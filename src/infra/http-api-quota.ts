import { createHash } from "node:crypto";
import { parseStrictNonNegativeInteger } from "../../packages/normalization-core/src/number-coercion.js";
import { asOptionalRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { ApiResponseStore } from "./http-api-read-store.js";
import { readResponseWithLimit } from "./http-response-body.js";
import { parseRetryAfterHeaderSeconds } from "./retry-after.js";
export { apiStoreRequestKey } from "./http-api-read-store.js";

const CAPACITY = 20;
const REFILL_INTERVAL_MS = 3_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_CREDENTIAL_SCOPES = 1_024;

export const ApiQuotaError = resolveGlobalSingleton(
  Symbol.for("openclaw.apiQuotaError"),
  () =>
    class extends Error {
      constructor(
        readonly reason: "admission" | "upstream",
        readonly retryAtMs: number,
        readonly upstreamStatus = 429,
        readonly resource?: string,
      ) {
        super("API request quota unavailable; wait before retrying");
        this.name = "ApiQuotaError";
      }

      get retryAfterMs(): number {
        return Math.max(0, this.retryAtMs - Date.now());
      }
    },
);
export type ApiQuotaError = InstanceType<typeof ApiQuotaError>;

export function apiRateLimitHint(message: unknown): boolean | "secondary" {
  if (typeof message !== "string") {
    return false;
  }
  return /secondary rate limit|abuse detection/i.test(message)
    ? "secondary"
    : /rate limit/i.test(message);
}

function isValidQuotaTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime());
}

/** Normalize conventional HTTP quota headers without returning upstream diagnostics. */
export function apiQuotaErrorForResponse(
  response: Response,
  rateLimited: boolean | "primary" | "secondary" = false,
): ApiQuotaError | undefined {
  if (
    !rateLimited &&
    response.status !== 429 &&
    !(
      response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))
    )
  ) {
    return undefined;
  }
  const now = Date.now();
  const retry = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"), now);
  const reset =
    response.headers.get("x-ratelimit-remaining") === "0"
      ? parseStrictNonNegativeInteger(response.headers.get("x-ratelimit-reset"))
      : undefined;
  const retryAt = retry === undefined ? 0 : now + retry * 1_000;
  const resetAt = reset === undefined ? 0 : reset * 1_000;
  const proposed = Math.max(
    isValidQuotaTimestamp(retryAt) ? retryAt : 0,
    isValidQuotaTimestamp(resetAt) ? resetAt : 0,
  );
  return new ApiQuotaError(
    "upstream",
    proposed > now ? proposed : now + DEFAULT_COOLDOWN_MS,
    response.status,
  );
}

/** One bucket admits every dispatch; primary resources and the secondary circuit share its scope. */
export class ApiRequestQuota {
  private tokens = CAPACITY;
  private refilledAt = Date.now();
  private readonly primary = new Map<string, { remaining: number; resetAt: number }>();
  private readonly pending = new Map<string, number>();
  private readonly cooldowns = new Map<string, ApiQuotaError>();
  private secondaryFailures = 0;

  canForget(): boolean {
    const now = Date.now();
    return (
      this.pending.size === 0 &&
      this.tokens + Math.max(0, now - this.refilledAt) / REFILL_INTERVAL_MS >= CAPACITY &&
      [...this.primary.values()].every((quota) => quota.resetAt <= now) &&
      [...this.cooldowns.values()].every((cooldown) => cooldown.retryAtMs <= now)
    );
  }

  admit(resource = "core"): () => void {
    const now = Date.now();
    const quota = this.primary.get(resource);
    if (quota && quota.resetAt <= now) {
      this.primary.delete(resource);
    }
    const cooldown = [this.cooldowns.get("*"), this.cooldowns.get(resource)]
      .filter((error): error is ApiQuotaError => Boolean(error && error.retryAtMs > now))
      .toSorted((a, b) => b.retryAtMs - a.retryAtMs)[0];
    if (cooldown) {
      throw cooldown;
    }
    this.tokens = Math.min(
      CAPACITY,
      this.tokens + Math.max(0, now - this.refilledAt) / REFILL_INTERVAL_MS,
    );
    this.refilledAt = now;
    const remaining = this.primary.get(resource);
    if (remaining && remaining.remaining < 1) {
      throw new ApiQuotaError("upstream", remaining.resetAt, 429, resource);
    }
    if (this.tokens < 1) {
      throw new ApiQuotaError("admission", now + Math.ceil((1 - this.tokens) * REFILL_INTERVAL_MS));
    }
    this.tokens -= 1;
    if (remaining) {
      remaining.remaining -= 1;
    }
    this.pending.set(resource, (this.pending.get(resource) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const count = (this.pending.get(resource) ?? 1) - 1;
      if (count > 0) {
        this.pending.set(resource, count);
      } else {
        this.pending.delete(resource);
      }
    };
  }

  observe(
    response: Response,
    resource = "core",
    rateLimited: boolean | "primary" | "secondary" = false,
    confirmedSuccess = true,
  ): ApiQuotaError | undefined {
    const now = Date.now();
    const key = response.headers.get("x-ratelimit-resource") ?? resource;
    const remaining = parseStrictNonNegativeInteger(response.headers.get("x-ratelimit-remaining"));
    const reset = parseStrictNonNegativeInteger(response.headers.get("x-ratelimit-reset"));
    const resetAt = reset === undefined ? 0 : reset * 1_000;
    if (remaining !== undefined && isValidQuotaTimestamp(resetAt) && resetAt > now) {
      const previous = this.primary.get(key);
      const available = Math.max(0, remaining - (this.pending.get(resource) ?? 0));
      // Out-of-order responses cannot replenish reservations in the same primary window.
      this.primary.set(key, {
        remaining:
          previous?.resetAt === resetAt ? Math.min(previous.remaining, available) : available,
        resetAt,
      });
    }
    let error = apiQuotaErrorForResponse(response, rateLimited);
    if (!error) {
      if (confirmedSuccess && response.ok && !this.cooldowns.get("*")?.retryAfterMs) {
        this.secondaryFailures = 0;
      }
      return undefined;
    }
    const cooldownKey =
      (remaining === 0 || rateLimited === "primary") &&
      response.status !== 429 &&
      rateLimited !== "secondary" &&
      !response.headers.has("retry-after")
        ? key
        : "*";
    if (cooldownKey === "*") {
      this.secondaryFailures += 1;
      if (parseRetryAfterHeaderSeconds(response.headers.get("retry-after"), now) === undefined) {
        error = new ApiQuotaError(
          "upstream",
          Math.max(
            error.retryAtMs,
            now + DEFAULT_COOLDOWN_MS * 2 ** Math.min(this.secondaryFailures - 1, 8),
          ),
          response.status,
        );
      }
    } else {
      error = new ApiQuotaError(error.reason, error.retryAtMs, error.upstreamStatus, cooldownKey);
    }
    const previous = this.cooldowns.get(cooldownKey);
    const retained = previous && previous.retryAtMs > error.retryAtMs ? previous : error;
    this.cooldowns.set(cooldownKey, retained);
    return retained;
  }
}

/** One instance owns admission and every response used to derive API projections. */
export class ApiRequestStore {
  readonly responses = new ApiResponseStore();

