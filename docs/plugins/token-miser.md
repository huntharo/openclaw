---
summary: "Helper-model reduction of oversized tool output with exact session-scoped original retrieval"
title: "Token Miser"
read_when:
  - You want smaller model-facing tool results without losing original output
  - You need to retrieve or search an original Token Miser result
  - You are checking Token Miser helper usage and retention limits
---

Token Miser is an optional plugin that evaluates oversized completed text tool
results with a helper model. It retains the exact original text-content JSON
before delivering a bounded summary and a retrieval ID. The model can retrieve
exact bytes, inspect lines, search, batch-read originals, or ask a focused helper
question without rerunning the producer tool.

Enabling Token Miser opts into sending eligible tool output and bounded task
and argument context to the configured helper provider. This includes text
captured before Code Mode's ordinary output truncation. For grouped Code Mode
output, the evaluator receives separate bounded excerpts of the completed outer
result, including its computed final value and printed output, and every
captured nested member. The outer result, member excerpts, and metadata share
one helper prompt byte budget. Ambiguous or insufficient partial excerpts
preserve the ordinary result. These additional model calls can incur provider
charges. Byte reduction does not by itself prove token or cost savings.

## Enable

```json5
{
  plugins: {
    entries: {
      "token-miser": {
        enabled: true,
        config: {
          thresholdBytes: 8192,
          maxSummaryBytes: 4000,
          retentionHours: 168,
          maxStoredBytes: 268435456,
        },
      },
    },
  },
}
```

The helper uses the configured agent model resolved by `runtime.llm.complete` by default. To select another
configured model, set `config.helperModel` and explicitly authorize that model
through the plugin's LLM policy:

```json5 validate=false
{
  enabled: true,
  llm: {
    allowModelOverride: true,
    allowedModels: ["provider/helper-model"],
  },
  config: { helperModel: "provider/helper-model" },
}
```

This is the value of `plugins.entries["token-miser"]`, not a complete config.
Model selection and credentials stay with the existing
[plugin model completion owner](/plugins/sdk-runtime/models).

The active tool policy must allow `token_miser_read`. Token Miser preserves the
ordinary result when exact retrieval is unavailable. `token_miser_focus` is an
additional helper capability; it can be denied independently.

## Results and retrieval

A summarized result names its original ID, expiry, and available retrieval tool.
Treat both the summary and retained original as untrusted tool output. Summaries
can omit detail; use exact retrieval when correctness depends on original bytes.

`token_miser_read` accepts these modes:

| Mode            | Request                                     | Returned view                                             |
| --------------- | ------------------------------------------- | --------------------------------------------------------- |
| `full`          | `id`, optional `offsetBytes` and `maxBytes` | Base64 byte page of exact original text-content JSON      |
| `head` / `tail` | `id`, optional `limit`                      | First or last numbered lines                              |
| `lines`         | `id`, optional `startLine`, `endLine`       | Numbered line range                                       |
| `search`        | `id`, `query`, optional `limit`             | Matching numbered lines                                   |
| `batch`         | `ids`                                       | Bounded byte pages of up to 16 originals                  |
| `group`         | `id`, optional `offsetBytes` and `maxBytes` | Exact original page with grouped member IDs when captured |

For example, inside Code Mode:

```javascript
const page = await tools.token_miser_read({ id: originalId, mode: "full", maxBytes: 4096 });
text(page);
```

Full retrieval returns `format: "text-content-json-v1"`, `encoding: "base64"`,
`offsetBytes`, `totalBytes`, `data`, and `nextOffsetBytes` when more remains.
Decode each page's `data` to bytes and concatenate the byte pages in offset
order. Decode UTF-8 and parse JSON after all bytes are present; individual pages
can split a Unicode character. The resulting array contains the original
`{ type: "text", text: "..." }` blocks in their original order, including escapes
and lone-surrogate representations in JSON.

Line and search views are bounded convenience views, not a replacement for full
byte retrieval. Follow `nextLine` when present. Smaller `limit` or `maxBytes`
values keep a read within the response budget.

