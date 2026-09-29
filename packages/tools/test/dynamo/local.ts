/**
 * DynamoDB Local for the tests: finds the endpoint, and creates fresh tables with the same key schema and
 * GSI as `infra/stacks/data.yaml` (`createTableInput`).
 *
 * Endpoint: `DYNAMODB_ENDPOINT`, default `http://localhost:8000`. Start one with
 *   npm run dynamodb:local -w packages/tools      (docker run amazon/dynamodb-local)
 * Without an endpoint the DynamoDB tests are skipped locally, but **fail in CI** (`CI` is set there), so
 * the contract suite on DynamoDB is a required check.
 */
import { randomUUID } from "node:crypto";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

import { createTableInput } from "../../src/repos/dynamo/table";

export const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

export function localClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: ENDPOINT,
    region: "us-east-1",
    // DynamoDB Local accepts any credentials; fixed ones keep every test in the same local namespace.
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 3,
  });
}

/** Is DynamoDB Local reachable? Throws in CI when it isn't, so a missing service can't pass silently. */
export async function dynamoLocalAvailable(): Promise<boolean> {
  const client = localClient();
  try {
    await client.send(new ListTablesCommand({ Limit: 1 }), { abortSignal: AbortSignal.timeout(2000) });
    return true;
  } catch (err) {
    if (process.env.CI) {
      throw new Error(`DynamoDB Local is required in CI but ${ENDPOINT} is unreachable`, { cause: err });
    }
    // stderr, not console: Vitest drops console output from files whose tests are all skipped.
    process.stderr.write(
      `\n[dynamo] SKIPPING the DynamoDB repository tests: no DynamoDB Local at ${ENDPOINT}.\n` +
        `[dynamo] Start one with \`npm run dynamodb:local -w packages/tools\` (or set DYNAMODB_ENDPOINT).\n`,
    );
    return false;
  } finally {
    client.destroy();
  }
}

/** Creates uniquely named tables and deletes them all in `dropAll()`. */
export function tableFactory(client: DynamoDBClient) {
  const created: string[] = [];
  return {
    async create(): Promise<string> {
      const name = `sched-test-${randomUUID().slice(0, 8)}`;
      await client.send(new CreateTableCommand(createTableInput(name)));
      await waitUntilTableExists(
        { client, maxWaitTime: 30, minDelay: 0.1, maxDelay: 1 },
        { TableName: name },
      );
      created.push(name);
      return name;
    },
    async dropAll(): Promise<void> {
      await Promise.all(
        created.splice(0).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
      );
    },
  };
}
