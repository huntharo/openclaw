/** @vitest-environment node */
import { expect, it } from "vitest";
import { TrafficWindow } from "./traffic-window.ts";

it("keeps sixty one-second buckets, expires idle traffic, and leaves published snapshots unchanged", () => {
  const window = new TrafficWindow();
  window.record("sent", 6, 100_000);
  window.record("sent", 4, 100_999);
  window.record("received", 20, 101_000);
  const published = window.snapshot(101_000);
  expect(published.sentBytes).toBe(10);
  expect(published.sentFrames).toBe(2);
  expect(published.receivedFrames).toBe(1);
  expect(published.seconds.slice(-2)).toEqual([
    { at: 100_000, sentBytes: 10, receivedBytes: 0, sentFrames: 2, receivedFrames: 0 },
    { at: 101_000, sentBytes: 0, receivedBytes: 20, sentFrames: 0, receivedFrames: 1 },
  ]);
  expect(window.snapshot(159_999).sentBytes).toBe(10);
  expect(window.snapshot(160_000).sentBytes).toBe(0);
  expect(window.snapshot(160_000).receivedBytes).toBe(20);
  expect(window.snapshot(161_000).receivedBytes).toBe(0);
  for (let second = 162; second < 500; second++) {
    window.record("received", 1, second * 1000);
  }
  const rolling = window.snapshot(499_000);
  expect(rolling.seconds).toHaveLength(60);
  expect(rolling.receivedBytes).toBe(60);
  expect(rolling.receivedFrames).toBe(60);
  expect(published.receivedBytes).toBe(20);
});

it("clears a window when the local clock moves backwards", () => {
  const window = new TrafficWindow();
  window.record("sent", 10, 200_000);
  expect(window.snapshot(100_000).sentBytes).toBe(0);
  window.record("received", 7, 101_000);
  expect(window.snapshot(101_000).receivedBytes).toBe(7);
  window.record("received", 3, 99_000);
  expect(window.snapshot(99_000).receivedBytes).toBe(3);
});
