/**
 * The voice timing record for #29's AC6 runs (r2/Q-2 (a)). Only builds made with
 * `VITE_VOICE_TIMING=1` load this module (`../voiceTiming.ts`); `build.test.ts` checks that other
 * builds contain none of it. Nothing here is sent anywhere: runs stay in this browser's local storage
 * until the tester exports them from the timing panel (`TimingPanel.tsx`).
 *
 * Per recording, from `performance.now()`: Send (or the 60 s auto-send), each final result, and the
 * end of the stream (ADR-006 Validation, as spike S-3 measured it):
 * - stop→final = last final − Send, and 0 ms when every final arrived before Send (PR #225);
 * - Send→stream end = when `stop()` resolves − Send, what the patient waits for;
 * - a failed stream is an error, the stream ending before Send, no final at all, or no end within
 *   10 s of Send (the overlay gives up and cancels; #10 r1/Q-2). The page becoming hidden is its own
 *   kind, `hidden` (r2/Q-1). A run the tester marks as a deliberate check doesn't count, nor does
 *   one cancelled by the tester (r2/Q-2 edges).
 *
 * The SDK closes its stream without an error on any socket close, so a socket that drops after Send
 * with some finals received counts as `ok` here; its transcript, kept in the record, shows the cut.
 */
import { FINAL_TIMEOUT_MS } from "../useRecording";
import type { FailureReason, StreamObserver, StreamOutcome } from "./RealTranscriber";

export const TIMING_STORAGE_KEY = "sched.voiceTiming";

/** The measured browsers first (AC6), then the best-effort ones; spike S-3's labels. */
export const BROWSERS = [
  "chrome-desktop",
  "safari-macos",
  "ios-safari",
  "android-chrome",
  "firefox",
  "edge",
] as const;
export type Browser = (typeof BROWSERS)[number];

export const CLIPS = ["5s", "20s", "60s"] as const;
export type Clip = (typeof CLIPS)[number];

/** Each measured browser's mix (ADR-006 "For #29"): 20 runs. */
export const CLIP_MIX: Record<Clip, number> = { "5s": 7, "20s": 7, "60s": 6 };

/** A cancel this long after Send is the overlay's 10 s timer giving up, not the tester. */
const TIMEOUT_CANCEL_MS = FINAL_TIMEOUT_MS - 500;

export type FailureKind = FailureReason | "no-final" | "timeout";

export interface TimingLabels {
  browser: Browser;
  clip: Clip;
  /** A deliberate check (a hidden page on purpose): recorded, never counted. */
  deliberate: boolean;
}

export interface TimingRun extends TimingLabels {
  /** ISO time the run ended. */
  at: string;
  outcome: "ok" | "failed" | "cancelled";
  failure?: FailureKind;
  detail?: string;
  /** Recording start → Send. */
  recordedMs?: number;
  stopToFinalMs?: number;
  sendToEndMs?: number;
  finals: number;
  finalsBeforeSend: number;
  /** The transcript (the tester reads synthetic scripts), to check a run ends with the script's last words. */
  transcript?: string;
}

export interface RoleCheck {
  at: string;
  action: string;
  denied: boolean;
  result: string;
}

export interface TimingData {
  labels: TimingLabels;
  runs: TimingRun[];
  roleChecks: RoleCheck[];
}

const DEFAULT_LABELS: TimingLabels = { browser: "chrome-desktop", clip: "5s", deliberate: false };

function emptyData(): TimingData {
  return { labels: { ...DEFAULT_LABELS }, runs: [], roleChecks: [] };
}

/** The runs, kept in local storage so a reload doesn't lose them; in memory if storage fails. */
export class TimingStore {
  private data: TimingData;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined) {
    this.data = this.load();
  }

  snapshot = (): TimingData => this.data;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setLabels(labels: Partial<TimingLabels>): void {
    this.update({ labels: { ...this.data.labels, ...labels } });
  }

  addRun(run: TimingRun): void {
    this.update({ runs: [...this.data.runs, run] });
  }

  removeLastRun(): void {
    this.update({ runs: this.data.runs.slice(0, -1) });
  }

  addRoleCheck(check: RoleCheck): void {
    this.update({ roleChecks: [...this.data.roleChecks, check] });
  }

  clear(): void {
    this.update({ runs: [], roleChecks: [] });
  }

  private load(): TimingData {
    try {
      const raw = this.storage?.getItem(TIMING_STORAGE_KEY);
      return raw ? { ...emptyData(), ...(JSON.parse(raw) as Partial<TimingData>) } : emptyData();
    } catch {
      return emptyData();
    }
  }

  private update(changes: Partial<TimingData>): void {
    this.data = { ...this.data, ...changes };
    try {
      this.storage?.setItem(TIMING_STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // In memory only: export before leaving the page.
    }
    for (const listener of this.listeners) listener();
  }
}

