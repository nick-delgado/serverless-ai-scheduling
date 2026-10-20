/**
 * HTTP API shapes (camelCase) for the SPA. Every route sits behind the Cognito authorizer; the
 * patient is identified by the token, never by a request field.
 */
import { z } from "zod";

import { LIMITS, Specialty } from "./clinic";
import { AppointmentId, ConversationId, MessageId } from "./ids";
import { IsoDateTimeUtc } from "./primitives";
import { ChatErrorCode } from "./stream";

/**
 * How a patient's message was entered. Client-supplied and untrusted (ADR-009): it can only make the
 * agent more careful (a spoken turn reaches the model with a marker, #234), never less.
 */
export const ChatInputMode = z.enum(["text", "voice"]);
export type ChatInputMode = z.infer<typeof ChatInputMode>;

/** `POST /api/chat` body. Response: a stream of ChatStreamEvent (stream.ts). */
export const ChatRequest = z.strictObject({
  /** Omit to start a new conversation; the `done` event returns the new ID. */
  conversationId: ConversationId.optional(),
  /** Client-generated; lets the server de-duplicate a retried send (FR-015). */
  clientMessageId: z.uuid(),
  text: z.string().trim().min(1).max(LIMITS.chatTextMaxChars),
  /** Omitted means `"text"`. `"voice"` marks a transcript from the voice overlay (#234). */
  inputMode: ChatInputMode.optional(),
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

/**
 * `POST /api/session` (empty or `{}` body): the templated greeting (FR-010) and the current conversation,
 * for restore (FR-014). POST because CloudFront drops `Authorization` on GET (ADR-007, amendment 2026-10-03).
 */
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

/**
 * `POST /api/request-access` (#357): the one public route. A reviewer passes the bot check and gets a
 * temporary synthetic patient. The body carries the bot-check token and nothing about the reviewer.
 */
export const RequestAccessRequest = z.strictObject({
  /** The Cloudflare Turnstile token (at most 2048 characters, per Cloudflare's server-side validation docs). */
  turnstileToken: z.string().min(1).max(2048),
});
export type RequestAccessRequest = z.infer<typeof RequestAccessRequest>;

/** The sign-in details, shown once: the server never stores or logs the password (#357, A-7, A-8). */
export const RequestAccessResponse = z.strictObject({
  username: z.string().regex(/^user-[a-z0-9]{8}$/),
  password: z.string().min(12).max(64),
  /** The synthetic patient's name, drawn from a fixed list without any input from the reviewer. */
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  /** When the account stops counting as active and is due for deletion. */
  expiresAt: IsoDateTimeUtc,
});
export type RequestAccessResponse = z.infer<typeof RequestAccessResponse>;

/** Why a request created nothing. Separate from `ChatErrorCode`: these codes belong to this route alone. */
export const RequestAccessErrorCode = z.enum([
  "BAD_REQUEST",
  /** The bot check rejected the token (or none was sent). */
  "BOT_CHECK_FAILED",
  /** The daily or the active cap is reached: the page says to contact Nick. */
  "CAP_REACHED",
  /** The verifier was unreachable, a transaction conflicted, or a step failed: nothing usable was created. */
  "TRY_AGAIN",
]);
export type RequestAccessErrorCode = z.infer<typeof RequestAccessErrorCode>;

export const RequestAccessError = z.strictObject({
  error: z.strictObject({
    code: RequestAccessErrorCode,
    message: z.string().min(1).max(500),
  }),
});
export type RequestAccessError = z.infer<typeof RequestAccessError>;

/** The text when a cap is reached (#357, A-11). The page links "the project README" to the repository's README. */
export const ACCESS_CAP_MESSAGE =
  "Demo access requests have run out for now. Please contact Nick through the contact details in the project README.";
