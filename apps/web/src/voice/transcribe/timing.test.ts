/** The AC6 timing record (#29 r2/Q-2 (a)): classification, the store, p95 and the summary. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classify,
  CLIP_MIX,
  createTimingObserver,
  exportTiming,
  p95,
  summarize,
  TIMEOUT_CANCEL_MS,
  TIMING_STORAGE_KEY,
  type TimingRun,
  TimingStore,
} from "./timing";

/** In-memory `Storage`. */
function memoryStorage(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [[TIMING_STORAGE_KEY, initial]]);
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

function run(overrides: Partial<TimingRun> = {}): TimingRun {
  return {
    browser: "chrome-desktop",
    clip: "5s",
    deliberate: false,
    at: "2026-10-09T12:00:00.000Z",
    outcome: "ok",
    finals: 1,
    finalsBeforeSend: 0,
    stopToFinalMs: 100,
    sendToEndMs: 150,
    ...overrides,
  };
}

describe("classify", () => {
  const ok = { status: "ok", transcript: "Hi." } as const;

  it("measures stop→final from Send to the last final, and Send→stream end", () => {
    expect(classify({ recording: 0, send: 5_000, finals: [4_000, 5_180], end: 5_300 }, ok)).toEqual({
      outcome: "ok",
      finals: 2,
      finalsBeforeSend: 1,
      recordedMs: 5_000,
      stopToFinalMs: 180,
      sendToEndMs: 300,
      transcript: "Hi.",
    });
  });

  it("counts every final before Send as 0 ms (PR #225)", () => {
    expect(classify({ recording: 0, send: 5_000, finals: [4_900], end: 5_200 }, ok)).toMatchObject({
      outcome: "ok",
      stopToFinalMs: 0,
      finalsBeforeSend: 1,
    });
  });

  it("is a failure with no final at all", () => {
    expect(classify({ recording: 0, send: 5_000, finals: [], end: 5_200 }, ok)).toMatchObject({
      outcome: "failed",
      failure: "no-final",
    });
  });

  it("keeps the failure's reason", () => {
    expect(
      classify(
        { recording: 0, finals: [], end: 900 },
        { status: "failed", reason: "hidden", detail: "hidden" },
      ),
    ).toEqual({ outcome: "failed", failure: "hidden", detail: "hidden", finals: 0, finalsBeforeSend: 0 });
  });

  it("is a timeout when the overlay gave up 10 s after Send", () => {
    expect(
      classify(
        { recording: 0, send: 5_000, finals: [], end: 5_000 + TIMEOUT_CANCEL_MS },
        { status: "cancelled", afterSend: true },
      ),
    ).toMatchObject({ outcome: "failed", failure: "timeout" });
  });

  it("is a tester's cancel, which doesn't count, sooner after Send or before it", () => {
    expect(
      classify(
        { recording: 0, send: 5_000, finals: [], end: 6_000 },
        { status: "cancelled", afterSend: true },
      ),
    ).toMatchObject({ outcome: "cancelled" });
    expect(
      classify({ recording: 0, finals: [], end: 900 }, { status: "cancelled", afterSend: false }),
    ).toMatchObject({
      outcome: "cancelled",
    });
  });
});

describe("createTimingObserver", () => {
  it("marks each step with the clock and stores the run with the current labels", () => {
    const store = new TimingStore(memoryStorage());
    store.setLabels({ browser: "ios-safari", clip: "20s" });
    const times = [100, 20_100, 20_250, 20_300];
    const observer = createTimingObserver(
      store,
      () => times.shift() ?? 0,
      () => new Date("2026-10-09T12:00:00Z"),
    );
    observer.recording();
    observer.send();
    observer.final();
    observer.end({ status: "ok", transcript: "Hello." });
    expect(store.snapshot().runs).toEqual([
      {
        browser: "ios-safari",
        clip: "20s",
        deliberate: false,
        at: "2026-10-09T12:00:00.000Z",
        outcome: "ok",
        finals: 1,
        finalsBeforeSend: 0,
        recordedMs: 20_000,
        stopToFinalMs: 150,
        sendToEndMs: 200,
        transcript: "Hello.",
      },
    ]);
  });
});

