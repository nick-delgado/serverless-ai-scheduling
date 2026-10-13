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

/** A key whose value is a block scalar (`key: |`, `key: >-`, `- run: |`), as a trimmed line. */
const BLOCK_SCALAR_KEY = /^(?:- +)*[^\s#][^#]*?:\s+[|>][-+1-9]*(?:\s+#.*)?$/;
/** A `key: value` line (the key's dash, if any, already removed). */
const ENTRY = /^\s*([^:\s#][^\s]*?):(?:\s+(.*))?$/;

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
    if (BLOCK_SCALAR_KEY.test(line.trim())) scalarKey = keyColumn(line);
  }
  return body;
}

/** The lines YAML reads as structure: not blank, not a comment, not block-scalar text. */
function structural(lines: string[]): boolean[] {
  const body = scalarBody(lines);
  return lines.map((line, i) => !body[i] && line.trim() !== "" && !line.trimStart().startsWith("#"));
}

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
 * The list items directly under a block's header line, each whole whatever its first key (`- name:` or `- uses:`):
 * from its `- ` line to the next `- ` line at its indent, without the comment and blank lines just before that line.
 * Throws when the header's first child isn't a list item.
 */
export function items(lines: string[]): string[][] {
  const isStructural = structural(lines);
  const first = isStructural.findIndex((s, i) => i > 0 && s);
  const firstLine = lines[first] ?? "";
  if (first === -1 || !/^\s*-(\s|$)/.test(firstLine)) {
    throw new Error(`no list items under ${JSON.stringify(lines[0] ?? "")}`);
  }
  const dash = indentOf(firstLine);
  const starts = lines.flatMap((line, i) =>
    i >= first && isStructural[i] && indentOf(line) === dash && /^\s*-(\s|$)/.test(line) ? [i] : [],
  );
  return starts.map((start, k) => trimTail(lines.slice(start, starts[k + 1])));
}

/** The lines of a block's or an item's direct members: an item's first line counts, with its `- ` blanked. */
function members(lines: string[]): string[] {
  const [first = "", ...rest] = lines;
  const dash = /^(\s*)- /.exec(first);
  return dash ? [first.replace(/^(\s*)- /, "$1  "), ...rest] : rest;
}

/** A block scalar's body lines, dedented to the least-indented one, as YAML reads it (clip: one final newline). */
function dedent(body: string[]): string {
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
  return body.map((l) => l.slice(indent)).join("\n") + "\n";
}

/**
 * The `key: value` entries directly under a block's header line, or directly in a list item (its first key included).
 * A one-line value is unquoted and loses a trailing ` # comment`; a block scalar's value is its body (`scalar`'s
 * text). A key whose value is a nested block has no entry.
 */
export function entries(lines: string[]): Record<string, string> {
  const own = members(lines);
  const body = scalarBody(own);
  const isStructural = structural(own);
  const childIndent = indentOf(own.find((_, i) => isStructural[i]) ?? "");
  const out: Record<string, string> = {};
  own.forEach((line, i) => {
    if (!isStructural[i] || indentOf(line) !== childIndent) return;
    const match = ENTRY.exec(line);
    const key = match?.[1];
    const value = match?.[2]?.trim();
    if (key === undefined || value === undefined || value === "") return;
    if (/^[|>][-+1-9]*(?:\s+#.*)?$/.test(value)) {
      const end = body.findIndex((b, j) => j > i && !b);
      const scalarLines = own.slice(i + 1, end === -1 ? undefined : end);
      while (scalarLines.length > 0 && (scalarLines.at(-1) ?? "").trim() === "") scalarLines.pop();
      out[key] = dedent(scalarLines);
      return;
    }
    const quoted = /^"(.*)"$|^'(.*)'$/.exec(value);
    out[key] = quoted ? (quoted[1] ?? quoted[2] ?? "") : value.replace(/\s+#.*$/, "");
  });
  return out;
}

/** The structural lines directly under a block's header line (its children, not theirs). */
export function children(lines: string[]): string[] {
  const isStructural = structural(lines);
  const body = lines.filter((_, i) => i > 0 && isStructural[i]);
  const childIndent = indentOf(body[0] ?? "");
  return body.filter((l) => indentOf(l) === childIndent);
}

/** The body of a block scalar whose header is `key: |` (the block from `block`), dedented as YAML reads it. */
export function scalar(lines: string[]): string {
  const [header = "", ...body] = lines;
  if (!BLOCK_SCALAR_KEY.test(header.trim())) throw new Error(`not a block scalar: ${JSON.stringify(header)}`);
  return dedent(body);
}

/**
 * The lines under a block's header, comment and blank lines dropped, each dedented by the header's indent and trimmed
 * at the end: compared exactly, any added line shows up.
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

/** The `uses:` of a GitHub workflow step that takes AWS credentials (any version). */
export const CREDENTIALS_ACTION = "aws-actions/configure-aws-credentials@";

/** A line that names the credentials action as a step's `uses:`, in either step form (`- uses:` or `uses:`). */
export const CREDENTIALS_USES = new RegExp(`^\\s+(- )?uses: ${CREDENTIALS_ACTION.replace(/[./]/g, "\\$&")}`);

/** Whether a workflow step (an item of `steps:`, in any form) is the AWS credentials step. */
export const isCredentialsStep = (step: string[]): boolean =>
  entries(step).uses?.startsWith(CREDENTIALS_ACTION) ?? false;

/**
 * A workflow job's credentials steps: how many of its lines name the action as a step's `uses:`, the steps that take
 * it (items of `steps:`, in either form), and the first one's `with:` entries (`{}` when there is none). A test pins
 * `lines` and `steps` to one each: the line count also catches a credentials `uses:` that isn't a step's own key.
 */
export function credentialsOf(job: string[]): {
  lines: number;
  steps: string[][];
  settings: Record<string, string>;
} {
  const steps = items(block(/^\s+steps:$/, job)).filter(isCredentialsStep);
  const [first] = steps;
  return {
    lines: job.filter((l) => CREDENTIALS_USES.test(l)).length,
    steps,
    settings: first ? entries(block(/^\s+with:$/, first)) : {},
  };
}
