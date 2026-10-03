/**
 * Runs native harness tool-result middleware around tool execution results.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  AgentToolResultMiddlewareProjection,
  OpenClawAgentToolResult,
} from "../../plugins/agent-tool-result-middleware-types.js";
import { getPluginValueInstance } from "../../plugins/plugin-instance-scope.js";
import { getPluginRegistryGatewayOwner } from "../../plugins/registry-lifecycle.js";
import { createLazyPromiseLoader } from "../../shared/lazy-promise.js";
import { truncateUtf16Safe } from "../../utils.js";
import { getCodeModeOriginalTextCapture } from "../code-mode-original-text.js";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { isDeliveredMessagingToolResult } from "../embedded-agent-message-tool-source-reply.js";
import { isMessagingToolSendAction } from "../embedded-agent-messaging.js";
import { isToolResultError } from "../tool-result-error.js";
import {
  coerceMiddlewareToolResult,
  sanitizeToolResultForMiddleware,
  snapshotToolResultForSelection,
  detachToolResultForMiddleware,
  snapshotMiddlewareArgs,
} from "./tool-result-middleware-coercion.js";

const log = createSubsystemLogger("agents/harness");

function captureOriginalText(
  result: OpenClawAgentToolResult,
  maxBytes: number,
): AgentToolResultMiddlewareEvent["originalTextContent"] {
  const content: Array<Readonly<{ type: "text"; text: string }>> = [];
  for (const block of result.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return undefined;
    }
    content.push(Object.freeze({ type: "text", text: block.text }));
  }
  const size = boundedJsonUtf8Bytes(content, maxBytes);
  return size.complete && size.bytes <= maxBytes ? Object.freeze(content) : undefined;
}

function buildMiddlewareFailureResult(): OpenClawAgentToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Tool output unavailable due to post-processing error.",
      },
    ],
    details: {
      status: "error",
      middlewareError: true,
    },
  };
}

function buildDeliveredMessagingFailureFallback(
  event: AgentToolResultMiddlewareEvent,
  result: OpenClawAgentToolResult,
): OpenClawAgentToolResult | undefined {
  const deliveryFact = readEmbeddedMessageDeliveryFact(
    isRecord(result.details) ? result.details.messageDelivery : undefined,
  );
  const delivered = deliveryFact
    ? deliveryFact.status === "settled"
    : isDeliveredMessagingToolResult({
        toolName: event.toolName,
        args: event.args,
        result,
        requirePluginDeliveryId: true,
      });
  if (
    event.isError === true ||
    isToolResultError(result) ||
    !isMessagingToolSendAction(event.toolName, event.args) ||
    !delivered
  ) {
    return undefined;
  }
  return {
    content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
    details: {
      ok: true,
      deliveryStatus: "sent",
      middlewareWarning: "post-processing failed",
    },
  };
}

function reconcileDeliveredMessagingFailure(
  result: OpenClawAgentToolResult,
  fallback: OpenClawAgentToolResult | undefined,
): OpenClawAgentToolResult {
  return fallback && isRecord(result.details) && result.details.middlewareError === true
    ? fallback
    : result;
}

/**
 * A run resolves middleware once. When a handler's own plugin was retired and is
 * gone from its Gateway's current registry, its post-processing no longer applies. The runner
 * checks this before choosing a path and again before each call, so a skipped
 * plugin never runs and cannot have touched the result.
 */
function isRemovedPluginMiddleware(handler: AgentToolResultMiddleware): boolean {
  const instance = getPluginValueInstance(handler);
  if (!instance?.owner || (!instance.disposing && instance.acceptingCalls)) {
    return false;
  }
  // Decide against the plugin's own Gateway; without that owner a stale handler fails closed.
  const successor = getPluginRegistryGatewayOwner(instance.owner.registry)?.current();
  return (
    successor !== undefined &&
    !successor.plugins.some(
      (record) => record.id === instance.pluginId && record.enabled && record.status === "loaded",
    )
  );
}

