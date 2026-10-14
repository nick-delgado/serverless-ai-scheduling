/**
 * `createAwsStores` (`lib/aws.ts`) against DynamoDB Local: the repositories and the turn store use the client
 * they're given (the chat function passes the one X-Ray captures, #38), and the conflict-retry hook reaches
 * `book` (`BookingConflictRetries`, owner decision r1/Q-6 (a)). Skipped locally without DynamoDB Local;
 * required in CI (see `dynamo-local.ts`).
 */
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { FrozenClock } from "@sched/tools";
import { writeSeed } from "@sched/tools/dynamo";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { afterAll, describe, expect, it } from "vitest";

import { createAwsStores } from "../src/lib/aws";
import { dynamoLocalAvailable, localClient, tableFactory } from "./dynamo-local";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const NOW = "2026-10-05T13:00:00Z";

const available = await dynamoLocalAvailable();
const admin = localClient();
const tables = tableFactory(admin);

afterAll(async () => {
  if (available) await tables.dropAll();
  admin.destroy();
});

describe.skipIf(!available)("createAwsStores (DynamoDB Local)", () => {
  it("sends every read and write through the given client, and reports book's conflict retries", async () => {
    const seed = buildClinicFixture();
    const tableName = await tables.create();
    await writeSeed({ tableName, client: admin, seed });

    // The given client records each command, and cancels the first transaction with TransactionConflict.
    const client = localClient();
    const sent: string[] = [];
    let cancelled = false;
    client.middlewareStack.add(
      (next, context) => async (args) => {
        sent.push(context.commandName ?? "");
        if (context.commandName === "TransactWriteItemsCommand" && !cancelled) {
          cancelled = true;
          throw new TransactionCanceledException({
            message: "Transaction cancelled (injected)",
            $metadata: {},
            CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
          });
        }
        return next(args);
      },
      { step: "initialize" },
    );
    let retries = 0;
    const stores = createAwsStores({
      tableName,
      clock: new FrozenClock(NOW),
      client,
      onConflictRetry: () => retries++,
    });

    expect((await stores.repos.patients.get(MARIA))?.firstName).toBe("Maria");
    expect(await stores.turns.consumeDailyTurn(MARIA, "2026-10-05", 50)).toMatchObject({ ok: true });
    const open = seed.slots.find((s) => s.status === "OPEN" && s.startUtc > NOW);
    const booked = await stores.repos.appointments.book({
      patientId: MARIA,
      slotId: open?.slotId ?? "",
      reason: "Checkup",
    });

    expect(booked.ok).toBe(true);
    expect(retries).toBe(1);
    expect(sent).toEqual(
      expect.arrayContaining(["GetItemCommand", "UpdateItemCommand", "TransactWriteItemsCommand"]),
    );
    client.destroy();
  }, 30_000);
});
