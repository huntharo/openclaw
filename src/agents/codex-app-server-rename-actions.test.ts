import { describe, expect, it } from "vitest";
import {
  buildCodexRenameActionCallbackData,
  parseCodexRenameActionCallbackData,
} from "./codex-app-server-rename-actions.js";

describe("codex rename action callbacks", () => {
  it("round-trips the with-project action", () => {
    const data = buildCodexRenameActionCallbackData({
      requestId: "rename-prompt-1",
      action: "withProject",
    });

    expect(parseCodexRenameActionCallbackData(data)).toEqual({
      action: "withProject",
      requestToken: "rename-prompt-1",
    });
  });

  it("rejects malformed callback data", () => {
    expect(parseCodexRenameActionCallbackData("cdxrn:x:rename-prompt-1")).toBeNull();
  });
});
