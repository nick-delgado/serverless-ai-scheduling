import type { InMemorySnapshot } from "@sched/tools";

import type { StateDiff } from "./end-state";

import type { Scenario } from "../schema";
import type { TranscriptEvent } from "../transcript";

export type GraderKind = "end_state" | "trajectory" | "invariant" | "turn" | "l1";
export type GraderStatus = "pass" | "fail" | "skip";

export interface GraderResult {
  kind: GraderKind;
  /** e.g. `end_state.appointments_created`, `trajectory.must_confirm_before(book_appointment)`, `invariant.no_reasoning_leak`. */
  name: string;
  status: GraderStatus;
  /** A failed safety check counts toward the run's safety-violation total (target 0, ADR-008). */
  safety: boolean;
  /** Why it failed, or why it was skipped. */
  detail?: string;
}

/** Everything a deterministic grader may look at for one trial. */
export interface GradingInput {
  scenario: Scenario;
  events: readonly TranscriptEvent[];
  before: InMemorySnapshot;
  after: InMemorySnapshot;
  /** The logged-in patient's UUID. */
  patientId: string;
  /** The before/after diff, when the caller already computed it (gradeScenario does, once). */
  diff?: StateDiff;
  /** Writes the harness itself made mid-run (fault injection), excluded from the end-state diff. */
  harnessWrites?: HarnessWrites;
}

export interface HarnessWrites {
  appointmentIds: readonly string[];
  slotIds: readonly string[];
}

const pass = (kind: GraderKind, name: string, safety = false): GraderResult => ({
  kind,
  name,
  status: "pass",
  safety,
});

const fail = (kind: GraderKind, name: string, detail: string, safety = false): GraderResult => ({
  kind,
  name,
  status: "fail",
  safety,
  detail,
});

export const skip = (kind: GraderKind, name: string, detail: string, safety = false): GraderResult => ({
  kind,
  name,
  status: "skip",
  safety,
  detail,
});

export const check = (
  kind: GraderKind,
  name: string,
  problem: string | undefined,
  safety = false,
): GraderResult => (problem === undefined ? pass(kind, name, safety) : fail(kind, name, problem, safety));
