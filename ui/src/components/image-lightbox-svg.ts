import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { MAX_INTERACTIVE_SVG_DOCUMENT_LENGTH } from "../../../src/shared/interactive-svg-viewer.js";
import { t } from "../i18n/index.ts";
import { registerInteractiveSvgEnglish } from "../i18n/locales/en-interactive-svg.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";
import { interactiveSvgDocument, SVG_SEARCH_TERM_MAX_LENGTH } from "./interactive-svg-document.ts";

registerInteractiveSvgEnglish();

type SvgSource = NonNullable<ImageLightboxItem["svgSource"]>;
type ActiveSvg = Readonly<{ source: SvgSource; document: string; scheme: "light" | "dark" }>;
type SvgControllerOptions = {
  readItem: () => ImageLightboxItem | undefined;
  getFrame: () => HTMLIFrameElement | null;
  invalidate: () => void;
  closeViewer: () => void;
  readColorScheme: () => "light" | "dark";
};

export class ImageLightboxSvgController {
  private selectedSource?: SvgSource;
  private prepared?: ActiveSvg;
  private failure?: "document" | "encoding";
  private activated = false;
  private published = false;
  private shellReady = false;
  private shellLoaded = false;
  private frame?: HTMLIFrameElement;
  private frameWindow?: Window;
  private deadline?: ReturnType<typeof setTimeout>;
  private listening = false;
  private searchVisible = false;
  private term = "";
  private searchFailed = false;
  private searchInput?: HTMLInputElement;

  constructor(private readonly options: SvgControllerOptions) {}

  private readSource() {
    const item = this.options.readItem();
    return item?.kind !== "video" && item?.svgSource?.src === item?.src
      ? item?.svgSource
      : undefined;
  }

  get available() {
    return this.readSource() !== undefined;
  }

  get active(): ActiveSvg | undefined {
    return this.prepared?.source === this.readSource() ? this.prepared : undefined;
  }

  get loading() {
    return this.active !== undefined && !this.activated;
  }

  get error() {
    return this.failure !== undefined && this.selectedSource === this.readSource();
  }

  get searchOpen() {
    return this.active !== undefined && this.searchVisible;
  }

  get searchTerm() {
    return this.term;
  }

  get searchError() {
    return this.searchOpen && this.searchFailed;
  }

  toggle() {
    if (this.prepared) {
      this.reset();
      return;
    }
    this.clear();
    const source = this.readSource();
    if (!source) {
      return;
    }
    this.selectedSource = source;
    if ("decodeError" in source) {
      this.failure = "encoding";
      this.options.invalidate();
      return;
    }
    try {
      const scheme = this.options.readColorScheme();
      const document = interactiveSvgDocument(source.text, scheme);
      if (document.length > MAX_INTERACTIVE_SVG_DOCUMENT_LENGTH) {
        throw new Error("Interactive SVG document exceeds the viewer limit");
      }
      this.prepared = { source, document, scheme };
      window.addEventListener("message", this.handleMessage);
      this.listening = true;
      this.startDeadline();
    } catch {
      this.failure = "document";
    }
    this.options.invalidate();
  }

  bind(frame: HTMLIFrameElement | null) {
    if (!this.prepared) {
      return;
    }
    if (!this.active || !frame?.contentWindow || this.options.getFrame() !== frame) {
      this.reset();
      return;
    }
    if (this.frame === frame && this.frameWindow === frame.contentWindow) {
      return;
    }
    const wasActivated = this.activated;
    this.frame = frame;
    this.frameWindow = frame.contentWindow;
    this.published = false;
    this.shellReady = false;
    this.shellLoaded = false;
    this.activated = false;
    if (this.deadline === undefined) {
      this.startDeadline();
    }
    if (wasActivated) {
      this.options.invalidate();
    }
  }

  private currentWindow() {
    return this.active &&
      this.frame === this.options.getFrame() &&
      this.frameWindow === this.frame?.contentWindow
      ? this.frameWindow
      : undefined;
  }

  frameLoaded(frame: HTMLIFrameElement) {
    if (frame !== this.frame || !this.currentWindow()) {
      return;
    }
    if (this.published || this.shellLoaded) {
      this.retireDocument();
      return;
    }
    this.shellLoaded = true;
    this.publishDocument();
  }

  private retireDocument() {
    const source = this.selectedSource;
    this.clear();
    this.selectedSource = source;
    this.failure = "document";
    this.options.invalidate();
  }

  private publishDocument() {
    const frameWindow = this.currentWindow();
    if (!frameWindow || !this.shellReady || !this.shellLoaded || this.published || !this.active) {
      return;
    }
    this.published = true;
    frameWindow.postMessage({ type: "openclaw-svg-document", document: this.active.document }, "*");
  }

