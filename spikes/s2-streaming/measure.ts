/**
 * Spike S-2 (#7): does POST /api/chat stream incrementally through CloudFront → API Gateway REST
 * (response streaming) → Lambda → Bedrock, and what do TTFB and total time look like?
 *
 * Signs in the skeleton test user with Cognito SRP, then sends the same prompt N times per target
 * (CloudFront and the direct execute-api URL, round-robin), paced so the account's 10 req/min Bedrock
 * quota is never at risk. For each request it records time to response headers, first body chunk,
 * first text_delta, and done, plus every chunk's arrival time. Then it checks the negative paths
 * (no token, bad token, bad body) and joins the Lambda's own timing log lines by request ID.
 *
 * Usage (from the repo root, credentials in spikes/s2-streaming/.env, see README.md):
 *   AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx spikes/s2-streaming/measure.ts --runs 10 --pace-ms 8000
 *
 * Throwaway spike code: informs ADR-007, not production.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { parseStreamEventLine, type ChatStreamEvent } from "@sched/contracts";

import { here, loadConfig, redactor, signIn } from "./common";

const { values: args } = parseArgs({
  options: {
    env: { type: "string", default: "dev" },
    runs: { type: "string", default: "10" },
    // ≥ 8 s between live (Bedrock-calling) requests: the account quota is 10 req/min, shared.
    "pace-ms": { type: "string", default: "8000" },
    targets: { type: "string", default: "cloudfront,direct" },
    text: {
      type: "string",
      default:
        "In about 120 words, what should I bring to my first appointment at the clinic? Plain sentences, no lists.",
    },
  },
});
const RUNS = Number(args.runs);
const PACE_MS = Math.max(8000, Number(args["pace-ms"]));
type Target = "cloudfront" | "direct";
const TARGETS = args.targets.split(",") as Target[];

const cfg = loadConfig(args.env);
const redact = redactor(cfg);
const URLS: Record<Target, string> = {
  cloudfront: `https://${cfg.cloudfrontDomain}/api/chat`,
  direct: `https://${cfg.executeApiDomain}/${cfg.stage}/api/chat`,
};

// ---------------------------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------------------------

interface Chunk {
  ms: number;
  bytes: number;
  events: number;
}

interface RunResult {
  target: Target;
  run: number;
  startedAt: string;
  status: number;
  headers: Record<string, string>;
  msHeaders: number;
  msFirstChunk: number | null;
  msFirstDelta: number | null;
  msLastDelta: number | null;
  msTotal: number;
  deltaCount: number;
  chunks: Chunk[];
  terminal: ChatStreamEvent | null;
  replyChars: number;
  apiRequestId: string | null;
  server?: { firstDeltaMs: number | null; totalMs: number; deltas: number; outcome: string };
}

const HEADERS_OF_INTEREST = [
  "content-type",
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "x-cache",
  "via",
  "x-amz-cf-pop",
  "x-amzn-requestid",
  "x-amzn-errortype",
];

async function chat(target: Target, run: number, token: string | null, body: string): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const since = (): number => Math.round((performance.now() - t0) * 10) / 10;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;

  const res = await fetch(URLS[target], { method: "POST", headers, body });
  const msHeaders = since();
  const picked: Record<string, string> = {};
  for (const h of HEADERS_OF_INTEREST) {
    const v = res.headers.get(h);
    if (v !== null) picked[h] = redact(v);
  }

  const chunks: Chunk[] = [];
  let msFirstDelta: number | null = null;
  let msLastDelta: number | null = null;
  let deltaCount = 0;
  let replyChars = 0;
  let terminal: ChatStreamEvent | null = null;
  let buffered = "";
  const decoder = new TextDecoder();
  const isNdjson = (res.headers.get("content-type") ?? "").includes("ndjson");

  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const ms = since();
      buffered += decoder.decode(value, { stream: true });
      let events = 0;
      let newline = buffered.indexOf("\n");
      while (isNdjson && newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line.trim()) continue;
        const event = parseStreamEventLine(line);
        events += 1;
        if (event.type === "text_delta") {
          deltaCount += 1;
          replyChars += event.text.length;
          msFirstDelta ??= ms;
          msLastDelta = ms;
        } else if (event.type === "done" || event.type === "error") {
          terminal = event;
        }
      }
      chunks.push({ ms, bytes: value.byteLength, events });
    }
  }
  return {
    target,
    run,
    startedAt,
    status: res.status,
    headers: picked,
    msHeaders,
    msFirstChunk: chunks[0]?.ms ?? null,
    msFirstDelta,
    msLastDelta,
    msTotal: since(),
    deltaCount,
    chunks,
    terminal:
      terminal ??
      (isNdjson
        ? null
        : { type: "error", code: "INTERNAL", message: buffered.slice(0, 200) || "-", retryable: false }),
    replyChars,
    apiRequestId: res.headers.get("x-amzn-requestid"),
  };
}

// ---------------------------------------------------------------------------------------------
// Server-side timings from the Lambda's JSON log ("chat turn" lines, joined by API request ID)
// ---------------------------------------------------------------------------------------------

function serverTimings(startMs: number): Map<string, NonNullable<RunResult["server"]>> {
  const out = new Map<string, NonNullable<RunResult["server"]>>();
  const raw = execFileSync(
    "aws",
    [
      "logs",
      "filter-log-events",
      "--log-group-name",
      `/aws/lambda/sched-${args.env}-api-chat-skeleton`,
      "--start-time",
      String(startMs),
      "--filter-pattern",
      '"chat turn"',
      "--query",
      "events[].message",
      "--output",
      "json",
    ],
    { encoding: "utf8" },
  );
  for (const line of JSON.parse(raw) as string[]) {
    try {
      const parsed = JSON.parse(line) as { message?: Record<string, unknown> };
      const m = parsed.message;
      if (m?.msg !== "chat turn" || typeof m.requestId !== "string") continue;
      out.set(m.requestId, {
        firstDeltaMs: typeof m.firstDeltaMs === "number" ? m.firstDeltaMs : null,
        totalMs: Number(m.totalMs),
        deltas: Number(m.deltas),
        outcome: String(m.outcome),
      });
    } catch {
      // not one of ours
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stats + report
// ---------------------------------------------------------------------------------------------

/** Nearest-rank percentile (with n=10, p95 is the maximum). */
function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}
const nums = (xs: (number | null | undefined)[]): number[] =>
  xs.filter((x): x is number => typeof x === "number");
