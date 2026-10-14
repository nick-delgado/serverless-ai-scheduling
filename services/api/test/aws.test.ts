/**
 * `createAwsStores` (`lib/aws.ts`) with no client given, as the session function calls it: the repositories
 * and the turn store share the one DynamoDB client it builds, as the module header says.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { FrozenClock } from "@sched/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAwsStores } from "../src/lib/aws";

afterEach(() => vi.restoreAllMocks());

describe("createAwsStores without a client", () => {
  it("gives the repositories and the turn store one shared DynamoDB client", () => {
    const from = vi.spyOn(DynamoDBDocumentClient, "from");
    createAwsStores({ tableName: "sched-test-table", clock: new FrozenClock("2026-10-05T13:00:00Z") });

    const clients = from.mock.calls.map(([client]) => client);
    expect(clients).toHaveLength(2);
    expect(clients[0]).toBeInstanceOf(DynamoDBClient);
    expect(clients[1]).toBe(clients[0]);
  });
});
