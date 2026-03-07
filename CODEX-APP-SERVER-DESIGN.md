# Codex App Server Integration Design (As Built)

## Scope

This document captures the current integration shape for OpenClaw's `codex-app-server` provider:

- runtime startup and availability gating
- `/codex` command surface and binding flow
- run execution bridge into Codex App Server
- Telegram approval/input relay and callback handling
- session/binding persistence and startup reconciliation

## External Contracts (Ground Truth)

- Codex App Server docs: <https://developers.openai.com/codex/app-server>
- Approvals section: <https://developers.openai.com/codex/app-server#approvals>
- Reference implementation: <https://github.com/openai/codex/tree/main/codex-rs/app-server>

Protocol assumptions reflected in current code:

- Client performs `initialize` then `initialized`.
- Thread discovery/reads use documented `thread/list`, `thread/loaded/list`, `thread/read` (with narrow fallback support where needed).
- Turn execution uses `turn/start`; steer uses `turn/steer` (fallback alias support present).
- Interactive prompts are handled as server requests and cleared on `serverRequest/resolved`.
- Cleanup unsubscribes loaded thread via `thread/unsubscribe`.
- `stdio` transport is connection-scoped; it can serve multiple threads over one connection.

## Integration Map (Files, Functions, Handlers)

### 1) Gateway Startup + Runtime Readiness

- Runtime probe and status:
  - [src/agents/codex-app-server-startup.ts](src/agents/codex-app-server-startup.ts)
  - `initializeCodexAppServerRuntime`
  - `getCodexAppServerRuntimeStatus`
  - `getCodexAppServerAvailabilityError`
- Startup reconciliation:
  - [src/agents/codex-app-server-startup.ts](src/agents/codex-app-server-startup.ts)
  - `reconcileCodexPendingInputsOnStartup`
  - `reconcileCodexBoundSessionsOnStartup`
- Startup hook wiring:
  - [src/gateway/server-startup.ts](src/gateway/server-startup.ts)
  - calls `initializeCodexAppServerRuntime`, `reconcileCodexPendingInputsOnStartup`, `reconcileCodexBoundSessionsOnStartup`
  - emits startup trace lines such as `codex startup binding reconcile: ...`

### 2) Provider Selection + Turn Execution

- Agent turn orchestration:
  - [src/auto-reply/reply/agent-runner-execution.ts](src/auto-reply/reply/agent-runner-execution.ts)
  - `runAgentTurnWithFallback`
  - branch: `isCodexAppServerProvider(provider, config)` -> `runCodexAppServerAgent(...)`
- Codex provider execution:
  - [src/agents/codex-app-server-runner.ts](src/agents/codex-app-server-runner.ts)
  - `runCodexAppServerAgent`
  - initializes JSON-RPC client, starts/resumes thread, starts turn, streams assistant deltas/snapshots, handles interactive input, unsubscribes thread on cleanup

### 3) `/codex` Command Surface

- Command handler:
  - [src/auto-reply/reply/commands-codex.ts](src/auto-reply/reply/commands-codex.ts)
  - `handleCodexCommand`
- Action coverage in handler:
  - `/codex new|spawn`
  - `/codex join`
  - `/codex steer`
  - `/codex status`
  - `/codex detach`
  - `/codex list [filter]`
- Helper flow in same file:
  - `ensureCodexBoundSession`
  - `resolveCodexReplyRoute`
  - `sendCodexReplies`
  - `buildThreadReplayPayloads`
  - `buildPendingInputReplay`
  - `shouldPinCodexBindingNotice`

### 4) Thread Discovery, Readback, Slash Discovery

- Discovery/read entrypoints:
  - [src/agents/codex-app-server-runner.ts](src/agents/codex-app-server-runner.ts)
  - `discoverCodexAppServerThreads`
  - `readCodexAppServerThreadContext`
  - `discoverCodexAppServerSlashCommands`
- Parsing helpers (same file) used to avoid LLM-based selection:
  - `applyThreadFilter`
  - `extractThreadReplayFromReadResult`
  - `extractConversationMessages` (used to compute last user/assistant replay)
  - `extractSlashCommands`

### 5) Active Run Registry + Control Bridge

- Codex run registry:
  - [src/agents/codex-app-server-runs.ts](src/agents/codex-app-server-runs.ts)
  - `setActiveCodexAppServerRun`
  - `clearActiveCodexAppServerRun`
  - `queueCodexAppServerMessageBySessionKey`
  - `submitCodexAppServerPendingInputBySessionKey`
  - `isCodexAppServerAwaitingInputBySessionKey`
- Provider-agnostic control bridge:
  - [src/agents/run-control.ts](src/agents/run-control.ts)
  - `queueAgentRunMessageBySessionKey`
  - `submitAgentRunPendingInputBySessionKey`

### 6) Pending Input + Approval Modeling