function browserStorage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

export const timingStore = new TimingStore(browserStorage());

/** The run's measurements from its marks (milliseconds, `performance.now()`) and outcome. */
export function classify(
  marks: { recording?: number; send?: number; finals: number[]; end: number },
  outcome: StreamOutcome,
): Omit<TimingRun, keyof TimingLabels | "at"> {
  const { recording, send, finals, end } = marks;
  const lastFinal = finals.at(-1);
  const base = {
    finals: finals.length,
    finalsBeforeSend: send === undefined ? finals.length : finals.filter((at) => at < send).length,
    ...(recording !== undefined && send !== undefined ? { recordedMs: send - recording } : {}),
  };
  if (outcome.status === "cancelled") {
    if (outcome.afterSend && send !== undefined && end - send >= TIMEOUT_CANCEL_MS) {
      return {
        ...base,
        outcome: "failed",
        failure: "timeout",
        detail: `no stream end within ${FINAL_TIMEOUT_MS} ms of Send`,
      };
    }
    return { ...base, outcome: "cancelled" };
  }
  if (outcome.status === "failed") {
    return { ...base, outcome: "failed", failure: outcome.reason, detail: outcome.detail };
  }
  // An ok stream has always been sent; no final at all is a failed stream.
  if (lastFinal === undefined || send === undefined) {
    return { ...base, outcome: "failed", failure: "no-final", transcript: outcome.transcript };
  }
  return {
    ...base,
    outcome: "ok",
    stopToFinalMs: Math.max(0, lastFinal - send),
    sendToEndMs: end - send,
    transcript: outcome.transcript,
  };
}

/** A timing observer for one recording, which adds the run to `store` when it ends. */
export function createTimingObserver(
  store: TimingStore = timingStore,
  now: () => number = () => performance.now(),
  clock: () => Date = () => new Date(),
): StreamObserver {
  const marks: { recording?: number; send?: number; finals: number[] } = { finals: [] };
  return {
    recording: () => (marks.recording = now()),
    send: () => (marks.send = now()),
    final: () => marks.finals.push(now()),
    end: (outcome) => {
      const run = classify({ ...marks, end: now() }, outcome);
      store.addRun({ ...store.snapshot().labels, at: clock().toISOString(), ...run });
    },
  };
}

/** Nearest-rank p95, as ADR-006's Validation computes it; undefined for no values. */
export function p95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

export interface BrowserSummary {
  browser: Browser;
  /** Runs that count: not deliberate checks, not cancelled by the tester. */
  runs: number;
  ok: number;
  failed: number;
  byClip: Record<Clip, number>;
  stopToFinalP95?: number;
  sendToEndP95?: number;
  /** OK runs whose finals all arrived before Send (0 ms stop→final). */
  finalBeforeSend: number;
}

const isNumber = (value: number | undefined): value is number => value !== undefined;

/** AC6's per-browser numbers, over the runs that count. */
export function summarize(runs: readonly TimingRun[]): BrowserSummary[] {
  return BROWSERS.flatMap((browser) => {
    const counted = runs.filter(
      (run) => run.browser === browser && !run.deliberate && run.outcome !== "cancelled",
    );
    if (counted.length === 0) return [];
    const ok = counted.filter((run) => run.outcome === "ok");
    const stopToFinalP95 = p95(ok.map((run) => run.stopToFinalMs).filter(isNumber));
    const sendToEndP95 = p95(ok.map((run) => run.sendToEndMs).filter(isNumber));
    return [
      {
        browser,
        runs: counted.length,
        ok: ok.length,
        failed: counted.length - ok.length,
        byClip: {
          "5s": counted.filter((run) => run.clip === "5s").length,
          "20s": counted.filter((run) => run.clip === "20s").length,
          "60s": counted.filter((run) => run.clip === "60s").length,
        },
        ...(stopToFinalP95 !== undefined ? { stopToFinalP95 } : {}),
        ...(sendToEndP95 !== undefined ? { sendToEndP95 } : {}),
        finalBeforeSend: ok.filter((run) => run.stopToFinalMs === 0).length,
      },
    ];
  });
}

/** The export file: every run and role check, the summary, and the browser's user agent. */
export function exportTiming(data: TimingData, userAgent: string, exportedAt: Date): string {
  return JSON.stringify(
    {
      kind: "sched-voice-timing",
      exportedAt: exportedAt.toISOString(),
      userAgent,
      summary: summarize(data.runs),
      runs: data.runs,
      roleChecks: data.roleChecks,
    },
    null,
    2,
  );
}
