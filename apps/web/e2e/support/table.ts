/**
 * Read-only views of the `e2e` table for the journeys' end state (r1/A-2) and the run's cost (r1/A-8). Nothing here
 * writes: the reseed is the seed scripts', and every other write is the app's.
 */
import type { Appointment, Escalation, TurnTrace } from "@sched/contracts";
import { SystemClock } from "@sched/tools";
import { createDocumentClient, createDynamoRepositories } from "@sched/tools/dynamo";

import { readTraces } from "../../../../scripts/trace";
import { awsDefaults, ssmParam } from "./env";

export interface E2eTable {
  appointments(sub: string): Promise<Appointment[]>;
  escalation(sub: string, conversationId: string): Promise<Escalation | null>;
  /**
   * The turn traces (`CONV#<id>` / `TRACE#<turnId>`) of each conversation, read with `scripts/trace.ts`'s
   * `readTraces`. Throws on an item whose `trace` isn't a `TurnTrace`, so the cost line never undercounts.
   */
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
        for (const entry of await readTraces(doc, tableName, id)) {
          if (!entry.trace) throw new Error(`Unreadable trace ${entry.turnId} in conversation ${id}`);
          traces.push(entry.trace);
        }
      }
      return traces;
    },
  };
}
