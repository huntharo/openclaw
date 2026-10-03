import type { PluginBlobEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  TokenMiserScope,
  TokenMiserAuthority,
  TokenMiserMetadata,
  TokenMiserTextContent,
  TokenMiserRetrieval,
  TokenMiserFullResult,
  TokenMiserRetrievalResult,
} from "./store-types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_MEMBERS = 16;
const MAX_LINES = 200;

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Token Miser ${label} must be ${minimum}–${maximum}.`);
  }
  return value;
}

function contentFromBytes(bytes: Uint8Array): TokenMiserTextContent[] {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (
    !Array.isArray(value) ||
    !value.every(
      (block: unknown) =>
        block !== null &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string",
    )
  ) {
    throw new Error("Token Miser retained content is invalid.");
  }
  return value;
}

function countLines(content: TokenMiserTextContent[]): number {
  let total = Math.max(1, content.length);
  for (const { text } of content) {
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      total++;
    }
  }
  return total;
}

function visitLines(
  content: TokenMiserTextContent[],
  visit: (line: number, text: string, start: number, end: number) => boolean,
): void {
  let line = 1;
  if (content.length === 0) {
    visit(line, "", 0, 0);
    return;
  }
  for (const { text } of content) {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      if (!visit(line++, text, start, end)) {
        return;
      }
      if (newline === -1) {
        break;
      }
      start = end + 1;
    }
  }
}

export function createTokenMiserRetriever(options: {
  maxResponseBytes: number;
  assertAccess: (scope: TokenMiserScope, authority: TokenMiserAuthority) => void;
  read: (
    id: string,
    scope: TokenMiserScope,
    authority: TokenMiserAuthority,
  ) => Promise<PluginBlobEntry<TokenMiserMetadata>>;
}) {
  const { maxResponseBytes, assertAccess, read } = options;
  function responseBudgetError(): Error {
    return new Error(
      "Token Miser response exceeds its byte budget; request fewer lines/results or use full with maxBytes and offsetBytes.",
    );
  }
  function boundedResult<T extends TokenMiserRetrievalResult>(result: T): T {
    if (encoder.encode(JSON.stringify(result)).byteLength > maxResponseBytes) {
      throw responseBudgetError();
    }
    return result;
  }

  function full(
    id: string,
    entry: PluginBlobEntry<TokenMiserMetadata>,
    request: TokenMiserRetrieval,
  ): TokenMiserFullResult {
    const offsetBytes = boundedInteger(
      request.offsetBytes ?? 0,
      0,
      entry.bytes.byteLength,
      "byte offset",
    );
    const chunkLimit = Math.max(1, Math.floor(((maxResponseBytes - 800) * 3) / 4));
    const maxBytes = boundedInteger(
      request.maxBytes ?? chunkLimit,
      1,
      chunkLimit,
      "retrieval byte count",
    );
    const end = Math.min(entry.bytes.byteLength, offsetBytes + maxBytes);
    return {
      id,
      mode: request.mode === "group" ? "group" : "full",
      format: "text-content-json-v1",
      encoding: "base64",
      offsetBytes,
      totalBytes: entry.bytes.byteLength,
      ...(end < entry.bytes.byteLength ? { nextOffsetBytes: end } : {}),
      data: Buffer.from(entry.bytes.subarray(offsetBytes, end)).toString("base64"),
      ...(request.mode === "group" && entry.metadata.memberIds
        ? { memberIds: entry.metadata.memberIds }
        : {}),
    };
  }

  async function retrieve(
    request: TokenMiserRetrieval,
    scope: TokenMiserScope,
    authority: TokenMiserAuthority,
  ): Promise<TokenMiserRetrievalResult> {
    assertAccess(scope, authority);
    if (request.mode === "batch") {
      if (!request.ids || request.ids.length < 1 || request.ids.length > MAX_MEMBERS) {
        throw new Error("Token Miser batch retrieval requires 1–16 result IDs.");
      }
      const results: TokenMiserFullResult[] = [];
      for (const id of request.ids) {
        const entry = await read(id, scope, authority);
        assertAccess(scope, authority);
        results.push(
          full(id, entry, {
            ...request,
            mode: "full",
            maxBytes:
              request.maxBytes ??
              Math.max(1, Math.floor(((maxResponseBytes / request.ids.length - 800) * 3) / 4)),
          }),
        );
      }
      return boundedResult({ mode: "batch", results });
    }
    if (!request.id) {
      throw new Error("Token Miser retrieval requires a result ID.");
    }
    const entry = await read(request.id, scope, authority);
    assertAccess(scope, authority);
    if (request.mode === "full" || request.mode === "group") {
      return boundedResult(full(request.id, entry, request));
    }
    const content = contentFromBytes(entry.bytes);
    const totalLines = countLines(content);
    const limit = boundedInteger(request.limit ?? 20, 1, MAX_LINES, "line limit");
    const selected: Array<{ line: number; text: string }> = [];
    let responseBytes = encoder.encode(
      JSON.stringify({ id: request.id, mode: request.mode, totalLines, lines: [] }),
    ).byteLength;
    const append = (line: number, text: string, start: number, end: number) => {
      // UTF-16 length is a lower bound for serialized JSON bytes; reject huge spans before slicing.
      if (end - start > maxResponseBytes - responseBytes) {
        throw responseBudgetError();
      }
      const item = { line, text: text.slice(start, end) };
      responseBytes += encoder.encode(JSON.stringify(item)).byteLength + (selected.length ? 1 : 0);
      if (responseBytes > maxResponseBytes) {
        throw responseBudgetError();
      }
      selected.push(item);
    };
    let nextLine: number | undefined;
    if (request.mode === "search") {
      if (!request.query || encoder.encode(request.query).byteLength > 1024) {
        throw new Error(
          "Token Miser search requires a nonempty literal query of at most 1024 bytes.",
        );
      }
      const start = boundedInteger(request.startLine ?? 1, 1, totalLines, "start line");
      const query = request.query;
      let nextMatch: number | undefined;
      if (!query.includes("\n")) {
        visitLines(content, (line, text, begin, end) => {
          if (begin === 0) {
            nextMatch = undefined;
          }
          if (line < start) {
            return true;
          }
          if (nextMatch === undefined || (nextMatch !== -1 && nextMatch < begin)) {
            nextMatch = text.indexOf(query, begin);
          }
          if (nextMatch === -1 || nextMatch + query.length > end) {
            return true;
          }
          if (selected.length === limit) {
            nextLine = line;
            return false;
          }
          append(line, text, begin, end);
          return true;
        });
      }
    } else {
      const start =
        request.mode === "tail"
          ? Math.max(1, totalLines - limit + 1)
          : request.mode === "head"
            ? 1
            : boundedInteger(request.startLine ?? 1, 1, totalLines, "start line");
      const end =
        request.mode === "lines"
          ? boundedInteger(
              request.endLine ?? Math.min(totalLines, start + limit - 1),
              start,
              totalLines,
              "end line",
            )
          : Math.min(totalLines, start + limit - 1);
      if (end - start + 1 > MAX_LINES) {
        throw new Error(
          "Token Miser line retrieval permits at most 200 lines; request a smaller range.",
        );
      }
      visitLines(content, (line, text, begin, finish) => {
        if (line > end) {
          return false;
        }
        if (line >= start) {
          append(line, text, begin, finish);
        }
        return true;
      });
      if (end < totalLines) {
        nextLine = end + 1;
      }
    }
    return boundedResult({
      id: request.id,
      mode: request.mode,
      totalLines,
      lines: selected,
      ...(nextLine ? { nextLine } : {}),
    });
  }

  return retrieve;
}
