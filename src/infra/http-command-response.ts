import { stripVTControlCharacters } from "node:util";

/** Separate HTTP headers emitted by CLI transports from their existing body output. */
export function parseHttpCommandResponse(
  output: string,
): { response: Response; body: string } | undefined {
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
