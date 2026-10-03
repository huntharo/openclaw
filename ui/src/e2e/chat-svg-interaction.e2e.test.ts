import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const diagram = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <style>rect { fill: #345477; } rect:hover, rect:focus { fill: #d26a40; } text { font: 24px sans-serif; fill: white; pointer-events: none; }</style>
  <rect width="800" height="450" fill="#172233"/>
  <rect id="control" tabindex="0" x="100" y="160" width="600" height="130" rx="20"/>
  <text x="190" y="232">Hover or focus to highlight this region</text>
  <script>parent.document.documentElement.dataset.svgExecuted = "yes"; fetch("/svg-network-probe");</script>
  <image href="https://example.invalid/external.png" width="1" height="1"/>
  <a href="https://example.invalid/svg-link"><text x="100" y="380">External link</text></a>
</svg>`;

describe("Control UI isolated SVG interaction", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    server = await startControlUiE2eServer();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("opens admitted attachment controls only after opt-in, without scripts or external navigation", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const proofDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("svg-interaction")
        : undefined;
    const forbiddenRequests: string[] = [];
    page.on("request", (request) => {
      if (/svg-network-probe|example\.invalid/.test(request.url())) {
        forbiddenRequests.push(request.url());
      }
    });
    await page.route("**/interactive-diagram.svg", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: diagram }),
    );
    await page.route("**/chat", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({
        response,
        body,
        headers: {
          ...response.headers(),
          "content-security-policy": buildControlUiCspHeader({
            inlineScriptHashes: computeInlineScriptHashes(body),
          }),
        },
      });
    });
    const gateway = await installMockGateway(page, {
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
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.getByRole("button", { name: "Open image interactive-diagram.svg" }).click();
      const viewer = page.locator("openclaw-image-lightbox");
      await expect.poll(() => viewer.locator("img").count()).toBe(1);
      expect(await viewer.locator("iframe").count()).toBe(0);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "preview.png") });
      }
      await viewer.getByRole("button", { name: "Interact with SVG" }).click();
      const frameElement = viewer.locator("iframe");
      expect(await frameElement.getAttribute("sandbox")).toBe("");
      const frame = page.frameLocator("openclaw-image-lightbox iframe");
      const control = frame.locator("#control");
      await control.waitFor({ state: "visible" });
      const before = await control.evaluate((node) => getComputedStyle(node).fill);
      await control.hover();
      await expect
        .poll(() => control.evaluate((node) => getComputedStyle(node).fill))
        .not.toBe(before);
      await page.mouse.move(0, 0);
      await control.focus();
      await expect
        .poll(() => control.evaluate((node) => getComputedStyle(node).fill))
        .not.toBe(before);
      expect(await frame.locator("a, script").count()).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.dataset.svgExecuted),
      ).toBeUndefined();
      expect(forbiddenRequests).toEqual([]);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "interacting.png") });
      }
      // The script-free frame cannot intercept Escape; Tab returns to native modal controls.
      await viewer.getByRole("button", { name: "Show image preview" }).click();
      await expect.poll(() => viewer.locator("iframe").count()).toBe(0);
      await viewer.getByRole("button", { name: "Close image preview" }).click();
      await expect.poll(() => page.locator("openclaw-image-lightbox").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
