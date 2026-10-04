import { createHash } from "node:crypto";
import type { ChannelPresentationCapabilities } from "../channels/plugins/outbound.types.js";
import { presentationPageSize } from "../channels/plugins/outbound/presentation-limits.js";
import type {
  MessagePresentation,
  MessagePresentationAction,
  MessagePresentationButton,
  ModelPickerAction,
} from "../interactive/payload.js";
import type { ModelPickerCapabilityProfile } from "./capabilities.js";

export type ModelPickerCatalog = readonly {
  provider: string;
  id: string;
  name?: string;
  /** Undefined is unknown; an empty list is an admitted refusal. */
  runtimes?: readonly { id: string; label: string; description?: string }[];
}[];

export type ModelPickerMenuParams = {
  catalog: ModelPickerCatalog;
  capabilityProfile: ModelPickerCapabilityProfile;
  currentModel?: string;
  provider?: string;
  /** With provider, render the admitted runtime choices for this exact model. */
  model?: string;
  page?: number;
};

export type ModelPickerActionResolution =
  | { kind: "command"; action: Extract<MessagePresentationAction, { type: "command" }> }
  | { kind: "unavailable" };

/** Derive a picker profile from the same capabilities held by the outbound renderer. */
export function createModelPickerCapabilityProfile(
  presentation: ChannelPresentationCapabilities | undefined,
): ModelPickerCapabilityProfile | undefined {
  if (
    !presentation ||
    presentation.modelPicker !== true ||
    presentation.supported === false ||
    presentation.buttons === false
  ) {
    return undefined;
  }
  return {
    presentation,
    callback: { limit: presentation.limits?.actions?.maxValueBytes ?? 64, unit: "utf8-bytes" },
    response: {
      supportsEphemeral: false,
      supportsEdit: presentation.limits?.text?.supportsEdit === true,
      supportsReplace: presentation.limits?.text?.supportsEdit === true,
    },
  };
}

// The domain and tuple encoding keep provider, model, runtime and snapshot identities distinct.
// Twelve base64url characters leave room for all four tokens in a 64-byte private envelope.
function token(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(["openclaw-model-picker", domain, value]))
    .digest("base64url")
    .slice(0, 12);
}

function snapshotToken(catalog: ModelPickerCatalog): string {
  return token(
    "snapshot",
    catalog
      .map((row) =>
        JSON.stringify([
          row.provider,
          row.id,
          row.runtimes?.map((runtime) => runtime.id).toSorted() ?? null,
        ]),
      )
      .toSorted(),
  );
}

function providers(catalog: ModelPickerCatalog): string[] {
  return [...new Set(catalog.map((row) => row.provider))].toSorted();
}

function pageSize(profile: ModelPickerCapabilityProfile): number {
  return presentationPageSize(profile.presentation, 4, 8);
}

function safeProvider(provider: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider);
}

function safeModel(model: string): boolean {
  // The canonical parser splits the first slash and treats @ as an auth profile delimiter.
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(model);
}

function safeRuntime(runtime: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runtime);
}

function unique<T>(candidates: readonly T[]): T | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

function parsePage(cursor: string | undefined): number | undefined {
  if (cursor === undefined) {
    return 1;
  }
  if (!/^[1-9][0-9]{0,11}$/u.test(cursor)) {
    return undefined;
  }
  const page = Number(cursor);
  return Number.isSafeInteger(page) ? page : undefined;
}

