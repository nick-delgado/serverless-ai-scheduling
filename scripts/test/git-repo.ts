/**
 * Helpers for the scripts' tests. A throwaway git repository (coverage-changed, pr-evidence, dup-changed; #184 shared it when
 * the duplicate check flagged the third copy): `main` checked out, no commits, a test identity and no signing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { vi } from "vitest";

export interface TestRepo {
  /** The repository's real path (macOS's tmpdir is a symlink). */
  dir: string;
  git: (...args: string[]) => string;
  /** Writes a file, making its directories. */
  write: (path: string, text: string) => void;
  /** Stages everything and commits it. */
  commit: (message: string) => void;
  remove: () => void;
}

export function gitRepo(prefix: string): TestRepo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  return {
    dir,
    git,
    write: (path, text) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    },
    commit: (message) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type Spy = ReturnType<typeof vi.spyOn>;

/** Runs `check` with console.log and console.error spied on and silenced, and restores both after. */
export async function withConsole(check: (log: Spy, error: Spy) => void | Promise<void>): Promise<void> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await check(log, error);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

/** A script's `log` and `logError` deps, pushing each line onto `out` and `errors`. */
export const logsTo = (out: string[], errors: string[]) => ({
  log: (line: string) => out.push(line),
  logError: (line: string) => errors.push(line),
});
