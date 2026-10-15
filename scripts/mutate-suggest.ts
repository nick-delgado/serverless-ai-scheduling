/**
 * Edit suggester for `npm run mutate` (#240, B9-1; the #238 review's P1): reads the code this branch adds and prints
 * an edits file of breaks to start the seen-failing pass from, so the breaks come from the code rather than the spec.
 *
 *   npm run --silent mutate -- --suggest [--base <ref>] > edits.json
 *
 * (Without `--silent`, npm's `> … mutate` banner goes to stdout too, and the file isn't JSON.) `scripts/mutate.ts`
 * loads this module only for `--suggest`. The added lines are the committed ones, `git diff -U0 -M <base>...HEAD`, in
 * the files the `Seen-failing evidence` check covers (`EVIDENCE_GLOBS`: non-test `.ts`/`.tsx` sources, the helpers in
 * `scripts/test/` and `apps/*\/e2e/` included since #265, B10-3, the Playwright specs not). Each file is
 * parsed at HEAD with the TypeScript compiler API, and each of these on an added line gets one edit:
 *   - `drop-operand`: an operand of a `&&`, `||` or `??` chain removed with the operator next to it. A chain of one
 *     operator is flattened (`a && b && c` gives three drops); an operand in parentheses or built with another
 *     operator is one operand, with its own drops inside (r1/Q-3). An operand counts when its first character is on
 *     an added line. `&&=`, `||=` and `??=` are assignments, not chains.
 *   - `boundary`: `<`, `<=`, `>`, `>=` moved to its boundary neighbour (`<` ↔ `<=`, `>` ↔ `>=`);
 *     `flip-equality`: `===` ↔ `!==`.
 *   - `number+1`, `number-1`: a numeric or bigint literal in a value position (not a type, an enum member or a
 *     member's name), written in decimal, a negative result in parentheses (A-6).
 *   - `regex-lookaround`, `regex-alternative`: in a regex literal, each lookaround removed, and each alternative of
 *     each group (the whole pattern included) removed with one `|` next to it, at any depth (r1/Q-4). The pattern is
 *     read by `regexParts`, a character scanner; a pattern passed to `new RegExp(…)` as a string gets nothing.
 *   - `pass-through` (#265, B10-4): in a call or `new` expression, each argument that is a parameter of any enclosing
 *     function (closures included; a destructured name counts), or a property access on one (`p.x`, `p?.x.y`),
 *     replaced by `undefined` (r1/Q-3 (b)). `p["x"]`, `p.x()`, `this` and a spread get none, and a local that shadows
 *     a parameter's name isn't told apart: the file is parsed, not type-checked.
 *   - `flip-argument`: a `true` or `false` argument of a call or `new` expression, negated; one inside an object
 *     literal or behind `!` gets none (r1/A-13).
 *   - `extend-message`: the string or template literal message of `throw new Error(…)` with ` [extra]` appended, so a
 *     test that names the whole message, or says a value never appears in it, has a break to fail on. Only `Error`
 *     itself, thrown with `new` (r1/A-12).
 *   - `move-guard`: a statement whose whole expression is a call or `new` expression, or `await` of one, swapped with
 *     the next statement of its list (a block, a file's top level, a `case`/`default` clause), keeping the text
 *     between them; not the last statement of a list, nor across a function, class, interface or type declaration
 *     (r1/Q-2 (a)). The break starts at the moved statement; the others' at the changed argument or literal.
 *
 * Each edit's `find` occurs exactly once in its file (`occurrences`, as the runner counts): the changed text widened
 * by whole tokens, alternately right and left, within the nearest enclosing statement (or class member; for
 * `move-guard`, the statement list the two statements are in). A candidate
 * whose whole statement still occurs more than once is skipped and counted on stderr (r1/Q-5). A file with
 * uncommitted changes is named on stderr and its candidates skipped and counted, since `find` is cut from HEAD (A-1).
 * `expect` is empty for the author to fill in, and `note` names the kind of break (A-7). Edits are ordered by file,
 * then position. The base is `--base`, else `COVERAGE_BASE`, else `origin/main`, as `coverage:changed` resolves it.
 *
 * Exit codes: 0 the list was printed (`[]` when nothing added is a candidate); 2 the arguments were wrong (`--suggest`
 * takes only `--base`) or there's no merge base with the base (A-3).
 */
