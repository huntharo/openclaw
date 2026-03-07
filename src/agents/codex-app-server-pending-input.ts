import crypto from "node:crypto";

export type CodexPendingUserInputApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type CodexPendingUserInputAction =
  | {
      kind: "approval";
      label: string;
      decision: CodexPendingUserInputApprovalDecision;
      responseDecision: string;
      proposedExecpolicyAmendment?: Record<string, unknown>;
      sessionPrefix?: string;
    }
  | {
      kind: "option";
      label: string;
      value: string;
    }
  | {
      kind: "steer";
      label: string;
    };

export type CodexPendingInputCallbackKind =
  | "approvalAccept"
  | "approvalAcceptForSession"
  | "approvalDecline"
  | "approvalCancel"
  | "option"
  | "steer";

const CALLBACK_PREFIX = "cdxui";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function findFirstStringByKeys(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | undefined {
  if (depth > 5) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findFirstStringByKeys(item, keys, depth + 1);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = pickString(record, keys);
  if (direct) {
    return direct;
  }
  for (const nested of Object.values(record)) {
    const match = findFirstStringByKeys(nested, keys, depth + 1);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function normalizeApprovalDecision(value: string): CodexPendingUserInputApprovalDecision | null {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "accept":
    case "approve":
    case "allow":
      return "accept";
    case "acceptwithexecpolicyamendment":
    case "acceptforsession":
    case "approveforsession":
    case "allowforsession":
      return "acceptForSession";
    case "decline":
    case "deny":
    case "reject":
      return "decline";
    case "cancel":
    case "abort":
    case "stop":
      return "cancel";
    default:
      return null;
  }
}

function humanizeApprovalDecision(
  decision: CodexPendingUserInputApprovalDecision,
  sessionPrefix?: string,
): string {
  switch (decision) {
    case "accept":
      return "Approve Once";
    case "acceptForSession":
      return sessionPrefix ? `Approve for Session (${sessionPrefix})` : "Approve for Session";
    case "decline":
      return "Decline";
    case "cancel":
      return "Cancel";
  }
}

function extractSessionPrefix(value: unknown): string | undefined {
  const record = asRecord(value);
  return (
    findFirstStringByKeys(record?.proposedExecpolicyAmendment, [
      "prefix",
      "commandPrefix",
      "prefixToApprove",
      "allowedPrefix",
      "command_prefix",
    ]) ??
    findFirstStringByKeys(record?.sessionApproval, [
      "prefix",
      "commandPrefix",
      "prefixToApprove",
      "allowedPrefix",
      "command_prefix",
    ]) ??
    findFirstStringByKeys(record?.execPolicyAmendment, [
      "prefix",
      "commandPrefix",
      "prefixToApprove",
      "allowedPrefix",
      "command_prefix",
    ])
  );
}

function buildApprovalActionsFromDecisions(value: unknown): CodexPendingUserInputAction[] {
  const record = asRecord(value);
  const rawDecisions = record?.availableDecisions ?? record?.decisions;
  if (!Array.isArray(rawDecisions)) {
    return [];
  }
  const actions: CodexPendingUserInputAction[] = [];
  for (const entry of rawDecisions) {
    if (typeof entry === "string") {
      const decision = normalizeApprovalDecision(entry);
      if (!decision) {
        continue;
      }
      actions.push({
        kind: "approval",
        decision,
        responseDecision: entry,
        label: humanizeApprovalDecision(decision),
      });
      continue;
    }
    const decisionRecord = asRecord(entry);
    const decisionValue =
      pickString(decisionRecord, ["decision", "value", "name", "id", "action"]) ?? "";
    const decision = normalizeApprovalDecision(decisionValue);
    if (!decision) {
      continue;
    }
    const sessionPrefix =
      decision === "acceptForSession" ? extractSessionPrefix(decisionRecord) : undefined;
    const proposedExecpolicyAmendment =
      decision === "acceptForSession"
        ? (asRecord(decisionRecord?.proposedExecpolicyAmendment) ??
          asRecord(decisionRecord?.execPolicyAmendment) ??
          undefined)
        : undefined;
    actions.push({
      kind: "approval",
      decision,
      responseDecision: decisionValue || decision,
      ...(proposedExecpolicyAmendment ? { proposedExecpolicyAmendment } : {}),
      ...(sessionPrefix ? { sessionPrefix } : {}),
      label:
        pickString(decisionRecord, ["label", "title", "text"]) ??
        humanizeApprovalDecision(decision, sessionPrefix),
    });
  }
  return actions;
}

function resolveApprovalDecisionFromText(
  text: string,
): CodexPendingUserInputApprovalDecision | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("session")) {
    return "acceptForSession";
  }
  if (/cancel|abort|stop/.test(normalized)) {
    return "cancel";
  }
  if (/deny|decline|reject|block|no/.test(normalized)) {
    return "decline";
  }
  if (/approve|allow|accept|yes/.test(normalized)) {
    return "accept";
  }
  return null;
}

