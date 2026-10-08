/**
 * Redaction for anything that leaves the page (r1/A-4): results are committed to a public repo, so
 * account IDs, Cognito pool, client and identity IDs, role session names and private LAN addresses
 * are replaced before export. The dev server's results endpoint runs the same function again with
 * the exact IDs from `.env.local` as `known`.
 */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const value of known) if (value) out = out.replaceAll(value, "<redacted-id>");
  return (
    out
      // Identity Pool and identity IDs: <region>:<uuid>
      .replace(
        /\b[a-z]{2}-[a-z]+-\d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
        "<identity-id>",
      )
      // User Pool IDs: <region>_<suffix>
      .replace(/\b[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{6,}\b/g, "<user-pool-id>")
      .replace(/assumed-role\/[^/\s]+\/[^\s"]+/g, "assumed-role/<role>/<session>")
      .replace(/\b(ASIA|AKIA)[A-Z0-9]{12,}\b/g, "<access-key-id>")
      // Account IDs: a run of exactly 12 digits that isn't part of a number. "(?<![\d.])" keeps the
      // fractional digits of a performance.now() value ("6744.399999999674") out of it: #10's first
      // exports lost their JSON validity to the old \b\d{12}\b.
      .replace(/(?<![\d.])\d{12}(?!\d)/g, "<account>")
      .replace(/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, "<lan-ip>")
  );
}
