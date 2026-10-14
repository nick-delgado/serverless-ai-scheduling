/** `createAwsStores` (`lib/aws.ts`) with no client given, as the session function calls it: it builds its own. */
import { FrozenClock } from "@sched/tools";
import { describe, expect, it } from "vitest";

import { createAwsStores } from "../src/lib/aws";

describe("createAwsStores without a client", () => {
  it("builds the repositories and the turn store on a client of its own, without calling AWS", () => {
    const stores = createAwsStores({
      tableName: "sched-test-table",
      clock: new FrozenClock("2026-10-05T13:00:00Z"),
    });
    expect(typeof stores.repos.patients.get).toBe("function");
    expect(typeof stores.turns.consumeDailyTurn).toBe("function");
  });
});
