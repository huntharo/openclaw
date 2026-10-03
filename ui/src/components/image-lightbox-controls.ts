import { html, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";

export function renderLightboxAction(
  className: string,
  label: string,
  disabled: boolean,
  action: () => unknown,
  content: string | TemplateResult,
) {
  return html`<button
    class=${"action " + className}
    type="button"
    aria-label=${t(label)}
    aria-disabled=${disabled}
    @click=${action}
  >
    ${content}
  </button>`;
}

export function renderSvgAction(active: boolean, toggle: () => void) {
  return html`<button
    class="action svg-interaction"
    type="button"
    aria-pressed=${active}
    title=${t("chat.imageLightbox.svgInteractionHelp")}
    @click=${toggle}
  >
    ${t(active ? "chat.imageLightbox.svgPreview" : "chat.imageLightbox.svgInteract")}
  </button>`;
}

export function renderSvgFrame(document: string, title: string) {
  return html`<iframe
    class="interactive-svg"
    title=${t("chat.imageLightbox.svgLabel", { title })}
    sandbox=""
    referrerpolicy="no-referrer"
    .srcdoc=${document}
  ></iframe>`;
}

export function lightboxLabels(kind: "image" | "video", title: string) {
  return {
    dialogLabel:
      kind === "video"
        ? t("chat.mediaPlayer.videoPreview", { title })
        : t("chat.imageLightbox.label", { title }),
    closeLabel:
      kind === "video" ? t("chat.mediaPlayer.closeVideoPreview") : t("chat.imageLightbox.close"),
  };
}
