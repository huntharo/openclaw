import type { KeybindingsConfig } from "../keybindings.js";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = new Set<string>([
  "app.interrupt",
  "app.clear",
  "app.exit",
  "app.suspend",
  "app.thinking.cycle",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.model.select",
  "app.tools.expand",
  "app.thinking.toggle",
  "app.editor.external",
  "app.message.followUp",
  "tui.input.submit",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.input.copy",
  "tui.editor.deleteToLineEnd",
]);

type BuiltInKeyBindings = Record<
  string,
  { keybinding: string; restrictOverride: boolean } | undefined
>;

export const buildBuiltinKeybindings = (
  resolvedKeybindings: KeybindingsConfig,
): BuiltInKeyBindings => {
  const builtinKeybindings: BuiltInKeyBindings = {};
  for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
    if (keys === undefined) {
      continue;
    }
    const keyList = Array.isArray(keys) ? keys : [keys];
    const restrictOverride = RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS.has(keybinding);
    for (const key of keyList) {
      const normalizedKey = key.toLowerCase();
      // If multiple actions bind the same key, the reserved action wins so extensions
      // remain blocked by reserved shortcuts regardless of iteration order.
      const existing = builtinKeybindings[normalizedKey];
      if (existing?.restrictOverride && !restrictOverride) {
        continue;
      }
      builtinKeybindings[normalizedKey] = {
        keybinding,
        restrictOverride,
      };
    }
  }
  return builtinKeybindings;
};
