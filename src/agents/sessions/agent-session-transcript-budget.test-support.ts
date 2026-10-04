import { vi } from "vitest";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerStore from "../../state/openclaw-agent-worker-store.js";
import { transcriptWriteBudgetEntrypoint } from "./fixtures/transcript-write-budget-entrypoint.test-support.js";
import type {
  TranscriptBudgetOperations,
  TranscriptWriteMeasurement,
} from "./fixtures/transcript-write-budget.worker.test-support.js";

/** Replace only the fixture module URL; native ownership, FIFO, and commit admission stay live. */
export function installTranscriptWriteMeasurement() {
  const original = workerStore.openOpenClawAgentSqliteWorkerStore;
  const moduleUrl = resolveRuntimeWorkerUrl(transcriptWriteBudgetEntrypoint);
  const measurements: TranscriptWriteMeasurement[] = [];
  let captured: Parameters<typeof original> | undefined;
  const intercepted: typeof original = async <Operations extends SqliteWorkerOperations>(
    options: Parameters<typeof original>[0],
    source: Parameters<typeof original>[1],
    worker: Parameters<typeof original>[2],
  ) => {
    if (!worker.moduleUrl.pathname.includes("session-manager-metadata.worker.")) {
      return original<Operations>(options, source, worker);
    }
    captured = [options, source, worker];
    const native = await original<TranscriptBudgetOperations>(options, source, {
      ...worker,
      moduleUrl,
      input: undefined,
    });
    const unwrap = (reply: TranscriptBudgetOperations["fixture.budget.execute"]["output"]) => {
      return reply.result;
    };
    return {
      close: () => native.close(),
      async execute<Key extends keyof Operations>(
        command: { type: Key; input: Operations[Key]["input"] },
        assertCurrent: () => void,
        commandOptions?: { signal?: AbortSignal },
      ): Promise<Operations[Key]["output"]> {
        if (typeof command.type !== "string") {
          throw new Error("Transcript fixture commands require string types");
        }
        const reply = await native.execute(
          { type: "fixture.budget.execute", input: { type: command.type, input: command.input } },
          assertCurrent,
          commandOptions,
        );
        // SAFETY: The fixture delegates the paired worker and leaves its production result untouched.
        return unwrap(reply) as Operations[Key]["output"];
      },
      run<T>(
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
        assertCurrent: () => void,
      ): Promise<T> {
        return native.run(
          (scope) =>
            operation({
              async execute<Key extends keyof Operations>(
                command: { type: Key; input: Operations[Key]["input"] },
                commandOptions?: { signal?: AbortSignal },
              ): Promise<Operations[Key]["output"]> {
                if (typeof command.type !== "string") {
                  throw new Error("Transcript fixture commands require string types");
                }
                const reply = await scope.execute(
                  {
                    type: "fixture.budget.execute",
                    input: { type: command.type, input: command.input },
                  },
                  commandOptions,
                );
                // SAFETY: The same paired metadata reply crosses the fixture envelope unchanged.
                return unwrap(reply) as Operations[Key]["output"];
              },
            }),
          assertCurrent,
        );
      },
    };
  };
  const spy = vi
    .spyOn(workerStore, "openOpenClawAgentSqliteWorkerStore")
    .mockImplementation(intercepted);
  const control = async <
    Key extends
      | "fixture.budget.begin"
      | "fixture.budget.end"
      | "fixture.budget.close"
      | "fixture.budget.invalidate",
  >(
    type: Key,
  ): Promise<TranscriptBudgetOperations[Key]["output"]> => {
    if (!captured) {
      throw new Error("Warm the actual transcript writer before measuring it");
    }
    const [options, source, worker] = captured;
    const native = await original<TranscriptBudgetOperations>(options, source, {
      ...worker,
      moduleUrl,
      input: undefined,
    });
    try {
      return await native.execute({ type, input: undefined }, () => undefined);
    } finally {
      await native.close();
    }
  };
  return {
    async scanControls(sql: string, sessionId: string) {
      if (!captured) {
        throw new Error("Warm the actual transcript writer before measuring it");
      }
      const [options, source, worker] = captured;
      const native = await original<TranscriptBudgetOperations>(options, source, {
        ...worker,
        moduleUrl,
        input: undefined,
      });
      try {
        return await native.execute(
          { type: "fixture.budget.scanControls", input: { sql, sessionId } },
          () => undefined,
        );
      } finally {
        await native.close();
      }
    },
    invalidateCheckpoints: () => control("fixture.budget.invalidate"),
    async begin() {
      const before = await control("fixture.budget.begin");
      measurements.length = 0;
      return before;
    },
    async end() {
      const connection = await control("fixture.budget.end");
      if (connection.measurement) {
        measurements.push(connection.measurement);
      }
      return { connection, measurements: [...measurements] };
    },
    async closeConnection() {
      await control("fixture.budget.close");
      captured = undefined;
    },
    async restore() {
      try {
        if (captured) {
          await control("fixture.budget.close");
        }
      } finally {
        spy.mockRestore();
      }
    },
  };
}
