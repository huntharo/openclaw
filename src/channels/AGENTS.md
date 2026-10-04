# Channels Boundary

`src/channels/**` is core channel implementation. Plugin authors should not
import from this tree directly.

## Public Contracts

- Docs:
  - `docs/plugins/sdk-channel-plugins.md`
  - `docs/plugins/architecture.md`
  - `docs/plugins/sdk-overview.md`
- Definition files:
  - `src/channels/plugins/types.plugin.ts`
  - `src/channels/plugins/types.core.ts`
  - `src/channels/plugins/types.adapters.ts`
  - `src/plugin-sdk/core.ts`
  - `src/plugin-sdk/channel-contract.ts`

## Boundary Rules

- Keep extension-facing channel surfaces flowing through `openclaw/plugin-sdk/*`
  instead of direct imports from `src/channels/**`.
- When a bundled or third-party channel needs a new seam, add a typed SDK
  contract or facade first.
- Treat channel entrypoints such as `channel.ts`, `shared.ts`,
  `channel.setup.ts`, `gateway.ts`, and `outbound.ts` as hot import paths. Do
  not statically pull async-only surfaces like send, monitor, probe,
  directory-live, setup/login flows, or large `runtime-api.ts` barrels into
  those files unless startup truly needs them.
- Prefer a small local seam such as `channel-api.ts`, `*.runtime.ts`, or
  `*.runtime-api.ts` to keep heavy runtime code off the hot path.
- Core discovery consumes admitted manifest/artifact metadata; runtime lookups
  consume already-registered scoped or root channel contracts. Missing runtime
  registrations return no plugin and never materialize a bundled provider.
  Deliberate setup and configured activation use their existing admission owners.
- Tests that need runtime callbacks register their channel fixtures in the same
  lifecycle scope as the caller; do not add an implicit bundled loading fallback.
- Put target parsing, thread-binding hints, native command descriptors, message
  tool descriptors, gateway auth bypass paths, and setup-promotion hints in
  small plugin-owned helpers reused by both the full channel plugin and any
  lightweight artifact.
- If a helper is called repeatedly by tests, install/reset the test plugin
  registry in the same lifecycle scope as the runtime reset. A `beforeAll`
  registry with `afterEach` runtime reset leaves later tests without their
  admitted channel registrations.
- Do not mix static and dynamic imports for the same heavy module family across
  a channel boundary change. If the path should stay lazy, keep it lazy end to
  end.
- Remember that shared channel changes affect both built-in and extension
  channels. Check routing, pairing, allowlists, command gating, onboarding, and
  reply behavior across the full set.

## Verification

- If you touch hot channel entrypoints or lazy-loading seams, run `pnpm build`.
- For bundled plugin channel changes that can affect startup/import cost, run:
  `OPENCLAW_LOCAL_CHECK=0 node --import tsx scripts/profile-extension-memory.mts --extension <id> --skip-combined --concurrency 1`
