import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { z } from "zod";
import type { ApiQuotaError } from "../../src/infra/http-api-quota.js";
import {
  createGitHubAsyncCommandQuota,
  isGitHubCommandQuotaError,
} from "./github-command-quota.mjs";
import { execGhRead } from "./plain-gh.mjs";

export type WatcherJsonReader = (
  args: string[],
  deadline: number,
  fresh?: boolean,
) => Promise<unknown>;

export class WatcherQuotaError extends Error {
  readonly primaryResource: "core" | "graphql" | undefined;
  constructor(quota: ApiQuotaError) {
    super(quota.message, { cause: quota });
    this.primaryResource =
      quota.resource === "core" || quota.resource === "graphql" ? quota.resource : undefined;
  }
}

const PrMetadataSchema = z.object({
  state: z.string().optional(),
  merged_at: z.string().nullish(),
  mergeable: z.unknown().optional(),
  head: z.object({ sha: z.string().optional() }).optional(),
});
const PrGraphqlMetadataSchema = z.object({
  state: z.string().optional(),
  mergeable: z.union([z.boolean(), z.string()]).optional(),
  headRefOid: z.string().optional(),
});

export function createWatcherGitHubReads(repository: string) {
  let deadline = 0;
  let fresh = false;
  let graphqlMetadata = false;
  let command: ReturnType<typeof createGitHubAsyncCommandQuota> | undefined;
  const remainingMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("watcher evidence deadline elapsed");
    }
    return remaining;
  };
  const readOptions = (): ExecFileSyncOptionsWithStringEncoding => ({
    encoding: "utf8" as const,
    timeout: Math.min(60_000, remainingMs()),
    stdio: [
      "ignore",
      "pipe",
      "pipe",
      ...(process.env.OPENCLAW_PR_LOCK_NOTIFY_FD === "3" ? [3] : []),
    ],
    env: { ...process.env, ...(fresh ? { OCTOPOOL_FRESH: "1" } : {}) },
  });
  const initialize = () => {
    // The browser launcher resolves gh's host locally; --no-browser adds an HTTP HEAD.
    const address = execGhRead(["browse", "--repo", repository], {
      ...readOptions(),
      env: {
        ...process.env,
        GH_BROWSER: `'${process.execPath.replaceAll("'", "'\\''")}' -p 'process.argv[1]'`,
      },
    }).trim();
    const hostname = new URL(address).host;
    return createGitHubAsyncCommandQuota({
      hostname,
      remainingMs,
      runGhAsync: async (args: string[]) => {
        // Preserve the existing PATH reader and inherited native supervisor pipe.
        return execGhRead(
          args[0] === "api" ? [...args, "--hostname", hostname] : args,
          readOptions(),
        );
      },
    });
  };
  const readJson: WatcherJsonReader = async (args, readDeadline, revalidate = false) => {
    deadline = readDeadline;
    fresh = revalidate;
    command ??= initialize();
    try {
      const result = await (await command)(args);
      if (result.error) {
        throw result.error;
      }
      return JSON.parse(result.body);
    } catch (error) {
      if (isGitHubCommandQuotaError(error)) {
        throw new WatcherQuotaError(error);
      }
      throw error;
    }
  };
  const readPr = async (pr: number, readDeadline: number) => {
    if (!graphqlMetadata) {
      try {
        const record = PrMetadataSchema.parse(
          await readJson(
            ["api", `repos/${repository}/pulls/${pr}`, "-H", "Cache-Control: max-age=0"],
            readDeadline,
          ),
        );
        return {
          state: record.merged_at ? "MERGED" : record.state?.toUpperCase(),
          mergeable:
            record.mergeable === true
              ? "MERGEABLE"
              : record.mergeable === false
                ? "CONFLICTING"
                : "UNKNOWN",
          headRefOid: record.head?.sha,
        };
      } catch (error) {
        if (!(error instanceof WatcherQuotaError) || error.primaryResource !== "core") {
          throw error;
        }
        graphqlMetadata = true;
      }
    }
    const [owner, name] = repository.split("/");
    const response = z
      .object({
        errors: z.never().nullish(),
        data: z.object({ repository: z.object({ pullRequest: PrGraphqlMetadataSchema }) }),
      })
      .parse(
        await readJson(
          [
            "api",
            "graphql",
            "-f",
            "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state mergeable headRefOid}}}",
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${pr}`,
            "-H",
            "Cache-Control: max-age=0",
          ],
          readDeadline,
        ),
      );
    return response.data.repository.pullRequest;
  };
  return { readJson, readPr };
}
