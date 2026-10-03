import type { Static } from "typebox";
import { Type } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";

const DiagnosticsCpuProfileParamsSchema = Type.Union([
  closedObject({}),
  closedObject({
    mode: Type.Literal("hot"),
    observeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
    cpuThresholdPercent: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
  }),
]);
export type DiagnosticsCpuProfileParams = Static<typeof DiagnosticsCpuProfileParamsSchema>;
export const validateDiagnosticsCpuProfileParams = lazyCompile(DiagnosticsCpuProfileParamsSchema);

/** Integer inputs are clamped by the capture owner to safe sampling bounds. */
const DiagnosticsHeapProfileParamsSchema = closedObject({
  durationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  samplingIntervalBytes: Type.Optional(
    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  includeObjectsCollectedByMajorGC: Type.Optional(Type.Boolean()),
  includeObjectsCollectedByMinorGC: Type.Optional(Type.Boolean()),
});
export type DiagnosticsHeapProfileParams = Static<typeof DiagnosticsHeapProfileParamsSchema>;
export const validateDiagnosticsHeapProfileParams = lazyCompile(DiagnosticsHeapProfileParamsSchema);

const DiagnosticsHeapSnapshotParamsSchema = closedObject({
  reason: Type.Optional(Type.String({ maxLength: 256 })),
});
export const validateDiagnosticsHeapSnapshotParams = lazyCompile(
  DiagnosticsHeapSnapshotParamsSchema,
);
