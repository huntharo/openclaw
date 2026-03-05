import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import { createNativeCommandTestParams } from "./bot-native-commands.test-helpers.js";

// All mocks scoped to this file only — does not affect bot-native-commands.test.ts

const persistentBindingRouteMocks = vi.hoisted(() => ({
  resolveConfiguredAcpRoute: vi.fn(),
  ensureConfiguredAcpRouteReady: vi.fn(),
}));
const sessionMocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(),
  resolveStorePath: vi.fn(),
}));
const replyMocks = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(),
}));

vi.mock("../acp/persistent-bindings.route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/persistent-bindings.route.js")>();
  return {
    ...actual,
    resolveConfiguredAcpRoute: persistentBindingRouteMocks.resolveConfiguredAcpRoute,
    ensureConfiguredAcpRouteReady: persistentBindingRouteMocks.ensureConfiguredAcpRouteReady,
  };
});
vi.mock("../config/sessions.js", () => ({
  recordSessionMetaFromInbound: sessionMocks.recordSessionMetaFromInbound,
  resolveStorePath: sessionMocks.resolveStorePath,
}));
vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
}));
vi.mock("../auto-reply/reply/inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));
vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: replyMocks.dispatchReplyWithBufferedBlockDispatcher,
}));
vi.mock("../channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: () => {} })),
}));
vi.mock("../auto-reply/skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/skill-commands.js")>();
  return { ...actual, listSkillCommandsForAgents: vi.fn(() => []) };
});
vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
}));
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type TelegramCommandHandler = (ctx: unknown) => Promise<void>;

function buildStatusCommandContext() {
  return {
    match: "",
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 100, type: "private" as const },
      from: { id: 200, username: "bob" },
    },
  };
}

function buildStatusTopicCommandContext() {
  return {
    match: "",
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "OpenClaw",
        is_forum: true,
      },
      message_thread_id: 42,
      from: { id: 200, username: "bob" },
    },
  };
}

function registerAndResolveStatusHandler(params: {
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const commandHandlers = new Map<string, TelegramCommandHandler>();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const baseParams = createNativeCommandTestParams({
    cfg: params.cfg,
    allowFrom: params.allowFrom ?? ["*"],
    groupAllowFrom: params.groupAllowFrom ?? [],
    useAccessGroups: params.useAccessGroups,
    bot: {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage,
      },
      command: vi.fn((name: string, cb: TelegramCommandHandler) => {
        commandHandlers.set(name, cb);
      }),
    } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
  });
  registerTelegramNativeCommands({
    ...baseParams,
  });

  const handler = commandHandlers.get("status");
  expect(handler).toBeTruthy();
  return { handler: handler as TelegramCommandHandler, sendMessage };
}

describe("registerTelegramNativeCommands — session metadata", () => {
  beforeEach(() => {
    persistentBindingRouteMocks.resolveConfiguredAcpRoute.mockReset();
    persistentBindingRouteMocks.resolveConfiguredAcpRoute.mockImplementation(
      (params: { route: unknown }) => ({
        configuredBinding: null,
        route: params.route,
      }),
    );
    persistentBindingRouteMocks.ensureConfiguredAcpRouteReady.mockReset();
    persistentBindingRouteMocks.ensureConfiguredAcpRouteReady.mockResolvedValue({ ok: true });
    sessionMocks.recordSessionMetaFromInbound.mockClear().mockResolvedValue(undefined);
    sessionMocks.resolveStorePath.mockClear().mockReturnValue("/tmp/openclaw-sessions.json");
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockClear().mockResolvedValue(undefined);
    deliveryMocks.deliverReplies.mockClear().mockResolvedValue({ delivered: true });
  });

  it("calls recordSessionMetaFromInbound after a native slash command", async () => {
    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    await handler(buildStatusCommandContext());

    expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    const call = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string; ctx?: { OriginatingChannel?: string; Provider?: string } }]
      >
    )[0]?.[0];
    expect(call?.ctx?.OriginatingChannel).toBe("telegram");
    expect(call?.ctx?.Provider).toBe("telegram");
    expect(call?.sessionKey).toBeDefined();
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred<void>();
    sessionMocks.recordSessionMetaFromInbound.mockReturnValue(deferred.promise);

    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    const runPromise = handler(buildStatusCommandContext());

    await vi.waitFor(() => {
      expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("injects canonical approval buttons for native command replies", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: { deliver: (payload: unknown) => unknown };
      }) => {
        await dispatcherOptions.deliver({
          text: "Mode: foreground\nRun: /approve 7f423fdc allow-once (or allow-always / deny).",
        });
      },
    );

    const { handler } = registerAndResolveStatusHandler({ cfg: {} });
    await handler(buildStatusCommandContext());

    const deliveredPayload = (
      deliveryMocks.deliverReplies.mock.calls[0]?.[0] as {
        replies?: Array<Record<string, unknown>>;
      }
    )?.replies?.[0];
    expect(deliveredPayload).toBeTruthy();
    expect(deliveredPayload?.["channelData"]).toEqual({
      telegram: {
        buttons: [
          [
            { text: "Allow Once", callback_data: "/approve 7f423fdc allow-once" },
            { text: "Allow Always", callback_data: "/approve 7f423fdc allow-always" },
          ],
          [{ text: "Deny", callback_data: "/approve 7f423fdc deny" }],
        ],
      },
    });
  });

  it("routes Telegram native commands through configured ACP topic bindings", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingRouteMocks.resolveConfiguredAcpRoute.mockImplementation(
      (params: { route: { accountId: string; sessionKey: string; agentId: string } }) => ({
        configuredBinding: {
          spec: {
            conversationId: "-1001234567890:topic:42",
          },
          record: {
            targetSessionKey: boundSessionKey,
          },
        },
        route: {
          ...params.route,
          sessionKey: boundSessionKey,
          agentId: "codex",
          matchedBy: "binding.channel",
        },
      }),
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(buildStatusTopicCommandContext());

    expect(persistentBindingRouteMocks.resolveConfiguredAcpRoute).toHaveBeenCalledTimes(1);
    expect(persistentBindingRouteMocks.ensureConfiguredAcpRouteReady).toHaveBeenCalledTimes(1);
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
  });

  it("stops command dispatch when configured ACP topic binding is unavailable", async () => {
    persistentBindingRouteMocks.resolveConfiguredAcpRoute.mockImplementation(
      (params: { route: { accountId: string; sessionKey: string; agentId: string } }) => ({
        configuredBinding: {
          spec: {
            conversationId: "-1001234567890:topic:42",
          },
          record: {
            targetSessionKey: "agent:codex:acp:binding:telegram:default:feedface",
          },
        },
        route: params.route,
      }),
    );
    persistentBindingRouteMocks.ensureConfiguredAcpRouteReady.mockResolvedValue({
      ok: false,
      error: "gateway unavailable",
    });

    const { handler, sendMessage } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(buildStatusTopicCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      "Configured ACP binding is unavailable right now. Please try again.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("sends unauthorized responses in the originating topic thread", async () => {
    const { handler, sendMessage } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(buildStatusTopicCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      "You are not authorized to use this command.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });
});
