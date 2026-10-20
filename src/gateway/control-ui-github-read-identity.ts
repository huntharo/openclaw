import { getSharedApiStore } from "../infra/http-api-quota.js";
import { gitHubPublicApi, type ControlUiGitHubPreviewIdentity } from "./github-public-api.js";
import { prepareGitHubReaderIdentity } from "./github-reader-identity.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

export class GitHubReadRequestInactiveError extends Error {
  constructor() {
    super("GitHub request is no longer active. Try again.");
  }
}

export async function prepareControlUiGitHubIdentity(
  {
    context,
    client,
    signal,
    hasCurrentClientAuthority,
  }: {
    context: Pick<GatewayRequestContext, "getRuntimeConfig" | "getClientConnIds">;
    client: GatewayClient | null;
    signal?: AbortSignal;
    hasCurrentClientAuthority?: () => boolean;
  },
  agentId: string,
): Promise<{
  identity: ControlUiGitHubPreviewIdentity | undefined;
  assertSelected: () => void;
}> {
  // Nested plugin requests may decorate the client; transport authority retains its owner.
  const assertActive = () => {
    if (
      signal?.aborted ||
      (hasCurrentClientAuthority
        ? !hasCurrentClientAuthority()
        : client?.connId &&
          !context.getClientConnIds?.((current) => current === client).has(client.connId))
    ) {
      throw new GitHubReadRequestInactiveError();
    }
  };
  return prepareGitHubReaderIdentity(context, agentId, assertActive);
}

/** Public readers pin their transport to github.com, independently of enterprise publication. */
export function controlUiGitHubReadScope(identity?: ControlUiGitHubPreviewIdentity) {
  const selected =
    identity ?? gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, "github.com");
  return {
    cacheScope: selected.cacheScope,
    store: getSharedApiStore({ apiBaseUrl: "https://api.github.com", token: selected.token }),
  };
}