describe("TimingStore", () => {
  it("persists labels and runs to storage and reads them back after a reload", () => {
    const storage = memoryStorage();
    const store = new TimingStore(storage);
    store.setLabels({ deliberate: true });
    store.addRun(run());
    store.addRoleCheck({ at: "t", action: "a", denied: true, result: "r" });
    const reloaded = new TimingStore(storage);
    expect(reloaded.snapshot()).toEqual(store.snapshot());
    expect(reloaded.snapshot().labels).toEqual({ browser: "chrome-desktop", clip: "5s", deliberate: true });
  });

  it("removes the last run, clears runs and checks but keeps the labels, and tells subscribers", () => {
    const store = new TimingStore(memoryStorage());
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.setLabels({ clip: "60s" });
    store.addRun(run({ at: "1" }));
    store.addRun(run({ at: "2" }));
    store.removeLastRun();
    expect(store.snapshot().runs.map((r) => r.at)).toEqual(["1"]);
    store.clear();
    expect(store.snapshot()).toMatchObject({ runs: [], roleChecks: [], labels: { clip: "60s" } });
    expect(listener).toHaveBeenCalledTimes(5);
    stop();
    store.addRun(run());
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it("starts empty from unreadable storage, and keeps working in memory when writes fail", () => {
    const store = new TimingStore({
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(store.snapshot().runs).toEqual([]);
    store.addRun(run());
    expect(store.snapshot().runs).toHaveLength(1);
    expect(new TimingStore(undefined).snapshot().runs).toEqual([]);
  });
});

describe("p95", () => {
  it("is the nearest rank: the 19th of 20, the largest of 10", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(p95(twenty)).toBe(190);
    expect(p95([5, 1, 9, 3, 7, 2, 8, 4, 6, 10])).toBe(10);
    expect(p95([])).toBeUndefined();
  });
});

describe("summarize", () => {
  it("counts per browser, leaving out deliberate checks and the tester's cancels", () => {
    const runs = [
      run({ stopToFinalMs: 0, sendToEndMs: 90 }),
      run({ clip: "20s", stopToFinalMs: 200, sendToEndMs: 300 }),
      run({
        clip: "60s",
        outcome: "failed",
        failure: "error",
        stopToFinalMs: undefined,
        sendToEndMs: undefined,
      }),
      run({ deliberate: true, outcome: "failed", failure: "hidden" }),
      run({ outcome: "cancelled" }),
      run({ browser: "android-chrome", stopToFinalMs: 120, sendToEndMs: 220 }),
    ];
    expect(summarize(runs)).toEqual([
      {
        browser: "chrome-desktop",
        runs: 3,
        ok: 2,
        failed: 1,
        byClip: { "5s": 1, "20s": 1, "60s": 1 },
        stopToFinalP95: 200,
        sendToEndP95: 300,
        finalBeforeSend: 1,
      },
      {
        browser: "android-chrome",
        runs: 1,
        ok: 1,
        failed: 0,
        byClip: { "5s": 1, "20s": 0, "60s": 0 },
        stopToFinalP95: 120,
        sendToEndP95: 220,
        finalBeforeSend: 0,
      },
    ]);
  });

  it("has no p95 for a browser whose runs all failed", () => {
    const [row] = summarize([run({ outcome: "failed", failure: "timeout" })]);
    expect(row).toMatchObject({ failed: 1 });
    expect(row).not.toHaveProperty("stopToFinalP95");
  });

  it("asks for 20 runs per measured browser: 7 × 5 s, 7 × 20 s, 6 × 60 s", () => {
    expect(CLIP_MIX).toEqual({ "5s": 7, "20s": 7, "60s": 6 });
  });
});

describe("exportTiming", () => {
  it("writes the runs, role checks, summary and user agent as JSON", () => {
    const data = {
      labels: { browser: "edge", clip: "5s", deliberate: false },
      runs: [run()],
      roleChecks: [],
    } as const;
    const parsed = JSON.parse(
      exportTiming({ ...data, runs: [...data.runs], roleChecks: [] }, "UA/1", new Date(0)),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      kind: "sched-voice-timing",
      exportedAt: "1970-01-01T00:00:00.000Z",
      userAgent: "UA/1",
      runs: [run()],
      roleChecks: [],
    });
    expect(parsed.summary).toEqual(summarize([run()]));
  });
});

describe("the app's store", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses local storage, and the default observer the real clocks", async () => {
    vi.resetModules();
    localStorage.clear();
    const fresh = await import("./timing");
    const observer = fresh.createTimingObserver();
    observer.recording();
    observer.send();
    observer.end({ status: "ok", transcript: "" });
    expect(fresh.timingStore.snapshot().runs).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(TIMING_STORAGE_KEY) ?? "{}")).toMatchObject({
      runs: [{ outcome: "failed" }],
    });
    localStorage.clear();
  });

  it("keeps runs in memory where local storage can't be reached", async () => {
    vi.resetModules();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const fresh = await import("./timing");
    fresh.timingStore.addRun(run());
    expect(fresh.timingStore.snapshot().runs).toHaveLength(1);
  });
});
