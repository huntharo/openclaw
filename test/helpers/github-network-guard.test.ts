import { execFileSync, execSync, fork, spawnSync } from "node:child_process";
import dns from "node:dns";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv, withEnv } from "../../src/test-utils/env.js";
import { installSharedTestSetup } from "../setup.shared.js";
import { requireNodeTool } from "./node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const node = requireNodeTool("node");
const forbidden = "GitHub network access is forbidden in ordinary tests";

function localGitSsh(directory: string, source: string, service = "upload-pack") {
  const ssh = join(directory, "ssh.mjs");
  writeFileSync(
    ssh,
    `#!${node}\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync("git", [${JSON.stringify(service)}, ${JSON.stringify(source)}], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
  );
  chmodSync(ssh, 0o755);
  return { ...process.env, GIT_SSH: ssh, GIT_SSH_VARIANT: "simple" };
}

function commitGitFixture(directory: string, text: string) {
  writeFileSync(join(directory, "README"), text);
  execFileSync("git", ["-C", directory, "add", "README"]);
  execFileSync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  return execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

describe("ordinary tests cannot reach GitHub", () => {
  it.each([false, true])(
    "retains the real-home network barrier with profile loading %s",
    (loadProfileEnv) => {
      installSharedTestSetup().cleanup();
      const caller = captureFullEnv();
      const home = tempDirs.make("github-real-home-policy-");
      writeFileSync(join(home, ".profile"), "export LIVE=1\n");
      const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
        throw new Error("unexpected DNS dispatch");
      });
      try {
        withEnv(
          {
            HOME: home,
            USERPROFILE: home,
            LIVE: undefined,
            OPENCLAW_LIVE_TEST: undefined,
            OPENCLAW_LIVE_GATEWAY: undefined,
            OPENCLAW_LIVE_USE_REAL_HOME: "1",
          },
          () => {
            const setup = installSharedTestSetup({ loadProfileEnv });
            try {
              expect(() => get("https://api.github.com/")).toThrow(forbidden);
              expect(lookup).not.toHaveBeenCalled();
            } finally {
              setup.cleanup();
            }
          },
        );
      } finally {
        lookup.mockRestore();
        caller.restore();
        installSharedTestSetup();
      }
    },
  );

  it.each(["api.github.com", "github.com", "tenant.ghe.com"])(
    "blocks HTTP and socket access to %s before dispatch",
    async (host) => {
      await expect(fetch(`https://${host}/`)).rejects.toThrow(forbidden);
      const socket = new Socket();
      try {
        expect(() => socket.connect({ host, port: 443 })).toThrow(forbidden);
      } finally {
        socket.destroy();
      }
    },
  );

  it("blocks native HTTPS before DNS, including normalized Socket.connect arguments", () => {
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
      throw new Error("unexpected DNS dispatch");
    });
    try {
      expect(() => get("https://api.github.com/")).toThrow(forbidden);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("resolves a physical child preload when the UI runtime supplies HTTP module metadata", () => {
    const directory = tempDirs.make("github-ui-module-guard-");
    const script = join(directory, "ui-guard.mjs");
    const source = readFileSync(new URL("./github-network-guard.mjs", import.meta.url), "utf8")
      .replaceAll(
        "import.meta.url",
        JSON.stringify("http://localhost:3000/test/helpers/github-network-guard.mjs"),
      )
      .replaceAll("import.meta.filename", "undefined");
    writeFileSync(script, source);
    const result = spawnSync(
      node,
      [
        "--input-type=module",
        "-e",
        `
      import { spawnSync } from "node:child_process";
      globalThis[Symbol.for("openclaw.test.githubNetworkGuard")]?.();
      const guard = await import(${JSON.stringify(pathToFileURL(script).href)});
      guard.installGitHubNetworkGuard();
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", 'import dns from "node:dns"; dns.lookup = () => { throw new Error("unexpected DNS dispatch"); }; await fetch("https://api.github.com/");'], { env: {}, encoding: "utf8" });
      process.stdout.write(child.stderr);
      process.exitCode = child.status === 1 ? 0 : 2;
    `,
      ],
      {
        cwd: fileURLToPath(new URL("../../ui/", import.meta.url)),
        env: {},
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(forbidden);
  });

  it.each(["api.github.com", "ghe.example.test"])(
    "keeps the guard for %s in a Node grandchild with a replaced environment",
    (host) => {
      vi.stubEnv("GH_HOST", "ghe.example.test");
      try {
        const probe = `import dns from "node:dns"; dns.lookup = () => { throw new Error("unexpected DNS dispatch"); }; await fetch("https://${host}/");`;
        const result = spawnSync(
          node,
          [
            "--input-type=module",
            "-e",
            `
      import { spawnSync } from "node:child_process";
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(probe)}], { env: {}, encoding: "utf8" });
      process.stdout.write(child.stderr);
      process.exitCode = child.status === 1 ? 0 : 2;
    `,
          ],
          { env: {}, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(forbidden);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps the guard in forked Node modules selected by URL", async () => {
    const directory = tempDirs.make("github-fork-guard-");
    const script = join(directory, "probe.mjs");
    writeFileSync(
      script,
      'import dns from "node:dns"; dns.lookup = () => { throw new Error("unexpected DNS dispatch"); }; await fetch("https://api.github.com/");',
    );
    const child = fork(pathToFileURL(script), [], {
      execPath: node,
      execArgv: [],
      env: {},
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, "close");
    expect(code).toBe(1);
    expect(stderr).toContain(forbidden);
  });

  it("allows local Git metadata containing a GitHub remote URL", () => {
    const directory = tempDirs.make("github-git-metadata-");
    execFileSync("git", ["init", "-q", directory]);
    const remote = "https://github.com/example/repo.git";
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: directory });
    expect(
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: directory,
        encoding: "utf8",
      }).trim(),
    ).toBe(remote);
    execFileSync("git", ["config", "fixture.operation", "fetch"], { cwd: directory });
    expect(
      execFileSync("git", ["config", "fixture.operation"], {
        cwd: directory,
        encoding: "utf8",
      }).trim(),
    ).toBe("fetch");
  });

  it.each([["fetch", "origin"], ["fetch"], ["remote", "update"]])(
    "blocks configured GitHub remotes for git %s",
    (...args) => {
      const directory = tempDirs.make("github-git-remote-guard-");
      const source = join(directory, "source.git");
      const checkout = join(directory, "checkout");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", checkout]);
      const remote = "https://github.com/example/repo.git";
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
      // The baseline reaches only this local repository, even without the guard.
      execFileSync("git", ["config", `url.${source}.insteadOf`, remote], { cwd: checkout });
      expect(() => execFileSync("git", args, { cwd: checkout })).toThrow(forbidden);
      execFileSync("git", ["config", "--unset", `url.${source}.insteadOf`], { cwd: checkout });
      execFileSync("git", ["remote", "set-url", "origin", source], { cwd: checkout });
      expect(spawnSync("git", args, { cwd: checkout }).status).toBe(0);
    },
  );

  it("allows an explicitly nonrecursive local push while blocking recursion and GitHub destinations", () => {
    const directory = tempDirs.make("github-local-push-guard-");
    const source = join(directory, "source.git");
    const checkout = join(directory, "checkout");
    execFileSync("git", ["init", "--bare", "-q", source]);
    execFileSync("git", ["init", "-q", checkout]);
    const sha = commitGitFixture(checkout, "synthetic local push\n");
    const push = ["push", "--recurse-submodules=no", source, "HEAD:refs/heads/main"];
    expect(spawnSync("git", push, { cwd: checkout }).status).toBe(0);
    expect(
      execFileSync("git", ["-C", source, "rev-parse", "refs/heads/main"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(sha);
    expect(() =>
      execFileSync(
        "git",
        ["push", "--recurse-submodules=on-demand", source, "HEAD:refs/heads/main"],
        { cwd: checkout },
      ),
    ).toThrow(forbidden);
    const remote = "https://github.com/example/repo.git";
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
    // Even without admission this destination resolves only to the local bare fixture.
    execFileSync("git", ["config", `url.${source}.insteadOf`, remote], { cwd: checkout });
    expect(() =>
      execFileSync("git", ["push", "--recurse-submodules=no", "origin", "HEAD:refs/heads/main"], {
        cwd: checkout,
      }),
    ).toThrow(forbidden);
  });

  it("blocks Git remote creation that immediately fetches", () => {
    const directory = tempDirs.make("github-git-remote-create-");
    const source = join(directory, "source.git");
    execFileSync("git", ["init", "--bare", "-q", source]);
    execFileSync("git", ["init", "-q", directory]);
    const remote = "https://github.com/example/repo.git";
    execFileSync("git", ["config", `url.${source}.insteadOf`, remote], { cwd: directory });
    expect(() =>
      execFileSync("git", ["remote", "add", "-f", "origin", remote], { cwd: directory }),
    ).toThrow(forbidden);
    execFileSync("git", ["config", "--unset", `url.${source}.insteadOf`], { cwd: directory });
    expect(
      spawnSync("git", ["remote", "add", "-f", "origin", source], { cwd: directory }).status,
    ).toBe(0);
  });

  it
    .skipIf(process.platform === "win32")
    .each(["github.com:example/repo.git", "fixture@github.com:example/repo.git"])(
    "blocks SCP-style Git destinations %s",
    (remote) => {
      const directory = tempDirs.make("github-scp-git-guard-");
      const source = join(directory, "source.git");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", directory]);
      // The baseline SSH request is served locally and never opens a socket.
      expect(() =>
        execFileSync("git", ["ls-remote", remote], {
          cwd: directory,
          env: localGitSsh(directory, source),
        }),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32")(
    "checks URL rewrite bases without a trailing slash",
    () => {
      const directory = tempDirs.make("github-rewrite-base-guard-");
      const source = join(directory, "source.git");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", directory]);
      execFileSync("git", ["config", "url.ssh://github.com.insteadOf", "fixture:"], {
        cwd: directory,
      });
      expect(() =>
        execFileSync("git", ["ls-remote", "fixture:/example/repo.git"], {
          cwd: directory,
          env: localGitSsh(directory, source),
        }),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32").each(["fetch-pack", "send-pack"])(
    "blocks native Git transport plumbing %s",
    (operation) => {
      const directory = tempDirs.make("github-git-plumbing-guard-");
      const source = join(directory, "source.git");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", directory]);
      expect(() =>
        execFileSync("git", [operation, "--all", "git@github.com:example/repo.git"], {
          cwd: directory,
          env: localGitSsh(
            directory,
            source,
            operation === "send-pack" ? "receive-pack" : "upload-pack",
          ),
        }),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32").each(["quoted directory", "changed directory"])(
    "blocks shell Git network operations with a %s",
    (mode) => {
      const directory = tempDirs.make("github-shell-git-guard-");
      const source = join(directory, "source.git");
      const checkout = join(directory, "checkout repo");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", directory]);
      execFileSync("git", ["init", "-q", checkout]);
      const remote = "https://github.com/example/repo.git";
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
      execFileSync("git", ["config", `url.${source}.insteadOf`, remote], { cwd: checkout });
      const quoted = `'${checkout.replaceAll("'", "'\\''")}'`;
      const prefix = mode === "quoted directory" ? `git -C ${quoted}` : `cd ${quoted} && git`;
      expect(() => execSync(`${prefix} fetch origin`, { cwd: directory })).toThrow(forbidden);
      expect(
        execSync(`${prefix} rev-parse --git-dir`, { cwd: directory, encoding: "utf8" }).trim(),
      ).toBe(".git");
    },
  );

  it.each(["--recurse-submodules", "--recurse-submodules=component", "--recurse-submodules=no"])(
    "rejects recursive clone admission with %s",
    (option) => {
      const directory = tempDirs.make("github-recursive-clone-guard-");
      const source = join(directory, "source.git");
      execFileSync("git", ["init", "--bare", "-q", source]);
      // This source is empty and local, so the pre-fix probe cannot contact GitHub.
      expect(() =>
        execFileSync("git", ["clone", option, source, join(directory, "checkout")], {
          cwd: directory,
        }),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32").each(["tenant.ghe.com", "ghe.example.test"])(
    "blocks native HTTP to Enterprise host %s",
    (host) => {
      const directory = tempDirs.make("github-enterprise-http-guard-");
      symlinkSync("/usr/bin/true", join(directory, "curl"));
      const env = { PATH: directory, GH_HOST: "ghe.example.test" };
      expect(() => execFileSync("curl", [`https://${host}/`], { env })).toThrow(forbidden);
      expect(() => execSync(`curl https://${host}/`, { env })).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains the parent's Enterprise host when native HTTP replaces its environment",
    () => {
      const directory = tempDirs.make("github-enterprise-parent-guard-");
      symlinkSync("/usr/bin/true", join(directory, "curl"));
      vi.stubEnv("GH_HOST", "ghe.example.test");
      try {
        expect(() =>
          execFileSync("curl", ["https://ghe.example.test/"], { env: { PATH: directory } }),
        ).toThrow(forbidden);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.skipIf(process.platform !== "win32")("blocks cmd.exe environment URLs", () => {
    const directory = tempDirs.make("github-cmd-http-guard-");
    const curl = join(directory, "curl.cmd");
    writeFileSync(curl, "@exit /b 0\r\n");
    expect(() =>
      execSync(`"${curl}" "%target_url%"`, {
        env: { Path: directory, TARGET_URL: "https://api.github.com/" },
      }),
    ).toThrow(forbidden);
    expect(() =>
      execFileSync("powershell.exe", ["-Command", "Invoke-WebRequest $env:TARGET_URL"], {
        env: { Path: directory, TARGET_URL: "https://api.github.com/" },
      }),
    ).toThrow(forbidden);
  });

  it.skipIf(process.platform !== "win32")("preserves a Windows Path override", () => {
    const directory = tempDirs.make("github-windows-path-guard-");
    writeFileSync(join(directory, "fixture-command.cmd"), "@echo synthetic response\r\n");
    expect(execSync("fixture-command", { env: { Path: directory }, encoding: "utf8" }).trim()).toBe(
      "synthetic response",
    );
  });

  it.skipIf(process.platform !== "win32")("checks forward-slash relative native gh paths", () => {
    const directory = tempDirs.make("github-windows-relative-guard-");
    copyFileSync(node, join(directory, "gh.exe"));
    // This native alias only prints Node's version if admission is missing.
    expect(() =>
      spawnSync("./gh.exe", ["--version"], { cwd: directory, env: { Path: "" } }),
    ).toThrow(forbidden);
  });

  it.skipIf(process.platform !== "win32")("checks the inherited Windows PATH with env={}", () => {
    const directory = tempDirs.make("github-windows-inherited-guard-");
    copyFileSync(node, join(directory, "gh.exe"));
    vi.stubEnv("PATH", directory);
    try {
      expect(() => spawnSync("gh", ["--version"], { env: {} })).toThrow(forbidden);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === "win32")(
    "permits unrelated shell commands with an inherited native CLI override",
    () => {
      const env = { OPENCLAW_GH_BIN: node };
      expect(execSync("printf ok", { env, encoding: "utf8" })).toBe("ok");
      expect(() => execSync('"$OPENCLAW_GH_BIN" --version', { env })).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a native gh executable and shell PATH fallback",
    () => {
      const directory = tempDirs.make("github-native-guard-");
      const gh = join(directory, "gh");
      symlinkSync(node, gh);
      expect(() => execFileSync(gh, ["--version"])).toThrow(forbidden);
      expect(() =>
        spawnSync("/bin/sh", ["-c", "gh --version"], { env: { PATH: directory } }),
      ).toThrow(forbidden);
      expect(() => spawnSync("/bin/sh", ["-c", "gh --version"], { env: { PATH: "" } })).toThrow(
        forbidden,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "checks expanded and suffixed shell gh executables",
    () => {
      const directory = tempDirs.make("github-shell-executable-guard-");
      const gh = join(directory, "gh");
      symlinkSync(node, gh);
      symlinkSync(node, join(directory, "gh.exe"));
      // These native aliases only print Node's version if the guard is missing.
      expect(() => execSync('"$GH_BIN" --version', { env: { GH_BIN: gh } })).toThrow(forbidden);
      expect(() => execSync("gh.exe --version", { env: { PATH: directory } })).toThrow(forbidden);
      expect(() =>
        execSync('"$GH_DIR"/"$GH_NAME" --version', {
          env: { GH_DIR: directory, GH_NAME: "gh" },
        }),
      ).toThrow(forbidden);
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["uninitialized update", "populated update", "populated fetch"])(
    "blocks GitHub submodules during %s",
    (mode) => {
      const directory = tempDirs.make("github-submodule-guard-");
      const source = join(directory, "source");
      const checkout = join(directory, "checkout");
      execFileSync("git", ["init", "-q", source]);
      execFileSync("git", ["init", "-q", checkout]);
      const sha = commitGitFixture(source, "synthetic fixture\n");
      const populated = mode.startsWith("populated");
      writeFileSync(
        join(checkout, ".gitmodules"),
        `[submodule "component"]\npath = component\nurl = ${populated ? source : "git@github.com:example/repo.git"}\n`,
      );
      if (populated) {
        const component = join(checkout, "component");
        const modules = join(checkout, ".git", "modules");
        mkdirSync(modules, { recursive: true });
        execFileSync("git", [
          "init",
          "-q",
          "--separate-git-dir",
          join(modules, "component"),
          component,
        ]);
        execFileSync("git", [
          "-C",
          component,
          "remote",
          "add",
          "origin",
          "git@github.com:example/repo.git",
        ]);
        commitGitFixture(component, "initial component fixture\n");
      }
      execFileSync("git", ["-C", checkout, "add", ".gitmodules"]);
      execFileSync("git", [
        "-C",
        checkout,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${sha},component`,
      ]);
      // The pre-fix clone is served locally; this SSH fixture never opens a socket.
      expect(() =>
        execFileSync(
          "git",
          mode.endsWith("fetch") ? ["fetch", source] : ["submodule", "update", "--init"],
          {
            cwd: checkout,
            env: localGitSsh(directory, source),
          },
        ),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32")(
    "blocks shell HTTP calls before dispatch, including environment URLs",
    () => {
      const directory = tempDirs.make("github-shell-http-guard-");
      // The pre-fix probe is harmless: this native alias only exits successfully.
      symlinkSync("/usr/bin/true", join(directory, "curl"));
      const env = { PATH: directory, TARGET_URL: "https://api.github.com/" };
      expect(() => execSync('curl "$TARGET_URL"', { env })).toThrow(forbidden);
      expect(() =>
        execFileSync("/bin/sh", ["-c", "curl https://api.github.com/"], { env }),
      ).toThrow(forbidden);
      expect(() => spawnSync("curl https://api.github.com/", [], { env, shell: true })).toThrow(
        forbidden,
      );
    },
  );

  it.skipIf(process.platform === "win32")("blocks schemeless native HTTP URLs", () => {
    const directory = tempDirs.make("github-schemeless-http-guard-");
    symlinkSync("/usr/bin/true", join(directory, "curl"));
    const env = { PATH: directory };
    const destination = "api.github.com/repos/example/repo";
    expect(() => execFileSync("curl", [destination], { env })).toThrow(forbidden);
    expect(() => execFileSync("curl", [`--url=${destination}`], { env })).toThrow(forbidden);
    expect(() => execSync(`curl ${destination}`, { env })).toThrow(forbidden);
  });

  it("preserves third-position subprocess options when arguments are omitted", () => {
    const directory = tempDirs.make("github-subprocess-options-");
    const script = join(directory, "probe.mjs");
    writeFileSync(
      script,
      "console.log(JSON.stringify({ cwd: process.cwd(), value: process.env.FIXTURE_VALUE }));",
    );
    const options = {
      cwd: pathToFileURL(directory),
      env: {
        FIXTURE_VALUE: "synthetic value",
        NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(script).href)}`,
      },
      encoding: "utf8" as const,
    };
    const expected = { cwd: directory, value: "synthetic value" };
    const child = spawnSync(node, undefined, options);
    expect(child.status, child.stderr.toString()).toBe(0);
    expect(typeof child.stdout).toBe("string");
    expect(JSON.parse(child.stdout.toString())).toEqual(expected);
    const output = execFileSync(node, undefined, options);
    expect(typeof output).toBe("string");
    expect(JSON.parse(output.toString())).toEqual(expected);
  });

  it.skipIf(process.platform === "win32")(
    "preserves system command lookup when PATH is omitted",
    () => {
      const result = spawnSync("true", [], { env: {} });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "runs the temporary gh fixture instead of a real CLI",
    () => {
      const directory = tempDirs.make("github-fixture-guard-");
      const gh = join(directory, "gh");
      writeFileSync(gh, `#!${node}\nprocess.stdout.write('synthetic response');\n`);
      chmodSync(gh, 0o755);
      expect(execFileSync(gh, ["api", "repos/example/repo"], { encoding: "utf8" })).toBe(
        "synthetic response",
      );
    },
  );

  it.skipIf(process.platform === "win32").each(["./gh", "gh"])(
    "resolves %s with URL-valued cwd and relative PATH",
    (command) => {
      const directory = tempDirs.make("github-cwd-url-guard-");
      const gh = join(directory, "gh");
      writeFileSync(gh, `#!${node}\nprocess.stdout.write('synthetic response');\n`);
      chmodSync(gh, 0o755);
      expect(
        execFileSync(command, ["api", "repos/example/repo"], {
          cwd: pathToFileURL(directory),
          env: { PATH: "." },
          encoding: "utf8",
        }),
      ).toBe("synthetic response");
    },
  );
});
