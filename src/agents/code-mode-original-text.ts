import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import type { CodeModeJsonSource, CodeModeOutputSource } from "./code-mode-json.js";
import type { AgentToolResult } from "./runtime/index.js";
import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "./runtime/internal-hooks.js";
import { isToolResultError } from "./tool-result-error.js";

type TextBlocks = readonly Readonly<{ type: "text"; text: string }>[];
export type CodeModeOriginalTextMember = Readonly<{
  toolCallId: string;
  toolName: string;
  args: Readonly<Record<string, unknown>>;
  content: TextBlocks;
}>;
export type CodeModeOriginalTextSnapshot = Readonly<{
  complete: boolean;
  originalTextContent?: TextBlocks;
  members?: readonly CodeModeOriginalTextMember[];
  groupId?: string;
}>;

class OriginalTextProvenance {
  constructor(readonly snapshot: CodeModeOriginalTextSnapshot) {}
}

export function getCodeModeOriginalTextCapture(
  result: object,
): CodeModeOriginalTextSnapshot | undefined {
  const provenance = getInternalToolResultProvenance(result);
  return provenance instanceof OriginalTextProvenance ? provenance.snapshot : undefined;
}

function completeJson(source: CodeModeJsonSource): string | undefined {
  return source.originalJson ?? (source.kind === "complete" ? source.json : undefined);
}

function freezeJson(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      freezeJson(nested);
    }
    Object.freeze(value);
  }
}

/** Extra capture shares the output owner's lifetime; it never changes guest or public values. */
export class CodeModeOriginalTextCapture {
  private outputJson = "[]";
  private memberBytes = 0;
  private readonly members: CodeModeOriginalTextMember[] = [];
  private readonly pendingMembers = new Map<
    string,
    { member: CodeModeOriginalTextMember; bytes: number }
  >();
  private complete = true;
  private closed = false;

  constructor(
    private readonly maxBytes: number,
    private readonly groupId?: string,
  ) {}

  get maxCaptureBytes(): number {
    return this.complete && !this.closed ? this.maxBytes : 0;
  }

  invalidate(): void {
    this.complete = false;
    this.outputJson = "[]";
    this.members.length = 0;
    this.pendingMembers.clear();
    this.memberBytes = 0;
  }

  close(): void {
    this.closed = true;
    this.invalidate();
  }

  append(leg: CodeModeOutputSource): void {
    if (!this.complete || this.closed || leg.count === 0) {
      return;
    }
    const json = completeJson(leg.source);
    if (json === undefined) {
      this.invalidate();
      return;
    }
    const bytes =
      Buffer.byteLength(this.outputJson) +
      Buffer.byteLength(json) -
      (this.outputJson === "[]" ? 2 : 1);
    if (bytes > this.maxBytes - this.memberBytes) {
      this.invalidate();
      return;
    }
    this.outputJson =
      this.outputJson === "[]" ? json : this.outputJson.slice(0, -1) + "," + json.slice(1);
  }

  beginMember(input: { toolCallId: string; toolName: string; args: unknown }): void {
    if (!this.complete || this.closed) {
      return;
    }
    const candidate = { ...input, content: [] };
    const size = boundedJsonUtf8Bytes(
      candidate,
      this.maxBytes - this.memberBytes - Buffer.byteLength(this.outputJson),
    );
    if (this.members.length + this.pendingMembers.size >= 16 || !size.complete) {
      this.invalidate();
      return;
    }
    try {
      // JSON normalization omits unsupported members and converts Date/nonfinite values;
      // structuredClone would preserve those shapes in the public JSON-only snapshot.
      // oxlint-disable-next-line unicorn/prefer-structured-clone
      const args: unknown = JSON.parse(JSON.stringify(input.args));
      if (!isRecord(args)) {
        this.invalidate();
        return;
      }
      freezeJson(args);
      this.pendingMembers.set(input.toolCallId, {
        member: Object.freeze({ ...candidate, args, content: Object.freeze([]) }),
        bytes: size.bytes,
      });
      this.memberBytes += size.bytes;
    } catch {
      this.invalidate();
    }
  }

  captureMember(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: AgentToolResult<unknown>;
  }): void {
    if (!this.complete || this.closed) {
      return;
    }
    const pending = this.pendingMembers.get(input.toolCallId);
    if (
      !pending ||
      isToolResultError(input.result) ||
      !Array.isArray(input.result.content) ||
      !input.result.content.every(
        (block) => block.type === "text" && typeof block.text === "string",
      )
    ) {
      this.invalidate();
      return;
    }
    this.pendingMembers.delete(input.toolCallId);
    this.memberBytes -= pending.bytes;
    const candidate = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: pending.member.args,
      content: input.result.content.map((block) => {
        if (block.type !== "text") {
          throw new Error("Non-text Code Mode member.");
        }
        return { type: "text" as const, text: block.text };
      }),
    };
    const size = boundedJsonUtf8Bytes(
      candidate,
      this.maxBytes - this.memberBytes - Buffer.byteLength(this.outputJson),
    );
    if (!size.complete) {
      this.invalidate();
      return;
    }
    try {
      const member: CodeModeOriginalTextMember = Object.freeze({
        ...candidate,
        content: Object.freeze(candidate.content.map((block) => Object.freeze(block))),
      });
      this.members.push(member);
      this.memberBytes += size.bytes;
    } catch {
      this.invalidate();
    }
  }

  attach(
    result: object,
    metadata: object,
    channels: { value?: CodeModeJsonSource; error?: string },
  ): void {
    let snapshot: CodeModeOriginalTextSnapshot = { complete: false, groupId: this.groupId };
    if (channels.error !== undefined) {
      this.invalidate();
    }
    if (isRecord(metadata) && metadata.status === "completed" && this.pendingMembers.size > 0) {
      this.invalidate();
    }
    if (this.complete && !this.closed) {
      const valueJson = channels.value === undefined ? undefined : completeJson(channels.value);
      if (channels.value !== undefined && valueJson === undefined) {
        this.invalidate();
      } else {
        try {
          const metadataSize = boundedJsonUtf8Bytes(metadata, this.maxBytes - this.memberBytes);
          // Account for channel keys before allocating the complete response string.
          const bytes =
            metadataSize.bytes +
            Buffer.byteLength(this.outputJson) +
            (valueJson === undefined ? 0 : Buffer.byteLength(valueJson) + 9) +
            10;
          if (!metadataSize.complete || bytes + this.memberBytes > this.maxBytes) {
            this.invalidate();
          } else {
            const head = JSON.stringify(metadata).slice(0, -1);
            const text = `${head}${head === "{" ? "" : ","}"output":${this.outputJson}${valueJson === undefined ? "" : `,"value":${valueJson}`}}`;
            // Each delivery owns only its new emissions; earlier snapshots retain their bytes.
            this.outputJson = "[]";
            snapshot = Object.freeze({
              complete: true,
              originalTextContent: Object.freeze([Object.freeze({ type: "text" as const, text })]),
              ...(isRecord(metadata) && metadata.status === "completed" && this.members.length > 0
                ? { members: Object.freeze([...this.members]) }
                : {}),
              groupId: this.groupId,
            });
          }
        } catch {
          this.invalidate();
        }
      }
    }
    attachInternalToolResultProvenance(result, new OriginalTextProvenance(snapshot));
  }
}
