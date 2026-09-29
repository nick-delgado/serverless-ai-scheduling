/**
 * A valid, internally consistent example for every exported schema (fictional data only).
 * Used by this package's round-trip tests and reusable as fixtures elsewhere:
 * `import { EXAMPLES } from "@sched/contracts/testing"`.
 */
import type { z } from "zod";

import type * as C from "../index";

const PATIENT_ID = "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01";
const CONVERSATION_ID = "b1e2c3d4-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const TURN_ID = "c2d3e4f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const CLIENT_MESSAGE_ID = "d3e4f5a6-7b8c-4d9e-a0f1-2b3c4d5e6f70";
const PROVIDER_ID = "prov_lee";
const SLOT_ID = "slot_lee_20261013T1830Z"; // Tue Oct 13, 2026 2:30 PM ET
const APPOINTMENT_ID = "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY";
const ESCALATION_ID = "esc_01JBX7Q2M3N4P5R6S7T8V9W0XZ";
const START = "2026-10-13T18:30:00Z";
const END = "2026-10-13T19:00:00Z";
const START_LOCAL = "Tuesday, October 13, 2026 at 2:30 PM ET";
const NOW = "2026-10-05T13:00:00Z";
const USAGE = { inputTokens: 1113, outputTokens: 262, cacheReadTokens: 4070, cacheWriteTokens: 214 };

type In<K extends keyof typeof C> = (typeof C)[K] extends z.ZodType ? z.input<(typeof C)[K]> : never;

const providerSummary = {
  provider_id: PROVIDER_ID,
  display_name: "Dr. Priya Lee",
  specialty: "dermatology",
  accepting_new_patients: true,
} satisfies In<"ProviderSummary">;

const appointmentSummary = {
  appointment_id: APPOINTMENT_ID,
  provider_id: PROVIDER_ID,
  provider_name: "Dr. Priya Lee",
  specialty: "dermatology",
  start_utc: START,
  start_local: START_LOCAL,
  status: "BOOKED",
  reason: "Mole check",
} satisfies In<"AppointmentSummary">;

const statusEvent = {
  type: "status",
  tool: "check_availability",
  label: "Checking availability…",
} satisfies In<"ChatStatusEvent">;
const deltaEvent = { type: "text_delta", text: "I found three openings" } satisfies In<"ChatTextDeltaEvent">;
const doneEvent = {
  type: "done",
  conversationId: CONVERSATION_ID,
  messageId: "msg_000003",
  usage: USAGE,
} satisfies In<"ChatDoneEvent">;
const errorEvent = {
  type: "error",
  code: "AGENT_UNAVAILABLE",
  message: "The assistant is temporarily unavailable. Please try again.",
  retryable: true,
} satisfies In<"ChatErrorEvent">;

