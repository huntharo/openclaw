import { loadQaRunnerChannelApi } from "openclaw/plugin-sdk/qa-runner-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const { requestDiscord: requestDiscordLive } =
  loadQaRunnerChannelApi<typeof import("@openclaw/discord/api.js")>("discord");

const DISCORD_PUBLIC_API_BASE = "https://discord.com/api/v10";

type DiscordQaRequestInit = RequestInit & { duplex?: "half" };

function requestInitFromDiscordQaRequest(request: Request): DiscordQaRequestInit {
  return {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: request.body, duplex: "half" as const } : {}),
    signal: request.signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  };
}

function createDiscordQaEndpointFetcher(apiBaseUrl: string): typeof fetch {
  const base = new URL(apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`);
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(`${DISCORD_PUBLIC_API_BASE}/`)) {
      throw new Error(`Discord QA request escaped the expected API base: ${request.url}`);
    }
    const suffix = request.url.slice(`${DISCORD_PUBLIC_API_BASE}/`.length);
    const target = new URL(suffix, base);
    const guarded = await fetchWithSsrFGuard({
      url: target.toString(),
      init: requestInitFromDiscordQaRequest(request),
      signal: request.signal,
      policy: { allowPrivateNetwork: true, allowedOrigins: [base.origin] },
      maxRedirects: 0,
      auditContext: "qa-lab-discord-endpoint",
    });
    try {
      const status = guarded.response.status;
      const bodyAllowed =
        request.method !== "HEAD" &&
        guarded.response.body !== null &&
        status !== 204 &&
        status !== 205 &&
        status !== 304;
      const body = bodyAllowed ? await guarded.response.arrayBuffer() : null;
      return new Response(body && body.byteLength > 0 ? body : null, {
        status,
        statusText: guarded.response.statusText,
        headers: guarded.response.headers,
      });
    } finally {
      await guarded.release();
    }
  };
}

const discordQaApiBaseByToken = new Map<string, string>();

type DiscordQaRequestOptions = NonNullable<Parameters<typeof requestDiscordLive>[2]>;

export async function requestDiscord<T>(
  requestPath: string,
  token: string,
  options?: DiscordQaRequestOptions,
): Promise<T> {
  const apiBaseUrl = discordQaApiBaseByToken.get(token);
  return await requestDiscordLive<T>(requestPath, token, {
    timeoutMs: 15_000,
    ...options,
    ...(apiBaseUrl
      ? { endpointRuntime: null, fetcher: createDiscordQaEndpointFetcher(apiBaseUrl) }
      : {}),
  });
}

export function registerDiscordQaApiBase(params: {
  apiBaseUrl: string;
  tokens: readonly string[];
}): () => void {
  const normalized = new URL(params.apiBaseUrl).toString().replace(/\/$/u, "");
  for (const token of params.tokens) {
    discordQaApiBaseByToken.set(token, normalized);
  }
  return () => {
    for (const token of params.tokens) {
      if (discordQaApiBaseByToken.get(token) === normalized) {
        discordQaApiBaseByToken.delete(token);
      }
    }
  };
}

export async function withRegisteredDiscordQaApiBase<T>(
  token: string,
  run: () => Promise<T>,
): Promise<T> {
  const apiBaseUrl = discordQaApiBaseByToken.get(token);
  if (!apiBaseUrl) {
    return await run();
  }
  const previous = process.env.DISCORD_API_URL;
  process.env.DISCORD_API_URL = apiBaseUrl;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.DISCORD_API_URL;
    } else {
      process.env.DISCORD_API_URL = previous;
    }
  }
}
