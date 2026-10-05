/**
 * Reading one judge reply (#32, r1/A-8). A reply is valid when it holds one JSON object that matches
 * `JudgeReply` (Zod), scores exactly the dimensions asked for, and every evidence quote appears in the
 * rendered transcript, comparing with whitespace collapsed. Anything else is a list of problems, which
 * the one retry shows to the model.
 */
import { z } from "zod";

import { issueText } from "../util";
import type { RubricDimension } from "./rubrics";

export const DimensionScore = z.object({
  dimension: z.string().min(1),
  score: z.int().min(1).max(5),
  evidence: z.array(z.string().trim().min(1)).min(1),
  reason: z.string(),
});
export type DimensionScore = z.infer<typeof DimensionScore> & { dimension: RubricDimension };

export const JudgeReply = z.object({ scores: z.array(DimensionScore) });

export type ParsedJudgeReply = { ok: true; scores: DimensionScore[] } | { ok: false; problems: string[] };

/** Collapse runs of whitespace, so a quote that re-wraps a line still matches. */
export const normalizeWhitespace = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** The JSON object in a reply: the reply itself, or the text between its first `{` and last `}` (code fences, preamble). */
function jsonObjectOf(text: string): unknown {
  // Without a `{` before a `}`, the slice is empty or a lone `}`, and JSON.parse throws.
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

/** Parse and check one reply against the dimensions asked for and the transcript the judge saw. */
export function parseJudgeReply(
  text: string,
  dimensions: readonly RubricDimension[],
  transcript: string,
): ParsedJudgeReply {
  let raw: unknown;
  try {
    raw = jsonObjectOf(text);
  } catch {
    return { ok: false, problems: ["it is not one JSON object"] };
  }
  const parsed = JudgeReply.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues.map(issueText),
    };

  const haystack = normalizeWhitespace(transcript);
  // Narrows the reply's string to the asked-for dimension it names, so the scores need no cast.
  const asked = (d: string): d is RubricDimension => (dimensions as readonly string[]).includes(d);
  const problems: string[] = [];
  const scores: DimensionScore[] = [];
  const seen = new Set<string>();
  for (const s of parsed.data.scores) {
    const { dimension } = s;
    if (!asked(dimension)) problems.push(`"${dimension}" was not asked for`);
    else if (seen.has(dimension)) problems.push(`${dimension} is scored twice`);
    else scores.push({ ...s, dimension });
    seen.add(dimension);
    for (const quote of s.evidence)
      if (!haystack.includes(normalizeWhitespace(quote)))
        problems.push(`${dimension}: the quote "${quote.slice(0, 80)}" is not in the transcript`);
  }
  for (const d of dimensions) if (!seen.has(d)) problems.push(`${d} is missing`);
  return problems.length === 0 ? { ok: true, scores } : { ok: false, problems };
}
