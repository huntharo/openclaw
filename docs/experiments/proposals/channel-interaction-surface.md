---
summary: "Proposal: move channel interaction semantics behind a unified plugin-owned interaction surface"
read_when:
  - Designing channel-agnostic messaging, threading, topic, poll, or rich UI behavior
  - Refactoring channel-specific interaction logic out of core messaging and prompt code
title: "Channel Interaction Surface (Proposal)"
---

# Channel Interaction Surface (Proposal)

Status: Proposed, not implemented yet.

This document proposes a plugin-owned interaction surface for channels. It does
not change current behavior by itself.

For current behavior, read source in:

- `src/channels/plugins/types.core.ts`
- `src/channels/plugins/types.adapters.ts`
- `src/channels/dock.ts`
- `src/channels/plugins/message-actions.ts`
- `src/infra/outbound/deliver.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/infra/outbound/message-action-params.ts`
- `src/agents/channel-tools.ts`
- `src/agents/system-prompt.ts`
- `src/plugins/types.ts`
- `extensions/discord/src/subagent-hooks.ts`
- `src/telegram/thread-bindings.ts`

## Problem

Today, OpenClaw already has channel plugins, but interaction behavior is still
split across several separate abstractions:

- `ChannelPlugin.capabilities` for broad support flags
- `ChannelDock` for lightweight channel-specific reads and threading helpers
- `outbound` adapters for delivery
- `actions` adapters for agent-discoverable message actions
- `threading` adapters for reply and tool-context behavior
- `agentPrompt.messageToolHints` for prompt-visible affordances
- generic plugin hooks for subagent lifecycle events
- hard-coded core helpers for Slack, Telegram, and Discord specific cases

This works for a small set of channels, but it scales poorly:

- the same channel truth is duplicated in more than one place
- core logic must know too much about provider-specific reply, thread, topic,
  button, and poll behavior
- new channels can implement `ChannelPlugin` and still fail to pick up the full
  interaction surface without touching scattered core code
- prompt claims like "I pinned this" or "I created a topic" are difficult to
  ground in a single capability check + structured outcome model

The result is a channel system that is pluginized at the transport layer, but
not yet pluginized at the interaction-semantics layer.

## Current-state audit

This audit is based on current code under `src/channels`, `src/infra/outbound`,
`src/agents`, `src/plugins`, and shipped channel plugins under `extensions/*`.

### Existing abstractions

Current channel interaction behavior is distributed like this:

- `ChannelPlugin` is the main plugin contract. It exposes broad capabilities,
  config, outbound delivery, actions, threading, messaging, prompt hints,
  directory lookup, and optional gateway/runtime hooks.
- `ChannelCapabilities` is a coarse support map. It covers high-level booleans
  such as `polls`, `threads`, `reactions`, `edit`, `reply`, `media`, and
  `nativeCommands`, but it does not answer "can I do this here, now, in this
  conversation?"
- `ChannelDock` is a second lightweight channel surface used by shared core
  code. It duplicates capability, threading, config, mention, and prompt facts
  for built-in and plugin-backed channels.
- `ChannelOutboundAdapter` owns message delivery. It already supports
  `sendText`, `sendMedia`, `sendPayload`, and `sendPoll`.
- `ChannelMessageActionAdapter` owns agent-discoverable actions. It currently
  exposes `listActions`, `supportsAction`, `supportsButtons`,
  `supportsCards`, `extractToolSend`, and `handleAction`.
- `ChannelThreadingAdapter` owns reply-to behavior and tool-context threading.
  This is where reply modes and per-channel tool threading context are
  currently injected.
- `ChannelAgentPromptAdapter` is used to leak channel-specific interaction hints
  into the system prompt. Examples today include Discord components/forms,
  LINE rich-message directives, and other channel-specific instructions.
- Generic plugin hooks already exist for subagent lifecycle:
  `subagent_spawning`, `subagent_delivery_target`, `subagent_spawned`, and
  `subagent_ended`. Discord uses them today. Telegram has thread-binding logic,
  but it is still core-owned rather than plugin-owned through the same surface.

### Normalized taxonomy of interaction features in use today

OpenClaw is already using the following interaction features today, but they are
not represented behind one normalized surface:

#### 1. Conversation topology

- Direct conversations
- Groups/rooms
- Channels/spaces
- Ephemeral reply references to a specific message
- Durable threads
- Durable topics/forum threads
- Nested scopes, especially "reply inside topic inside group"
- Thread/topic auto-targeting for tool-sent messages
- Session/subagent bindings to durable thread/topic destinations

