#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { observeGatewayTraffic } from "./lib/gateway-traffic.ts";

const { values } = parseArgs({
  options: {
    cdp: { type: "string" },
    page: { type: "string" },
    seconds: { type: "string", default: "60" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/gateway-traffic.mts --cdp <CDP endpoint> --page <exact page URL> [--seconds 60]",
  );
} else {
  if (!values.cdp || !values.page) {
    throw new Error("Select an existing browser with --cdp and an exact --page URL");
  }
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error("--seconds must be greater than zero and at most 600");
  }
  const browser = await chromium.connectOverCDP(values.cdp);
  try {
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => page.url() === values.page);
    if (pages.length !== 1) {
      throw new Error(
        "--page must match exactly one existing tab; no tabs were opened or navigated",
      );
    }
    const monitor = await observeGatewayTraffic(pages[0]!);
    const startedAt = performance.now();
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.error(
      `Traffic capture armed for up to ${seconds} seconds; Ctrl+C prints the current report.`,
    );
    try {
      await setTimeout(seconds * 1000, undefined, { signal: abort.signal }).catch(
        (error: unknown) => {
          if (!abort.signal.aborted) {
            throw error;
          }
        },
      );
      const elapsedMs = performance.now() - startedAt;
      const traffic = monitor.snapshot();
      console.log(
        JSON.stringify(
          {
            elapsedMs,
            bytes: "decoded WebSocket application payload; excludes framing, TLS, and compression",
            ...traffic,
            payloadBytesPerMinute: {
              sent: (traffic.sent.payloadBytes * 60000) / elapsedMs,
              received: (traffic.received.payloadBytes * 60000) / elapsedMs,
            },
          },
          null,
          2,
        ),
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await monitor.stop();
    }
  } finally {
    // Playwright's CDP connection closes its transport, not the attached browser.
    await browser.close();
  }
}
