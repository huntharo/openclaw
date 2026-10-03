import DOMPurify from "dompurify";

/** Attachment controls stay in an opaque, script-free document, never the app DOM. */
export function interactiveSvgDocument(source: string): string {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (
    parsed.documentElement.localName !== "svg" ||
    parsed.documentElement.namespaceURI !== "http://www.w3.org/2000/svg" ||
    parsed.getElementsByTagName("parsererror").length > 0
  ) {
    throw new Error("Invalid SVG document");
  }
  const svg = DOMPurify.sanitize(new XMLSerializer().serializeToString(parsed.documentElement), {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["a", "foreignObject"],
    ADD_ATTR: ["tabindex"],
  });
  return `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
    <meta name="referrer" content="no-referrer">
    <style>html { height: 100%; } body { margin: 0; min-height: 100%; display: grid; place-items: center; } svg { display: block; max-width: 100%; max-height: 100vh; height: auto; }</style>
  </head><body>${svg}</body></html>`;
}
