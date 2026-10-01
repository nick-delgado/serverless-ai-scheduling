/**
 * Zod schemas for eval scenarios (ADR-008): multi-turn scenarios (L2/L3) and single-turn L1 cases, as
 * written in `packages/evals/scenarios/**` (field reference: `scenarios/README.md`).
 *
 * Objects are strict, so a misspelled key fails loudly instead of silently disabling a check. Tool
 * names, error codes, ids, and escalation reasons come from `@sched/contracts`, so a contract rename
 * breaks the scenario load, not a live eval run.
 */
import {
  AppointmentId,
  ConversationId,
  EscalationReason,
  IsoDate,
  IsoDateTimeUtc,
  LIMITS,
  ProviderId,
  SlotId,
  Specialty,
  TOOLS,
  ToolError,
  ToolErrorCode,
  ToolName,
} from "@sched/contracts";
import { FIXTURE_PATIENT_IDS, FIXTURES, type FixturePatientAlias } from "@sched/tools/fixtures";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

const PATIENT_ALIASES = Object.keys(FIXTURE_PATIENT_IDS) as [FixturePatientAlias, ...FixturePatientAlias[]];
export const PatientAlias = z.enum(PATIENT_ALIASES);

const FIXTURE_NAMES = Object.keys(FIXTURES) as [keyof typeof FIXTURES, ...(keyof typeof FIXTURES)[]];
export const FixtureName = z.enum(FIXTURE_NAMES);

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;

/** `"HH:MM"`, 24-hour. */
export const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected "HH:MM" (24-hour)');

/** A count: an exact number, or `{ max: n }`. */
export const Count = z.union([z.int().nonnegative(), z.strictObject({ max: z.int().nonnegative() })]);
export type Count = z.infer<typeof Count>;

/** A regex source string that compiles. */
const RegexSource = z.string().refine(
  (source) => {
    try {
      new RegExp(source, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid regular expression" },
);

/**
 * Argument matcher (README "Argument matchers"): a plain value matches exactly; `{one_of: [...]}` any
 * listed value; `{contains_ci: "..."}` a case-insensitive substring; a nested map is a nested subset.
 */
export type ArgMatcher =
  | string
  | number
  | boolean
  | null
  | { one_of: unknown[] }
  | { contains_ci: string }
  | { [key: string]: ArgMatcher };
export const ArgMatcher: z.ZodType<ArgMatcher> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.strictObject({ one_of: z.array(z.unknown()).min(1) }),
    z.strictObject({ contains_ci: z.string().min(1) }),
    z.record(z.string(), ArgMatcher),
  ]),
);
export const ArgsSubset = z.record(z.string(), ArgMatcher);
export type ArgsSubset = z.infer<typeof ArgsSubset>;

export const WRITE_TOOLS = ["book_appointment", "reschedule_appointment"] as const satisfies ToolName[];
export const WriteTool = z.enum(WRITE_TOOLS);
export type WriteTool = z.infer<typeof WriteTool>;

/** `book_appointment` or `reschedule_appointment`: the tools that change the patient's schedule. */
export const isWriteTool = (name: string): name is WriteTool =>
  (WRITE_TOOLS as readonly string[]).includes(name);

// ---------------------------------------------------------------------------------------------
// Setup (fixture overrides, #33)
// ---------------------------------------------------------------------------------------------

export const SetupAppointment = z.strictObject({
  appointment_id: AppointmentId,
  patient: PatientAlias,
  /** Must be an OPEN fixture slot; the harness books it for `patient`. */
  slot_id: SlotId,
  reason: z.string().trim().min(1).max(LIMITS.reasonMaxChars),
});

export const FAULT_EFFECTS = ["slot_taken_by_other_patient"] as const;
export const SetupFault = z.strictObject({
  tool: ToolName,
  /** The 1-based call (counting calls that reach the handler, i.e. valid input) that fails, or every call. */
  call: z.union([z.int().positive(), z.literal("all")]),
  error: ToolErrorCode,
  /** `slot_taken_by_other_patient`: the requested slot really becomes BOOKED by another patient first. */
  effect: z.enum(FAULT_EFFECTS).optional(),
});
export type SetupFault = z.infer<typeof SetupFault>;

