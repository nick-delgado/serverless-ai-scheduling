/**
 * AWS-backed stores for the API Lambdas: the DynamoDB repositories (#13) and the turn store, sharing
 * one DynamoDB client. Create them once per execution environment (module scope), not per request.
 *
 * Kept out of `index.ts`, so in-process users of the handler core (the eval harness) never load the
 * AWS SDK.
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

export function createAwsStores(options: {
  tableName: string;
  clock: Clock;
  client?: DynamoDBClient;
}): AwsStores {
  const client = options.client ?? new DynamoDBClient({});
  return {
    repos: createDynamoRepositories({ tableName: options.tableName, client, clock: options.clock }),
    turns: createDynamoTurnStore({ tableName: options.tableName, doc: createDocumentClient(client) }),
  };
}