#### 2. Message and conversation actions

- Send text/media replies
- Edit and delete/unsend
- React and inspect reactions
- Pin, unpin, and list pins
- Rename group/topic
- Create thread/topic/channel-like destinations
- Participant/group membership actions
- Read/search/info actions that are interaction-adjacent but not central to
  this proposal

#### 3. Interactive UI

- Poll creation
- Inline buttons
- Slack blocks
- Discord components and modals/forms
- Teams adaptive cards
- LINE and channel-specific rich card directives

#### 4. Presentation

- Markdown rendering with per-channel conversion rules
- Fenced code blocks and chunking rules
- Media attachments and captions
- Reply references and quote text
- Fallback text requirements for rich layouts
- Channel-specific degradation rules when a richer layout is unsupported

### Shipped channel matrix

Legend:

- `yes` = implemented and exposed today
- `partial` = limited, conditional, or still partly core-owned
- `no` = not implemented today
- `channel-specific` = implemented today, but with a provider-specific schema or
  prompt convention rather than a normalized one

| Channel         | Topology                                                                                                                                                | Actions                                                                                                                             | Interactive UI                                                                       | Presentation / notes                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| BlueBubbles     | direct/group; ephemeral reply `yes`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                           | send/edit/unsend/react/reply `yes`; rename group/icon and participant ops `yes`; pin `no`; topic/thread spawn `no`                  | none                                                                                 | iMessage-specific message ids and private API gating are channel-specific                                                 |
| Discord         | direct/channel/thread; ephemeral reply `yes`; durable threads `yes`; nested layers `partial`; bound destinations `yes` via plugin hooks                 | send/edit/delete/react/pin/list pins/read/search `yes`; create thread/channel/category/event `yes`; moderation and role ops `yes`   | polls `yes`; components `yes`; modals/forms `yes`; buttons/selects `yes`             | markdown + component payloads + forum/thread behavior are partly core-aware today                                         |
| Feishu          | direct/channel; ephemeral reply `yes`; durable threads `partial`; nested layers `no`; bound destinations `no`                                           | send/edit/reply/react `yes`; durable rename/spawn `no`                                                                              | interactive cards `channel-specific`                                                 | cards are exposed by hints and channel payloads rather than one shared schema                                             |
| Google Chat     | direct/group/thread; ephemeral reply `yes`; durable threads `yes`; nested layers `partial`; bound destinations `no`                                     | send/react `yes`; broader message lifecycle ops `partial`; durable rename/spawn `no`                                                | cards `partial`                                                                      | webhook/threading semantics are channel-specific                                                                          |
| iMessage        | direct/group; ephemeral reply `yes`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                           | send/reply `yes`; richer lifecycle ops `no`                                                                                         | none                                                                                 | plain text + media + reply references only                                                                                |
| IRC             | direct/group; ephemeral reply `no`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                            | send `yes`; other interaction ops `no`                                                                                              | none                                                                                 | effectively plain-text delivery surface                                                                                   |
| LINE            | direct/group; ephemeral reply `no`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                            | send `yes`; other lifecycle ops `no`                                                                                                | quick replies, confirm dialogs, buttons, event/device/media cards `channel-specific` | rich UI currently leaks through prompt directives instead of a normalized payload                                         |
| Mattermost      | direct/channel/group/thread; ephemeral reply `partial`; durable threads `yes`; nested layers `partial`; bound destinations `no`                         | send/react `yes`; durable rename/spawn `no` in current adapter                                                                      | buttons `yes`                                                                        | button layouts exist, but only as provider-specific payloads                                                              |
| Matrix          | direct/group/thread; ephemeral reply `yes`; durable threads `yes`; nested layers `partial`; bound destinations `no`                                     | send/edit/delete/react/pin/list pins `yes`; channel/member info `yes`; durable rename/spawn `no`                                    | polls `yes`                                                                          | thread/poll semantics exist, but no shared interaction contract yet                                                       |
| Microsoft Teams | direct/channel/thread; ephemeral reply `partial`; durable threads `yes`; nested layers `partial`; bound destinations `no`                               | send `yes`; poll `yes`; other durable ops `no` in current adapter                                                                   | adaptive cards `yes`; cards are provider-specific; forms `partial`                   | rich card surface is distinct from Slack/Discord/Telegram today                                                           |
| Nextcloud Talk  | direct/group; ephemeral reply `no`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                            | send `yes`; other interaction ops `no`                                                                                              | none                                                                                 | basic text/media surface                                                                                                  |
| Nostr           | direct; ephemeral reply `partial`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                             | send `yes`; other lifecycle ops `no`                                                                                                | none                                                                                 | MVP DM-only surface                                                                                                       |
| Signal          | direct/group; ephemeral reply `yes`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                           | send/react `yes`; other lifecycle ops `partial`                                                                                     | none                                                                                 | reply ids and formatting are normalized only at delivery time                                                             |
| Slack           | direct/channel/thread; ephemeral reply `yes`; durable threads `yes`; nested layers `partial`; bound destinations `no`                                   | send/edit/delete/react `yes`; other durable ops are partly available through provider-specific helpers; rename/spawn not normalized | blocks `yes`; buttons `yes`; cards `partial`; modals/forms `partial`                 | markdown conversion, blocks, and thread auto-targeting are scattered across core and plugin surfaces                      |
| Synology Chat   | direct; ephemeral reply `no`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                                  | send `yes`; other interaction ops `no`                                                                                              | none                                                                                 | simple direct-message surface                                                                                             |
| Telegram        | direct/group/channel/thread; ephemeral reply `yes`; durable topics `yes`; nested layers `yes`; bound destinations `partial` through core-owned bindings | send/edit/delete/react/sticker `yes`; topic create `yes`; pin `partial`; broader durable ops are split across core/helpers          | polls `yes`; inline buttons `yes`                                                    | markdown to HTML, topic auto-targeting, reply-in-topic, and pinning already prove the need for a richer interaction layer |
| Tlon            | direct/group/thread; ephemeral reply `yes`; durable threads `yes`; nested layers `partial`; bound destinations `no`                                     | send/story `partial`; broader lifecycle ops `no`                                                                                    | none                                                                                 | custom story/media behavior is channel-specific                                                                           |
| Twitch          | group; ephemeral reply `no`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                                   | basic send/actions `partial`                                                                                                        | none                                                                                 | chat-only group surface                                                                                                   |
| WhatsApp        | direct/group; ephemeral reply `yes`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                           | send/react `yes`; poll `yes`; other durable ops `no`                                                                                | polls `yes`; buttons/cards `no` in current plugin surface                            | reply references and poll behavior exist without threads/topics                                                           |
| Zalo            | direct/group; ephemeral reply `partial`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                       | send `yes`; broader lifecycle ops `partial`                                                                                         | none                                                                                 | mostly basic messaging with provider-specific monitor/runtime behavior                                                    |
| Zalo User       | direct/group; ephemeral reply `partial`; durable threads/topics `no`; nested layers `no`; bound destinations `no`                                       | send `yes`; broader lifecycle ops `partial`                                                                                         | none                                                                                 | same interaction shape as Zalo, different account/runtime model                                                           |