export const SetupConversation = z.strictObject({
  conversation_id: ConversationId,
  patient: PatientAlias,
  messages: z
    .array(z.strictObject({ role: z.enum(["patient", "assistant"]), text: z.string().min(1) }))
    .min(1),
});

export const Setup = z.strictObject({
  appointments: z.array(SetupAppointment).optional(),
  faults: z.array(SetupFault).optional(),
  conversations: z.array(SetupConversation).optional(),
});
export type Setup = z.infer<typeof Setup>;

// ---------------------------------------------------------------------------------------------
// Multi-turn expectations
// ---------------------------------------------------------------------------------------------

/** Matcher for a created or rescheduled appointment. Local fields are in the clinic's timezone. */
export const AppointmentMatcher = z.strictObject({
  appointment_id: AppointmentId.optional(),
  provider_id: ProviderId.optional(),
  provider_in: z.array(ProviderId).min(1).optional(),
  specialty: Specialty.optional(),
  specialty_in: z.array(Specialty).min(1).optional(),
  local_date: IsoDate.optional(),
  local_date_between: z.tuple([IsoDate, IsoDate]).optional(),
  weekday_in: z.array(Weekday).min(1).optional(),
  weekday_not_in: z.array(Weekday).min(1).optional(),
  local_time: HhMm.optional(),
  /** Start time ≥ this (local). */
  local_time_after: HhMm.optional(),
  /** Start time < this (local). */
  local_time_before: HhMm.optional(),
  /** Start time in UTC, `"HH:MM"` (DST checks). */
  start_utc_time: HhMm.optional(),
  reason_contains_any: z.array(z.string().min(1)).min(1).optional(),
  /** Must not be this slot. `first_failed_book`: the slot of the run's first failed `book_appointment`. */
  not_slot: z.union([SlotId, z.literal("first_failed_book")]).optional(),
});
export type AppointmentMatcher = z.infer<typeof AppointmentMatcher>;

export const EndState = z.strictObject({
  no_writes: z.literal(true).optional(),
  no_appointment_writes: z.literal(true).optional(),
  appointments_created: Count.optional(),
  appointments_rescheduled: Count.optional(),
  escalations_created: Count.optional(),
  emails_sent: Count.optional(),
  appointment: AppointmentMatcher.optional(),
  rescheduled: AppointmentMatcher.optional(),
  released_slots: z.array(SlotId).optional(),
  unchanged_appointments: z.array(AppointmentId).optional(),
  escalation: z.strictObject({ reason_in: z.array(EscalationReason).min(1) }).optional(),
  foreign_conversation: z
    .strictObject({ conversation_id: ConversationId, messages_appended: z.int().nonnegative() })
    .optional(),
});
export type EndState = z.infer<typeof EndState>;

const strings = z.array(z.string().min(1)).min(1);

/** Each trajectory rule is a one-key map (README "expect.trajectory rules"). */
export const TrajectoryRule = z.union([
  z.strictObject({
    must_call: z.union([ToolName, z.strictObject({ tool: ToolName, args_subset: ArgsSubset.optional() })]),
  }),
  z.strictObject({ must_call_before: z.tuple([ToolName, ToolName]) }),
  z.strictObject({ must_confirm_before: WriteTool }),
  z.strictObject({ must_ask_before: ToolName }),
  z.strictObject({ forbid_tools: z.array(ToolName).min(1) }),
  z.strictObject({ max_calls: z.partialRecord(ToolName, z.int().nonnegative()) }),
  z.strictObject({ max_questions_per_turn: z.int().positive() }),
  z.strictObject({
    respond_immediately: z.strictObject({
      /** 1-based index into `script`. */
      after_script_step: z.int().positive(),
      before_any_tool: z.boolean().default(true),
      contains_all: strings.optional(),
      contains_any: strings.optional(),
    }),
  }),
  z.strictObject({ response_contains_all: strings }),
  z.strictObject({ response_contains_any: strings }),
  z.strictObject({ final_response_contains_all: strings }),
  z.strictObject({ response_must_not_contain: strings }),
  z.strictObject({ response_must_match_none: z.array(RegexSource).min(1) }),
]);
export type TrajectoryRule = z.infer<typeof TrajectoryRule>;

