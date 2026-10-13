/**
 * Read-only views of the `e2e` table for the journeys' end state (r1/A-2) and the run's cost (r1/A-8). Nothing here
 * writes: the reseed is the seed scripts', and every other write is the app's.
 */
import { paginateQuery } from "@aws-sdk/lib-dynamodb";
import { type Appointment, type Escalation, TurnTrace } from "@sched/contracts";
import { SystemClock } from "@sched/tools";
import { createDocumentClient, createDynamoRepositories, keys } from "@sched/tools/dynamo";

import { awsDefaults, ssmParam } from "./env";

export interface E2eTable {
  appointments(sub: string): Promise<Appointment[]>;
  escalation(sub: string, conversationId: string): Promise<Escalation | null>;
  /** The turn traces (`CONV#<id>` / `TRACE#<turnId>`) of each conversation. */
  traces(conversationIds: readonly string[]): Promise<TurnTrace[]>;
}

export async function openTable(env: string): Promise<E2eTable> {
  awsDefaults();
  const tableName = await ssmParam(`/sched/${env}/data/table-name`);
  const repos = createDynamoRepositories({ tableName, clock: new SystemClock() });
  const doc = createDocumentClient();
  return {
    appointments: (sub) => repos.appointments.listForPatient(sub),
    escalation: (sub, conversationId) => repos.escalations.getForConversation(sub, conversationId),
    async traces(conversationIds) {
      const traces: TurnTrace[] = [];
      for (const id of conversationIds) {
        const pages = paginateQuery(
          { client: doc },
          {
            TableName: tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :trace)",
            ExpressionAttributeValues: { ":pk": keys.escalation(id).PK, ":trace": "TRACE#" },
          },
        );
        for await (const page of pages) {
          for (const item of page.Items ?? []) traces.push(TurnTrace.parse(JSON.parse(String(item.trace))));
        }
      }
      return traces;
    },
  };
}
