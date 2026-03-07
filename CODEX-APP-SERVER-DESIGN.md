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
