# Codex App Server Integration Plan

## Summary

Planned file: `CODEX-APP-SERVER-PLAN.md` at the repo root.

This plan defines a new Codex App Server integration that follows the `/acp` model closely for session targeting, topic binding, relay hooks, and operator ergonomics, while preserving Codex-native capabilities such as persistent thread binding, interactive approvals, thread discovery, and mirrored slash commands. Phase 1 prioritizes `/acp`-style parity and Telegram operator flow; interactive worktree/environment bootstrap lands in Phase 2.

## Ground Truths And Facts

- Canonical protocol reference: <https://developers.openai.com/codex/app-server>
- Reference implementation linked from the docs: <https://github.com/openai/codex/tree/main/codex-rs/app-server>
- Existing OpenClaw ACP operator model and command surface:
  - `docs/tools/acp-agents.md`
  - `docs/channels/telegram.md`
  - `/acp` already establishes the repo's preferred shape for session targeting, thread/topic binding, focus integration, relay hooks, and operator-facing command semantics.
- Existing Codex branch review findings:
  - The reviewed branch already has useful Telegram approval relay patterns, pending-input state persistence, thread binding metadata, and topic-aware routing ideas.
  - The reviewed branch also over-relies on compatibility probing for discovery and RPC shapes; the new implementation should follow the documented App Server contract first and keep fallbacks narrowly scoped.
- App Server transport facts from the docs:
  - `stdio` is connection-scoped, not thread-scoped.
  - One `stdio` or WebSocket connection can load and interact with multiple threads simultaneously.
  - `turn/start` auto-subscribes the current connection to the target thread.
  - `thread/unsubscribe` removes the connection's subscription to a thread without deleting the thread.
  - `thread/loaded/list` reports the threads currently loaded on that connection.
  - The transport question is therefore about connection ownership and lifecycle, not "one process/websocket per open thread."
- App Server protocol facts that materially affect the implementation:
  - The client must `initialize` and then send `initialized`.
  - `session/update` is the mechanism for session-scoped metadata like `cwd` and session identity.
  - Interactive tool prompts and approvals are part of the protocol and must be relayed, not flattened into best-effort text.
  - `serverRequest/resolved` exists and should be used to clear stale approval or input state.
  - `item/tool/requestUserInput` is experimental and should be negotiated accordingly when supported.
- Product direction chosen for this plan:
  - Phase 1 optimizes for `/acp` parity first.
  - Command naming is ACP-aligned hybrid: ACP-like targeting/binding semantics, Codex-native verbs where they improve clarity.
  - Guided worktree/environment bootstrap is Phase 2, not Phase 1.
  - Codex App Server should behave like a built-in runtime, not an external plugin: it uses the system `codex` binary when present, but startup probing and readiness reporting should mirror ACPX operationally.

## Public Surface And Usage Philosophy

- Primary operator command family: `/codex`
- Philosophy:
  - Bound conversations should behave like `/acp`: once a topic/DM is bound and focused, normal follow-up messages route directly to the Codex thread.
  - Codex thread identity must survive gateway restarts through persisted session metadata and rebinding logic.
  - Detach must be cheap and non-destructive: unbind locally, never close the remote Codex thread unless the operator explicitly asks.
  - Session targeting should mirror `/acp` conventions so `/focus [agent-id]` and related targeting rules work naturally.
  - Telegram is the first full UX, but the control-plane design must not hardcode Telegram into core session and binding logic.
  - Approvals are a first-class feature from day one, including buttons plus free-form replies.
- Initial command surface to plan around:
  - `/codex spawn` or `/codex new`
  - `/codex join`
  - `/codex steer`
  - `/codex status`
  - `/codex detach`
  - `/codex list [filter]`
  - `/codex close` only if explicitly supported and clearly separate from detach
  - Mirrored Codex slash commands as `/codex_<name>` when discoverable
- Targeting and binding model:
  - Use ACP-style target resolution precedence where possible.
  - Maintain an OpenClaw session key for the bound lane plus persisted Codex thread metadata.
  - Support agent-scoped identities so `/focus [agent-id]` works with Codex-bound conversations.
- Phase 1 non-goals:
  - Full interactive worktree/environment bootstrap
  - Broad multi-channel UX parity beyond designing reusable core abstractions
  - Undocumented App Server discovery APIs as primary behavior

