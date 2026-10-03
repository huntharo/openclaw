import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  pauseVirtualClock,
  type ControlUiMockGateway,
  type MockGatewayWindow,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI action traffic" });
type WireFrame = ControlUiMockGateway["wireFrames"][number];

async function wireFrames(page: Page): Promise<WireFrame[]> {
  return page.evaluate(() => {
    const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
    if (gateway.wireFramesDropped) {
      throw new Error("Traffic fixture exceeded its capture bound");
    }
    return gateway.wireFrames;
  });
}

function traffic(frames: WireFrame[]) {
  const summarize = (direction: WireFrame["direction"]) => {
    const selected = frames.filter((frame) => frame.direction === direction);
    const kinds: Record<string, number> = {};
    for (const frame of selected) {
      const parsed = JSON.parse(frame.data) as { type: string; method?: string; event?: string };
      const kind = parsed.method ?? parsed.event ?? parsed.type;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    return {
      frames: selected.length,
      bytes: selected.reduce((total, frame) => total + Buffer.byteLength(frame.data, "utf8"), 0),
      kinds,
    };
  };
  return { sent: summarize("sent"), received: summarize("received") };
}

function expectBudget(name: string, frames: WireFrame[], sentFrames: number, sentBytes: number) {
  const summary = traffic(frames);
  expect(summary.sent.frames, `${name}: client frame budget`).toBeLessThanOrEqual(sentFrames);
  expect(summary.sent.bytes, `${name}: client UTF-8 byte budget`).toBeLessThanOrEqual(sentBytes);
  return summary;
}

async function drainAcknowledgments(page: Page) {
  let previousLength = -1;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.clock.runFor(100);
    const frames = await wireFrames(page);
    const responses = new Set(
      frames
        .filter((frame) => frame.direction === "received")
        .map((frame) => JSON.parse(frame.data) as { type: string; id?: string })
        .filter((frame) => frame.type === "res")
        .map((frame) => frame.id),
    );
    const pending = frames
      .filter((frame) => frame.direction === "sent")
      .map((frame) => JSON.parse(frame.data) as { type: string; id?: string })
      .filter((frame) => frame.type === "req" && !responses.has(frame.id));
    if (pending.length === 0 && previousLength === frames.length) {
      return frames;
    }
    previousLength = frames.length;
  }
  throw new Error("Mock Gateway acknowledgments did not drain within 3 seconds of fixture time");
}

