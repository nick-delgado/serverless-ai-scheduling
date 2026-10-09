/**
 * The report's markdown beyond the run line and the case table (#34): the conversation metrics, the run's
 * half of the PRD §7 exit metrics, and the per-scenario drill-down (r1/A-10; no HTML).
 */
import type { TrialResult } from "../runner";
import type { CaseResult, RunReport } from "../suite";
import { agentCostUsd, emergencyMet, exitHalf, pct, type ConversationMetrics } from "./metrics";

const usd = (x: number) => `$${x.toFixed(4)}`;
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The conversation line of a scenario run (r1/Q-5, r1/A-10). */
export function conversationLine(m: ConversationMetrics): string {
  const turns =
    m.turns === undefined
      ? "turns n/a"
      : `turns per conversation mean ${m.turns.mean.toFixed(1)}, p95 ${m.turns.p95}`;
  const cost =
    m.agentCostPerCompletedUsd === undefined
      ? "agent cost per completed conversation n/a"
      : `agent cost per completed conversation ${usd(m.agentCostPerCompletedUsd)}`;
  return `- Conversations: ${m.completed} of ${m.trials} completed (\`goal_achieved\` or \`escalated\`) · ${turns} · ${cost} (agent share ${usd(m.agentCostUsd)} over every trial)`;
}

/** The run's own half of the §7 exit metrics, as markdown lines (r1/Q-4 (a)). */
export function exitHalfLines(report: RunReport): string[] {
  const h = exitHalf(report.mode, report.trialsPerCase, report.cases, report.summary.safetyViolations);
  const emergency = `- Emergency cases (tagged \`emergency\`): ${h.emergency.passedEvery.length}/${h.emergency.ids.length} passed every trial${emergencyMet(h) ? "" : " (not met)"}`;
  if (report.mode !== "scenario") return [emergency];
  const categories = h.byCategory
    .map((c) => `${c.category} ${c.taskSuccess === undefined ? "n/a" : pct(c.taskSuccess)}`)
    .join(", ");
  return [
    `- Core categories: task success ${h.taskSuccess === undefined ? "n/a" : pct(h.taskSuccess)} (${categories}) · reliability ${h.reliability === undefined ? "n/a" : pct(h.reliability)} (all ${report.trialsPerCase} trial(s) passing)`,
    emergency,
  ];
}

const judgeScores = (t: TrialResult): string =>
  t.graders
    .filter((g) => g.kind === "judge" && g.score !== undefined)
    .map((g) => `${g.name.replace(/^judge\./, "")} ${String(g.score)}`)
    .join(", ");

/** One trial's failed checks, as the case table shows them. */
type FailedChecks = (t: CaseResult["trials"][number]) => string[];

/** The per-scenario drill-down: a section per case, a row per trial (r1/A-10). Scenario reports only. */
export function drillDown(report: RunReport, failedChecks: FailedChecks): string[] {
  if (report.mode !== "scenario") return [];
  const lines = ["", "## Per-scenario drill-down"];
  for (const c of report.cases) {
    lines.push(
      "",
      `### ${c.id} (${c.category}, ${c.status})`,
      "",
      "| Trial | Status | Stopped because | Turns | Agent cost | Failed checks | Judge scores |",
      "|---|---|---|---|---|---|---|",
    );
    for (const t of c.trials) {
      if (t.kind !== "scenario") continue;
      lines.push(
        `| ${t.trial} | ${t.status} | ${t.stoppedBecause ?? "–"} | ${t.turns} | ${usd(agentCostUsd(t))} | ${cell(failedChecks(t).join("; "))} | ${judgeScores(t)} |`,
      );
    }
    if (c.reason !== undefined) lines.push("", `${c.reason}`);
  }
  return lines;
}
