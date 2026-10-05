/**
 * Exact-edit mutation runner (#113 trial; the #72 PR #132 review's P1, with the readiness review's A-5 edge cases).
 *
 *   npx tsx spikes/stryker/mutate.ts <edits.json> [--timeout <s>] [--json <out.json>] [--only <id,...>] -- <test command...>
 *
 * `edits.json` is a list of `{ "id"?, "file", "find", "replace", "note"? }` (paths relative to the current directory).
 * For each edit, on its own: refuse it unless `find` occurs exactly once in `file`; write the edit; run the test
 * command; restore the file (also on an error, SIGINT or SIGTERM; a SIGKILL leaves the edit in place); print
 *
 *   KILLED|SURVIVED|ERROR|TIMEOUT|REFUSED <id> <file>: <find> → <replace>
 *
 * followed, for a KILLED edit run by Vitest, by the names of the tests that failed (from Vitest's JSON reporter,
 * which the runner adds to any command that names `vitest`). A Vitest command that fails with no failing test (a
 * compile error, a crash, a failed import) is ERROR, not KILLED. A non-Vitest command that exits non-zero is KILLED
 * with no names. The command first runs once unedited; if that fails, nothing is mutated.
 *
 * Exit codes: 0 every edit was killed (or timed out); 1 an edit survived; 2 an edit was refused or errored, or the
 * unedited run failed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Edit {
  id?: string;
  file: string;
  find: string;
  replace: string;
  note?: string;
}

export type Status = "KILLED" | "SURVIVED" | "ERROR" | "TIMEOUT" | "REFUSED";

export interface EditResult {
  id: string;
  file: string;
  find: string;
  replace: string;
  status: Status;
  failedTests: string[];
  detail?: string;
  seconds: number;
}

interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  output: string;
  failedTests: string[] | undefined;
}

export function occurrences(text: string, find: string): number {
  if (find === "") return 0;
  return text.split(find).length - 1;
}

const isVitest = (cmd: string[]): boolean => cmd.some((arg) => /(^|\/)vitest(\.m?js)?$/.test(arg));

/** Names of failed tests in a Vitest JSON report: `<test file> > <full name>`, the file relative to `cwd`. */
export function failedTestNames(report: unknown, cwd: string): string[] {
  const files = (
    report as { testResults?: { name: string; assertionResults?: { status: string; fullName: string }[] }[] }
  ).testResults;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((test) => test.status === "failed")
      .map(
        (test) =>
          `${file.name.startsWith(cwd + "/") ? file.name.slice(cwd.length + 1) : file.name} > ${test.fullName}`,
      ),
  );
}

let current: number | undefined;

function run(cmd: string[], timeoutSeconds: number): Promise<RunOutcome> {
  const vitest = isVitest(cmd);
  const scratch = mkdtempSync(join(tmpdir(), "mutate-"));
  const reportFile = join(scratch, "report.json");
  const args = vitest
    ? [...cmd.slice(1), "--reporter=dot", "--reporter=json", `--outputFile.json=${reportFile}`]
    : cmd.slice(1);
  return new Promise((resolve) => {
    const child = spawn(cmd[0] as string, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    current = child.pid;
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, timeoutSeconds * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      current = undefined;
      let failedTests: string[] | undefined;
      if (vitest && existsSync(reportFile)) {
        failedTests = failedTestNames(JSON.parse(readFileSync(reportFile, "utf8")), process.cwd());
      }
      rmSync(scratch, { recursive: true, force: true });
      resolve({ code, timedOut, output, failedTests: vitest ? (failedTests ?? []) : undefined });
    });
  });
}

/** The status of one edited run: Vitest failures name a test; any other non-zero exit is KILLED only off Vitest. */
export function classify(outcome: Pick<RunOutcome, "code" | "timedOut" | "failedTests">): Status {
  if (outcome.timedOut) return "TIMEOUT";
  if (outcome.code === 0) return "SURVIVED";
  if (outcome.failedTests === undefined) return "KILLED";
  return outcome.failedTests.length > 0 ? "KILLED" : "ERROR";
}

