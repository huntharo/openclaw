export const tokenMiserConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    helperModel: { type: "string", minLength: 1, maxLength: 256 },
    thresholdBytes: { type: "integer", minimum: 1024, maximum: 1_048_576, default: 8192 },
    maxSummaryBytes: { type: "integer", minimum: 512, maximum: 16_000, default: 4000 },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 55_000, default: 55_000 },
    retentionHours: { type: "integer", minimum: 1, maximum: 168, default: 168 },
    maxStoredBytes: {
      type: "integer",
      minimum: 1_048_576,
      maximum: 268_435_456,
      default: 268_435_456,
    },
  },
};

export function resolveTokenMiserConfig(input: Record<string, unknown> = {}) {
  const integer = (key: keyof typeof tokenMiserConfigSchema.properties): number => {
    const schema = tokenMiserConfigSchema.properties[key];
    if (!("default" in schema)) {
      throw new Error(`Token Miser ${key} is not a numeric setting.`);
    }
    const value = input[key] ?? schema.default;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < schema.minimum ||
      value > schema.maximum
    ) {
      throw new Error(`Token Miser ${key} must be ${schema.minimum}–${schema.maximum}.`);
    }
    return value;
  };
  const helperModel = input.helperModel;
  if (
    helperModel !== undefined &&
    (typeof helperModel !== "string" || !helperModel.trim() || helperModel.length > 256)
  ) {
    throw new Error("Token Miser helperModel must be a nonempty model reference.");
  }
  const thresholdBytes = integer("thresholdBytes");
  const maxSummaryBytes = integer("maxSummaryBytes");
  const maxStoredBytes = integer("maxStoredBytes");
  if (maxSummaryBytes >= thresholdBytes || thresholdBytes > maxStoredBytes) {
    throw new Error("Token Miser requires maxSummaryBytes < thresholdBytes <= maxStoredBytes.");
  }
  return {
    helperModel,
    thresholdBytes,
    maxSummaryBytes,
    maxStoredBytes,
    timeoutMs: integer("timeoutMs"),
    retentionHours: integer("retentionHours"),
    maxEntryBytes: Math.min(32 * 1024 * 1024, maxStoredBytes),
  };
}

export type TokenMiserConfig = ReturnType<typeof resolveTokenMiserConfig>;
