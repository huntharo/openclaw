import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Optional utility preprocessing keeps its runtime loaders lazy and cancellation explicit.
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../../agents/tool-fs-policy.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { hasInboundMediaForUnderstanding } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import { assertPreparedConversationBindingRouteCurrent } from "./session-conversation-binding.js";

const mediaUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../media-understanding/apply.runtime.js"),
);
const linkUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../link-understanding/apply.runtime.js"),
);

export function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.agentText;
  if (!message) {
    return false;
  }
  return /\bhttps?:\/\/\S+/i.test(message);
}

export async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel: { provider: string; model: string };
  processingMode?: "audio-only" | "files-only" | "audio-and-files";
  selfServeLocalPaths?: boolean;
}): Promise<ApplyMediaUnderstandingResult | undefined> {
  if (!hasInboundMediaForUnderstanding(params.ctx)) {
    return undefined;
  }
  try {
    const { applyMediaUnderstanding } = await mediaUnderstandingApplyRuntimeLoader.load();
    return await applyMediaUnderstanding(params);
  } catch (err) {
    mediaUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

export function hasExplicitAudioUnderstandingConfig(cfg: OpenClawConfig): boolean {
  const audio = cfg.tools?.media?.audio;
  return audio !== undefined && audio.enabled !== false;
}

export async function applyLinkUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!hasLinkCandidate(params.ctx)) {
    return false;
  }
  try {
    const { applyLinkUnderstanding } = await linkUnderstandingApplyRuntimeLoader.load();
    await applyLinkUnderstanding(params);
    return true;
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    linkUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `link understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return false;
  }
}

/** Refuse a changed channel choice before preparing an agent's model or workspace. */
export async function resolveReplyAgentScope(params: { cfg: OpenClawConfig; ctx: MsgContext }) {
  const { cfg, ctx } = params;
  const targetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  if (
    readConversationBindingRouteFacts(ctx) &&
    ctx.InternalTurnSource === undefined &&
    !targetSessionKey
  ) {
    await assertPreparedConversationBindingRouteCurrent(ctx);
  }
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  return {
    agentSessionKey,
    agentId: resolveSessionAgentId({
      sessionKey: agentSessionKey,
      config: cfg,
      fallbackAgentId: ctx.AgentId,
    }),
  };
}

export function canSelfServeLocalPaths(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  workspaceDir: string;
  provider: string;
  model: string;
  opts?: GetReplyOptions;
  senderIsOwner: boolean;
  spawnedBy?: string;
  stagedPathsAvailable: boolean;
}): boolean {
  if (params.opts?.disableTools === true) {
    return false;
  }
  const policySessionKey = resolveRuntimePolicySessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const sandboxed = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: policySessionKey,
  }).sandboxed;
  if (
    (sandboxed && !params.stagedPathsAvailable) ||
    (!sandboxed &&
      !resolveEffectiveToolFsRootExpansionAllowed({ cfg: params.cfg, agentId: params.agentId }))
  ) {
    return false;
  }
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: params.cfg,
    sessionKey: policySessionKey,
    runSessionKey: policySessionKey === params.sessionKey ? undefined : params.sessionKey,
    agentId: params.agentId,
    agentAccountId: params.ctx.AccountId,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.ctx.OriginatingChannel,
      provider: params.ctx.Provider ?? params.ctx.Surface,
    }),
    conversationToolPolicy: params.ctx.ConversationToolPolicy,
    groupId: resolveGroupSessionKey(params.ctx)?.id,
    groupChannel:
      normalizeOptionalString(params.ctx.GroupChannel) ??
      normalizeOptionalString(params.ctx.GroupSubject),
    groupSpace: normalizeOptionalString(params.ctx.GroupSpace),
    spawnedBy: params.spawnedBy,
    senderId: normalizeOptionalString(params.ctx.SenderId),
    senderName: normalizeOptionalString(params.ctx.SenderName),
    senderUsername: normalizeOptionalString(params.ctx.SenderUsername),
    senderE164: normalizeOptionalString(params.ctx.SenderE164),
    senderIsOwner: params.senderIsOwner,
    modelProvider: params.provider,
    modelId: params.model,
    workspaceDir: params.workspaceDir,
    runtimeToolAllowlist: params.opts?.toolsAllow,
    inheritRuntimeToolAllowlist: true,
    inputProvenance: params.ctx.InputProvenance,
  });
  return (
    projectConversationToolNames({
      capabilityProfile,
      toolNames: ["read"],
      warn: () => {},
    }).length === 1
  );
}
