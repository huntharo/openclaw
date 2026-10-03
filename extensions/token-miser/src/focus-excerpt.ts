import type { TokenMiserRetrievalResult } from "./store.js";

export function decodeFocusExcerpt(page: TokenMiserRetrievalResult) {
  if (page.mode !== "full" && page.mode !== "group") {
    throw new Error("Token Miser focus requires a retained byte page.");
  }
  // Full pages may end inside a codepoint. Streaming decode omits its incomplete suffix.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(page.data, "base64"), {
    stream: true,
  });
  const coveredBytes = Buffer.byteLength(text, "utf8");
  return {
    format: page.format,
    offsetBytes: page.offsetBytes,
    totalBytes: page.totalBytes,
    coveredBytes,
    partial: page.offsetBytes + coveredBytes < page.totalBytes,
    text,
  };
}