- Approval action modeling and callback encoding:
  - [src/agents/codex-app-server-pending-input.ts](src/agents/codex-app-server-pending-input.ts)
  - `buildCodexPendingUserInputActions`
  - `buildCodexPendingInputButtons`
  - `buildCodexPendingInputCallbackData`
  - `parseCodexPendingInputCallbackData`
  - `matchesCodexPendingInputRequestToken`
- In-run interactive request handling:
  - [src/agents/codex-app-server-runner.ts](src/agents/codex-app-server-runner.ts)
  - request handler captures interactive request payloads, sends tool result with Telegram button metadata, waits for mapped response, and returns protocol-typed response back to Codex
  - text formatting for approvals is generated in code (`buildPromptText`, `buildMarkdownCodeBlock`), not delegated to model parsing

### 7) Telegram Event Handlers and Routing

- Telegram callback handler:
  - [src/telegram/bot-handlers.ts](src/telegram/bot-handlers.ts)
  - event: `bot.on("callback_query", ...)`
  - parses `cdxui:*` callback data, resolves conversation binding, validates request token/action, submits pending input via `submitAgentRunPendingInputBySessionKey`, clears inline buttons, posts ack text
- Telegram free-form message path:
  - [src/telegram/bot-handlers.ts](src/telegram/bot-handlers.ts)
  - event: `bot.on("message", ...)`
  - inbound messages flow through normal pipeline and can be consumed as queued input when session is waiting
- Sequential lane behavior for pending approvals:
  - [src/telegram/sequential-key.ts](src/telegram/sequential-key.ts)
  - `getTelegramSequentialKey`
  - routes `cdxui:*` callbacks and pending-input conversations to control lane to avoid interleaving races

### 8) Binding and Session Persistence

- Shared session binding abstraction:
  - [src/infra/outbound/session-binding-service.ts](src/infra/outbound/session-binding-service.ts)
  - `getSessionBindingService`, `bind`, `resolveByConversation`, `touch`, `unbind`
- Telegram binding persistence:
  - [src/telegram/thread-bindings.ts](src/telegram/thread-bindings.ts)
  - `createTelegramThreadBindingManager`
  - stores thread binding records and exposes adapter integration
- Session entry surfaces:
  - [src/auto-reply/reply/session.ts](src/auto-reply/reply/session.ts)
  - [src/config/sessions/types.ts](src/config/sessions/types.ts)
  - codex fields persisted on session entries include:
    - `providerOverride="codex-app-server"`
    - `codexThreadId`
    - `codexProjectKey`
    - `codexAutoRoute`
    - `pendingUserInput*` fields

## Request/Response Lifecycle (Telegram Topic, Bound Session)

1. User message reaches Telegram handler (`bot.on("message")`).
2. Bound conversation resolves through `SessionBindingService`.
3. `runAgentTurnWithFallback` selects `codex-app-server` provider for bound session.
4. `runCodexAppServerAgent` starts or resumes thread and sends `turn/start`.
5. Assistant deltas/snapshots are emitted through partial reply hooks.
6. If Codex requests interactive input:
   - request is mapped to deterministic prompt text and actions
   - Telegram buttons are generated from typed actions
   - pending input metadata is persisted on session entry
7. Operator responds by button callback or free text:
   - callback path submits action index
   - free text path queues steer/text input
8. App Server response is sent; run continues to completion.
9. Cleanup unsubscribes thread and clears active run handle.

## Startup Recovery Lifecycle

1. On gateway start, Codex runtime probe executes.
2. Pending inputs are reconciled (expired pending prompts are cleared).
3. Bound Codex sessions are reconciled:
   - stale bindings removed when session key no longer exists
   - missing bindings re-created from persisted session metadata
   - repaired entries enforce `providerOverride=codex-app-server` and `codexAutoRoute=true`
4. Startup logs include checked/repaired/removed/failed counts for observability.

## Current Design Constraints

- Transport abstraction allows websocket or stdio, but current operational focus is stdio.
- Run control API is session-key keyed; correct binding resolution is mandatory for approval callbacks.
- Approval rendering and callback encoding are deterministic and strongly typed in code paths; they should not depend on model interpretation.
- Thread replay shown by `/codex join` is extracted from structured thread/read data, not synthesized by LLM summarization.

## Mirrored Command Split

The current design should treat mirrored Codex slash commands as three different implementation families rather than one generic "dispatch slash text" path.

### 1) Client-side commands

These are implemented locally in Codex TUI and should be mirrored in OpenClaw as local UX backed by App Server state:

- `/codex_status`
- `/codex_fast`
- `/codex_model`
- `/codex_permissions`
- `/codex_experimental`
- `/codex_skills`
- `/codex_plan`
- `/codex_diff`
- `/codex_mcp`

Current OpenClaw seam:

- [src/auto-reply/reply/commands-codex.ts](src/auto-reply/reply/commands-codex.ts)
- `handleCodexCommand`
- `runCodexSlashCommandDirectly`

Design note:

- these commands should stop flowing through `runCodexSlashCommandDirectly(...)` as slash-text prompts
- they need dedicated handlers that read or mutate local Codex session state using structured App Server methods and stored session metadata

