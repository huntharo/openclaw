import type { Chat, Message } from "@grammyjs/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveCodexAppServerRun,
  setActiveCodexAppServerRun,
} from "../agents/codex-app-server-runs.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getTelegramSequentialKey } from "./sequential-key.js";

const mockChat = (chat: Pick<Chat, "id"> & Partial<Pick<Chat, "type" | "is_forum">>): Chat =>
  chat as Chat;
const mockMessage = (message: Pick<Message, "chat"> & Partial<Message>): Message =>
  ({
    message_id: 1,
    date: 0,
    ...message,
  }) as Message;

describe("getTelegramSequentialKey", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [{ message: mockMessage({ chat: mockChat({ id: 123 }) }) }, "telegram:123"],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123:topic:9",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup", is_forum: true }),
        }),
      },
      "telegram:123:topic:1",
    ],
    [{ update: { message: mockMessage({ chat: mockChat({ id: 555 }) }) } }, "telegram:555"],
    [
      {
        channelPost: mockMessage({ chat: mockChat({ id: -100777111222, type: "channel" }) }),
      },
      "telegram:-100777111222",
    ],
    [
      {
        update: {
          channel_post: mockMessage({ chat: mockChat({ id: -100777111223, type: "channel" }) }),
        },
      },
      "telegram:-100777111223",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/stop" }) },
      "telegram:123:control",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/status" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop please" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "do not do that" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "остановись" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "halt" }) },
      "telegram:123:control",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort" }) }, "telegram:123"],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort now" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "please do not do that" }) },
      "telegram:123",
    ],
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toBe(expected);
  });

  it("routes Codex callback approvals through a control lane", () => {
    expect(
      getTelegramSequentialKey({
        update: {
          callback_query: {
            data: "cdxui:aa:0:abc1234567",
            message: mockMessage({
              chat: mockChat({ id: -1003841603622, type: "supergroup", is_forum: true }),
              message_thread_id: 1364,
            }),
          },
        },
      }),
    ).toBe("telegram:-1003841603622:topic:1364:control");
  });

  it("routes bound Codex pending-input replies through a control lane", () => {
    const handle = {
      queueMessage: vi.fn().mockResolvedValue(true),
      submitPendingInput: vi.fn().mockResolvedValue(true),
      interrupt: vi.fn().mockResolvedValue(undefined),
      isStreaming: () => false,
      isAwaitingInput: () => true,
    };
    setActiveCodexAppServerRun(
      "codex-run-1",
      handle,
      "agent:pwrdrvr:codex:binding:telegram:default:-1003841603622:topic:1364",
    );
    vi.spyOn(getSessionBindingService(), "resolveByConversation").mockReturnValue({
      bindingId: "binding-1",
      targetSessionKey: "agent:pwrdrvr:codex:binding:telegram:default:-1003841603622:topic:1364",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003841603622:topic:1364",
      },
      status: "active",
      boundAt: Date.now(),
    });

    expect(
      getTelegramSequentialKey(
        {
          message: mockMessage({
            chat: mockChat({ id: -1003841603622, type: "supergroup", is_forum: true }),
            message_thread_id: 1364,
            text: "1",
          }),
        },
        { accountId: "default" },
      ),
    ).toBe("telegram:-1003841603622:topic:1364:control");

    clearActiveCodexAppServerRun(
      "codex-run-1",
      handle,
      "agent:pwrdrvr:codex:binding:telegram:default:-1003841603622:topic:1364",
    );
  });
});
