/**
 * HTTP API shapes (camelCase) for the SPA. Every route sits behind the Cognito authorizer; the
 * patient is identified by the token, never by a request field.
 */
import { z } from "zod";

import { LIMITS, Specialty } from "./clinic";
import { AppointmentId, ConversationId, MessageId } from "./ids";
import { IsoDateTimeUtc } from "./primitives";
import { ChatErrorCode } from "./stream";

/** `POST /api/chat` body. Response: a stream of ChatStreamEvent (stream.ts). */
export const ChatRequest = z.strictObject({
  /** Omit to start a new conversation; the `done` event returns the new ID. */
  conversationId: ConversationId.optional(),
  /** Client-generated; lets the server de-duplicate a retried send (FR-015). */
  clientMessageId: z.uuid(),
  text: z.string().trim().min(1).max(LIMITS.chatTextMaxChars),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** A chat bubble as the SPA renders it: text only, no tool blocks. */
export const DisplayMessage = z.strictObject({
  id: MessageId,
  role: z.enum(["patient", "assistant"]),
  text: z.string(),
  createdAt: IsoDateTimeUtc,
});
export type DisplayMessage = z.infer<typeof DisplayMessage>;

export const UpcomingAppointment = z.strictObject({
  appointmentId: AppointmentId,
  providerName: z.string().min(1).max(80),
  specialty: Specialty,
  startUtc: IsoDateTimeUtc,
  startLocal: z.string().min(1).max(80),
});
export type UpcomingAppointment = z.infer<typeof UpcomingAppointment>;

/** `GET /api/session`: the templated greeting (FR-010) and the current conversation, for restore (FR-014). */
export const SessionResponse = z.strictObject({
  patient: z.strictObject({ firstName: z.string().min(1).max(60) }),
  greeting: z.string().min(1).max(500),
  upcomingAppointment: UpcomingAppointment.nullable(),
  conversationId: ConversationId.nullable(),
  messages: z.array(DisplayMessage),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Non-streaming error body for 4xx/5xx responses. */
export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ChatErrorCode,
    message: z.string().min(1).max(500),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
