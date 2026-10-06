/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_UI_LINK_READER_CHANGED_EVENT,
  type ControlUiLinkReaderDocument,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../api/gateway.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import "./link-reader-panel.ts";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";

const tag = "test-link-reader-store-updates-" + crypto.randomUUID();
customElements.define(tag, class extends LinkReaderHovercardProvider {});
const url = "https://github.com/openclaw/openclaw/pull/23";
type Panel = HTMLElementTagNameMap["openclaw-link-reader-panel"];

function fixture() {
  let title = "Open pull request";
  const listeners = new Set<GatewayEventListener>();
  const request = vi.fn(
    async (_method: string, params: { url: string }): Promise<ControlUiLinkReaderDocument> => ({
      url: params.url,
      title,
      body: "Pull request description",
      badge: { label: title, tone: "positive" },
    }),
  );
  const client = {
    request,
    connected: true,
    connectionGeneration: 1,
    recoveryScope: "reader-authority",
    addEventListener: (listener: GatewayEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const panels: Panel[] = [];
  const mountPanel = async () => {
    const panel = document.createElement("openclaw-link-reader-panel");
    Object.assign(panel, {
      client: client as unknown as GatewayBrowserClient,
      available: true,
      agentId: "main",
      readers: [TEST_LINK_READER],
      embedded: true,
      presented: true,
    });
    document.body.append(panel);
    await panel.updateComplete;
    panel.handleToggleRequest(
      new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
        detail: { url, open: true, newTab: false },
        cancelable: true,
      }),
    );
    panels.push(panel);
    return panel;
  };
  const changed = (changedUrl = url, agentId = "main") => {
    for (const listener of listeners) {
      listener({
        type: "event",
        event: CONTROL_UI_LINK_READER_CHANGED_EVENT,
        payload: { url: changedUrl, agentId },
      });
    }
  };
  return {
    client,
    request,
    listeners,
    panels,
    mountPanel,
    changed,
    setTitle: (value: string) => {
      title = value;
    },
  };
}

describe("Shared reader fact invalidations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("updates every open document and active hover projection through their normal authorized read", async () => {
    const f = fixture();
    await f.mountPanel();
    await f.mountPanel();
    const provider = document.createElement(tag) as LinkReaderHovercardProvider;
    provider.readers = [TEST_LINK_READER];
    provider.agentId = "main";
    provider.client = f.client as unknown as GatewayBrowserClient;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.textContent = "Pull request";
    provider.append(anchor);
    document.body.append(provider);
    anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(250);
    expect(f.panels.map((p) => p.renderRoot.querySelector("h1")?.textContent)).toEqual([
      "Open pull request",
      "Open pull request",
    ]);
    expect(document.querySelector(".link-reader-hovercard__title")?.textContent).toBe(
      "Open pull request",
    );
    f.request.mockClear();
    f.setTitle("Merged pull request");
    f.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.panels.map((p) => p.renderRoot.querySelector("h1")?.textContent)).toEqual([
      "Merged pull request",
      "Merged pull request",
    ]);
    expect(document.querySelector(".link-reader-hovercard__title")?.textContent).toBe(
      "Merged pull request",
    );
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.request.mock.calls.every(([, params]) => params.url === url)).toBe(true);
    document.body.replaceChildren();
    expect(f.listeners.size).toBe(0);
  });

  it("ignores other targets, agents, and packets from a retired connection epoch", async () => {
    const f = fixture();
    await f.mountPanel();
    await vi.advanceTimersByTimeAsync(0);
    f.request.mockClear();
    f.changed("https://github.com/private/repo/pull/23");
    f.changed(url, "other-agent");
    f.client.connectionGeneration += 1;
    f.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.panels[0]!.renderRoot.querySelector("h1")?.textContent).toBe("Open pull request");
  });
});
