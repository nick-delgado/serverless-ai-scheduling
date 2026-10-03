/**
 * The API Gateway REST API Lambda proxy event (payload v1) as our handlers read it, and the one place
 * that turns it into a patient identity. Shared by every handler (`/api/chat` #17, `/api/session` #18).
 */
import { PatientId } from "@sched/contracts";

/** The fields we read from the REST API Lambda proxy event. */
export interface RestApiProxyEvent {
  body: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    requestId: string;
    /** Set by the Cognito User Pool authorizer: the verified ID token's claims. */
    authorizer?: { claims?: Record<string, string | undefined> } | null;
  };
}

/**
 * The patient ID from the authorizer's verified claims (`sub`), or undefined when it's missing or isn't
 * a Cognito UUID. This is the ONLY source of patient identity (CLAUDE.md rule 1, ADR-005): never a body
 * field, never a tool input.
 */
export function patientIdFromEvent(event: RestApiProxyEvent): PatientId | undefined {
  const parsed = PatientId.safeParse(event.requestContext.authorizer?.claims?.sub);
  return parsed.success ? parsed.data : undefined;
}

/** The request body as text (API Gateway base64-encodes binary media types). */
export function bodyText(event: RestApiProxyEvent): string | null {
  if (event.body === null) return null;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

/** Parse a JSON body with a Zod-style schema. Malformed JSON and schema mismatches both read as failure. */
export function parseJsonBody<T>(
  body: string | null,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): { ok: true; value: T } | { ok: false } {
  if (body === null) return { ok: false };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}