### Main core touchpoints to replace

These are the highest-value seams where channel-specific interaction logic is
still embedded in core code and should move behind one interaction surface:

- `src/channels/dock.ts`
  - duplicates capability, threading, config, and prompt-facing facts
  - still acts as a parallel source of truth next to `ChannelPlugin`
- `src/channels/plugins/message-actions.ts`
  - only knows how to ask global button/card questions today
  - does not expose one normalized interaction capability model
- `src/infra/outbound/message-action-runner.ts`
  - centralizes message action execution, but still contains core knowledge of
    Slack/Telegram auto-thread targeting, channel-specific parameter shaping,
    and cross-context decoration policy
- `src/infra/outbound/message-action-params.ts`
  - contains Slack and Telegram thread injection logic and provider-specific
    parsing behavior for blocks/cards/components
- `src/infra/outbound/message-action-spec.ts`
  - encodes static action-name target rules instead of delegating to a richer
    interaction model
- `src/agents/channel-tools.ts` and `src/agents/system-prompt.ts`
  - still compute prompt-visible capabilities from dock/action helpers and
    explicit Slack/Telegram/Discord-specific checks
- `src/plugins/types.ts` plus `extensions/discord/src/subagent-hooks.ts`
  - generic lifecycle hooks exist, but "channel interaction" is not yet the
    unit of abstraction; only Discord currently owns durable subagent binding
    through plugin hooks
- `src/telegram/thread-bindings.ts`
  - Telegram already has durable topic/thread binding logic, but it is still
    core-owned rather than exposed through a shared plugin interaction surface

## Proposed interaction model

