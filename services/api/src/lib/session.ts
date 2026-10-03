/**
 * The session call behind `POST /api/session` (S3-04, #18): the templated greeting (FR-010) and the
 * patient's current conversation for restore (FR-014). No model call. Transport-free with injected
 * repositories, clock and logger (CLAUDE.md rule 3); `handlers/session.ts` wires the AWS ones.
 *
 * - POST, not GET: CloudFront drops `Authorization` on GET (ADR-007, amendment 2026-10-03). The body is
 *   empty or `{}`; anything else is a 400. Nothing in it could name a patient anyway.
 * - Identity is the authorizer's verified `claims.sub`, nothing else (CLAUDE.md rule 1, ADR-005).
 * - Every read is a patient-scoped repository read (ADR-004): the profile, the patient's appointments,
 *   the patient's newest conversation, and `listMessages(patientId, conversationId)`, which returns
 *   nothing for a conversation that isn't this patient's. The provider read is the clinic's public data.
 * - "Current conversation" is the patient's newest (by creation). If its messages have expired (TTL,
 *   ADR-004) there is nothing to restore: `conversationId` is null and the next chat turn starts afresh.
 * - The three independent reads run in parallel, then the provider and the messages, so the warm path
 *   is two DynamoDB round trips (p95 < 300 ms warm, #18).
 * - Logs IDs, counts and timings only, never names or message text (ADR-009).
 */
import {
  SessionResponse,
  type ConversationId,
  type PatientId,
  type UpcomingAppointment,
} from "@sched/contracts";
import type { Clock, Repositories } from "@sched/tools";

import { toDisplayMessages } from "./display";
import {
  NO_PROFILE_FIRST_NAME,
  nextUpcomingAppointment,
  sessionGreeting,
  toUpcomingAppointment,
} from "./greeting";
import { errorResponse, jsonResponse, type ProxyResult } from "./http";
import { errorSummary, silentLogger, type Logger } from "./log";
import { bodyText, patientIdFromEvent, type RestApiProxyEvent } from "./request";

export type SessionRepositories = Pick<
  Repositories,
  "patients" | "providers" | "appointments" | "conversations"
>;

export interface SessionDeps {
  repos: SessionRepositories;
  clock: Clock;
  log?: Logger;
  /** Monotonic milliseconds for timings. Default `performance.now`. */
  monotonicNow?: () => number;
}

export interface SessionInput {
  /** The raw request body (already base64-decoded). */
  body: string | null;
  /** The verified JWT `sub` from the authorizer. Never taken from the body (CLAUDE.md rule 1). */
  patientId: PatientId | undefined;
  requestId: string;
}

/** The session call takes no parameters: an empty body, or the JSON object `{}`. */
export function isEmptySessionBody(body: string | null): boolean {
  if (body === null || body.trim() === "") return true;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  return typeof json === "object" && json !== null && !Array.isArray(json) && Object.keys(json).length === 0;
}

export const SESSION_FAILURES = {
  unauthorized: () => errorResponse(401, "UNAUTHORIZED", "Please sign in again."),
  badRequest: () => errorResponse(400, "BAD_REQUEST", "The request couldn't be read."),
  internal: () => errorResponse(500, "INTERNAL", "Something went wrong on our side."),
} as const;

export async function handleSession(input: SessionInput, deps: SessionDeps): Promise<ProxyResult> {
  const log = deps.log ?? silentLogger;
  const now = deps.monotonicNow ?? (() => performance.now());
  const t0 = now();
  const facts: Record<string, unknown> = {};
  let result: ProxyResult;
  try {
    if (input.patientId === undefined) result = SESSION_FAILURES.unauthorized();
    else if (!isEmptySessionBody(input.body)) result = SESSION_FAILURES.badRequest();
    else result = jsonResponse(200, await buildSession(input.patientId, deps, facts));
  } catch (error) {
    log({ msg: "session failed", level: "error", requestId: input.requestId, ...errorSummary(error) });
    result = SESSION_FAILURES.internal();
  }
  log({
    msg: "session",
    requestId: input.requestId,
    status: result.statusCode,
    ...facts,
    totalMs: Math.round(now() - t0),
  });
  return result;
}

async function buildSession(
  patientId: PatientId,
  deps: SessionDeps,
  facts: Record<string, unknown>,
): Promise<SessionResponse> {
  const { repos, clock } = deps;
  const [profile, appointments, [newest]] = await Promise.all([
    repos.patients.get(patientId),
    repos.appointments.listForPatient(patientId),
    repos.conversations.listConversations(patientId, { limit: 1 }),
  ]);
  const next = nextUpcomingAppointment(appointments, clock.now());

  const newestId = newest?.conversationId ?? null;
  const [upcoming, stored] = await Promise.all([
    upcomingWithProvider(deps, next),
    newestId === null ? [] : repos.conversations.listMessages(patientId, newestId),
  ]);
  // Empty when the messages have expired (TTL): nothing to restore, and nothing to continue.
  const conversationId: ConversationId | null = stored.length > 0 ? newestId : null;
  const messages = toDisplayMessages(stored);

  Object.assign(facts, {
    hasProfile: profile !== null,
    hasUpcoming: upcoming !== null,
    conversationId,
    displayMessages: messages.length,
  });
  // Validated on the way out: a response that breaks the contract is a bug, reported as a 500.
  return SessionResponse.parse({
    patient: { firstName: profile?.firstName ?? NO_PROFILE_FIRST_NAME },
    greeting: sessionGreeting(profile?.firstName ?? null, upcoming),
    upcomingAppointment: upcoming,
    conversationId,
    messages,
  });
}

async function upcomingWithProvider(
  deps: SessionDeps,
  next: ReturnType<typeof nextUpcomingAppointment>,
): Promise<UpcomingAppointment | null> {
  if (next === null) return null;
  const provider = await deps.repos.providers.get(next.providerId);
  // Appointments reference seeded providers; a missing one is a broken invariant, not a name to invent.
  if (provider === null) throw new Error(`Appointment references unknown provider ${next.providerId}`);
  return toUpcomingAppointment(next, provider);
}

/** The REST API Lambda proxy adapter (buffered JSON, not streaming). */
export function sessionProxyHandler(deps: SessionDeps): (event: RestApiProxyEvent) => Promise<ProxyResult> {
  return (event) =>
    handleSession(
      {
        body: bodyText(event),
        patientId: patientIdFromEvent(event),
        requestId: event.requestContext.requestId,
      },
      deps,
    );
}