import { parseArgs } from "node:util";

import ts from "typescript";

import { addedSince, baseRef, isSourceFile, type ScriptDeps, scriptIo } from "./coverage-changed";
import { type Edit, occurrences, USAGE } from "./mutate";
import { EVIDENCE_GLOBS } from "./pr-evidence";

export type Note =
  | "drop-operand"
  | "boundary"
  | "flip-equality"
  | "number+1"
  | "number-1"
  | "regex-lookaround"
  | "regex-alternative"
  | "pass-through"
  | "flip-argument"
  | "extend-message"
  | "move-guard";

export type SuggestedEdit = Edit & { expect: string[]; note: Note };

/** A change to the file's text: replace `[start, end)` with `text`. */
interface Candidate {
  start: number;
  end: number;
  text: string;
  note: Note;
  /** Where the break is, for "is it on an added line" and for ordering. */
  at: number;
  node: ts.Node;
  /** How far the `find` may widen, when not the statement or class member around `node` (`move-guard`). */
  scope?: ts.Node;
}

/** A span of a regex pattern, `[start, end)`, as offsets into the pattern. */
export interface Span {
  start: number;
  end: number;
}

/**
 * The lookarounds of a regex pattern, and the spans that remove each alternative of each group (the whole pattern
 * included) with one `|` next to it. Escapes and character classes (nested ones with the `v` flag) aren't syntax;
 * `(?<name>` is a group, not a lookbehind.
 */
export function regexParts(pattern: string, vFlag: boolean): { lookarounds: Span[]; alternatives: Span[] } {
  const lookarounds: Span[] = [];
  const alternatives: Span[] = [];
  // Each open group: where it opens, where its content starts, the `|`s directly in it, and whether it is a
  // lookaround. The whole pattern is the group around them all.
  const groups: { open: number; content: number; bars: number[]; lookaround: boolean }[] = [];
  const top: { content: number; bars: number[] } = { content: 0, bars: [] };
  const close = (group: { content: number; bars: number[] }, end: number) => {
    const bounds = [group.content - 1, ...group.bars, end];
    group.bars.forEach((bar, k) => {
      // Alternative k with the `|` after it; the last alternative with the `|` before it.
      alternatives.push({ start: (bounds[k] as number) + 1, end: bar + 1 });
      if (k === group.bars.length - 1) alternatives.push({ start: bar, end });
    });
  };
  let classDepth = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "\\") {
      i += 1;
    } else if (classDepth > 0) {
      if (c === "]") classDepth -= 1;
      else if (c === "[" && vFlag) classDepth += 1;
    } else if (c === "[") {
      classDepth = 1;
    } else if (c === "(") {
      const prefix = ["(?=", "(?!", "(?<=", "(?<!"].find((opener) => pattern.startsWith(opener, i));
      groups.push({
        open: i,
        content: i + (prefix?.length ?? 1),
        bars: [],
        lookaround: prefix !== undefined,
      });
    } else if (c === "|") {
      (groups.at(-1) ?? top).bars.push(i);
    } else if (c === ")") {
      const group = groups.pop();
      if (group === undefined) continue;
      close(group, i);
      if (group.lookaround) lookarounds.push({ start: group.open, end: i + 1 });
    }
  }
  close(top, pattern.length);
  return { lookarounds, alternatives };
}

