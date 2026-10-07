/**
 * The second home of a run's results (#195): every live run that finishes writes its `.json` and `.md`
 * to the primary directory (`--out`, default `packages/evals/results/`) and also to a copy directory
 * outside every checkout, so removing the worktree that ran it leaves the results in place.
 *
 * - The copy directory is `EVAL_RESULTS_COPY_DIR` when set (an absolute path), else
 *   `$XDG_STATE_HOME/serverless-ai-scheduling/eval-results/` when `XDG_STATE_HOME` is absolute (a relative
 *   value is ignored, as the XDG Base Directory spec says), else
 *   `$HOME/.local/state/serverless-ai-scheduling/eval-results/` (r1/Q-1, r1/Q-5). There is no flag and no
 *   off switch.
 * - Files go in one subdirectory per checkout, named after the checkout's directory (r1/Q-2).
 * - A copy directory (the per-checkout subdirectory the files go to) inside the checkout running the CLI,
 *   or inside the checkout holding it when it is a worktree under `.worktrees/`, is a usage error (r1/Q-4), checked before any model call, `--dry-run`
 *   included. A live run creates the directory before its first model call, and a failure there is a
 *   usage error (r1/Q-3); a `--dry-run` creates nothing (r1/A-1).
 * - After the run the primary pair is written first, then the copy; a failed copy write is a warning
 *   and leaves the exit code alone (r1/Q-3). When both locations are the same path the pair is written
 *   once (r1/A-2).
 *
 * The functions take the environment, the home directory, the checkout root and the file system as
 * parameters; `cli.ts` passes in the process's.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CliArgError, resultsBasePath } from "./cli-args";
import type { RunReport } from "./suite";
import { errorReason } from "./util";

/** The environment variable that replaces the default copy directory (r1/Q-5). */
export const RESULTS_COPY_DIR_ENV = "EVAL_RESULTS_COPY_DIR";

/** The copy directory below the state directory. */
export const RESULTS_COPY_SUBDIR = join("serverless-ai-scheduling", "eval-results");

/** Where the copies go, before the per-checkout subdirectory: the override, else the XDG state directory. */
export function resultsCopyBaseDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const override = env[RESULTS_COPY_DIR_ENV];
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override))
      throw new CliArgError(`${RESULTS_COPY_DIR_ENV} must be an absolute path, got ${override}`);
    return resolve(override);
  }
  const xdg = env.XDG_STATE_HOME;
  const state = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return resolve(state, RESULTS_COPY_SUBDIR);
}

/**
 * The repository roots a copy directory must stay out of: the checkout itself, and, for a worktree at
 * `<repo>/.worktrees/<name>`, the checkout that holds it.
 */
export function checkoutRoots(checkout: string): string[] {
  const root = resolve(checkout);
  const parent = dirname(root);
  return basename(parent) === ".worktrees" ? [root, dirname(parent)] : [root];
}

/** True when `dir` is `root` or anywhere below it (by path: `relative` resolves `.` and `..`). */
export function isInsideDir(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * The run's copy directory: `<base>/<checkout directory name>`. A copy directory inside one of the
 * checkout's roots is a usage error naming both. The check is on the directory the files go to, not the
 * base: a base that is the main checkout's parent puts them in the checkout itself.
 */
export function resultsCopyDir(deps: {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  checkout: string;
}): string {
  const dir = join(resultsCopyBaseDir(deps.env, deps.home), basename(deps.checkout));
  const inside = checkoutRoots(deps.checkout).find((root) => isInsideDir(dir, root));
  if (inside !== undefined)
    throw new CliArgError(
      `the results copy directory ${dir} is inside the repository checkout ${inside}; set ${RESULTS_COPY_DIR_ENV} to a directory outside it`,
    );
  return dir;
}

/** The file system calls the results writes need. */
export interface ResultsFiles {
  mkdir: (dir: string) => void;
  writeFile: (path: string, text: string) => void;
}

/** The real file system, for `cli.ts`. */
export const nodeResultsFiles: ResultsFiles = {
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  writeFile: (path, text) => writeFileSync(path, text),
};

/** Create the copy directory before a live run's first model call; a failure is a usage error (r1/Q-3). */
export function prepareResultsCopyDir(
  dir: string,
  files: Pick<ResultsFiles, "mkdir"> = nodeResultsFiles,
): void {
  try {
    files.mkdir(dir);
  } catch (error) {
    throw new CliArgError(`can't create the results copy directory ${dir}: ${errorReason(error)}`);
  }
}

/** Where a run's results went: base paths without the extension. */
export interface WrittenResults {
  primary: string;
  /** The copy's base path; absent when it is the primary's. */
  copy?: string;
  /** Why the copy couldn't be written, when it couldn't. */
  copyError?: string;
}

/**
 * Write the run's `.json` and `.md` to `out`, then to `copyDir`. A primary write that fails throws, as
 * before; a copy write that fails is returned as `copyError`.
 */
export function writeRunResults(
  report: Pick<RunReport, "startedAt" | "mode" | "suite" | "profile">,
  md: string,
  dirs: { out: string; copyDir: string },
  files: ResultsFiles = nodeResultsFiles,
): WrittenResults {
  const writePair = (dir: string): string => {
    files.mkdir(dir);
    const base = resultsBasePath(report, dir);
    files.writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    files.writeFile(`${base}.md`, `${md}\n`);
    return base;
  };
  const primary = writePair(dirs.out);
  const copyBase = resultsBasePath(report, dirs.copyDir);
  if (resolve(copyBase) === resolve(primary)) return { primary };
  try {
    writePair(dirs.copyDir);
    return { primary, copy: copyBase };
  } catch (error) {
    return { primary, copy: copyBase, copyError: errorReason(error) };
  }
}

/**
 * What the CLI prints after the writes: the last line names both `.json` paths (r1/A-3), and a failed
 * copy also gets a warning for stderr naming the path and the error.
 */
export function resultsWrittenMessages(written: WrittenResults): { line: string; warning?: string } {
  const { primary, copy, copyError } = written;
  if (copy === undefined) return { line: `evals: wrote ${primary}.json (also the copy location)` };
  if (copyError === undefined) return { line: `evals: wrote ${primary}.json and the copy ${copy}.json` };
  return {
    line: `evals: wrote ${primary}.json; the copy ${copy}.json was not written`,
    warning: `evals: warning: couldn't write the results copy ${copy}.json: ${copyError}`,
  };
}
