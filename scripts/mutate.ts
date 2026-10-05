/**
 * Exact-edit mutation runner (#113; the #72 PR #132 review's P1): makes each break of the definition of done's
 * seen-failing pass an exact edit with a recorded result.
 *
 *   npm run mutate -- <edits.json> [--timeout <s>] [--json <out.json>] [--only <id,...>] -- <test command...>
 *
 * `edits.json` is a list of `{ "id"?, "file", "find", "replace" }` (paths relative to the current directory;
 * other fields are kept as notes). Each edit is applied on its own:
 *   - it is REFUSED unless `find` occurs exactly once in `file` (two copies of a statement take two edits,
 *     each with enough context to be unique);
 *   - the edit is written, the test command runs, and the file is restored, also on an error, SIGINT or
 *     SIGTERM (a SIGKILL of this process leaves the edit in place);
 *   - one line is printed: `KILLED|SURVIVED|ERROR|TIMEOUT|REFUSED <id> <file>: <find> → <replace>`, with
 *     newlines shown as ⏎.
 * A command that names `vitest` gets Vitest's JSON reporter added, and a KILLED edit lists the tests that
 * failed (`    ✗ <test file> > <test name>`). A Vitest run that fails with no failing test (a compile error, a
 * crash, a failed import) is ERROR, not KILLED. Any other command that exits non-zero is KILLED, with no names.
 * A command still running after `--timeout` seconds (default 300) is killed and the edit is TIMEOUT.
 * The command first runs once unedited; if that run fails, nothing is mutated.
 *
 * Exit codes: 0 every edit was killed or timed out; 1 an edit survived; 2 an edit was refused or errored, the
 * unedited run failed, or the arguments were wrong.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface Edit {
  id?: string;
  file: string;
  find: string;
  replace: string;
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

export interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  output: string;
  /** Failed tests from Vitest's JSON report; undefined when the command isn't Vitest. */
  failedTests: string[] | undefined;
}

export interface CliArgs {
  editsFile: string;
  timeout: number;
  json?: string;
  only?: string[];
  cmd: string[];
}

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const USAGE =
  "usage: mutate <edits.json> [--timeout <s>] [--json <out.json>] [--only <id,...>] -- <test command...>";

/** How many times `find` occurs in `text` (non-overlapping); an empty `find` occurs nowhere. */
export function occurrences(text: string, find: string): number {
  if (find === "") return 0;
  return text.split(find).length - 1;
}

/** True when the command runs Vitest: an argument whose last path segment is `vitest` (or `vitest.mjs`). */
export const isVitest = (cmd: readonly string[]): boolean =>
  cmd.some((arg) => /(^|\/)vitest(\.mjs)?$/.test(arg));

interface VitestReport {
  testResults?: { name: string; assertionResults?: { status: string; fullName: string }[] }[];
}

/** The failed tests in a Vitest JSON report, as `<test file> > <full name>`, the file relative to `cwd`. */
export function failedTestNames(report: unknown, cwd: string): string[] {
  const files = (report as VitestReport).testResults;
  if (!Array.isArray(files)) return [];
  const prefix = `${cwd}/`;
  return files.flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((test) => test.status === "failed")
      .map(
        (test) =>
          `${file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name} > ${test.fullName}`,
      ),
  );
}

/** The status of one edited run. */
export function classify(outcome: Pick<RunOutcome, "code" | "timedOut" | "failedTests">): Status {
  if (outcome.timedOut) return "TIMEOUT";
  if (outcome.code === 0) return "SURVIVED";
  if (outcome.failedTests === undefined) return "KILLED";
  return outcome.failedTests.length > 0 ? "KILLED" : "ERROR";
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const dash = argv.indexOf("--");
  if (dash < 0 || dash === argv.length - 1) throw new Error(USAGE);
  const args: CliArgs = { editsFile: "", timeout: DEFAULT_TIMEOUT_SECONDS, cmd: argv.slice(dash + 1) };
  const own = argv.slice(0, dash);
  for (let i = 0; i < own.length; i++) {
    const arg = own[i] as string;
    const value = own[i + 1];
    if (arg === "--timeout" || arg === "--json" || arg === "--only") {
      if (value === undefined) throw new Error(`${arg} needs a value. ${USAGE}`);
      i++;
      if (arg === "--timeout") args.timeout = Number(value);
      else if (arg === "--json") args.json = value;
      else args.only = value.split(",");
    } else if (args.editsFile === "") args.editsFile = arg;
    else throw new Error(`unexpected argument ${arg}. ${USAGE}`);
  }
  if (args.editsFile === "") throw new Error(`no edits file. ${USAGE}`);
  if (!(args.timeout > 0)) throw new Error(`--timeout must be a positive number of seconds. ${USAGE}`);
  return args;
}

/** The command running now: its process group, and the directory its report goes to. */
let running: { pid: number; reportDir: string } | undefined;