const fmt = (ms: number | null): string => (ms === null ? "–" : `${(ms / 1000).toFixed(2)} s`);

function summaryRow(label: string, values: number[]): string {
  return `| ${label} | ${fmt(pct(values, 50))} | ${fmt(pct(values, 95))} | ${fmt(values.length ? Math.min(...values) : null)} | ${fmt(values.length ? Math.max(...values) : null)} |`;
}

async function main(): Promise<void> {
  const logStart = Date.now() - 60_000;
  const token = await signIn(cfg);
  console.log(`signed in; targets ${TARGETS.join(", ")}; ${RUNS} runs each; pace ${PACE_MS} ms`);

  const body = JSON.stringify({ clientMessageId: crypto.randomUUID(), text: args.text });
  const results: RunResult[] = [];
  let lastLiveCall = 0;
  const pace = async (): Promise<void> => {
    const wait = lastLiveCall + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastLiveCall = Date.now();
  };

  for (let run = 1; run <= RUNS; run++) {
    for (const target of TARGETS) {
      await pace();
      const r = await chat(
        target,
        run,
        token,
        JSON.stringify({ ...JSON.parse(body), clientMessageId: crypto.randomUUID() }),
      );
      results.push(r);
      console.log(
        `${target.padEnd(10)} #${run} HTTP ${r.status} headers ${fmt(r.msHeaders)} firstDelta ${fmt(r.msFirstDelta)} ` +
          `total ${fmt(r.msTotal)} deltas ${r.deltaCount} chunks ${r.chunks.length} → ${r.terminal?.type ?? "no terminal event"}`,
      );
    }
  }

  // Negative paths. None of these reach Bedrock, so no pacing needed.
  const negatives: {
    check: string;
    target: Target;
    status: number;
    body: string;
    contentType: string | null;
  }[] = [];
  for (const target of TARGETS) {
    for (const [check, tok, b] of [
      ["no token", null, body],
      ["malformed token", "not.a.jwt", body],
      ["bad body (valid token)", token, JSON.stringify({ text: "missing clientMessageId" })],
    ] as const) {
      const res = await fetch(URLS[target], {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { Authorization: tok } : {}) },
        body: b,
      });
      negatives.push({
        check,
        target,
        status: res.status,
        body: redact(await res.text()).trim(),
        contentType: res.headers.get("content-type"),
      });
    }
  }
  console.table(negatives);

  // Lambda logs arrive a few seconds late.
  await sleep(10_000);
  const server = serverTimings(logStart);
  for (const r of results) {
    const s = r.apiRequestId ? server.get(r.apiRequestId) : undefined;
    if (s) r.server = s;
  }

  // Write results.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  const redactedResults = JSON.parse(redact(JSON.stringify({ args, results, negatives }))) as unknown;
  writeFileSync(join(outDir, `raw-${stamp}.json`), `${JSON.stringify(redactedResults, null, 2)}\n`);

  const lines: string[] = [];
  lines.push(`# Spike S-2 results, ${stamp}`, "");
  lines.push(`Prompt: "${args.text}"  `);
  lines.push(
    `Runs: ${RUNS} per target, round-robin, ≥ ${PACE_MS / 1000} s apart. Model: us.anthropic.claude-sonnet-4-6 (no thinking), from a laptop.`,
    "",
  );
  for (const target of TARGETS) {
    const rs = results.filter((r) => r.target === target && r.status === 200);
    const ok = rs.filter((r) => r.terminal?.type === "done");
    lines.push(
      `## ${target === "cloudfront" ? "Via CloudFront (/api/chat)" : "Direct execute-api (/<stage>/api/chat)"}`,
      "",
    );
    lines.push(
      `${ok.length}/${results.filter((r) => r.target === target).length} runs ended with \`done\`.`,
      "",
    );
    lines.push("| Metric | p50 | p95 | min | max |", "|---|---|---|---|---|");
    lines.push(summaryRow("Response headers (fetch resolves)", nums(rs.map((r) => r.msHeaders))));
    lines.push(summaryRow("First body chunk (TTFB)", nums(rs.map((r) => r.msFirstChunk))));
    lines.push(summaryRow("First `text_delta`", nums(rs.map((r) => r.msFirstDelta))));
    lines.push(summaryRow("Total (stream ended)", nums(rs.map((r) => r.msTotal))));
    lines.push(
      summaryRow(
        "First → last delta (spread)",
        nums(rs.map((r) => (r.msLastDelta ?? 0) - (r.msFirstDelta ?? 0))),
      ),
    );
    lines.push(summaryRow("Server: first delta (Lambda log)", nums(rs.map((r) => r.server?.firstDeltaMs))));
    lines.push(summaryRow("Server: total (Lambda log)", nums(rs.map((r) => r.server?.totalMs))));
    lines.push("");
    const chunkCounts = rs.map((r) => r.chunks.length);
    const deltaCounts = rs.map((r) => r.deltaCount);
    lines.push(
      `Network chunks per response: median ${pct(chunkCounts, 50)}, min ${Math.min(...chunkCounts)}; ` +
        `text_delta events per response: median ${pct(deltaCounts, 50)}.`,
    );
    const example = rs[Math.floor(rs.length / 2)];
    if (example) {
      lines.push("", `Chunk arrival times for run #${example.run} (ms since request, bytes, events):`, "");
      lines.push("```", example.chunks.map((c) => `${c.ms}\t${c.bytes}\t${c.events}`).join("\n"), "```");
      lines.push("", `Response headers: \`${JSON.stringify(example.headers)}\``);
    }
    lines.push("");
  }
  lines.push(
    "## Negative paths",
    "",
    "| Check | Target | HTTP | Content-Type | Body |",
    "|---|---|---|---|---|",
  );
  for (const n of negatives)
    lines.push(
      `| ${n.check} | ${n.target} | ${n.status} | ${n.contentType ?? "–"} | \`${n.body.slice(0, 160)}\` |`,
    );
  lines.push("");
  writeFileSync(join(outDir, `summary-${stamp}.md`), `${redact(lines.join("\n"))}\n`);
  console.log(`wrote results/raw-${stamp}.json and results/summary-${stamp}.md`);
}

await main();
