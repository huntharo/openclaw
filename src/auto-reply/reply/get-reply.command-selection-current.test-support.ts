import path from "node:path";
import { vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import { recordInboundSession } from "../../channels/session.js";
import type { AssembledChannelTurn } from "../../channels/turn/types.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import * as entryMutation from "../../config/sessions/session-accessor.sqlite-entry-mutation.js";
import * as sessionEntry from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ConversationRef,
  SessionBindingAdapter,
  SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../../infra/outbound/session-binding-service.js";
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
} from "../../plugin-sdk/channel-inbound.js";
import { resolveRuntimeConversationBindingRouteAsync } from "../../plugin-sdk/conversation-binding-runtime.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { ReplyPayload } from "../reply-payload.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import * as modelRuntime from "./model-runtime-normalization.js";
import { dispatchReplyWithBufferedBlockDispatcherCore } from "./provider-dispatcher.js";

const catalog: ModelCatalogSnapshot = {
  entries: [
    { provider: "mock-openai", id: "initial", name: "Initial", reasoning: false },
    { provider: "mock-openai", id: "selected", name: "Selected", reasoning: false },
  ],
  routeVariants: [],
  authoritative: true,
};

export async function createCommandSelectionFixture(params: {
  state: OpenClawTestState;
  sender: string;
  registerAdapter: (
    lookup: (ref: ConversationRef) => SessionBindingRecord | null,
  ) => SessionBindingAdapter;
}) {
  const { state, sender, registerAdapter } = params;
  vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalogSnapshot").mockResolvedValue(catalog);
  vi.spyOn(preparedModelCatalog, "loadProviderScopedThinkingCatalog").mockResolvedValue(
    catalog.entries,
  );
  const sessionKey = "agent:main:webchat:direct:room";
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const cfg: OpenClawConfig = withFullRuntimeReplyConfig({
    plugins: { enabled: false },
    commands: { text: true, ownerAllowFrom: ["owner"], allowFrom: { "*": ["owner", "guest"] } },
    session: { store: storePath },
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/initial" },
        modelPolicy: { allow: ["mock-openai/initial", "mock-openai/selected"] },
      },
    },
  });
  setRuntimeConfigSnapshot(cfg);
  replaceSessionEntrySync(
    { storePath, sessionKey },
    { sessionId: "selection-session", updatedAt: 1 },
  );
  const conversation: ConversationRef = {
    channel: "webchat",
    accountId: "default",
    conversationId: "room",
  };
  let binding: SessionBindingRecord | null = {
    bindingId: "command-binding",
    targetSessionKey: sessionKey,
    targetKind: "session",
    status: "active",
    boundAt: 1,
    conversation,
  };
  const adapter = registerAdapter(() => (binding?.status === "active" ? binding : null));
  const { route } = await resolveRuntimeConversationBindingRouteAsync({
    route: {
      agentId: "main",
      channel: "webchat",
      accountId: "default",
      sessionKey,
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    },
    conversation,
  });
  const replies: ReplyPayload[] = [];
  const body = "/model mock-openai/selected -s";
  const ctxPayload = buildChannelInboundEventContext({
    channel: "webchat",
    accountId: "default",
    messageId: "selection-message",
    from: sender,
    sender: { id: sender },
    conversation: { kind: "direct", id: "room" },
    route: { ...route, routeSessionKey: route.sessionKey },
    reply: { to: "room" },
    message: { rawBody: body },
    command: { kind: "text-slash", name: "model", body, authorized: true },
    access: { commands: { authorized: true } },
  });
  let recordedEntry: ReturnType<typeof loadSessionEntry>;
  const turn: AssembledChannelTurn = {
    channel: "webchat",
    accountId: "default",
    routeSessionKey: sessionKey,
    storePath,
    ctxPayload,
    cfg,
    agentId: "main",
    recordInboundSession: async (input) => {
      await recordInboundSession(input);
      recordedEntry = loadSessionEntry({ storePath, sessionKey });
    },
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherCore,
    replyResolver: getReplyFromConfig,
    replyOptions: { suppressTyping: true },
    commandSelectionCurrent: { publicationCurrent: () => true, assertRouteCurrent() {} },
    delivery: {
      deliver: async (reply) => {
        replies.push(reply);
        return { visibleReplySent: true };
      },
    },
  };
  const authorization = resolveCommandAuthorization({
    ctx: ctxPayload,
    cfg,
    commandAuthorized: true,
  });
  return {
    cfg,
    turn,
    adapter,
    authorization,
    replies,
    scope: { storePath, sessionKey },
    read: () => loadSessionEntry({ storePath, sessionKey }),
    readRecorded: () => recordedEntry,
    replaceBinding: (next: SessionBindingRecord | null) => {
      binding = next;
    },
    run: () =>
      runChannelInboundEvent({
        channel: "webchat",
        raw: body,
        adapter: {
          ingest: () => ({ id: "selection-message", rawText: body }),
          resolveTurn: () => turn,
        },
      }),
  };
}

export type SelectionRevocation =
  | "source-publication"
  | "source-route"
  | "core-publication"
  | "adapter-registration"
  | "binding-selection"
  | "binding-unbind"
  | "binding-close";

