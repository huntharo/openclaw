import { html, nothing, type TemplateResult } from "lit";
import { INTERACTIVE_SVG_VIEWER_PATH } from "../../../src/shared/interactive-svg-viewer.js";
import { resolveControlUiPaths } from "../app/browser.ts";
import { t } from "../i18n/index.ts";
import { registerInteractiveSvgEnglish } from "../i18n/locales/en-interactive-svg.ts";
import { icons } from "./icons.ts";

registerInteractiveSvgEnglish();

export function renderLightboxOriginalLink(url: string, preparing: boolean) {
  return url || preparing
    ? html`<a
        class="action open-original"
        href=${url || nothing}
        aria-disabled=${!url}
        tabindex=${url ? 0 : -1}
        target="_blank"
        rel="noreferrer"
        aria-label=${t("chat.imageLightbox.openOriginal")}
      >
        <span class="open-original-label">${t("chat.imageLightbox.openOriginal")}</span>
        <span class="open-original-icon" aria-hidden="true">${icons.externalLink}</span>
      </a>`
    : nothing;
}

export function renderLightboxImage(options: {
  src: string;
  title: string;
  scale: number;
  width?: number;
  height?: number;
  interactive: boolean;
  loaded: (event: Event) => void;
  failed: (event: Event) => void;
  clicked: (event: MouseEvent) => void;
  keydown: (event: KeyboardEvent) => void;
}) {
  const { width, height } = options;
  const sized = Number.isFinite(width) && width! > 0 && Number.isFinite(height) && height! > 0;
  const imageSize = sized
    ? `width: min(${width}px, 100cqw, calc(100cqh * ${width! / height!}))`
    : nothing;
  const hint = options.interactive ? t("chat.imageLightbox.svgClickHint") : nothing;
  return html`<div class="slide">
    <img
      class=${options.scale > 1 ? "image zoomed" : "image"}
      style=${imageSize}
      src=${options.src}
      alt=${options.title}
      role=${options.interactive ? "button" : nothing}
      tabindex=${options.interactive ? "0" : nothing}
      title=${hint}
      aria-description=${hint}
      referrerpolicy="no-referrer"
      @load=${options.loaded}
      @error=${options.failed}
      @dragstart=${(event: DragEvent) => event.preventDefault()}
      @click=${options.clicked}
      @keydown=${options.keydown}
    />
  </div>`;
}

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
