import { pruneMapToMaxSize } from "../../../src/infra/map-size.ts";
import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { subscribeToSharedRequest } from "../lib/shared-request-subscription.ts";
import {
  parsePreviewResponse,
  previewContextFor,
  type CacheEntry,
  type PreviewContext,
} from "./link-reader-preview.ts";
import { linkReaderResponseMatchesTarget } from "./link-reader-response.ts";
import { linkReaderTargetKey, type LinkReaderTarget } from "./link-reader-target.ts";

/** Connection/agent-scoped renderer projection; the Gateway owns upstream facts and invalidations. */
export class LinkReaderPreviewCache {
  private readonly entries = new Map<string, { target: LinkReaderTarget; value: CacheEntry }>();
  constructor(
    private readonly current: () => {
      client: GatewayBrowserClient | null;
      agentId: string | undefined;
      context: PreviewContext | null;
      accepts: (target: LinkReaderTarget) => boolean;
    },
    private readonly changed: () => void,
  ) {}

  get(target: LinkReaderTarget): CacheEntry | undefined {
    const cached = this.entries.get(linkReaderTargetKey(target))?.value;
    return cached && !cached.controller.signal.aborted && cached.expiresAt > Date.now()
      ? cached
      : undefined;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.value.controller.abort();
    }
    this.entries.clear();
    this.changed();
  }

  invalidate(url: string): boolean {
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (linkReaderResponseMatchesTarget(entry.target, url)) {
        entry.value.controller.abort();
        this.entries.delete(key);
        removed = true;
      }
    }
    if (removed) {
      this.changed();
    }
    return removed;
  }

  load(target: LinkReaderTarget, signal: AbortSignal): Promise<ControlUiLinkReaderPreview> {
    const key = linkReaderTargetKey(target);
    const cached = this.get(target);
    this.entries.delete(key);
    if (cached) {
      this.entries.set(key, { target, value: cached });
      return subscribeToSharedRequest(cached, {}, signal);
    }
    const controller = new AbortController();
    const { client, agentId, context, accepts } = this.current();
    const load = async () => {
      const method = target.reader.linkReader.previewMethod;
      if (!client || !method || !accepts(target)) {
        throw new Error("Link preview requires an available reader");
      }
      return parsePreviewResponse(
        target,
        await client.request<ControlUiLinkReaderPreview>(
          method,
          { ...(agentId ? { agentId } : {}), url: target.href },
          { signal: controller.signal },
        ),
      );
    };
    const entry: CacheEntry = {
      expiresAt: Date.now() + 5 * 60_000,
      controller,
      subscribers: new Set(),
      promise: load()
        .then((preview) => {
          const current = this.current();
          if (
            !controller.signal.aborted &&
            this.entries.get(key)?.value === entry &&
            client === current.client &&
            agentId === current.agentId &&
            client &&
            previewContextFor(client, agentId) === context
          ) {
            entry.preview = preview;
            this.changed();
          }
          return preview;
        })
        .catch((error: unknown) => {
          entry.expiresAt = Date.now() + 30_000;
          this.changed();
          throw error;
        }),
    };
    this.entries.set(key, { target, value: entry });
    this.changed();
    pruneMapToMaxSize(this.entries, 100);
    return subscribeToSharedRequest(entry, {}, signal);
  }
}