### 2) Structured App Server operations

These commands should map to explicit protocol methods rather than conversational turn text:

- `/codex_review` -> `review/start`
- `/codex_rename` -> `thread/name/set`
- `/codex_compact` -> `thread/compact/start`

Primary seams:

- [src/auto-reply/reply/commands-codex.ts](src/auto-reply/reply/commands-codex.ts)
- [src/agents/codex-app-server-runner.ts](src/agents/codex-app-server-runner.ts)

Design note:

- these handlers should become method-specific runner entry points instead of piggybacking on mirrored slash text dispatch

### 3) Relayed turn commands

These are the remaining mirrored commands that still plausibly map to a user turn:

- `/codex_init`

Design note:

- `/codex_init` aligns with the Codex TUI pattern of submitting a built-in init prompt as a user message, so turn relay remains the expected shape here unless later source review shows a better structured path

### Evidence sources

The March 7, 2026 local Codex source review that drove this split came from:

- `codex-rs/tui/src/chatwidget.rs`
- `codex-rs/tui/src/app.rs`
- `codex-rs/tui/src/status/mod.rs`
- `codex-rs/tui/src/status/card.rs`
- `codex-rs/app-server/README.md`
- `codex-rs/app-server-protocol/src/protocol/common.rs`

## Next-Iteration Design Hooks

This section maps the refined March 6, 2026 requirements into concrete code seams.

### 1) `/codex list --cwd` with home expansion

- Command parse and dispatch seam:
  - [src/auto-reply/reply/commands-codex.ts](src/auto-reply/reply/commands-codex.ts)
  - `handleCodexCommand` in the `action === "list"` branch
- Thread filter seam:
  - [src/agents/codex-app-server-runner.ts](src/agents/codex-app-server-runner.ts)
  - `discoverCodexAppServerThreads`
  - `buildThreadDiscoveryFilter`
- Design intent:
  - expand `~/...` to home before discovery
  - validate directory existence before exact-path filtering
  - keep filtering deterministic and avoid LLM-mediated path matching in the critical path

### 2) Approval replay de-duplication on join and restart

- Replay emit seam:
  - [src/auto-reply/reply/commands-codex.ts](src/auto-reply/reply/commands-codex.ts)
  - `buildPendingInputReplay`
  - join payload routing in `handleCodexCommand` in the `action === "join"` branch
- Startup reconciliation seam:
  - [src/agents/codex-app-server-startup.ts](src/agents/codex-app-server-startup.ts)
  - `reconcileCodexPendingInputsOnStartup`
- Callback token seam:
  - [src/agents/codex-app-server-pending-input.ts](src/agents/codex-app-server-pending-input.ts)
  - `buildCodexPendingInputCallbackData`
  - `matchesCodexPendingInputRequestToken`
- Design intent:
  - replay pending approvals once per unresolved request id
  - if an existing dialog is still actionable for the same request id, do not duplicate it

### 3) Monitoring across threads

- Existing data sources:
  - [src/agents/codex-app-server-runner.ts](src/agents/codex-app-server-runner.ts)
  - `discoverCodexAppServerThreads`
  - `readCodexAppServerThreadContext`
  - [src/infra/outbound/session-binding-service.ts](src/infra/outbound/session-binding-service.ts)
  - binding records resolved via `resolveByConversation`
  - [src/config/sessions/types.ts](src/config/sessions/types.ts)
  - persisted Codex thread and pending-input fields
- Design intent:
  - add a monitor aggregator that merges recent thread activity, pending approvals, binding metadata, and workspace or branch status
  - support poll mode for non-active thread visibility if App Server does not push enough events to passive clients

### 4) Telegram handler boundary cleanup

- Current heavy integration point:
  - [src/telegram/bot-handlers.ts](src/telegram/bot-handlers.ts)
  - `bot.on("callback_query", ...)`
  - `bot.on("message", ...)`
- Existing shared control seam:
  - [src/agents/run-control.ts](src/agents/run-control.ts)
  - `submitAgentRunPendingInputBySessionKey`
  - `queueAgentRunMessageBySessionKey`
- Design intent:
  - extract Codex pending-input callback and free-form routing into dedicated adapter module(s)
  - keep `bot-handlers.ts` focused on Telegram transport and event normalization

### 5) Focus and unfocus safety for Codex bindings

- Binding behavior seams:
  - [src/infra/outbound/session-binding-service.ts](src/infra/outbound/session-binding-service.ts)
  - [src/telegram/thread-bindings.ts](src/telegram/thread-bindings.ts)
  - [src/auto-reply/reply/commands-codex.ts](src/auto-reply/reply/commands-codex.ts)
  - `shouldPinCodexBindingNotice`
  - bind and unbind flows in `ensureCodexBoundSession` and `unbindCodexConversation`
- Design intent:
  - preserve Codex binding correctness when `/focus` and `/unfocus` are used
  - avoid orphaning codex-bound session entries
  - keep pinned bind notice behavior consistent for topic conversations
