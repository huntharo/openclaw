import { createHash } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { expect, it } from "vitest";
import {
  expectSqliteQueryScans,
  type SqliteWriteBudget,
} from "../../../test/helpers/sqlite-write-budget.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { AssistantMessageEvent } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { installTranscriptWriteMeasurement } from "./agent-session-transcript-budget.test-support.js";
import type { ToolDefinition } from "./extensions/types.js";
import type { TranscriptWriteMeasurement } from "./fixtures/transcript-write-budget.worker.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

function fixtureText(bytes: number): string {
  // Stable varied bytes exercise payload storage instead of compressing to one repeated run.
  const digest = createHash("shake256", { outputLength: bytes })
    .update("openclaw-transcript-write-budget")
    .digest();
  return Buffer.from(
    digest.map((value, index) => (index % 9 === 8 ? 32 : 97 + (value % 26))),
  ).toString("ascii");
}

const scenarios = [
  { name: "history-0", history: 0 },
  { name: "history-32", history: 32 },
  { name: "history-128", history: 128 },
  { name: "turns-4", turns: 4 },
  { name: "turns-16", turns: 16 },
  { name: "chunks-1", chunks: 1 },
  { name: "chunks-16", chunks: 16 },
  { name: "chunks-64", chunks: 64 },
  { name: "tool-chunks-1", toolChunks: 1 },
  { name: "tool-chunks-16", toolChunks: 16 },
  { name: "tool-chunks-64", toolChunks: 64 },
  { name: "tool-bytes-4k", toolChunks: 8, toolBytes: 4096 },
  { name: "tool-bytes-256k", toolChunks: 8, toolBytes: 262144 },
];

type ObservedPlan = TranscriptWriteMeasurement["plans"][number][1];

function justifyFixtureScans(sql: string, plan: ObservedPlan, sessionId: string) {
  const identity = createHash("sha256").update(sql).digest("hex");
  const scans = plan.raw.filter(
    (detail) => /^SCAN /i.test(detail) && detail !== "SCAN CONSTANT ROW",
  );
  if (scans.length === 0) {
    return [];
  }
  // Exact generated statements from the pinned owners. These are synthetic
  // fixture qualifications, not global exemptions for aliases or JSON scans.
  if (identity === "bb87e113c3b69f2d341517718cbe6e9e3b5a271ae967c05ed7d6c3560d775233") {
    // transcript-payload.ts readNavigation: two bound JSON values, one input row.
    expect(plan.persistentCursors).toBe(0);
    expect(plan.raw).toContain("SCAN CONSTANT ROW");
    expect(plan.fullTableScans).toEqual(["SCAN input", "SCAN metadata"]);
    return scans.map((detail) => ({
      sql,
      detail,
      reason: "readNavigation's single bound row projects the admitted fixture JSON shape",
    }));
  }
  const tails: Record<string, string[]> = {
    // session-accessor.sqlite-transcript-parent.ts readActiveTranscriptAppendParentId.
    "6fb745425ed0f024d44217cab90a644e95d1361785d4589d8c424e0265ed5b73": [
      "SEARCH ti USING INDEX idx_agent_transcript_event_identity_sequence (session_id=?)",
      "SEARCH te USING INDEX sqlite_autoindex_transcript_events_1 (session_id=? AND seq=?)",
    ],
    // Same owner: readTranscriptVisibleTailEntryIdInTransaction's admitted active path.
    e19c79178af9bf272ee46873ed7be1e9727ca71118a514ea422e276017495b10: [
      "SEARCH active USING INDEX sqlite_autoindex_session_transcript_active_events_1 (session_id=?)",
      "SEARCH event USING INDEX sqlite_autoindex_transcript_events_1 (session_id=? AND seq=?)",
    ],
  };
  const searches = tails[identity];
  expect(searches, "Changed owner query needs new unchanged-main scan evidence").toBeDefined();
  expect(plan.raw).toEqual([
    ...searches!,
    "CORRELATED SCALAR SUBQUERY 1",
    "SCAN json_each VIRTUAL TABLE INDEX 1:",
  ]);
  expect(plan.persistentCursors).toBe(4);
  expect(plan.expandedSqlStable).toBe(true);
  const literals = [
    "$.navigation",
    "type",
    "id",
    "parentId",
    "targetId",
    "appendParentId",
    "appendMode",
    sessionId,
  ].map((value) => `'${value.replaceAll("'", "''")}'`);
  literals.push("1.0");
  let binding = 0;
  expect(plan.expandedSql).toBe(sql.replaceAll("?", () => literals[binding++]!));
  return scans.map((detail) => ({
    sql,
    detail,
    reason:
      "Indexed ordered tail lookup projects one admitted <=6-member JSON object; json_each preserves native member types",
  }));
}

