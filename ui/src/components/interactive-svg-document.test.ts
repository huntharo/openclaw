/* @vitest-environment jsdom */
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { interactiveSvgDocument } from "./interactive-svg-document.ts";

const svgSource = `<svg xmlns="http://www.w3.org/2000/svg" onload="initialize(evt)">
  <style>rect:hover { opacity: .5; }</style>
  <rect id="search" onclick="search()" width="20" height="20"/>
  <script><![CDATA[
    function initialize() { window.initialized = true; }
    function search(term) { window.lastSearch = term; }
    history.replaceState({ ready: true }, "", "#ready");
    initialize();
  ]]></script>
</svg>`;

function preparedRuntime({
  source = svgSource,
  replaceState = vi.fn<(...args: unknown[]) => unknown>(() => {
    throw new DOMException("Opaque frame", "SecurityError");
  }),
} = {}) {
  const page = new DOMParser().parseFromString(interactiveSvgDocument(source, "dark"), "text/html");
  const frameWindow = Object.assign(new EventTarget(), {
    initialized: false,
    lastSearch: "",
    searching: false,
  });
  const parentWindow = { postMessage: vi.fn() };
  const history = { replaceState };
  const context = createContext({
    window: frameWindow,
    parent: parentWindow,
    history,
  });
  for (const script of page.querySelectorAll("script")) {
    runInContext(script.textContent ?? "", context);
  }
  const startupMessages = [...parentWindow.postMessage.mock.calls];
  parentWindow.postMessage.mockClear();
  const message = (data: unknown, messageSource: unknown = parentWindow) => {
    const event = Object.assign(new Event("message"), { data, source: messageSource });
    frameWindow.dispatchEvent(event);
  };
  return {
    page,
    frameWindow,
    parentWindow,
    history,
    replaceState,
    message,
    startupMessages,
  };
}

describe("interactive SVG prepared document", () => {
  it.each([
    "<html/>",
    '<svg xmlns="https://example.test/wrong"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>',
  ])("rejects invalid SVG XML before preparing an executable document: %s", (source) => {
    expect(() => interactiveSvgDocument(source)).toThrow("Invalid SVG document");
  });

  it("preserves source callbacks and styles while its initial fragment update remains usable", () => {
    const { page, frameWindow, replaceState, startupMessages } = preparedRuntime();
    expect(startupMessages).toEqual([["openclaw-svg-active", "*"]]);
    expect(frameWindow.initialized).toBe(true);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({ ready: true }, "", "#ready");
    expect(page.querySelector("svg")?.getAttribute("onload")).toBe("initialize(evt)");
    expect(page.querySelector("rect")?.getAttribute("onclick")).toBe("search()");
    expect(page.querySelector("svg style")?.textContent).toBe("rect:hover { opacity: .5; }");
    expect(page.head.querySelector("style")?.textContent).toMatch(/color-scheme: dark/u);
  });

  it("forwards successful history updates and rethrows errors unrelated to opaque origins", () => {
    const replaceState = vi.fn<(...args: unknown[]) => unknown>(() => undefined);
    const { history } = preparedRuntime({ replaceState });
    history.replaceState();
    expect(replaceState).toHaveBeenCalledTimes(2);
    const failure = new DOMException("Cannot clone state", "DataCloneError");
    replaceState.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => history.replaceState()).toThrow(failure);
  });

  it("accepts only bounded scalar search terms from the owning parent", () => {
    const { frameWindow, parentWindow, message } = preparedRuntime();
    const searchTerm = (term: unknown) => ({ type: "openclaw-svg-search-term", term });
    message(searchTerm("other frame"), {});
    message(searchTerm({ expression: "object" }));
    message(searchTerm("x".repeat(4097)));
    message({ type: "unrelated", term: "unrelated" });
    expect(frameWindow.lastSearch).toBe("");
    expect(parentWindow.postMessage).not.toHaveBeenCalled();
    message(searchTerm("[known frame]"));
    expect(frameWindow.lastSearch).toBe("[known frame]");
    message(searchTerm("x".repeat(4096)));
    expect(frameWindow.lastSearch).toHaveLength(4096);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>function search() { throw new Error("Invalid expression"); }</script></svg>',
  ])("reports unavailable or failed source search without throwing into the host", (source) => {
    const { parentWindow, message } = preparedRuntime({ source });
    message({ type: "openclaw-svg-search-term", term: "[" });
    expect(parentWindow.postMessage).toHaveBeenCalledExactlyOnceWith(
      "openclaw-svg-search-error",
      "*",
    );
  });

  it.each([{ key: "F3" }, { key: "f", ctrlKey: true }, { key: "F", metaKey: true }])(
    "opens host search for $key and preserves the SVG's active-search reset",
    (keys) => {
      const { frameWindow, parentWindow } = preparedRuntime();
      const event = new KeyboardEvent("keydown", { ...keys, cancelable: true });
      const sourceHandler = vi.fn();
      frameWindow.addEventListener("keydown", sourceHandler);
      frameWindow.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(sourceHandler).not.toHaveBeenCalled();
      expect(parentWindow.postMessage).toHaveBeenCalledExactlyOnceWith("openclaw-svg-search", "*");
      frameWindow.searching = true;
      const reset = new KeyboardEvent("keydown", { ...keys, cancelable: true });
      frameWindow.dispatchEvent(reset);
      expect(reset.defaultPrevented).toBe(false);
      expect(sourceHandler).toHaveBeenCalledOnce();
      expect(parentWindow.postMessage).toHaveBeenCalledOnce();
    },
  );

  it("bridges source search clicks and Escape without interpreting arbitrary actions", () => {
    const { frameWindow, parentWindow } = preparedRuntime();
    const click = new MouseEvent("click", { cancelable: true });
    Object.defineProperty(click, "target", { value: { id: "search" } });
    frameWindow.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    frameWindow.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    frameWindow.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(parentWindow.postMessage.mock.calls).toEqual([
      ["openclaw-svg-search", "*"],
      ["openclaw-svg-escape", "*"],
    ]);
  });
});
