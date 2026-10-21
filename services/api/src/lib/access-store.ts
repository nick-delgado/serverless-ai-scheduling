/**
 * The request-access registry and its two caps (#357, owner decision r1/Q-3 (a); ADR-004's 2026-10-20 amendment).
 * Two implementations: DynamoDB (below) and in-memory (`createInMemoryAccessStore`, for handler tests).
 *
 * | Item | PK | SK | Attributes |
 * |---|---|---|---|
 * | Registry entry, one per issued account | `ACCESS#ISSUED` | `<accessExpiresAt>#<requestId>` | `username`, `requestId`, `accessExpiresAt` (ISO, UTC), `sub` once the user exists |
 * | Active-account counter | `ACCESS#COUNT` | `ACTIVE` | `active` (no TTL: only the expiry job decrements it, in the transaction that removes the entry) |
 * | Daily counter (clinic-local day) | `ACCESS#COUNT` | `DAY#<yyyy-mm-dd>` | `issued`, `expiresAt` = two days after the day ends (UTC) |
 *
 * `ACCESS#` is no prefix of `PATIENT#`, `PROVIDER#`, `CONV#` or `ENV`, and the counters live under it, not under `ENV`
 * (r2/A-18). The registry has no `expiresAt` TTL attribute: it must outlive the account until the job removes it.
 *
 * Issuing is two transactions. `reserve` puts the registry entry and adds one to both counters, each add conditional
 * on its cap, so concurrent requests can't overshoot either cap and a refused request counts for nothing. `commit`,
 * after Cognito has created the user, writes the patient's `PATIENT#<sub>` profile and the entry's `sub` together.
 * "Active" means listed in the registry, from the moment the reservation commits.
 *
 * The expiry job (#357, part 2) reads the registry with `listExpired` (a `Query` on the partition with an SK range, no
 * `Scan`) and, once an account's user and data are gone, calls `release`: one transaction removes the entry and takes one
 * off the active counter. `release` is safe to repeat: an entry already gone is `gone` and decrements nothing.
 *
 * A cancelled transaction is read by item position (r2/A-15). A failed condition on either counter is the cap, even
 * when another item only conflicted, and is never retried. A cancellation of conflicts alone is `conflict`: nothing
 * was refused and nothing was written, and the caller says "try again" (no retry loop here).
 */
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { IsoDate, Patient } from "@sched/contracts";
import { patientItem } from "@sched/tools/dynamo";

import { counterExpiresAt } from "./dynamo-turn-store";
import { queryAll } from "./query-all";

export const CONDITION_FAILED = "ConditionalCheckFailed";

/** The cancellation codes of a cancelled transaction, by item position; null for any other error. */
export function cancellationCodes(error: unknown): (string | undefined)[] | null {
  if (!(error instanceof TransactionCanceledException)) return null;
  return (error.CancellationReasons ?? []).map((reason) => reason.Code);
}

export interface AccessCaps {
  /** Accounts issued per clinic-local day. */
  daily: number;
  /** Accounts in the registry at once. */
  active: number;
}

/** One account's registry entry before it has a `sub`. */
export interface AccessReservation {
  /** A random ID for this request; never the API Gateway request ID or anything about the caller. */
  requestId: string;
  username: string;
  /** The clinic-local day the request was made on (the daily cap's day). */
  day: IsoDate;
  /** When the account is due for deletion, ISO UTC with `Z`. */
  accessExpiresAt: string;
}

/** A registry entry as the expiry job reads it. `sub` is absent when issuing failed before the profile was written. */
export interface IssuedEntry {
  requestId: string;
  username: string;
  accessExpiresAt: string;
  sub?: string;
}

export type ReleaseResult =
  | { ok: true }
  /** The entry was already removed (an earlier run got this far): nothing was decremented. */
  | { ok: false; reason: "gone" };

export type ReserveResult =
  | { ok: true }
  /** A cap was reached; nothing was written. */
  | { ok: false; reason: "capped" }
  /** The transaction only conflicted with another writer; nothing was written. */
  | { ok: false; reason: "conflict" };

export interface AccessStore {
  reserve(reservation: AccessReservation, caps: AccessCaps): Promise<ReserveResult>;
  /**
   * Writes the new patient's profile and records the user's `sub` (and the final `username`, which differs from the
   * reserved one only after a username clash) on the reservation's entry.
   */
  commit(reservation: AccessReservation, patient: Patient): Promise<void>;
}

/** What the expiry job uses of the registry. */
export interface ExpiryStore {
  /** Entries due at `nowIso` (ISO UTC, whole seconds): `accessExpiresAt` at or before it, oldest first. */
  listExpired(nowIso: string): Promise<IssuedEntry[]>;
  /**
   * Removes the entry and takes one off the active counter, in one transaction. A transaction that conflicts, or a
   * counter already at 0, throws: the entry stays and the next run tries again.
   */
  release(entry: IssuedEntry): Promise<ReleaseResult>;
}

export const accessKeys = {
  issued: (accessExpiresAt: string, requestId: string) => ({
    PK: "ACCESS#ISSUED",
    SK: `${accessExpiresAt}#${requestId}`,
  }),
  active: () => ({ PK: "ACCESS#COUNT", SK: "ACTIVE" }),
  daily: (day: string) => ({ PK: "ACCESS#COUNT", SK: `DAY#${day}` }),
};

export interface DynamoAccessStoreOptions {
  tableName: string;
  /** `send` is all we use, so tests can pass a fake. */
  doc: Pick<DynamoDBDocumentClient, "send">;
}

