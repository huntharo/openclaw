/** @vitest-environment node */
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserGatewaySocket,
  type GatewayTrafficObserverCell,
} from "./gateway-browser-socket.ts";

type MockSocketEvent = { code?: number; data?: unknown; reason?: string };
type MockSocketHandler = (event: MockSocketEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly OPEN = 1;
  readonly close = vi.fn((code?: number, _reason?: string) => {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
  });
  readonly handlers = new Map<string, MockSocketHandler[]>();
  readyState = 0;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: MockSocketHandler) {
    const handlers = this.handlers.get(type) ?? [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  readonly send = vi.fn<(data: string) => void>();

  emit(type: string, event: MockSocketEvent = {}) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }
}

function createHandlers() {
  return {
    open: vi.fn(),
    message: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
  };
}

describe("createBrowserGatewaySocket", () => {
  let socket: MockWebSocket;
  let handlers: ReturnType<typeof createHandlers>;
  let socketAdapter: ReturnType<typeof createBrowserGatewaySocket>;
  let traffic: GatewayTrafficObserverCell;
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    handlers = createHandlers();
    traffic = {};
    socketAdapter = createBrowserGatewaySocket(
      "wss://gateway.example",
      handlers,
      undefined,
      traffic,
    );
    const created = sockets[0];
    if (!created) {
      throw new Error("expected a websocket instance");
    }
    socket = created;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["é🙂", 6, "é🙂"],
    [new Blob(["é🙂"]), 6, "[object Blob]"],
    [new ArrayBuffer(9), 9, "[object ArrayBuffer]"],
    [new Uint8Array(new ArrayBuffer(10), 2, 4), 4, "0,0,0,0"],
  ])("counts native incoming data before conversion (%s)", (data, bytes, converted) => {
    traffic.observer = vi.fn();
    socket.emit("message", { data });
    expect(traffic.observer).toHaveBeenCalledWith("received", bytes);
    expect(handlers.message).toHaveBeenCalledWith(converted);
  });

  it("isolates a throwing observer from message delivery and successful sends", () => {
    traffic.observer = () => {
      throw new Error("diagnostic callback failed");
    };
    expect(() => socket.emit("message", { data: "é🙂" })).not.toThrow();
    expect(handlers.message).toHaveBeenCalledWith("é🙂");
    expect(() => socketAdapter.send("é🙂")).not.toThrow();
    expect(socket.send).toHaveBeenCalledWith("é🙂");
  });

  it("does no diagnostic encoding when disabled and reuses payload-limit sizing", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    socket.emit("message", { data: "é🙂" });
    socketAdapter.send("é🙂");
    expect(encode).not.toHaveBeenCalled();
    const observer = vi.fn();
    const limited = createBrowserGatewaySocket("wss://gateway.example", handlers, () => 6, {
      observer,
    });
    const native = sockets[1]!;
    limited.send("é🙂");
    expect(encode).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith("sent", 6);
    observer.mockClear();
    expect(() => limited.send("é🙂x")).toThrow("payload limit");
    expect(native.send).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
    native.send.mockImplementationOnce(() => {
      throw new Error("socket send rejected");
    });
    expect(() => limited.send("é🙂")).toThrow("socket send rejected");
    expect(observer).not.toHaveBeenCalled();
  });

  it.each(["local", "remote"])(
    "retires queued observations after %s close even when the observer is replaced",
    (close) => {
      const previous = vi.fn();
      traffic.observer = previous;
      if (close === "local") {
        socketAdapter.close(1000, "stopped");
      } else {
        socket.emit("close", { code: 1000 });
      }
      const replacement = vi.fn();
      traffic.observer = replacement;
      socket.emit("message", { data: "old socket" });
      expect(previous).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      createBrowserGatewaySocket("wss://gateway.example", handlers, undefined, traffic);
      sockets[1]!.emit("message", { data: "new socket" });
      expect(replacement).toHaveBeenCalledWith("received", 10);
    },
  );

  it("closes a websocket that never finishes opening", async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error.mock.calls[0]?.[0]).toEqual(
      new Error(
        `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
      ),
    );
    expect(socket.close).toHaveBeenCalledOnce();

    socket.emit("error");
    socket.emit("close", { code: 1006, reason: "" });
    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.close).toHaveBeenCalledWith(
      1006,
      `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
    );
  });

  it("preserves a real close reason when an opening timeout also occurred", async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    socket.emit("close", { code: 1006, reason: "gateway supplied a close reason" });

    expect(handlers.close).toHaveBeenCalledWith(1006, "gateway supplied a close reason");
  });

  it("clears the opening deadline after the socket opens", async () => {
    socket.readyState = MockWebSocket.OPEN;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.open).toHaveBeenCalledOnce();
    expect(handlers.error).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline after a native transport failure", async () => {
    socket.emit("error");
    socket.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error).toHaveBeenCalledWith(new Error("websocket error"));
    expect(handlers.close).toHaveBeenCalledWith(1006, "");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline when the client closes the socket", async () => {
    socketAdapter.close(1000, "stopped");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(socket.close).toHaveBeenCalledWith(1000, "stopped");
    expect(handlers.error).not.toHaveBeenCalled();
  });

  it("maps protocol policy-violation closes to the browser-safe connect failure code", () => {
    expect(() => socketAdapter.close(1008, "connect failed")).not.toThrow();
    expect(socket.close).toHaveBeenCalledWith(4008, "connect failed");
  });

  it("does not normalize other invalid browser close codes", () => {
    expect(() => socketAdapter.close(1009, "invalid client close")).toThrow(
      expect.objectContaining({ name: "InvalidAccessError" }),
    );
  });

  it("preserves policy-violation closes received from the gateway", () => {
    socket.emit("close", { code: 1008, reason: "pairing required" });

    expect(handlers.close).toHaveBeenCalledWith(1008, "pairing required");
  });
});
