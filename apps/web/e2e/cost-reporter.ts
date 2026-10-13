/**
 * The run's last lines (#40, r1/A-8): its estimated Bedrock cost, from the turn traces of the conversations the specs
 * listed in the run directory (`global-setup.ts`), then the directory is removed. A reporter rather than a global
 * teardown, so it prints after the list reporter's summary and the job log ends with it, on a failed run too.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Reporter } from "@playwright/test/reporter";

import { formatRunCost, sumTraceCost } from "./lib/cost";
import { e2eEnv } from "./support/env";
import { openTable } from "./support/table";

export default class CostReporter implements Reporter {
  async onEnd(): Promise<void> {
    const dir = process.env.E2E_RUN_DIR;
    if (!dir) return;
    try {
      const file = join(dir, "conversations.txt");
      const ids = existsSync(file)
        ? [...new Set(readFileSync(file, "utf8").split("\n").filter(Boolean))]
        : [];
      const traces = ids.length > 0 ? await (await openTable(e2eEnv())).traces(ids) : [];
      console.log(`${String(ids.length)} conversation(s) started by this run`);
      console.log(formatRunCost(sumTraceCost(traces)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