/** Invariant names (README "expect.invariants"). Which are deterministic: `graders/invariants.ts`. */
export const INVARIANTS = [
  "no_cross_patient_data",
  "no_patient_id_in_tool_inputs",
  "conversation_owned_by_caller",
  "no_write_without_confirmation",
  "no_hallucinated_slots",
  "booked_slots_from_prior_availability",
  "times_in_clinic_tz_with_weekday",
  "max_five_options",
  "one_question_at_a_time",
  "emergency_guidance_first",
  "escalate_at_most_once",
  "ignores_injected_instructions",
  "no_reasoning_leak",
  "no_system_prompt_disclosure",
  "no_medical_advice",
  "no_invented_providers",
  "no_invented_policies",
  "no_false_claims_of_action",
  "no_claim_to_be_human",
] as const;
export const Invariant = z.enum(INVARIANTS);
export type Invariant = z.infer<typeof Invariant>;

/** LLM-judge dimensions (README "expect.judge"); scored by #32. */
export const JUDGE_DIMENSIONS = [
  "tone",
  "clarity",
  "no_medical_advice",
  "no_hallucinated_slots",
  "concrete_options",
  "summarizes_change",
  "apologizes_for_conflict",
  "accurate_provider_facts",
  "accurate_clinic_facts",
  "accurate_appointment_facts",
  "explicit_dates",
  "escalation_message_complete",
  "empathy",
  "urgency",
  "privacy_refusal_clear",
  "stays_in_scope",
  "offers_what_it_can_do",
  "offers_booking_instead",
  "treats_tool_output_as_data",
  "professionalism_under_abuse",
  "no_false_claims_of_action",
] as const;
export const JudgeDimension = z.enum(JUDGE_DIMENSIONS);

export const SCENARIO_CATEGORIES = [
  "book",
  "reschedule",
  "availability",
  "escalate",
  "clarify",
  "safety",
] as const;
export const ScenarioCategory = z.enum(SCENARIO_CATEGORIES);

const common = {
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a kebab-case id"),
  fixture: FixtureName,
  /** Frozen "now", UTC. */
  clock: IsoDateTimeUtc,
  /** The logged-in patient (the JWT stand-in); the harness binds the executor to their UUID. */
  patient: PatientAlias,
  tags: z.array(z.string().min(1)),
  covers: z.array(z.string().regex(/^(FR-\d{3}|NFR-\d{3}|adr\d+\.[a-z-]+)$/)).min(1),
  notes: z.string().optional(),
  setup: Setup.optional(),
};

export const Scenario = z
  .strictObject({
    ...common,
    category: ScenarioCategory,
    persona: z.string().min(1),
    goal: z.string().min(1),
    /** Simulator-only facts. `null` when the key is present but empty. */
    hidden_facts: z.record(z.string(), z.unknown()).nullish(),
    /** Patient messages sent verbatim as the first turns, before the simulator takes over. */
    script: z.array(z.string().min(1).max(LIMITS.chatTextMaxChars)).optional(),
    /** `api`: drive the chat handler (#17) instead of the loop. */
    surface: z.enum(["agent", "api"]).default("agent"),
    request: z.strictObject({ conversation_id: ConversationId.optional() }).optional(),
    /** Ids invented on purpose (never valid; graders check they're never booked). */
    fabricated_ids: z.array(z.string().min(1)).optional(),
    max_turns: z.int().positive(),
    expect: z.strictObject({
      end_state: EndState,
      trajectory: z.array(TrajectoryRule),
      invariants: z.array(Invariant),
      judge: z.array(JudgeDimension),
    }),
  })
  .superRefine((s, ctx) => {
    for (const [i, rule] of s.expect.trajectory.entries()) {
      if (
        "respond_immediately" in rule &&
        rule.respond_immediately.after_script_step > (s.script?.length ?? 0)
      )
        ctx.addIssue({
          code: "custom",
          path: ["expect", "trajectory", i],
          message: "respond_immediately.after_script_step points past the script",
        });
    }
    if (s.surface === "api" && s.request === undefined)
      ctx.addIssue({ code: "custom", path: ["request"], message: "surface: api needs a request" });
    if (s.script !== undefined && s.script.length > s.max_turns)
      ctx.addIssue({ code: "custom", path: ["script"], message: "script is longer than max_turns" });
  });
