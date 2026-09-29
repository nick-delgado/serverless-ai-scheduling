/**
 * Seed datasets, by the name eval scenarios use (`fixture: clinic-default`, ADR-008).
 * `import { buildClinicFixture, FIXTURES } from "@sched/tools/fixtures"`.
 */
import { buildClinicFixture, CLINIC_DEFAULT_NAME } from "./clinic-default";

export * from "./clinic-default";

export const FIXTURES = {
  [CLINIC_DEFAULT_NAME]: buildClinicFixture,
} as const;
export type FixtureName = keyof typeof FIXTURES;
