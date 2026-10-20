/**
 * `POST /api/request-access` (#357): the one public route. A reviewer passes the bot check and gets a temporary
 * synthetic patient, whose sign-in details come back once in this response.
 *
 * Order (owner decision r1/A-3): verify the bot check; reserve (both caps and the registry entry in one
 * transaction); `AdminCreateUser` (no message); `AdminSetUserPassword` (permanent); `AdminGetUser` for the `sub`;
 * then write the profile and the entry's `sub` in one transaction. The bot check comes first, so a request that
 * fails it counts against no cap and creates nothing. If anything after the reservation fails, one attempt is made
 * to delete the Cognito user, the reservation stays (the expiry job releases it, PR 2), and the answer is "try
 * again"; the day's count stays used.
 *
 * Privacy (A-7): the log entry carries the request ID, the outcome and timings, and nothing else. The handler never
 * reads the source IP, the user agent, the token, the username or the password. The password exists in memory for
 * the length of this call and in the one response; it is never stored or logged. This route has no authorizer, so
 * the patient ID is not read from the request at all: it is the `sub` Cognito assigned to the new user (CLAUDE.md
 * rule 1 still holds for every later call, which carries a verified token).
 */
import { randomUUID } from "node:crypto";

import {
  ACCESS_CAP_MESSAGE,
  type IsoDateTimeUtc,
  Patient,
  RequestAccessError,
  type RequestAccessErrorCode,
  RequestAccessRequest,
  RequestAccessResponse,
} from "@sched/contracts";
import { clinicDateOf, type Clock } from "@sched/tools";

import type { AccessCaps, AccessReservation, AccessStore } from "./access-store";
import { newIdentity, newPassword, newUsername, type RandomInt } from "./access-identity";
import type { BotVerifier } from "./bot-check";
import type { CognitoAdmin } from "./cognito-admin";
import { jsonResponse, type ProxyResult } from "./http";
import { errorSummary, silentLogger, type Logger } from "./log";
import { bodyText, parseJsonBody, type RestApiProxyEvent } from "./request";

export const DEFAULT_ACCESS_DAILY_CAP = 10;
export const DEFAULT_ACCESS_ACTIVE_CAP = 5;
export const DEFAULT_ACCESS_EXPIRY_HOURS = 24;

export interface AccessConfig {
  caps: AccessCaps;
  /** How long an account lasts before it is due for deletion. */
  expiryHours: number;
}

export interface RequestAccessDeps {
  verifier: BotVerifier;
  store: AccessStore;
  admin: CognitoAdmin;
  clock: Clock;
  config: AccessConfig;
  random?: RandomInt;
  newRequestId?: () => string;
  log?: Logger;
  monotonicNow?: () => number;
}

/** Status, code and message of each failure; the page shows the message. */
export const ACCESS_FAILURES: Record<
  RequestAccessErrorCode,
  { status: number; code: RequestAccessErrorCode; message: string }
> = {
  BAD_REQUEST: { status: 400, code: "BAD_REQUEST", message: "The request body must be a bot-check token." },
  BOT_CHECK_FAILED: {
    status: 403,
    code: "BOT_CHECK_FAILED",
    message: "The check didn't pass. Please try again.",
  },
  CAP_REACHED: { status: 429, code: "CAP_REACHED", message: ACCESS_CAP_MESSAGE },
  TRY_AGAIN: {
    status: 503,
    code: "TRY_AGAIN",
    message: "We couldn't create access just now. Please try again in a moment.",
  },
};

function failure(code: RequestAccessErrorCode): ProxyResult {
  const { status, message } = ACCESS_FAILURES[code];
  return jsonResponse(status, RequestAccessError.parse({ error: { code, message } }));
}

/** ISO UTC with whole seconds and a `Z`, the shape `IsoDateTimeUtc` and the registry's sort key use. */
const isoSeconds = (date: Date): IsoDateTimeUtc => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export type AccessOutcome = "issued" | "bot_check_failed" | "capped" | "try_again" | "bad_request" | "error";

export async function handleRequestAccess(
  input: { body: string | null; requestId: string },
  deps: RequestAccessDeps,
): Promise<ProxyResult> {
  const log = deps.log ?? silentLogger;
  const now = deps.monotonicNow ?? (() => performance.now());
  const t0 = now();
  let outcome: AccessOutcome;
  let result: ProxyResult;
  try {
    ({ outcome, result } = await issue(input.body, deps));
  } catch (error) {
    log({ msg: "request-access failed", level: "error", requestId: input.requestId, ...errorSummary(error) });
    outcome = "error";
    result = failure("TRY_AGAIN");
  }
  log({ msg: "request-access", requestId: input.requestId, outcome, totalMs: Math.round(now() - t0) });
  return result;
}

async function issue(
  body: string | null,
  deps: RequestAccessDeps,
): Promise<{ outcome: AccessOutcome; result: ProxyResult }> {
  const parsed = parseJsonBody(body, RequestAccessRequest);
  if (!parsed.ok) return { outcome: "bad_request", result: failure("BAD_REQUEST") };

  const check = await deps.verifier(parsed.value.turnstileToken);
  if (!check.ok) {
    return check.reason === "rejected"
      ? { outcome: "bot_check_failed", result: failure("BOT_CHECK_FAILED") }
      : { outcome: "try_again", result: failure("TRY_AGAIN") };
  }

  const { random } = deps;
  const now = deps.clock.now();
  const accessExpiresAt = isoSeconds(new Date(now.getTime() + deps.config.expiryHours * 3_600_000));
  const reservation: AccessReservation = {
    requestId: (deps.newRequestId ?? randomUUID)(),
    username: newUsername(random),
    day: clinicDateOf(now),
    accessExpiresAt,
  };

  const reserved = await deps.store.reserve(reservation, deps.config.caps);
  if (!reserved.ok) {
    return reserved.reason === "capped"
      ? { outcome: "capped", result: failure("CAP_REACHED") }
      : { outcome: "try_again", result: failure("TRY_AGAIN") };
  }

  // From here on the reservation stands. A failure deletes the user once and answers "try again".
  const identity = newIdentity(random);
  const password = newPassword(random);
  let username = reservation.username;
  try {
    let created = await deps.admin.createUser({
      username,
      givenName: identity.firstName,
      familyName: identity.lastName,
    });
    if (!created) {
      // A random clash with an existing user: one retry with a new handle, then give up.
      username = newUsername(random);
      created = await deps.admin.createUser({
        username,
        givenName: identity.firstName,
        familyName: identity.lastName,
      });
      if (!created) return { outcome: "try_again", result: failure("TRY_AGAIN") };
    }
    await deps.admin.setPermanentPassword(username, password);
    const sub = await deps.admin.getSub(username);
    const patient = Patient.parse({ patientId: sub, ...identity, createdAt: isoSeconds(now) });
    await deps.store.commit({ ...reservation, username }, patient);
    return {
      outcome: "issued",
      result: jsonResponse(
        200,
        RequestAccessResponse.parse({
          username,
          password,
          firstName: identity.firstName,
          lastName: identity.lastName,
          expiresAt: accessExpiresAt,
        }),
      ),
    };
  } catch (error) {
    await deps.admin.deleteUser(username).catch(() => undefined);
    throw error;
  }
}

/** The REST API Lambda proxy adapter. */
export function requestAccessProxyHandler(
  deps: RequestAccessDeps,
): (event: RestApiProxyEvent) => Promise<ProxyResult> {
  return (event) =>
    handleRequestAccess({ body: bodyText(event), requestId: event.requestContext.requestId }, deps);
}
