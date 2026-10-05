/** Small value helpers shared by every layer (transcript, graders, runner, CLI). No harness imports. */

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One Zod issue as `path: message`, with `(root)` for the value itself. */
export const issueText = (issue: { path: readonly PropertyKey[]; message: string }): string =>
  `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`;

/** How a model, transport or usage error is recorded: `Name: message`. */
export const errorReason = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Every object key and every string value anywhere inside a value, in one walk. */
export function walkValue(
  value: unknown,
  out: { keys: string[]; strings: string[] } = { keys: [], strings: [] },
): { keys: string[]; strings: string[] } {
  if (typeof value === "string") out.strings.push(value);
  else if (Array.isArray(value)) for (const v of value) walkValue(v, out);
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value)) {
      out.keys.push(k);
      walkValue(v, out);
    }
  return out;
}
