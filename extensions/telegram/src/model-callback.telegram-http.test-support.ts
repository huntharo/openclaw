// The canonical command flow is covered by the broker-routed core fixture;
// this owner proves Telegram encoding, admission, source edits, and queued sends.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildModelPickerPresentation,
  createModelPickerCapabilityProfile,
  type ModelPickerCatalog,
} from "openclaw/plugin-sdk/interactive-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { defaultTelegramBotDeps, type TelegramBotDeps } from "./bot-deps.js";
import { createTelegramCallbackMessageActions } from "./bot-handlers.callback-actions.js";
import type { TelegramCallbackMessageRuntime } from "./bot-handlers.callback-router-controls.js";
import { createTelegramCallbackRouter } from "./bot-handlers.callback-router.js";
import type { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveTelegramGroupAllowFromContext } from "./bot/helpers.js";
import { resolveTelegramConversationRoute } from "./conversation-route.js";
import { getTelegramObservedMessageCache } from "./outbound-message-context.js";
import { TELEGRAM_PRESENTATION_CAPABILITIES } from "./presentation-capabilities.js";
import { resetTelegramMessageCacheForTest } from "./runtime.test-support.js";
import { editMessageReplyMarkupTelegram } from "./send-edit.js";

const CHAT_ID = 123;
const PROVIDER = "fixture";
const MODEL = `synthetic/${"long-model-".repeat(12)}:latest`;
const catalog: ModelPickerCatalog = [{ provider: PROVIDER, id: MODEL }];
const capabilityProfile = createModelPickerCapabilityProfile(TELEGRAM_PRESENTATION_CAPABILITIES)!;
const presentation = buildModelPickerPresentation({
  catalog,
  capabilityProfile,
  provider: PROVIDER,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export function registerTelegramModelCallbackHttpTests(
  fixture: ReturnType<typeof createTelegramDispatchHttpFixture>,
) {
  describe("Telegram canonical model-menu callbacks", () => {
    afterEach(resetTelegramMessageCacheForTest);

    async function setup(
      options: {
        prepareCatalog?: () => Promise<void>;
        admittedCatalog?: ModelPickerCatalog;
        business?: boolean;
        media?: boolean;
      } = {},
    ) {
      fixture.bot.botInfo = { ...telegramBotInfoForTest, id: 123456 };
      fixture.bot.api.config.use(getOrCreateAccountThrottler(fixture.token).transformer);
      const telegramCfg = {
        botToken: fixture.token,
        apiRoot: fixture.apiRoot,
        dmPolicy: "open" as const,
        allowFrom: ["*"],
        capabilities: { inlineButtons: "all" as const },
        richMessages: false,
      };
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "default", default: true }] },
        session: { store: fixture.state.path("sessions.json") },
        channels: { telegram: telegramCfg },
      };
      await fixture.dispatchProgressTurn(async () => {}, {
        mode: "off",
        toolProgress: false,
        cfg,
        telegramCfg,
        finalReply: { text: "Choose a model", presentation },
      });
      const markup = fixture.visibleMarkup.get(1);
      // The independent provider contract rejects invalid callback lengths.
      expect(markup).toMatchObject({ inline_keyboard: expect.any(Array) });
      const source: Message = {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: CHAT_ID, type: "private", first_name: "Fixture" },
        from: fixture.bot.botInfo,
        text: "Choose a model",
        reply_markup: markup as Message["reply_markup"],
        ...(options.business
          ? {
              business_connection_id: "fixture-business",
              from: { id: 88, is_bot: false, first_name: "Fixture business account" },
              sender_business_bot: fixture.bot.botInfo,
            }
          : {}),
      };
      if (options.media) {
        delete source.text;
        source.caption = "Choose a model";
        source.photo = [
          { file_id: "fixture-photo", file_unique_id: "fixture-unique", width: 1, height: 1 },
        ];
        fixture.respondToCall = ({ method }) =>
          method === "editMessageText"
            ? {
                error_code: 400,
                description: "Bad Request: there is no text in the message to edit",
              }
            : undefined;
      }
      const cache = getTelegramObservedMessageCache({ cfg, accountId: "default" });
      await cache.record({ accountId: "default", chatId: CHAT_ID, msg: source, botUserId: 123456 });
      const callbackData = source.reply_markup?.inline_keyboard
        .flat()
        .find((button) => "callback_data" in button && button.callback_data.startsWith("mp1:s:"));
      if (!callbackData || !("callback_data" in callbackData)) {
        throw new Error("Missing model control");
      }
      expect(Buffer.byteLength(callbackData.callback_data, "utf8")).toBeLessThanOrEqual(64);
      const commands: string[] = [];
      const errors: string[] = [];
      const admitted = options.admittedCatalog ?? catalog;
      const telegramDeps: TelegramBotDeps = {
        ...defaultTelegramBotDeps,
        getRuntimeConfig: () => cfg,
        buildModelsProviderData: async () => {
          await options.prepareCatalog?.();
          return {
            providers: admitted.length ? [PROVIDER] : [],
            byProvider: new Map([[PROVIDER, new Set(admitted.map((row) => row.id))]]),
            modelNames: new Map(),
            modelCatalog: [],
            resolvedDefault: { provider: PROVIDER, model: MODEL },
          };
        },
      };
      const messageRuntime: TelegramCallbackMessageRuntime = {
        buildFailedProcessingResult: (error) => ({ kind: "failed-retryable", error }),
        resolveTelegramSessionState: async () => {
          const routed = await resolveTelegramConversationRoute({
            cfg,
            accountId: "default",
            chatId: CHAT_ID,
            isGroup: false,
            threadSpec: { scope: "none" },
            senderId: "9",
          });
          return {
            ...routed,
            agentId: routed.route.agentId,
            sessionKey: routed.route.sessionKey,
            storePath: cfg.session!.store!,
            sessionEntry: undefined,
            model: undefined,
          };
        },
        processMessageWithReplyChain: async ({ msg, options: replyOptions }) => {
          commands.push(msg.text ?? "");
          await fixture.dispatchProgressTurn(async () => {}, {
            mode: "off",
            toolProgress: false,
            cfg,
            telegramCfg,
            callbackReply: replyOptions?.callbackReply,
            finalReply: { text: "Selection admitted by the canonical command owner." },
          });
          return { kind: "completed" };
        },
      };
      const router = createTelegramCallbackRouter({
        params: {
          accountId: "default",
          bot: fixture.bot,
          telegramDeps,
          runtime: {
            log: () => undefined,
            exit: () => {
              throw new Error("Unexpected exit");
            },
            error: (error) => {
              errors.push(String(error));
            },
          },
          shouldSkipUpdate: () => false,
          opts: { token: fixture.token },
        },
        message: messageRuntime,
        authorization: {
          resolveTelegramEventAuthorizationContext: async ({ threadSpec }) => ({
            ...(await resolveTelegramGroupAllowFromContext({
              cfg,
              accountId: "default",
              chatId: CHAT_ID,
              threadSpec,
              dmPolicy: "open",
              allowFrom: ["*"],
              resolveTelegramGroupConfig: () => ({}),
            })),
            cfg,
            telegramCfg,
            commandAuthorizedByConfig: true,
            dmPolicy: "open",
            allowFrom: ["*"],
          }),
          authorizeTelegramEventSender: async () => true,
          isTelegramModelCallbackAuthorized: async () => true,
        },
      });
      fixture.bot.on("callback_query", (context) => router.route(context));
      let sequence = 2;
      const tap = (data = callbackData.callback_data, message = source) =>
        fixture.bot.handleUpdate({
          update_id: sequence++,
          callback_query: {
            id: `fixture-callback-${sequence}`,
            chat_instance: "fixture-chat",
            data,
            message,
            from: { id: 9, is_bot: false, first_name: "Fixture guest" },
          },
        });
      return { cfg, cache, source, tap, commands, errors };
    }

    it.each(["text", "business-caption"] as const)(
      "resolves a long model ID to typed canonical ingress and edits only the originating %s menu",
      async (mode) => {
        const flow = await setup({
          business: mode === "business-caption",
          media: mode === "business-caption",
        });
        if (mode === "business-caption") {
          for (const domain of [undefined, "other-business"] as const) {
            const { business_connection_id: _business, ...ordinary } = flow.source;
            await flow.cache.record({
              accountId: "default",
              chatId: CHAT_ID,
              msg: {
                ...ordinary,
                text: "Independent menu",
                ...(domain === undefined ? {} : { business_connection_id: domain }),
              },
            });
          }
        }
        const start = fixture.calls.length;
        await flow.tap();
        expect(flow.errors).toEqual([]);
        expect(flow.commands).toEqual([`/model ${PROVIDER}/${MODEL} -s`]);
        const calls = fixture.calls.slice(start);
        expect(calls[0]?.method).toBe("answerCallbackQuery");
        const edits = calls.filter(({ method }) => method.startsWith("editMessage"));
        expect(edits.map(({ method }) => method)).toEqual(
          mode === "text" ? ["editMessageText"] : ["editMessageText", "editMessageCaption"],
        );
        for (const edit of edits) {
          expect(String(edit.fields.chat_id)).toBe(String(CHAT_ID));
          expect(edit.fields).toMatchObject({
            message_id: 1,
            reply_markup: { inline_keyboard: [] },
          });
          if (mode === "business-caption") {
            expect(edit.fields.business_connection_id).toBe("fixture-business");
          }
        }
        expect(calls.some(({ method }) => method === "sendMessage")).toBe(false);
        expect(fixture.visibleMessages.size).toBe(1);
      },
    );

    it("keeps concurrent callbacks in independent business domains current", async () => {
      const entered = deferred();
      const release = deferred();
      let preparations = 0;
      const flow = await setup({
        business: true,
        prepareCatalog: async () => {
          if (++preparations === 1) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      const sibling = { ...flow.source, business_connection_id: "other-business" };
      await flow.cache.record({ accountId: "default", chatId: CHAT_ID, msg: sibling });
      const start = fixture.calls.length;
      const first = flow.tap();
      await entered.promise;
      try {
        await flow.tap(undefined, sibling);
      } finally {
        release.resolve();
      }
      await first;
      expect(flow.errors).toEqual([]);
      expect(flow.commands).toEqual([
        `/model ${PROVIDER}/${MODEL} -s`,
        `/model ${PROVIDER}/${MODEL} -s`,
      ]);
      expect(
        fixture.calls
          .slice(start)
          .filter(({ method }) => method === "editMessageText")
          .map(({ fields }) => fields.business_connection_id)
          .toSorted((a, b) => String(a).localeCompare(String(b))),
      ).toEqual(["fixture-business", "other-business"]);
    });

    it.each(["deleted-catalog", "changed-snapshot", "legacy-delivered"] as const)(
      "retires %s controls visibly without deriving a command from callback text",
      async (change) => {
        const flow = await setup({
          admittedCatalog:
            change === "deleted-catalog"
              ? []
              : change === "changed-snapshot"
                ? [{ provider: PROVIDER, id: "replacement" }]
                : catalog,
        });
        if (change === "legacy-delivered") {
          flow.source.reply_markup = {
            inline_keyboard: [[{ text: "Old model", callback_data: "mdl1~m:old" }]],
          };
          await flow.cache.record({ accountId: "default", chatId: CHAT_ID, msg: flow.source });
        }
        await flow.tap(change === "legacy-delivered" ? "mdl1~m:old" : undefined);
        expect(flow.commands).toEqual([]);
        expect(flow.errors).toEqual([]);
        expect(fixture.visibleMarkup.get(1)).toEqual({ inline_keyboard: [] });
        expect([...fixture.visibleMessages.values()]).toContain(
          "This action is no longer available.",
        );
      },
    );

    it("rejects an old callback when a different full keyboard is already known at the same edit date", async () => {
      const flow = await setup();
      const newer = {
        ...flow.source,
        reply_markup: { inline_keyboard: [[{ text: "Replacement", callback_data: "newer" }]] },
      };
      await flow.cache.record({ accountId: "default", chatId: CHAT_ID, msg: newer });
      await flow.tap();
      expect(flow.commands).toEqual([]);
      expect(flow.errors).toHaveLength(1);
      expect(flow.errors[0]).toContain("source changed");
      expect(fixture.calls.filter(({ method }) => method.startsWith("editMessage"))).toEqual([]);
      expect(
        (await flow.cache.get({ accountId: "default", chatId: CHAT_ID, messageId: "1" }))
          ?.sourceMessage.reply_markup,
      ).toEqual(newer.reply_markup);
    });

    it("rejects an observed source replacement during catalog preparation", async () => {
      const prepared = deferred();
      const resume = deferred();
      const flow = await setup({
        prepareCatalog: async () => {
          prepared.resolve();
          await resume.promise;
        },
      });
      const pending = flow.tap();
      await prepared.promise;
      await flow.cache.record({
        accountId: "default",
        chatId: CHAT_ID,
        msg: {
          ...flow.source,
          edit_date: 1_700_000_001,
          reply_markup: { inline_keyboard: [[{ text: "Newer menu", callback_data: "newer" }]] },
        },
      });
      resume.resolve();
      await pending;
      expect(flow.commands).toEqual([]);
      expect(flow.errors).toHaveLength(1);
      expect(flow.errors[0]).toContain("source changed");
      expect(fixture.calls.filter(({ method }) => method.startsWith("editMessage"))).toEqual([]);
      expect([...fixture.visibleMessages.values()]).toContain(
        "Could not use this menu. Send /models or /commands again.",
      );
    });

    it("fences a queued clear after a published source change, without overwriting a newer menu", async () => {
      const flow = await setup();
      const source = flow.cache.beginObservedMessageCapture({
        accountId: "default",
        chatId: CHAT_ID,
        messageId: "1",
      });
      source.capture(
        (await flow.cache.get({ accountId: "default", chatId: CHAT_ID, messageId: "1" }))!,
        flow.source,
      );
      fixture.respondToCall = ({ method }) =>
        method === "editMessageReplyMarkup"
          ? {
              error_code: 429,
              description: "Too Many Requests: retry after 60",
              parameters: { retry_after: 60 },
            }
          : undefined;
      const pending = editMessageReplyMarkupTelegram(CHAT_ID, 1, [], {
        cfg: flow.cfg,
        token: fixture.token,
        api: fixture.bot.api,
        accountId: "default",
        assertPlatformSendAuthorized: source.assertCurrent,
      });
      const rejected = expect(pending).rejects.toThrow("source changed");
      await fixture.waitForBotApiCall(({ method }) => method === "editMessageReplyMarkup");
      fixture.respondToCall = () => undefined;
      await flow.cache.record({
        accountId: "default",
        chatId: CHAT_ID,
        msg: {
          ...flow.source,
          edit_date: 1_700_000_001,
          reply_markup: { inline_keyboard: [[{ text: "New", callback_data: "new" }]] },
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(
        fixture.acceptedCalls.filter(({ method }) => method === "editMessageReplyMarkup"),
      ).toHaveLength(0);
      expect(
        (await flow.cache.get({ accountId: "default", chatId: CHAT_ID, messageId: "1" }))
          ?.sourceMessage.reply_markup,
      ).toEqual({ inline_keyboard: [[{ text: "New", callback_data: "new" }]] });
      source.dispose();
    });

    it("invalidates active source captures through the actual acknowledged markup owner", async () => {
      const flow = await setup();
      const source = flow.cache.beginObservedMessageCapture({
        accountId: "default",
        chatId: CHAT_ID,
        messageId: "1",
      });
      source.capture(
        (await flow.cache.get({ accountId: "default", chatId: CHAT_ID, messageId: "1" }))!,
        flow.source,
      );
      const actions = createTelegramCallbackMessageActions({
        bot: fixture.bot,
        callbackMessage: flow.source,
        threadSpec: { scope: "none" },
        cfg: flow.cfg,
        accountId: "default",
      });
      await actions.clearCallbackButtons();
      expect(fixture.visibleMarkup.get(1)).toEqual({ inline_keyboard: [] });
      expect(() => source.assertCurrent()).toThrow("source changed");
      source.dispose();
      expect(() => source.assertCurrent()).toThrow("source changed");
    });

    it("allows only the newer overlapping callback to edit the source menu", async () => {
      const prepared = deferred();
      const resume = deferred();
      let preparations = 0;
      const flow = await setup({
        prepareCatalog: async () => {
          if (++preparations === 1) {
            prepared.resolve();
            await resume.promise;
          }
        },
      });
      const older = flow.tap();
      await prepared.promise;
      await flow.tap();
      resume.resolve();
      await older;
      expect(flow.commands).toEqual([`/model ${PROVIDER}/${MODEL} -s`]);
      expect(flow.errors).toHaveLength(1);
      expect(flow.errors[0]).toContain("newer menu interaction");
      expect(
        fixture.acceptedCalls.filter(({ method }) => method === "editMessageText"),
      ).toHaveLength(1);
    });
  });
}