function buildApprovalActionsFromOptions(options: string[]): CodexPendingUserInputAction[] {
  const seen = new Set<CodexPendingUserInputApprovalDecision>();
  const actions: CodexPendingUserInputAction[] = [];
  for (const option of options) {
    const decision = resolveApprovalDecisionFromText(option);
    if (!decision || seen.has(decision)) {
      continue;
    }
    seen.add(decision);
    actions.push({
      kind: "approval",
      decision,
      responseDecision: decision,
      label: option.trim() || humanizeApprovalDecision(decision),
    });
  }
  return actions;
}

export function buildCodexPendingUserInputActions(params: {
  method?: string;
  requestParams?: unknown;
  options?: string[];
}): CodexPendingUserInputAction[] {
  const methodLower = params.method?.trim().toLowerCase() ?? "";
  const options = params.options?.map((option) => option.trim()).filter(Boolean) ?? [];
  if (methodLower.includes("requestapproval")) {
    const approvalActions = buildApprovalActionsFromDecisions(params.requestParams);
    const resolvedApprovalActions =
      approvalActions.length > 0 ? approvalActions : buildApprovalActionsFromOptions(options);
    return [...resolvedApprovalActions, { kind: "steer", label: "Tell Codex What To Do" }];
  }
  return options.map((option) => ({
    kind: "option",
    label: option,
    value: option,
  }));
}

export function buildCodexPendingInputCallbackData(params: {
  requestId: string;
  actionIndex: number;
  action: CodexPendingUserInputAction;
}): string {
  const requestToken = crypto
    .createHash("sha1")
    .update(params.requestId)
    .digest("base64url")
    .slice(0, 10);
  const kindCode =
    params.action.kind === "approval"
      ? params.action.decision === "accept"
        ? "aa"
        : params.action.decision === "acceptForSession"
          ? "as"
          : params.action.decision === "decline"
            ? "ad"
            : "ac"
      : params.action.kind === "steer"
        ? "st"
        : "op";
  return `${CALLBACK_PREFIX}:${kindCode}:${params.actionIndex.toString(36)}:${requestToken}`;
}

export function parseCodexPendingInputCallbackData(data: string): {
  kind: CodexPendingInputCallbackKind;
  actionIndex: number;
  requestToken: string;
} | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith(`${CALLBACK_PREFIX}:`)) {
    return null;
  }
  const match = trimmed.match(/^cdxui:(aa|as|ad|ac|op|st):([0-9a-z]+):([A-Za-z0-9_-]{6,20})$/);
  if (!match) {
    return null;
  }
  const actionIndex = Number.parseInt(match[2] ?? "", 36);
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    return null;
  }
  return {
    kind:
      match[1] === "aa"
        ? "approvalAccept"
        : match[1] === "as"
          ? "approvalAcceptForSession"
          : match[1] === "ad"
            ? "approvalDecline"
            : match[1] === "ac"
              ? "approvalCancel"
              : match[1] === "st"
                ? "steer"
                : "option",
    actionIndex,
    requestToken: match[3] ?? "",
  };
}

export function matchesCodexPendingInputRequestToken(
  requestId: string,
  requestToken: string,
): boolean {
  return (
    crypto.createHash("sha1").update(requestId).digest("base64url").slice(0, 10) === requestToken
  );
}

export function buildCodexPendingInputButtons(params: {
  requestId: string;
  actions?: CodexPendingUserInputAction[];
}): ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>> | undefined {
  const actions = params.actions?.slice(0, 8) ?? [];
  if (actions.length === 0) {
    return undefined;
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < actions.length; index += 2) {
    rows.push(
      actions.slice(index, index + 2).map((action, offset) => {
        const actionIndex = index + offset;
        return {
          text: action.label,
          callback_data: buildCodexPendingInputCallbackData({
            requestId: params.requestId,
            actionIndex,
            action,
          }),
        };
      }),
    );
  }
  return rows;
}

export function describeCodexPendingInputAction(action: CodexPendingUserInputAction): string {
  switch (action.kind) {
    case "approval":
      return action.label;
    case "option":
      return action.label;
    case "steer":
      return action.label;
  }
}
