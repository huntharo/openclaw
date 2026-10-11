import type { Message } from "grammy/types";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import {
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
  type PersistedTelegramMessageCacheValue,
} from "./message-cache-persistence.js";
import type { TelegramObservedMessageCapture } from "./message-cache-source-observation.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { resetTelegramMessageCacheForTest } from "./runtime.test-support.js";

export function registerTelegramMessageCacheBusinessDomainTests(params: {
  scope: string;
  accountId: string;
  state: () => OpenClawTestState;
}) {
  it.each(["bounded", "retained"] as const)(
    "isolates ordinary/business A/business B native message identity in %s storage",
    async (retention) => {
      const chat: Message["chat"] =
        retention === "bounded"
          ? { id: 7, type: "private", first_name: "Fixture" }
          : { id: -1007, type: "supergroup", title: "Storage fixture" };
      const writer = createTelegramMessageCache({ scope: params.scope });
      const domains = [undefined, "business:A/opaque", "business:B/opaque"] as const;
      const identity = (businessConnectionId: string | undefined, messageId = "22") => ({
        accountId: params.accountId,
        chatId: chat.id,
        messageId,
        businessConnectionId,
      });
      const source = (businessConnectionId: string | undefined): Message => ({
        chat,
        message_id: 22,
        date: 1_700_000_000,
        from: { id: 123456, is_bot: true, first_name: "Fixture bot" },
        text: businessConnectionId ?? "ordinary",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Own menu", callback_data: businessConnectionId ?? "ordinary" }],
          ],
        },
        ...(businessConnectionId === undefined
          ? {}
          : { business_connection_id: businessConnectionId }),
      });
      for (const domain of domains) {
        await writer.record({
          accountId: params.accountId,
          chatId: chat.id,
          msg: source(domain),
          historyEligible: true,
        });
      }
      resetTelegramMessageCacheForTest();
      const first = createTelegramMessageCache({ scope: params.scope });
      const second = createTelegramMessageCache({ scope: params.scope });
      const captures: TelegramObservedMessageCapture[] = [];
      try {
        for (const domain of domains) {
          const node = await second.get(identity(domain));
          expect(node?.sourceMessage.text).toBe(domain ?? "ordinary");
          expect(node?.sourceMessage.business_connection_id).toBe(domain);
          const history = await second.readHistory({ ...identity(domain), limit: 10 });
          expect(history.messages.map((item) => item.sourceMessage.text)).toEqual([
            domain ?? "ordinary",
          ]);
          expect(
            (await second.recentBefore({ ...identity(domain, "23"), limit: 10 })).map(
              (item) => item.sourceMessage.text,
            ),
          ).toEqual([domain ?? "ordinary"]);
          const capture = first.beginObservedMessageCapture(identity(domain));
          captures.push(capture);
          capture.capture(node!, source(domain));
        }
        second.invalidateObservedMessageCaptures(identity(domains[1]));
        captures[0]!.assertCurrent();
        expect(() => captures[1]!.assertCurrent()).toThrow("source changed");
        captures[2]!.assertCurrent();
        await second.record({
          accountId: params.accountId,
          chatId: chat.id,
          msg: { ...source(domains[2]), reply_markup: { inline_keyboard: [] } },
        });
        captures[0]!.assertCurrent();
        expect(() => captures[2]!.assertCurrent()).toThrow("source changed");
      } finally {
        for (const capture of captures) {
          capture.dispose();
        }
      }
    },
  );

  it.each(["bounded", "retained"] as const)(
    "preserves ambiguous legacy %s business rows without admitting them as ordinary history",
    async (retention) => {
      const chat: Message["chat"] =
        retention === "bounded"
          ? { id: 7, type: "private", first_name: "Fixture" }
          : { id: -1007, type: "supergroup", title: "Storage fixture" };
      const legacy: PersistedTelegramMessageCacheValue = {
        version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
        sourceMessage: {
          chat,
          message_id: 22,
          date: 1_700_000_000,
          text: "Legacy business history",
          business_connection_id: "business:A/opaque",
        },
        historyEligible: true,
      };
      const store = createPluginStateKeyedStoreForTests<PersistedTelegramMessageCacheValue>(
        "telegram",
        {
          namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
          ...(retention === "retained"
            ? { retention: "retained" }
            : { maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES }),
          env: params.state().env,
        },
      );
      const nativeId = retention === "retained" ? "0000000022" : "22";
      const legacyKey = `${resolveTelegramMessageCachePersistentScopeKey(params.scope)}:${params.accountId}:${chat.id}:${nativeId}`;
      await store.register(legacyKey, legacy);
      const cache = createTelegramMessageCache({ scope: params.scope });
      const identity = { accountId: params.accountId, chatId: chat.id, messageId: "22" };
      expect(await cache.get(identity)).toBeNull();
      expect(
        await cache.get({ ...identity, businessConnectionId: "business:A/opaque" }),
      ).toBeNull();
      expect((await cache.readHistory({ ...identity, limit: 10 })).messages).toEqual([]);
      expect(await cache.readHistoryWindow({ ...identity, limit: 10 })).toEqual([]);
      expect(await store.lookup(legacyKey)).toEqual(legacy);
    },
  );
}
