import { expect, it } from "vitest";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Debug local Gateway traffic",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("observes delivered bytes on the existing cadence while diagnostics are pending, then clears on stop, hide, reconnect and navigation", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "question.list": { questions: [] },
            "diagnostics.lanes": { lanes: [], dynamic: null },
            "last-heartbeat": null,
          },
        });
        await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
        await page.goto(`${suite.server.baseUrl}debug`);
        const monitor = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Gateway traffic", exact: true }),
        });
        await monitor.waitFor();
        await pauseVirtualClock(page);
        await page.clock.runFor(500);
        const start = monitor.getByRole("button", { name: "Start monitoring", exact: true });
        const stop = monitor.getByRole("button", { name: "Stop monitoring", exact: true });
        const requestCount = (await gateway.getRequests()).length;
        await start.click();
        await stop.waitFor();
        const charts = monitor.locator("openclaw-sparkline");
        expect(await charts.count()).toBe(2);
        expect((await gateway.getRequests()).length).toBe(requestCount);
        await page.evaluate(() => {
          let bytes = 0;
          // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves each socket receiver.
          const dispatch = WebSocket.prototype.dispatchEvent;
          WebSocket.prototype.dispatchEvent = function (event) {
            if (event instanceof MessageEvent && typeof event.data === "string") {
              bytes += new TextEncoder().encode(event.data).byteLength;
            }
            return Reflect.apply(dispatch, this, [event]);
          };
          (window as Window & { readTrafficBytes?: () => number }).readTrafficBytes = () => bytes;
        });
        const raw = { type: "event", event: "traffic-fixture", payload: "é🙂" };
        await gateway.deliverLatest(raw);
        await page.clock.runFor(100);
        const bytes = await page.evaluate(() =>
          (window as Window & { readTrafficBytes?: () => number }).readTrafficBytes?.(),
        );
        expect(bytes).toBe(61);
        expect(await charts.nth(1).textContent()).toContain("0 frames / last 60s");
        await gateway.deferNext("last-heartbeat");
        await gateway.deferNext("diagnostics.lanes");
        await page.clock.runFor(3000);
        expect(await charts.nth(1).textContent()).toContain(`${bytes} B · 1 frames / last 60s`);
        const firstPoints = await charts.nth(1).locator("polyline").getAttribute("points");
        await gateway.deliverLatest(raw);
        await page.clock.runFor(3000);
        expect(await charts.nth(1).textContent()).toContain(
          `${Number(bytes) * 2} B · 2 frames / last 60s`,
        );
        expect(await charts.nth(1).locator("polyline").getAttribute("points")).not.toBe(
          firstPoints,
        );
        await stop.click();
        expect(await charts.count()).toBe(0);
        await start.click();
        expect(await charts.nth(1).textContent()).toContain("0 frames / last 60s");
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await start.waitFor();
        expect(await charts.count()).toBe(0);
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await start.click();
        await gateway.setOnline(false);
        await start.waitFor();
        expect(await start.isDisabled()).toBe(true);
        expect(await charts.count()).toBe(0);
        await gateway.setOnline(true);
        await page.clock.runFor(2000);
        expect(await start.isEnabled()).toBe(true);
        await start.click();
        expect(await charts.nth(1).textContent()).toContain("0 frames / last 60s");
        await page.getByRole("link", { name: "Appearance", exact: true }).click();
        await page.locator("openclaw-debug-page").waitFor({ state: "detached" });
        expect(await monitor.count()).toBe(0);
        await page.goBack();
        await start.waitFor();
        expect(await charts.count()).toBe(0);
      },
    );
  });
});
