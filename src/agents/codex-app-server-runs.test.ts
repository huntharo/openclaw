import { describe, expect, it, vi } from "vitest";
import {
  clearActiveCodexAppServerRun,
  isCodexAppServerRunActive,
  isCodexAppServerRunStreaming,
  queueCodexAppServerMessage,
  queueCodexAppServerMessageBySessionKey,
  setActiveCodexAppServerRun,
  submitCodexAppServerPendingInputBySessionKey,
} from "./codex-app-server-runs.js";

describe("codex app server run registry", () => {
  it("queues messages for active streaming runs", async () => {
    const queueMessage = vi.fn().mockResolvedValue(true);
    const handle = {
      queueMessage,
      submitPendingInput: vi.fn().mockResolvedValue(true),
      interrupt: vi.fn().mockResolvedValue(undefined),
      isStreaming: () => true,
      isAwaitingInput: () => false,
    };
    setActiveCodexAppServerRun("s1", handle);
    expect(isCodexAppServerRunActive("s1")).toBe(true);
    expect(isCodexAppServerRunStreaming("s1")).toBe(true);
    expect(queueCodexAppServerMessage("s1", "hello")).toBe(true);
    await vi.waitFor(() => {
      expect(queueMessage).toHaveBeenCalledWith("hello");
    });
    clearActiveCodexAppServerRun("s1", handle);
    expect(isCodexAppServerRunActive("s1")).toBe(false);
  });

  it("still accepts queued text while awaiting user input", async () => {
    const queueMessage = vi.fn().mockResolvedValue(true);
    const handle = {
      queueMessage,
      submitPendingInput: vi.fn().mockResolvedValue(true),
      interrupt: vi.fn().mockResolvedValue(undefined),
      isStreaming: () => false,
      isAwaitingInput: () => true,
    };
    setActiveCodexAppServerRun("s2", handle);
    expect(isCodexAppServerRunStreaming("s2")).toBe(true);
    expect(queueCodexAppServerMessage("s2", "1")).toBe(true);
    await vi.waitFor(() => {
      expect(queueMessage).toHaveBeenCalledWith("1");
    });
    clearActiveCodexAppServerRun("s2", handle);
  });

  it("queues messages by session key for active runs", async () => {
    const queueMessage = vi.fn().mockResolvedValue(true);
    const handle = {
      queueMessage,
      submitPendingInput: vi.fn().mockResolvedValue(true),
      interrupt: vi.fn().mockResolvedValue(undefined),
      isStreaming: () => true,
      isAwaitingInput: () => false,
    };
    setActiveCodexAppServerRun("s3", handle, "agent:main:telegram:group:1:topic:9");
    expect(queueCodexAppServerMessageBySessionKey("agent:main:telegram:group:1:topic:9", "2")).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(queueMessage).toHaveBeenCalledWith("2");
    });
    clearActiveCodexAppServerRun("s3", handle, "agent:main:telegram:group:1:topic:9");
    expect(queueCodexAppServerMessageBySessionKey("agent:main:telegram:group:1:topic:9", "3")).toBe(
      false,
    );
  });

  it("submits typed pending input by session key while awaiting input", async () => {
    const submitPendingInput = vi.fn().mockResolvedValue(true);
    const handle = {
      queueMessage: vi.fn().mockResolvedValue(true),
      submitPendingInput,
      interrupt: vi.fn().mockResolvedValue(undefined),
      isStreaming: () => false,
      isAwaitingInput: () => true,
    };
    setActiveCodexAppServerRun("s4", handle, "agent:main:telegram:group:1:topic:10");
    expect(
      submitCodexAppServerPendingInputBySessionKey("agent:main:telegram:group:1:topic:10", {
        actionIndex: 1,
      }),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(submitPendingInput).toHaveBeenCalledWith({ actionIndex: 1 });
    });
    clearActiveCodexAppServerRun("s4", handle, "agent:main:telegram:group:1:topic:10");
  });
});
