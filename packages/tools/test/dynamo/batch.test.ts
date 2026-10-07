/**
 * `batchWrite`, the one `UnprocessedItems` retry loop (#125), against a fake client: DynamoDB Local never
 * returns unprocessed items, so `dynamo.test.ts` can't reach the retry path. Runs without DynamoDB Local.
 * Moved from `scripts/seed-data.test.ts`'s `deleteRows` cases, with the same waits.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { BatchWriteCommandInput, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BATCH_WRITE_MAX_CALLS,
  batchWrite,
  type BatchWriteRequest,
  writeSeed,
} from "../../src/repos/dynamo/repositories";
import { contractSeed } from "../contract/scenario";

// A copy of `scripts/seed-data.test.ts`' fakeClient, by #125's A-7: that file keeps it for its SSM tests,
// and a test helper isn't worth a package export.
// jscpd:ignore-start
/** A client whose `send` records each command's input and answers with `reply(input, call)`. */
function fakeClient(reply: (input: BatchWriteCommandInput, call: number) => unknown) {
  const sent: BatchWriteCommandInput[] = [];
  const client = {
    send(command: { input: BatchWriteCommandInput }) {
      sent.push(command.input);
      return Promise.resolve(reply(command.input, sent.length));
    },
  };
  return { sent, client: client as unknown as Pick<DynamoDBDocumentClient, "send"> };
}
// jscpd:ignore-end

const requestsOf = (input: BatchWriteCommandInput) => input.RequestItems?.t1 ?? [];
const giveUp = (n: number) => new Error(`${String(n)} still unprocessed`);

describe("batchWrite", () => {
  const deletes: BatchWriteRequest[] = Array.from({ length: 30 }, (_, i) => ({
    DeleteRequest: { Key: { PK: `PROVIDER#p${String(i)}`, SK: "PROFILE" } },
  }));

  it("sends batches of 25 and re-sends only the unprocessed requests after a wait", async () => {
    const { sent, client } = fakeClient((input, call) =>
      call === 1 ? { UnprocessedItems: { t1: requestsOf(input).slice(3, 5) } } : {},
    );
    const waits: number[] = [];
    await batchWrite(client, "t1", deletes, giveUp, async (ms) => void waits.push(ms));
    expect(sent.map(requestsOf)).toEqual([deletes.slice(0, 25), deletes.slice(3, 5), deletes.slice(25)]);
    expect(waits).toEqual([100]);
  });

  it("re-sends unprocessed puts and deletes alike, and nothing for another table or of another kind", async () => {
    const put: BatchWriteRequest = { PutRequest: { Item: { PK: "x", SK: "y", n: 1 } } };
    const del: BatchWriteRequest = { DeleteRequest: { Key: { PK: "a", SK: "b" } } };
    const { sent, client } = fakeClient((input, call) =>
      call === 1 ? { UnprocessedItems: { t1: [...requestsOf(input), {}], t2: [put] } } : {},
    );
    await batchWrite(client, "t1", [put, del], giveUp, async () => undefined);
    expect(sent.map(requestsOf)).toEqual([
      [put, del],
      [put, del],
    ]);
  });

  it(`gives up on a batch after ${String(BATCH_WRITE_MAX_CALLS)} calls that leave requests unprocessed`, async () => {
    const { sent, client } = fakeClient((input) => ({ UnprocessedItems: { t1: requestsOf(input) } }));
    const waits: number[] = [];
    await expect(
      batchWrite(client, "t1", deletes.slice(0, 2), giveUp, async (ms) => void waits.push(ms)),
    ).rejects.toThrow("2 still unprocessed");
    expect(BATCH_WRITE_MAX_CALLS).toBe(8);
    expect(sent).toHaveLength(8);
    expect(waits).toEqual([100, 200, 400, 800, 1600, 3200, 6400, 12800]);
  });

  it("waits with a real timer when no wait is given", async () => {
    vi.useFakeTimers();
    const { sent, client } = fakeClient((input, call) =>
      call === 1 ? { UnprocessedItems: { t1: requestsOf(input) } } : {},
    );
    const done = batchWrite(client, "t1", deletes.slice(0, 1), giveUp);
    await vi.advanceTimersByTimeAsync(99);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(sent).toHaveLength(2);
  });
});

describe("writeSeed", () => {
  it("names the items still unprocessed when it gives up", async () => {
    vi.useFakeTimers();
    // A client that never reaches DynamoDB: every BatchWriteItem call answers with all of its puts unprocessed.
    const client = new DynamoDBClient({
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    client.middlewareStack.add(
      () => (args) => {
        const input = (args as { input: { RequestItems: Record<string, unknown[]> } }).input;
        return Promise.resolve({
          output: { $metadata: {}, UnprocessedItems: input.RequestItems },
          response: {},
        });
      },
      { step: "build", priority: "high" },
    );
    const done = writeSeed({ tableName: "t1", client, seed: contractSeed() });
    const outcome = expect(done).rejects.toThrow(/^writeSeed: \d+ items still unprocessed$/);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    client.destroy();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
