/**
 * Reads YAML as text, for the tests that check a SAM template or a GitHub workflow file as committed (#157): a block by
 * its header, the list items under a block, a block's direct entries and children, a block scalar's body, and a body
 * with comments dropped. No YAML parser: `yaml` would be a new root dependency and would need custom tags for `!Sub`
 * and `!GetAtt` (PR #152's review). A case this file lacks is added here, with a test in yaml-text.test.ts, not to a
 * new slicer in a test file (`sam-deploy` skill, rule 9).
 *
 * Every function takes lines (`text.split("\n")`). The rules follow YAML where it matters to the tests (r1/Q-2 (b) on
 * #157):
 *   - A comment line (`#` first, outside a block scalar) never ends a block or an item. Lines inside a block scalar
 *     (`run: |`, `FunctionCode: |`) are body text whatever they start with.
 *   - A block is its header line and every line after it up to the first line that isn't blank, isn't a comment and is
 *     indented no deeper than the header. A list item runs from its `- ` line to the next `- ` line at its indent.
 *     Either way, the comment and blank lines directly before the end are left out, because they introduce what
 *     follows; at the end of the input, trailing comment and blank lines are left out too.
 *   - A header matches only a line that isn't a comment or block-scalar text, and must match exactly one line of the
 *     searched lines (r1/A-2): a miss and a repeated header both throw. To look up a repeated header, narrow the search
 *     to an enclosing block first.
 */