export function createDynamoAccessStore({
  tableName,
  doc,
}: DynamoAccessStoreOptions): AccessStore & ExpiryStore {
  return {
    async reserve(r, caps) {
      const input = {
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: accessKeys.daily(r.day),
              UpdateExpression: "ADD issued :one SET expiresAt = :exp, entityType = :type",
              ConditionExpression: "attribute_not_exists(issued) OR issued < :cap",
              ExpressionAttributeValues: {
                ":one": 1,
                ":cap": caps.daily,
                ":exp": counterExpiresAt(r.day),
                ":type": "ACCESS_DAILY_COUNTER",
              },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: accessKeys.active(),
              UpdateExpression: "ADD active :one SET entityType = :type",
              ConditionExpression: "attribute_not_exists(active) OR active < :cap",
              ExpressionAttributeValues: { ":one": 1, ":cap": caps.active, ":type": "ACCESS_ACTIVE_COUNTER" },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                ...accessKeys.issued(r.accessExpiresAt, r.requestId),
                entityType: "ACCESS_ISSUED",
                username: r.username,
                requestId: r.requestId,
                accessExpiresAt: r.accessExpiresAt,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      };
      try {
        await doc.send(new TransactWriteCommand(input));
        return { ok: true };
      } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error;
        const codes = (error.CancellationReasons ?? []).map((reason) => reason.Code);
        if (codes[0] === CONDITION_FAILED || codes[1] === CONDITION_FAILED) {
          return { ok: false, reason: "capped" };
        }
        // A random request ID that already exists is a bug, not a conflict to retry.
        if (codes[2] === CONDITION_FAILED) throw error;
        if (codes.includes("TransactionConflict")) return { ok: false, reason: "conflict" };
        throw error;
      }
    },

    async listExpired(nowIso) {
      const items = await queryAll(doc, {
        TableName: tableName,
        ConsistentRead: true,
        // `~` sorts after every character of a request ID, so an entry expiring exactly at `nowIso` is included.
        KeyConditionExpression: "PK = :pk AND SK <= :last",
        ExpressionAttributeValues: { ":pk": "ACCESS#ISSUED", ":last": `${nowIso}#~` },
      });
      return items.map((item) => ({
        requestId: String(item.requestId),
        username: String(item.username),
        accessExpiresAt: String(item.accessExpiresAt),
        ...(typeof item.sub === "string" ? { sub: item.sub } : {}),
      }));
    },

    async release(entry) {
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: tableName,
                  Key: accessKeys.issued(entry.accessExpiresAt, entry.requestId),
                  ConditionExpression: "attribute_exists(PK)",
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: accessKeys.active(),
                  UpdateExpression: "ADD active :minusOne",
                  ConditionExpression: "active >= :one",
                  ExpressionAttributeValues: { ":minusOne": -1, ":one": 1 },
                },
              },
            ],
          }),
        );
        return { ok: true };
      } catch (error) {
        const codes = cancellationCodes(error);
        if (codes?.[0] === CONDITION_FAILED) return { ok: false, reason: "gone" };
        throw error;
      }
    },

    async commit(r, patient) {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: patientItem(patient),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: accessKeys.issued(r.accessExpiresAt, r.requestId),
                // `sub` is a DynamoDB reserved word, hence the name placeholder.
                UpdateExpression: "SET #sub = :sub, username = :username",
                ExpressionAttributeNames: { "#sub": "sub" },
                ConditionExpression: "attribute_exists(PK)",
                ExpressionAttributeValues: { ":sub": patient.patientId, ":username": r.username },
              },
            },
          ],
        }),
      );
    },
  };
}

export interface InMemoryAccessStore extends AccessStore, ExpiryStore {
  /** Registry entries in reserve order. */
  readonly issued: { requestId: string; username: string; accessExpiresAt: string; sub?: string }[];
  /** Profiles written by `commit`. */
  readonly patients: Patient[];
  activeCount(): number;
  dailyCount(day: IsoDate): number;
}

export function createInMemoryAccessStore(): InMemoryAccessStore {
  const issued: InMemoryAccessStore["issued"] = [];
  const patients: Patient[] = [];
  const daily = new Map<string, number>();
  return {
    issued,
    patients,
    activeCount: () => issued.length,
    dailyCount: (day) => daily.get(day) ?? 0,
    reserve(r, caps) {
      if ((daily.get(r.day) ?? 0) >= caps.daily || issued.length >= caps.active) {
        return Promise.resolve({ ok: false, reason: "capped" });
      }
      daily.set(r.day, (daily.get(r.day) ?? 0) + 1);
      issued.push({ requestId: r.requestId, username: r.username, accessExpiresAt: r.accessExpiresAt });
      return Promise.resolve({ ok: true });
    },
    commit(r, patient) {
      const entry = issued.find((e) => e.requestId === r.requestId);
      if (!entry) return Promise.reject(new Error("no reservation for this request"));
      entry.sub = patient.patientId;
      entry.username = r.username;
      patients.push(structuredClone(patient));
      return Promise.resolve();
    },
    listExpired(nowIso) {
      const due = issued
        .filter((e) => e.accessExpiresAt <= nowIso)
        .sort((a, b) => a.accessExpiresAt.localeCompare(b.accessExpiresAt));
      return Promise.resolve(due.map((e) => ({ ...e })));
    },
    release(entry) {
      const at = issued.findIndex((e) => e.requestId === entry.requestId);
      if (at < 0) return Promise.resolve({ ok: false, reason: "gone" });
      issued.splice(at, 1);
      return Promise.resolve({ ok: true });
    },
  };
}