export function createAgentToolResultMiddlewareRunner(
  ctx: AgentToolResultMiddlewareContext,
  handlers?: AgentToolResultMiddleware[],
) {
  const resolvedHandlersLoader = createLazyPromiseLoader(async () => {
    const { loadAgentToolResultMiddlewaresForRuntime } =
      await import("../../plugins/agent-tool-result-middleware-loader.js");
    return loadAgentToolResultMiddlewaresForRuntime({
      runtime: ctx.runtime,
    });
  });
  return {
    async applyToolResultMiddleware(
      event: AgentToolResultMiddlewareEvent,
      project: (
        result: OpenClawAgentToolResult,
      ) => OpenClawAgentToolResult | Promise<OpenClawAgentToolResult> = (result) => result,
      selectionView: (result: OpenClawAgentToolResult) => OpenClawAgentToolResult = (result) =>
        result,
      finalize: (result: OpenClawAgentToolResult) => OpenClawAgentToolResult = (result) => result,
    ): Promise<OpenClawAgentToolResult> {
      // Drop removed plugins' handlers before choosing a path, so a run whose
      // only middleware was removed keeps the untouched no-middleware result.
      const handlersForRun = (await (handlers ?? resolvedHandlersLoader.load())).filter(
        (handler) => !isRemovedPluginMiddleware(handler),
      );
      // Fast path: with no middleware registered the result is delivered
      // unchanged; skip validation entirely so tool emitters that produce
      // dependency payloads on `details` (SDK objects with methods, cycles)
      // are not penalized for behavior the validator was added to police.
      if (handlersForRun.length === 0) {
        return finalize(await project(event.result));
      }
      // Snapshot the confirmed side effect before legacy middleware can mutate
      // or sanitization can collapse the receipt; never expose the raw result.
      const deliveredMessagingFallback = buildDeliveredMessagingFailureFallback(
        event,
        event.result,
      );
      const captureBytes =
        ctx.resultVisibility === "observe"
          ? 0
          : Math.max(0, ...handlersForRun.map((handler) => handler.originalTextMaxBytes ?? 0));
      const hostAssertCurrent = ctx.assertCurrent;
      const hostSignal = ctx.signal;
      const assertSettlementCurrent = () => {
        hostAssertCurrent?.();
        hostSignal?.throwIfAborted();
      };
      const capturedContext =
        captureBytes > 0
          ? Object.freeze({
              runtime: ctx.runtime,
              agentId: ctx.agentId,
              sessionId: ctx.sessionId,
              sessionKey: ctx.sessionKey,
              runId: ctx.runId,
              resultVisibility: ctx.resultVisibility,
              persistence: ctx.persistence,
              task: ctx.task,
              toolNames: ctx.toolNames ? Object.freeze([...ctx.toolNames]) : undefined,
              signal: hostSignal,
              assertCurrent: hostAssertCurrent,
            })
          : ctx;
      const producerCapture =
        captureBytes > 0 ? getCodeModeOriginalTextCapture(event.result) : undefined;
      const capturedArgs =
        captureBytes > 0 ? snapshotMiddlewareArgs(event.args, captureBytes) : undefined;
      const originalTextContent =
        captureBytes > 0
          ? producerCapture
            ? producerCapture.originalTextContent
            : captureOriginalText(event.result, captureBytes)
          : undefined;
      const originalCaptureSize =
        originalTextContent && capturedArgs
          ? boundedJsonUtf8Bytes(
              {
                content: originalTextContent,
                members: producerCapture?.members,
                args: capturedArgs,
              },
              captureBytes,
            )
          : undefined;
      let current = sanitizeToolResultForMiddleware(event.result);
      // Sanitization has admitted JSON-safe details; keep a detached fallback before legacy mutation.
      const original =
        captureBytes > 0 ? (detachToolResultForMiddleware(current) ?? current) : current;
      const projections: AgentToolResultMiddlewareProjection[] = [];
      const discardProjections = async () => {
        await Promise.allSettled(projections.map((projection) => projection.discard()));
      };
      for (const handler of handlersForRun) {
        // An earlier handler can await while a later handler's plugin is removed.
        if (isRemovedPluginMiddleware(handler)) {
          continue;
        }
        try {
          ctx.assertCurrent?.();
          const handlerCaptureBytes = handler.originalTextMaxBytes ?? 0;
          const admittedCapture =
            originalCaptureSize?.complete === true &&
            originalCaptureSize.bytes <= handlerCaptureBytes;
          const isolated = handler.failureMode === "passthrough";
          const handlerResult = isolated ? detachToolResultForMiddleware(current) : current;
          if (!handlerResult) {
            continue;
          }
          const next = await handler(
            {
              ...event,
              ...(handlerCaptureBytes > 0 ? { args: capturedArgs ?? Object.freeze({}) } : {}),
              originalTextContent: admittedCapture ? originalTextContent : undefined,
              ...(handlerCaptureBytes > 0
                ? {
                    originalCaptureComplete: admittedCapture && producerCapture?.complete !== false,
                    originalTextMembers: admittedCapture ? producerCapture?.members : undefined,
                  }
                : {}),
              result: handlerResult,
            },
            handlerCaptureBytes > 0 ? capturedContext : ctx,
          );
          if (next?.projection) {
            projections.push(next.projection);
          }
          // Middleware may mutate event.result in place for legacy runtime parity.
          // Validate the current object after every handler so in-place writes
          // cannot bypass the same shape and size bounds as returned results.
          const candidate = next?.result ?? handlerResult;
          const coercedCandidate = coerceMiddlewareToolResult(candidate);
          if (coercedCandidate) {
            current = coercedCandidate;
          } else {
            await discardProjections();
            log.warn(
              `[${ctx.runtime}] discarded invalid tool result middleware output for ${truncateUtf16Safe(
                event.toolName,
                120,
              )}`,
            );
            return finalize(
              await project(
                reconcileDeliveredMessagingFailure(
                  buildMiddlewareFailureResult(),
                  deliveredMessagingFallback,
                ),
              ),
            );
          }
        } catch {
          if (handler.failureMode === "passthrough") {
            try {
              assertSettlementCurrent();
            } catch (error) {
              await discardProjections();
              throw error;
            }
            const instance = getPluginValueInstance(handler);
            if (!instance || (!instance.disposing && instance.acceptingCalls)) {
              continue;
            }
          }
          await discardProjections();
          log.warn(
            `[${ctx.runtime}] tool result middleware failed for ${truncateUtf16Safe(
              event.toolName,
              120,
            )}`,
          );
          return finalize(
            await project(
              reconcileDeliveredMessagingFailure(
                buildMiddlewareFailureResult(),
                deliveredMessagingFallback,
              ),
            ),
          );
        }
      }
      let selectedSuccessfully = false;
      try {
        if (projections.length > 0) {
          assertSettlementCurrent();
        } else {
          ctx.assertCurrent?.();
        }
        const projected = finalize(
          await project(reconcileDeliveredMessagingFailure(current, deliveredMessagingFallback)),
        );
        if (projections.length === 0) {
          return projected;
        }
        const selected = snapshotToolResultForSelection(projected);
        if (!selected) {
          return finalize(original);
        }
        const view = selectionView(selected);
        const visible = snapshotToolResultForSelection({
          content: view.content,
          details: view.details,
          ...(view.terminate !== undefined ? { terminate: view.terminate } : {}),
        });
        if (!visible) {
          return finalize(original);
        }
        for (const projection of projections) {
          assertSettlementCurrent();
          if (!(await projection.select(visible))) {
            return finalize(original);
          }
        }
        assertSettlementCurrent();
        for (const projection of projections) {
          projection.assertCurrent?.();
        }
        selectedSuccessfully = true;
        // Notifications cannot revoke a selection already validated by every participant.
        for (const projection of projections) {
          try {
            projection.selected?.();
          } catch {
            log.warn(`[${ctx.runtime}] tool result selection notification failed`);
          }
        }
        return selected;
      } catch (error) {
        if (projections.length === 0) {
          throw error;
        }
        assertSettlementCurrent();
        return finalize(original);
      } finally {
        if (!selectedSuccessfully) {
          await discardProjections();
        }
      }
    },
  };
}