/**
 * Kills the running command's whole process group and removes its report directory, for a signal that ends this
 * process mid-run. Between runs it does nothing, since a finished command's process group may be reused.
 */
export function stopRunning(): void {
  if (running === undefined) return;
  process.kill(-running.pid, "SIGKILL");
  rmSync(running.reportDir, { recursive: true, force: true });
}

/** Runs the command in its own process group, adding Vitest's JSON reporter when it is Vitest. */
export function runCommand(cmd: readonly string[], timeoutSeconds: number, cwd: string): Promise<RunOutcome> {
  const vitest = isVitest(cmd);
  const scratch = mkdtempSync(join(tmpdir(), "mutate-"));
  const reportFile = join(scratch, "report.json");
  const args = vitest
    ? [...cmd.slice(1), "--reporter=dot", "--reporter=json", `--outputFile.json=${reportFile}`]
    : cmd.slice(1);
  return new Promise((done) => {
    const child = spawn(cmd[0] as string, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    running = { pid: child.pid as number, reportDir: scratch };
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(-(child.pid as number), "SIGKILL");
    }, timeoutSeconds * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      running = undefined;
      const failedTests = !vitest
        ? undefined
        : existsSync(reportFile)
          ? failedTestNames(JSON.parse(readFileSync(reportFile, "utf8")), cwd)
          : [];
      rmSync(scratch, { recursive: true, force: true });
      done({ code, timedOut, output, failedTests });
    });
  });
}

const shown = (text: string) => text.replaceAll("\n", "⏎");

/** The printed lines for one result. */
export function formatResult(result: EditResult): string[] {
  const lines = [
    `${result.status} ${result.id} ${result.file}: ${shown(result.find)} → ${shown(result.replace)}`,
  ];
  for (const name of result.failedTests) lines.push(`    ✗ ${name}`);
  if (result.status === "REFUSED") lines.push(`    (${result.detail ?? ""})`);
  return lines;
}

export interface MutateDeps {
  /** Directory the edits' paths and the command are relative to; defaults to the process's. */
  cwd?: string;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/** The script's entry point; returns the exit code (see the header). */
export async function main(argv: readonly string[], deps: MutateDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    logError((err as Error).message);
    return 2;
  }
  const all = (JSON.parse(readFileSync(resolve(cwd, args.editsFile), "utf8")) as Edit[]).map((edit, i) => ({
    ...edit,
    id: edit.id ?? String(i + 1),
  }));
  const edits = args.only ? all.filter((edit) => args.only?.includes(edit.id)) : all;

  const baseline = await runCommand(args.cmd, args.timeout, cwd);
  if (baseline.code !== 0) {
    logError(
      `mutate: the unedited run failed (exit ${String(baseline.code)}); nothing was mutated.\n${baseline.output}`,
    );
    return 2;
  }

  let restore: (() => void) | undefined;
  /* v8 ignore start -- runs only on a signal to the CLI; the spawned-CLI test checks it, and records no coverage */
  const onSignal = (signal: NodeJS.Signals) => {
    stopRunning();
    restore?.();
    logError(`\nmutate: ${signal}: the edited file is restored.`);
    process.exit(130);
  };
  /* v8 ignore stop */
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results: EditResult[] = [];
  try {
    for (const edit of edits) {
      const path = resolve(cwd, edit.file);
      const original = readFileSync(path, "utf8");
      const count = occurrences(original, edit.find);
      const base = { id: edit.id, file: edit.file, find: edit.find, replace: edit.replace };
      let result: EditResult;
      if (count !== 1) {
        result = {
          ...base,
          status: "REFUSED",
          failedTests: [],
          detail: `find occurs ${count} times`,
          seconds: 0,
        };
      } else {
        const started = Date.now();
        restore = () => writeFileSync(path, original);
        try {
          // A replacer function, so `$&` or `$1` in `replace` is written as it stands.
          writeFileSync(
            path,
            original.replace(edit.find, () => edit.replace),
          );
          const outcome = await runCommand(args.cmd, args.timeout, cwd);
          const status = classify(outcome);
          result = {
            ...base,
            status,
            failedTests: outcome.failedTests ?? [],
            ...(status === "ERROR" ? { detail: outcome.output.slice(-2000) } : {}),
            seconds: (Date.now() - started) / 1000,
          };
        } finally {
          restore();
          restore = undefined;
        }
      }
      results.push(result);
      for (const line of formatResult(result)) log(line);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (args.json)
    writeFileSync(resolve(cwd, args.json), JSON.stringify({ cmd: args.cmd, results }, null, 2) + "\n");

  const count = (status: Status) => results.filter((r) => r.status === status).length;
  log(
    `\n${results.length} edits: ${count("KILLED")} killed, ${count("SURVIVED")} survived, ` +
      `${count("TIMEOUT")} timed out, ${count("ERROR")} errors, ${count("REFUSED")} refused`,
  );
  if (count("SURVIVED") > 0) return 1;
  return count("ERROR") + count("REFUSED") > 0 ? 2 : 0;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
