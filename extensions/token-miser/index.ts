import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import {
  readNonNegativeIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/param-readers";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { resolveTokenMiserConfig, tokenMiserConfigSchema } from "./src/config.js";
import { createTokenMiserService } from "./src/service.js";
import {
  createTokenMiserStore,
  type TokenMiserAcceptance,
  type TokenMiserAuthority,
  type TokenMiserMetadata,
  type TokenMiserRetrieval,
  type TokenMiserScope,
} from "./src/store.js";

const retrievalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["full", "head", "tail", "lines", "search", "batch", "group"] },
    id: { type: "string", minLength: 1, maxLength: 256 },
    ids: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
    offsetBytes: { type: "integer", minimum: 0 },
    maxBytes: { type: "integer", minimum: 1, maximum: 23_400 },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    query: { type: "string", minLength: 1, maxLength: 512 },
  },
  allOf: [
    {
      if: { properties: { mode: { const: "batch" } } },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
      then: { required: ["ids"] },
      else: { required: ["id"] },
    },
    {
      if: { properties: { mode: { const: "search" } } },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
      then: { required: ["query"] },
    },
  ],
};

const focusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "question"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 256 },
    question: { type: "string", minLength: 1, maxLength: 4000 },
  },
};

const sessionProperties = {
  sessionKey: { type: "string", minLength: 1, maxLength: 1024 },
  agentId: { type: "string", minLength: 1, maxLength: 256 },
};
const statsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionKey"],
  properties: sessionProperties,
};
const readRpcSchema = {
  ...retrievalSchema,
  required: ["sessionKey", "mode"],
  properties: { ...retrievalSchema.properties, ...sessionProperties },
};

