import type { ControlUiMockGateway } from "./control-ui-e2e-contract.ts";

// Serialized into the browser with the mock socket; keep runtime dependencies local.
export function createControlUiMockWire(capture: boolean) {
  const frames: ControlUiMockGateway["wireFrames"] = [];
  let bytes = 0;
  let dropped = 0;
  return {
    frames,
    get dropped() {
      return dropped;
    },
    record(socketId: number, direction: "sent" | "received", data: string): void {
      if (!capture) {
        return;
      }
      const size = new TextEncoder().encode(data).byteLength;
      if (frames.length >= 4_096 || bytes + size > 8 * 1024 * 1024) {
        dropped += 1;
        return;
      }
      bytes += size;
      frames.push({ socketId, direction, data });
    },
    parse(raw: string | ArrayBufferLike | Blob | ArrayBufferView): {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      type?: unknown;
    } | null {
      if (typeof raw !== "string") {
        return null;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    },
  };
}
