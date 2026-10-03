import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleControlUiHttpRequest } from "../../../src/gateway/control-ui.ts";
import { VERSION } from "../../../src/version.ts";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  buildProductionControlUiE2e,
  captureControlUiE2eFailureDiagnostics,
  resolvePlaywrightChromiumExecutablePath,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

declare global {
  interface Window {
    recordLeakedSvgSearch: (term: unknown) => Promise<void>;
  }
}

const diagram = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450" onload="initialize()">
  <style>rect { fill: #345477; } rect:hover { fill: #d26a40; } text { font: 24px sans-serif; fill: white; } #control { cursor: pointer; } #status { pointer-events: none; }</style>
  <rect width="800" height="450"/>
  <rect id="control" x="100" y="160" width="600" height="130" rx="20" onclick="zoom()"/>
  <text id="status" x="190" y="232">Click to zoom this region</text>
  <text id="search" x="610" y="50" onclick="search()">Search</text>
  <text id="navigate" x="100" y="390" onclick="window.parent = {postMessage(){}}; location.href='/operator/ui/navigated-svg-document'">Navigate own frame</text>
  <script><![CDATA[
    var runs = 0;
    function initialize() {
      window.addEventListener("pagehide", function(event) { event.stopImmediatePropagation(); }, { capture: true });
      var status = document.getElementById("status");
      status.dataset.runs = String(++runs);
      try { parent.document.documentElement.dataset.svgExecuted = "yes"; } catch (_) { status.dataset.parent = "denied"; }
      try { localStorage.getItem("gateway-token"); } catch (_) { status.dataset.storage = "denied"; }
      history.replaceState({}, "", "#ready");
      var externalScript = document.createElement("script");
      externalScript.src = "/svg-script-probe";
      document.head.append(externalScript);
      fetch("/svg-network-probe").catch(function() { status.dataset.network = "denied"; });
      parent.postMessage({ type: "req", method: "chat.send", params: { message: "untrusted" } }, "*");
    }
    function zoom() { document.getElementById("control").setAttribute("width", "650"); document.getElementById("status").textContent = "Zoomed region"; }
    function search(term) {
      if (term === "[") throw new Error("Invalid search");
      document.getElementById("status").textContent = "Found: " + term;
    }
  ]]></script>
  <image href="/svg-image-probe" width="1" height="1"/>
  <foreignObject width="1" height="1"><iframe xmlns="http://www.w3.org/1999/xhtml" src="/svg-frame-probe"/></foreignObject>
</svg>`;

describe("Control UI scripted SVG attachment through production HTTP owner", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;
  const tempDirs = createTempDirTracker();
  const forbiddenHttpRequests: string[] = [];
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    const root = tempDirs.make("openclaw-svg-viewer-e2e-");
    await buildProductionControlUiE2e(root, "svg-viewer-e2e");
    const http = createServer((req, res) => {
      if (/^\/svg-(?:network|script|image|frame)-probe$/.test(req.url ?? "")) {
        forbiddenHttpRequests.push(req.url!);
        res.statusCode = 204;
        res.end();
        return;
      }
      void handleControlUiHttpRequest(req, res, {
        basePath: "/operator/ui",
        terminalEnabled: false,
        root: { kind: "resolved", path: root },
      })
        .then((handled) => {
          if (!handled) {
            res.statusCode = 404;
            res.end();
          }
        })
        .catch(() => {
          res.statusCode = 500;
          res.end("Fixture failure");
        });
    });
    await new Promise<void>((resolve) => {
      http.listen(0, "127.0.0.1", resolve);
    });
    server = {
      baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/operator/ui/`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          http.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
    tempDirs.cleanup();
  });

  it("executes only after Interact, bridges search, denies parent/network privilege, and retires stale frames", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const proofDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("svg-script-interaction")
        : undefined;
    const leakedQueries: unknown[] = [];
    await page.exposeFunction("recordLeakedSvgSearch", (term: unknown) => leakedQueries.push(term));
    await page.addInitScript(() => {
      window.addEventListener("message", (event) => {
        if (event.data === "openclaw-svg-retired") {
          const count = Number(document.documentElement.dataset.svgRetirements ?? "0");
          document.documentElement.dataset.svgRetirements = String(count + 1);
        }
        if (event.data?.type === "leaked-svg-search") {
          void window.recordLeakedSvgSearch(event.data.term);
        }
      });
    });
    await page.route("**/interactive-diagram.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from('<?xml version="1.0" encoding="UTF-16"?>' + diagram, "utf16le"),
        ]),
      }),
    );
    await page.route("**/navigated-svg-document", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>
        window.addEventListener("message", function(event) {
          if (event.data && event.data.type === "openclaw-svg-search-term") {
            parent.postMessage({type: "leaked-svg-search", term: event.data.term}, "*");
          }
        });
        for (const data of ["openclaw-svg-ready", "openclaw-svg-active", "openclaw-svg-search", "openclaw-svg-escape"]) parent.postMessage(data, "*");
      </script><p>Untrusted navigated document</p>`,
      }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/operator/ui",
      serverBuildId: "svg-viewer-e2e",
      serverVersion: VERSION,
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "interactive-diagram.svg",
                mimeType: "image/svg+xml",
                url: `${server.baseUrl}interactive-diagram.svg`,
              },
            },
          ],
          timestamp: 1_800_000_000_000,
        },
      ],
    });
    try {
      const appResponse = await page.goto(`${server.baseUrl}chat`);
      expect(appResponse?.headers()["content-security-policy"]).not.toContain(
        "script-src 'unsafe-inline'",
      );
      await gateway.waitForRequest("chat.startup");
      const trigger = page.getByRole("button", { name: "Open image interactive-diagram.svg" });
      await trigger.click();
      const viewer = page.locator("openclaw-image-lightbox");
      await viewer.locator("img").waitFor();
      expect(await viewer.locator("iframe").count()).toBe(0);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "preview.png") });
      }
      const responsePromise = page.waitForResponse((response) =>
        response.url().endsWith("/operator/ui/__openclaw__/svg-viewer"),
      );
      await viewer.getByRole("button", { name: "Interact with SVG" }).click();
      const viewerResponse = await responsePromise;
      expect(viewerResponse.headers()["content-security-policy"]).toContain(
        "sandbox allow-scripts",
      );
      const element = viewer.locator("iframe.interactive-svg");
      expect(await element.getAttribute("sandbox")).toBe("allow-scripts");
      const frame = page.frameLocator("openclaw-image-lightbox iframe.interactive-svg");
      const status = frame.locator("#status");
      await expect.poll(() => status.getAttribute("data-runs")).toBe("1");
      // A second parent document publication cannot remount the one-shot shell.
      await element.evaluate((node) =>
        (node as HTMLIFrameElement).contentWindow?.postMessage(
          {
            type: "openclaw-svg-document",
            document: "<p id=unexpected>Second publication</p>",
          },
          "*",
        ),
      );
      expect(await frame.locator("#unexpected").count()).toBe(0);
      expect(await status.getAttribute("data-parent")).toBe("denied");
      expect(await status.getAttribute("data-storage")).toBe("denied");
      await expect.poll(() => status.getAttribute("data-network")).toBe("denied");
      await frame.locator("#control").click();
      expect(await status.textContent()).toBe("Zoomed region");
      await frame.locator("#search").click();
      const search = viewer.getByRole("textbox", { name: "Search SVG frames" });
      await search.fill("renderer");
      await viewer.getByRole("button", { name: "Find", exact: true }).click();
      await expect.poll(() => status.textContent()).toBe("Found: renderer");
      expect(await search.count()).toBe(0);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "script-search.png") });
      }
      await frame.locator("#search").click();
      await search.fill("[");
      await viewer.getByRole("button", { name: "Find", exact: true }).click();
      await viewer.getByRole("alert").waitFor();
      await search.press("Escape");
      expect(await search.count()).toBe(0);
      const retiredWindow = await element.evaluateHandle(
        (node) => (node as HTMLIFrameElement).contentWindow,
      );
      await viewer.getByRole("button", { name: "Show image preview" }).click();
      expect(await element.count()).toBe(0);
      await viewer.getByRole("button", { name: "Interact with SVG" }).click();
      await expect.poll(() => status.getAttribute("data-runs")).toBe("1");
      await page.evaluate((source) => {
        for (const data of [
          "openclaw-svg-ready",
          "openclaw-svg-active",
          "openclaw-svg-search",
          "openclaw-svg-escape",
        ]) {
          window.dispatchEvent(new MessageEvent("message", { source, origin: "null", data }));
        }
      }, retiredWindow);
      expect(await viewer.count()).toBe(1);
      expect(await search.count()).toBe(0);
      expect(await status.getAttribute("data-runs")).toBe("1");
      await retiredWindow.dispose();
      await frame.locator("#control").press("Escape");
      await expect.poll(() => viewer.count()).toBe(0);
      await trigger.click();
      expect(await viewer.locator("iframe").count()).toBe(0);
      await viewer.getByRole("button", { name: "Interact with SVG" }).click();
      await expect.poll(() => status.getAttribute("data-runs")).toBe("1");
      expect(
        await page.evaluate(() => document.documentElement.dataset.svgExecuted),
      ).toBeUndefined();
      expect(forbiddenHttpRequests).toEqual([]);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      expect(await gateway.getRequests("sessions.create")).toEqual([]);
      const navigatedWindow = await element.evaluateHandle(
        (node) => (node as HTMLIFrameElement).contentWindow,
      );
      const retirementCount = await page.evaluate(() =>
        Number(document.documentElement.dataset.svgRetirements ?? "0"),
      );
      await frame.locator("#navigate").click();
      await expect
        .poll(() =>
          page.evaluate(() => Number(document.documentElement.dataset.svgRetirements ?? "0")),
        )
        .toBe(retirementCount + 1);
      await expect.poll(() => element.count()).toBe(0);
      expect(await viewer.count()).toBe(1);
      await viewer.getByRole("alert").waitFor();
      expect(await search.count()).toBe(0);
      // A WindowProxy is stable across navigation; held identity alone cannot admit this document.
      await page.evaluate((source) => {
        for (const data of [
          "openclaw-svg-ready",
          "openclaw-svg-active",
          "openclaw-svg-search",
          "openclaw-svg-escape",
        ]) {
          window.dispatchEvent(new MessageEvent("message", { source, origin: "null", data }));
        }
      }, navigatedWindow);
      expect(await viewer.count()).toBe(1);
      expect(await search.count()).toBe(0);
      await viewer.getByRole("button", { name: "Interact with SVG" }).click();
      await expect.poll(() => status.getAttribute("data-runs")).toBe("1");
      await viewer.locator('.svg-notice[role="status"]').waitFor({ state: "hidden" });
      await frame.locator("#search").click();
      await search.fill("later private search");
      await viewer.getByRole("button", { name: "Find", exact: true }).click();
      await expect.poll(() => status.textContent()).toBe("Found: later private search");
      expect(leakedQueries).toEqual([]);
      await navigatedWindow.dispose();
      await viewer.getByRole("button", { name: "Close image preview" }).click();
      await expect.poll(() => viewer.count()).toBe(0);

      // The HTTP sandbox also applies when the static blank document is loaded directly.
      const direct = await context.newPage();
      await direct.goto(`${server.baseUrl}__openclaw__/svg-viewer`);
      const denied = await direct.evaluate(() => {
        try {
          localStorage.getItem("gateway-token");
          return false;
        } catch {
          return true;
        }
      });
      expect(denied).toBe(true);
      await direct.close();
    } catch (error) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error:
          error instanceof Error ? error : new Error("SVG viewer proof failed", { cause: error }),
        label: "svg-production-viewer",
      });
      throw error;
    } finally {
      await context.close();
    }
  });
});
