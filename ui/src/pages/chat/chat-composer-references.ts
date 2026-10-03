import type { ApplicationGateway } from "../../app/gateway.ts";
import { projectsForGateway, type ProjectCatalog } from "../../lib/projects.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  isSessionKeyAddressable,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiSessionRowAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view.ts";
import type { ComposerReferenceSources } from "./components/chat-composer-reference-menu.ts";
import { chatPullRequestId } from "./components/chat-pull-requests.ts";

type ReferenceInputs = {
  state: ChatPageHost;
  gateway: ApplicationGateway;
  pullRequests: NonNullable<ChatProps["pullRequests"]>;
  dismissed: ReadonlySet<string>;
};

/** Derive references from held catalogs; streaming renders reuse the same projection. */
export class ChatComposerReferenceProjection {
  private cached?: {
    scope: string;
    sessions: ChatPageHost["sessionsResult"];
    projects: ProjectCatalog["snapshot"]["result"];
    pullRequests: ReferenceInputs["pullRequests"];
    dismissed: ReferenceInputs["dismissed"];
    value: ComposerReferenceSources;
  };

  resolve(
    state: ChatPageHost,
    owner: ApplicationGateway,
    pullRequests: ReferenceInputs["pullRequests"],
    dismissed: ReferenceInputs["dismissed"],
  ): ComposerReferenceSources | undefined {
    if (!state.connected) {
      return undefined;
    }
    const gateway = owner.snapshot;
    const connectionRevision = owner.connectionRevision;
    const currentAgentId = resolveChatAgentId(state);
    const projects = projectsForGateway(owner).snapshot.result;
    const mainKey = resolveUiConfiguredMainKey(state);
    const globalScope = isUiGlobalScopeConfigured(state);
    const scope = JSON.stringify([
      connectionRevision,
      gateway.selfUser?.id,
      gateway.hello?.auth?.role,
      gateway.hello?.auth?.scopes,
      currentAgentId,
      state.sessionKey,
      state.basePath,
      mainKey,
      globalScope,
    ]);
    const previous = this.cached;
    if (
      previous &&
      previous.scope === scope &&
      previous.sessions === state.sessionsResult &&
      previous.projects === projects &&
      previous.pullRequests === pullRequests &&
      previous.dismissed === dismissed
    ) {
      return previous.value;
    }
    const value: ComposerReferenceSources = {
      ownerKey: scope,
      sessions: (state.sessionsResult?.sessions ?? [])
        .filter(
          (row) => row.key !== state.sessionKey && isSessionKeyAddressable(row.key, globalScope),
        )
        .map((row) => ({
          key: row.key,
          agentId: resolveUiSessionRowAgentId(row, currentAgentId),
          label: resolveSessionDisplayName(row.key, row),
          href: sessionNavigationTarget({
            face: resolveSessionPreferredFace(row),
            sessionKey: row.key,
            row,
            fallbackAgentId: resolveUiSessionRowAgentId(row, currentAgentId),
            basePath: state.basePath,
            mainKey,
            exactKey: true,
          }).href,
        })),
      pullRequests: pullRequests.filter((pr) => !dismissed.has(chatPullRequestId(pr))),
      projects: projects?.projects.map((project) => ({
        id: project.id,
        label: project.displayName,
        path: project.repoRoot,
      })),
    };
    this.cached = {
      scope,
      sessions: state.sessionsResult,
      projects,
      pullRequests,
      dismissed,
      value,
    };
    return value;
  }
}
