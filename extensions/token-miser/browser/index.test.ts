import type {
  ControlUiAccessory,
  ControlUiHost,
  ControlUiPanel,
} from "openclaw/plugin-sdk/control-ui";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.ts";

const exampleStats = {
  scope: "gateway-runtime",
  originalBytes: 12_000,
  projectedBytes: 700,
  retrievedBytes: 300,
  retrievalCount: 1,
  decisions: 3,
  summarized: 1,
  passedThrough: 1,
  failedOpen: 1,
  retainedCount: 1,
  helper: { calls: 2, inputTokens: 640, outputTokens: 80, costUsd: 0.00042 },
};

function fixture() {
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  const events = new Map<string, (payload: unknown) => void>();
  const panels = new Map<string, ControlUiPanel>();
  const accessories = new Map<string, ControlUiAccessory>();
  const requests: {
    method: string;
    params: Record<string, unknown> | undefined;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    promise: Promise<unknown>;
  }[] = [];
  const unused = () => {
    throw new Error("This test did not install an unused host capability.");
  };
  const host: ControlUiHost = {
    apiVersion: 1,
    pluginId: "token-miser",
    signal: abort.signal,
    basePath: "",
    locale: "en",
    connection: {
      connected: true,
      canRead: true,
      canWrite: false,
      canGrant: false,
      canAdmin: false,
      assistantAgentId: "main",
    },
    redact: (text) => text.replace("secret", "[redacted]"),
    request: async <T>(method: string, params?: Record<string, unknown>) => {
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<unknown>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      requests.push({ method, params, resolve, reject, promise });
      return (await promise) as T;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEvent(name, listener) {
      events.set(name, listener);
      return () => {
        events.delete(name);
      };
    },
    sessions: {
      rows: [],
      selectedKey: "a",
      normalizeKey: (key) => key,
      refresh: unused,
      observe: unused,
      open: unused,
      create: unused,
      patch: unused,
    },
    agents: {
      rows: [],
      selectedId: "main",
      defaultId: "main",
      scopeId: null,
      select: unused,
      setScope: unused,
      refresh: unused,
    },
    navigation: { openPage: unused, pageHref: unused },
    components: {
      resolveAppearanceColor: unused,
      mountAgentAvatar: unused,
      mountAppearancePicker: unused,
      mountAppearanceGlyph: unused,
      mountDialog: unused,
      mountAgentPicker: unused,
      mountSelectPicker: unused,
      mountSessionSummary: unused,
      mountDashboard: unused,
    },
    ui: {
      invalidate: unused,
      registerPanel(panel) {
        panels.set(panel.id, panel);
        return () => {
          panels.delete(panel.id);
        };
      },
      registerAccessory(accessory) {
        accessories.set(accessory.id, accessory);
        return () => {
          accessories.delete(accessory.id);
        };
      },
      openPanel: vi.fn(),
      registerPage: unused,
      registerNavigation: unused,
      registerAction: unused,
      registerWidget: unused,
      registerReplacement: unused,
      selectReplacement: unused,
    },
  };
  const context = (sessionKey = "a", presented = true): Parameters<ControlUiPanel["mount"]>[1] => ({
    host,
    signal: abort.signal,
    props: { sessionKey, agentId: "main" },
    presented,
    mountDefault: unused,
  });
  const container = document.createElement("div");
  document.body.append(container);
  return {
    host,
    abort,
    container,
    panels,
    accessories,
    requests,
    context,
    events,
    listeners,
    async activate() {
      await plugin.activate(host);
    },
    notify() {
      for (const listener of listeners) {
        listener();
      }
    },
    async respond(index: number, value: unknown) {
      const request = expectDefined(requests[index], `pending stats request ${index}`);
      request.resolve(value);
      await request.promise;
      await Promise.resolve();
    },
  };
}

afterEach(() => document.body.replaceChildren());

describe("Token Miser native panel", () => {
  it("shows owner measurements, distinguishes unknown usage, and refreshes after recovery", async () => {
    const f = fixture();
    await f.activate();
    f.panels.get("measurements")!.mount(f.container, f.context());
    expect(f.container.textContent).toContain("Loading measurements");
    expect(f.requests[0]).toMatchObject({
      method: "tokenMiser.stats",
      params: { sessionKey: "a" },
    });
    await f.respond(0, exampleStats);
    expect(f.container.textContent).toContain("Original bytes12,000");
    expect(f.container.textContent).toContain("Delivered bytes700");
    expect(f.container.textContent).toContain("Retrieval response bytes300");
    expect(f.container.textContent).toContain("Helper input tokens640");
    expect(f.container.textContent).toContain("Helper cache read tokensUnavailable");
    expect(f.container.textContent).toContain("Reported helper cost (USD)0.000420");
    expect(f.container.textContent).toContain("can incur provider charges");
    f.events.get("tokenMiser.updated")!({ sessionKey: "other" });
    expect(f.requests).toHaveLength(1);
    f.events.get("tokenMiser.updated")!({ sessionKey: "a" });
    const refresh = expectDefined(f.requests[1], "event refresh request");
    refresh.reject(new Error("secret provider failed"));
    await refresh.promise.catch(() => undefined);
    await Promise.resolve();
    expect(f.container.querySelector('[role="alert"]')?.textContent).toBe(
      "[redacted] provider failed",
    );
    expect(f.container.textContent).not.toContain("12,000");
    f.container.querySelector("button")!.click();
    await f.respond(2, { ...exampleStats, decisions: 0, helper: { calls: 0 } });
    expect(f.container.textContent).toContain(
      "No Token Miser decisions for this session in the current Gateway runtime",
    );
    expect(f.container.textContent).toContain("Helper input tokensUnavailable");
    f.abort.abort();
  });

  it("rejects stale session and disconnected responses and disposes active reads", async () => {
    const f = fixture();
    await f.activate();
    const view = f.panels.get("measurements")!.mount(f.container, f.context());
    if (!view) {
      throw new Error("Expected mounted panel");
    }
    view.update!(f.context("b"));
    await f.respond(0, exampleStats);
    expect(f.container.textContent).not.toContain("12,000");
    expect(expectDefined(f.requests[1], "replacement session stats request").params).toEqual({
      sessionKey: "b",
    });
    f.host.connection.connected = false;
    f.notify();
    await f.respond(1, exampleStats);
    expect(f.container.textContent).toContain("Connect to the Gateway");
    expect(f.container.textContent).not.toContain("12,000");
    f.host.connection.connected = true;
    f.notify();
    f.abort.abort();
    await f.respond(2, exampleStats);
    expect(f.container.textContent).toBe("");
    expect(f.listeners.size).toBe(0);
    expect(f.events.size).toBe(0);
  });

  it("reads only presented authorized panels and opens the accessory's current session", async () => {
    const f = fixture();
    await f.activate();
    const panel = f.panels.get("measurements")!.mount(f.container, f.context("a", false));
    if (!panel) {
      throw new Error("Expected mounted panel");
    }
    expect(f.requests).toHaveLength(0);
    f.host.connection.canRead = false;
    panel.update!(f.context());
    expect(f.requests).toHaveLength(0);
    expect(f.container.textContent).toContain("Read access is required");
    f.host.connection.canRead = true;
    f.notify();
    expect(f.requests).toHaveLength(1);
    const accessoryContainer = document.createElement("div");
    const accessory = f.accessories.get("measurements")!.mount(accessoryContainer, f.context());
    if (!accessory) {
      throw new Error("Expected mounted accessory");
    }
    accessory.update!(f.context("b"));
    const button = accessoryContainer.querySelector("button")!;
    button.click();
    expect(f.host.ui.openPanel).toHaveBeenCalledWith("measurements", {
      sessionKey: "b",
      agentId: "main",
    });
    f.abort.abort();
    button.click();
    expect(f.host.ui.openPanel).toHaveBeenCalledTimes(1);
    await f.respond(0, exampleStats);
  });
});
