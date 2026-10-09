/**
 * Checks for `src/redact.ts` (spikes have no Vitest project, so this is a plain assert script):
 *
 *   npx tsx spikes/s3-transcribe-browser/redact.check.ts
 *
 * #10's first exports ran `\b\d{12}\b` over JSON, which matched the 12 fractional digits of
 * `performance.now()` values ("stop": 6744.399999999674) and left files that no longer parsed.
 *
 * The fake IDs below are built at run time, so the source holds no literal shaped like an access key,
 * account ID, pool or identity ID, or LAN address for secret scanners to flag (PR #225).
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

// Synthetic IDs, assembled here (see the header).
const region = ["us", "east", "1"].join("-");
const account = "1".repeat(12);
const identityId = `${region}:${["a".repeat(8), "b".repeat(4), "c".repeat(4), "d".repeat(4), "e".repeat(12)].join("-")}`;
const userPoolId = `${region}_${"A".repeat(9)}`;
const accessKeyId = "ASIA" + "A".repeat(16);
const lanIp = [192, 168, 1, 23].join(".");

// Account IDs in strings are still replaced.
assert.equal(
  redact(`User: arn:aws:sts::${account}:assumed-role/sched-dev-Role-ABC/CognitoIdentityCredentials is not`),
  "User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not",
);
assert.equal(redact(`"account ${account}"`), '"account <account>"');
assert.equal(redact(`${account}3`), `${account}3`, "a 13-digit run is not an account ID");

// The other IDs.
assert.equal(redact(identityId), "<identity-id>");
assert.equal(redact(userPoolId), "<user-pool-id>");
assert.equal(redact(accessKeyId), "<access-key-id>");
assert.equal(redact(`https://${lanIp}:5175/`), "https://<lan-ip>:5175/");
assert.equal(redact("abc client xyz", ["client"]), "abc <redacted-id> xyz");

console.log("redact checks passed");
