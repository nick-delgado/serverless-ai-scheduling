/**
 * AWS-backed stores for the API Lambdas: the DynamoDB repositories (#13) and the turn store, sharing
 * one DynamoDB client. Create them once per execution environment (module scope), not per request.
 *
 * Kept out of `index.ts`, so in-process users of the handler core (the eval harness) never load the
 * DynamoDB SDK.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { Clock } from "@sched/agent";
import type { Repositories } from "@sched/tools";
import { createDocumentClient, createDynamoRepositories } from "@sched/tools/dynamo";

import { createDynamoTurnStore } from "./dynamo-turn-store";
import type { TurnStore } from "./turn-store";

export interface AwsStores {
  repos: Repositories;
  turns: TurnStore;
}

export interface AwsStoreOptions {
  tableName: string;
  clock: Clock;
  /** The DynamoDB client, e.g. one the X-Ray tracer captures (the chat function, #38). Default a new one. */
  client?: DynamoDBClient;
  /** Counts `book` and `reschedule` conflict retries (`BookingConflictRetries`, #38). Default none. */
  onConflictRetry?: () => void;
}

export function createAwsStores(options: AwsStoreOptions): AwsStores {
  const client = options.client ?? new DynamoDBClient({});
  return {
    repos: createDynamoRepositories({
      tableName: options.tableName,
      client,
      clock: options.clock,
      onConflictRetry: options.onConflictRetry,
    }),
    turns: createDynamoTurnStore({ tableName: options.tableName, doc: createDocumentClient(client) }),
  };
}
