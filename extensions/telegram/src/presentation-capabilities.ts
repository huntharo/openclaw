// Outbound metadata and both reply renderers share this capability declaration.
export const TELEGRAM_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  modelPicker: true,
  selects: true,
  context: true,
  divider: false,
  // Native table blocks require the account's Bot API 10.3 rich-message path;
  // per-account capability resolution flips this on when richMessages is enabled.
  tables: false,
  limits: {
    actions: {
      maxActions: 100,
      maxActionsPerRow: 3,
      maxValueBytes: 64,
      supportsStyles: false,
      supportsDisabled: false,
    },
    selects: {
      maxOptions: 100,
    },
    text: {
      supportsEdit: true,
      markdownDialect: "markdown" as const,
    },
  },
};

export function resolveTelegramPresentationCapabilities(params: {
  richMessages: boolean;
}): typeof TELEGRAM_PRESENTATION_CAPABILITIES {
  return params.richMessages
    ? { ...TELEGRAM_PRESENTATION_CAPABILITIES, tables: true }
    : TELEGRAM_PRESENTATION_CAPABILITIES;
}
