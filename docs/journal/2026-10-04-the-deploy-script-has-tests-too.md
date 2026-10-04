# 2026-10-04 — The deploy script has tests too

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #100, ADR-003, ADR-005; unblocks #36, informs #41

## What happened

The web stack (#7) has had an empty bucket and a CloudFront distribution in front of it since M1, but no script put the SPA in it. `scripts/deploy-web.sh <env>` now does: it reads the env's Cognito IDs and the web stack's bucket, distribution and domain from SSM, builds `apps/web` with the IDs as `VITE_*` variables, syncs `apps/web/dist/` to the bucket and invalidates the distribution. The PR #120 review made one rule non-negotiable: a build without the pool IDs must never ship, because the login page would throw at runtime and nothing at build time would complain.

The definition of done says a test counts only once you've seen it fail, and that applies to a bash script as much as to a tool handler. So the script runs for real in `scripts/deploy-web.test.ts`, inside a throwaway git repo, against stand-in `aws` and `npm` commands on `PATH` that log every call. The stand-in `aws` answers `ssm get-parameter` from a per-test map, and the stand-in `npm` writes a fake `dist/` that embeds the `VITE_*` values it received. I then broke the script 43 ways, one at a time (each SSM name, each `VITE_*` variable, each refusal, each cache header, each `--delete`, the upload order, the invalidation path, the wait), and every break turned a test red.

## Why we chose what we chose

- **Upload order: assets, then `index.html`, then deletions, then the invalidation.** At every moment the live `index.html` points at files that exist. Deleting stale assets before the new `index.html` lands would break open tabs and the next page load.
- **`assets/*` immutable for a year, everything else `no-cache`.** Vite hashes everything under `assets/`, so those never change under a name. `index.html` is the one file that must revalidate.
- **Invalidate `/*`, not just `/index.html`.** One path either way (the first 1,000 a month are free), and `/*` also covers `/` and anything a future `public/` folder adds at the root. Evicting hashed assets costs nothing.
- **Wait for the invalidation.** The script returns only once the new `index.html` is live, so a `curl` straight afterwards checks the new build and #41's workflow can run a smoke check next.
- **Check that the bundle contains the env's user pool ID.** The missing-parameter check proves that SSM returned values, not that Vite saw them. Grepping `dist/assets` for the pool ID costs nothing and catches a renamed variable or a broken `env` prefix.
- **A `--dry-run` flag** prints the `aws s3 sync --dryrun` plan and stops. The issue asks to print the plan before syncing. The flag lets #41 and a cautious human see the plan without acting on it.
- **No exec role.** This isn't CloudFormation. `SchedDeployer` already has S3 access to `sched-*` buckets and `cloudfront:CreateInvalidation` (`infra/bootstrap/sched-deployer-policy.json`).

## Evidence

- `scripts/deploy-web.test.ts`: 23 tests, about 9 s (each one spawns git and bash several times, hence a 30 s per-test timeout).
- 43 single-line mutations of `scripts/deploy-web.sh`, all red, 0 survivors.
- A real `vite build` with synthetic IDs writes `index.html`, one JS and one CSS file under `assets/`, and both IDs end up in the JS bundle, the same layout the stand-in `npm` fakes.
- The `dev` run is in the PR (#100).

## What's next

- #36 deploys the SPA with this script. #41's deploy workflow calls it after `scripts/deploy.sh` instead of re-implementing the sync.
- Deep links (`/chat` on refresh) still return an S3 error until #99 adds the CloudFront Function.
