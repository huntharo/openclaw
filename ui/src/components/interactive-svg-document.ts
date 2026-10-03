export const SVG_SEARCH_TERM_MAX_LENGTH = 4096;

/** The caller mounts this document only after opt-in in an opaque allow-scripts frame. */
export function interactiveSvgDocument(
  source: string,
  colorScheme: "light" | "dark" = "light",
): string {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const svg = parsed.documentElement;
  if (
    svg.localName !== "svg" ||
    svg.namespaceURI !== "http://www.w3.org/2000/svg" ||
    parsed.getElementsByTagName("parsererror").length > 0
  ) {
    throw new Error("Invalid SVG document");
  }

  const serialized = new XMLSerializer().serializeToString(svg);
  return `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'">
    <meta name="referrer" content="no-referrer">
    <style>:root { color-scheme: ${colorScheme}; } html { height: 100%; overflow: auto; } body { display: flex; flex-direction: column; min-height: 100%; margin: 0; } svg { display: block; flex: none; max-width: 100%; height: auto; margin: auto; background: Canvas; }</style>
    <script>
      (function() {
        // SVG viewers update their fragment while searching. Opaque frames cannot replace a URL.
        const replaceState = history.replaceState.bind(history);
        history.replaceState = function() {
          try {
            return replaceState.apply(null, arguments);
          } catch (error) {
            if (!error || error.name !== "SecurityError") throw error;
          }
        };
      })();
    </script>
  </head><body>${serialized}
    <script>
      window.addEventListener("click", function(event) {
        if (event.target && event.target.id === "search" && !window.searching) {
          event.preventDefault();
          event.stopImmediatePropagation();
          parent.postMessage("openclaw-svg-search", "*");
        }
      }, true);
      window.addEventListener("keydown", function(event) {
        if (event.key === "Escape") {
          parent.postMessage("openclaw-svg-escape", "*");
        } else if ((event.key === "F3" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f")) && !window.searching) {
          event.preventDefault();
          event.stopImmediatePropagation();
          parent.postMessage("openclaw-svg-search", "*");
        }
      }, true);
      window.addEventListener("message", function(event) {
        if (event.source !== parent || !event.data || event.data.type !== "openclaw-svg-search-term"
          || typeof event.data.term !== "string" || event.data.term.length > ${SVG_SEARCH_TERM_MAX_LENGTH}) return;
        try {
          if (typeof search !== "function") throw new Error("SVG search is unavailable");
          search(event.data.term);
        } catch (_) {
          parent.postMessage("openclaw-svg-search-error", "*");
        }
      });
      parent.postMessage("openclaw-svg-active", "*");
    </script>
  </body></html>`;
}
