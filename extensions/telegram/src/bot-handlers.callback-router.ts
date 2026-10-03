import type { Context } from "grammy";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  capturePureSessionBindingAdapterSelection,
  readConversationBindingRouteObservations,
  matchesConversationBindingRouteFacts,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  createModelPickerCapabilityProfile,
  resolveModelPickerAction,
  type ModelPickerCatalog,
} from "openclaw/plugin-sdk/interactive-runtime";
import { captureRuntimeConfigPublicationCurrent } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  hasTelegramApprovalCallbackPrefix,
  parseTelegramApprovalCallbackData,
} from "./approval-callback-data.js";
import {
  createTelegramCallbackMessageActions,
  handleTelegramQuestionCallback,
  sendTelegramQuestionFeedback,
} from "./bot-handlers.callback-actions.js";
import {
  createTelegramCallbackApprovalRuntime,
  handleTelegramInteractiveCallback,
  isPermanentTelegramCallbackEditError,
  type TelegramCallbackMessageRuntime,
  TelegramRetryableCallbackError,
} from "./bot-handlers.callback-router-controls.js";
import type {
  TelegramEventAuthorizationMode,
  TelegramHandlerAuthorization,
} from "./bot-handlers.inbound-authorization.js";
import {
  buildSyntheticContext,
  buildSyntheticTextMessage,
} from "./bot-handlers.message-context.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import {
  resolveTelegramForumFlag,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramMessageThreadSpec,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import {
  getTelegramCallbackQueryAnswerPromise,
  startTelegramCallbackQueryAnswer,
} from "./callback-query-answer-state.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { isTelegramMessageFromCurrentBot } from "./message-cache-codec.js";
import {
  hasTelegramModelPickerCallbackPrefix,
  parseTelegramModelPickerCallbackData,
} from "./model-picker-callback-data.js";
import {
  hasTelegramOpaqueCallbackPrefix,
  parseTelegramNativeCommandCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import { isTelegramMessageNotModifiedError } from "./network-errors.js";
import { getTelegramObservedMessageCache } from "./outbound-message-context.js";
import { TELEGRAM_PRESENTATION_CAPABILITIES } from "./presentation-capabilities.js";
import {
  hasTelegramQuestionCallbackPrefix,
  parseTelegramQuestionCallbackData,
} from "./question-callback-data.js";
import { editMessageReplyMarkupTelegram } from "./send.js";
import { buildTelegramConversationId } from "./topic-conversation.js";

export function createTelegramCallbackRouter({
  params: {
    accountId,
    bot,
    runtime,
    telegramDeps,
    shouldSkipUpdate,
    nativeCommandCallbackDispatcher,
    opts,
  },
  message: messageRuntime,
  authorization: authorizationRuntime,
}: {
  params: Pick<
    RegisterTelegramHandlerParams,
    | "accountId"
    | "bot"
    | "runtime"
    | "telegramDeps"
    | "shouldSkipUpdate"
    | "nativeCommandCallbackDispatcher"
    | "opts"
  >;
  message: TelegramCallbackMessageRuntime;
  authorization: Pick<
    TelegramHandlerAuthorization,
    | "resolveTelegramEventAuthorizationContext"
    | "authorizeTelegramEventSender"
    | "isTelegramModelCallbackAuthorized"
  >;
}) {
  const { processMessageWithReplyChain } = messageRuntime;
  const {
    resolveTelegramEventAuthorizationContext,
    authorizeTelegramEventSender,
    isTelegramModelCallbackAuthorized,
  } = authorizationRuntime;
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);
  const activeMenus = new Map<string, AbortController>();

  const handleCallback = async (ctx: Context) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    const authorizationCfg = telegramDeps.getRuntimeConfig();
    const publicationCurrent = captureRuntimeConfigPublicationCurrent(authorizationCfg);
    const answerCallbackQuery = async () => {
      await withTelegramApiErrorLogging({
        operation: "answerCallbackQuery",
        runtime,
        fn: () => startTelegramCallbackQueryAnswer(bot, callback.id, false),
      }).catch(() => {});
    };
    const skipUpdate = shouldSkipUpdate(ctx);
    const data = (callback.data ?? "").trim();
    const typedQuestionCallback = parseTelegramQuestionCallbackData(data);
    const earlyAnswerPromise = getTelegramCallbackQueryAnswerPromise(ctx);
    if (earlyAnswerPromise) {
      await earlyAnswerPromise.catch(answerCallbackQuery);
    } else {
      await answerCallbackQuery();
    }
    if (skipUpdate) {
      return;
    }

    let menuFeedback: (() => Promise<unknown>) | undefined;
    let releaseMenu: (() => void) | undefined;
    let disposeSource: (() => void) | undefined;
    let menuSourceEdit: Parameters<typeof editMessageReplyMarkupTelegram>[3] | undefined;
    try {
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
      const isNativeMenuCommand = /^\/(?:commands|models)(?:\s|$)/u.test(
        nativeCallbackCommand ?? "",
      );
      const legacyPage = /^commands_page_([1-9][0-9]*|noop)(?::.+)?$/.exec(data);
      const pickerAction = parseTelegramModelPickerCallbackData(data);
      const hasLegacyModelPrefix = data.startsWith("mdl1~") || data.startsWith("mdl_");
      const hasReservedModelPrefix =
        hasTelegramModelPickerCallbackPrefix(data) || hasLegacyModelPrefix;
      const isMenuCallback = hasReservedModelPrefix || Boolean(legacyPage) || isNativeMenuCommand;
      const hasReservedOpaquePrefix = hasTelegramOpaqueCallbackPrefix(data);
      const opaqueCallbackData = parseTelegramOpaqueCallbackData(callback.data?.trimStart());
      const genericCallbackText = data.startsWith("/") ? data : `callback_data: ${data}`;
      const callbackCommandText =
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : genericCallbackText);
      const hasReservedApprovalPrefix = hasTelegramApprovalCallbackPrefix(data);
      const hasReservedQuestionPrefix = hasTelegramQuestionCallbackPrefix(data);
      const typedApprovalCallback = parseTelegramApprovalCallbackData(data);
      const legacyApprovalCallback = parseExecApprovalCommandText(
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : data),
      );
      const isApprovalCallback = hasReservedApprovalPrefix || legacyApprovalCallback !== null;
      const isRuntimeControlCallback = isApprovalCallback || hasReservedQuestionPrefix;
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: authorizationCfg,
        accountId,
      });
      const inlineButtonsUnavailable =
        inlineButtonsScope === "off" ||
        (inlineButtonsScope === "dm" && isGroup) ||
        (inlineButtonsScope === "group" && !isGroup);
      // Runtime controls retain their authorization after inline-button capability changes.
      // Stale typed controls cross this gate only to render their terminal result.
      if (
        !isRuntimeControlCallback &&
        inlineButtonsUnavailable &&
        !nativeCallbackCommand &&
        !hasReservedOpaquePrefix &&
        !hasReservedModelPrefix
      ) {
        return;
      }

      const isForum = await resolveTelegramForumFlag({
        chatId,
        chatType: callbackMessage.chat.type,
        isGroup,
        isForum: callbackMessage.chat.is_forum,
        isTopicMessage: callbackMessage.is_topic_message,
        getChat,
      });
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        cfg: authorizationCfg,
        chatId,
        isGroup,
        senderId,
        threadSpec: resolveTelegramMessageThreadSpec(callbackMessage, isForum),
      });
      const threadSpec = eventAuthContext.threadSpec;
      const { dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
      const requireTopic = (groupConfig as { requireTopic?: boolean } | undefined)?.requireTopic;
      if (!isGroup && requireTopic === true && dmThreadId == null) {
        logVerbose(
          `Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`,
        );
        return;
      }
      const actions = createTelegramCallbackMessageActions({
        bot,
        callbackMessage,
        threadSpec,
        cfg: authorizationCfg,
        accountId,
      });
      const clearRoutedCallbackButtons = async () => {
        try {
          if (menuSourceEdit) {
            await editMessageReplyMarkupTelegram(
              chatId,
              callbackMessage.message_id,
              [],
              menuSourceEdit,
            );
          } else {
            await actions.clearCallbackButtons();
          }
        } catch (editErr) {
          if (
            !isTelegramMessageNotModifiedError(editErr) &&
            !isPermanentTelegramCallbackEditError(editErr)
          ) {
            throw new TelegramRetryableCallbackError(editErr);
          }
        }
      };
      const terminalizeUnavailableCallback = async () => {
        logVerbose("telegram: typed callback unavailable (handler missing or payload invalid)");
        await clearRoutedCallbackButtons();
        await actions.replyToCallbackChat("This action is no longer available.");
      };

      if (
        inlineButtonsUnavailable &&
        !isMenuCallback &&
        ((nativeCallbackCommand && !legacyApprovalCallback) ||
          hasReservedOpaquePrefix ||
          hasReservedModelPrefix)
      ) {
        await terminalizeUnavailableCallback();
        return;
      }
      if (nativeCallbackCommand && !isNativeMenuCommand && nativeCommandCallbackDispatcher) {
        const dispatch = await nativeCommandCallbackDispatcher({
          botUser: ctx.me,
          callbackQuery: callback,
          commandText: nativeCallbackCommand,
        });
        if (dispatch.handled) {
          if (dispatch.clearButtons) {
            await clearRoutedCallbackButtons();
          }
          return;
        }
      }
      const authorizationMode: TelegramEventAuthorizationMode = hasReservedQuestionPrefix
        ? "callback-runtime-allowlist"
        : !isGroup || (!isRuntimeControlCallback && inlineButtonsScope === "allowlist")
          ? "callback-allowlist"
          : "callback-scope";
      const senderAuthorization = await authorizeTelegramEventSender({
        chatId,
        chatTitle: callbackMessage.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: authorizationMode,
        context: eventAuthContext,
      });
      if (!senderAuthorization) {
        return;
      }

      const callbackConversationId = buildTelegramConversationId({ chatId, thread: threadSpec });
      const callbackThreadId = threadSpec.id;
      const runtimeCfg = authorizationCfg;
      const approvalRuntime = createTelegramCallbackApprovalRuntime({
        accountId,
        telegramDeps,
        runtimeCfg,
        senderId,
        actions,
      });
      const authorizeCallback = async () =>
        await isTelegramModelCallbackAuthorized({
          chatId,
          isGroup,
          senderId,
          context: eventAuthContext,
        });
      if (typedApprovalCallback) {
        await approvalRuntime.handleCanonical(typedApprovalCallback);
        return;
      }
      if (typedQuestionCallback) {
        await handleTelegramQuestionCallback({
          callback: typedQuestionCallback,
          cfg: runtimeCfg,
          senderId,
          feedback: async (text, mode) =>
            await sendTelegramQuestionFeedback({
              actions,
              text,
              mode,
              isGroup,
              user: callback.from,
            }),
        });
        return;
      }
      if (hasReservedQuestionPrefix) {
        return;
      }
      if (hasReservedApprovalPrefix) {
        await approvalRuntime.handleMalformedReserved();
        return;
      }
      if (
        !nativeCallbackCommand &&
        !hasReservedModelPrefix &&
        !legacyPage &&
        !isNativeMenuCommand &&
        !inlineButtonsUnavailable &&
        (await handleTelegramInteractiveCallback({
          accountId,
          callback,
          ctx,
          callbackMessage,
          data,
          pluginCallbackData: opaqueCallbackData ?? data,
          callbackConversationId,
          callbackThreadId,
          senderId,
          senderUsername,
          isGroup,
          isForum,
          storeAllowFrom,
          actions,
          messageRuntime,
          authorizeCallback,
        }))
      ) {
        return;
      }
      if (legacyApprovalCallback) {
        await approvalRuntime.handleLegacy(legacyApprovalCallback);
        return;
      }
      if (hasReservedOpaquePrefix) {
        await terminalizeUnavailableCallback();
        return;
      }
      let menuCommand: string | undefined;
      let callbackReply: import("./bot-message-context.types.js").TelegramMessageContextOptions["callbackReply"];
      if (legacyPage?.[1] === "noop") {
        return;
      }
      if (isMenuCallback) {
        if (
          callbackMessage.date <= 0 ||
          !isTelegramMessageFromCurrentBot(callbackMessage, ctx.me.id) ||
          !callbackMessage.reply_markup?.inline_keyboard.some((row) =>
            row.some((button) => "callback_data" in button && button.callback_data === data),
          )
        ) {
          await actions.replyToCallbackChat(
            "This menu is no longer current. Send /models or /commands again.",
          );
          return;
        }
        menuFeedback = () =>
          actions.replyToCallbackChat("Could not use this menu. Send /models or /commands again.");
        const key = JSON.stringify([
          callbackMessage.business_connection_id ?? null,
          chatId,
          callbackMessage.message_id,
        ]);
        const controller = new AbortController();
        activeMenus.get(key)?.abort(new Error("A newer menu interaction replaced this request."));
        activeMenus.set(key, controller);
        releaseMenu = () => {
          if (activeMenus.get(key) === controller) {
            activeMenus.delete(key);
          }
        };
        let assertRouteCurrent: (() => void) | undefined;
        // oxlint-disable-next-line prefer-const -- Initial admission checks run before the awaited source capture initializes this closure.
        let assertSourceCurrent: (() => void) | undefined;
        const assertCurrent = () => {
          controller.signal.throwIfAborted();
          opts.fetchAbortSignal?.throwIfAborted();
          if (
            activeMenus.get(key) !== controller ||
            telegramDeps.getRuntimeConfig() !== runtimeCfg ||
            publicationCurrent?.() === false
          ) {
            throw new Error("This menu changed while preparing the command. Send a new request.");
          }
          assertRouteCurrent?.();
          assertSourceCurrent?.();
        };
        const revalidate = async () => {
          assertCurrent();
          const currentContext = await resolveTelegramEventAuthorizationContext({
            cfg: runtimeCfg,
            chatId,
            isGroup,
            senderId,
            threadSpec,
          });
          assertCurrent();
          if (
            !(await isTelegramModelCallbackAuthorized({
              chatId,
              isGroup,
              senderId,
              context: currentContext,
            }))
          ) {
            throw new Error("You are no longer authorized to use this menu.");
          }
          assertCurrent();
        };
        menuSourceEdit = {
          cfg: runtimeCfg,
          api: bot.api,
          token: opts.token,
          accountId,
          businessConnectionId: callbackMessage.business_connection_id,
          signal: controller.signal,
          assertPlatformSendAuthorized: assertCurrent,
        };
        assertCurrent();
        const cache = getTelegramObservedMessageCache({ cfg: runtimeCfg, accountId });
        const source = cache.beginObservedMessageCapture({
          accountId,
          chatId,
          messageId: String(callbackMessage.message_id),
          businessConnectionId: callbackMessage.business_connection_id,
        });
        disposeSource = source.dispose;
        const admitted =
          (await cache.get({
            accountId,
            chatId,
            messageId: String(callbackMessage.message_id),
            businessConnectionId: callbackMessage.business_connection_id,
          })) ??
          (await cache.record({
            accountId,
            chatId,
            msg: callbackMessage,
            botUserId: ctx.me.id,
            observationMode: "partial",
          }));
        assertCurrent();
        source.capture(admitted, callbackMessage);
        assertSourceCurrent = source.assertCurrent;
        const session = await messageRuntime.resolveTelegramSessionState({
          chatId,
          isGroup,
          threadSpec,
          botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
          senderId,
          runtimeCfg,
        });
        assertCurrent();
        const observations = readConversationBindingRouteObservations(session.route);
        const readSelection = capturePureSessionBindingAdapterSelection(
          observations.map((observation) => observation.conversation),
        );
        if (readSelection) {
          assertRouteCurrent = () => {
            const selected = readSelection();
            if (
              observations.some(
                (observation, index) =>
                  !matchesConversationBindingRouteFacts(observation, selected[index] ?? null),
              )
            ) {
              throw new Error("This menu's conversation route changed. Send a new request.");
            }
          };
        }
        await revalidate();
        // Delivered legacy menus have no admitted catalog snapshot. Retire them visibly.
        if (
          inlineButtonsUnavailable ||
          hasLegacyModelPrefix ||
          (hasReservedModelPrefix && !pickerAction)
        ) {
          assertCurrent();
          await terminalizeUnavailableCallback();
          return;
        }
        if (pickerAction) {
          const modelData = await telegramDeps.buildModelsProviderData(
            runtimeCfg,
            session.agentId,
            {
              sessionEntry: session.sessionEntry,
            },
          );
          await revalidate();
          if (modelData.isCurrent?.() === false) {
            assertCurrent();
            await terminalizeUnavailableCallback();
            return;
          }
          const names = modelData.modelMenu?.modelNames ?? modelData.modelNames;
          const catalog: ModelPickerCatalog = modelData.providers.flatMap((provider) =>
            [...(modelData.byProvider.get(provider) ?? [])].map((id) => ({
              provider,
              id,
              name: names.get(`${provider}/${id}`),
              runtimes: modelData.runtimeChoicesByModel?.get(`${provider}/${id}`),
            })),
          );
          const capabilityProfile = createModelPickerCapabilityProfile(
            TELEGRAM_PRESENTATION_CAPABILITIES,
          );
          const resolved = capabilityProfile
            ? resolveModelPickerAction({ action: pickerAction, catalog, capabilityProfile })
            : { kind: "unavailable" as const };
          if (resolved.kind !== "command") {
            assertCurrent();
            await terminalizeUnavailableCallback();
            return;
          }
          menuCommand = resolved.action.command;
        } else {
          // Old pagination suffixes never choose an agent: canonical ingress resolves its route.
          menuCommand = legacyPage
            ? `/commands ${legacyPage[1]}`
            : (nativeCallbackCommand ?? undefined);
        }
        callbackReply = {
          messageId: callbackMessage.message_id,
          businessConnectionId: callbackMessage.business_connection_id,
          commandSelectionCurrent: { publicationCurrent, assertRouteCurrent: assertCurrent },
          abortSignal: opts.fetchAbortSignal
            ? AbortSignal.any([controller.signal, opts.fetchAbortSignal])
            : controller.signal,
          revalidate,
          assertCurrent,
        };
      }
      if (hasReservedModelPrefix && !menuCommand) {
        await terminalizeUnavailableCallback();
        return;
      }

      const hasCallbackInlineKeyboard =
        (callbackMessage.reply_markup?.inline_keyboard?.length ?? 0) > 0;
      if (hasCallbackInlineKeyboard && !callbackReply) {
        await clearRoutedCallbackButtons();
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: withResolvedTelegramForumFlag(callbackMessage, isForum),
        from: callback.from,
        text: menuCommand ?? callbackCommandText,
      });
      const syntheticCtx = buildSyntheticContext(ctx, syntheticMessage);
      const result = await processMessageWithReplyChain({
        ctx: syntheticCtx,
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom,
        options: {
          threadSpec,
          ...(nativeCallbackCommand || menuCommand ? { commandSource: "native" as const } : {}),
          ...(callbackReply ? { callbackReply } : {}),
          forceWasMentioned: true,
          messageIdOverride: callback.id,
        },
      });
      if (callbackReply && result.kind !== "completed") {
        await menuFeedback?.();
      }
    } catch (err) {
      await menuFeedback?.().catch(() => {});
      if (err instanceof TelegramRetryableCallbackError) {
        if (isPermanentTelegramCallbackEditError(err.cause)) {
          logVerbose(`telegram: swallowing permanent callback edit error: ${String(err.cause)}`);
          return;
        }
        runtime.error?.(danger(`callback handler failed: ${String(err)}`));
        throw err.cause;
      }
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
      if (isTelegramSpooledReplayUpdate(ctx.update)) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
      }
    } finally {
      disposeSource?.();
      releaseMenu?.();
    }
  };

  return { route: handleCallback };
}
