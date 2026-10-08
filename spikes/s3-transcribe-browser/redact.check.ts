/**
 * Checks for `src/redact.ts` (spikes have no Vitest project, so this is a plain assert script):
 *
 *   npx tsx spikes/s3-transcribe-browser/redact.check.ts
 *
 * #10's first exports ran `\b\d{12}\b` over JSON, which matched the 12 fractional digits of
 * `performance.now()` values ("stop": 6744.399999999674) and left files that no longer parsed.
 */
import assert from "node:assert/strict";

import { redact } from "./src/redact.ts";

// Numbers survive, and a redacted export still parses with the same values.
const payload = {
  marks: { stop: 6744.399999999674, lastFinal: 6911.123456789012 },
  latencyMs: 166.723456789012,
};
const json = JSON.stringify(payload);
assert.equal(redact(json), json, "redaction changed a number");
assert.deepEqual(JSON.parse(redact(json)), payload);

// Account IDs in strings are still replaced.
assert.equal(
  redact("User: arn:aws:sts::123456789012:assumed-role/sched-dev-Role-ABC/CognitoIdentityCredentials is not"),
  "User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not",
);
assert.equal(redact('"account 123456789012"'), '"account <account>"');
assert.equal(redact("1234567890123"), "1234567890123", "a 13-digit run is not an account ID");

// The other IDs.
assert.equal(redact("us-east-1:0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"), "<identity-id>");
assert.equal(redact("us-east-1_AbCdEf123"), "<user-pool-id>");
assert.equal(redact("ASIAABCDEFGHIJKLMNOP"), "<access-key-id>");
assert.equal(redact("https://192.168.1.23:5175/"), "https://<lan-ip>:5175/");
assert.equal(redact("abc client xyz", ["client"]), "abc <redacted-id> xyz");

console.log("redact checks passed");
