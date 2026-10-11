import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";

type Direction = "sent" | "received";
type Counts = {
  frames: number;
  payloadBytes: number;
  largestPayloadBytes: number;
  repeatedPayloads: number;
};
type Bucket = Counts & { direction: Direction; kind: string; name: string };
const MAX_BUCKETS = 128;
const MAX_PENDING_REQUESTS = 1024;
const MAX_FINGERPRINTS = 4096;
const MAX_ANALYZED_PAYLOAD_BYTES = 1024 * 1024;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: unknown): string {
  return hash(
    JSON.stringify(value, (_key, item: unknown) => {
      const record = asOptionalRecord(item);
      return record
        ? Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)))
        : item;
    }) ?? "null",
  );
}

function protocolName(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9._/-]{0,159}$/.test(value)
    ? value
    : "unknown";
}

function emptyCounts(): Counts {
  return { frames: 0, payloadBytes: 0, largestPayloadBytes: 0, repeatedPayloads: 0 };
}

/** Invocation-owned, size-only evidence. No payloads, URLs, IDs, or hashes are exported. */
export function createGatewayTrafficCapture() {
  const totals = { sent: emptyCounts(), received: emptyCounts() };
  const buckets = new Map<string, Bucket>();
  const pending = new Map<string, string>();
  const fingerprints = new Set<string>();
  let fingerprintEvictions = 0;
  let unmatchedResponses = 0;
  let fingerprintFailures = 0;
  let oversizedFrames = 0;
  const analyzeFingerprint = (value: unknown) => {
    try {
      return fingerprint(value);
    } catch {
      // Deep JSON can exceed the serializer stack; its wire bytes still count.
      fingerprintFailures += 1;
      return undefined;
    }
  };

  return {
    record(socket: string, direction: Direction, opcode: number, payload: string) {
      const bytes = Buffer.byteLength(payload, opcode === 1 ? "utf8" : "base64");
      let kind = opcode === 1 ? "other-text" : "binary";
      let name = "unknown";
      let signature: string | undefined;
      if (opcode === 1 && bytes > MAX_ANALYZED_PAYLOAD_BYTES) {
        kind = "oversized-text";
        oversizedFrames += 1;
      } else if (opcode === 1) {
        let frame: Record<string, unknown> | undefined;
        try {
          frame = asOptionalRecord(JSON.parse(payload));
        } catch {
          // Malformed/non-Gateway traffic still contributes to the page's byte total.
        }
        if (frame?.type === "req" && typeof frame.id === "string") {
          kind = "request";
          name = protocolName(frame.method);
          const key = hash(JSON.stringify([socket, frame.id]));
          if (pending.size >= MAX_PENDING_REQUESTS && !pending.has(key)) {
            pending.delete(pending.keys().next().value!);
          }
          pending.set(key, name);
          if (name !== "connect") {
            signature = analyzeFingerprint({ method: frame.method, params: frame.params });
          }
        } else if (frame?.type === "res" && typeof frame.id === "string") {
          kind = "response";
          const key = hash(JSON.stringify([socket, frame.id]));
          name = pending.get(key) ?? "unmatched";
          unmatchedResponses += Number(name === "unmatched");
          if (asOptionalRecord(frame.payload)?.status !== "accepted") {
            pending.delete(key);
          }
          if (name !== "connect") {
            signature = analyzeFingerprint({
              ok: frame.ok,
              payload: frame.payload,
              error: frame.error,
            });
          }
        } else if (frame?.type === "event") {
          kind = "event";
          name = protocolName(frame.event);
          signature = analyzeFingerprint({ event: frame.event, payload: frame.payload });
        }
      }
      let key = JSON.stringify([direction, kind, name]);
      if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
        key = JSON.stringify([direction, "overflow", "other"]);
        kind = "overflow";
        name = "other";
      }
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { direction, kind, name, ...emptyCounts() };
        buckets.set(key, bucket);
      }
      const repeatKey = signature ? `${hash(socket)}:${key}:${signature}` : undefined;
      const repeated = repeatKey !== undefined && fingerprints.has(repeatKey);
      if (repeatKey && !repeated) {
        if (fingerprints.size >= MAX_FINGERPRINTS) {
          fingerprints.delete(fingerprints.values().next().value!);
          fingerprintEvictions += 1;
        }
        fingerprints.add(repeatKey);
      }
      for (const counts of [totals[direction], bucket]) {
        counts.frames += 1;
        counts.payloadBytes += bytes;
        counts.largestPayloadBytes = Math.max(counts.largestPayloadBytes, bytes);
        counts.repeatedPayloads += Number(repeated);
      }
    },
    snapshot() {
      return {
        sent: { ...totals.sent },
        received: { ...totals.received },
        buckets: Array.from(buckets.values(), (bucket) => ({ ...bucket })),
        unmatchedResponses,
        fingerprintEvictions,
        fingerprintFailures,
        oversizedFrames,
        limits: {
          bucketNames: MAX_BUCKETS,
          pendingRequests: MAX_PENDING_REQUESTS,
          fingerprints: MAX_FINGERPRINTS,
          analyzedPayloadBytes: MAX_ANALYZED_PAYLOAD_BYTES,
        },
      };
    },
  };
}

/** Observe the selected page without navigating it or changing its Gateway connection. */
export async function observeGatewayTraffic(page: Page) {
  const capture = createGatewayTrafficCapture();
  const session = await page.context().newCDPSession(page);
  session.on("Network.webSocketFrameSent", ({ requestId, response }) => {
    capture.record(requestId, "sent", response.opcode, response.payloadData);
  });
  session.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
    capture.record(requestId, "received", response.opcode, response.payloadData);
  });
  try {
    await session.send("Network.enable");
  } catch (error) {
    await session.detach();
    throw error;
  }
  return { snapshot: () => capture.snapshot(), stop: () => session.detach() };
}