function fixtureJsonShape(values: readonly unknown[]) {
  let maxRootMembers = 0;
  let maxBytes = 0;
  let maxObjectMembers = 0;
  let maxArrayElements = 0;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      maxArrayElements = Math.max(maxArrayElements, value.length);
      for (const member of value) {
        visit(member);
      }
    } else if (value && typeof value === "object") {
      maxObjectMembers = Math.max(maxObjectMembers, Object.keys(value).length);
      for (const member of Object.values(value)) {
        visit(member);
      }
    }
  };
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Fixture JSON input must be an object");
    }
    maxRootMembers = Math.max(maxRootMembers, Object.keys(value).length);
    maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(value)));
    visit(value);
  }
  expect(maxRootMembers).toBeLessThanOrEqual(6);
  expect(maxBytes).toBeLessThanOrEqual(300000);
  expect(maxObjectMembers).toBeLessThanOrEqual(16);
  expect(maxArrayElements).toBeLessThanOrEqual(1);
  return { rows: values.length, maxRootMembers, maxBytes, maxObjectMembers, maxArrayElements };
}

it("measures fake streamed requests through the real AgentSession transcript writer", async () => {
  await withOpenClawTestState({ label: "transcript-write-campaign" }, async (state) => {
    const observer = installTranscriptWriteMeasurement();
    try {
      for (const fixture of scenarios) {
        const scenario = {
          history: 0,
          turns: 1,
          chunks: 8,
          replyBytes: 8192,
          toolChunks: 0,
          toolBytes: 65536,
          ...fixture,
        };
        const target = {
          agentId: scenario.name,
          sessionId: scenario.name,
          sessionKey: `agent:${scenario.name}:${scenario.name}`,
          storePath: path.join(state.agentDir(scenario.name), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const manager = SessionManager.open(target, state.workspaceDir);
        for (let index = 0; index < scenario.history; index += 1) {
          await manager.appendMessageAsync(
            index % 2 === 0
              ? { role: "user", content: `history-${index}`, timestamp: index + 1 }
              : createAssistant(testModel, [{ type: "text", text: `history-${index}` }]),
          );
        }
        let streaming = false;
        let modelRequests = 0;
        let deliveredChunks = 0;
        let toolUpdates = 0;
        const reply = fixtureText(scenario.replyBytes);
        const toolOutput = fixtureText(scenario.toolBytes);
        const tool: ToolDefinition = {
          name: "budget_emit",
          label: "Emit fixture output",
          description: "Returns deterministic synthetic output with streaming updates.",
          parameters: Type.Object({}),
          async execute(_id, _params, _signal, onUpdate) {
            for (let chunk = 1; chunk <= scenario.toolChunks; chunk += 1) {
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: toolOutput.slice(
                      0,
                      Math.ceil((toolOutput.length * chunk) / scenario.toolChunks),
                    ),
                  },
                ],
                details: {},
              });
              await Promise.resolve();
            }
            return { content: [{ type: "text", text: toolOutput }], details: {} };
          },
        };
        streamMocks.streamSimple.mockImplementation((model) => {
          if (!streaming) {
            return createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "warm" }]),
            );
          }
          modelRequests += 1;
          const callsTool = scenario.toolChunks > 0 && modelRequests % 2 === 1;
          const message = createAssistant(
            model,
            callsTool
              ? [{ type: "toolCall", id: `call-${modelRequests}`, name: tool.name, arguments: {} }]
              : [{ type: "text", text: reply }],
            callsTool ? "toolUse" : "stop",
          );
          const stream = createAssistantMessageEventStream();
          const events: AssistantMessageEvent[] = [];
          {
            events.push({ type: "start", partial: { ...message, content: [] } });
            if (callsTool) {
              events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              events.push({
                type: "toolcall_delta",
                contentIndex: 0,
                delta: "{}",
                partial: message,
              });
              const call = message.content[0];
              if (call?.type !== "toolCall") {
                throw new Error("Missing fixture tool call");
              }
              events.push({
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: call,
                partial: message,
              });
            } else {
              events.push({
                type: "text_start",
                contentIndex: 0,
                partial: { ...message, content: [{ type: "text", text: "" }] },
              });
              for (let chunk = 0; chunk < scenario.chunks; chunk += 1) {
                events.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: reply.slice(
                    Math.floor((reply.length * chunk) / scenario.chunks),
                    Math.floor((reply.length * (chunk + 1)) / scenario.chunks),
                  ),
                });
              }
              events.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
            }
            events.push({ type: "done", reason: callsTool ? "toolUse" : "stop", message });
          }
          const iterate = stream[Symbol.asyncIterator].bind(stream);
          // Feed each native queue only as the consumer asks; unread bursts coalesce.
          stream[Symbol.asyncIterator] = async function* () {
            const iterator = iterate();
            try {
              for (const event of events) {
                stream.push(event);
                const next = await iterator.next();
                if (next.done) {
                  throw new Error("Fixture stream ended before its terminal event");
                }
                yield next.value;
              }
            } finally {
              stream.end();
              await iterator.return?.();
            }
          };
          return stream;
        });
        const { session } = await createTestSession({
          sessionManager: manager,
          customTools: scenario.toolChunks ? [tool] : [],
        });
        try {
          await session.prompt("warmup");
          const seededEntries = manager.getPersistedEntries().length;
          const unsubscribe = session.subscribe((event) => {
            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_delta"
            ) {
              deliveredChunks += 1;
            }
            if (event.type === "tool_execution_update") {
              toolUpdates += 1;
            }
            if (event.type === "message_end" && event.message.role === "user") {
              // User publication follows persistence; assistant/tool listeners precede it.
              expect(manager.getLeafEntry()?.type).toBe("message");
              expect(manager.getLeafEntry()).toMatchObject({
                message: { role: event.message.role },
              });
            }
          });
          const connection = await observer.begin();
          streaming = true;
          try {
            for (let turn = 0; turn < scenario.turns; turn += 1) {
              await session.prompt(`request-${turn}`);
              expect(manager.getLeafEntry()).toMatchObject({
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: reply }] },
              });
            }
          } finally {
            unsubscribe();
          }
          const measured = await observer.end();
          expect(measured.connection.autoCheckpoint).toBe(connection.autoCheckpoint);
          expect(connection.workerThreadId).toBeGreaterThan(0);
          expect(measured.measurements.length).toBeGreaterThan(0);
          expect(
            measured.measurements.every(
              (part) => part.workerThreadId === connection.workerThreadId,
            ),
          ).toBe(true);
          expect(measured.measurements).toHaveLength(1);
          const measurement = measured.measurements[0];
          if (!measurement) {
            throw new Error("Missing transcript window measurement");
          }
          const { reads, statements } = measurement;
          const writes: SqliteWriteBudget = measurement.writes;
          const plans = new Map(measurement.plans);
          const durable = loadTranscriptEventsSync(target);
          expect(durable).toEqual(manager.getPersistedEntries());
          // This campaign only appends durable events. Thus the post-window shape
          // diagnostic covers every navigation input selected during the window,
          // including event_json fallback and seeded rows.
          expect(
            statements.some(({ sql }) =>
              /^(?:update|delete)\b[\s\S]*"transcript_events"/i.test(sql),
            ),
          ).toBe(false);
          const inputShape = fixtureJsonShape(durable);
          expect(measurement.navigationShape.rows).toBe(durable.length);
          expect(measurement.navigationShape.maxRootMembers).toBeLessThanOrEqual(6);
          expect(measurement.navigationShape.maxBytes).toBeLessThanOrEqual(1024);
          const justifiedScans = [...plans].flatMap(([sql, plan]) =>
            justifyFixtureScans(sql, plan, target.sessionId),
          );
          expectSqliteQueryScans(plans, justifiedScans);
          if (scenario.name === "history-0") {
            const tailSql = [...plans.keys()].find(
              (sql) =>
                createHash("sha256").update(sql).digest("hex") ===
                "6fb745425ed0f024d44217cab90a644e95d1361785d4589d8c424e0265ed5b73",
            );
            expect(tailSql).toBeDefined();
            const controls = await observer.scanControls(tailSql!, target.sessionId);
            expect(controls).toHaveLength(2);
            for (const [sql, plan] of controls) {
              expect(plan.raw).toContain("SCAN json_each VIRTUAL TABLE INDEX 1:");
              expect(() => justifyFixtureScans(sql, plan, target.sessionId)).toThrow();
            }
            expect(() =>
              fixtureJsonShape([{ type: "message", a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }]),
            ).toThrow();
          }
          expect(modelRequests).toBe(scenario.turns * (scenario.toolChunks ? 2 : 1));
          expect(writes.commits).toBe(scenario.turns * (scenario.toolChunks ? 4 : 2));
          expect(writes.writeStatements).toBeLessThanOrEqual(
            scenario.turns * (scenario.toolChunks ? 32 : 18),
          );
          // FTS segment merges legitimately add changes without extra executed statements.
          expect(writes.rowsChanged).toBeLessThanOrEqual(scenario.turns * 64);
          expect(reads.rows).toBeLessThanOrEqual(scenario.turns * (scenario.toolChunks ? 128 : 64));
          expect(reads.textBytes + reads.blobBytes).toBeLessThanOrEqual(
            scenario.turns * (scenario.toolChunks ? 16384 : 8192),
          );
          expect(deliveredChunks).toBe(scenario.turns * scenario.chunks);
          expect(toolUpdates).toBe(scenario.turns * scenario.toolChunks);
          expect(manager.getPersistedEntries().length - seededEntries).toBe(
            scenario.turns * (scenario.toolChunks ? 4 : 2),
          );
          expect(session.messages.at(-1)).toMatchObject({
            content: [{ type: "text", text: reply }],
          });
          if (scenario.toolChunks) {
            expect(
              session.messages.findLast((message) => message.role === "toolResult"),
            ).toMatchObject({ content: [{ type: "text", text: toolOutput }] });
          }
          console.log(
            JSON.stringify({
              scenario: scenario.name,
              historyEvents: scenario.history + 2,
              turns: scenario.turns,
              responseChunks: scenario.chunks,
              replyBytes: scenario.replyBytes,
              toolChunks: scenario.toolChunks,
              toolBytes: scenario.toolChunks ? scenario.toolBytes : 0,
              modelRequests,
              deliveredChunks,
              toolUpdates,
              ...writes,
              reads,
              backendRowsChanged: measured.measurements.reduce(
                (sum, part) => sum + part.backendRowsChanged,
                0,
              ),
              writeSql: statements.filter(({ sql }) => /^(?:insert|update|delete)\b/i.test(sql)),
              inputShape,
              navigationShape: measurement.navigationShape,
              scans: [...plans].flatMap(([sql, plan]) =>
                plan.raw
                  .filter((detail) => /^SCAN /i.test(detail))
                  .map((detail) => ({
                    sql,
                    detail,
                    persistentCursors: plan.persistentCursors,
                    inputRows: 1,
                    raw: plan.raw,
                    reason:
                      justifiedScans.find((scan) => scan.sql === sql && scan.detail === detail)
                        ?.reason ?? "Single constant input row",
                  })),
              ),
            }),
          );
          if (scenario.name === "tool-bytes-4k") {
            const failureWindow = await observer.begin();
            await observer.invalidateCheckpoints();
            await expect(observer.end()).rejects.toThrow("Disable automatic WAL checkpoints");
            const restored = await observer.end();
            expect(restored.connection.autoCheckpoint).toBe(failureWindow.autoCheckpoint);
            await observer.begin();
            await session.prompt("recovered fixture");
            const recovered = await observer.end();
            expect(recovered.measurements[0]?.writes.commits).toBe(4);
            expect(manager.getLeafEntry()).toMatchObject({
              message: { role: "assistant", content: [{ type: "text", text: reply }] },
            });
          }
        } finally {
          streaming = false;
          await observer.end();
          await observer.closeConnection();
          session.dispose();
        }
      }
    } finally {
      await observer.restore();
    }
  });
});