/** Produce portable controls from admitted facts; no config, session or transport policy lives here. */
export function buildModelPickerMenu(
  params: ModelPickerMenuParams,
  admittedProviders?: readonly string[],
): {
  presentation: MessagePresentation;
  providerPage: readonly string[];
  navigation: readonly { label: string; command: string }[];
} {
  if (!createModelPickerCapabilityProfile(params.capabilityProfile.presentation)) {
    return { presentation: { blocks: [] }, providerPage: [], navigation: [] };
  }
  const base = {
    type: "model-picker" as const,
    version: 1 as const,
    snapshotToken: snapshotToken(params.catalog),
  };
  const buttons: MessagePresentationButton[] = [];
  const navigation: { label: string; command: string }[] = [];
  const unavailable: string[] = [];
  const add = (label: string, action: MessagePresentationAction, available = true) => {
    if (available) {
      buttons.push({ label, action });
    } else {
      unavailable.push(label);
    }
  };
  let providerPage: readonly string[] = [];
  let totalPages = 1;
  let currentPage = 1;
  if (params.provider && params.model) {
    const row = unique(
      params.catalog.filter(
        (entry) => entry.provider === params.provider && entry.id === params.model,
      ),
    );
    for (const runtime of row?.runtimes ?? []) {
      add(
        runtime.label,
        {
          ...base,
          intent: "choose-runtime",
          providerToken: token("provider", params.provider),
          modelToken: token("model", [params.provider, params.model]),
          runtimeToken: token("runtime", [params.provider, params.model, runtime.id]),
        },
        safeProvider(params.provider) &&
          safeModel(params.model) &&
          safeRuntime(runtime.id) &&
          row?.runtimes?.filter((candidate) => candidate.id === runtime.id).length === 1,
      );
    }
    if (buttons.length === 0) {
      unavailable.push("Runtime choices are unavailable. Open /models and choose again.");
    }
    add(
      "Back to models",
      {
        ...base,
        intent: "show-models",
        providerToken: token("provider", params.provider),
      },
      safeProvider(params.provider),
    );
  } else {
    const entries = params.provider
      ? params.catalog
          .filter((row) => row.provider === params.provider)
          .toSorted((a, b) => a.id.localeCompare(b.id))
      : [...new Set(admittedProviders ?? providers(params.catalog))]
          .toSorted()
          .map((provider) => ({ provider, id: "" }));
    const size = pageSize(params.capabilityProfile);
    totalPages = Math.max(1, Math.ceil(entries.length / size));
    currentPage = Math.min(totalPages, Math.max(1, Math.trunc(params.page ?? 1) || 1));
    const pageEntries = entries.slice((currentPage - 1) * size, currentPage * size);
    if (!params.provider) {
      providerPage = pageEntries.map((row) => row.provider);
    }
    for (const row of pageEntries) {
      if (params.provider) {
        const ref = row.provider + "/" + row.id;
        const model = unique(
          params.catalog.filter((entry) => entry.provider === row.provider && entry.id === row.id),
        );
        add(
          (ref === params.currentModel ? "✓ " : "") + (model?.name ?? row.id),
          {
            ...base,
            intent: "choose-model",
            providerToken: token("provider", row.provider),
            modelToken: token("model", [row.provider, row.id]),
          },
          Boolean(model) &&
            safeProvider(row.provider) &&
            safeModel(row.id) &&
            model?.runtimes?.length !== 0,
        );
      } else {
        add(
          row.provider +
            " (" +
            params.catalog.filter((entry) => entry.provider === row.provider).length +
            ")",
          params.catalog.some((entry) => entry.provider === row.provider)
            ? {
                ...base,
                intent: "show-models",
                providerToken: token("provider", row.provider),
              }
            : { type: "command", command: "/models list " + row.provider + " 1" },
          safeProvider(row.provider),
        );
      }
    }
    const pageAction = (page: number): MessagePresentationAction =>
      params.provider
        ? {
            ...base,
            intent: "show-models",
            providerToken: token("provider", params.provider),
            cursor: String(page),
          }
        : admittedProviders
          ? { type: "command", command: "/models page=" + page }
          : { ...base, intent: "show-providers", cursor: String(page) };
    const addPage = (label: string, page: number) => {
      const command = params.provider
        ? "/models list " + params.provider + " " + page
        : "/models page=" + page;
      navigation.push({ label, command });
      add(label, pageAction(page));
    };
    if (currentPage > 1) {
      addPage("Previous", currentPage - 1);
    }
    if (currentPage < totalPages) {
      addPage("Next", currentPage + 1);
    }
  }
  if (params.provider) {
    add("Providers", { ...base, intent: "show-providers" });
    add("Reset to default", { ...base, intent: "reset" });
  }
  return {
    providerPage,
    navigation,
    presentation: {
      blocks: [
        ...(totalPages > 1
          ? [{ type: "context" as const, text: "Page " + currentPage + "/" + totalPages }]
          : []),
        ...(buttons.length ? [{ type: "buttons" as const, buttons }] : []),
        ...(unavailable.length
          ? [{ type: "context" as const, text: "Unavailable:\n" + unavailable.join("\n") }]
          : []),
      ],
    },
  };
}

/** Public builder projects the same held menu selection used by core's text producer. */
export function buildModelPickerPresentation(params: ModelPickerMenuParams): MessagePresentation {
  return buildModelPickerMenu(params).presentation;
}

/** Resolve tokens against freshly admitted facts, then re-enter canonical command ingress. */
export function resolveModelPickerAction(params: {
  action: ModelPickerAction;
  catalog: ModelPickerCatalog;
  capabilityProfile: ModelPickerCapabilityProfile;
}): ModelPickerActionResolution {
  const { action, catalog, capabilityProfile } = params;
  const unavailable = { kind: "unavailable" as const };
  if (
    !createModelPickerCapabilityProfile(capabilityProfile.presentation) ||
    action.type !== "model-picker" ||
    action.version !== 1 ||
    action.snapshotToken !== snapshotToken(catalog)
  ) {
    return unavailable;
  }
  const command = (value: string): ModelPickerActionResolution => ({
    kind: "command",
    action: { type: "command", command: value },
  });
  if (action.intent === "reset") {
    return command("/model default -s");
  }
  if (action.intent === "cancel") {
    return command("/model status");
  }
  if (action.intent === "show-recents") {
    return unavailable;
  }
  if (action.intent === "show-providers") {
    const page = parsePage(action.cursor);
    return page &&
      page <= Math.max(1, Math.ceil(providers(catalog).length / pageSize(capabilityProfile)))
      ? command(page === 1 ? "/models" : "/models page=" + page)
      : unavailable;
  }
  const provider = unique(
    providers(catalog).filter((id) => token("provider", id) === action.providerToken),
  );
  if (!provider || !safeProvider(provider)) {
    return unavailable;
  }
  const rows = catalog.filter((row) => row.provider === provider);
  if (action.intent === "show-models") {
    const page = parsePage(action.cursor);
    return page && page <= Math.max(1, Math.ceil(rows.length / pageSize(capabilityProfile)))
      ? command("/models list " + provider + " " + page)
      : unavailable;
  }
  const row = unique(
    rows.filter((entry) => token("model", [provider, entry.id]) === action.modelToken),
  );
  if (!row || !safeModel(row.id) || row.runtimes?.length === 0) {
    return unavailable;
  }
  const ref = provider + "/" + row.id;
  if (action.intent === "choose-runtime") {
    const runtime = unique(
      (row.runtimes ?? []).filter(
        (entry) => token("runtime", [provider, row.id, entry.id]) === action.runtimeToken,
      ),
    );
    return runtime && safeRuntime(runtime.id)
      ? command("/model " + ref + " --runtime " + runtime.id + " -s")
      : unavailable;
  }
  if (action.intent !== "choose-model") {
    return unavailable;
  }
  return command(
    row.runtimes && row.runtimes.length > 1 ? "/models runtimes " + ref : "/model " + ref + " -s",
  );
}