const CHAINS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const SWAPS = new Map<ts.SyntaxKind, [string, Note]>([
  [ts.SyntaxKind.LessThanToken, ["<=", "boundary"]],
  [ts.SyntaxKind.LessThanEqualsToken, ["<", "boundary"]],
  [ts.SyntaxKind.GreaterThanToken, [">=", "boundary"]],
  [ts.SyntaxKind.GreaterThanEqualsToken, [">", "boundary"]],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, ["!==", "flip-equality"]],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, ["===", "flip-equality"]],
]);

/** The operands of the chain `node` heads: same-operator children flattened, parentheses kept as one operand. */
function operands(node: ts.Expression, op: ts.SyntaxKind): ts.Expression[] {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === op)
    return [...operands(node.left, op), ...operands(node.right, op)];
  return [node];
}

/** A number written for code: decimal, a negative one in parentheses so `a-0` doesn't become `a--1`. */
const literal = (value: number | bigint, suffix: string) => {
  const text = `${String(value)}${suffix}`;
  return value < 0 ? `(${text})` : text;
};

/** True for a numeric literal whose value code reads: not in a type, an enum, or a member's name. */
function inValuePosition(node: ts.Node): boolean {
  const parent = node.parent;
  if ((parent as { name?: ts.Node }).name === node) return false;
  for (let up: ts.Node | undefined = parent; up !== undefined; up = up.parent)
    if (ts.isTypeNode(up) || ts.isEnumDeclaration(up)) return false;
  return true;
}

/** The names a parameter binds: an identifier, or each name in a destructuring pattern. */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : boundNames(element.name),
  );
}

/** True when `arg` is a parameter of a function around `call`, or a property access on one (`p.x`, `p?.x.y`). */
function passedThrough(arg: ts.Expression, call: ts.Node): boolean {
  let root = arg;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (!ts.isIdentifier(root)) return false;
  for (let up: ts.Node | undefined = call.parent; up !== undefined; up = up.parent)
    if (ts.isFunctionLike(up) && up.parameters.some((p) => boundNames(p.name).includes(root.text)))
      return true;
  return false;
}

/** The statement lists a `move-guard` swaps within: a block, a file's top level, a `case`/`default` clause. */
const statementList = (
  node: ts.Node,
): node is ts.Block | ts.SourceFile | ts.CaseOrDefaultClause | ts.ModuleBlock =>
  ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseOrDefaultClause(node) || ts.isModuleBlock(node);

/** True for a statement a guard moving across changes nothing: a function, class, interface or type declaration. */
const declaration = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node);

/** True for a statement whose whole expression is a call or `new` expression, or `await` of one. */
function discardedCall(node: ts.Node): node is ts.ExpressionStatement {
  if (!ts.isExpressionStatement(node)) return false;
  const value = ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression;
  return ts.isCallExpression(value) || ts.isNewExpression(value);
}

/** The `pass-through` and `flip-argument` breaks of one call's arguments. */
function argumentBreaks(call: ts.CallExpression | ts.NewExpression, source: ts.SourceFile): Candidate[] {
  return (call.arguments ?? []).flatMap((arg): Candidate[] => {
    const at = arg.getStart(source);
    const end = arg.getEnd();
    if (arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword) {
      const text = arg.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true";
      return [{ start: at, end, text, note: "flip-argument", at, node: call }];
    }
    if (passedThrough(arg, call))
      return [{ start: at, end, text: "undefined", note: "pass-through", at, node: call }];
    return [];
  });
}

/** The `extend-message` break of `throw new Error(<string or template literal>, …)`, if `node` is one. */
function messageBreak(node: ts.ThrowStatement, source: ts.SourceFile): Candidate[] {
  const thrown = node.expression;
  if (
    !ts.isNewExpression(thrown) ||
    !ts.isIdentifier(thrown.expression) ||
    thrown.expression.text !== "Error"
  )
    return [];
  const message = thrown.arguments?.[0];
  if (message === undefined || !(ts.isStringLiteral(message) || ts.isTemplateLiteral(message))) return [];
  const at = message.getStart(source);
  const raw = message.getText(source);
  const text = `${raw.slice(0, -1)} [extra]${raw.slice(-1)}`;
  return [{ start: at, end: message.getEnd(), text, note: "extend-message", at, node: message }];
}

