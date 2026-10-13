import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { getSharedApiQuota } from "../infra/http-api-quota.js";
import type { BufferedCommandResult } from "../process/exec.js";
import { runCommandBuffered } from "../process/exec.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";

// mock-isolation: Exercise publication admission without launching Git or gh processes.
vi.mock("../process/exec.js", () => ({ runCommandBuffered: vi.fn() }));

function response(body: string, headers = "", code = 0): BufferedCommandResult {
  return {
    stdout: Buffer.from(
      `HTTP/2.0 ${code ? "429 Too Many Requests" : "200 OK"}\r\n${headers}\r\n${body}`,
    ),
    stderr: Buffer.alloc(0),
    code,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearRuntimeConfigSnapshot();
  vi.mocked(runCommandBuffered).mockReset();
});

describe("GitHub publication API transport", () => {
  it("isolates native gh profiles and pins their resolved credentials at dispatch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const command = vi.mocked(runCommandBuffered).mockImplementation(async (argv, options) => {
      const profile = options?.env?.GH_CONFIG_DIR;
      const token = `synthetic-native-publication-${profile}`;
      if (argv[1] === "auth") {
        return { ...response(""), stdout: Buffer.from(token + "\n") };
      }
      return response(JSON.stringify({ profile }));
    });
    const args = githubPublicationApiArgs("repos/owner/repo/pulls/1");
    const results = await Promise.all(
      ["first", "second"].map((profile) =>
        runPublicationCommand(args, { env: { GH_CONFIG_DIR: profile } }),
      ),
    );
    expect(results.map((result) => JSON.parse(result.stdout.toString()))).toEqual([
      { profile: "first" },
      { profile: "second" },
    ]);
    const apiCalls = command.mock.calls.filter(([argv]) => argv[1] === "api");
    expect(apiCalls).toHaveLength(2);
    for (const [, options] of apiCalls) {
      expect(options?.env?.GH_TOKEN).toBe(
        `synthetic-native-publication-${options?.env?.GH_CONFIG_DIR}`,
      );
    }
    expect(command.mock.calls.filter(([argv]) => argv[1] === "auth")).toEqual([
      [
        ["gh", "auth", "token", "--hostname", "github.com"],
        expect.objectContaining({ env: expect.objectContaining({ GH_CONFIG_DIR: "first" }) }),
      ],
      [
        ["gh", "auth", "token", "--hostname", "github.com"],
        expect.objectContaining({ env: expect.objectContaining({ GH_CONFIG_DIR: "second" }) }),
      ],
    ]);
  });

  it("refuses API dispatch when the native gh credential cannot be resolved", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const command = vi.mocked(runCommandBuffered).mockResolvedValue({
      ...response("", "", 1),
      stdout: Buffer.alloc(0),
    });
    await expect(
      runPublicationCommand(githubPublicationApiArgs("repos/owner/repo/pulls/1"), {
        env: { GH_CONFIG_DIR: "synthetic-missing-native-profile" },
      }),
    ).rejects.toThrow("GitHub CLI authentication is unavailable");
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[0]).toEqual(["gh", "auth", "token", "--hostname", "github.com"]);
  });

  it("keeps a shared GET alive when its first caller retires before dispatch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const command = vi.mocked(runCommandBuffered).mockResolvedValue(response('{"number":1}'));
    const args = githubPublicationApiArgs("repos/owner/repo/pulls/1");
    const env = { GH_TOKEN: "synthetic-publication-surviving-reader" };
    let firstCurrent = true;
    let checks = 0;
    const first = runPublicationCommand(args, {
      env,
      beforeRun: () => {
        if (!firstCurrent) {
          throw new Error("First reader retired");
        }
      },
    });
    const second = runPublicationCommand(args, {
      env,
      beforeRun: () => {
        if (++checks === 3) {
          firstCurrent = false;
        }
      },
    });
    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: new Error("First reader retired"),
    });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { code: 0 } });
    expect(command).toHaveBeenCalledOnce();
  });
  it("shares ghe.com cloud admission with the token gh actually uses", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const host = "tenant.ghe.com";
    const apiBaseUrl = `https://api.${host}`;
    setRuntimeConfigSnapshot({ gateway: { github: { host, apiBaseUrl } } });
    const token = "synthetic-cloud-publication";
    getSharedApiQuota({ apiBaseUrl, token }).observe(
      new Response(null, { status: 429, headers: { "Retry-After": "90" } }),
    );
    const command = vi.mocked(runCommandBuffered).mockResolvedValue(response("{}"));
    await expect(
      runPublicationCommand(githubPublicationApiArgs("repos/owner/repo", "GET", host), {
        env: { GH_TOKEN: token, GH_ENTERPRISE_TOKEN: "synthetic-other-enterprise" },
      }),
    ).rejects.toMatchObject({ reason: "upstream" });
    expect(command).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "preserves a failed command receipt and honors Retry-After with colored headers=%s",
    async (colored) => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn());
      const headers = colored
        ? "\u001b[36mRetry-After\u001b[0m: \u001b[32m90\u001b[0m\r\n"
        : "Retry-After: 90\r\n";
      const body = colored
        ? '\u001b[33m{"message":"secondary rate limit"}\u001b[0m'
        : '{"message":"secondary rate limit"}';
      const command = vi
        .mocked(runCommandBuffered)
        .mockResolvedValueOnce(response(body, headers, 1))
        .mockResolvedValue(response('{"sha":"accepted"}'));
      const args = githubPublicationApiArgs("repos/owner/repo/git/refs", "POST");
      const options = {
        env: { GH_TOKEN: `synthetic-publication-cooldown-${colored}` },
        input: "{}",
      };
      const failed = await runPublicationCommand(args, options);
      expect(failed.code).toBe(1);
      await expect(runPublicationCommand(args, options)).rejects.toMatchObject({
        reason: "upstream",
      });
      expect(command).toHaveBeenCalledOnce();
      expect(failed.stdout.toString()).toBe(body);
      await vi.advanceTimersByTimeAsync(90_000);
      expect((await runPublicationCommand(args, options)).stdout.toString()).toBe(
        '{"sha":"accepted"}',
      );
      expect(command).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["github.com", "ghe.example.test"])(
    "admits each %s pagination request and retains filtered page output",
    async (host) => {
      vi.stubGlobal("fetch", vi.fn());
      setRuntimeConfigSnapshot({
        gateway: {
          github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
        },
      });
      const apiBaseUrl =
        host === "github.com" ? "https://api.github.com" : "https://ghe.example.test/api/v3";
      const next = `${apiBaseUrl}/repos/owner/repo/pulls?per_page=100&page=2`;
      const command = vi
        .mocked(runCommandBuffered)
        .mockResolvedValueOnce(
          response(
            '[{"number":1}]\n',
            `X-RateLimit-Remaining: 1\r\nX-RateLimit-Reset: ${Math.ceil(Date.now() / 1_000) + 90}\r\nLink: <${next}>; rel="next"\r\n`,
          ),
        )
        .mockResolvedValueOnce(response('[{"number":2}]\n'));
      const result = await runPublicationCommand(
        [
          ...githubPublicationApiArgs("repos/owner/repo/pulls", "GET", host),
          "-f",
          "head=owner:topic",
          "--paginate",
          "--jq",
          "map({number}) | tojson",
        ],
        {
          env: {
            GH_TOKEN: "synthetic-publication-pages",
            GH_ENTERPRISE_TOKEN: "synthetic-enterprise-pages",
          },
        },
      );
      expect(result.stdout.toString()).toBe('[{"number":1}]\n[{"number":2}]\n');
      expect(command).toHaveBeenCalledTimes(2);
      expect(
        command.mock.calls.every(
          ([argv]) => argv.includes("--include") && !argv.includes("--paginate"),
        ),
      ).toBe(true);
      expect(command.mock.calls[1]?.[0]).toContain(next);
      expect(command.mock.calls[1]?.[0]).not.toContain("head=owner:topic");
    },
  );

  it("stops pagination when a successful page exhausts primary quota", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const command = vi
      .mocked(runCommandBuffered)
      .mockResolvedValue(
        response(
          "[]\n",
          'X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1800000090\r\nLink: <https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next"\r\n',
        ),
      );
    await expect(
      runPublicationCommand([...githubPublicationApiArgs("repos/owner/repo/pulls"), "--paginate"], {
        env: { GH_TOKEN: "synthetic-publication-primary" },
      }),
    ).rejects.toMatchObject({ reason: "upstream", retryAtMs: 1_800_000_090_000 });
    expect(command).toHaveBeenCalledOnce();
  });

  it("bounds page dispatches and admission waits to one publication deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    const start = 1_800_000_000_000;
    vi.setSystemTime(start);
    const token = "synthetic-publication-deadline";
    const quota = getSharedApiQuota({ apiBaseUrl: "https://api.github.com", token });
    const next = (page: number) =>
      `Link: <https://api.github.com/repos/owner/repo/pulls?page=${page}>; rel="next"\r\n`;
    const command = vi
      .mocked(runCommandBuffered)
      .mockImplementationOnce(async () => {
        vi.setSystemTime(start + 25_000);
        return response("[]\n", next(2));
      })
      .mockImplementationOnce(async () => {
        vi.setSystemTime(start + 59_500);
        // Other callers can use the same credential while a page is in flight.
        for (let count = 0; count < 20; count += 1) {
          quota.admit()();
        }
        return response("[]\n", next(3));
      });
    const pending = runPublicationCommand(
      [...githubPublicationApiArgs("repos/owner/repo/pulls"), "--paginate"],
      { env: { GH_TOKEN: token } },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(command.mock.calls.map(([, options]) => options?.timeoutMs)).toEqual([60_000, 35_000]);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ message: "GitHub publication API command timed out" });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("revalidates publication authority after waiting for admission", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    const command = vi.mocked(runCommandBuffered).mockResolvedValue(response("{}"));
    const args = githubPublicationApiArgs("repos/owner/repo");
    let current = true;
    const options = {
      env: { GH_TOKEN: "synthetic-publication-admission" },
      beforeRun: () => {
        if (!current) {
          throw new Error("Publication authority changed");
        }
      },
    };
    for (let count = 0; count < 20; count += 1) {
      await runPublicationCommand(args, options);
    }
    const pending = runPublicationCommand(args, options);
    const rejected = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(command).toHaveBeenCalledTimes(20);
    current = false;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await rejected).toMatchObject({ message: "Publication authority changed" });
    expect(command).toHaveBeenCalledTimes(20);
  });
});
