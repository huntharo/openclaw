import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  controlUiGitHubReadScope,
  prepareControlUiGitHubIdentity,
} from "./control-ui-github-read-identity.js";
import { createControlUiLinkReaderNotifications } from "./control-ui-link-reader-notifications.js";
import { prepareControlUiSessionPrRead } from "./control-ui-session-pr-read.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** Both projections live with the Gateway and resolve each recipient's current authority. */
export function createGatewayControlUiGitHubReaders(deps: {
  scheduler: GatewayScheduler;
  getSessionRowProjection: () => SessionRowProjection | undefined;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  isConnectionActive: (connId: string) => boolean;
  clients: Pick<GatewayClientRegistry, "getByConnectionId">;
  getRuntimeConfig: () => OpenClawConfig;
}) {
  const { clients, getRuntimeConfig } = deps;
  return {
    pullRequests: createControlUiSessionPullRequestSubscriptions({
      ...deps,
      prepareRead: async (connId, session) => {
        const client = clients.getByConnectionId(connId);
        return client
          ? await prepareControlUiSessionPrRead({
              client,
              ...session,
              getRuntimeConfig,
              getSessionRowProjection: deps.getSessionRowProjection,
              isCurrentClient: () => clients.getByConnectionId(connId) === client,
            })
          : undefined;
      },
    }),
    documents: createControlUiLinkReaderNotifications({
      ...deps,
      prepareRead: async (connId, agentId, signal) => {
        const client = clients.getByConnectionId(connId);
        if (!client) {
          return undefined;
        }
        const selected = await prepareControlUiGitHubIdentity(
          {
            context: { getRuntimeConfig },
            client,
            signal,
            hasCurrentClientAuthority: () => clients.getByConnectionId(connId) === client,
          },
          agentId,
        );
        const prepared = controlUiGitHubReadScope(selected.identity);
        return {
          ...prepared,
          assertSelected() {
            selected.assertSelected();
            if (controlUiGitHubReadScope(selected.identity).store !== prepared.store) {
              throw new Error("GitHub reader identity changed");
            }
          },
        };
      },
    }),
  };
}