export const EXAMPLES = {
  // primitives + ids + clinic
  IsoDate: "2026-10-13",
  IsoDateTimeUtc: START,
  TokenUsage: USAGE,
  PatientId: PATIENT_ID,
  ProviderId: PROVIDER_ID,
  SlotId: SLOT_ID,
  AppointmentId: APPOINTMENT_ID,
  EscalationId: ESCALATION_ID,
  ConversationId: CONVERSATION_ID,
  TurnId: TURN_ID,
  MessageId: "msg_000003",
  Specialty: "dermatology",

  // domain
  Patient: {
    patientId: PATIENT_ID,
    firstName: "Maria",
    lastName: "Santos",
    dateOfBirth: "1988-04-17",
    preferredProviderId: PROVIDER_ID,
    createdAt: NOW,
  } satisfies In<"Patient">,
  Provider: {
    providerId: PROVIDER_ID,
    displayName: "Dr. Priya Lee",
    firstName: "Priya",
    lastName: "Lee",
    credentials: "MD",
    specialty: "dermatology",
    acceptingNewPatients: true,
    bio: "Board-certified dermatologist (fictional).",
  } satisfies In<"Provider">,
  SlotStatus: "OPEN",
  Slot: {
    slotId: SLOT_ID,
    providerId: PROVIDER_ID,
    specialty: "dermatology",
    startUtc: START,
    endUtc: END,
    status: "BOOKED",
    appointmentId: APPOINTMENT_ID,
  } satisfies In<"Slot">,
  AppointmentStatus: "BOOKED",
  Appointment: {
    appointmentId: APPOINTMENT_ID,
    patientId: PATIENT_ID,
    providerId: PROVIDER_ID,
    slotId: SLOT_ID,
    specialty: "dermatology",
    startUtc: START,
    endUtc: END,
    status: "BOOKED",
    reason: "Mole check",
    createdAt: NOW,
    updatedAt: NOW,
  } satisfies In<"Appointment">,
  ContentBlock: { type: "text", text: "Hi! Do you have dermatology openings on Tuesday?" },
  ConversationMessage: {
    conversationId: CONVERSATION_ID,
    seq: 2,
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      {
        type: "tool_use",
        id: "toolu_01",
        name: "check_availability",
        input: { specialty: "dermatology", date_range: { start_date: "2026-10-13", end_date: "2026-10-13" } },
      },
    ],
    turnId: TURN_ID,
    createdAt: NOW,
  } satisfies In<"ConversationMessage">,
  EscalationReason: "patient_requested",
  Escalation: {
    escalationId: ESCALATION_ID,
    conversationId: CONVERSATION_ID,
    patientId: PATIENT_ID,
    reason: "patient_requested",
    summary: "Patient asked to speak with a person about rescheduling a dermatology visit.",
    createdAt: NOW,
    notification: { status: "SENT", messageId: "0100019a-example" },
  } satisfies In<"Escalation">,

  // tools
  ToolName: "check_availability",
  ProviderSummary: providerSummary,
  SlotOption: {
    slot_id: SLOT_ID,
    provider_id: PROVIDER_ID,
    provider_name: "Dr. Priya Lee",
    specialty: "dermatology",
    start_utc: START,
    start_local: START_LOCAL,
  } satisfies In<"SlotOption">,
  AppointmentSummary: appointmentSummary,
  ToolErrorCode: "SLOT_UNAVAILABLE",
  ToolError: {
    error: {
      code: "SLOT_UNAVAILABLE",
      message: "That time was just booked by someone else.",
      hint: "Call check_availability again and offer the next closest times.",
    },
  } satisfies In<"ToolError">,
  DateRange: { start_date: "2026-10-13", end_date: "2026-10-16" } satisfies In<"DateRange">,
  FindProvidersInput: { specialty: "dermatology", name_query: "Lee" } satisfies In<"FindProvidersInput">,
  CheckAvailabilityInput: {
    specialty: "dermatology",
    date_range: { start_date: "2026-10-13", end_date: "2026-10-13" },
    time_of_day: "afternoon",
  } satisfies In<"CheckAvailabilityInput">,
  GetMyAppointmentsInput: {} satisfies In<"GetMyAppointmentsInput">,
  GetPatientProfileInput: {} satisfies In<"GetPatientProfileInput">,
  BookAppointmentInput: { slot_id: SLOT_ID, reason: "Mole check" } satisfies In<"BookAppointmentInput">,
  RescheduleAppointmentInput: {
    appointment_id: APPOINTMENT_ID,
    new_slot_id: "slot_lee_20261015T1400Z",
  } satisfies In<"RescheduleAppointmentInput">,
  EscalateToHumanInput: {
    reason: "patient_requested",
    summary: "Patient asked to speak with a person about rescheduling a dermatology visit.",
  } satisfies In<"EscalateToHumanInput">,
  FindProvidersOutput: { providers: [providerSummary] } satisfies In<"FindProvidersOutput">,
  CheckAvailabilityOutput: {
    slots: [
      {
        slot_id: SLOT_ID,
        provider_id: PROVIDER_ID,
        provider_name: "Dr. Priya Lee",
        specialty: "dermatology",
        start_utc: START,
        start_local: START_LOCAL,
      },
    ],
    truncated: false,
  } satisfies In<"CheckAvailabilityOutput">,
  GetMyAppointmentsOutput: { appointments: [appointmentSummary] } satisfies In<"GetMyAppointmentsOutput">,
  GetPatientProfileOutput: {
    first_name: "Maria",
    last_name: "Santos",
    preferred_provider: providerSummary,
  } satisfies In<"GetPatientProfileOutput">,
  BookAppointmentOutput: {
    appointment: appointmentSummary,
    already_booked: false,
  } satisfies In<"BookAppointmentOutput">,
  RescheduleAppointmentOutput: {
    appointment: {
      ...appointmentSummary,
      start_utc: "2026-10-15T14:00:00Z",
      start_local: "Thursday, October 15, 2026 at 10:00 AM ET",
    },
    previous_start_local: START_LOCAL,
  } satisfies In<"RescheduleAppointmentOutput">,
  EscalateToHumanOutput: {
    escalation_id: ESCALATION_ID,
    phone: "1-800-555-0199",
    hours: "Mon–Fri, 8 AM–5 PM ET",
    already_escalated: false,
  } satisfies In<"EscalateToHumanOutput">,

  // trace
  LlmCallTrace: {
    index: 0,
    modelId: "us.anthropic.claude-sonnet-4-6",
    startedAt: NOW,
    durationMs: 2670,
    ttftMs: 1380,
    stopReason: "tool_use",
    usage: USAGE,
  } satisfies In<"LlmCallTrace">,
  ToolCallTrace: {
    toolUseId: "toolu_01",
    name: "check_availability",
    input: { specialty: "dermatology", date_range: { start_date: "2026-10-13", end_date: "2026-10-13" } },
    ok: true,
    durationMs: 42,
  } satisfies In<"ToolCallTrace">,
  TurnOutcome: "completed",
  TurnTrace: {
    turnId: TURN_ID,
    conversationId: CONVERSATION_ID,
    modelProfile: "sonnet-4.6-medium",
    modelId: "us.anthropic.claude-sonnet-4-6",
    promptVersion: "system.v1",
    startedAt: NOW,
    durationMs: 5160,
    iterations: 2,
    llmCalls: [],
    toolCalls: [],
    usage: USAGE,
    outcome: "completed",
  } satisfies In<"TurnTrace">,

  // stream
  ChatStatusEvent: statusEvent,
  ChatTextDeltaEvent: deltaEvent,
  ChatDoneEvent: doneEvent,
  ChatErrorCode: "RATE_LIMITED",
  ChatErrorEvent: errorEvent,
  ChatStreamEvent: statusEvent,
  ChatStreamEventList: [statusEvent, deltaEvent, doneEvent] satisfies In<"ChatStreamEventList">,

  // api
  ChatRequest: {
    conversationId: CONVERSATION_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    text: "Do you have dermatology openings on Tuesday afternoon?",
  } satisfies In<"ChatRequest">,
  DisplayMessage: {
    id: "msg_000003",
    role: "assistant",
    text: "I found three openings on Tuesday, October 13.",
    createdAt: NOW,
  } satisfies In<"DisplayMessage">,
  UpcomingAppointment: {
    appointmentId: APPOINTMENT_ID,
    providerName: "Dr. Priya Lee",
    specialty: "dermatology",
    startUtc: START,
    startLocal: START_LOCAL,
  } satisfies In<"UpcomingAppointment">,
  SessionResponse: {
    patient: { firstName: "Maria" },
    greeting:
      "Hi Maria! I see you're booked with Dr. Priya Lee on Tuesday, October 13 at 2:30 PM ET. How can I help today?",
    upcomingAppointment: {
      appointmentId: APPOINTMENT_ID,
      providerName: "Dr. Priya Lee",
      specialty: "dermatology",
      startUtc: START,
      startLocal: START_LOCAL,
    },
    conversationId: null,
    messages: [],
  } satisfies In<"SessionResponse">,
  ApiError: { error: { code: "UNAUTHORIZED", message: "Please sign in again." } } satisfies In<"ApiError">,
} as const;
