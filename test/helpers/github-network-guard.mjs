import childProcess from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guardKey = Symbol.for("openclaw.test.githubNetworkGuard");
const preload = import.meta.url;
const marker = "OPENCLAW_TEST_GITHUB_NETWORK_GUARD";
const tempRootKey = "OPENCLAW_TEST_GITHUB_FIXTURE_ROOT";
const hostsKey = "OPENCLAW_TEST_GITHUB_HOSTS";
const fixtureRoot = process.env[tempRootKey] || tmpdir();
const inheritedHosts = (process.env[hostsKey] ?? "").split(",").filter(Boolean);
const blockedCommands = fileURLToPath(new URL("../fixtures/forbid-github/", import.meta.url));
const transportCommands = new Set([
  "gh",
  "curl",
  "wget",
  "git",
  "ssh",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
]);

function envValue(env, name) {
  const key =
    process.platform === "win32"
      ? Object.keys(env)
          .toSorted()
          .find((candidate) => candidate.toUpperCase() === name.toUpperCase())
      : name;
  return key === undefined ? undefined : env[key];
}

function configuredHosts(env) {
  return [...new Set([...inheritedHosts, envValue(env, "GH_HOST"), process.env.GH_HOST])].filter(
    Boolean,
  );
}

function forbidden() {
  throw new Error(
    "GitHub network access is forbidden in ordinary tests; use a mocked HTTP transport or a temporary gh fixture",
  );
}

