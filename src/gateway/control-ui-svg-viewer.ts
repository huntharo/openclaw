import type { IncomingMessage, ServerResponse } from "node:http";
import {
  INTERACTIVE_SVG_VIEWER_PATH,
  MAX_INTERACTIVE_SVG_DOCUMENT_LENGTH,
} from "../shared/interactive-svg-viewer.js";

const VIEWER_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

// An HTTP document owns this policy. Blob/srcdoc would inherit the app's stricter CSP.
const VIEWER_HTML = `<!doctype html><html><head><meta name="referrer" content="no-referrer"></head><body>
<script>
(function() {
  const parentWindow = parent;
  const notifyParent = parentWindow.postMessage.bind(parentWindow);
  // Retire before a replacement document can post messages through the same WindowProxy.
  window.addEventListener("pagehide", function() {
    notifyParent("openclaw-svg-retired", "*");
  }, { once: true, capture: true });
  function mount(event) {
    if (event.source !== parentWindow || !event.data || event.data.type !== "openclaw-svg-document"
      || typeof event.data.document !== "string" || event.data.document.length > ${MAX_INTERACTIVE_SVG_DOCUMENT_LENGTH}) return;
    window.removeEventListener("message", mount);
    // Keep this Document so any later iframe load unambiguously means navigation.
    const parsed = new DOMParser().parseFromString(event.data.document, "text/html");
    const root = document.importNode(parsed.documentElement, true);
    document.documentElement.replaceWith(root);
    // Parsed scripts are inert; execute them in document order only after admission.
    for (const script of root.querySelectorAll("script")) {
      const executable = document.createElement("script");
      for (const attribute of script.attributes) executable.setAttribute(attribute.name, attribute.value);
      executable.textContent = script.textContent;
      script.replaceWith(executable);
    }
    // SVG load handlers normally initialize during document loading, which is already complete.
    root.querySelector("svg")?.dispatchEvent(new Event("load"));
  }
  window.addEventListener("message", mount);
  notifyParent("openclaw-svg-ready", "*");
})();
</script></body></html>`;

export function serveControlUiSvgViewer(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  basePath: string,
): boolean {
  if (pathname !== `${basePath}${INTERACTIVE_SVG_VIEWER_PATH}`) {
    return false;
  }
  // The general Control UI read-method admission runs before this document owner.
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", VIEWER_CSP);
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
  );
  res.end(req.method === "HEAD" ? undefined : VIEWER_HTML);
  return true;
}
