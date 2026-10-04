// Register thread tests cover message thread command registration and option wiring.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageThreadCommands } from "./register.thread.js";

function createHelpers(runMessageAction: MessageCliHelpers["runMessageAction"]): MessageCliHelpers {
  return {
    withMessageBase: (command, target) => {
      if (target === "required") {
        command.requiredOption("-t, --target <dest>", "Target");
      }
      return command.option("--channel <channel>", "Channel");
    },
    runMessageAction,
  };
}

function firstMessageActionCall(runMessageAction: { mock: { calls: unknown[][] } }) {
  return runMessageAction.mock.calls[0] as [string, Record<string, unknown>] | undefined;
}

describe("registerMessageThreadCommands", () => {
  const runMessageAction = vi.fn(
    async (_action: string, _opts: Record<string, unknown>) => undefined,
  );

  it("forwards raw thread create options to the admission-owning shared runner", async () => {
    runMessageAction.mockClear();
    const message = new Command().exitOverride();
    registerMessageThreadCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "thread",
        "create",
        "--channel",
        "plain-chat",
        "-t",
        "channel:123",
        "--thread-name",
        "Build Updates",
        "-m",
        "hello",
      ],
      { from: "user" },
    );

    const defaultCall = firstMessageActionCall(runMessageAction);
    expect(defaultCall?.[0]).toBe("thread-create");
    expect(defaultCall?.[1]?.channel).toBe("plain-chat");
    expect(defaultCall?.[1]?.target).toBe("channel:123");
    expect(defaultCall?.[1]?.threadName).toBe("Build Updates");
    expect(defaultCall?.[1]?.message).toBe("hello");
    expect(defaultCall?.[1]).not.toHaveProperty("name");
  });
});