/** A line's indent, in spaces. */
export const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A list item's dash at the start of a line: `- `, or a bare `-`. Group 1 is the indent. */
const DASH = /^(\s*)-(?:\s|$)/;
/** A block scalar's indicator, as a key's whole value (`|`, `|-`, `>+`, `|2`). */
const SCALAR_INDICATOR = /^[|>][-+1-9]*$/;
/** A `key: value` line once its dashes are gone: group 1 the key, group 2 the rest. */
const ENTRY = /^\s*([^:\s#][^\s]*?|"[^"]*"|'[^']*'):(?:\s+(.*))?$/;

/** A double- or single-quoted scalar without its quotes; anything else as it is. */
const unquote = (s: string): string =>
  /^"(.*)"$|^'(.*)'$/
    .exec(s)
    ?.slice(1)
    .find((g) => g !== undefined) ?? s;

/**
 * A line's `key: value` pair, past any leading `- `: the key unquoted, and the value without a trailing ` # comment`
 * and unquoted ("" when the key has no inline value, a `key: # comment` included). Undefined when it isn't a pair.
 */
function pairOf(line: string): [string, string] | undefined {
  const match = ENTRY.exec(line.replace(/^\s*(?:-\s+)*/, ""));
  if (match?.[1] === undefined) return undefined;
  const raw = (match[2] ?? "").trim();
  const value = /^["']/.test(raw) ? raw.replace(/(["'])\s+#.*$/, "$1") : raw.replace(/(?:^|\s+)#.*$/, "");
  return [unquote(match[1]), unquote(value)];
}

/** Whether a line's value is a block scalar's indicator (`key: |`, `- run: >-`). */
const isScalarKey = (line: string): boolean => SCALAR_INDICATOR.test(pairOf(line)?.[1] ?? "");

/** The column of a line's key, past any leading `- `: a block scalar's body is indented deeper than this. */
const keyColumn = (line: string): number => line.length - line.replace(/^\s*(?:-\s+)*/, "").length;

/** For each line, whether it is block-scalar body text (blank lines inside the body included). */
function scalarBody(lines: string[]): boolean[] {
  const body: boolean[] = [];
  let scalarKey: number | undefined;
  for (const line of lines) {
    if (scalarKey !== undefined && (line.trim() === "" || indentOf(line) > scalarKey)) {
      body.push(true);
      continue;
    }
    scalarKey = undefined;
    body.push(false);
    if (!line.trimStart().startsWith("#") && isScalarKey(line)) scalarKey = keyColumn(line);
  }
  return body;
}

/** For each line, whether YAML reads it as structure: not blank, not a comment, not block-scalar text. */
function structural(lines: string[]): boolean[] {
  const body = scalarBody(lines);
  return lines.map((line, i) => !body[i] && line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/** The lines YAML reads as structure: no blank or comment line, and no block-scalar text. */
export const structuralLines = (lines: string[]): string[] => {
  const isStructural = structural(lines);
  return lines.filter((_, i) => isStructural[i]);
};

/** `lines` without the blank and comment lines at its end (block-scalar text stays). */
function trimTail(lines: string[]): string[] {
  const body = scalarBody(lines);
  let end = lines.length;
  while (end > 1) {
    const line = lines[end - 1] ?? "";
    if (line.trim() !== "" && (body[end - 1] || !line.trimStart().startsWith("#"))) break;
    end--;
  }
  return lines.slice(0, end);
}

/** A whole file as one block with an empty header, so `entries`, `member`, `children` and `childBlocks` read its top level. */
export const root = (lines: string[]): string[] => ["", ...lines];

/**
 * The block whose header is the one line of `within` that matches `header`: the header and every line after it up to
 * the first structural line indented no deeper, without the comment and blank lines just before that line.
 * Throws when no line, or more than one, matches.
 */
export function block(header: RegExp, within: string[]): string[] {
  const isStructural = structural(within);
  const matches = within.flatMap((line, i) => (isStructural[i] && header.test(line) ? [i] : []));
  if (matches.length === 0) throw new Error(`no line matches ${String(header)}`);
  if (matches.length > 1) {
    const at = matches.map((i) => i + 1).join(", ");
    throw new Error(`${matches.length} lines match ${String(header)} (lines ${at}); narrow the search first`);
  }
  const start = matches[0] ?? 0;
  const indent = indentOf(within[start] ?? "");
  const end = within.findIndex((line, i) => i > start && isStructural[i] && indentOf(line) <= indent);
  return trimTail(within.slice(start, end === -1 ? undefined : end));
}

/**
 * Splits the lines after a block's header at each structural line indented `at`, for which `starts` holds: each part
 * runs to the next such line, without the comment and blank lines just before it.
 */
function split(lines: string[], from: number, at: number, starts: (line: string) => boolean): string[][] {
  const isStructural = structural(lines);
  const heads = lines.flatMap((line, i) =>
    i >= from && isStructural[i] && indentOf(line) === at && starts(line) ? [i] : [],
  );
  return heads.map((head, k) => trimTail(lines.slice(head, heads[k + 1])));
}

/** The index of the first structural line after a block's header, or -1. */
const firstChild = (lines: string[]): number => structural(lines).findIndex((s, i) => i > 0 && s);

/**
 * The list items directly under a block's header line, each whole whatever its first key (`- name:` or `- uses:`):
 * from its `- ` line to the next `- ` line at its indent, without the comment and blank lines just before that line.
 * Throws when the header's first child isn't a list item.
 */
export function items(lines: string[]): string[][] {
  const first = firstChild(lines);
  const firstLine = lines[first] ?? "";
  if (first === -1 || !DASH.test(firstLine))
    throw new Error(`no list items under ${JSON.stringify(lines[0] ?? "")}`);
  return split(lines, first, indentOf(firstLine), (line) => DASH.test(line));
}

/** Each direct child of a block's header (a key of a mapping, such as each job under `jobs:`) as its own block. */
export function childBlocks(lines: string[]): string[][] {
  const first = firstChild(lines);
  return first === -1 ? [] : split(lines, first, indentOf(lines[first] ?? ""), () => true);
}

/** The lines of a block's or an item's direct members: an item's first line counts, with its `- ` blanked. */
function members(lines: string[]): string[] {
  const [first = "", ...rest] = lines;
  return DASH.test(first) ? [first.replace(/^(\s*)-/, "$1 "), ...rest] : rest;
}

/** A block scalar's body lines, dedented to the least-indented one, as YAML reads it (clip: one final newline). */
function dedent(body: string[]): string {
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
  return body.map((l) => l.slice(indent)).join("\n") + "\n";
}

/** The direct members of a block or an item, each with its key, its inline value and its lines (the key's block). */
function direct(lines: string[]): { key: string; value: string; lines: string[] }[] {
  const own = members(lines);
  const isStructural = structural(own);
  const first = isStructural.findIndex(Boolean);
  if (first === -1) return [];
  const at = indentOf(own[first] ?? "");
  return split(["", ...own], first + 1, at, () => true).flatMap((part) => {
    const pair = pairOf(part[0] ?? "");
    return pair ? [{ key: pair[0], value: pair[1], lines: part }] : [];
  });
}

/**
 * The `key: value` entries directly under a block's header line, or directly in a list item (its first key included).
 * Keys and one-line values are unquoted, and a value loses a trailing ` # comment`; a block scalar's value is its body
 * (`scalar`'s text). A key whose value is a nested block (`key:` or `key: # comment`) has no entry.
 */
export function entries(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value, lines: own } of direct(lines)) {
    if (value === "") continue;
    out[key] = SCALAR_INDICATOR.test(value) ? scalar(own) : value;
  }
  return out;
}

/**
 * A direct member's value: undefined when the key is absent, a string for a one-line value, or the pairs of a mapping,
 * whether written as a flow map (`key: { a: b, c: d }`) or as a block under `key:`.
 */
export function member(lines: string[], key: string): string | Record<string, string> | undefined {
  const found = direct(lines).find((m) => m.key === key);
  if (found === undefined) return undefined;
  const flow = /^\{(.*)\}$/.exec(found.value);
  if (flow) {
    const pairs = (flow[1] ?? "").split(",").flatMap((p) => (p.trim() === "" ? [] : [pairOf(p.trim())]));
    return Object.fromEntries(pairs.filter((p) => p !== undefined));
  }
  return found.value === "" ? entries(found.lines) : found.value;
}

/** The structural lines directly under a block's header line (its children, not theirs). */
export function children(lines: string[]): string[] {
  const body = structuralLines(lines.slice(1));
  const childIndent = indentOf(body[0] ?? "");
  return body.filter((l) => indentOf(l) === childIndent);
}

/** The body of a block scalar whose header is `key: |` (the block from `block`), dedented as YAML reads it. */
export function scalar(lines: string[]): string {
  const [header = "", ...body] = lines;
  if (!isScalarKey(header)) throw new Error(`not a block scalar: ${JSON.stringify(header)}`);
  while (body.length > 0 && (body.at(-1) ?? "").trim() === "") body.pop();
  return dedent(body);
}

/**
 * The lines under a block's header, comment and blank lines dropped (a block scalar's `#` lines stay), each dedented
 * by the header's indent and trimmed at the end: compared exactly, any added line shows up.
 */
export function bodyLines(lines: string[]): string[] {
  const indent = indentOf(lines[0] ?? "");
  const body = scalarBody(lines);
  const kept = (line: string, i: number): boolean =>
    i > 0 && line.trim() !== "" && (body[i] === true || !line.trimStart().startsWith("#"));
  return lines.flatMap((line, i) => (kept(line, i) ? [line.slice(indent).trimEnd()] : []));
}

/** Lines back to text, ending in a newline, for `toContain` and `toMatch` checks. */
export const text = (lines: string[]): string => lines.join("\n") + "\n";

/** A GitHub workflow job's steps: the items of its `steps:`, each whole. */
export const stepsOf = (job: string[]): string[][] => items(block(/^\s+steps:$/, job));

/** The `uses:` of a GitHub workflow step that takes AWS credentials (any version). */
const CREDENTIALS_ACTION = "aws-actions/configure-aws-credentials@";

/** The structural lines that give the credentials action as a `uses:` value, in any step form, quoted or not. */
export const credentialsLines = (lines: string[]): string[] =>
  structuralLines(lines).filter((line) => {
    const pair = pairOf(line);
    return pair?.[0] === "uses" && pair[1].startsWith(CREDENTIALS_ACTION);
  });

/** Whether a workflow step (an item of `steps:`, in any form) is the AWS credentials step. */
export const isCredentialsStep = (step: string[]): boolean =>
  entries(step).uses?.startsWith(CREDENTIALS_ACTION) ?? false;

/**
 * A workflow job's credentials steps: how many of its lines give the action as a `uses:` value (`credentialsLines`), the
 * steps that take it (items of `steps:`, in either form), and the first one's `with:` entries (`{}` when there is
 * none). A test pins `lines` and `steps` to one each: the line count also catches a credentials `uses:` that isn't a
 * step's own key.
 */
export function credentialsOf(job: string[]): {
  lines: number;
  steps: string[][];
  settings: Record<string, string>;
} {
  const steps = stepsOf(job).filter(isCredentialsStep);
  const [first] = steps;
  return {
    lines: credentialsLines(job).length,
    steps,
    settings: first ? entries(block(/^\s+with:$/, first)) : {},
  };
}
