#!/usr/bin/env bash
# Local patch for @stryker-mutator/vitest-runner 10.0.0 under Vitest 5 (stryker-js#6210, fix proposed in #6214).
# Vitest 5 matches `testNamePattern` against the suite chain joined with " > "; the runner builds its per-test
# filter from names joined with a space, so no test runs against a covered mutant and every one "survives".
# This rewrites the join in the two files that build test names (the setup file copied into each sandbox and the
# helper the runner uses). It edits node_modules only, which `npm ci` restores. Idempotent.
set -euo pipefail
dir="$(npm root)/@stryker-mutator/vitest-runner/dist/src"
for f in "$dir/test-helpers.js" "$dir/stryker-setup.js"; do
  if grep -q "nameParts.join(' ')" "$f"; then
    sed -i.bak "s/nameParts.join(' ').trim()/nameParts.filter(Boolean).join(' > ').trim()/" "$f" && rm "$f.bak"
    echo "patched $f"
  else
    echo "already patched (or changed upstream): $f"
  fi
done