## Implementation Changes

### Core architecture

- Introduce a Codex control-plane shape that mirrors ACP ownership patterns:
  - transport/client lifecycle
  - session metadata persistence
  - topic binding resolution
  - reply projection and relay hooks
  - explicit command handlers
- Prefer a documented-API-first App Server client:
  - first-class support for documented initialize/session/turn/thread methods
  - connection manager designed so a single connection can host multiple loaded threads when beneficial
  - narrow compatibility fallbacks only where needed for real App Server variants
- Explicitly model connection ownership decisions:
  - Phase 1 may still use one logical client per active run if that reduces risk
  - the abstraction must not encode "one transport per thread" as a requirement
  - cleanup must use `thread/unsubscribe` for connection-loaded threads
- Persist Codex session metadata alongside existing session store entries:
  - bound thread id
  - active run id
  - project/workspace identity
  - pending approval/input metadata
  - enough information to restore topic-local behavior after restart

### ACP-style integration points

- Follow `/acp` attachment points and operator model closely:
  - command parsing and targeting behavior
  - topic binding and focus semantics
  - dispatch and relay hooks for response streaming and status
  - startup reconciliation behavior for persisted bindings
- Reuse the session binding service rather than inventing a parallel Telegram-only binding layer.
- Make bound-topic routing and explicit `/codex steer` share the same backend session metadata and dispatch path where possible.

### Command and UX behavior

- `/codex spawn|new`
  - creates a new Codex thread
  - defaults to binding the current topic/DM unless explicitly detached
  - records workspace identity and binding metadata
- `/codex join`
  - resolves an existing Codex thread from explicit id or filter text
  - uses project-aware thread discovery
  - binds the current conversation to the selected thread
  - replays recent thread state into the topic when appropriate
  - if the thread is waiting on approval/input, replays that prompt into Telegram
- `/codex steer`
  - sends instructions to the bound or explicitly targeted Codex thread/session
- `/codex status`
  - shows binding state, run state, project identity, pending approval/input state, and focus/binding resolution
- `/codex detach`
  - clears local binding only
  - never closes the remote thread
- `/codex list [filter]`
  - remains supported
  - filters by project and text where possible
  - uses documented discovery/read flows first
- Mirrored slash commands
  - discover Codex and MCP-defined slash commands via App Server discovery
  - expose them as prefixed OpenClaw commands like `/codex_<name>`
  - avoid conflicts with built-in OpenClaw slash commands

### Approval and prompt relay

- Treat interactive approvals as first-class protocol items:
  - relay request text with operator-useful context
  - offer Telegram buttons for common decisions
  - accept free-form text replies as an alternate response path
  - clear pending state on `serverRequest/resolved`, completion, cancellation, or timeout
- Preserve richer approval semantics where exposed by the protocol:
  - available decisions
  - session-scoped approvals when offered
  - command and cwd context
  - file-change and tool-input prompts as distinct cases
- Keep approval replay restart-safe:
  - pending request metadata must survive restart
  - `/codex join` and resumed bound threads can replay unresolved approvals cleanly

## Phases And Tracking

### Phase 0: Plan And Architecture Baseline

- [x] Write `CODEX-APP-SERVER-PLAN.md` at the repo root with this structure and keep it updated as phases land.
- [x] Add ground-truth references to the App Server docs, App Server reference implementation, and ACP docs.
- [x] Document the chosen transport truth clearly: `stdio` supports multiple threads over one connection; it is not per-thread.
- [x] Record command-surface decisions: ACP-aligned hybrid naming, `/codex list`, mirrored `/codex_*`, detach semantics.
- [x] Record Phase 1 and Phase 2 boundaries explicitly.
- [x] Commit the plan-only change with `scripts/committer`.

### Phase 1: ACP-Parity Core For Telegram

Current status: partially implemented. The command surface, runner foundation, deterministic `/codex list`, startup readiness probe, and shared session-binding integration now exist; restart-safe rebinding polish, approval replay, and Telegram-specific approval UX still remain.

- [x] Before coding, identify the exact ACP integration points to mirror for targeting, binding, relay, and status.
- [ ] Write or update unit tests first where the interface is already clear:
  - command parsing and targeting resolution
  - binding persistence and restart reconciliation
  - approval state lifecycle
  - Telegram callback and free-form reply routing
