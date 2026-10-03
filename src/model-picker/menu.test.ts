import { describe, expect, it } from "vitest";
import type { MessagePresentation, ModelPickerAction } from "../interactive/payload.js";
import {
  buildModelPickerPresentation,
  createModelPickerCapabilityProfile,
  resolveModelPickerAction,
  type ModelPickerCatalog,
} from "./menu.js";

function createProfile() {
  const profile = createModelPickerCapabilityProfile({
    supported: true,
    buttons: true,
    modelPicker: true,
    limits: { actions: { maxValueBytes: 64, maxActions: 12, maxActionsPerRow: 3 } },
  });
  if (!profile) {
    throw new Error("Expected the opted-in profile");
  }
  return profile;
}
const profile = createProfile();

function picker(presentation: MessagePresentation, label: string): ModelPickerAction {
  const button = presentation.blocks
    .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
    .find((candidate) => candidate.label === label);
  if (button?.action?.type !== "model-picker") {
    throw new Error("Missing picker action: " + label);
  }
  return button.action;
}

function resolve(action: ModelPickerAction, catalog: ModelPickerCatalog) {
  return resolveModelPickerAction({ action, catalog, capabilityProfile: profile });
}

describe("portable model picker", () => {
  it("browses providers and selects a long slash-containing model through canonical session commands", () => {
    const id = "team/" + "long-model-".repeat(40);
    const catalog = [{ provider: "acme", id, name: "Long model" }];
    const providers = buildModelPickerPresentation({ catalog, capabilityProfile: profile });
    expect(resolve(picker(providers, "acme (1)"), catalog)).toEqual({
      kind: "command",
      action: { type: "command", command: "/models list acme 1" },
    });
    const models = buildModelPickerPresentation({
      catalog,
      capabilityProfile: profile,
      provider: "acme",
      currentModel: "acme/" + id,
    });
    const action = picker(models, "✓ Long model");
    expect(resolve(action, catalog)).toEqual({
      kind: "command",
      action: { type: "command", command: "/model acme/" + id + " -s" },
    });
    expect(action.snapshotToken).toMatch(/^[A-Za-z0-9_-]{12}$/u);
    expect(action.intent === "choose-model" && action.providerToken.length).toBe(12);
    expect(action.intent === "choose-model" && action.modelToken.length).toBe(12);
    expect(resolve(action, [])).toEqual({ kind: "unavailable" });
  });

  it("admits runtime navigation and rejects selections when the runtime catalog changes", () => {
    const openclaw = { id: "openclaw", label: "OpenClaw" };
    const row = {
      provider: "acme",
      id: "model",
      name: "Model",
      runtimes: [openclaw, { id: "agent-cli", label: "Agent CLI" }],
    };
    const catalog = [row];
    const models = buildModelPickerPresentation({
      catalog,
      capabilityProfile: profile,
      provider: "acme",
    });
    expect(resolve(picker(models, "Model"), catalog)).toEqual({
      kind: "command",
      action: { type: "command", command: "/models runtimes acme/model" },
    });
    const menu = buildModelPickerPresentation({
      catalog,
      capabilityProfile: profile,
      provider: "acme",
      model: "model",
    });
    const action = picker(menu, "Agent CLI");
    expect(resolve(action, catalog)).toEqual({
      kind: "command",
      action: { type: "command", command: "/model acme/model --runtime agent-cli -s" },
    });
    expect(action.intent === "choose-runtime" && action.runtimeToken.length).toBe(12);
    expect(resolve(action, [{ ...row, runtimes: [openclaw] }])).toEqual({
      kind: "unavailable",
    });
    expect(resolve(action, [{ ...row, runtimes: undefined }])).toEqual({
      kind: "unavailable",
    });
    expect(resolve(action, [{ ...row, runtimes: [] }])).toEqual({ kind: "unavailable" });
  });

  it("rejects conflicting rows instead of resolving the last matching token", () => {
    const row = { provider: "acme", id: "model", name: "Model" };
    const action = picker(
      buildModelPickerPresentation({
        catalog: [row],
        capabilityProfile: profile,
        provider: "acme",
      }),
      "Model",
    );
    const duplicateCatalog = [row, { ...row, name: "Different label" }];
    const duplicateMenu = buildModelPickerPresentation({
      catalog: duplicateCatalog,
      capabilityProfile: profile,
      provider: "acme",
    });
    const currentSnapshot = picker(duplicateMenu, "Reset to default").snapshotToken;
    expect(resolve({ ...action, snapshotToken: currentSnapshot }, duplicateCatalog)).toEqual({
      kind: "unavailable",
    });
    expect(duplicateMenu.blocks).toContainEqual({
      type: "context",
      text: "Unavailable:\nmodel\nmodel",
    });
  });

  it.each([
    ["provider/model", "model", undefined],
    ["acme", "model@profile", undefined],
    ["acme", "model --runtime injected", undefined],
    ["acme", "model\n/model other", undefined],
    ["acme", "model", [{ id: "agent-cli -g", label: "Unsafe runtime" }]],
    ["acme", "model", []],
  ])(
    "leaves unrepresentable or refused catalog rows visibly unavailable (%s, %s)",
    (provider, id, runtimes) => {
      const catalog = [{ provider, id, runtimes }];
      const menu = buildModelPickerPresentation({
        catalog,
        capabilityProfile: profile,
        provider,
        ...(runtimes?.length ? { model: id } : {}),
      });
      expect(
        menu.blocks.some(
          (block) => block.type === "context" && block.text.startsWith("Unavailable:"),
        ),
      ).toBe(true);
      expect(
        menu.blocks
          .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
          .some(
            (button) =>
              button.action?.type === "model-picker" &&
              ["choose-model", "choose-runtime"].includes(button.action.intent),
          ),
      ).toBe(false);
    },
  );

  it("uses the admitted snapshot independent of catalog ordering and rejects forged pagination", () => {
    const catalog = Array.from({ length: 10 }, (_, i) => ({ provider: "p" + i, id: "model" }));
    const menu = buildModelPickerPresentation({ catalog, capabilityProfile: profile });
    const action = picker(menu, "Next");
    expect(resolve(action, catalog.toReversed())).toEqual({
      kind: "command",
      action: { type: "command", command: "/models page=2" },
    });
    expect(resolve({ ...action, intent: "show-providers", cursor: "999" }, catalog)).toEqual({
      kind: "unavailable",
    });
    expect(
      resolve({ ...action, intent: "show-providers", cursor: "2 /model other" }, catalog),
    ).toEqual({ kind: "unavailable" });
  });
});
