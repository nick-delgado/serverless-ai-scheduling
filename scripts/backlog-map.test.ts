/**
 * docs/backlog.md keeps the dependency graph twice: as mermaid edges and as each table row's "Blocked by"
 * cell. They are edited by hand, so this checks they agree (#139, from the review of PR #124, SMELL-3):
 * every edge `X --> Y` has X's issue in Y's "Blocked by" cell, and every blocker a cell names has its edge
 * when both issues are in the graph.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const map = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "backlog.md"), "utf8");

/** Graph node id → issue number, from lines such as `M1_02["#4 M1-02<br/>..."]`. */
const issueOf = new Map(
  [...map.matchAll(/^\s*(\w+)\["#(\d+)\b/gm)].map(([, node = "", issue = ""]) => [node, issue]),
);

/** Graph edges as [blocker issue, blocked issue]. */
const edges = [...map.matchAll(/^\s*(\w+)\s*-->\s*(\w+)\s*$/gm)].map(([line, from = "", to = ""]) => {
  const blocker = issueOf.get(from);
  const blocked = issueOf.get(to);
  if (!blocker || !blocked)
    throw new Error(`docs/backlog.md: an edge names a node with no issue: ${line.trim()}`);
  return [blocker, blocked] as const;
});

/** Issue → the issues its table row's last cell ("Blocked by") names. */
const blockedBy = new Map(
  [...map.matchAll(/^\| \[#(\d+)\]\(.*\| ([^|]*) \|\s*$/gm)].map(([, issue = "", cell = ""]) => [
    issue,
    new Set(cell.match(/\d+/g) ?? []),
  ]),
);

describe("docs/backlog.md", () => {
  it("parses a graph and tables (a format change must update this test, not silence it)", () => {
    expect(issueOf.size).toBeGreaterThan(20);
    expect(edges.length).toBeGreaterThan(20);
    expect(blockedBy.size).toBeGreaterThan(20);
  });

  it.each(edges)("graph edge #%s --> #%s is in the blocked issue's table row", (from, to) => {
    expect([...(blockedBy.get(to) ?? [`(#${to} has no table row)`])]).toContain(from);
  });

  it("every blocker a table row names, when both issues are in the graph, has its edge", () => {
    const inGraph = new Set(issueOf.values());
    const edgeSet = new Set(edges.map(([from, to]) => `${from}->${to}`));
    const missing = [...blockedBy].flatMap(([to, froms]) =>
      inGraph.has(to)
        ? [...froms]
            .filter((from) => inGraph.has(from) && !edgeSet.has(`${from}->${to}`))
            .map((from) => `#${from} --> #${to}`)
        : [],
    );
    expect(missing).toEqual([]);
  });
});