function parseArgs(argv: string[]) {
  const dash = argv.indexOf("--");
  if (dash < 0 || dash === argv.length - 1)
    throw new Error("usage: mutate.ts <edits.json> [options] -- <test command...>");
  const own = argv.slice(0, dash);
  const cmd = argv.slice(dash + 1);
  const opts = {
    editsFile: "",
    timeout: 300,
    json: undefined as string | undefined,
    only: undefined as string[] | undefined,
  };
  for (let i = 0; i < own.length; i++) {
    const arg = own[i] as string;
    if (arg === "--timeout") opts.timeout = Number(own[++i]);
    else if (arg === "--json") opts.json = own[++i];
    else if (arg === "--only") opts.only = (own[++i] ?? "").split(",");
    else opts.editsFile = arg;
  }
  if (!opts.editsFile) throw new Error("no edits file given");
  return { ...opts, cmd };
}

async function main(argv: string[]): Promise<number> {
  const { editsFile, timeout, json, only, cmd } = parseArgs(argv);
  const all = (JSON.parse(readFileSync(editsFile, "utf8")) as Edit[]).map((edit, i) => ({
    ...edit,
    id: edit.id ?? String(i + 1),
  }));
  const edits = only ? all.filter((edit) => only.includes(edit.id)) : all;

  const baseline = await run(cmd, timeout);
  if (baseline.code !== 0) {
    process.stderr.write(
      `The unedited run failed (exit ${String(baseline.code)}); nothing was mutated.\n${baseline.output}\n`,
    );
    return 2;
  }

  let restore: (() => void) | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (current !== undefined) process.kill(-current, "SIGKILL");
    restore?.();
    process.stderr.write(`\n${signal}: restored the edited file.\n`);
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results: EditResult[] = [];
  for (const edit of edits) {
    const started = Date.now();
    const original = readFileSync(edit.file, "utf8");
    const count = occurrences(original, edit.find);
    let result: EditResult;
    if (count !== 1) {
      result = {
        ...edit,
        status: "REFUSED",
        failedTests: [],
        detail: `find occurs ${count} times`,
        seconds: 0,
      };
    } else {
      restore = () => writeFileSync(edit.file, original);
      try {
        writeFileSync(
          edit.file,
          original.replace(edit.find, () => edit.replace),
        );
        const outcome = await run(cmd, timeout);
        const status = classify(outcome);
        result = {
          ...edit,
          status,
          failedTests: outcome.failedTests ?? [],
          detail: status === "ERROR" ? outcome.output.slice(-2000) : undefined,
          seconds: (Date.now() - started) / 1000,
        };
      } finally {
        restore();
        restore = undefined;
      }
    }
    results.push(result);
    const show = (s: string) => s.replace(/\n/g, "⏎");
    process.stdout.write(
      `${result.status} ${result.id} ${edit.file}: ${show(edit.find)} → ${show(edit.replace)}\n`,
    );
    for (const name of result.failedTests) process.stdout.write(`    ✗ ${name}\n`);
    if (result.status === "REFUSED") process.stdout.write(`    (${result.detail ?? ""})\n`);
  }
  if (json) writeFileSync(json, JSON.stringify({ cmd, results }, null, 2) + "\n");

  const count = (status: Status) => results.filter((r) => r.status === status).length;
  process.stdout.write(
    `\n${results.length} edits: ${count("KILLED")} killed, ${count("SURVIVED")} survived, ${count("TIMEOUT")} timed out, ` +
      `${count("ERROR")} errors, ${count("REFUSED")} refused\n`,
  );
  if (count("SURVIVED") > 0) return 1;
  return count("ERROR") + count("REFUSED") > 0 ? 2 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
