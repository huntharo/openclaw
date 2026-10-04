import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { resolvePluginSourceCapturesDirectory } from "../plugins/plugin-source-capture-path.js";

type SourceArtifact = { kind: "directory" } | { kind: "file"; bytes: Buffer };
type CaptureArtifact = {
  kind: "directory" | "file" | "link";
  dev: number;
  ino: number;
  bytes?: Buffer;
  target?: string;
};

/** Inspect private captures without following their host-package links into unrelated trees. */
export function readColdMessageArtifacts(stateDir: string, hostRoot: string) {
  const captureRoot = resolvePluginSourceCapturesDirectory(stateDir);
  const captureParent = path.dirname(captureRoot);
  const durable: Record<string, SourceArtifact> = {};
  const captures: Record<string, CaptureArtifact> = {};
  const instances = new Set<string>();
  let admitted = 0;
  const visit = (directory: string, privateCapture: boolean) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      expect(++admitted, "bounded source/capture inventory").toBeLessThanOrEqual(128);
      const filename = path.join(directory, entry.name);
      if (filename === captureRoot) {
        expect(entry.isDirectory(), "capture namespace must be a directory").toBe(true);
        visit(filename, true);
        continue;
      }
      const name = path.relative(privateCapture ? captureRoot : stateDir, filename);
      const stat = fs.lstatSync(filename);
      expect(stat.isDirectory() || stat.isFile() || stat.isSymbolicLink(), name).toBe(true);
      if (privateCapture) {
        const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "link";
        captures[name] = { kind, dev: stat.dev, ino: stat.ino };
        if (kind === "link") {
          expect(name.split(path.sep)).toEqual([
            expect.any(String),
            "captures",
            expect.stringMatching(/^openclaw-plugin-build-/u),
            "node_modules",
            "openclaw",
          ]);
          const target = fs.readlinkSync(filename);
          expect(path.resolve(path.dirname(filename), target)).toBe(fs.realpathSync(hostRoot));
          captures[name].target = target;
        } else if (kind === "file") {
          captures[name].bytes = fs.readFileSync(filename);
        }
        if (directory === captureRoot) {
          expect(stat.isDirectory(), name).toBe(true);
          instances.add(filename);
        }
      } else {
        expect(stat.isSymbolicLink(), `unexpected source link ${name}`).toBe(false);
        // The capture owner may leave its namespace parents; other tmp contents stay in scope.
        if (filename === captureParent) {
          expect(stat.isDirectory(), name).toBe(true);
        }
        if (filename !== captureParent) {
          durable[name] = stat.isDirectory()
            ? { kind: "directory" }
            : { kind: "file", bytes: fs.readFileSync(filename) };
        }
      }
      if (stat.isDirectory()) {
        visit(filename, privateCapture);
      }
    }
  };
  visit(stateDir, false);
  return { durable, captures, instances };
}

export function assertColdMessageSourceUnchanged(
  reference: ReturnType<typeof readColdMessageArtifacts>,
  current: ReturnType<typeof readColdMessageArtifacts>,
  phase: "closed-state" | "published-agent-state" = "closed-state",
) {
  expect(Object.keys(current.durable).toSorted()).toEqual(
    Object.keys(reference.durable).toSorted(),
  );
  for (const [name, original] of Object.entries(reference.durable)) {
    const actual = current.durable[name];
    expect(actual?.kind, name).toBe(original.kind);
    if (original.kind === "file") {
      if (
        phase === "published-agent-state" &&
        name === "agents/main/agent/openclaw-agent.sqlite-shm"
      ) {
        // SQLite WAL format §2.1: bytes 100..119 coordinate live readers, not database content.
        expect(
          actual?.kind === "file" &&
            actual.bytes.length === original.bytes.length &&
            actual.bytes.subarray(0, 100).equals(original.bytes.subarray(0, 100)) &&
            actual.bytes.subarray(120).equals(original.bytes.subarray(120)),
          name,
        ).toBe(true);
      } else {
        expect(actual?.kind === "file" && actual.bytes.equals(original.bytes), name).toBe(true);
      }
    }
  }
}
