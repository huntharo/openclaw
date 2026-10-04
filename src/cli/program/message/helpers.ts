import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { getChannelPlugin } from "../../../channels/plugins/index.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../../channels/plugins/types.public.js";
import { resolveMessageSecretScope } from "../../../cli/message-secret-scope.js";
import { parseAccountSelector } from "../../../commands/channels/account-selector.js";
import { parseChannelSelector } from "../../../commands/channels/channel-selector.js";
import type { messageCommand } from "../../../commands/message.js";
import { danger, setVerbose } from "../../../globals.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { CHANNEL_TARGET_DESCRIPTION } from "../../../infra/outbound/channel-target.js";
import { resolveMessageActionOutcome } from "../../../infra/outbound/message-action-contracts.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../../runtime.js";
import { withArtifactPreservingStateReads } from "../../../state/openclaw-state-db-readonly.js";
import {
  ABSOLUTE_DEADLINE_EXPIRED,
  awaitWithinDeadline,
} from "../../../utils/absolute-deadline.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { measureCliCommandStartup } from "../../command-startup-timing.js";
import { requestExitAfterOneShotOutput } from "../../one-shot-exit.js";

export type MessageCliHelpers = ReturnType<typeof createMessageCliHelpers>;

const GATEWAY_STOP_TIMEOUT_MS = 2500;
const CHANNEL_MESSAGE_ACTION_NAME_SET = new Set<string>(CHANNEL_MESSAGE_ACTION_NAMES);
const STRICT_POSITIVE_INTEGER_OPTIONS = new Map([
  ["pollDurationHours", "--poll-duration-hours"],
  ["pollDurationSeconds", "--poll-duration-seconds"],
  ["limit", "--limit"],
  ["autoArchiveMin", "--auto-archive-min"],
]);
const STRICT_NON_NEGATIVE_INTEGER_OPTIONS = new Map([
  ["durationMin", "--duration-min"],
  ["deleteDays", "--delete-days"],
]);

type MessagePluginPreloadPlan = { preload: true; channelId?: string } | { preload: false };

function normalizeMessageOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const { account, ...rest } = opts;
  return {
    ...rest,
    accountId: typeof account === "string" ? account : rest.accountId,
  };
}

function validateMessageOptions(action: string, opts: Record<string, unknown>): void {
  for (const [key, flag] of STRICT_POSITIVE_INTEGER_OPTIONS) {
    if (opts[key] === undefined) {
      continue;
    }
    if (parseStrictPositiveInteger(opts[key]) === undefined) {
      throw new Error(`${flag} must be a positive integer.`);
    }
  }
  for (const [key, flag] of STRICT_NON_NEGATIVE_INTEGER_OPTIONS) {
    if (opts[key] === undefined) {
      continue;
    }
    if (parseStrictNonNegativeInteger(opts[key]) === undefined) {
      throw new Error(`${flag} must be a non-negative integer.`);
    }
  }
  if (action === "poll" && opts.pollAnonymous === true && opts.pollPublic === true) {
    throw new Error("--poll-anonymous and --poll-public are mutually exclusive.");
  }
}

async function runPluginStopHooks(registry: PluginRegistry): Promise<void> {
  const { createHookRunner } = await import("../../../plugins/hooks.js");
  const runner = createHookRunner(registry, { logger: createSubsystemLogger("plugins") });
  const result = await awaitWithinDeadline(
    () =>
      withPluginRuntimeRegistryScope(registry, () =>
        runner.runGatewayStop({ reason: "cli message action complete" }, {}),
      ),
    Date.now() + GATEWAY_STOP_TIMEOUT_MS,
  );
  if (result === ABSOLUTE_DEADLINE_EXPIRED) {
    defaultRuntime.error(
      danger(`gateway_stop hook exceeded ${GATEWAY_STOP_TIMEOUT_MS}ms; continuing`),
    );
  }
}

function resolveScopedMessageChannel(opts: Record<string, unknown>): string | undefined {
  const explicit = normalizeOptionalLowercaseString(opts.channel);
  if (explicit) {
    // A cold custom channel is a requested metadata selection, not yet a registered transport.
    return resolveMessageSecretScope({ channel: explicit }).channel ?? explicit;
  }
  return resolveMessageSecretScope({
    channel: opts.channel,
    target: opts.target,
    targets: opts.targets,
  }).channel;
}

function asChannelMessageActionName(action: string): ChannelMessageActionName | undefined {
  return CHANNEL_MESSAGE_ACTION_NAME_SET.has(action)
    ? (action as ChannelMessageActionName)
    : undefined;
}

function resolveCliActionRequest(action: string, opts: Record<string, unknown>) {
  const channel = resolveScopedMessageChannel(opts);
  const messageAction = asChannelMessageActionName(action);
  const request =
    channel && messageAction
      ? getChannelPlugin(channel)?.actions?.resolveCliActionRequest?.({
          action: messageAction,
          args: opts,
        })
      : undefined;
  return request ?? { action, args: opts };
}