  constructor(private readonly quota = new ApiRequestQuota()) {}

  admit(resource?: string): () => void {
    return this.quota.admit(resource);
  }

  observe(
    response: Response,
    resource = "core",
    rateLimited: boolean | "primary" | "secondary" = false,
    confirmedSuccess = true,
  ): ApiQuotaError | undefined {
    return this.quota.observe(response, resource, rateLimited, confirmedSuccess);
  }

  async dispatch(resource: string, load: () => Promise<Response>): Promise<Response> {
    const release = this.admit(resource);
    let response: Response;
    try {
      response = await load();
    } finally {
      release();
    }
    let error = this.observe(response, resource, false, resource !== "graphql");
    if (error && error.resource === undefined) {
      void response.body?.cancel().catch(() => {});
      throw error;
    }
    if (response.status === 403 || resource === "graphql") {
      try {
        const value = asOptionalRecord(
          JSON.parse((await readResponseWithLimit(response.clone(), 256 * 1024)).toString("utf8")),
        );
        const errors = Array.isArray(value?.errors) ? value.errors : [];
        const limited =
          apiRateLimitHint(value?.message) ||
          errors
            .map((item: unknown) => {
              const candidate = asOptionalRecord(item);
              return (
                apiRateLimitHint(candidate?.message) ||
                candidate?.type === "RATE_LIMITED" ||
                candidate?.type === "RATE_LIMIT"
              );
            })
            .find(Boolean);
        if (limited && (!error || (limited === "secondary" && error.resource !== undefined))) {
          error = this.observe(response, resource, limited, false);
        }
        if (resource === "graphql" && !errors.length) {
          this.observe(response, resource);
        }
      } catch {
        // Malformed diagnostics cannot establish a body-reported limit; header facts still apply.
      }
    }
    if (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    return response;
  }
}

type CredentialScope = {
  key: string;
  scopes: Map<string, CredentialScope>;
  quota: ApiRequestQuota;
  store: WeakRef<ApiRequestStore>;
};

const shared = resolveGlobalSingleton(
  Symbol.for("openclaw.sharedHttpApiQuota"),
  () => ({
    transports: new WeakMap<object, Map<string, CredentialScope>>(),
    scopes: new Set<CredentialScope>(),
  }),
  (state) => {
    for (const scope of state.scopes) {
      scope.store.deref()?.responses.close();
    }
    state.scopes.clear();
    state.transports = new WeakMap();
  },
  "close-only",
);

/** Credential values stay out of keys and errors; injected transports represent separate API environments. */
export function getSharedApiStore(options: {
  apiBaseUrl: string;
  token?: string;
  fetchImpl?: object;
}): ApiRequestStore {
  const transport = options.fetchImpl ?? globalThis.fetch;
  const scopes = shared.transports.get(transport) ?? new Map<string, CredentialScope>();
  shared.transports.set(transport, scopes);
  const credential = options.token
    ? createHash("sha256").update(options.token).digest("hex")
    : "anonymous";
  const base = new URL(options.apiBaseUrl);
  const scope = `${base.origin}${base.pathname.replace(/\/+$/, "")}:${credential}`;
  const existing = scopes.get(scope);
  const retained = existing?.store.deref();
  if (retained) {
    return retained;
  }
  // Historical tokens must not pin response bodies. Keep their small quota state
  // until every reservation and server cooldown expires, even if the cache is collected.
  for (const candidate of shared.scopes) {
    if (candidate !== existing && !candidate.store.deref() && candidate.quota.canForget()) {
      candidate.scopes.delete(candidate.key);
      shared.scopes.delete(candidate);
    }
  }
  if (!existing && shared.scopes.size >= MAX_CREDENTIAL_SCOPES) {
    throw new ApiQuotaError("admission", Date.now() + REFILL_INTERVAL_MS);
  }
  const quota = existing?.quota ?? new ApiRequestQuota();
  const store = new ApiRequestStore(quota);
  if (existing) {
    existing.store = new WeakRef(store);
  } else {
    const entry = { key: scope, scopes, quota, store: new WeakRef(store) };
    scopes.set(scope, entry);
    shared.scopes.add(entry);
  }
  return store;
}

export const getSharedApiQuota = getSharedApiStore;
