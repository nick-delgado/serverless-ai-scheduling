import { z } from "zod";

/** Calendar date in the clinic timezone, `YYYY-MM-DD`. Short pattern on purpose: tool schemas are sent to the model. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "Not a real calendar date");
export type IsoDate = z.infer<typeof IsoDate>;

/**
 * Wall-clock time, `HH:MM`, 24-hour, zero-padded (`09:30`, not `9:30`). No timezone: each field's own
 * description says ET or UTC. No `.describe()` here, so a field's JSON Schema keeps its own description
 * and no `$defs`. Don't loosen the pattern: `minutesOf` in `check_availability` reads exactly two-digit hours.
 */
export const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a time as HH:MM (24-hour)");
export type HhMm = z.infer<typeof HhMm>;

/** Instant in UTC, ISO-8601 with `Z` (no offsets). All stored timestamps use this. */
export const IsoDateTimeUtc = z.iso.datetime({ offset: false });
export type IsoDateTimeUtc = z.infer<typeof IsoDateTimeUtc>;

const count = z.int().nonnegative();

/** Token usage for one model call or a whole turn. */
export const TokenUsage = z.strictObject({
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
});
export type TokenUsage = z.infer<typeof TokenUsage>;
