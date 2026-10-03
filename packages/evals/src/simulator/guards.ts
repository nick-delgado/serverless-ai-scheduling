/**
 * Deterministic checks on every simulator reply before it reaches the agent (#31). The prompt asks the
 * model to stay in role; these make sure it did, so a simulator slip can't pose as an agent result:
 * - `verbatimLeaks`: the reply copies the goal or a hidden fact word for word;
 * - `agentVoice`: the reply speaks as the assistant, or carries tool-call syntax;
 * - `brokenCharacter`: the reply talks about the role-play itself.
 * A rejected reply is never sent; the simulator asks the model again, with the problems listed.
 */
import { LIMITS, TOOL_NAMES } from "@sched/contracts";

import type { Scenario } from "../schema";
import { factText } from "./prompt";

/** Consecutive words copied from the goal or a hidden fact that count as quoting it. */
export const VERBATIM_WINDOW_WORDS = 8;

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replaceAll(/[’‘]/g, "'")
    .split(/[^a-z0-9']+/)
    .map((w) => w.replaceAll(/^'+|'+$/g, ""))
    .filter(Boolean);

/**
 * Quoted lines inside a hidden fact are what the patient says (`says 'actually, can we do Thursday
 * instead?'`), so they're allowed verbatim and taken out before comparing. A quote opens after the
 * start, whitespace, `:` or `(`, and closes before whitespace, punctuation or the end, so an apostrophe
 * inside a word ("don't") doesn't open one.
 */
export const withoutQuotedLines = (text: string): string =>
  text
    .replaceAll(/(^|[\s:(])"[^"]*"(?=[\s.,;:!?)]|$)/g, "$1 … ")
    .replaceAll(/(^|[\s:(])'.*?'(?=[\s.,;:!?)]|$)/g, "$1 … ")
    .replaceAll(/(^|[\s:(])“[^”]*”/g, "$1 … ");

function windows(text: string, size: number): Set<string> {
  const out = new Set<string>();
  for (const part of text.split("…")) {
    const w = words(part);
    for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(" "));
  }
  return out;
}

/**
 * Problems if `reply` copies the goal or a hidden fact: a run of `VERBATIM_WINDOW_WORDS` consecutive
 * words (case and punctuation ignored, quoted lines excepted), or a fact's snake_case key.
 */
export function verbatimLeaks(reply: string, scenario: Pick<Scenario, "goal" | "hidden_facts">): string[] {
  const replyWords = words(reply);
  const replyWindows = new Set<string>();
  for (let i = 0; i + VERBATIM_WINDOW_WORDS <= replyWords.length; i++)
    replyWindows.add(replyWords.slice(i, i + VERBATIM_WINDOW_WORDS).join(" "));

  const sources: [string, string][] = [
    ["the goal", scenario.goal],
    ...Object.entries(scenario.hidden_facts ?? {}).map(([key, value]): [string, string] => [
      `hidden fact "${key}"`,
      withoutQuotedLines(factText(value)),
    ]),
  ];
  const problems: string[] = [];
  for (const [label, text] of sources)
    if ([...windows(text, VERBATIM_WINDOW_WORDS)].some((w) => replyWindows.has(w)))
      problems.push(`it copies ${label} word for word; say it in your own words`);
  for (const key of Object.keys(scenario.hidden_facts ?? {}))
    if (key.includes("_") && reply.toLowerCase().includes(key.toLowerCase()))
      problems.push(`it names the private fact "${key}"`);
  return problems;
}

const AGENT_LABEL =
  /^\s*(assistant|agent|ai|bot|scheduler|scheduling assistant|receptionist|system|staff)\s*:/im;
const TOOL_SYNTAX = new RegExp(
  [
    `\\b(${TOOL_NAMES.join("|")})\\b`,
    String.raw`<\/?(tool|function|invoke|tool_use|tool_call)\b`,
    String.raw`\{\s*"`,
  ].join("|"),
  "i",
);
/** Things only the scheduling side says. A patient asks to be booked; it doesn't say it booked anyone. */
const AGENT_PHRASES = [
  /\bhow (can|may) i (help|assist)( you)?\b/i,
  /\bis there anything else i can (help|do)\b/i,
  /\bi('ve| have) (booked|scheduled|rescheduled|moved|reserved) (you|your)\b/i,
  /\byou('re| are) (all )?(booked|scheduled|confirmed) (for|with|on)\b/i,
  /\b(shall|should) i (go ahead and )?(book|schedule|reschedule|confirm)\b/i,
  /\bwould you like me to (book|schedule|reschedule|check|look)\b/i,
  /\blet me (check|look up|pull up|search) (the |our )?(availability|schedule|calendar|openings)\b/i,
  /\bhere are (the |some )?(available|open) (times|slots|appointments)\b/i,
  /\bour (providers|doctors|clinic) (have|has) (the following )?(availability|openings)\b/i,
];

/** Problems if `reply` speaks as the assistant or the clinic, or carries tool-call syntax. */
export function agentVoice(reply: string): string[] {
  const problems: string[] = [];
  if (AGENT_LABEL.test(reply)) problems.push("it has an assistant or staff speaker label");
  if (TOOL_SYNTAX.test(reply)) problems.push("it contains tool-call syntax or a tool name");
  if (AGENT_PHRASES.some((p) => p.test(reply)))
    problems.push("it speaks as the assistant; you are the patient");
  return problems;
}

const META =
  /\b(role-?play(ing)?|simulat(ed|or|ion)|hidden facts?|private facts?|my persona|test scenario|stop marker)\b/i;

/** Problems if `reply` talks about the role-play itself. */
export const brokenCharacter = (reply: string): string[] =>
  META.test(reply) ? ["it talks about the role-play; stay in character"] : [];

/** Every problem with a patient message, in a stable order. Empty means it may be sent. */
export function replyProblems(reply: string, scenario: Pick<Scenario, "goal" | "hidden_facts">): string[] {
  const problems = [...agentVoice(reply), ...verbatimLeaks(reply, scenario), ...brokenCharacter(reply)];
  if (reply.length > LIMITS.chatTextMaxChars)
    problems.push(`it is longer than ${LIMITS.chatTextMaxChars} characters`);
  return problems;
}
