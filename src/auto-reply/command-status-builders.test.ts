import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as preparedCatalog from "../agents/prepared-model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deliverOutboundPayloadsCore } from "../infra/outbound/deliver-core.js";
import { prepareOutboundPayloadBatch } from "../infra/outbound/deliver-prepare.js";
import {
  createModelPickerCapabilityProfile,
  resolveModelPickerAction,
} from "../model-picker/menu.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { buildCommandsMessagePaginated } from "./command-status-builders.js";
import { resolveTextCommand } from "./commands-registry-normalize.js";
import { handleCommands } from "./reply/commands-core.js";
import { loadModelsProviderData } from "./reply/commands-models-catalog.js";
import { createModelsTestOwner } from "./reply/commands-models.test-support.js";
import { buildCommandTestParams } from "./reply/commands.test-harness.js";
import type { ReplyPayload } from "./types.js";

const snapshot = captureActivePluginRegistrySnapshot();
afterEach(() => {
  vi.restoreAllMocks();
  restoreActivePluginRegistrySnapshot(snapshot);
});

async function deliver(reply: ReplyPayload, cfg: OpenClawConfig, accountId: string) {
  const params = { cfg, channel: "portable", to: "portable:bot", accountId, payloads: [reply] };
  const preparedBatch = await prepareOutboundPayloadBatch(params);
  return await deliverOutboundPayloadsCore({ ...params, preparedBatch });
}

describe("portable command list", () => {
  it("paginates the shared command inventory with typed next and previous actions", async () => {
    const sendText = vi.fn(async ({ text }: { text: string }) => ({
      channel: "portable",
      messageId: text ? "fixture-command-receipt" : "empty",
    }));
    const plugin = {
      ...createChannelTestPluginBase({ id: "portable" }),
      outbound: {
        deliveryMode: "direct" as const,
        presentationCapabilities: { supported: true, buttons: true, modelPicker: true },
        resolvePresentationCapabilities: () => ({ supported: true, buttons: false }),
        sendText,
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "portable", plugin, source: "test" }]));
    const first = buildCommandsMessagePaginated({}, undefined, { surface: "portable" });
    expect(first.totalPages).toBeGreaterThan(1);
    expect(first.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Next", action: { type: "command", command: "/commands 2" } }],
        },
      ],
    });
    const second = buildCommandsMessagePaginated({}, undefined, { surface: "portable", page: 2 });
    expect(second.currentPage).toBe(2);
    expect(second.text).not.toBe(first.text);
    expect(second.presentation?.blocks).toEqual([
      {
        type: "buttons",
        buttons: expect.arrayContaining([
          { label: "Previous", action: { type: "command", command: "/commands 1" } },
        ]),
      },
    ]);
    const parsed = resolveTextCommand("/commands 2");
    expect(parsed?.command.key).toBe("commands");
    expect(parsed?.args).toBe("2");
    const params = buildCommandTestParams(
      "/commands 2",
      { commands: { text: true } },
      {
        Provider: "portable",
        Surface: "portable",
        From: "portable:fixture-user",
        To: "portable:bot",
      },
    );
    const dispatched = await handleCommands({
      ...params,
      skillCommands: [],
      resolveModelLevels: async () => ({
        resolvedThinkLevel: undefined,
        resolvedReasoningLevel: "off",
      }),
    });
    expect(dispatched.shouldContinue).toBe(false);
    expect(dispatched.reply?.text).toBe(second.text);
    expect(dispatched.reply?.presentation).toEqual(second.presentation);
    expect(
      await deliver(expectDefined(dispatched.reply, "Expected command page"), {}, "text-only"),
    ).toHaveLength(1);
    const textOnly = sendText.mock.calls.at(-1)?.[0].text;
    expect(textOnly).toContain("/commands 1");
    expect(textOnly).toContain("/commands 3");
    params.command.isAuthorizedSender = false;
    const denied = await handleCommands({
      ...params,
      skillCommands: [],
      resolveModelLevels: async () => ({
        resolvedThinkLevel: undefined,
        resolvedReasoningLevel: "off",
      }),
    });
    expect(denied).toEqual({ shouldContinue: false });
    const plain = buildCommandsMessagePaginated({}, undefined, { surface: "plain" });
    expect(plain.totalPages).toBe(1);
    expect(plain.presentation).toBeUndefined();
    expect(plain.text).toContain("/stop");
  });
});

