/**
 * Agent tool contracts: the model-facing input schemas (snake_case, strict) and the output shapes the
 * handlers return. `toolDefinitionsForModel()` turns them into provider-neutral tool definitions; the
 * LLM adapter maps them to its wire shape (Converse `toolSpec`, ADR-010).
 *
 * Security invariant (CLAUDE.md rule 1, ADR-005): no input schema has a patient identifier. The
 * handler receives the patient from the verified JWT via its ToolContext. Inputs are strict objects,
 * so an extra `patient_id` from the model is rejected at runtime too. tools.test.ts enforces both.
 */
import { z } from "zod";

import { CLINIC, LIMITS, Specialty } from "./clinic";
import { EscalationReason } from "./domain";
import { AppointmentId, EscalationId, ProviderId, SlotId } from "./ids";
import { IsoDate, IsoDateTimeUtc } from "./primitives";

export const TOOL_NAMES = [
  "find_providers",
  "check_availability",
  "get_my_appointments",
  "get_patient_profile",
  "book_appointment",
  "reschedule_appointment",
  "escalate_to_human",
] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;

// ---------------------------------------------------------------------------------------------
// Shared output shapes (model-facing, snake_case)
// ---------------------------------------------------------------------------------------------

/** Human-readable local time the model should quote verbatim, e.g. "Tuesday, October 13, 2026 at 2:30 PM ET". */
const LocalTimeText = z.string().min(1).max(80);

export const ProviderSummary = z.strictObject({
  provider_id: ProviderId,
  display_name: z.string().min(1).max(80),
  specialty: Specialty,
  accepting_new_patients: z.boolean(),
});
export type ProviderSummary = z.infer<typeof ProviderSummary>;

export const SlotOption = z.strictObject({
  slot_id: SlotId,
  provider_id: ProviderId,
  provider_name: z.string().min(1).max(80),
  specialty: Specialty,
  start_utc: IsoDateTimeUtc,
  start_local: LocalTimeText,
});
export type SlotOption = z.infer<typeof SlotOption>;

export const AppointmentSummary = z.strictObject({
  appointment_id: AppointmentId,
  provider_id: ProviderId,
  provider_name: z.string().min(1).max(80),
  specialty: Specialty,
  start_utc: IsoDateTimeUtc,
  start_local: LocalTimeText,
  status: z.enum(["BOOKED", "CANCELLED", "COMPLETED"]),
  reason: z.string().max(LIMITS.reasonMaxChars),
});
export type AppointmentSummary = z.infer<typeof AppointmentSummary>;

