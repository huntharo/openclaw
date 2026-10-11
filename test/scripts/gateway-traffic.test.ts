import { describe, expect, it } from "vitest";
import { createGatewayTrafficCapture } from "../../scripts/lib/gateway-traffic.ts";

describe("Gateway traffic evidence", () => {
  it("keeps exact byte totals when deep or oversized JSON cannot be fingerprinted", () => {
    const capture = createGatewayTrafficCapture();
    const deep =
      '{"type":"event","event":"chat","payload":' +
      "[".repeat(50000) +
      "0" +
      "]".repeat(50000) +
      "}";
    capture.record("socket", "received", 1, deep);
    const oversized = JSON.stringify({
      type: "event",
      event: "chat",
      payload: "x".repeat(1024 * 1024),
    });
    capture.record("socket", "received", 1, oversized);
    expect(capture.snapshot()).toMatchObject({
      received: { frames: 2, payloadBytes: 1148663, repeatedPayloads: 0 },
      fingerprintFailures: 1,
      oversizedFrames: 1,
    });
  });
  it("counts original UTF-8/binary payload bytes and correlates accepted/final replies without retaining content", () => {
    const capture = createGatewayTrafficCapture();
    const record = (direction: "sent" | "received", frame: unknown) =>
      capture.record("socket", direction, 1, JSON.stringify(frame));
    record("sent", {
      type: "req",
      id: "private-id",
      method: "chat.send",
      params: { message: "private 🦞" },
    });
    record("received", {
      type: "res",
      id: "private-id",
      ok: true,
      payload: { status: "accepted" },
    });
    record("received", { type: "res", id: "private-id", ok: true, payload: { status: "done" } });
    capture.record("socket", "received", 2, Buffer.from([0, 255, 128]).toString("base64"));
    const result = capture.snapshot();
    expect(result.sent).toEqual({
      frames: 1,
      payloadBytes: 89,
      largestPayloadBytes: 89,
      repeatedPayloads: 0,
    });
    expect(result.received.frames).toBe(3);
    expect(result.buckets.find((bucket) => bucket.kind === "response")).toMatchObject({
      name: "chat.send",
      frames: 2,
    });
    expect(result.buckets.find((bucket) => bucket.kind === "binary")?.payloadBytes).toBe(3);
    expect(result.unmatchedResponses).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private|message|accepted|done/);
  });

  it("detects semantic request repeats despite new IDs/key order, while separating changed actions and sockets", () => {
    const capture = createGatewayTrafficCapture();
    const request = (socket: string, id: string, params: unknown) =>
      capture.record(
        socket,
        "sent",
        1,
        JSON.stringify({ type: "req", id, method: "sessions.list", params }),
      );
    request("first", "1", { limit: 80, agentId: "main" });
    request("first", "2", { agentId: "main", limit: 80 });
    request("first", "3", { agentId: "main", limit: 20 });
    request("replacement", "4", { agentId: "main", limit: 80 });
    expect(capture.snapshot().sent).toMatchObject({ frames: 4, repeatedPayloads: 1 });
    capture.record(
      "first",
      "received",
      1,
      JSON.stringify({ type: "event", event: "presence", seq: 1, payload: { presence: [] } }),
    );
    capture.record(
      "first",
      "received",
      1,
      JSON.stringify({ type: "event", event: "presence", seq: 2, payload: { presence: [] } }),
    );
    expect(capture.snapshot().received.repeatedPayloads).toBe(1);
  });

  it("bounds named buckets, pending correlation and repeat evidence during noisy captures", () => {
    const capture = createGatewayTrafficCapture();
    for (let index = 0; index < 4200; index += 1) {
      capture.record(
        "socket",
        "sent",
        1,
        JSON.stringify({
          type: "req",
          id: `r-${index}`,
          method: `plugin.method${index}`,
          params: { index },
        }),
      );
    }
    capture.record(
      "socket",
      "received",
      1,
      JSON.stringify({ type: "res", id: "r-0", ok: true, payload: {} }),
    );
    const result = capture.snapshot();
    expect(result.sent.frames).toBe(4200);
    expect(result.buckets.length).toBeLessThanOrEqual(130);
    expect(result.buckets.find((bucket) => bucket.kind === "overflow")).toMatchObject({
      frames: 4072,
    });
    expect(result.unmatchedResponses).toBe(1);
    expect(result.fingerprintEvictions).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("r-0");
  });
});
