// Compares two runs of the same edit list (mutate.ts --json outputs), row by row: the status and the failing
// tests at each commit, and whether each claimed test (the PR table's "Tests that went red", `claimed` in the
// edit list, split on ";") is among the failing tests. #113 AC 7 (readiness review A-8).
//
//   node spikes/stryker/compare-rows.mjs <edits.json> <before.json> <after.json> [labelBefore] [labelAfter]
import { readFileSync } from "node:fs";

const [editsFile, beforeFile, afterFile, lb = "before", la = "after"] = process.argv.slice(2);
const edits = JSON.parse(readFileSync(editsFile, "utf8"));
const byId = (file) => new Map(JSON.parse(readFileSync(file, "utf8")).results.map((r) => [r.id, r]));
const before = byId(beforeFile);
const after = byId(afterFile);
// "replays an answered…" matches a test whose title starts with "replays an answered".
const stem = (claim) =>
  claim
    .replace(/\(.*?\)/g, "")
    .replace(/^[\w.-]+\.test\.tsx?:\s*/, "")
    .replace(/….*$/, "")
    .trim();
const names = (r) => (r?.failedTests ?? []).map((t) => t.split(" > ").slice(1).join(" > "));
const covers = (r, claim) => names(r).some((n) => n.includes(stem(claim)));

for (const edit of edits) {
  const b = before.get(edit.id);
  const a = after.get(edit.id);
  const claims = (edit.claimed ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !/^the (same|three)/.test(c));
  const missing = (r) => claims.filter((c) => !covers(r, c));
  const gone = names(b).filter((n) => !names(a).includes(n));
  const added = names(a).filter((n) => !names(b).includes(n));
  const changed = b?.status !== a?.status || gone.length > 0 || added.length > 0;
  console.log(
    `${edit.id}\t${lb} ${b?.status ?? "-"} (${names(b).length})\t${la} ${a?.status ?? "-"} (${names(a).length})` +
      `${changed ? "\tCHANGED" : ""}${missing(a).length ? `\tclaimed but green at ${la}: ${missing(a).join(" | ")}` : ""}`,
  );
  for (const n of gone) console.log(`    - red at ${lb} only: ${n}`);
  for (const n of added) console.log(`    + red at ${la} only: ${n}`);
}