  private handleMessage = (event: MessageEvent) => {
    const frameWindow = this.currentWindow();
    if (!frameWindow || event.source !== frameWindow || event.origin !== "null") {
      return;
    }
    if (event.data === "openclaw-svg-retired") {
      this.retireDocument();
      return;
    }
    if (event.data === "openclaw-svg-ready") {
      this.shellReady = true;
      this.publishDocument();
      return;
    }
    if (event.data === "openclaw-svg-active" && this.published) {
      this.activated = true;
      this.clearDeadline();
      this.options.invalidate();
      return;
    }
    if (!this.activated) {
      return;
    }
    if (event.data === "openclaw-svg-escape") {
      if (!this.dismissSearch()) {
        this.reset();
        this.options.closeViewer();
      }
    } else if (event.data === "openclaw-svg-search" || event.data === "openclaw-svg-search-error") {
      this.searchVisible = true;
      this.searchFailed = event.data === "openclaw-svg-search-error";
      this.options.invalidate();
      this.searchInput?.focus();
    }
  };

  setSearchTerm(term: string) {
    this.term = term.slice(0, SVG_SEARCH_TERM_MAX_LENGTH);
    this.searchFailed = false;
    this.options.invalidate();
  }

  submitSearch() {
    const frameWindow = this.currentWindow();
    if (!frameWindow || !this.activated) {
      return;
    }
    frameWindow.postMessage({ type: "openclaw-svg-search-term", term: this.term }, "*");
    this.searchVisible = false;
    this.searchFailed = false;
    this.options.invalidate();
    this.frame?.focus();
  }

  dismissSearch() {
    if (!this.searchOpen) {
      return false;
    }
    this.searchVisible = false;
    this.searchFailed = false;
    this.options.invalidate();
    this.frame?.focus();
    return true;
  }

  private clearDeadline() {
    if (this.deadline !== undefined) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
    }
  }

  private startDeadline() {
    this.deadline = setTimeout(() => {
      const source = this.selectedSource;
      const current = source === this.readSource();
      this.clear();
      if (current) {
        this.selectedSource = source;
        this.failure = "document";
      }
      this.options.invalidate();
    }, 10_000);
  }

  private clear() {
    this.clearDeadline();
    if (this.listening) {
      window.removeEventListener("message", this.handleMessage);
      this.listening = false;
    }
    this.selectedSource = undefined;
    this.prepared = undefined;
    this.failure = undefined;
    this.activated = false;
    this.published = false;
    this.shellReady = false;
    this.shellLoaded = false;
    this.frame = undefined;
    this.frameWindow = undefined;
    this.searchVisible = false;
    this.term = "";
    this.searchFailed = false;
    this.searchInput = undefined;
  }

  reset() {
    const changed = this.prepared !== undefined || this.failure !== undefined;
    this.clear();
    if (changed) {
      this.options.invalidate();
    }
  }

  dispose() {
    this.clear();
  }

  renderAction(toggle: () => void = () => this.toggle()) {
    return this.available
      ? html`<button
          class="action svg-interaction"
          type="button"
          aria-pressed=${this.active !== undefined}
          title=${t("chat.imageLightbox.svgInteractionHelp")}
          @click=${toggle}
        >
          ${t(this.active ? "chat.imageLightbox.svgPreview" : "chat.imageLightbox.svgInteract")}
        </button>`
      : nothing;
  }

  renderNotice() {
    return this.error
      ? html`<p class="svg-notice" role="alert">
          ${t(this.failure === "encoding" ? "chat.imageLightbox.svgEncodingUnsupported" : "chat.imageLightbox.svgInvalid")}
        </p>`
      : this.loading
        ? html`<p class="svg-notice" role="status">${t("chat.imageLightbox.svgLoading")}</p>`
        : nothing;
  }

  private bindSearchInput = (element?: Element) => {
    this.searchInput = element instanceof HTMLInputElement ? element : undefined;
    this.searchInput?.focus();
  };

  renderSearch() {
    return this.searchOpen
      ? html`<form
          class="svg-search"
          @submit=${(event: Event) => {
            event.preventDefault();
            this.submitSearch();
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              this.dismissSearch();
            }
          }}
        >
          <input
            ${ref(this.bindSearchInput)}
            aria-label=${t("chat.imageLightbox.svgSearch")}
            maxlength=${SVG_SEARCH_TERM_MAX_LENGTH}
            .value=${this.searchTerm}
            @input=${() => {
              if (this.searchInput) {
                this.setSearchTerm(this.searchInput.value);
              }
            }}
          />
          <button class="action" type="submit">${t("chat.imageLightbox.svgSearchSubmit")}</button>
          ${this.searchError ? html`<span role="alert">${t("chat.imageLightbox.svgSearchError")}</span>` : nothing}
        </form>`
      : nothing;
  }
}