/** The `move-guard` break of a discarded call statement: swapped with the next statement of its list. */
function guardBreak(node: ts.ExpressionStatement, source: ts.SourceFile): Candidate[] {
  const list = node.parent;
  if (!statementList(list)) return [];
  const statements: readonly ts.Statement[] = list.statements;
  const next = statements[statements.indexOf(node) + 1];
  if (next === undefined || declaration(next)) return [];
  const at = node.getStart(source);
  const text = source.text;
  const swapped =
    next.getText(source) + text.slice(node.getEnd(), next.getStart(source)) + node.getText(source);
  return [{ start: at, end: next.getEnd(), text: swapped, note: "move-guard", at, node, scope: list }];
}

/** The candidate breaks in one parsed file, wherever they are. */
function candidates(source: ts.SourceFile): Candidate[] {
  const found: Candidate[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const parentOp = ts.isBinaryExpression(node.parent) ? node.parent.operatorToken.kind : undefined;
      if (CHAINS.has(op) && parentOp !== op) {
        const parts = operands(node, op);
        const start = node.getStart(source);
        parts.forEach((part, i) => {
          // The first operand goes with the operator after it, any other with the operator before it.
          const cut =
            i === 0
              ? { start, end: (parts[1] as ts.Node).getStart(source) }
              : { start: (parts[i - 1] as ts.Node).getEnd(), end: part.getEnd() };
          found.push({ ...cut, text: "", note: "drop-operand", at: part.getStart(source), node });
        });
      }
      const swap = SWAPS.get(op);
      if (swap) {
        const token = node.operatorToken;
        const at = token.getStart(source);
        found.push({ start: at, end: token.getEnd(), text: swap[0], note: swap[1], at, node });
      }
    } else if ((ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) && inValuePosition(node)) {
      const at = node.getStart(source);
      const bigint = ts.isBigIntLiteral(node);
      const digits = node.getText(source).replaceAll("_", "");
      for (const [delta, note] of [
        [1, "number+1"],
        [-1, "number-1"],
      ] as const) {
        const value = bigint ? BigInt(digits.slice(0, -1)) + BigInt(delta) : Number(digits) + delta;
        found.push({
          start: at,
          end: node.getEnd(),
          text: literal(value, bigint ? "n" : ""),
          note,
          at,
          node,
        });
      }
    } else if (ts.isRegularExpressionLiteral(node)) {
      const start = node.getStart(source);
      const raw = node.getText(source);
      const slash = raw.lastIndexOf("/");
      const pattern = raw.slice(1, slash);
      const { lookarounds, alternatives } = regexParts(pattern, raw.slice(slash).includes("v"));
      const spans = [
        ...lookarounds.map((span) => ({ span, note: "regex-lookaround" as const })),
        ...alternatives.map((span) => ({ span, note: "regex-alternative" as const })),
      ];
      for (const { span, note } of spans) {
        // A pattern left empty would read as a `//` comment.
        const empty = span.end - span.start === pattern.length;
        const at = start + 1 + span.start;
        found.push({ start: at, end: start + 1 + span.end, text: empty ? "(?:)" : "", note, at, node });
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      found.push(...argumentBreaks(node, source));
    } else if (ts.isThrowStatement(node)) {
      found.push(...messageBreak(node, source));
    }
    if (discardedCall(node)) found.push(...guardBreak(node, source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The nearest statement or class member around `node`: how far a `find` may widen. */
function enclosing(node: ts.Node): ts.Node {
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent)
    if (ts.isStatement(up) || ts.isClassElement(up)) return up;
  /* v8 ignore next -- a fallback: each value a candidate reads sits in a statement or a class member */
  return node.getSourceFile();
}

/** The start and end of each token in `node`, in order. */
function tokens(node: ts.Node, source: ts.SourceFile): { start: number; end: number }[] {
  const leaves: { start: number; end: number }[] = [];
  const walk = (child: ts.Node) => {
    const children = child.getChildren(source);
    if (children.length === 0) leaves.push({ start: child.getStart(source), end: child.getEnd() });
    else children.forEach(walk);
  };
  walk(node);
  return leaves;
}

/** The candidate as an edit whose `find` occurs once in the file, or undefined when its whole statement repeats. */
function unique(candidate: Candidate, file: string, source: ts.SourceFile): SuggestedEdit | undefined {
  const text = source.text;
  const scope = candidate.scope ?? enclosing(candidate.node);
  const marks = tokens(scope, source);
  let { start, end } = candidate;
  for (let right = true; ; right = !right) {
    const find = text.slice(start, end);
    if (occurrences(text, find) === 1) {
      const replace = text.slice(start, candidate.start) + candidate.text + text.slice(candidate.end, end);
      return { file, find, replace, expect: [], note: candidate.note };
    }
    const next = marks.find((mark) => mark.end > end);
    const previous = marks.findLast((mark) => mark.start < start);
    if (previous === undefined || (right && next !== undefined)) {
      if (next === undefined) return undefined;
      end = next.end;
    } else start = previous.start;
  }
}

/**
 * The suggested edits for one file's text, for the breaks that start on `added` lines (1-based), in order of
 * position, and how many candidates were skipped because their whole statement occurs more than once.
 */
export function suggestEdits(
  file: string,
  text: string,
  added: ReadonlySet<number>,
): { edits: SuggestedEdit[]; skipped: number } {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const onAdded = candidates(source)
    .filter((candidate) => added.has(source.getLineAndCharacterOfPosition(candidate.at).line + 1))
    .sort((a, b) => a.at - b.at);
  const edits: SuggestedEdit[] = [];
  let skipped = 0;
  for (const candidate of onAdded) {
    const edit = unique(candidate, file, source);
    if (edit) edits.push(edit);
    else skipped += 1;
  }
  return { edits, skipped };
}

/** The `--suggest` entry point, called by `mutate`'s `main`; returns the exit code (see the header). */
export function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: ScriptDeps = {},
): number {
  const { log, logError, git } = scriptIo(deps);
  let base: string;
  try {
    if (argv.includes("--")) throw new Error("--suggest takes no test command");
    const { values } = parseArgs({
      args: [...argv],
      options: { suggest: { type: "boolean" }, base: { type: "string" } },
      strict: true,
    });
    base = baseRef(values.base, vars.COVERAGE_BASE);
  } catch (err) {
    logError(`${(err as Error).message}. ${USAGE}`);
    return 2;
  }
  try {
    git("merge-base", base, "HEAD");
  } catch {
    logError(`mutate --suggest: no merge base with ${base} (fetch it, or pass --base <ref>).`);
    return 2;
  }
  const edits: SuggestedEdit[] = [];
  let skipped = 0;
  let uncommitted = 0;
  // In git's path order, so by file.
  for (const [file, lines] of addedSince(git, base)) {
    if (!isSourceFile(file, EVIDENCE_GLOBS)) continue;
    const found = suggestEdits(file, git("show", `HEAD:${file}`), new Set(lines.map(({ line }) => line)));
    const count = found.edits.length + found.skipped;
    if (count > 0 && git("status", "--porcelain", "--", file).trim() !== "") {
      logError(`mutate --suggest: ${file} has uncommitted changes; skipped its ${count} candidates.`);
      uncommitted += count;
      continue;
    }
    edits.push(...found.edits);
    skipped += found.skipped;
  }
  log(JSON.stringify(edits, null, 2));
  logError(
    `mutate --suggest: ${edits.length} edits since ${base}; skipped ${skipped} whose statement occurs more than ` +
      `once, and ${uncommitted} in files with uncommitted changes. Fill in each edit's expect.`,
  );
  return 0;
}