Add a new `interactions` layer to `ChannelPlugin`. This layer sits above the
current `outbound`, `actions`, `threading`, and subagent-hook surfaces.

The new surface should answer four questions in one place:

1. What conversation scope am I in right now?
2. What can this channel/account/conversation do right now?
3. If I ask for an interaction, what happened?
4. If I send a rich payload, how was it degraded or rejected?

### Design goals

- Keep existing adapters in place and compose over them.
- Move from provider booleans to scoped conversation layers.
- Treat capabilities as contextual facts, not static plugin traits.
- Require structured outcomes so prompts can distinguish skipped, failed, and
  applied operations.
- Let plugins degrade rich payloads intentionally and report how they degraded
  them.

### Proposed types

```ts
type ChannelConversationLayerKind = "direct" | "group" | "channel" | "thread" | "topic" | "reply";

type ChannelCapabilityStatus = "supported" | "unsupported" | "conditional";

type ChannelOperationOutcomeStatus =
  | "applied"
  | "failed"
  | "skipped_unsupported"
  | "skipped_disallowed"
  | "skipped_not_applicable";

type ChannelDegradationReason =
  | "unsupported_layout"
  | "unsupported_style"
  | "unsupported_text_variant"
  | "unsupported_visibility"
  | "missing_context"
  | "policy_blocked"
  | "limit_exceeded"
  | "provider_error";

type ChannelConversationLayerRef = {
  kind: ChannelConversationLayerKind;
  id: string;
  durable: boolean;
  label?: string;
  parentId?: string;
  messageId?: string;
};

type ChannelInteractionContext = {
  channel: ChannelId;
  accountId?: string | null;
  target: {
    to: string;
    normalizedTo?: string;
  };
  currentMessageId?: string;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  layers: ChannelConversationLayerRef[];
  toolContext?: ChannelThreadingToolContext;
};

type ChannelInteractionCapability = {
  status: ChannelCapabilityStatus;
  reason?: string;
  limitations?: string[];
};

type ChannelInteractionCapabilities = {
  replyReference: ChannelInteractionCapability;
  durableThreads: ChannelInteractionCapability;
  durableTopics: ChannelInteractionCapability;
  nestedLayers: ChannelInteractionCapability;
  pin: ChannelInteractionCapability;
  renameConversation: ChannelInteractionCapability;
  createConversation: ChannelInteractionCapability;
  polls: ChannelInteractionCapability;
  buttons: ChannelInteractionCapability;
  cards: ChannelInteractionCapability;
  forms: ChannelInteractionCapability;
  markdown: ChannelInteractionCapability;
  codeBlocks: ChannelInteractionCapability;
  media: ChannelInteractionCapability;
};

type ChannelInteractionAction = {
  id: string;
  text: {
    short: string;
    long?: string;
  };
  style?: "default" | "primary" | "success" | "danger";
  callbackData?: string;
  url?: string;
};

type ChannelInteractionRenderSpec = {
  body?: {
    text: string;
    format: "markdown" | "plain";
    allowCodeBlocks?: boolean;
  };
  media?: Array<{
    url: string;
    alt?: string;
    caption?: string;
  }>;
  quote?: {
    messageId?: string;
    text?: string;
  };
  actions?: {
    layout?: "auto" | "row" | "column";
    rows: ChannelInteractionAction[][];
  };
  card?: {
    title?: string;
    summary?: string;
    sections?: Array<{
      title?: string;
      body: string;
    }>;
  };
  form?: {
    title: string;
    submitLabel?: string;
    fields: Array<{
      id: string;
      label: string;
      kind: "short-text" | "long-text" | "select";
      required?: boolean;
      options?: Array<{ value: string; label: string }>;
    }>;
  };
  poll?: {
    question: string;
    options: Array<{
      id: string;
      text: {
        short: string;
        long?: string;
      };
    }>;
    maxSelections?: number;
    visibility?: "channel-default" | "anonymous" | "named";
    durationSeconds?: number;
    durationHours?: number;
  };
  fallbackText?: string;
};

type ChannelInteractionOperation =
  | {
      kind: "message.send";
      render: ChannelInteractionRenderSpec;
    }
  | {
      kind: "message.pin";
      mode: "pin" | "unpin" | "list";
      messageId?: string;
    }
  | {
      kind: "conversation.rename";
      layerKind: "group" | "thread" | "topic";
      title: string;
    }
  | {
      kind: "conversation.create";
      layerKind: "thread" | "topic";
      title: string;
      initialMessage?: ChannelInteractionRenderSpec;
    }
  | {
      kind: "poll.create";
      render: ChannelInteractionRenderSpec;
    };

type ChannelInteractionResult = {
  status: ChannelOperationOutcomeStatus;
  message?: string;
  capability?: ChannelInteractionCapability;
  messageId?: string;
  createdLayer?: ChannelConversationLayerRef;
  degradations?: Array<{
    reason: ChannelDegradationReason;
    field: string;
    note?: string;
  }>;
  error?: {
    code?: string;
    message: string;
    retryable?: boolean;
  };
};

type ChannelInteractionLayer = {
  resolveContext: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    to: string;
    toolContext?: ChannelThreadingToolContext;
    requesterSenderId?: string | null;
    requesterSenderName?: string | null;
    currentMessageId?: string;
  }) => Promise<ChannelInteractionContext>;

  inspectCapabilities: (params: {
    cfg: OpenClawConfig;
    context: ChannelInteractionContext;
  }) => Promise<ChannelInteractionCapabilities>;

  perform: (params: {
    cfg: OpenClawConfig;
    context: ChannelInteractionContext;
    operation: ChannelInteractionOperation;
    dryRun?: boolean;
  }) => Promise<ChannelInteractionResult>;
};
```

