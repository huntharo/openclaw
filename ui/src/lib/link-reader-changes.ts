import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CONTROL_UI_LINK_READER_CHANGED_EVENT,
  type ControlUiLinkReaderChanged,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

const scopes = new WeakMap<
  GatewayBrowserClient,
  { generation: number; recoveryScope: string; client: GatewayBrowserClient }
>();

export function linkReaderChangeScope(client: GatewayBrowserClient | null) {
  if (!client) {
    return null;
  }
  let scope = scopes.get(client);
  if (
    !scope ||
    scope.generation !== client.connectionGeneration ||
    scope.recoveryScope !== client.recoveryScope
  ) {
    scope = {
      client,
      generation: client.connectionGeneration,
      recoveryScope: client.recoveryScope,
    };
    scopes.set(client, scope);
  }
  return scope;
}

/** Listener lifetime and every event stay pinned to this Gateway connection epoch. */
export function subscribeLinkReaderChanges(
  client: GatewayBrowserClient,
  agentId: () => string | undefined,
  changed: (event: ControlUiLinkReaderChanged) => void,
): () => void {
  const generation = client.connectionGeneration;
  const recoveryScope = client.recoveryScope;
  return client.addEventListener((event) => {
    const payload = event.payload;
    if (
      event.event === CONTROL_UI_LINK_READER_CHANGED_EVENT &&
      client.connectionGeneration === generation &&
      client.recoveryScope === recoveryScope &&
      isRecord(payload) &&
      typeof payload.url === "string" &&
      typeof payload.agentId === "string" &&
      (agentId() === undefined || agentId() === payload.agentId)
    ) {
      changed({ url: payload.url, agentId: payload.agentId });
    }
  });
}
