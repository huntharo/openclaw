import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import { getSharedApiStore } from "../infra/http-api-quota.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import { gitHubPublicApi, type ControlUiGitHubPreviewIdentity } from "./github-public-api.js";
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
  const config = context.getRuntimeConfig();
  const configuredIdentity = () => {
    const current = context.getRuntimeConfig();
    if (resolveConfiguredGitHubHost(current) !== "github.com") {
      return undefined;
    }
    return (
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "system" })
    );
  };
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
  assertActive();
  // Without a managed selection, retain service/env/anonymous access without
  // probing native gh. Both paths must still own the selection at delivery.
  const identity = configuredIdentity()
    ? await prepareGitHubReadIdentity({
        config,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        agentId,
        getCurrentConfig: () => context.getRuntimeConfig(),
        assertActive,
        refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      })
    : undefined;
  return {
    identity,
    assertSelected:
      identity?.assertSelected ??
      (() => {
        assertActive();
        if (configuredIdentity()) {
          throw new GitHubIdentityError("changed");
        }
      }),
  };
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