### Why scoped conversation layers instead of provider flags

The current system already proves that provider flags are not enough:

- Slack thread auto-targeting depends on current thread + reply mode
- Telegram topic behavior depends on current chat + topic layer
- Discord durable thread behavior depends on thread/forum/channel context
- rich UI support depends on account config, action gates, and current target

The proposal therefore models interaction scope as a layer stack:

- base conversation layer: direct, group, or channel
- optional durable layer: thread or topic
- optional ephemeral layer: reply

That lets one context represent:

- a plain DM
- a Slack thread in a channel
- a Telegram topic in a group
- a Telegram reply inside a topic inside a group

This is the right abstraction boundary for prompt decisions and tool behavior.

### Why capabilities must be contextual

The current `ChannelCapabilities` booleans are still useful, but they only
describe broad provider traits.

Prompt logic needs stronger answers:

- "Pin is supported here" vs "pin exists somewhere on this provider"
- "Rename is supported for this topic" vs "rename exists for some target kinds"
- "buttons are available on this account and target" vs "the plugin has a
  button surface in some contexts"

`inspectCapabilities()` should therefore combine:

- static plugin traits
- action gates
- current conversation layers
- account config
- provider-specific context checks

### Why outcomes must distinguish skipped vs failed

Today a caller often has to infer outcome from a thrown error or from the
absence of a capability. The new layer should force one of these results:

- applied: supported and succeeded
- failed: supported, attempted, but provider/runtime failed
- skipped_unsupported: not available on this provider or payload shape
- skipped_disallowed: supported in general, but blocked by policy/config
- skipped_not_applicable: supported in general, but not valid in the current
  conversation scope

This gives prompt builders and user-visible messaging a reliable contract:

- "I pinned this message."
- "Pinning is not available in this conversation, so I left the message
  unpinned."
- "Topic rename is supported here, but the provider returned an error."

### Why the rich payload must be row-oriented

Buttons/cards/forms already exist today, but each provider exposes them through
different shapes:

- Telegram inline keyboard rows
- Slack blocks
- Discord components and modal definitions
- Teams adaptive cards
- LINE rich-message directives

The least-bad shared payload is a richer row-oriented spec with optional hints:

- short and long text variants
- style hints
- row or column layout preference
- optional card and form sections
- explicit fallback text

Each plugin can then:

- render the full spec
- degrade unsupported hints
- reject truly unsupported constructs
- report degradations explicitly

That is better than either extreme:

- a common-denominator schema that cannot express current Discord/Slack/LINE
  behavior
- a provider-specific free-for-all that keeps interaction logic scattered

### Composition over existing adapters

The new surface should compose over current adapters, not replace them
immediately:

- `resolveContext()` composes current target normalization and
  `threading.buildToolContext`
- `inspectCapabilities()` composes `capabilities`, `actions.listActions`,
  `supportsButtons`, `supportsCards`, and account/config checks
- `perform({ kind: "message.send" })` composes `outbound.sendPayload`,
  `sendText`, `sendMedia`, and `sendPoll`
- `perform({ kind: "message.pin" })` initially wraps existing action handlers
  for channels that already expose pin/unpin/list-pins
- `perform({ kind: "conversation.rename" })` initially wraps existing
  provider-specific rename helpers such as BlueBubbles rename and future topic
  rename adapters
