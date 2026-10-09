/**
 * Turns the page's exports (`results/raw-<browser>-<timestamp>.json`) into
 * `results/summary-<date>.md`: per browser, the r1/Q-2 failure count and the r1/Q-4 statistics
 * (p95 nearest rank over the browser's successful main runs; median and max per length; n beside
 * each), every cold run flagged, the r1/A-2 stabilization variant apart, Firefox and Edge as best
 * effort (r1/A-7), the role-scope check and the r1/Q-5 checklist.
 *
 *   npx tsx spikes/s3-transcribe-browser/summarize.ts [--dir <results dir>] [--out <file.md>]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  BEST_EFFORT_BROWSERS,
  countsTowardRule,
  type Length,
  LENGTHS,
  MEASURED_BROWSERS,
} from "./src/scripts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    dir: { type: "string", default: join(here, "results") },
    out: { type: "string" },
  },
});

interface Run {
  id: string;
  at: string;
  browser: string;
  length: Length;
  variant: "main" | "stabilized";
  check: string;
  ok: boolean;
  failure?: { kind: string; detail: string };
  cold: boolean;
  stopReason?: string;
  latencyMs?: number;
  sendToEndMs?: number;
  wer?: number;
  marks: Record<string, number | undefined>;
  audio: { contextRate: number; secondsSent: number; maxLevel?: number };
}

interface Export {
  exportedAt: string;
  browser: string;
  userAgent: string;
  envLoads: { isSecureContext: boolean; loadContextState?: string; micPermissionAtLoad?: string }[];
  roleScope?: { denied: boolean; result: string };
  probe16k?: { honoured?: boolean; reportedRate?: number; micConnect?: string; error?: string };
  checklist: { manual: Record<string, string>; auto: Record<string, unknown> };
  runs: Run[];
}

const NFR_P95_MS = 2000;

/** Nearest-rank percentile (r1/Q-4). */
function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
const median = (values: number[]) => percentile(values, 50);
const ms = (v: number | undefined) => (v === undefined ? "–" : `${Math.round(v)}`);
/** A final that arrived before Send counts as 0 ms of waiting. */
const latency = (r: Run) => Math.max(0, r.latencyMs ?? 0);
const beforeSend = (r: Run) => r.ok && (r.latencyMs ?? 0) <= 0;
/** Send → the response stream's end: when a Transcriber's stop() can resolve with the transcript. */
const toEnd = (rs: Run[]) => rs.flatMap((r) => (r.ok && r.sendToEndMs !== undefined ? [r.sendToEndMs] : []));
const max = (v: number[]) => (v.length ? Math.max(...v) : undefined);

/** Every export must parse and carry its runs; a broken file stops the summary with its name. */
function readExport(file: string): Export {
  let parsed: Export;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Export;
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${String(error)}); see README "Results files"`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed.runs) || typeof parsed.browser !== "string")
    throw new Error(`${file} has no runs or browser`);
  return parsed;
}

// Exports may overlap (a browser exported twice): runs merge by id, the newest export wins the rest.
const exports = readdirSync(args.dir)
  .filter((f) => /^raw-.*\.json$/.test(f))
  .map((f) => readExport(join(args.dir, f)))
  .sort((a, b) => a.exportedAt.localeCompare(b.exportedAt));
const byBrowser = new Map<string, { latest: Export; runs: Map<string, Run> }>();
for (const e of exports) {
  const entry = byBrowser.get(e.browser) ?? { latest: e, runs: new Map<string, Run>() };
  entry.latest = e;
  for (const r of e.runs) entry.runs.set(r.id, r);
  byBrowser.set(e.browser, entry);
}

const lines: string[] = [];
const push = (...l: string[]) => lines.push(...l);
push(
  `# Spike S-3 results summary`,
  "",
  `Generated ${new Date().toISOString()} from ${exports.length} export(s) in \`results/\`.`,
  "",
);
push(
  "Latency is stop→final: from Send (or the 60 s auto-send) to the arrival of the last `IsPartial: false` result (r1/A-1). " +
    "p95 is nearest rank over the browser's successful main runs (r1/Q-4). A failed stream (r1/Q-2: the stream errored; the socket closed before Send, or after it without a clean code-1000 close; the stream ended with no final at all; or nothing ended within 10 s of Send) is not a latency sample. " +
    "When every final arrived before Send (the speaker paused before pressing it), the run is a success and stop→final counts as 0 ms; the 'final before Send' column counts those runs. " +
    "Send→end is the time to the end of the response stream, which is when a Transcriber's `stop()` can resolve with the whole transcript.",
  "",
);