suite.define(() => {
  it.each([16, 64])(
    "bounds idle, action, and response traffic through %i chunks",
    async (chunks) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          captureWire: true,
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Ready for traffic proof." }] },
          ],
          methodResponses: {
            "sessions.list": {
              count: 2,
              defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
              path: "",
              sessions: [
                { key: "agent:main:main", kind: "direct", label: "Home", updatedAt: 2 },
                { key: "agent:main:session-b", kind: "direct", label: "Session B", updatedAt: 1 },
              ],
            },
          },
        });
        await page.clock.install();
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Ready for traffic proof.", { exact: true }).waitFor();
        await pauseVirtualClock(page);
        const initialization = await drainAcknowledgments(page);
        await page.clock.runFor(120_000);
        const idle = (await wireFrames(page)).slice(initialization.length);
        await page.locator(".agent-chat__composer-combobox textarea").fill("Reply in paragraphs.");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const { idempotencyKey: runId } = send.params as { idempotencyKey: string };
        const beforeStream = await drainAcknowledgments(page);
        let text = "";
        const paragraphs: string[] = [];
        for (let index = 0; index < chunks; index += 1) {
          const deltaText = `Paragraph ${index}: é🙂 ${"x".repeat(64)}.\n\n`;
          text += deltaText;
          paragraphs.push(deltaText.trim());
          await gateway.emitGatewayEvent("chat", {
            runId,
            sessionKey: "agent:main:main",
            state: "delta",
            seq: index + 1,
            deltaText,
            ...(index === 0
              ? { message: { role: "assistant", content: [{ type: "text", text }] } }
              : {}),
          });
          await page.clock.runFor(20);
        }
        const stream = (await wireFrames(page)).slice(beforeStream.length);
        await expect
          .poll(() => page.locator(".chat-bubble.streaming").textContent())
          .toContain(`Paragraph ${chunks - 1}:`);
        expect(await page.locator(".chat-bubble.streaming p").allTextContents()).toEqual(
          paragraphs,
        );
        await gateway.emitChatFinal({ runId, text });
        await page.clock.runFor(5_000);
        await page
          .locator(".chat-text")
          .filter({ hasText: `Paragraph ${chunks - 1}:` })
          .waitFor();
        expect(
          await page
            .locator(".chat-text")
            .filter({ hasText: `Paragraph ${chunks - 1}:` })
            .locator("p")
            .allTextContents(),
        ).toEqual(paragraphs);
        const terminal = (await wireFrames(page)).slice(beforeStream.length + stream.length);
        if (chunks === 16) {
          let cursor = (await drainAcknowledgments(page)).length;
          const record = async () => {
            const frames = await drainAcknowledgments(page);
            const phase = frames.slice(cursor);
            cursor = frames.length;
            return traffic(phase);
          };
          await page
            .locator(
              '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
            )
            .click();
          const selectSession = await record();
          await page.getByRole("link", { name: "Automations", exact: true }).click();
          const automationsTab = await record();
          await page.locator(".cron-refresh").click();
          const explicitRefresh = await record();
          await page.clock.runFor(120_000);
          const automationsIdle = await record();
          await page.getByRole("link", { name: "Home", exact: true }).click();
          const returnChat = await record();
          expect(selectSession.sent.frames).toBeLessThanOrEqual(12);
          expect(selectSession.sent.bytes).toBeLessThanOrEqual(1_800);
          expect(selectSession.sent.kinds["chat.startup"]).toBe(1);
          expect(automationsTab.sent.frames).toBeLessThanOrEqual(5);
          expect(automationsTab.sent.bytes).toBeLessThanOrEqual(1_000);
          expect(explicitRefresh.sent.kinds).toEqual({
            "cron.runs": 1,
            "channels.status": 1,
            "cron.status": 1,
            "cron.list": 1,
          });
          expect(explicitRefresh.sent.bytes).toBeLessThanOrEqual(850);
          expect(automationsIdle.sent).toEqual({ frames: 0, bytes: 0, kinds: {} });
          expect(automationsIdle.received.kinds).toEqual({ tick: 4 });
          expect(returnChat.sent.frames).toBeLessThanOrEqual(3);
          expect(returnChat.sent.bytes).toBeLessThanOrEqual(450);
        }
        expect(await gateway.getSocketCount()).toBe(1);
        const boot = expectBudget("connect and settled startup", initialization, 32, 6_000);
        expect(boot.sent.kinds.connect).toBe(1);
        expect(boot.sent.kinds["chat.startup"]).toBe(1);
        expectBudget("120-second Chat idle", idle, 0, 0);
        expect(traffic(idle).received.kinds).toEqual({ tick: 4 });
        const submitted = expectBudget(
          "one GUI send",
          beforeStream.slice(initialization.length + idle.length),
          3,
          600,
        );
        expect(submitted.sent.kinds["chat.send"]).toBe(1);
        const streamed = expectBudget("ordered response chunks", stream, 0, 0);
        expect(streamed.received.kinds).toEqual({ chat: chunks });
        expect(streamed.received.bytes).toBeLessThanOrEqual(chunks * 270 + 256);
        const finalized = expectBudget(
          "final response and roster reconciliation",
          terminal,
          1,
          300,
        );
        expect(finalized.sent.kinds).toEqual({ "sessions.list": 1 });
        expect(finalized.received.kinds).toEqual({ chat: 1, res: 1 });
      });
    },
  );

  it("rejects the idle budget for an intentionally malformed question response", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        captureWire: true,
        methodResponses: { "question.list": {} },
      });
      await page.clock.install();
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      await pauseVirtualClock(page);
      const before = await drainAcknowledgments(page);
      await page.clock.runFor(12_000);
      const recovery = (await drainAcknowledgments(page)).slice(before.length);
      expect(traffic(recovery).sent.kinds["question.list"]).toBeGreaterThanOrEqual(3);
      expect(() => expectBudget("malformed response recovery", recovery, 0, 0)).toThrow(
        "client frame budget",
      );
    });
  });

  it("detects a replayed raw request and refuses an overflowed capture", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, { captureWire: true });
      await page.clock.install();
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      await pauseVirtualClock(page);
      const before = await drainAcknowledgments(page);
      await page.evaluate(() => {
        // oxlint-disable-next-line typescript/unbound-method -- Replay uses call(this, data) to preserve each mock socket receiver.
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          send.call(this, data);
          if (typeof data === "string" && JSON.parse(data).method === "chat.send") {
            send.call(this, data);
          }
        };
      });
      await page.locator(".agent-chat__composer-combobox textarea").fill("Replay control.");
      await page.getByRole("button", { name: "Send message" }).click();
      const repeated = (await drainAcknowledgments(page))
        .slice(before.length)
        .filter(
          (frame) => frame.direction === "sent" && JSON.parse(frame.data).method === "chat.send",
        );
      expect(repeated).toHaveLength(2);
      expect(repeated[0]?.data).toBe(repeated[1]?.data);
      expect(() => expectBudget("one chat request", repeated, 1, 600)).toThrow(
        "client frame budget",
      );
      await gateway.deliverLatest({
        type: "event",
        event: "fixture.overflow",
        payload: "x".repeat(8 * 1024 * 1024),
      });
      await expect(wireFrames(page)).rejects.toThrow("capture bound");
    });
  });
});
