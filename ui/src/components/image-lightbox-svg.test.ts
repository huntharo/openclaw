/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_INTERACTIVE_SVG_DOCUMENT_LENGTH } from "../../../src/shared/interactive-svg-viewer.js";
import { ImageLightboxSvgController } from "./image-lightbox-svg.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";

const validSvg =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>function search() {}</script></svg>';
const cleanups = new Set<() => void>();

function fixture() {
  vi.useFakeTimers();
  let item: ImageLightboxItem | undefined = {
    src: "blob:selected",
    title: "Synthetic diagram",
    svgSource: { src: "blob:selected", text: validSvg },
  };
  const frames: HTMLIFrameElement[] = [];
  const makeFrame = () => {
    const element = document.createElement("iframe");
    document.body.append(element);
    frames.push(element);
    const post = vi
      .spyOn(element.contentWindow!, "postMessage")
      .mockImplementation(() => undefined);
    return { element, post };
  };
  const first = makeFrame();
  let frame: HTMLIFrameElement | null = first.element;
  const closeViewer = vi.fn();
  const invalidate = vi.fn();
  const controller = new ImageLightboxSvgController({
    readItem: () => item,
    getFrame: () => frame,
    readColorScheme: () => "dark",
    closeViewer,
    invalidate,
  });
  const message = (
    data: unknown,
    source: Window | null = frame?.contentWindow ?? null,
    origin = "null",
  ) => {
    window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
  };
  const activate = () => {
    controller.toggle();
    controller.bind(frame);
    controller.frameLoaded(frame!);
    message("openclaw-svg-ready");
    message("openclaw-svg-active");
  };
  cleanups.add(() => {
    controller.dispose();
    for (const element of frames) {
      element.remove();
    }
  });
  return {
    controller,
    closeViewer,
    invalidate,
    first,
    makeFrame,
    message,
    activate,
    setItem: (value: ImageLightboxItem | undefined) => {
      item = value;
    },
    setFrame: (value: HTMLIFrameElement | null) => {
      frame = value;
    },
    getItem: () => item,
  };
}

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("interactive SVG lightbox lifecycle", () => {
  it("reports unsupported source decoding without admitting a frame or losing the preview source", () => {
    const { controller, setItem, getItem, first } = fixture();
    setItem({
      src: "blob:selected",
      title: "Unsupported encoding",
      svgSource: { src: "blob:selected", decodeError: true },
    });
    controller.toggle();
    expect(controller.available).toBe(true);
    expect(controller.active).toBeUndefined();
    expect(controller.error).toBe(true);
    expect(getItem()?.src).toBe("blob:selected");
    expect(first.post).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const notice = document.createElement("div");
    render(controller.renderNotice(), notice);
    expect(notice.querySelector('[role="alert"]')?.textContent).toContain(
      "encoding cannot be used interactively",
    );
  });
  it("publishes only after the exact opaque frame is ready and stops loading after activation", () => {
    const { controller, first, message, closeViewer } = fixture();
    controller.toggle();
    controller.bind(first.element);
    expect(controller.active?.scheme).toBe("dark");
    expect(controller.loading).toBe(true);
    message("openclaw-svg-active");
    message("openclaw-svg-ready", first.element.contentWindow, "https://other.test");
    message("openclaw-svg-ready", window);
    message({ type: "openclaw-svg-ready" });
    message("openclaw-svg-escape");
    expect(first.post).not.toHaveBeenCalled();
    expect(closeViewer).not.toHaveBeenCalled();
    message("openclaw-svg-ready");
    expect(first.post).not.toHaveBeenCalled();
    controller.frameLoaded(first.element);
    message("openclaw-svg-ready");
    expect(first.post).toHaveBeenCalledExactlyOnceWith(
      {
        type: "openclaw-svg-document",
        document: controller.active?.document,
      },
      "*",
    );
    expect(controller.loading).toBe(true);
    message("openclaw-svg-active");
    expect(controller.loading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires the prior frame window when the renderer replaces its iframe", () => {
    const { controller, first, makeFrame, setFrame, message, activate } = fixture();
    activate();
    const replacement = makeFrame();
    setFrame(replacement.element);
    message("openclaw-svg-search", first.element.contentWindow);
    expect(controller.searchOpen).toBe(false);
    controller.bind(replacement.element);
    expect(controller.loading).toBe(true);
    message("openclaw-svg-ready", first.element.contentWindow);
    expect(replacement.post).not.toHaveBeenCalled();
    controller.frameLoaded(replacement.element);
    message("openclaw-svg-ready");
    expect(replacement.post).toHaveBeenCalledOnce();
    message("openclaw-svg-active");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["load", "pagehide"])(
    "revokes a navigated document at %s even when its opaque WindowProxy remains identical",
    (retirement) => {
      const { controller, first, message, activate, closeViewer } = fixture();
      activate();
      first.post.mockClear();
      message("openclaw-svg-search");
      controller.setSearchTerm("private later search");
      if (retirement === "load") {
        controller.frameLoaded(first.element);
      } else {
        message("openclaw-svg-retired");
      }
      message("openclaw-svg-ready");
      message("openclaw-svg-active");
      message("openclaw-svg-search");
      message("openclaw-svg-escape");
      controller.submitSearch();
      expect(first.post).not.toHaveBeenCalled();
      expect(closeViewer).not.toHaveBeenCalled();
      expect(controller.active).toBeUndefined();
      expect(controller.searchOpen).toBe(false);
      expect(controller.searchTerm).toBe("");
      expect(controller.error).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects a retired SVG source even when its preview URL is unchanged", () => {
    const { controller, setItem, first, message, closeViewer, activate } = fixture();
    activate();
    setItem({
      src: "blob:selected",
      title: "Replacement",
      svgSource: { src: "blob:selected", text: validSvg },
    });
    message("openclaw-svg-search");
    message("openclaw-svg-escape");
    expect(controller.active).toBeUndefined();
    expect(controller.searchOpen).toBe(false);
    expect(closeViewer).not.toHaveBeenCalled();
    controller.bind(first.element);
    expect(vi.getTimerCount()).toBe(0);
    controller.toggle();
    expect(controller.loading).toBe(true);
  });

  it.each(["reset", "dispose"] as const)(
    "%s clears pending publication, search state, and the watchdog",
    (operation) => {
      const { controller, first, message } = fixture();
      controller.toggle();
      controller.bind(first.element);
      controller.setSearchTerm("retired term");
      controller[operation]();
      message("openclaw-svg-ready");
      message("openclaw-svg-active");
      message("openclaw-svg-search");
      expect(first.post).not.toHaveBeenCalled();
      expect(controller.active).toBeUndefined();
      expect(controller.searchTerm).toBe("");
      expect(controller.searchOpen).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retires a pending source watchdog without failing the replacement preview", () => {
    const { controller, setItem, first } = fixture();
    controller.toggle();
    controller.bind(first.element);
    setItem({ src: "blob:replacement", title: "Replacement preview" });
    controller.bind(first.element);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(controller.error).toBe(false);
    expect(controller.active).toBeUndefined();
  });

  it("falls back visibly when the shell never activates and permits an explicit retry", () => {
    const { controller, first, message } = fixture();
    controller.toggle();
    controller.bind(first.element);
    message("openclaw-svg-ready");
    vi.advanceTimersByTime(10_000);
    expect(controller.active).toBeUndefined();
    expect(controller.error).toBe(true);
    expect(controller.loading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    message("openclaw-svg-search");
    expect(controller.searchOpen).toBe(false);
    controller.toggle();
    expect(controller.error).toBe(false);
    expect(controller.loading).toBe(true);
  });

  it("keeps failed search visible, bounds terms, and gives Escape to search before closing", () => {
    const { controller, first, message, activate, closeViewer } = fixture();
    activate();
    first.post.mockClear();
    message("openclaw-svg-search");
    const surface = document.createElement("div");
    document.body.append(surface);
    cleanups.add(() => {
      render(null, surface);
      surface.remove();
    });
    render(controller.renderSearch(), surface);
    expect(surface.querySelector("input")?.maxLength).toBe(4096);
    controller.setSearchTerm("x".repeat(4097));
    controller.submitSearch();
    expect(first.post).toHaveBeenCalledExactlyOnceWith(
      { type: "openclaw-svg-search-term", term: "x".repeat(4096) },
      "*",
    );
    expect(controller.searchOpen).toBe(false);
    message("openclaw-svg-search-error");
    expect(controller.searchError).toBe(true);
    expect(controller.searchOpen).toBe(true);
    message("openclaw-svg-escape");
    expect(controller.searchOpen).toBe(false);
    expect(closeViewer).not.toHaveBeenCalled();
    message("openclaw-svg-escape");
    message("openclaw-svg-escape");
    expect(closeViewer).toHaveBeenCalledOnce();
    expect(controller.active).toBeUndefined();
    // jsdom queues selectionchange on focus. Drain that task without advancing the 10s watchdog.
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    undefined,
    {
      src: "blob:selected",
      title: "Video",
      kind: "video" as const,
      svgSource: { src: "blob:selected", text: validSvg },
    },
    {
      src: "blob:selected",
      title: "Mismatched lease",
      svgSource: { src: "blob:other", text: validSvg },
    },
  ])("does not activate without a matching admitted image source", (item) => {
    const { controller, setItem, first } = fixture();
    setItem(item);
    controller.toggle();
    expect(controller.available).toBe(false);
    expect(controller.active).toBeUndefined();
    expect(first.post).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "<html/>",
    `<svg xmlns="http://www.w3.org/2000/svg"><text>${"x".repeat(MAX_INTERACTIVE_SVG_DOCUMENT_LENGTH)}</text></svg>`,
  ])("rejects invalid or oversized documents before installing the viewer lifecycle", (text) => {
    const { controller, setItem, first } = fixture();
    setItem({
      src: "blob:selected",
      title: "Invalid document",
      svgSource: { src: "blob:selected", text },
    });
    controller.toggle();
    expect(controller.error).toBe(true);
    expect(controller.active).toBeUndefined();
    expect(first.post).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
