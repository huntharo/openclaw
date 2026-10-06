import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { apiStoreRequestKey, getSharedApiStore } from "../infra/http-api-quota.js";
import { CONTROL_UI_LINK_READER_CHANGED_EVENT } from "../shared/control-ui-link-reader.js";
import { controlUiGitHubReadScope } from "./control-ui-github-read-identity.js";
import { createControlUiLinkReaderNotifications } from "./control-ui-link-reader-notifications.js";
import { createControlUiRequestOptions } from "./server-methods/control-ui-request.test-support.js";
import { createControlUiHandlers } from "./server-methods/control-ui.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient, RespondFn } from "./server-methods/types.js";

const url = "https://github.com/openclaw/openclaw/pull/23/files?view=split#diff-1";
const target = { kind: "pull" as const, owner: "openclaw", repo: "openclaw", number: 23 };
const apiUrl = "https://api.github.com/repos/openclaw/openclaw/pulls/23";
let nextFixture = 0;

function fixture() {
  const config = {
    agents: { entries: { main: {} } },
    gateway: { controlUi: { github: { token: `reader-fixture-token-${++nextFixture}` } } },
  };
  setRuntimeConfigSnapshot(config);
  const selected = controlUiGitHubReadScope();
  const current = new Set(["reader-one", "reader-two", "uninterested"]);
  const delivered = createDeferred();
  const prepared = createDeferred();
  const releasePreparation = createDeferred();
  let hold = false;
  let currentScope = selected;
  const prepareRead = vi.fn(async () => {
    prepared.resolve();
    if (hold) {
      await releasePreparation.promise;
    }
    return { ...currentScope, assertSelected: () => {} };
  });
  const broadcast = vi.fn(() => delivered.resolve());
  const owner = createControlUiLinkReaderNotifications({
    broadcastToConnIds: broadcast,
    isConnectionActive: (connId) => current.has(connId),
    prepareRead,
  });
  const respond = vi.fn<RespondFn>();
  const requestOptions = createControlUiRequestOptions(() => config);
  const load = vi.fn(async () => ({ url, title: "Public pull request" }));
  const handler = createControlUiHandlers(load)["controlUi.githubPreview"]!;
  const read = async (connId: string, readerUrl = url) => {
    const client = { ...identifiedClient("public-reader"), connId };
    await handler(
      requestOptions({ ...target, readerUrl }, respond, {
        client,
        context: {
          getRuntimeConfig: () => config,
          getClientConnIds: (filter: (client: GatewayClient) => boolean) =>
            new Set(filter(client) && current.has(connId) ? [connId] : []),
          controlUiLinkReaderNotifications: owner,
        },
      }),
    );
  };
  const change = async (title = "Merged") =>
    selected.store.responses.remember(
      apiStoreRequestKey(apiUrl),
      new Response(
        JSON.stringify({ number: 23, title, state: "closed", head: { sha: "a".repeat(40) } }),
      ),
    );
  return {
    owner,
    selected,
    current,
    prepareRead,
    broadcast,
    read,
    change,
    respond,
    delivered: delivered.promise,
    prepared: prepared.promise,
    holdPreparation: () => {
      hold = true;
    },
    releasePreparation: releasePreparation.resolve,
    replaceScope: () => {
      currentScope = {
        cacheScope: "other",
        store: getSharedApiStore({
          apiBaseUrl: "https://api.github.com",
          token: "other-reader-fixture-token",
        }),
      };
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  clearRuntimeConfigSnapshot();
});

describe("Connection-scoped link reader store notifications", () => {
  it("notifies only successful readers of the exact held target with no PR data", async () => {
    const f = fixture();
    cleanup.push(() => f.owner.stop());
    await f.read("reader-one");
    await f.read("reader-two", "https://github.com/different/repo/pull/23");
    expect(f.respond.mock.calls.every(([ok]) => ok)).toBe(true);
    await f.change();
    await f.delivered;
    expect(f.broadcast).toHaveBeenCalledTimes(1);
    expect(f.broadcast).toHaveBeenCalledWith(
      CONTROL_UI_LINK_READER_CHANGED_EVENT,
      { url, agentId: "main" },
      new Set(["reader-one"]),
      { dropIfSlow: true },
    );
  });

  it.each(["disconnect", "identity"] as const)(
    "rechecks %s after asynchronous preparation",
    async (change) => {
      const f = fixture();
      cleanup.push(() => f.owner.stop());
      await f.read("reader-one");
      f.holdPreparation();
      await f.change();
      await f.prepared;
      if (change === "disconnect") {
        f.current.delete("reader-one");
        f.owner.unsubscribe("reader-one");
      } else {
        f.replaceScope();
      }
      f.releasePreparation();
      await f.prepareRead.mock.results[0]!.value;
      await f.owner.stop();
      expect(f.broadcast).not.toHaveBeenCalled();
    },
  );

  it("joins an active reader before invalidating and retires all observation at stop", async () => {
    const f = fixture();
    cleanup.push(() => f.owner.stop());
    await f.read("reader-one");
    const finishRead = f.owner.beginRead("reader-one", "main", url);
    await f.change();
    expect(f.prepareRead).not.toHaveBeenCalled();
    finishRead();
    await f.delivered;
    await f.owner.stop();
    f.broadcast.mockClear();
    await f.change("Updated after stop");
    expect(f.broadcast).not.toHaveBeenCalled();
  });

  it("preserves an invalidation when a successful read replaces its held interest", async () => {
    const f = fixture();
    cleanup.push(() => f.owner.stop());
    await f.read("reader-one");
    const finishRead = f.owner.beginRead("reader-one", "main", url);
    await f.change();
    await f.read("reader-one");
    expect(f.prepareRead).not.toHaveBeenCalled();
    finishRead();
    await f.delivered;
    expect(f.broadcast).toHaveBeenCalledTimes(1);
    expect(f.broadcast).toHaveBeenCalledWith(
      CONTROL_UI_LINK_READER_CHANGED_EVENT,
      { url, agentId: "main" },
      new Set(["reader-one"]),
      { dropIfSlow: true },
    );
  });

  it("invalidates a known PR reader when accepted reviews change", async () => {
    const f = fixture();
    cleanup.push(() => f.owner.stop());
    const reviewsKey = apiStoreRequestKey(`${apiUrl}/reviews`);
    await f.change("Known PR before the reader opens");
    await f.selected.store.responses.remember(
      reviewsKey,
      new Response(JSON.stringify([{ id: 1, state: "COMMENTED", body: "Initial review" }])),
    );
    await f.read("reader-one");
    await f.selected.store.responses.remember(
      reviewsKey,
      new Response(JSON.stringify([{ id: 1, state: "APPROVED", body: "Updated review" }])),
    );
    await f.delivered;
    expect(f.broadcast).toHaveBeenCalledTimes(1);
    expect(f.broadcast).toHaveBeenCalledWith(
      CONTROL_UI_LINK_READER_CHANGED_EVENT,
      { url, agentId: "main" },
      new Set(["reader-one"]),
      { dropIfSlow: true },
    );
  });
});
