/**
 * The expiry job (#357, part 2; owner decisions r1/Q-3 (a) and r1/A-4): deletes each temporary account that is due,
 * with its data, and frees its place in the registry. It runs hourly (`rate(1 hour)`, `RequestAccessExpiryFunction`),
 * so an account is deleted at most an hour after it expires, and on demand with `{ "asOf": "<ISO time>" }`.
 *
 * For each registry entry at or before `asOf`, in this order (every step repeats safely, so an entry that fails part-way
 * is simply tried again next run and is never left orphaned):
 * 1. Skip it, logged by request ID, unless its username starts with `user-`. Nothing is deleted for it and it stays.
 * 2. With a `sub`: look the user up. Only when the user's `sub` is the entry's is it signed out everywhere
 *    (`AdminUserGlobalSignOut`) and deleted (`AdminDeleteUser`). A user that no longer exists counts as deleted. A user
 *    with another `sub` is not ours (a username clash, ADR-004's amendment): it is left alone and the entry goes on.
 *    Without a `sub` (issuing failed before the profile was written) no user is touched: the entry can't prove which
 *    user is its own, and no password ever left the function.
 * 3. With a `sub`: delete the account's data and free its slots (`account-data.ts`).
 * 4. Remove the entry and take one off the active counter, in one transaction.
 *
 * A failure on one entry is logged by request ID and error name, counted, and doesn't stop the others. The log
 * carries request IDs, outcomes and counts only: never a username, a `sub` or a name.
 */
import { ACCESS_USERNAME_PREFIX, toIsoSeconds } from "@sched/contracts";
import type { Clock } from "@sched/tools";

import type { AccountData } from "./account-data";
import type { ExpiryStore, IssuedEntry } from "./access-store";
import type { CognitoExpiryAdmin } from "./cognito-admin";
import { errorSummary, silentLogger, type Logger } from "./log";

export interface ExpireDeps {
  store: ExpiryStore;
  admin: CognitoExpiryAdmin;
  data: AccountData;
  clock: Clock;
  log?: Logger;
}

export type ExpiryOutcome =
  /** The user (if it was ours) and the data are gone and the entry is released. */
  | "expired"
  /** An entry with no `sub`: released without touching any user. */
  | "released_unissued"
  /** The entry was already removed by another run. */
  | "already_released"
  /** The username has no `user-` prefix: nothing deleted, the entry stays. */
  | "skipped_prefix"
  | "failed";

export interface ExpirySummary {
  /** The time entries were compared with, ISO UTC. */
  asOf: string;
  due: number;
  expired: number;
  skipped: number;
  failed: number;
}

export async function expireAccess(deps: ExpireDeps, asOf?: Date): Promise<ExpirySummary> {
  const log = deps.log ?? silentLogger;
  const at = toIsoSeconds(asOf ?? deps.clock.now());
  const due = await deps.store.listExpired(at);
  const summary: ExpirySummary = { asOf: at, due: due.length, expired: 0, skipped: 0, failed: 0 };

  for (const entry of due) {
    let outcome: ExpiryOutcome;
    try {
      outcome = await expireOne(entry, deps, log);
    } catch (error) {
      log({
        msg: "access-expiry entry failed",
        level: "error",
        requestId: entry.requestId,
        ...errorSummary(error),
      });
      outcome = "failed";
    }
    log({ msg: "access-expiry entry", requestId: entry.requestId, outcome });
    if (outcome === "failed") summary.failed++;
    else if (outcome === "skipped_prefix") summary.skipped++;
    else summary.expired++;
  }

  log({
    msg: "access-expiry",
    asOf: at,
    due: summary.due,
    expired: summary.expired,
    skipped: summary.skipped,
    failed: summary.failed,
  });
  return summary;
}

async function expireOne(entry: IssuedEntry, deps: ExpireDeps, log: Logger): Promise<ExpiryOutcome> {
  if (!entry.username.startsWith(ACCESS_USERNAME_PREFIX)) {
    log({
      msg: "access-expiry skipped an entry without the user- prefix",
      level: "warn",
      requestId: entry.requestId,
    });
    return "skipped_prefix";
  }
  if (entry.sub === undefined) {
    const released = await deps.store.release(entry);
    return released.ok ? "released_unissued" : "already_released";
  }

  const found = await deps.admin.findSub(entry.username);
  if (found === entry.sub) {
    await deps.admin.globalSignOut(entry.username);
    await deps.admin.deleteUser(entry.username);
  } else if (found !== undefined) {
    log({
      msg: "access-expiry left a user with another sub alone",
      level: "warn",
      requestId: entry.requestId,
    });
  }

  const deleted = await deps.data.deleteAccount(entry.sub);
  log({
    msg: "access-expiry data",
    requestId: entry.requestId,
    items: deleted.items,
    slotsFreed: deleted.slotsFreed,
  });
  const released = await deps.store.release(entry);
  return released.ok ? "expired" : "already_released";
}

/**
 * The Lambda handler's body. The hourly schedule sends EventBridge's scheduled event, which has no `asOf`, so the job
 * compares entries with the clock. An operator's invocation may carry `{ "asOf": "<ISO time>" }` to run as of another
 * time: a time in the future expires accounts early (the live check; the runbook's revoke-all step uses a far-future
 * time). Anything else in the event is ignored, and an `asOf` that isn't a date fails the run before anything is read.
 * The run throws after all entries were tried when any failed, so the invocation shows as failed (the Lambda Errors
 * metric) while the entries stay for the next run.
 */
export function expiryHandler(deps: ExpireDeps): (event: unknown) => Promise<ExpirySummary> {
  return async (event) => {
    const asOf = parseAsOf(event);
    const summary = await expireAccess(deps, asOf);
    if (summary.failed > 0) throw new Error(`${summary.failed} of ${summary.due} accounts failed to expire`);
    return summary;
  };
}

function parseAsOf(event: unknown): Date | undefined {
  const raw = typeof event === "object" && event !== null ? (event as { asOf?: unknown }).asOf : undefined;
  if (raw === undefined) return undefined;
  const at = typeof raw === "string" ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) throw new Error("asOf must be an ISO date-time string");
  return at;
}
