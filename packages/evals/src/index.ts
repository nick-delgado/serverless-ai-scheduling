/**
 * @sched/evals: the evaluation harness (ADR-008). S7-01 (#30) provides the core:
 * - `schema` / `loader`: Zod scenario schema and a loader that validates every file under `scenarios/`;
 * - `environment` / `runner`: an isolated in-memory world per trial and the multi-turn runner over the
 *   real `runAgentTurn`, with a `PatientSimulator` seam for #31;
 * - `graders`: deterministic end-state, trajectory, and invariant graders;
 * - `l1`: single-turn next-action cases;
 * - `suite` / `cli`: suites, metrics, JSON + markdown results (`npm run evals`);
 * - `results-copy`: the second copy of each run's results, outside every checkout (#195);
 * - `rate-limit`: the shared per-model token bucket with 429 backoff every live call goes through;
 * - `judge`: the LLM judge's rubrics, grader results and calibration (#32).
 * Reports and baselines (#34) plug in on top.
 */
export const PACKAGE_NAME = "@sched/evals";

export * from "./cli-args";
export * from "./environment";
export * from "./graders";
export * from "./judge";
export * from "./l1";
export * from "./loader";
export * from "./rate-limit";
export * from "./results-copy";
export * from "./runner";
export * from "./schema";
export * from "./simulator";
export * from "./suite";
export * from "./system-prompt";
export * from "./transcript";
export * from "./util";
