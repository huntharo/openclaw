import { describe, expect, it } from "vitest";
import {
  __testing,
  isCodexAppServerProvider,
  parseCodexUserInput,
} from "./codex-app-server-runner.js";

describe("parseCodexUserInput", () => {
  it("parses numeric option choices", () => {
    expect(parseCodexUserInput("1", 3)).toEqual({ kind: "option", index: 0 });
    expect(parseCodexUserInput("option 2", 3)).toEqual({ kind: "option", index: 1 });
    expect(parseCodexUserInput("Option 3", 3)).toEqual({ kind: "option", index: 2 });
  });

  it("falls back to free-form text for invalid option indices", () => {
    expect(parseCodexUserInput("0", 3)).toEqual({ kind: "text", text: "0" });
    expect(parseCodexUserInput("option 9", 3)).toEqual({ kind: "text", text: "option 9" });
  });

  it("returns text when there is no option syntax", () => {
    expect(parseCodexUserInput("ship it", 3)).toEqual({ kind: "text", text: "ship it" });
  });
});

describe("isCodexAppServerProvider", () => {
  it("matches the codex-app-server provider id", () => {
    expect(isCodexAppServerProvider("codex-app-server")).toBe(true);
  });

  it("respects explicit disablement in config", () => {
    expect(
      isCodexAppServerProvider("codex-app-server", {
        agents: { defaults: { codexAppServer: { enabled: false } } },
      }),
    ).toBe(false);
  });
});

describe("isMethodUnavailableError", () => {
  it("recognizes unknown variant errors for the matching rpc method", () => {
    expect(
      __testing.isMethodUnavailableError(
        new Error(
          "codex app server rpc error (-32600): Invalid request: unknown variant `session/update`",
        ),
        "session/update",
      ),
    ).toBe(true);
  });

  it("does not treat other unknown variant errors as the same rpc method", () => {
    expect(
      __testing.isMethodUnavailableError(
        new Error(
          "codex app server rpc error (-32600): Invalid request: unknown variant `thread/list`",
        ),
        "session/update",
      ),
    ).toBe(false);
  });
});

describe("applyThreadFilter", () => {
  it("prefers project path matches over summary text matches", () => {
    const threads = [
      {
        threadId: "thread-1",
        projectKey: "/Users/huntharo/github/jeerreview",
      },
      {
        threadId: "thread-2",
        title: "Planning work",
        projectKey: "/Users/huntharo/.openclaw/workspace-pwrdrvr",
        summary: "Discussed jeerreview migration details",
      },
      {
        threadId: "thread-3",
        title: "Plan TASKS doc refresh",
        projectKey: "/Users/huntharo/github/jeerreview",
      },
    ];

    expect(__testing.applyThreadFilter(threads, "jeerreview")).toEqual([threads[0], threads[2]]);
  });

  it("prefers title matches before falling back to summary matches", () => {
    const threads = [
      {
        threadId: "thread-1",
        title: "Fix Telegram approval flow",
        projectKey: "/Users/huntharo/github/openclaw",
      },
      {
        threadId: "thread-2",
        summary: "Work on Telegram approval buttons",
        projectKey: "/Users/huntharo/.openclaw/workspace-pwrdrvr",
      },
    ];

    expect(__testing.applyThreadFilter(threads, "approval")).toEqual([threads[0]]);
  });
});

describe("buildCodexTelegramOptionButtons", () => {
  it("renders numbered Telegram buttons for pending input options", () => {
    expect(__testing.buildCodexTelegramOptionButtons(["Approve", "Decline", "Cancel"])).toEqual([
      [
        { text: "1. Approve", callback_data: "1" },
        { text: "2. Decline", callback_data: "2" },
      ],
      [{ text: "3. Cancel", callback_data: "3" }],
    ]);
  });
});

describe("mapPendingInputResponse", () => {
  it("maps approval text to the expected Codex decision", () => {
    expect(__testing.resolveApprovalDecisionFromText("Approve for this session", true)).toBe(
      "acceptForSession",
    );
    expect(__testing.resolveApprovalDecisionFromText("Decline", true)).toBe("decline");
    expect(__testing.resolveApprovalDecisionFromText("Cancel", true)).toBe("cancel");
  });

  it("maps timed-out approvals to cancel", () => {
    expect(
      __testing.mapPendingInputResponse({
        methodLower: "server/requestapproval",
        requestParams: {},
        response: { text: "Approve" },
        options: ["Approve", "Decline"],
        timedOut: true,
      }),
    ).toEqual({ decision: "cancel" });
  });

  it("maps tool request user input selections into answer payloads", () => {
    expect(
      __testing.mapPendingInputResponse({
        methodLower: "item/tool/requestuserinput",
        requestParams: {
          questions: [
            {
              id: "approval",
              options: [{ label: "Approve" }, { label: "Decline" }],
            },
          ],
        },
        response: { index: 1 },
        options: ["Approve", "Decline"],
        timedOut: false,
      }),
    ).toEqual({
      answers: {
        approval: {
          answers: ["Decline"],
        },
      },
    });
  });
});
