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