- `perform({ kind: "conversation.create" })` wraps existing Discord thread
  creation, Telegram topic creation, and future equivalents
- durable subagent/session behavior composes existing plugin hooks where
  available and existing core Telegram binding code until Telegram is migrated

This lets OpenClaw adopt one interaction model without requiring a clean-slate
rewrite.

## Migration shape

### Phase 1: add the new interaction types and plugin surface

- Add `interactions?: ChannelInteractionLayer` to `ChannelPlugin`.
- Keep `outbound`, `actions`, `threading`, `agentPrompt`, and hook surfaces
  unchanged.
- Add shared core types in `src/channels/plugins/types.core.ts` or a dedicated
  `types.interactions.ts`.

No behavior change in this phase.

### Phase 2: build compatibility adapters for existing channels

Implement compatibility-backed `interactions` layers for shipped channels by
composing existing code:

- `resolveContext()` from current target normalization and tool threading
  context
- `inspectCapabilities()` from plugin capabilities + actions + context checks
- `perform()` from current action handlers and outbound adapters

Priority channels:

1. Telegram
2. Discord
3. Slack
4. WhatsApp
5. Matrix
6. Mattermost
7. Microsoft Teams
8. BlueBubbles

These channels already exercise most of the hard interaction cases.

### Phase 3: switch core call sites to `interactions`

Replace core branching in this order:

1. Prompt capability surfacing
   - move `messageToolHints`, button/card support checks, and capability claims
     to `inspectCapabilities()`
2. Message tool and action execution
   - move action-name dispatch and rich payload handling to
     `interactions.perform()`
3. Thread/topic auto-targeting
   - move Slack/Telegram thread injection out of
     `message-action-runner.ts`/`message-action-params.ts`
4. Subagent/session-bound channel behavior
   - make durable destination creation/binding an interaction concern rather
     than a channel-specific hook special case

### Phase 4: shrink or remove older special-case helpers

After parity is proven:

- shrink `ChannelDock` down to read-only config helpers, or fold its
  interaction-facing pieces into `interactions`
- reduce direct use of `actions.supportsButtons` and `supportsCards`
- reduce direct use of per-channel prompt hints for capability claims
- collapse provider-specific auto-thread helpers that became part of
  `resolveContext()` and `perform()`

## First implementation pass: in scope vs out of scope

### In scope

- new interaction types and plugin surface
- compatibility adapters for existing channels
- migration of prompt capability checks, message tool execution, and
  thread/topic auto-targeting to the new surface
- structured outcomes and explicit degradation reporting

### Out of scope

- replacing every existing action name immediately
- building a generic arbitrary layout engine for every provider
- rewriting onboarding, config schema, status, resolver, or gateway lifecycle
  surfaces unless they directly block interaction migration
- removing existing adapters before parity is proven

## Review scenarios

Maintainers should use these scenarios to review the proposal:

1. Pin requested in a channel that supports pinning vs one that does not.
   The interaction layer should expose both the capability check and the
   applied/skipped outcome.
2. Rename requested in a durable topic where rename is supported, unsupported,
   and provider-failed.
   Prompt builders should be able to distinguish all three.
3. Telegram nested delivery: reply inside topic inside group.
   The context should model this as layered scope, not as Telegram-only flags.
4. Rich buttons/components requested with advanced hints.
   Discord or Slack may render most of the spec; Teams/LINE may degrade
   differently; plain channels should skip with explicit degradation or
   unsupported outcomes.
5. Markdown plus fenced code blocks across Telegram, Slack, Discord, and
   plain-text-like channels.
   The render contract should preserve code-block intent even when formatting is
   downgraded.
6. Poll creation across channels with different anonymity, duration, and option
   limits.
   The result should expose what was kept, degraded, or rejected.
7. Subagent/session flows that create or bind durable topics/threads where
   supported and fall back cleanly where not.
   Durable destination binding should be reported as an interaction outcome, not
   inferred from channel-specific side effects.

## Assumptions and defaults

- Proposal path: `docs/experiments/proposals/channel-interaction-surface.md`
- Scope: all shipped message channels, including extension channels
- Strategy: incremental compatibility layer, not a clean-slate v2 rewrite
- Payload shape: rich normalized schema with explicit fallback/degradation
- Existing plugin interfaces stay in place during migration
- A companion implementation plan under `docs/experiments/plans/` should be
  written only after maintainers agree on this proposal