`token_miser_focus({ id, question })` invokes the helper model against an at most
8,192-byte prefix of the original's serialized `text-content-json-v1` data and
returns a bounded answer. The excerpt starts at byte offset zero; an incomplete
terminal UTF-8 character is omitted. The excerpt can contain incomplete JSON
and is presented as a serialized prefix rather than parsed content. The answer
reports the total original bytes and the actual decoded byte coverage; it can
report that the excerpt is insufficient and cannot assume unseen output.
It can incur provider charges. It does not rerun the original tool; use
`token_miser_read` for exact output without an additional model call.

## Runtime coverage

OpenClaw applies Token Miser at the shared tool-result boundary where it owns
model-visible output. This includes OpenClaw's embedded runtime, its dynamic
tools exposed to Codex App Server, and Agents API-owned tool responses.

The official Codex App Server owns its native execution, continuation, and
compaction. A native observation relay or transcript mirror cannot prove that
Codex's model received a replacement. Token Miser does not assume support for
custom PwrAgent Codex initialization or replacement protocols. See the
[Codex harness ownership guide](/plugins/codex-harness).

Completed text results with a captured current task are eligible. Missing task intent passes through before a helper call. Mixed media, incomplete capture, active
execution or wait status, ephemeral/incognito runs, and Token Miser's own tools
are passed through. Deterministic policy preserves outputs that carry required
instructions, patches, or retrieval/discovery contracts. Helper errors, invalid
decisions, oversized summaries, storage failures, capacity exhaustion, and
failed replacement acceptance preserve the ordinary result and its failure
semantics.

## Storage and lifetime

Originals and acceptance markers use the existing plugin-scoped SQLite blob and
keyed stores. Originals are immutable and scoped to the exact agent, session
key, and session ID. A reset creates a new session incarnation and prevents the
new conversation from retrieving the previous conversation's IDs.

The reference is accepted only after the model-facing replacement has been
selected. Rejected replacements discard their staged originals. Accepted
originals survive process restart until expiry. Storage rejects new entries at
capacity rather than evicting an accepted original early. Disabling the plugin
stops helper work and retrieval; expiry remains enforced when storage is read.

Expiry is an immutable logical deadline advertised in the reference. The
worker's physical TTL sweep can lag behind that deadline. Staged or orphaned
entries consume capacity until owned cleanup or expiry; storage then fails open
for new results. The existing snapshot owner excludes TTL original blobs from
backups; small acceptance markers may remain, but cannot retrieve an excluded
original. Each namespace admits at most 1,000 entries, including grouped members.

A crash after an acceptance marker is stored but before the model-facing result
is published can leave an orphan marker and original until expiry. No provider
publication acknowledgment or transaction spanning the two stores and model
delivery is claimed. A restarted store can admit that marker if its ID is known;
runtime decision counters do not reconstruct publication history.

| Setting           |     Default | Purpose                                                   |
| ----------------- | ----------: | --------------------------------------------------------- |
| `thresholdBytes`  |       8,192 | Minimum original UTF-8 text-content JSON size to evaluate |
| `maxSummaryBytes` |       4,000 | Summary and reference delivery limit                      |
| `timeoutMs`       |      55,000 | Helper evaluation timeout                                 |
| `retentionHours`  |         168 | Original lifetime, at most seven days                     |
| `maxStoredBytes`  | 268,435,456 | Maximum original bytes in the plugin namespace            |

Each original is capped at 32 MiB, or the configured storage limit if smaller.
`maxSummaryBytes` must be smaller than `thresholdBytes`, which must not exceed
`maxStoredBytes`. Retrieval responses have their own bounded byte budget.

## Measurements

The Control UI's **Token Miser** session-header button opens a measurements
panel. It shows current Gateway-runtime decisions, original and delivered UTF-8
bytes, bounded retrieval response bytes, retrieval count, retained-original count, and
provider-reported helper usage. Missing helper usage or cost is **Unavailable**,
not zero. Helper cost is shown only when the provider reports it.

Retrieval counters describe completed tool reads, including reads consumed by a
Code Mode cell. They do not prove that the parent model received those bytes.

Runtime counters reset when the owning runtime ends. They do not reconstruct
history or estimate parent token savings, cache replay savings, or dollar
savings. Retained-original availability follows the durable store's separate
expiry and session-incarnation rules.

Runtime measurement counters retain at most 1,000 session scopes; admitting a new scope at that limit resets the oldest scope's counters. Accepted originals use the separate worker-backed retention owner and are unaffected. Helper prompts use the existing model-facing redaction owner; tool arguments are bounded evaluator context and are not stored with originals.