describe("portable model provider pages", () => {
  it("keeps canonical forward/back replies bounded with page-local availability and pending facts", async () => {
    const providers = Array.from(
      { length: 200 },
      (_, index) => `provider-${String(index).padStart(3, "0")}-${"synthetic-long-id-".repeat(3)}`,
    );
    const entries = providers.map((provider) => ({
      provider,
      id: "fixture-model",
      name: "Fixture",
    }));
    const capabilities = { supported: true, buttons: true, modelPicker: true };
    const sendText = vi.fn(async ({ text }: { text: string }) => ({
      channel: "portable",
      messageId: text ? "fixture-model-receipt" : "empty",
    }));
    const pendingProvider = "provider-005-pending";
    const inventory = [...providers, pendingProvider].toSorted();
    const plugin = {
      ...createChannelTestPluginBase({ id: "portable" }),
      outbound: {
        deliveryMode: "direct" as const,
        presentationCapabilities: capabilities,
        resolvePresentationCapabilities: ({ accountId }: { accountId?: string | null }) => ({
          ...capabilities,
          buttons: accountId !== "text-only",
        }),
        sendText,
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "portable", plugin, source: "test" }]));
    const cfg = {
      commands: { text: true },
      agents: {
        defaults: {
          model: {
            primary: providers[0] + "/fixture-model",
            fallbacks: providers.slice(1).map((provider) => provider + "/fixture-model"),
          },
        },
      },
    };
    vi.spyOn(preparedCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot").mockImplementation(
      async (params) => {
        if (!params?.config) {
          throw new Error("Expected admitted config");
        }
        const admittedOwner = createModelsTestOwner(params.config, entries, params);
        const owner = {
          ...admittedOwner,
          modelCatalog: {
            ...admittedOwner.modelCatalog,
            pendingProviders: inventory,
            refreshFailed: true,
          },
        };
        bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
        return owner;
      },
    );
    const dispatch = async (command: string, accountId?: string) => {
      expect(resolveTextCommand(command)?.command.key).toBe("models");
      return await handleCommands({
        ...buildCommandTestParams(command, cfg, {
          Provider: "portable",
          Surface: "portable",
          From: "portable:fixture",
          To: "portable:bot",
          AccountId: accountId,
        }),
        skillCommands: [],
        resolveModelLevels: async () => ({
          resolvedThinkLevel: undefined,
          resolvedReasoningLevel: "off",
        }),
      });
    };
    const admitted = await loadModelsProviderData(
      cfg,
      "main",
      { workspaceDir: "/tmp" },
      "/tmp/models-agent",
    );
    expect(admitted.pendingProviders).toHaveLength(201);
    expect(admitted.byProvider.get(pendingProvider)?.size).toBe(0);
    expect(admitted.modelMenu?.byProvider.get(providers[8]!)?.notice).toContain("Sign-in needed");
    expect(admitted.refreshWarning).toBeTruthy();
    const profile = createModelPickerCapabilityProfile(capabilities)!;
    const catalog = admitted.providers.flatMap((provider) =>
      [...(admitted.byProvider.get(provider) ?? [])].map((id) => ({
        provider,
        id,
        runtimes: admitted.runtimeChoicesByModel?.get(provider + "/" + id),
      })),
    );
    const pageCommand = (
      reply: NonNullable<Awaited<ReturnType<typeof dispatch>>["reply"]>,
      label: string,
    ) => {
      const action = reply.presentation?.blocks
        .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
        .find((button) => button.label === label)?.action;
      if (action?.type === "command") {
        return action.command;
      }
      if (action?.type !== "model-picker") {
        throw new Error("Missing typed model-page control");
      }
      const result = resolveModelPickerAction({ action, catalog, capabilityProfile: profile });
      if (result.kind !== "command") {
        throw new Error("Fresh page action was unavailable");
      }
      return result.action.command;
    };
    const second = expectDefined((await dispatch("/models page=2")).reply, "Expected page two");
    expect(second.text?.length).toBeLessThanOrEqual(4096);
    expect(second.text).toContain(admitted.refreshWarning);
    const assertPage = (reply: typeof second, start: number) => {
      const expected = inventory.slice(start, start + 4);
      expect(reply.text?.split("\n").filter((line) => line.startsWith("- "))).toEqual(
        expected.map((provider) => `- ${provider} (${provider === pendingProvider ? 0 : 1})`),
      );
      expect(reply.text?.split("\n").filter((line) => line.endsWith(": checking models…"))).toEqual(
        expected.map((provider) => `${provider}: checking models…`),
      );
      const buttons = reply.presentation?.blocks
        .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
        .filter((button) => button.label !== "Previous" && button.label !== "Next");
      expect(buttons?.map((button) => button.label)).toEqual(
        expected.map((provider) => `${provider} (${provider === pendingProvider ? 0 : 1})`),
      );
      for (const provider of expected) {
        const notice = admitted.modelMenu?.byProvider.get(provider)?.notice;
        if (notice) {
          expect(reply.text).toContain(notice);
        }
      }
    };
    assertPage(second, 4);
    expect(await deliver(second, cfg, "text-only")).toHaveLength(1);
    const deliveredText = sendText.mock.calls.at(-1)?.[0].text;
    expect(deliveredText).toContain("Previous: /models page=1");
    expect(deliveredText).toContain("Next: /models page=3");
    const pendingControl = second.presentation?.blocks
      .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
      .find((button) => button.label === `${pendingProvider} (0)`);
    if (pendingControl?.action?.type !== "command") {
      throw new Error("Missing pending-provider browse command");
    }
    expect((await dispatch(pendingControl.action.command)).reply?.text).toContain(
      `${pendingProvider}: checking models…`,
    );
    const third = expectDefined(
      (await dispatch(pageCommand(second, "Next"))).reply,
      "Expected page three",
    );
    assertPage(third, 8);
    const back = expectDefined(
      (await dispatch(pageCommand(third, "Previous"))).reply,
      "Expected page two again",
    );
    expect(back.text).toBe(second.text);
    expect(back.presentation).toEqual(second.presentation);
    const plainProviders = expectDefined(
      (await dispatch("/models", "text-only")).reply,
      "Expected text-only provider inventory",
    );
    expect(plainProviders.presentation).toBeUndefined();
    expect(plainProviders.text).toContain(`- ${providers.at(-1)} (1)`);
    expect(plainProviders.text).toContain(`- ${pendingProvider} (0)`);
    const plainModels = expectDefined(
      (await dispatch(`/models ${providers[0]}`, "text-only")).reply,
      "Expected text-only model inventory",
    );
    expect(plainModels.presentation).toBeUndefined();
    expect(plainModels.text).toContain("fixture-model");
  });
});
