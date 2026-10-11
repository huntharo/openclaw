import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectMessagingArchitectureViolations } from "../../scripts/check-messaging-architecture.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("enforces messaging ownership for every metadata-declared provider through resolved source imports", async () => {
  const root = tempDirs.make("openclaw-messaging-architecture-");
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  write("package.json", JSON.stringify({ type: "module" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: {
          "fixture-provider": ["./extensions/alpha/api.ts"],
          "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
        },
      },
    }),
  );
  // The providers deliberately use different metadata declarations and package names.
  for (const [name, manifest, metadata] of [
    ["alpha", { channels: ["chat-a"] }, {}],
    ["beta", {}, { channel: { id: "chat-b" } }],
    ["gamma", { categories: ["channels"] }, {}],
  ] as const) {
    write(`extensions/${name}/openclaw.plugin.json`, JSON.stringify({ id: name, ...manifest }));
    write(
      `extensions/${name}/package.json`,
      JSON.stringify({ name: `@fixture/${name}`, type: "module", openclaw: metadata }),
    );
    write(
      `extensions/${name}/api.ts`,
      "export const send = () => {}; export type Message = string;",
    );
    write(`src/plugin-sdk/${name}.ts`, "export {};");
  }
  write("extensions/unrelated/openclaw.plugin.json", '{"id":"unrelated","providers":["model"]}');
  write("extensions/unrelated/package.json", '{"name":"@fixture/model"}');
  write("extensions/unrelated/api.ts", "export {};");
  write("src/gateway/host.ts", "export const host = 1;");
  write("src/plugin-sdk/helper.ts", "export const helper = 1;");
  write("src/channels/contracts/message.ts", "export type Message = string;");
  write("src/channels/load.ts", 'export * from "../../extensions/alpha/api.js";');
  write(
    "extensions/alpha/local.ts",
    [
      'import { send } from "./api.js";',
      'import { helper } from "../../src/plugin-sdk/helper.js";',
      'import "openclaw/plugin-sdk/alpha";',
      "export const local = () => [send(), helper];",
    ].join("\n"),
  );
  write(
    "ui/src/allowed.ts",
    [
      'import type { Message } from "../../src/channels/contracts/message.js";',
      'import "../../extensions/unrelated/api.js";',
      '// import "../../extensions/alpha/api.js";',
      "const example = 'import \"../../extensions/beta/api.js\"';",
      "export type View = Message;",
    ].join("\n"),
  );
  write("ui/src/fixture.test.ts", 'import "../../extensions/alpha/api.js";');
  write(
    "extensions/unrelated/test-contract.ts",
    'import type { Message } from "../alpha/api.js"; export type TestMessage = Message;',
  );
  expect(await collectMessagingArchitectureViolations(root)).toEqual([]);

  write(
    "ui/src/violations.ts",
    [
      'import { send } from "fixture-provider";',
      'export { send as other } from "../../extensions/beta/api.js";',
      'const lazy = () => import("../../extensions/gamma/api.js");',
      'const cjs = require("@fixture/beta");',
      'type Message = import("../../extensions/alpha/api.js").Message;',
      'const asset = new URL("../../extensions/gamma/api.js", import.meta.url);',
      'const repeated = require("@fixture/beta");',
      'import "openclaw/plugin-sdk/beta";',
    ].join("\n"),
  );
  write("src/gateway/direct.ts", 'import "../../extensions/beta/api.js";');
  write("src/plugin-sdk/leak.ts", 'export * from "../../extensions/alpha/api.js";');
  write("src/plugin-sdk/channel-contract.ts", 'import "../gateway/host.js";');
  write("src/channels/contracts/leak.ts", 'export * from "../../../extensions/alpha/api.js";');
  write("src/channels/contracts/host.ts", 'import type { host } from "../../gateway/host.js";');
  write("src/channels/contracts/host.d.ts", 'import type { host } from "../../gateway/host.js";');
  write("ui/src/reached.ts", 'import "./fixture.test.js";');
  write(
    "extensions/alpha/violations.ts",
    [
      'import "../beta/api.js";',
      'import "@fixture/gamma";',
      'import "../../src/gateway/host.js";',
      'import "../../ui/src/allowed.js";',
      'import "openclaw/plugin-sdk/beta";',
    ].join("\n"),
  );
  const violations = await collectMessagingArchitectureViolations(root);
  expect(violations.map(({ file, line, rule }) => [file, line, rule])).toEqual([
    ["extensions/alpha/violations.ts", 1, "messaging-provider-alpha-does-not-import-siblings"],
    ["extensions/alpha/violations.ts", 2, "messaging-provider-alpha-does-not-import-siblings"],
    ["extensions/alpha/violations.ts", 3, "messaging-providers-do-not-import-hosts"],
    ["extensions/alpha/violations.ts", 4, "messaging-providers-do-not-import-hosts"],
    ["extensions/alpha/violations.ts", 5, "messaging-provider-alpha-does-not-import-siblings"],
    [
      "src/channels/contracts/host.d.ts",
      1,
      "messaging-interface-has-no-provider-or-host-dependencies",
    ],
    [
      "src/channels/contracts/host.ts",
      1,
      "messaging-interface-has-no-provider-or-host-dependencies",
    ],
    [
      "src/channels/contracts/leak.ts",
      1,
      "messaging-interface-has-no-provider-or-host-dependencies",
    ],
    ["src/gateway/direct.ts", 1, "hosts-do-not-import-messaging-providers"],
    [
      "src/plugin-sdk/channel-contract.ts",
      1,
      "messaging-interface-has-no-provider-or-host-dependencies",
    ],
    ["src/plugin-sdk/leak.ts", 1, "hosts-do-not-import-messaging-providers"],
    ["ui/src/fixture.test.ts", 1, "hosts-do-not-import-messaging-providers"],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((line) => [
      "ui/src/violations.ts",
      line,
      "hosts-do-not-import-messaging-providers",
    ]),
  ]);
});
