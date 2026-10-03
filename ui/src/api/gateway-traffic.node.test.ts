/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";

let client: GatewayBrowserClient;
beforeEach(() => {
  useNodeFakeTimers();
  wsInstances.length = 0;
  stubWindowGlobals();
  vi.stubGlobal("WebSocket", MockWebSocket);
  client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789" });
});
afterEach(() => {
  client.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("unsubscribes counters without retiring a replacement and clears them when the client stops", () => {
  client.start();
  const socket = getLatestWebSocket();
  const previous = vi.fn();
  const unsubscribe = client.observeTraffic(previous);
  const replacement = vi.fn();
  const unsubscribeReplacement = client.observeTraffic(replacement);
  unsubscribe();
  socket.emitMessage("unparsed incoming bytes");
  expect(previous).not.toHaveBeenCalled();
  expect(replacement).toHaveBeenCalledWith("received", 23);
  unsubscribeReplacement();
  socket.emitMessage("unparsed incoming bytes");
  expect(replacement).toHaveBeenCalledOnce();
  const stopped = vi.fn();
  client.observeTraffic(stopped);
  client.stop();
  socket.emitMessage("queued before stop");
  client.start();
  getLatestWebSocket().emitMessage("new connection");
  expect(stopped).not.toHaveBeenCalled();
});
