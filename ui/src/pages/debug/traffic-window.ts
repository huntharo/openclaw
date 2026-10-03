type TrafficSecond = {
  at: number;
  sentBytes: number;
  receivedBytes: number;
  sentFrames: number;
  receivedFrames: number;
};

export type TrafficSnapshot = {
  seconds: TrafficSecond[];
  sentBytes: number;
  receivedBytes: number;
  sentFrames: number;
  receivedFrames: number;
};

const WINDOW_SECONDS = 60;

/** Debug owns this counter-only window for one opt-in connection. */
export class TrafficWindow {
  private readonly buckets = Array.from({ length: WINDOW_SECONDS }, () => ({
    at: -1,
    sentBytes: 0,
    receivedBytes: 0,
    sentFrames: 0,
    receivedFrames: 0,
  }));
  private lastSecond = -1;

  private advance(now: number): number {
    const second = Math.floor(now / 1000);
    if (second < this.lastSecond) {
      for (const bucket of this.buckets) {
        bucket.at = -1;
      }
    }
    this.lastSecond = second;
    return second;
  }

  record(direction: "sent" | "received", bytes: number, now = Date.now()): void {
    const second = this.advance(now);
    const bucket = this.buckets[second % WINDOW_SECONDS]!;
    if (bucket.at !== second) {
      bucket.at = second;
      bucket.sentBytes = 0;
      bucket.receivedBytes = 0;
      bucket.sentFrames = 0;
      bucket.receivedFrames = 0;
    }
    if (direction === "sent") {
      bucket.sentBytes += bytes;
      bucket.sentFrames += 1;
    } else {
      bucket.receivedBytes += bytes;
      bucket.receivedFrames += 1;
    }
  }

  snapshot(now = Date.now()): TrafficSnapshot {
    const second = this.advance(now);
    const result: TrafficSnapshot = {
      seconds: [],
      sentBytes: 0,
      receivedBytes: 0,
      sentFrames: 0,
      receivedFrames: 0,
    };
    for (let at = second - WINDOW_SECONDS + 1; at <= second; at++) {
      const bucket = at >= 0 ? this.buckets[at % WINDOW_SECONDS] : undefined;
      const sample = {
        at: at * 1000,
        sentBytes: bucket?.at === at ? bucket.sentBytes : 0,
        receivedBytes: bucket?.at === at ? bucket.receivedBytes : 0,
        sentFrames: bucket?.at === at ? bucket.sentFrames : 0,
        receivedFrames: bucket?.at === at ? bucket.receivedFrames : 0,
      };
      result.seconds.push(sample);
      result.sentBytes += sample.sentBytes;
      result.receivedBytes += sample.receivedBytes;
      result.sentFrames += sample.sentFrames;
      result.receivedFrames += sample.receivedFrames;
    }
    return result;
  }
}
