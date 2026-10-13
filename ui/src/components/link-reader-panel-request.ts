import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { linkReaderErrorMessage } from "./link-reader-error.ts";
import { LinkReaderImages } from "./link-reader-images.ts";
import type { ReaderTab } from "./link-reader-panel-view.ts";
import { linkReaderResponseMatchesTarget } from "./link-reader-response.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";

/** A document's response and image lifetime share the originating tab and connection authority. */
async function loadLinkReaderPanelDocument(deps: {
  client: GatewayBrowserClient;
  target: LinkReaderTarget;
  agentId?: string;
  refresh: boolean;
  signal: AbortSignal;
  isCurrent: () => boolean;
  isDocumentCurrent: (detail: ControlUiLinkReaderDocument) => boolean;
  setView: (view: ReaderTab["view"]) => void;
}): Promise<void> {
  const { client, target } = deps;
  try {
    const detail = await client.request<ControlUiLinkReaderDocument>(
      target.reader.linkReader.detailMethod,
      {
        url: target.href,
        ...(deps.agentId ? { agentId: deps.agentId } : {}),
        ...(deps.refresh ? { refresh: true } : {}),
      },
      { signal: deps.signal },
    );
    if (!deps.isCurrent()) {
      return;
    }
    if (!detail || !linkReaderResponseMatchesTarget(target, detail.url)) {
      throw new Error("Link document does not match the requested target");
    }
    const imageMethod = target.reader.linkReader.imageMethod;
    const images = imageMethod
      ? new LinkReaderImages(client, imageMethod, () => deps.isDocumentCurrent(detail))
      : undefined;
    deps.setView({ status: "ready", detail, images });
  } catch (error) {
    if (deps.isCurrent()) {
      deps.setView({ status: "error", message: linkReaderErrorMessage(error) });
    }
  }
}

type PanelSelection = {
  client: GatewayBrowserClient | null;
  agentId: string | undefined;
  sessionKey: string;
  connected: boolean;
  available: boolean;
  presented: boolean;
  tab: ReaderTab | undefined;
  target: LinkReaderTarget | null;
  readers: readonly ControlUiLinkReaderDescriptor[];
  tabs: readonly ReaderTab[];
};

/** Owns cancellation and late-result exclusion independently of panel presentation. */
export class LinkReaderPanelRequests {
  private request: { controller: AbortController; tab: ReaderTab } | undefined;
  constructor(
    private readonly current: () => PanelSelection,
    private readonly setView: (tab: ReaderTab, view: ReaderTab["view"]) => void,
  ) {}

  abort(): void {
    const request = this.request;
    this.request = undefined;
    request?.controller.abort();
    if (request?.tab.view.status === "loading") {
      this.setView(request.tab, { status: "idle" });
    }
  }

  async load(refresh: boolean): Promise<void> {
    const selected = this.current();
    const { client, tab, target } = selected;
    if (!client || !tab || !target || !selected.available || !selected.presented) {
      return;
    }
    const request = { controller: new AbortController(), tab };
    this.request = request;
    const generation = client.connectionGeneration;
    const recoveryScope = client.recoveryScope;
    this.setView(tab, { status: "loading" });
    const ownsSelection = () => {
      const current = this.current();
      return (
        current.connected &&
        current.available &&
        current.client === client &&
        current.agentId === selected.agentId &&
        current.sessionKey === selected.sessionKey &&
        client.connectionGeneration === generation &&
        client.recoveryScope === recoveryScope &&
        current.readers.includes(target.reader)
      );
    };
    await loadLinkReaderPanelDocument({
      client,
      target,
      agentId: selected.agentId,
      refresh,
      signal: request.controller.signal,
      isCurrent: () =>
        this.request === request &&
        !request.controller.signal.aborted &&
        ownsSelection() &&
        this.current().presented &&
        this.current().tab === tab &&
        this.current().target?.href === target.href,
      isDocumentCurrent: (detail) =>
        ownsSelection() &&
        this.current().tabs.includes(tab) &&
        tab.view.status === "ready" &&
        tab.view.detail === detail,
      setView: (view) => this.setView(tab, view),
    });
  }
}