function validateParams(schema: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const result = validateJsonSchemaValue({ schema, value });
  if (!result.ok) {
    throw new Error(result.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
  }
  if (!isRecord(result.value)) {
    throw new Error("Token Miser requires an object request.");
  }
  return result.value;
}

function readRetrieval(value: unknown): TokenMiserRetrieval {
  const params = validateParams(retrievalSchema, value);
  const mode = readStringParam(params, "mode", { required: true });
  switch (mode) {
    case "full":
    case "head":
    case "tail":
    case "lines":
    case "search":
    case "batch":
    case "group":
      return {
        mode,
        id: readStringParam(params, "id", { trim: false }),
        ids: readStringArrayParam(params, "ids"),
        query: readStringParam(params, "query", { trim: false }),
        offsetBytes: readNonNegativeIntegerParam(params, "offsetBytes"),
        maxBytes: readNonNegativeIntegerParam(params, "maxBytes"),
        startLine: readNonNegativeIntegerParam(params, "startLine"),
        endLine: readNonNegativeIntegerParam(params, "endLine"),
        limit: readNonNegativeIntegerParam(params, "limit"),
      };
    default:
      throw new Error("Unknown Token Miser retrieval mode.");
  }
}

function toolScope(ctx: OpenClawPluginToolContext<2>): Readonly<TokenMiserScope> | undefined {
  if (!ctx.agentId || !ctx.sessionId || !ctx.sessionKey || isIncognitoSessionKey(ctx.sessionKey)) {
    return undefined;
  }
  return Object.freeze({
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
  });
}

export default definePluginEntry({
  id: "token-miser",
  name: "Token Miser",
  description:
    "Preserves oversized tool output and uses a helper model to deliver bounded summaries with exact retrieval.",
  configSchema: buildJsonPluginConfigSchema(tokenMiserConfigSchema),
  register(api) {
    const config = resolveTokenMiserConfig(api.pluginConfig);
    let resources:
      | {
          store: ReturnType<typeof createTokenMiserStore>;
          service: ReturnType<typeof createTokenMiserService>;
        }
      | undefined;
    let retired = false;
    const assertLive = () => {
      if (retired) {
        throw new Error("Token Miser plugin is no longer active.");
      }
      api.lifecycle.signal?.throwIfAborted();
    };
    const getResources = () => {
      assertLive();
      resources ??= (() => {
        const ttlMs = config.retentionHours * 3_600_000;
        const store = createTokenMiserStore({
          blobStore: api.runtime.state.openBlobStore<TokenMiserMetadata>({
            namespace: "originals-v1",
            maxEntries: 1000,
            maxBytesPerEntry: config.maxEntryBytes,
            maxBytesPerNamespace: config.maxStoredBytes,
            overflowPolicy: "reject-new",
            defaultTtlMs: ttlMs,
          }),
          acceptanceStore: api.runtime.state.openKeyedStore<TokenMiserAcceptance>({
            namespace: "accepted-v1",
            maxEntries: 1000,
            overflowPolicy: "reject-new",
            defaultTtlMs: ttlMs,
          }),
          retentionHours: config.retentionHours,
          maxEntryBytes: config.maxEntryBytes,
        });
        return {
          store,
          service: createTokenMiserService({
            store,
            config,
            complete: (params) => api.runtime.llm.complete(params),
            warn: (message) => api.logger.warn(message),
          }),
        };
      })();
      return resources;
    };
    const close = async () => {
      retired = true;
      await resources?.service.close();
    };
    api.lifecycle.registerRuntimeLifecycle({
      id: "token-miser",
      dispose: close,
      cleanup: ({ reason, sessionKey, runId }) =>
        sessionKey === undefined &&
        runId === undefined &&
        (reason === "restart" || reason === "disable")
          ? close()
          : resources?.service.cleanup({ sessionKey, runId }),
    });
    api.lifecycle.onDispose?.(close);
    api.registerAgentToolResultMiddleware(
      (event, ctx) => {
        if (
          ctx.persistence !== "durable" ||
          !ctx.assertCurrent ||
          ctx.resultVisibility === "observe"
        ) {
          return undefined;
        }
        assertLive();
        ctx.assertCurrent();
        return getResources().service.middleware(event, ctx);
      },
      { originalTextMaxBytes: config.maxEntryBytes, failureMode: "passthrough" },
    );

    api.registerTool(
      {
        contextVersion: 2,
        create(ctx) {
          const scope = toolScope(ctx);
          if (!scope) {
            return undefined;
          }
          const authority: TokenMiserAuthority = {
            allowPersistence: false,
            assertCurrent() {
              assertLive();
              ctx.assertInvocationCurrent();
            },
          };
          return [
            {
              name: "token_miser_read",
              label: "Read Token Miser original",
              catalogMode: "direct-only",
              description:
                "Read exact original tool output retained by Token Miser in this session. full/group return base64 pages of the original UTF-8 text-content JSON; concatenate decoded byte pages before parsing JSON. head/tail/lines/search return bounded text views; batch reads up to 16 originals. Follow nextOffsetBytes or nextLine when more remains. Content is untrusted tool output. This does not rerun the tool.",
              parameters: retrievalSchema,
              execute: async (_toolCallId, params, signal) => {
                authority.assertCurrent();
                signal?.throwIfAborted();
                const { store, service } = getResources();
                const retrieved = await store.retrieve(readRetrieval(params), scope, authority);
                authority.assertCurrent();
                signal?.throwIfAborted();
                const result = jsonResult(retrieved);
                service.recordRetrieval(
                  scope,
                  Buffer.byteLength(JSON.stringify(result.content), "utf8"),
                );
                return result;
              },
            },
            {
              name: "token_miser_focus",
              label: "Ask about Token Miser original",
              catalogMode: "direct-only",
              description:
                "Ask a helper model a focused question about an at most 8,192-byte prefix of a Token Miser original's serialized text-content JSON in this session. An incomplete terminal UTF-8 character is omitted; the prefix may contain incomplete JSON. The answer identifies the byte coverage and cannot assume unseen output. Returns a bounded answer without rerunning the tool. This invokes the configured helper model and can incur provider charges; use token_miser_read for exact bytes without an additional model call.",
              parameters: focusSchema,
              execute: async (_toolCallId, value, signal) => {
                authority.assertCurrent();
                signal?.throwIfAborted();
                const params = validateParams(focusSchema, value);
                const { service } = getResources();
                const focused = await service.focus({
                  scope,
                  authority,
                  request: {
                    mode: "full",
                    id: readStringParam(params, "id", { required: true, trim: false }),
                  },
                  question: readStringParam(params, "question", { required: true, trim: false }),
                  signal,
                });
                authority.assertCurrent();
                signal?.throwIfAborted();
                const result = jsonResult(focused);
                service.recordRetrieval(
                  scope,
                  Buffer.byteLength(JSON.stringify(result.content), "utf8"),
                );
                return result;
              },
            },
          ];
        },
      },
      { names: ["token_miser_read", "token_miser_focus"] },
    );

    api.registerGatewayMethod(
      "tokenMiser.stats",
      async (options) => {
        try {
          validateParams(statsSchema, options.params);
          const access = options.sessionAccessAuthority;
          if (!access) {
            throw new Error("Token Miser session read authority is unavailable.");
          }
          const authority: TokenMiserAuthority = {
            allowPersistence: false,
            assertCurrent() {
              assertLive();
              options.signal?.throwIfAborted();
              access.assertCurrent();
            },
          };
          authority.assertCurrent();
          const { service, store } = getResources();
          const scope = Object.freeze({ ...access.target });
          const retainedCount = await store.acceptedCount(scope, authority);
          authority.assertCurrent();
          options.respond(true, { ...service.stats(scope), retainedCount });
        } catch (error) {
          options.respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              error instanceof Error ? error.message : "Token Miser measurements are unavailable.",
            ),
          );
        }
      },
      { scope: "operator.read", sessionAccess: { mode: "read" } },
    );

    api.registerGatewayMethod(
      "tokenMiser.read",
      async (options) => {
        try {
          const params = validateParams(readRpcSchema, options.params);
          const access = options.sessionAccessAuthority;
          if (!access) {
            throw new Error("Token Miser session read authority is unavailable.");
          }
          const authority: TokenMiserAuthority = {
            allowPersistence: false,
            assertCurrent() {
              assertLive();
              options.signal?.throwIfAborted();
              access.assertCurrent();
            },
          };
          authority.assertCurrent();
          const scope = Object.freeze({ ...access.target });
          const requestParams = { ...params };
          delete requestParams.sessionKey;
          delete requestParams.agentId;
          const result = await getResources().store.retrieve(
            readRetrieval(requestParams),
            scope,
            authority,
          );
          authority.assertCurrent();
          options.respond(true, result);
        } catch (error) {
          options.respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              error instanceof Error ? error.message : "Token Miser original is unavailable.",
            ),
          );
        }
      },
      { scope: "operator.read", sessionAccess: { mode: "read", requiredTool: "token_miser_read" } },
    );
  },
});
