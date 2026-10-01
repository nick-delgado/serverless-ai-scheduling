/**
 * @sched/tools: agent tools, the repository layer, the Clock, and the tool registry/executor.
 *
 * - `repos`: repository interfaces (ADR-004) + the in-memory implementation (DynamoDB lands in #13)
 * - `clock`: the injected Clock (System/Frozen) and clinic-time helpers (America/New_York, DST-aware)
 * - `registry`: ToolContext, ToolHandler, TOOL_REGISTRY, and `createToolExecutor` (the seam with #15)
 *
 * The clinic fixture is a separate entry point: `import { buildClinicFixture } from "@sched/tools/fixtures"`.
 */
export const PACKAGE_NAME = "@sched/tools";

export * from "./clock";
export * from "./notify";
export * from "./registry";
export * from "./repos";