export const ToolErrorCode = z.enum([
  "INVALID_INPUT",
  "NOT_FOUND",
  "SLOT_UNAVAILABLE",
  "NOT_ALLOWED",
  "INTERNAL",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

/** Body of an `is_error: true` tool_result. `hint` tells the model what to do next. */
export const ToolError = z.strictObject({
  error: z.strictObject({
    code: ToolErrorCode,
    message: z.string().min(1).max(300),
    hint: z.string().max(300).optional(),
  }),
});
export type ToolError = z.infer<typeof ToolError>;

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export const DateRange = z
  .strictObject({
    start_date: IsoDate.describe("First day to search, YYYY-MM-DD in the clinic's timezone (ET)."),
    end_date: IsoDate.describe("Last day to search (inclusive), YYYY-MM-DD in the clinic's timezone (ET)."),
  })
  .refine((r) => r.end_date >= r.start_date, {
    message: "end_date must be on or after start_date",
    path: ["end_date"],
  })
  .refine(
    (r) =>
      (Date.parse(`${r.end_date}T00:00:00Z`) - Date.parse(`${r.start_date}T00:00:00Z`)) / DAY_MS <
      LIMITS.availabilityMaxRangeDays,
    { message: `date_range can span at most ${LIMITS.availabilityMaxRangeDays} days`, path: ["end_date"] },
  );

export const FindProvidersInput = z.strictObject({
  specialty: Specialty.optional().describe("Only return providers in this specialty."),
  name_query: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("Part of a provider's name as the patient said it, e.g. 'Lee' or 'Dr. Okafor'."),
});

export const CheckAvailabilityInput = z.strictObject({
  provider_id: ProviderId.optional().describe("Only this provider (an id from find_providers)."),
  specialty: Specialty.optional().describe("Only providers in this specialty."),
  date_range: DateRange.describe("Days to search, in the clinic's timezone (ET)."),
  time_of_day: z
    .enum(["morning", "afternoon", "any"])
    .default("any")
    .describe("morning = before 12:00 PM ET, afternoon = 12:00 PM ET or later."),
});

export const GetMyAppointmentsInput = z.strictObject({
  include_past: z.boolean().default(false).describe("Also include past appointments."),
});

export const GetPatientProfileInput = z.strictObject({});

export const BookAppointmentInput = z.strictObject({
  slot_id: SlotId.describe("A slot_id returned by check_availability in this conversation."),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.reasonMaxChars)
    .describe("Short reason for the visit, in the patient's words."),
});

export const RescheduleAppointmentInput = z.strictObject({
  appointment_id: AppointmentId.describe("The appointment to move (an id from get_my_appointments)."),
  new_slot_id: SlotId.describe("The new slot (a slot_id from check_availability)."),
});

export const EscalateToHumanInput = z.strictObject({
  reason: EscalationReason.describe("Why the conversation is being handed to staff."),
  summary: z
    .string()
    .trim()
    .min(LIMITS.escalationSummaryMinChars)
    .max(LIMITS.escalationSummaryMaxChars)
    .describe(
      "Two or three sentences for the front desk: what the patient needs and what was already tried.",
    ),
});

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

export const FindProvidersOutput = z.strictObject({
  providers: z.array(ProviderSummary).max(LIMITS.providersMaxResults),
});

export const CheckAvailabilityOutput = z.strictObject({
  slots: z.array(SlotOption).max(LIMITS.availabilityMaxSlots),
  /** True when more slots matched than were returned; the model should narrow the search or offer these. */
  truncated: z.boolean(),
});

export const GetMyAppointmentsOutput = z.strictObject({
  appointments: z.array(AppointmentSummary),
});

export const GetPatientProfileOutput = z.strictObject({
  first_name: z.string().min(1).max(60),
  last_name: z.string().min(1).max(60),
  preferred_provider: ProviderSummary.nullable(),
});

export const BookAppointmentOutput = z.strictObject({
  appointment: AppointmentSummary,
  /** True when the patient already held this slot (idempotent retry); nothing new was booked. */
  already_booked: z.boolean(),
});

export const RescheduleAppointmentOutput = z.strictObject({
  appointment: AppointmentSummary,
  /** The time before the move; null when nothing moved (`already_rescheduled`). */
  previous_start_local: LocalTimeText.nullable(),
  /** True when the appointment was already at the requested slot (an idempotent retry); nothing changed. */
  already_rescheduled: z.boolean(),
});

export const EscalateToHumanOutput = z.strictObject({
  escalation_id: EscalationId,
  phone: z.literal(CLINIC.phone),
  hours: z.literal(CLINIC.hours),
  /** True when this conversation was already escalated; no second email was sent. */
  already_escalated: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

export interface ToolContract<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: ToolName;
  /** Model-facing description: when to use it, what it returns, and the rules around it. */
  description: string;
  input: I;
  output: O;
}

export const TOOLS = {
  find_providers: {
    name: "find_providers",
    description:
      'List Cedar Ridge Health providers, optionally filtered by specialty or by part of a name. Use it to resolve a provider the patient mentions ("Dr. Lee") into a provider_id, or to show who practices a specialty.',
    input: FindProvidersInput,
    output: FindProvidersOutput,
  },
  check_availability: {
    name: "check_availability",
    description: `Find open ${CLINIC.visitMinutes}-minute appointment slots by provider or specialty, within a date range (at most ${LIMITS.availabilityMaxRangeDays} days), optionally only mornings or afternoons. Returns up to ${LIMITS.availabilityMaxSlots} slots in time order, each with a slot_id and a start_local time to quote verbatim. Only offer slots returned by this tool, and only book slot_ids it returned.`,
    input: CheckAvailabilityInput,
    output: CheckAvailabilityOutput,
  },
  get_my_appointments: {
    name: "get_my_appointments",
    description:
      "List the logged-in patient's own appointments, upcoming only unless include_past is true. Use it to answer questions about their bookings (\"When is my next appointment?\") and to get the appointment_id before rescheduling. Check each status: only BOOKED appointments will take place, so never present a CANCELLED or COMPLETED one as an upcoming visit. Quote start_local verbatim. The patient's identity is applied automatically; never ask for or pass a patient ID.",
    input: GetMyAppointmentsInput,
    output: GetMyAppointmentsOutput,
  },
  get_patient_profile: {
    name: "get_patient_profile",
    description:
      "Get the logged-in patient's first and last name and their preferred provider, to greet them by name or to resolve \"my usual doctor\". preferred_provider is null when they have none. The patient's identity is applied automatically; never ask for or pass a patient ID.",
    input: GetPatientProfileInput,
    output: GetPatientProfileOutput,
  },
  book_appointment: {
    name: "book_appointment",
    description:
      "Book an open slot for the logged-in patient. Call it only after the patient has explicitly confirmed the provider, date, time, and reason. slot_id must come from check_availability in this conversation. On success it returns the appointment: confirm it by quoting start_local verbatim. already_booked: true means the patient already held this slot (for example, after a retry); confirm it rather than booking again. SLOT_UNAVAILABLE means the slot was just taken, so offer other times. NOT_ALLOWED means the time has already started, or the provider isn't taking new patients; follow its hint.",
    input: BookAppointmentInput,
    output: BookAppointmentOutput,
  },
  reschedule_appointment: {
    name: "reschedule_appointment",
    description:
      "Move one of the logged-in patient's existing appointments to a different open slot, in one atomic step (the old time is released only if the new one is booked). Call it only after the patient has explicitly confirmed the change. appointment_id must come from get_my_appointments and new_slot_id from check_availability; the new slot must be in the same specialty. On success it returns the moved appointment: quote start_local (the new time) and previous_start_local verbatim. SLOT_UNAVAILABLE means the new time was just taken and the original appointment is kept, so offer other times. NOT_ALLOWED means the appointment is cancelled, completed or already started, the new time has passed or is a different specialty, or the provider isn't taking new patients; follow its hint. already_rescheduled: true means the appointment was already at that time (for example, after a retry) and nothing changed; previous_start_local is then null, so confirm the time instead of moving it again.",
    input: RescheduleAppointmentInput,
    output: RescheduleAppointmentOutput,
  },
  escalate_to_human: {
    name: "escalate_to_human",
    description:
      "Hand the conversation to front-desk staff: records the escalation and notifies staff with your summary and the transcript. Use it when the patient asks for a person, after two failed attempts, when the patient is frustrated, or for out-of-scope requests. Use it at most once per conversation, then give the patient the phone number and hours it returns.",
    input: EscalateToHumanInput,
    output: EscalateToHumanOutput,
  },
} as const satisfies Record<ToolName, ToolContract>;

export type ToolInput<N extends ToolName> = z.infer<(typeof TOOLS)[N]["input"]>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOLS)[N]["output"]>;

/**
 * A provider-neutral tool definition (contracts v1.1). The Converse adapter sends it as
 * `{ toolSpec: { name, description, inputSchema: { json: inputSchema } } }`.
 */
export interface ModelToolDefinition {
  name: ToolName;
  description: string;
  /** JSON Schema (draft 2020-12 subset) of the tool input, without `$schema`. */
  inputSchema: { type: "object"; [key: string]: unknown };
}

/** JSON Schema for a tool input as the model should see it (input view: defaulted fields are optional). */
export function toolInputJsonSchema(name: ToolName): ModelToolDefinition["inputSchema"] {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(TOOLS[name].input, { io: "input" }) as Record<
    string,
    unknown
  >;
  if (schema.type !== "object") throw new Error(`Tool ${name} input must be an object schema`);
  return schema as ModelToolDefinition["inputSchema"];
}

/** Every tool definition, in a stable order (stable bytes keep the prompt cache warm). */
export function toolDefinitionsForModel(): ModelToolDefinition[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: toolInputJsonSchema(name),
  }));
}