- [x] Implement a documented-API-first Codex App Server client layer.
- [ ] Implement Codex session metadata persistence and restart-safe rebinding.
- [x] Implement `/codex spawn|new`, `/codex join`, `/codex steer`, `/codex status`, `/codex detach`, and `/codex list`.
- [x] Add a startup readiness gate that probes the built-in Codex runtime once at gateway boot and reports health.
- [x] Integrate bound-topic auto-routing so follow-up messages in a focused/bound conversation go directly to Codex through ACP-style bindings/focus.
- [ ] Integrate interactive approval and user-input relay from the start.
- [ ] Support replay of pending approvals when rejoining or resuming a bound thread.
- [x] Use `thread/unsubscribe` for cleanup of loaded threads on shared connections where applicable.
- [ ] Add or update Telegram docs for the bound Codex workflow once behavior is stable.
- [x] Run focused tests for Codex command handling, runner behavior, and Telegram routing.
- [ ] Commit Phase 1 with `scripts/committer`.

### Phase 2: Guided Bootstrap For New Threads

- [ ] Decide which `/codex spawn|new` parameters are explicit flags versus interactive prompts.
- [ ] Write tests first where prompt flow and session-state transitions are deterministic.
- [ ] Add interactive project selection, worktree setup, branch setup, and environment selection flow.
- [ ] Support both explicit flags like `--cwd` and operator-friendly guided prompts/buttons.
- [ ] Ensure the bootstrap flow feeds the resulting workspace/cwd back into Codex session metadata and binding state.
- [ ] Verify approval UX still works cleanly inside bootstrap/setup steps.
- [ ] Document the bootstrap flow and operator examples.
- [ ] Commit Phase 2 with `scripts/committer`.

### Phase 3: Mirrored Slash Commands And Discovery Hardening

- [ ] Replace heuristic discovery with documented discovery/read flows as the primary path.
- [ ] Add mirrored `/codex_<name>` command registration from discovered Codex and MCP slash commands.
- [ ] Add collision handling and stable fallback behavior when names conflict or discovery is unavailable.
- [ ] Add tests for slash command discovery, caching, refresh, and prefixed command dispatch.
- [ ] Document mirrored slash command behavior and limits.
- [ ] Commit Phase 3 with `scripts/committer`.

### Phase 4: Hardening And Cross-Channel Readiness

- [ ] Review the core design for Telegram assumptions and extract reusable channel-agnostic pieces.
- [ ] Harden connection lifecycle, reconnect behavior, and stale-binding recovery.
- [ ] Add tests for restart reconciliation, stale thread ids, missing workspaces, and connection-scoped multi-thread behavior.
- [ ] Evaluate whether to move from per-run logical clients toward a shared long-lived connection manager.
- [ ] Only broaden to additional channels after the control plane and Telegram UX are stable.
- [ ] Commit Phase 4 with `scripts/committer`.

## Test Plan

- Unit tests
  - command parsing, target resolution, and ACP-style fallback targeting
  - Codex session metadata read/write and restart recovery
  - App Server client request/notification handling for initialize, session update, turn lifecycle, approvals, and unsubscribe
  - approval and user-input response mapping, including free-form responses and Telegram button callbacks
  - discovery and filtered `/codex list` behavior
- Integration-style tests
  - Telegram topic binding, follow-up routing, detach, and approval replay
  - restart recovery for a bound topic with unresolved approval
  - `/focus` compatibility with Codex-backed session identities
- Verification gates per phase
  - run the smallest focused test set first while building
  - add broader command/routing coverage before phase closeout
  - use TDD when interfaces are already clear; otherwise add tests immediately after stabilizing the implementation shape

## Assumptions And Defaults

- Plan location is the repo root, not `docs/experiments/plans`.
- Phase 1 is Telegram-first in delivered UX, but the architecture must remain channel-agnostic enough to reuse later.
- `/codex` naming stays ACP-aligned hybrid rather than pure ACP or pure Codex naming.
- Guided worktree/environment bootstrap is intentionally deferred to Phase 2.
- `detach` is non-destructive and must not close the remote Codex thread.
- The implementation should follow documented App Server methods first and use compatibility fallbacks only where they solve a real observed interoperability gap.
