import { html, type TemplateResult } from "lit";
import { INTERACTIVE_SVG_VIEWER_PATH } from "../../../src/shared/interactive-svg-viewer.js";
import { resolveControlUiPaths } from "../app/browser.ts";
import { t } from "../i18n/index.ts";
import { registerInteractiveSvgEnglish } from "../i18n/locales/en-interactive-svg.ts";

registerInteractiveSvgEnglish();

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

export function renderSvgFrame(
  title: string,
  scheme: "light" | "dark",
  loaded: (frame: HTMLIFrameElement) => void,
) {
  const [, resourceBasePath] = resolveControlUiPaths(window.location.pathname);
  return html`<iframe
    class="interactive-svg"
    title=${t("chat.imageLightbox.svgLabel", { title })}
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    style=${`color-scheme: ${scheme}`}
    src=${`${resourceBasePath}${INTERACTIVE_SVG_VIEWER_PATH}`}
    @load=${(event: Event) => {
      // SAFETY: Lit attaches this listener only to the iframe rendered here.
      loaded(event.currentTarget as HTMLIFrameElement);
    }}
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
