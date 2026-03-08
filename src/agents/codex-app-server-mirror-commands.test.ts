import { describe, expect, it } from "vitest";
import {
  CODEX_BUILT_IN_MIRRORED_COMMANDS,
  getCodexBuiltInMirroredCommandCount,
} from "./codex-app-server-mirror-commands.js";

describe("codex mirrored commands", () => {
  it("exports the built-in mirrored command list", () => {
    expect(getCodexBuiltInMirroredCommandCount()).toBe(CODEX_BUILT_IN_MIRRORED_COMMANDS.length);
    expect(CODEX_BUILT_IN_MIRRORED_COMMANDS).toContainEqual(
      expect.objectContaining({ baseName: "stop" }),
    );
    expect(CODEX_BUILT_IN_MIRRORED_COMMANDS).toContainEqual(
      expect.objectContaining({ baseName: "plan" }),
    );
    expect(CODEX_BUILT_IN_MIRRORED_COMMANDS).toContainEqual(
      expect.objectContaining({ baseName: "resume" }),
    );
  });
});