function resolveMessagePluginPreloadPlan(
  action: string,
  opts: Record<string, unknown>,
): MessagePluginPreloadPlan {
  const scopedChannel = resolveScopedMessageChannel(opts);
  const plugin = scopedChannel ? getChannelPlugin(scopedChannel) : undefined;
  // An unavailable selected channel reaches the canonical command error without
  // preparing local state or materializing an unconfigured implementation.
  if (scopedChannel && !plugin) {
    return { preload: false };
  }
  const messageAction = asChannelMessageActionName(action);
  if (
    opts.dryRun === true ||
    action === "broadcast" ||
    !messageAction ||
    plugin?.actions?.resolveExecutionMode?.({ action: messageAction }) !== "gateway"
  ) {
    return { preload: true, ...(scopedChannel ? { channelId: scopedChannel } : {}) };
  }
  return { preload: false };
}

/** Create shared option decorators and the common message action runner. */
export function createMessageCliHelpers(messageChannelOptions: string) {
  return {
    withMessageBase: (command: Command, target?: "required") => {
      if (target === "required") {
        command.requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);
      }
      return command
        .option("--channel <channel>", `Channel: ${messageChannelOptions}`, parseChannelSelector)
        .option("--account <id>", "Channel account id (accountId)", parseAccountSelector)
        .option("--json", "Output result as JSON", false)
        .option("--dry-run", "Print payload and skip sending", false)
        .option("--verbose", "Verbose logging", false);
    },

    runMessageAction: async (action: string, opts: Record<string, unknown>) => {
      setVerbose(Boolean(opts.verbose));
      let failed = false;
      let result: Awaited<ReturnType<typeof messageCommand>> | undefined;
      let inspection: Awaited<
        ReturnType<typeof import("./plugin-admission.js").acquireMessagePluginRegistry>
      >;
      let runStopHooks = false;
      let dispatchedAction = action;
      try {
        await runCommandWithRuntime(
          defaultRuntime,
          async () => {
            validateMessageOptions(action, opts);
            await measureCliCommandStartup("config-ready", async () => {
              const { ensureConfigReady } = await import("../config-guard.js");
              await ensureConfigReady({
                runtime: defaultRuntime,
                commandPath: ["message", action],
                suppressDoctorStdout: opts.json === true,
                validateConfigOnly: true,
                measure: (stage, run) => measureCliCommandStartup(stage, run),
              });
            });
            const scopedChannel = resolveScopedMessageChannel(opts);
            if (scopedChannel && !getChannelPlugin(scopedChannel)) {
              const { acquireMessagePluginRegistry } = await import("./plugin-admission.js");
              inspection = await acquireMessagePluginRegistry([scopedChannel]);
            }
            const inAdmission = <T>(run: () => T) => {
              inspection?.assertCurrent();
              return withPluginRuntimeRegistryScope(inspection?.registry, run);
            };
            let request = inAdmission(() => resolveCliActionRequest(action, opts));
            validateMessageOptions(request.action, request.args);
            const preloadPlan = inAdmission(() =>
              resolveMessagePluginPreloadPlan(request.action, request.args),
            );
            inspection?.assertCurrent();
            if (preloadPlan.preload) {
              await inspection?.release();
              inspection = undefined;
              const { ensureConfigReady } = await import("../config-guard.js");
              await ensureConfigReady({
                runtime: defaultRuntime,
                commandPath: ["message", action],
                suppressDoctorStdout: opts.json === true,
                validateConfigOnly: false,
                measure: (stage, run) => measureCliCommandStartup(stage, run),
              });
              const { acquireMessagePluginRegistry } = await import("./plugin-admission.js");
              inspection = await acquireMessagePluginRegistry(
                scopedChannel || preloadPlan.channelId
                  ? [
                      ...new Set(
                        [scopedChannel, preloadPlan.channelId].filter((id) => id !== undefined),
                      ),
                    ]
                  : undefined,
              );
              request = inAdmission(() => resolveCliActionRequest(action, opts));
              validateMessageOptions(request.action, request.args);
              runStopHooks = true;
            }
            // Late config preparers belong to module admission, before any operational writes.
            const [{ messageCommand }, { createDefaultDeps }] =
              await withArtifactPreservingStateReads(() =>
                Promise.all([import("../../../commands/message.js"), import("../../deps.js")]),
              );
            const deps = createDefaultDeps();
            const run = () =>
              messageCommand(
                {
                  ...normalizeMessageOptions(request.args),
                  action: request.action,
                },
                deps,
                defaultRuntime,
                inspection?.assertCurrent,
              );
            dispatchedAction = request.action;
            result = await inAdmission(run);
          },
          (err) => {
            failed = true;
            defaultRuntime.error(danger(formatErrorMessage(err)));
          },
        );
      } finally {
        // Finalize only this command's registry, including JSON/expected errors that rethrow.
        try {
          if (runStopHooks && inspection && dispatchedAction !== "read") {
            await runPluginStopHooks(inspection.registry);
          }
        } finally {
          await inspection?.release();
        }
      }
      failed ||= result !== undefined && !resolveMessageActionOutcome(result).ok;
      requestExitAfterOneShotOutput(defaultRuntime, failed ? 1 : 0);
    },
  };
}