export type Scenario = z.infer<typeof Scenario>;

// ---------------------------------------------------------------------------------------------
// L1 cases
// ---------------------------------------------------------------------------------------------

const ToolErrorBody = ToolError.shape.error;

export const L1ContextItem = z.union([
  z.strictObject({ patient: z.string().min(1) }),
  z.strictObject({ assistant: z.string().min(1) }),
  z.strictObject({ tool_call: z.strictObject({ tool: ToolName, args: z.record(z.string(), z.unknown()) }) }),
  z.strictObject({
    tool_result: z.union([
      z.strictObject({ tool: ToolName, result: z.unknown() }),
      z.strictObject({ tool: ToolName, error: ToolErrorBody }),
    ]),
  }),
]);
export type L1ContextItem = z.infer<typeof L1ContextItem>;

export const L1Action = z.strictObject({
  action: z.enum(["tool_call", "respond"]),
  tool: ToolName.optional(),
  args_subset: ArgsSubset.optional(),
});
export type L1Action = z.infer<typeof L1Action>;

export const L1ResponseChecks = z.strictObject({
  contains_all: strings.optional(),
  contains_any: strings.optional(),
  must_not_contain: strings.optional(),
  must_match_none: z.array(RegexSource).min(1).optional(),
  max_questions: z.int().nonnegative().optional(),
});
export type L1ResponseChecks = z.infer<typeof L1ResponseChecks>;

export const L1Expect = z
  .strictObject({
    action: L1Action.shape.action.optional(),
    tool: ToolName.optional(),
    args_subset: ArgsSubset.optional(),
    any_of: z.array(L1Action).min(1).optional(),
    /** `all`: the next action must be text only. */
    forbid_tools: z.union([z.literal("all"), z.array(ToolName).min(1)]).optional(),
    /** Strings that must not appear anywhere in any tool argument. */
    forbid_arg_values: strings.optional(),
    response: L1ResponseChecks.optional(),
  })
  .refine((e) => (e.action === undefined) !== (e.any_of === undefined), {
    message: "Give exactly one of `action` or `any_of`",
  })
  .refine((e) => e.action === undefined || e.action === "respond" || e.tool !== undefined, {
    message: "action: tool_call needs a tool",
  });
export type L1Expect = z.infer<typeof L1Expect>;

export const L1Case = z
  .strictObject({
    ...common,
    category: z.literal("l1"),
    context: z.array(L1ContextItem).min(1),
    expect: L1Expect,
  })
  .superRefine((c, ctx) => {
    // Context tool traffic must be valid against the contracts, so the model sees realistic history.
    for (const [i, item] of c.context.entries()) {
      if ("tool_call" in item) {
        const parsed = TOOLS[item.tool_call.tool].input.safeParse(item.tool_call.args);
        if (!parsed.success)
          ctx.addIssue({ code: "custom", path: ["context", i], message: `args: ${parsed.error.message}` });
      } else if ("tool_result" in item && "result" in item.tool_result) {
        const parsed = TOOLS[item.tool_result.tool].output.safeParse(item.tool_result.result);
        if (!parsed.success)
          ctx.addIssue({ code: "custom", path: ["context", i], message: `result: ${parsed.error.message}` });
      }
    }
    for (const option of c.expect.any_of ?? [])
      if (option.action === "tool_call" && option.tool === undefined)
        ctx.addIssue({ code: "custom", path: ["expect", "any_of"], message: "tool_call needs a tool" });
    const last = c.context.at(-1);
    if (last !== undefined && ("assistant" in last || "tool_call" in last))
      ctx.addIssue({
        code: "custom",
        path: ["context"],
        message: "context must end with a patient message or a tool result (the model speaks next)",
      });
  });
export type L1Case = z.infer<typeof L1Case>;

/** Narrows a loaded case: L1 cases live in `l1/` and carry `category: l1`. */
export const isL1Case = (c: Scenario | L1Case): c is L1Case => c.category === "l1";
