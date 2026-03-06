import { describe, expect, it } from "vitest";
import {
  buildCodexPendingInputButtons,
  buildCodexPendingUserInputActions,
  parseCodexPendingInputCallbackData,
} from "./codex-app-server-pending-input.js";

describe("buildCodexPendingUserInputActions", () => {
  it("builds typed approval actions from available decisions", () => {
    const actions = buildCodexPendingUserInputActions({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        availableDecisions: [
          { decision: "accept", label: "Approve Once" },
          {
            decision: "acceptForSession",
            label: "Approve for Session",
            proposedExecpolicyAmendment: { prefix: "npm view" },
          },
          { decision: "decline", label: "Decline" },
        ],
      },
    });

    expect(actions).toEqual([
      { kind: "approval", decision: "accept", label: "Approve Once" },
      {
        kind: "approval",
        decision: "acceptForSession",
        label: "Approve for Session",
        sessionPrefix: "npm view",
      },
      { kind: "approval", decision: "decline", label: "Decline" },
      { kind: "steer", label: "Tell Codex What To Do" },
    ]);
  });
});

describe("buildCodexPendingInputButtons", () => {
  it("encodes typed callback payloads with the request token", () => {
    const buttons = buildCodexPendingInputButtons({
      requestId: "3526d05c-ebf2-404c-9ce2-1c380a143ca8-mmffeqxg",
      actions: [
        { kind: "approval", decision: "accept", label: "Approve Once" },
        { kind: "approval", decision: "decline", label: "Decline" },
        { kind: "steer", label: "Tell Codex What To Do" },
      ],
    });

    expect(buttons).toEqual([
      [
        {
          text: "Approve Once",
          callback_data: expect.stringMatching(/^cdxui:/),
        },
        {
          text: "Decline",
          callback_data: expect.stringMatching(/^cdxui:/),
        },
      ],
      [
        {
          text: "Tell Codex What To Do",
          callback_data: expect.stringMatching(/^cdxui:/),
        },
      ],
    ]);
    const parsed = parseCodexPendingInputCallbackData(buttons?.[0]?.[0]?.callback_data ?? "");
    expect(parsed).toMatchObject({ actionIndex: 0 });
  });
});
