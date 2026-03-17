import { vi } from "vitest";
import {
  createWebInboundDeliverySpies,
  sendWebDirectInboundMessage,
} from "./auto-reply.test-harness.js";
import type { WebInboundMessage } from "./inbound.js";

async function createCapturedWebOnMessage(resolver: unknown) {
  const { loadConfig } = await import("openclaw/plugin-sdk/config-runtime");
  const { DEFAULT_GROUP_HISTORY_LIMIT } = await import("openclaw/plugin-sdk/reply-runtime");
  const { getChildLogger } = await import("openclaw/plugin-sdk/runtime-env");
  const { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } = await import("./accounts.js");
  const { buildMentionConfig } = await import("./auto-reply/mentions.js");
  const { createEchoTracker } = await import("./auto-reply/monitor/echo.js");
  const { createWebOnMessageHandler } = await import("./auto-reply/monitor/on-message.js");

  const baseCfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg: baseCfg, accountId: "default" });
  const cfg = {
    ...baseCfg,
    channels: {
      ...baseCfg.channels,
      whatsapp: {
        ...baseCfg.channels?.whatsapp,
        ackReaction: account.ackReaction,
        messagePrefix: account.messagePrefix,
        allowFrom: account.allowFrom,
        groupAllowFrom: account.groupAllowFrom,
        groupPolicy: account.groupPolicy,
        textChunkLimit: account.textChunkLimit,
        chunkMode: account.chunkMode,
        mediaMaxMb: account.mediaMaxMb,
        blockStreaming: account.blockStreaming,
        groups: account.groups,
      },
    },
  } satisfies typeof baseCfg;

  return createWebOnMessageHandler({
    cfg,
    verbose: false,
    connectionId: "test-web-broadcast",
    maxMediaBytes: resolveWhatsAppMediaMaxBytes(account),
    groupHistoryLimit:
      cfg.channels?.whatsapp?.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: createEchoTracker({ maxItems: 100 }),
    backgroundTasks: new Set(),
    replyResolver: resolver as never,
    replyLogger: getChildLogger({ module: "web-auto-reply-test" }),
    baseMentionConfig: buildMentionConfig(cfg),
    account,
  });
}

export async function monitorWebChannelWithCapture(resolver: unknown): Promise<{
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
}> {
  const spies = createWebInboundDeliverySpies();
  const onMessage = await createCapturedWebOnMessage(resolver);

  return { spies, onMessage };
}

export async function sendWebDirectInboundAndCollectSessionKeys(): Promise<{
  seen: string[];
  resolver: ReturnType<typeof vi.fn>;
}> {
  const seen: string[] = [];
  const resolver = vi.fn(async (ctx: { SessionKey?: unknown }) => {
    seen.push(String(ctx.SessionKey));
    return { text: "ok" };
  });

  const spies = createWebInboundDeliverySpies();
  const onMessage = await createCapturedWebOnMessage(resolver);

  await sendWebDirectInboundMessage({
    onMessage,
    spies,
    id: "m1",
    from: "+1000",
    to: "+2000",
    body: "hello",
  });

  return { seen, resolver };
}