export async function exerciseSelectionRevocation(params: {
  fixture: Awaited<ReturnType<typeof createCommandSelectionFixture>>;
  phase: "preparation" | "queued-commit";
  revocation: SelectionRevocation;
  signal: AbortSignal;
}) {
  const { fixture, phase, revocation, signal } = params;
  const prepared = createDeferred();
  const releasePreparation = createDeferred();
  const blockerEntered = createDeferred();
  const releaseBlocker = createDeferred();
  const enqueued = createDeferred();
  let publicationCurrent = true;
  let routeCurrent = true;
  let inCommit = false;
  let sourceChecksAtCommit = 0;
  let queueArmed = false;
  const transactions: boolean[] = [];
  fixture.turn.commandSelectionCurrent = {
    publicationCurrent: () => publicationCurrent,
    assertRouteCurrent: () => {
      if (inCommit) {
        sourceChecksAtCommit++;
      }
      if (!routeCurrent) {
        throw new Error("Original channel route changed.");
      }
    },
  };
  const prepareModelSelection = modelRuntime.prepareModelSelectionRuntime;
  vi.spyOn(modelRuntime, "prepareModelSelectionRuntime").mockImplementation(async (input) => {
    const result = await prepareModelSelection(input);
    if (input.model === "selected") {
      if (result.status !== "ready") {
        throw new Error(`Fixture model preparation rejected: ${result.message}`);
      }
      prepared.resolve();
      await releasePreparation.promise;
    }
    return result;
  });
  const mutate = entryMutation.applySessionEntryPatchInDatabase;
  vi.spyOn(entryMutation, "applySessionEntryPatchInDatabase").mockImplementation((db, input) => {
    if (input.sessionKey !== fixture.scope.sessionKey || input.next?.modelOverride !== "selected") {
      return mutate(db, input);
    }
    transactions.push(db.db.isTransaction);
    inCommit = true;
    try {
      return mutate(db, input);
    } finally {
      inCommit = false;
    }
  });
  const patchEntry = sessionEntry.patchSessionEntryCore;
  vi.spyOn(sessionEntry, "patchSessionEntryCore").mockImplementation((scope, update, options) => {
    const target =
      queueArmed &&
      scope.sessionKey === fixture.scope.sessionKey &&
      options?.fallbackEntry?.modelOverride === "selected";
    if (!target) {
      return patchEntry(scope, update, options);
    }
    const pendingBefore = new Set(
      [...SQLITE_SESSION_WRITER_QUEUES.values()].flatMap((q) => q.pending),
    );
    const result = patchEntry(scope, update, options);
    if (
      ![...SQLITE_SESSION_WRITER_QUEUES.values()].some((q) =>
        q.pending.some((task) => !pendingBefore.has(task)),
      )
    ) {
      throw new Error("Fixture model write did not enter the actual writer queue");
    }
    enqueued.resolve();
    return result;
  });
  const revoke = () => {
    switch (revocation) {
      case "source-publication":
        publicationCurrent = false;
        break;
      case "source-route":
        routeCurrent = false;
        break;
      case "core-publication":
        // Same-object republication must invalidate the original admission generation.
        setRuntimeConfigSnapshot(fixture.cfg);
        break;
      case "adapter-registration":
        registerSessionBindingAdapter(fixture.adapter);
        break;
      case "binding-selection":
        fixture.replaceBinding({
          bindingId: "replacement",
          targetSessionKey: "agent:work:webchat:direct:room",
          targetKind: "session",
          status: "active",
          boundAt: 2,
          conversation: { channel: "webchat", accountId: "default", conversationId: "room" },
        });
        break;
      case "binding-unbind":
        fixture.replaceBinding(null);
        break;
      case "binding-close":
        fixture.replaceBinding({
          bindingId: "command-binding",
          targetSessionKey: fixture.scope.sessionKey,
          targetKind: "session",
          status: "ended",
          boundAt: 1,
          conversation: { channel: "webchat", accountId: "default", conversationId: "room" },
        });
        break;
    }
  };
  const operation = fixture.run();
  let blocker: Promise<unknown> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        prepared.promise,
        operation,
        "Fixture dispatch settled before real model preparation",
      ),
      signal,
    );
    if (phase === "queued-commit") {
      // The real accessor holds FIFO admission without changing the prepared session row.
      blocker = patchEntry(
        fixture.scope,
        async () => {
          blockerEntered.resolve();
          await releaseBlocker.promise;
          return null;
        },
        { skipMaintenance: true },
      );
      await withinTest(
        awaitGateBeforeSettlement(
          blockerEntered.promise,
          blocker,
          "Fixture competing writer settled before acquiring admission",
        ),
        signal,
      );
      queueArmed = true;
      releasePreparation.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          enqueued.promise,
          operation,
          "Fixture dispatch settled before queueing its model write",
        ),
        signal,
      );
    }
    revoke();
    releasePreparation.resolve();
    releaseBlocker.resolve();
    const result = await withinTest(operation, signal);
    await blocker;
    return { result, transactions, sourceChecksAtCommit };
  } finally {
    releasePreparation.resolve();
    releaseBlocker.resolve();
    await Promise.allSettled([operation, ...(blocker ? [blocker] : [])]);
    if (revocation === "adapter-registration") {
      unregisterSessionBindingAdapter({
        channel: "webchat",
        accountId: "default",
        adapter: fixture.adapter,
      });
    }
  }
}