push("## Main runs (r1/Q-2 rule and r1/Q-4 statistics)", "");
push(
  "| Browser | runs | failed (counted) | ok | p95 ms | final before Send | Send→end p95 ms | NFR-002 p95 ≤ 2 s | Q-2 (≤ 1 failed) | cold runs ms | tap→WS open ms, median warm (each cold) | tap→first result ms, median warm |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
);
for (const browser of [...MEASURED_BROWSERS, ...BEST_EFFORT_BROWSERS]) {
  const entry = byBrowser.get(browser);
  if (!entry) {
    push(`| ${browser} | not run | | | | | | | | | | |`);
    continue;
  }
  const main = [...entry.runs.values()].filter((r) => r.variant === "main" && countsTowardRule(r));
  const ok = main.filter((r) => r.ok);
  const failed = main.length - ok.length;
  const p95 = percentile(ok.map(latency), 95);
  // r1/Q-4 edges: the first stream after every page load is cold, so a browser can have several.
  const cold = main.filter((r) => r.cold);
  const warmOpen = median(
    main.filter((r) => !r.cold && r.marks.wsOpen !== undefined).map((r) => r.marks.wsOpen ?? 0),
  );
  const coldRuns = cold.map(
    (r) => `${ms(r.ok ? latency(r) : undefined)}${r.ok ? "" : ` (${r.failure?.kind})`}`,
  );
  const coldOpen = cold.map((r) => ms(r.marks.wsOpen));
  const warmFirst = median(
    main.filter((r) => !r.cold && r.marks.firstResult !== undefined).map((r) => r.marks.firstResult ?? 0),
  );
  const bestEffort = BEST_EFFORT_BROWSERS.includes(browser);
  push(
    `| ${browser}${bestEffort ? " (best effort)" : ""} | ${main.length} | ${failed} | ${ok.length} | ${ms(p95)} | ${ok.filter(beforeSend).length} | ${ms(percentile(toEnd(ok), 95))} | ${p95 === undefined ? "–" : p95 <= NFR_P95_MS ? "yes" : "**no**"} | ${bestEffort ? "n/a" : failed <= 1 ? "pass" : "**fail → batch fallback**"} | ${coldRuns.join(", ") || "–"} | ${ms(warmOpen)} (${coldOpen.join(", ") || "–"}) | ${ms(warmFirst)} |`,
  );
}
push("");

push(
  "## Per length, main runs",
  "",
  "| Browser | length | n ok / runs | median ms | max ms | final before Send | Send→end median / max ms | median WER |",
  "|---|---|---|---|---|---|---|---|",
);
for (const [browser, entry] of byBrowser) {
  for (const length of LENGTHS) {
    const set = [...entry.runs.values()].filter(
      (r) => r.variant === "main" && countsTowardRule(r) && r.length === length,
    );
    if (set.length === 0) continue;
    const ok = set.filter((r) => r.ok);
    const values = ok.map(latency);
    push(
      `| ${browser} | ${length} | ${ok.length} / ${set.length} | ${ms(median(values))} | ${ms(max(values))} | ${ok.filter(beforeSend).length} | ${ms(median(toEnd(ok)))} / ${ms(max(toEnd(ok)))} | ${median(ok.flatMap((r) => (r.wer === undefined ? [] : [r.wer])))?.toFixed(2) ?? "–"} |`,
    );
  }
}
push("");

push(
  "## Stabilization variant (r1/A-2 corrected; outside the Q-2 rule and the Q-4 count)",
  "",
  "| Browser | length | n ok / runs | median ms | max ms | p95 ms | final before Send | Send→end median / max ms |",
  "|---|---|---|---|---|---|---|---|",
);
for (const [browser, entry] of byBrowser) {
  for (const length of LENGTHS) {
    const set = [...entry.runs.values()].filter(
      (r) => r.variant === "stabilized" && countsTowardRule(r) && r.length === length,
    );
    if (set.length === 0) continue;
    const okSet = set.filter((r) => r.ok);
    const values = okSet.map(latency);
    push(
      `| ${browser} | ${length} | ${values.length} / ${set.length} | ${ms(median(values))} | ${ms(max(values))} | ${ms(percentile(values, 95))} | ${okSet.filter(beforeSend).length} | ${ms(median(toEnd(okSet)))} / ${ms(max(toEnd(okSet)))} |`,
    );
  }
}
push("");

push(
  "## Failures and deliberate checks",
  "",
  "| Browser | variant | length | check | outcome | detail |",
  "|---|---|---|---|---|---|",
);
for (const [browser, entry] of byBrowser) {
  for (const r of entry.runs.values()) {
    if (r.ok && countsTowardRule(r)) continue;
    push(
      `| ${browser} | ${r.variant} | ${r.length} | ${r.check} | ${r.ok ? `ok, ${ms(latency(r))} ms` : r.failure?.kind} | ${[r.failure?.detail ?? "", `audio sent ${r.audio.secondsSent.toFixed(1)} s of ${(((r.marks.stop ?? 0) - (r.marks.recording ?? 0)) / 1000).toFixed(1)} s recorded`].filter(Boolean).join("; ").replace(/\|/g, "/")} |`,
    );
  }
}
push("");

push(
  "## Role scope and secure context",
  "",
  "| Browser | isSecureContext | ListTranscriptionJobs | result |",
  "|---|---|---|---|",
);
for (const [browser, { latest }] of byBrowser) {
  push(
    `| ${browser} | ${[...new Set(latest.envLoads.map((e) => e.isSecureContext))].join(", ")} | ${latest.roleScope ? (latest.roleScope.denied ? "denied" : "**allowed**") : "not tried"} | ${(latest.roleScope?.result ?? "").replace(/\|/g, "/")} |`,
  );
}
push("");

push("## Behaviour checklist (r1/Q-5)", "");
for (const [browser, { latest }] of byBrowser) {
  push(`### ${browser}`, "", `User agent: \`${latest.userAgent}\``, "", "| Item | Result |", "|---|---|");
  for (const [k, v] of Object.entries(latest.checklist.auto)) push(`| ${k} (auto) | ${JSON.stringify(v)} |`);
  for (const [k, v] of Object.entries(latest.checklist.manual)) push(`| ${k} | ${v || "not recorded"} |`);
  push("");
}

const out = args.out ?? join(args.dir, `summary-${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`Wrote ${out}`);
