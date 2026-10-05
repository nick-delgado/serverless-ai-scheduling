// Turns a Stryker JSON report into the small text summary the trial commits (#113): a per-file count of
// mutant statuses and one line per mutant that wasn't killed (Survived, NoCoverage), with its location,
// mutator, original text and replacement. The full JSON and HTML reports aren't committed (several hundred
// KB each, with local paths).
//
//   node spikes/stryker/summarize.mjs <report.json> > <summary.txt>
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const statuses = ["Killed", "Timeout", "Survived", "NoCoverage", "CompileError", "RuntimeError", "Ignored"];
const out = [`file\t${statuses.join("\t")}\tscore`];
const lines = [];
let totals = Object.fromEntries(statuses.map((s) => [s, 0]));
for (const [name, file] of Object.entries(report.files)) {
  const rel = name.replace(/^.*?(?=(packages|services|apps|scripts)\/)/, "");
  const count = Object.fromEntries(statuses.map((s) => [s, 0]));
  const source = file.source.split("\n");
  for (const m of file.mutants) {
    count[m.status] = (count[m.status] ?? 0) + 1;
    if (m.status !== "Survived" && m.status !== "NoCoverage") continue;
    const { start, end } = m.location;
    const original =
      start.line === end.line
        ? source[start.line - 1].slice(start.column - 1, end.column - 1)
        : source
            .slice(start.line - 1, end.line)
            .join("\n")
            .slice(start.column - 1);
    const flat = (s) => s.replace(/\s+/g, " ").trim().slice(0, 120);
    lines.push(
      `${m.status}\t${m.id}\t${rel}:${start.line}:${start.column}\t${m.mutatorName}\t${flat(original)}\t→\t${flat(m.replacement ?? "")}`,
    );
  }
  for (const s of statuses) totals[s] += count[s];
  out.push(`${rel}\t${statuses.map((s) => count[s]).join("\t")}\t${score(count)}`);
}
out.push(`total\t${statuses.map((s) => totals[s]).join("\t")}\t${score(totals)}`);
console.log(out.join("\n"));
console.log("\nNot killed (status, id, location, mutator, original → replacement):");
console.log(lines.join("\n"));

function score(c) {
  const detected = c.Killed + c.Timeout;
  const valid = detected + c.Survived + c.NoCoverage;
  return valid === 0 ? "n/a" : `${((100 * detected) / valid).toFixed(2)}%`;
}
