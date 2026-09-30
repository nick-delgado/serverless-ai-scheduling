/**
 * @sched/contracts: the integration seam every stream codes against (M1-02, #4).
 *
 * - `domain`: stored entities (camelCase, ADR-004)
 * - `content`: provider-neutral conversation content blocks (ADR-010)
 * - `tools`: model-facing tool inputs/outputs (snake_case) + `toolDefinitionsForModel()`
 * - `trace`: per-turn agent trace (ADR-001)
 * - `stream`: chat stream events + NDJSON helpers (ADR-007)
 * - `api`: HTTP request/response shapes for the SPA
 *
 * Changing a schema here is a cross-stream change; call it out in the PR (CLAUDE.md).
 * Valid examples for every schema: `@sched/contracts/testing`.
 */
export * from "./api";
export * from "./clinic";
export * from "./content";
export * from "./domain";
export * from "./ids";
export * from "./primitives";
export * from "./stream";
export * from "./tools";
export * from "./trace";

/** Contract version (v1.1: neutral content blocks, `text_reset`, trace refinements; ADR-010, #60). */
export const CONTRACTS_VERSION = "1.1";