function isGitHubHost(host, env = process.env) {
  const normalized = String(host ?? "")
    .toLowerCase()
    .replace(/^\[|\]$|\.$/gu, "");
  return (
    ["github.com", "githubusercontent.com", "ghe.com"].some(
      (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
    ) ||
    configuredHosts(env).some(
      (configuredHost) => normalized === configuredHost.toLowerCase().replace(/\.$/u, ""),
    )
  );
}

function hasGitHubDestination(value, env) {
  const text = String(value);
  for (const token of text.split(/[\s"'=]+/u)) {
    const scpHost = /^(?:[^/@:]+@)?(\[[^\]]+\]|[^/:]+):/u.exec(token)?.[1];
    if (scpHost && isGitHubHost(scpHost, env)) {
      return true;
    }
    const url = URL.parse(token.includes("://") ? token : `https://${token}`);
    if (url && isGitHubHost(url.hostname, env)) {
      return true;
    }
  }
  for (const match of text.matchAll(/(?:[a-z][a-z\d+.-]*:\/\/|git@)[^\s"'<>]+/giu)) {
    const raw = match[0];
    const url = URL.parse(raw.startsWith("git@") ? `ssh://${raw.replace(":", "/")}` : raw);
    if (url && isGitHubHost(url.hostname, env)) {
      return true;
    }
  }
  return false;
}

function executable(command, env, cwd) {
  const directoryRoot = cwd instanceof URL ? fileURLToPath(cwd) : (cwd ?? process.cwd());
  if (path.isAbsolute(command) || command.includes("/") || command.includes(path.sep)) {
    return path.resolve(directoryRoot, command);
  }
  const lookupPath =
    envValue(env, "PATH") ??
    (process.platform === "win32" ? (envValue(process.env, "PATH") ?? "") : "/usr/bin:/bin");
  const directories = lookupPath.split(path.delimiter);
  if (process.platform === "win32") {
    directories.unshift("");
  }
  for (const directory of directories) {
    for (const suffix of process.platform === "win32"
      ? ["", ".com", ".exe", ".cmd", ".bat"]
      : [""]) {
      const candidate = path.resolve(directoryRoot, directory, command + suffix);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isTemporaryFixture(file) {
  if (!file || !existsSync(file)) {
    return false;
  }
  const relative = path.relative(realpathSync(fixtureRoot), realpathSync(file));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  // Native gh can read the user's keychain even when HOME and token variables are isolated.
  return (
    (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(file)) ||
    /^#![^\r\n]+/u.test(readFileSync(file, "utf8").slice(0, 256))
  );
}

function guardedPath(env, cwd) {
  const defaultPath =
    process.platform === "win32" ? (envValue(process.env, "PATH") ?? "") : "/usr/bin:/bin";
  const directories = (envValue(env, "PATH") ?? defaultPath)
    .split(path.delimiter)
    .filter((directory) => directory !== blockedCommands);
  const firstRealGh = directories.findIndex((directory) => {
    const gh = executable("gh", { PATH: directory }, cwd);
    return gh && !isTemporaryFixture(gh);
  });
  directories.splice(firstRealGh < 0 ? directories.length : firstRealGh, 0, blockedCommands);
  return directories.join(path.delimiter);
}

function gitCommandIndex(args) {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const option = args[index++];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) {
      index++;
    }
  }
  return index;
}

/** Block real GitHub transports, including Node children that replace their environment. */
export function installGitHubNetworkGuard() {
  if (globalThis[guardKey]) {
    return globalThis[guardKey];
  }
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const methods = ["execFile", "execFileSync", "spawn", "spawnSync", "fork", "exec", "execSync"];
  const originals = new Map(methods.map((name) => [name, childProcess[name]]));
  const checkCommand = (command, args, options, shellText = "") => {
    const env = options.env ?? process.env;
    const file = executable(command, env, options.cwd);
    const name = path
      .basename(command)
      .toLowerCase()
      .replace(/\.(?:exe|com|cmd|bat)$/u, "");
    if (name === "gh" || command === envValue(env, "OPENCLAW_GH_BIN")) {
      if (!file || !isTemporaryFixture(file)) {
        forbidden();
      }
    } else if (transportCommands.has(name)) {
      const commandIndex = gitCommandIndex(args);
      const operation = args[commandIndex];
      const operationArgs = args.slice(commandIndex + 1);
      const subOperation = operationArgs.find((arg) => !arg.startsWith("-"));
      const submodule = operation === "submodule" && ["add", "update"].includes(subOperation);
      let networkIndex = [
        "clone",
        "fetch",
        "pull",
        "push",
        "ls-remote",
        "fetch-pack",
        "send-pack",
        "http-fetch",
        "http-push",
      ].includes(operation)
        ? commandIndex
        : -1;
      if (operation === "remote") {
        if (
          ["update", "prune"].includes(subOperation) ||
          (subOperation === "show" && !operationArgs.includes("-n")) ||
          (subOperation === "set-head" &&
            operationArgs.some((arg) => arg === "-a" || arg === "--auto")) ||
          (subOperation === "add" &&
            operationArgs.some((arg) => /^-[^-]*f/u.test(arg) || arg === "--fetch"))
        ) {
          networkIndex = commandIndex;
        }
      }
      if (
        submodule ||
        (operation === "archive" &&
          operationArgs.some((arg) => arg === "--remote" || arg.startsWith("--remote="))) ||
        (operation === "maintenance" &&
          subOperation === "run" &&
          (!operationArgs.some((arg) => arg.startsWith("--task=")) ||
            operationArgs.includes("--task=prefetch")))
      ) {
        networkIndex = commandIndex;
      }
      if (name === "git" && networkIndex < 0) {
        return;
      }
      if (name === "git" && shellText) {
        forbidden();
      }
      if (
        hasGitHubDestination(shellText, env) ||
        args.some((arg) => hasGitHubDestination(arg, env))
      ) {
        forbidden();
      }
      if (name === "git" && !isTemporaryFixture(file)) {
        if (submodule && subOperation === "update") {
          forbidden();
        }
        // Recursive/remote updates can select destinations inside not-yet-loaded repositories.
        if (
          operationArgs.some(
            (arg) => arg === "--recursive" || /^--recurse-submodules(?:=|$)/u.test(arg),
          ) ||
          (submodule && operationArgs.includes("--remote"))
        ) {
          forbidden();
        }
        const modules = originals.get("spawnSync")(
          file ?? command,
          [
            ...args.slice(0, networkIndex),
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "modules",
          ],
          { cwd: options.cwd, env, encoding: "utf8" },
        );
        if (
          modules.error ||
          (modules.status !== 0 && modules.status !== 128) ||
          (modules.status === 0 && existsSync(modules.stdout.trim()))
        ) {
          forbidden();
        }
        // Named/default remotes and URL rewrites can select GitHub without a URL argument.
        for (const configFile of submodule ? [undefined, ".gitmodules"] : [undefined]) {
          const config = originals.get("spawnSync")(
            file ?? command,
            [
              ...args.slice(0, networkIndex),
              "config",
              ...(configFile ? ["--file", configFile] : []),
              "--get-regexp",
              "^(remote\\..*\\.(url|pushurl)|url\\..*\\.(insteadof|pushinsteadof)|submodule\\..*\\.url)$",
            ],
            { cwd: options.cwd, env, encoding: "utf8" },
          );
          if (config.error || (config.status !== 0 && config.status !== 1)) {
            forbidden();
          }
          const rewriteBases = [
            ...String(config.stdout).matchAll(/^url\.(.+)\.(?:insteadof|pushinsteadof)\s/gimu),
          ].map((match) => match[1]);
          if (
            hasGitHubDestination(config.stdout, env) ||
            rewriteBases.some((base) => hasGitHubDestination(base, env))
          ) {
            forbidden();
          }
        }
      }
    }
  };
  const guarded = (original, shell) =>
    function (...args) {
      if (!shell && args[1] == null) {
        args[1] = [];
      }
      const optionIndex = shell || !Array.isArray(args[1]) ? 1 : 2;
      const options =
        args[optionIndex] && typeof args[optionIndex] === "object" ? args[optionIndex] : {};
      const command = args[0] instanceof URL ? fileURLToPath(args[0]) : args[0];
      const shellCommand =
        shell ||
        options.shell ||
        ["sh", "bash", "zsh", "cmd", "powershell", "pwsh"].includes(
          path
            .basename(command)
            .toLowerCase()
            .replace(/\.(?:exe|com|cmd|bat)$/u, ""),
        );
      if (!shellCommand) {
        checkCommand(command, Array.isArray(args[1]) ? args[1] : [], options);
      } else {
        const env = options.env ?? process.env;
        const commandText = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(" ");
        const expanded = commandText.replace(
          /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/giu,
          (_, powershell, braced, plain, cmd) =>
            envValue(env, powershell ?? braced ?? plain ?? cmd) ?? "",
        );
        const tokens = [...expanded.matchAll(/(?:\\.|"[^"]*"|'[^']*'|[^\s;&|()"'\\])+/gu)].map(
          (match) =>
            match[0].replace(/\\(.)|"([^"]*)"|'([^']*)'/gu, (fragment, escaped, double, single) =>
              escaped === undefined
                ? (double ?? single)
                : process.platform === "win32"
                  ? fragment
                  : escaped,
            ),
        );
        for (const [index, token] of tokens.entries()) {
          const name = path
            .basename(token)
            .toLowerCase()
            .replace(/\.(?:exe|com|cmd|bat)$/u, "");
          if (transportCommands.has(name)) {
            checkCommand(token, tokens.slice(index + 1), options, expanded);
          }
        }
        const ghBin = envValue(env, "OPENCLAW_GH_BIN");
        if (ghBin && expanded.includes(ghBin)) {
          checkCommand(ghBin, [], options);
        }
      }
      const env = options.env ?? process.env;
      const nodeOptions = envValue(env, "NODE_OPTIONS") ?? "";
      const childEnv = { ...env };
      if (process.platform === "win32") {
        for (const key of Object.keys(childEnv)) {
          if (key.toUpperCase() === "PATH") {
            delete childEnv[key];
          }
        }
      }
      const nextOptions = {
        ...options,
        env: {
          ...childEnv,
          PATH: guardedPath(env, options.cwd),
          [marker]: "1",
          [tempRootKey]: fixtureRoot,
          [hostsKey]: configuredHosts(env).join(","),
          NODE_OPTIONS: nodeOptions.includes(preload)
            ? nodeOptions
            : `${nodeOptions} --import=${JSON.stringify(preload)}`.trim(),
        },
      };
      if (typeof args[optionIndex] === "function") {
        args.splice(optionIndex, 0, nextOptions);
      } else {
        args[optionIndex] = nextOptions;
      }
      return Reflect.apply(original, this, args);
    };
  for (const [name, original] of originals) {
    const shell = name === "exec" || name === "execSync";
    childProcess[name] = guarded(original, shell);
    const custom = Symbol.for("nodejs.util.promisify.custom");
    if (original[custom]) {
      childProcess[name][custom] = guarded(original[custom], shell);
    }
  }
  if (originalFetch) {
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (isGitHubHost(url.hostname)) {
        forbidden();
      }
      return originalFetch(input, init);
    };
  }
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = first && typeof first === "object" ? (first.host ?? first.hostname) : args[1];
    if (isGitHubHost(host)) {
      forbidden();
    }
    return Reflect.apply(originalConnect, this, args);
  };
  syncBuiltinESMExports();
  const restore = () => {
    for (const [name, original] of originals) {
      childProcess[name] = original;
    }
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
    syncBuiltinESMExports();
    delete globalThis[guardKey];
  };
  globalThis[guardKey] = restore;
  return restore;
}

if (process.env[marker] === "1") {
  installGitHubNetworkGuard();
}
