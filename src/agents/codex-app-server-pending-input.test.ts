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
      {
        kind: "approval",
        decision: "accept",
        responseDecision: "accept",
        label: "Approve Once",
      },
      {
        kind: "approval",
        decision: "acceptForSession",
        responseDecision: "acceptForSession",
        label: "Approve for Session",
        proposedExecpolicyAmendment: { prefix: "npm view" },
        sessionPrefix: "npm view",
      },
      {
        kind: "approval",
        decision: "decline",
        responseDecision: "decline",
        label: "Decline",
      },
      { kind: "steer", label: "Tell Codex What To Do" },
    ]);
  });

  it("finds nested approval decisions and preserves Codex-provided labels", () => {
    const actions = buildCodexPendingUserInputActions({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        questions: [
          {
            prompt: "Allow this command?",
            decisions: [
              { decision: "accept", label: "Yes" },
              {
                decision: "acceptWithExecPolicyAmendment",
                label: "Yes, and don't ask again for commands that start with npm view",
                proposedExecpolicyAmendment: { prefix: "npm view" },
              },
              { decision: "decline", label: "No, and tell Codex what to do differently" },
            ],
          },
        ],
      },
    });

    expect(actions).toEqual([
      {
        kind: "approval",
        decision: "accept",
        responseDecision: "accept",
        label: "Yes",
      },
      {
        kind: "approval",
        decision: "acceptForSession",
        responseDecision: "acceptWithExecPolicyAmendment",
        label: "Yes, and don't ask again for commands that start with npm view",
        proposedExecpolicyAmendment: { prefix: "npm view" },
        sessionPrefix: "npm view",
      },
      {
        kind: "approval",
        decision: "decline",
        responseDecision: "decline",
        label: "No, and tell Codex what to do differently",
      },
      { kind: "steer", label: "Tell Codex What To Do" },
    ]);
  });
});

describe("buildCodexPendingInputButtons", () => {
  it("encodes typed callback payloads with the request token", () => {
    const buttons = buildCodexPendingInputButtons({
      requestId: "3526d05c-ebf2-404c-9ce2-1c380a143ca8-mmffeqxg",
      actions: [
        {
          kind: "approval",
          decision: "accept",
          responseDecision: "accept",
          label: "Approve Once",
        },
        {
          kind: "approval",
          decision: "decline",
          responseDecision: "decline",
          label: "Decline",
        },
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
