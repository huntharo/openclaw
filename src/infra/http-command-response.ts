import { stripVTControlCharacters } from "node:util";

/** Separate HTTP headers emitted by CLI transports from their existing body output. */
export function parseHttpCommandResponse(
  output: string,
  { lastResponse = false }: { lastResponse?: boolean } = {},
): { response: Response; body: string } | undefined {
  if (lastResponse) {
    // A failed CLI command can retain successful pages before its final response.
    let frameStart = 0;
    for (const match of output.matchAll(/^HTTP\/[\d.]+ [2-5]\d{2}\b/gmu)) {
      frameStart = match.index;
    }
    output = output.slice(frameStart);
  }
  const boundary = /\r?\n\r?\n/u.exec(output);
  if (!boundary) {
    return undefined;
  }
  const headerOutput = stripVTControlCharacters(output.slice(0, boundary.index));
  const status = /^HTTP\/[\d.]+ ([2-5]\d{2})\b/u.exec(headerOutput)?.[1];
  if (!status) {
    return undefined;
  }
  const headers = new Headers();
  for (const line of headerOutput.split(/\r?\n/u).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
  }
  return {
    response: new Response(null, { status: Number(status), headers }),
    body: output.slice(boundary.index + boundary[0].length),
  };
}
