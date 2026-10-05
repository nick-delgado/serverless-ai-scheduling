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
 * An edit whose file can't be read is REFUSED; a command that can't be started is ERROR (or, unedited, a failed run).
 *
 * Exit codes: 0 every edit was killed or timed out; 1 an edit survived; 2 an edit was refused or errored, the
 * unedited run failed, or the arguments were wrong (including an edits file that can't be read or isn't a list of
 * edits, and an `--only` id no edit has).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface Edit {
  id?: string;
  file: string;
  find: string;
  replace: string;
}

export type Status = "KILLED" | "SURVIVED" | "ERROR" | "TIMEOUT" | "REFUSED";

interface EditResultBase {
  id: string;
  file: string;
  find: string;
  replace: string;
  failedTests: string[];
  seconds: number;
}

/** One edit's result: a refused edit always says why; an errored one carries the command's output. */
export type EditResult = EditResultBase &
  ({ status: "REFUSED"; detail: string } | { status: Exclude<Status, "REFUSED">; detail?: string });

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
  json?: string | undefined;
  only?: string[] | undefined;
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
export function classify(
  outcome: Pick<RunOutcome, "code" | "timedOut" | "failedTests">,
): Exclude<Status, "REFUSED"> {
  if (outcome.timedOut) return "TIMEOUT";
  if (outcome.code === 0) return "SURVIVED";
  if (outcome.failedTests === undefined) return "KILLED";
  return outcome.failedTests.length > 0 ? "KILLED" : "ERROR";
}

/** The arguments before the first `--` are the runner's own; everything after it is the test command. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const dash = argv.indexOf("--");
  if (dash < 0 || dash === argv.length - 1) throw new Error(USAGE);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(0, dash),
      allowPositionals: true,
      strict: true,
      options: { timeout: { type: "string" }, json: { type: "string" }, only: { type: "string" } },
    });
  } catch (err) {
    throw new Error(`${(err as Error).message}. ${USAGE}`, { cause: err });
  }
  const { values, positionals } = parsed;
  const [editsFile, ...rest] = positionals;
  if (editsFile === undefined) throw new Error(`no edits file. ${USAGE}`);
  if (rest.length > 0) throw new Error(`unexpected argument ${rest.join(" ")}. ${USAGE}`);
  const timeout = Number(values.timeout ?? DEFAULT_TIMEOUT_SECONDS);
  if (!(timeout > 0)) throw new Error(`--timeout must be a positive number of seconds. ${USAGE}`);
  return {
    editsFile,
    timeout,
    json: values.json,
    only: values.only?.split(","),
    cmd: argv.slice(dash + 1),
  };
}

/** True for a `{ id?, file, find, replace }` entry with string fields (other fields are notes). */
function isEdit(entry: unknown): entry is Edit {
  const { id, file, find, replace } = (entry ?? {}) as Record<string, unknown>;
  return (
    (id === undefined || typeof id === "string") &&
    typeof file === "string" &&
    typeof find === "string" &&
    typeof replace === "string"
  );
}

/** The edits in `path`, each with an id (its 1-based position when it has none); throws why it can't. */
export function readEdits(path: string): (Edit & { id: string })[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`can't read the edits file ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (!Array.isArray(parsed)) throw new Error(`the edits file ${path} isn't a list of edits`);
  return parsed.map((entry: unknown, i) => {
    if (!isEdit(entry))
      throw new Error(
        `edit ${i + 1} in ${path} isn't { "id"?, "file", "find", "replace" } with string values`,
      );
    return { ...entry, id: entry.id ?? String(i + 1) };
  });
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

/**
 * Runs the command in its own process group, adding Vitest's JSON reporter when it is Vitest. A command that can't be
 * started ends with no exit code and no failed tests (ERROR, by `classify`), its error in the output.
 */
export function runCommand(cmd: readonly string[], timeoutSeconds: number, cwd: string): Promise<RunOutcome> {
  const vitest = isVitest(cmd);
  const scratch = mkdtempSync(join(tmpdir(), "mutate-"));
  const reportFile = join(scratch, "report.json");
  const args = vitest
    ? [...cmd.slice(1), "--reporter=dot", "--reporter=json", `--outputFile.json=${reportFile}`]
    : cmd.slice(1);
  return new Promise((done) => {
    const child = spawn(cmd[0] as string, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    // A command that can't be started has no pid, and no process group to kill.
    if (child.pid !== undefined) running = { pid: child.pid, reportDir: scratch };
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopRunning();
    }, timeoutSeconds * 1000);
    // The first of these settles the promise, and only the first: a spawn error is followed by a "close" that would
    // read as an exit, and comes after the next command has started, whose handle it must not clear.
    let settled = false;
    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running = undefined;
      rmSync(scratch, { recursive: true, force: true });
      done(outcome);
    };
    child.on("error", (err) => {
      finish({ code: null, timedOut, output: `${output}${err.message}`, failedTests: [] });
    });
    child.on("close", (code) => {
      const failedTests = !vitest
        ? undefined
        : existsSync(reportFile)
          ? failedTestNames(JSON.parse(readFileSync(reportFile, "utf8")), cwd)
          : [];
      finish({ code, timedOut, output, failedTests });
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
  if (result.status === "REFUSED") lines.push(`    (${result.detail})`);
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
  let all: (Edit & { id: string })[];
  try {
    all = readEdits(resolve(cwd, args.editsFile));
  } catch (err) {
    logError(`mutate: ${(err as Error).message}`);
    return 2;
  }
  const only = args.only;
  const unmatched = (only ?? []).filter((id) => !all.some((edit) => edit.id === id));
  if (unmatched.length > 0) {
    logError(`mutate: --only names no edit with the id ${unmatched.join(", ")}`);
    return 2;
  }
  const edits = only ? all.filter((edit) => only.includes(edit.id)) : all;

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
  /* v8 ignore stop -- end of the signal handler */
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results: EditResult[] = [];
  try {
    for (const edit of edits) {
      const path = resolve(cwd, edit.file);
      const base = { id: edit.id, file: edit.file, find: edit.find, replace: edit.replace };
      const refused = (detail: string): EditResult => ({
        ...base,
        status: "REFUSED",
        failedTests: [],
        detail,
        seconds: 0,
      });
      let original = "";
      let unreadable: string | undefined;
      try {
        original = readFileSync(path, "utf8");
      } catch (err) {
        unreadable = (err as Error).message;
      }
      const count = occurrences(original, edit.find);
      let result: EditResult;
      if (unreadable !== undefined) {
        result = refused(`can't read the file: ${unreadable}`);
      } else if (count !== 1) {
        result = refused(`find occurs ${count} times`);
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
