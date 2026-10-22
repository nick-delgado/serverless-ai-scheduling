# 2026-10-22 — The project has billed $249.60 as of 2026-10-22, nearly all of it Claude on Bedrock, and idle runs at $0.26 so far

**Chapter:** 6. What I'd do next
**Milestone:** M4
**Related:** #45, PR #375, #37, #43, #44, #345, #356, ADR-002, ADR-008, ADR-009, PRD NFR-003, PRD §7

## What happened

#45 closes the loop: what the project cost, what we learned, what a second version would do. NFR-003 gives this issue one number to report, idle cost against $5 a month (excluding a domain).

The agent can't read billing, so Nick exported Cost Explorer's daily report, by service, from the console on 2026-10-22 and posted it on the issue as a plain table ([#45 comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/45#issuecomment-6341441996)). It covers 2026-09-27, the day the repo was created, to 2026-10-22, the last day and a partial one. The agent summed it by month and service and retyped the figures below. Everything in the "billed" column comes from that comment and nothing else. The export has no credit rows, so no credit was applied.

The headline: **$249.60 billed as of 2026-10-22, of which $228.48 before tax and $21.12 tax, all of it on the usage services.** All of it falls in October; September's four days read $0.00. Claude on Bedrock is $216.68 of it (Sonnet 4.6 $193.28, Haiku 4.5 $23.40). The other model services and voice add $11.53 (Cost Explorer's "Bedrock" $11.15, "Transcribe" $0.38). Every other service together is $0.26.

Counted: AWS and Bedrock only (r1/Q-6 (a)). Not counted: the AI coding agents' and other tools' costs, and any domain (there is none). Cloudflare Turnstile, which the self-serve access page uses ([the access-request entry](2026-10-20-a-reviewer-can-request-a-demo-patient-and-the-bot-check-comes-first.md)), is on its free tier, so it adds nothing.

### Billed, by service (Cost Explorer, 2026-09-27 to 2026-10-22)

| Service | Billed (USD) | Part of |
|---|---|---|
| Claude Sonnet 4.6 (Bedrock Edition) | 193.28 | usage |
| Claude Haiku 4.5 (Bedrock Edition) | 23.40 | usage |
| Bedrock | 11.15 | usage |
| Transcribe | 0.38 | usage |
| **Usage subtotal** | **228.22** | |
| DynamoDB | 0.23 | idle |
| Cost Explorer | 0.02 | idle |
| S3, API Gateway, SES, CloudWatch (each under $0.01: 0.0043, 0.0037, 0.0022, 0.0003) | 0.01 | idle |
| Secrets Manager, CloudFront, Glue, CloudFormation, KMS, SNS, SQS, Lambda, Cognito, X-Ray, Budgets, Data Transfer | 0.00 | idle |
| **Idle subtotal** | **0.26** | |
| Tax on usage (Sonnet 4.6 17.88, Haiku 4.5 2.17, Bedrock 1.03, Transcribe 0.04; one posting, 2026-10-01) | 21.12 | usage tax, kept beside the usage rows |
| **Total costs** | **249.60** | |

### The split: build, eval, idle (r1/Q-2 (a))

Billed and estimated figures stay in their own columns. Only the residual, build, mixes them, and says so.

| Bucket | Billed | List-price estimate | How it was found |
|---|---|---|---|
| Idle | $0.26 | | Every service except Bedrock (and the two per-model Claude names) and Transcribe; no tax was charged on any of them |
| Eval | | **at least $115.87** | The sum of recorded harness costs in the ledger below (agent, simulator and judge together), at the list prices in `packages/agent/src/profiles.ts` (`PRICES_AS_OF = "2026-09-29"`) |
| Build | | **at most $112.35** | Inferred residual: billed usage $228.22 minus the eval estimate $115.87. Covers dev and demo chat, the E2E runs, voice, and every eval run nobody recorded, so it is an upper bound |
| Usage (build + eval) | $228.22 | | Billed Bedrock + Transcribe |
| Tax on usage | $21.12 | | Belongs with usage (build and eval), as its own line: Nick's Taxes-by-service table on the issue gives it per service, not per purpose, so we don't split it between build and eval |

Eval is a minimum for three reasons, all of them runs whose cost nobody wrote down: local results before 2026-10-06's out-of-checkout copy (`0ff92ab`), the CI `Eval gate` (223 runs of `evals.yml` as of 2026-10-22, from `gh run list --workflow evals.yml`, many of which pass without calling Bedrock; the ledger holds the cost of five of them, the two on 2026-10-09 and the three on 2026-10-11, and the later gate runs' entries name the result but not the cost), and runs a task worker made without noting the cost. Build is therefore a maximum by the same amount. The ledger doesn't hit the "estimate exceeds the bill" edge: the estimate is 51% of billed usage.

### The recorded eval ledger

Each figure is what the entry or issue comment named, quoted, not re-measured.

| Date | What | Recorded cost (USD) | Source |
|---|---|---|---|
| 2026-09-29 | First live L1 run | 0.027 | [entry](2026-09-29-first-live-l1-run.md) |
| 2026-10-02 | System prompt v1, all iterations | 2.77 | [entry](2026-10-02-system-prompt-v1.md) |
| 2026-10-02 | Simulated patient says yes like a person (0.338, then 0.031 for the two safety cases re-run after the fix) | 0.369 | [entry](2026-10-02-the-simulated-patient-says-yes-like-a-person.md) |
| 2026-10-04 | The staff-email smoke runs, `main` and the branch, 0.0553 each | 0.1106 | [entry](2026-10-04-the-staff-email-must-not-carry-its-own-address.md) |
| 2026-10-05 | Guards outside the prompt, four runs | 0.56 | [entry](2026-10-05-guards-outside-the-prompt.md) |
| 2026-10-05 | First full scenario run with the judge (agent 1.36, simulator 0.59, judge 0.22) | 2.16 | [entry](2026-10-05-the-judge-scores-beside-the-trial.md); the same run is quoted in [one real safety violation](2026-10-05-one-real-safety-violation-in-three.md) and counted once |
| 2026-10-05 | A floor reaches the sixth slot (1.37 approved, 0.43 on two reruns nobody approved) | 1.80 | [entry](2026-10-05-a-floor-reaches-the-sixth-slot.md) |
| 2026-10-05 | One copy of the model-call plumbing, four runs | 0.87 | [entry](2026-10-05-one-copy-of-the-model-call-plumbing.md) |
| 2026-10-05 | An ID in your own note (0.040 + 0.0026 judge) | 0.0426 | [entry](2026-10-05-an-id-in-your-own-note-is-not-a-leak.md) |
| 2026-10-06 | A refusal that quotes a time: the smoke re-run 0.1202 and the replay 0.1628 | 0.2830 | [entry](2026-10-05-a-refusal-that-quotes-a-time-is-not-an-offer.md) |
| 2026-10-06 | Ten tool-PR L1 cases (0.0717), then the two cases re-run with the literal check (0.0296) | 0.1013 | [entry](2026-10-06-tool-pr-cases-land-as-l1.md) |
| 2026-10-06 | A retry is the repository's answer too: L1 smoke on `main` 0.0567 and on the branch 0.0570 | 0.1137 | [entry](2026-10-06-a-retry-is-the-repositorys-answer-too.md) |
| 2026-10-06 | No time before the tool returns it, eight runs | 1.94 | [entry](2026-10-06-no-time-before-the-tool-returns-it.md) |
| 2026-10-07 | Three rules each written once, four runs | 0.84 | [entry](2026-10-07-three-rules-each-written-once.md) |
| 2026-10-07 | The losing twin move is a retry too: L1 smoke on `main` 0.0403 and on the branch 0.0572 | 0.0975 | [entry](2026-10-07-the-losing-twin-move-is-a-retry-too.md) |
| 2026-10-09 | The `Eval gate`'s seed smoke runs (0.0566 + 0.3169 + 0.0430 judge) | 0.417 | [entry](2026-10-09-the-eval-gate-and-an-estimate-that-was-7x-high.md) |
| 2026-10-09 | `Eval gate` run 37930953931 (0.0405 + 0.3208 + 0.0417 judge) | 0.4030 | [entry](2026-10-09-the-eval-gate-and-an-estimate-that-was-7x-high.md), [the run](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/37930953931) |
| 2026-10-09 | `Eval gate` run 37935466134 (0.0574 + 0.3511 + 0.0435 judge) | 0.4520 | [entry](2026-10-09-the-eval-gate-and-an-estimate-that-was-7x-high.md), [the run](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/37935466134) |
| 2026-10-10 to 11 | Ask who is speaking before acting: six runs, from 0.0014 to 0.0719 | 0.3065 | [entry](2026-10-10-ask-who-is-speaking-before-acting.md) |
| 2026-10-11 | Plain text for a plain-text bubble: three local runs (0.0369, 0.0417, 0.3103 + 0.0391 judge), and three `Eval gate` runs (0.4394, 0.4428, 0.3772) | 1.6874 | [entry](2026-10-11-plain-text-for-a-plain-text-bubble.md) |
| 2026-10-11 to 12 | **The M3 matrix**, 14 cells, k=3, both modes | 57.61 | [entry](2026-10-13-what-the-matrix-chose.md), [#37](https://github.com/nick-delgado/serverless-ai-scheduling/issues/37) |
| 2026-10-15 | Five options grouped by day: `main` 0.56, the branch 0.96 | 1.52 | [entry](2026-10-15-five-options-grouped-by-day.md) |
| 2026-10-16 | A format miss is not a leak | 0.0784 | [entry](2026-10-16-a-format-miss-is-not-a-leak.md) |
| 2026-10-16 | Judge calibration, first set | 0.1360 | [entry](2026-10-16-the-judge-agrees-but-passes-every-reply-nick-failed.md) |
| 2026-10-16 | The handoff rule, three runs | 1.76 | [entry](2026-10-16-the-handoff-rule-already-held.md) |
| 2026-10-16 | The patient asked for the Monday: "2.7x" a $0.31 dry run, so about | 0.84 | [entry](2026-10-16-the-patient-asked-for-the-monday.md) |
| 2026-10-16 | The lead-in says that day | 0.2765 | [entry](2026-10-16-the-lead-in-says-that-day.md) |
| 2026-10-17 | Options go inside the one question, two runs | 1.1739 | [entry](2026-10-17-options-go-inside-the-one-question.md) |
| 2026-10-17 | Every undated time, two runs (0.5349 + 0.5215) | 1.0564 | [entry](2026-10-17-every-undated-time-still-left-out-et.md) |
| 2026-10-17 | The `system.v9` smoke re-baseline at k=1: L1 0.0975, scenario 0.6036 + 0.0577 judge | 0.7588 | [entry](2026-10-17-the-time-check-reads-every-clock-time.md) |
| 2026-10-18 | Several-day offers name no time: run 1 (2.14 + 0.13 judge) and run 2 (2.25 + 0.15 judge) | 4.67 | [entry](2026-10-18-several-day-offers-name-no-time.md) |
| 2026-10-18 | Undated times now carry ET: runs 2 (1.85) and 4 (2.41) and a one-trial check (about 0.2); run 1 was lost and its spend is unrecorded | 4.46 | [entry](2026-10-18-undated-times-now-carry-et-the-weekday-is-what-is-left.md) |
| 2026-10-18 | One time over several days (agent 1.91, judge 0.15) | 2.06 | [entry](2026-10-18-one-time-over-several-days-is-searched-per-weekday.md) |
| 2026-10-18 | Judge calibration (0.1389) and the full scenario run at `system.v10` (2.97 + 0.22 judge) | 3.33 | [entry](2026-10-18-the-judge-now-fails-one-of-nicks-six-clarity-3s.md) |
| 2026-10-19 | The scenario run behind the 47-pair judge set (3.32), and the two calibrate runs (0.164 + 0.148, `ef90f9f`) | 3.632 | [entry](2026-10-19-judge-v2-agrees-with-nick-on-47-of-47-on-system-v13-replies.md) |
| 2026-10-19 | Seven suggested cases, one L1 run | 0.06 | [entry](2026-10-19-seven-suggested-cases-and-the-checks-l1-cannot-make.md) |
| 2026-10-19 to 20 | The patient's time of day stays: five L1 runs (0.0505, 0.0855, 0.0799, 0.0851, 0.0800); the first draft's $0.0706 is an estimate and is left out | 0.3810 | [entry](2026-10-19-the-patients-time-of-day-stays-until-they-change-it.md) |
| 2026-10-20 | The M3 exit re-run: scenario 10.3084, L1 1.5067, two stopped scenario attempts 2.85 and 2.05 (their judge share unrecorded) | 16.72 | [entry](2026-10-20-the-exit-rerun-on-system-v15-misses-three-of-six-targets.md), [#345](https://github.com/nick-delgado/serverless-ai-scheduling/issues/345) |
| | **Recorded total** (38 rows) | **115.87** | |

Recorded build-side spend that sits inside the residual, not subtracted from it: #37's two deployed NFR-001 measurements $0.86 ([#37](https://github.com/nick-delgado/serverless-ai-scheduling/issues/37), "Total live spend on #37 so far is $58.47", which is the matrix's $57.61 plus these), the refusal-fallback spike $0.047 ([the matrix entry](2026-10-13-what-the-matrix-chose.md)), the E2E suite's full run $0.1220 ([entry](2026-10-13-the-e2e-suite-reads-the-stream-not-the-reply.md)), nine deployed chat turns about $0.13 ([entry](2026-10-10-the-deployed-chat-runs-the-real-prompt.md)) and the S-1c model spike about $0.16 ([entry](2026-09-29-one-transport-many-models.md)). That is $1.32; the remaining $111.03 of the residual has no record.

### Idle against NFR-003

NFR-003: idle at most $5 a month, excluding a domain. r1/Q-3 (a) reads it account-wide and measured, bootstrap stack included, every env alive in the period, for the latest full calendar month. The project has had no full calendar month (the repo dates from 2026-09-27), so the reported figure is October to the 22nd, the only month with deployed resources to measure (the owner's decision on this PR's review of `46e0c91`, SPEC-2 (b)).

| Period | Idle billed | Verdict |
|---|---|---|
| **October 2026 to the 22nd (the 22nd is partial), the reported figure** | **$0.26** | **met** |
| October at that rate for all 31 days, straight-line arithmetic, not a measurement | about $0.36 | met |

Footnote: September 2026 is the only full calendar month the project's life touched, but it ran four days (27th to 30th) and billed $0.00, so it measures nothing.

The envs that were up in the reported month, as the journal names them: `dev`, `demo`, `e2e`, and short-lived ephemeral envs such as `i36fail` and the rehearsal stacks, about 30 minutes ([the runbook rehearsal](2026-10-16-a-new-env-from-the-runbook-alone.md)). October still had build traffic, so the reported $0.26 is an upper bound on what an untouched env costs, not a measurement of one. DynamoDB is 88% of it ($0.23), and the export can't separate its point-in-time recovery from the build's reads and writes. The other half of NFR-003, the agent's cost per completed conversation, is a separate figure: $0.0400 in the matrix on `sonnet-4.6` at `high` (#37, PRD §7) and $0.0729 in the exit re-run, both under the $0.25 ceiling ([the exit entry](2026-10-20-the-exit-rerun-on-system-v15-misses-three-of-six-targets.md)).

## Why we chose what we chose

The settled decisions are on #45 (r1/Q-1 to Q-6, all recommendations accepted). The ones the agent made where the spec was silent, each with the alternative it beat:

- **Tax goes with usage, as its own line, not split between build and eval.** Nick's Bills, Taxes by service table ([#45 comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/45#issuecomment-6341441996)) shows the $21.12 is all tax on the four usage services (Sonnet 4.6 $17.88, Haiku 4.5 $2.17, Bedrock $1.03, Transcribe $0.04) and none on any other, so idle carries no tax and stays $0.26. The alternative, splitting it pro rata between build and eval, would need a build/eval split of billed usage, and we only have the eval estimate and a residual, so the split would rest on an estimate; we kept the usage-tax line beside both.
- **October to the 22nd is the reported idle month, and September is a footnote (the owner's decision on this PR's review, SPEC-2 (b)).** Q-3 (a) names the latest full calendar month, and the project has none: September is four days at $0.00. The alternative, reporting September as the nominal month with October beside it, would have attached the envs and the build-traffic caveat Q-3 (a) asks for to a month they don't describe. The alternative of waiting for November's full month would have delayed this entry by weeks (r1/Q-3's rejected (c)).
- **The $115.87 total counts each run once.** The first full scenario run appears in two entries with the same figures, and is in the ledger once. Where an entry gives an approximation ("2.7x"), the row says "about" and shows its basis. The alternative, leaving unreconstructable rows out, would have understated eval further.
- **Ephemeral envs are named, not priced.** The export has no env dimension; there are no cost-allocation tags on `sched-*` stacks, and changing that is a non-goal of #45. The alternative, estimating each env's idle share from its lifetime, would put a made-up number beside the billed ones, and the DynamoDB row, 88% of idle, can't be split by env at all.

## What surprised us

- **Almost the whole bill is the model.** $228.22 of $228.48 before tax, 99.9%. The serverless stack we spent most of the milestones designing costs $0.26 over 22 days. The cost of this project is its evaluation, and the matrix alone, $57.61, is 50% of the recorded eval spend.
- **Eval is a minimum, and so is our knowledge of build.** Every run we did get written down came from a task worker's habit of recording its spend. The CI gate's runs, a large group, mostly didn't. Because Bedrock can't be told apart by purpose here ([the backstop entry](2026-10-20-the-spend-backstop-covers-voice-not-bedrock.md)), the only record of what an experiment cost is the sentence someone wrote after it. A fresh reader can't turn that into a bill; the residual is what is left when it fails.
- **The bill can't tell us what the cheap models cost.** The matrix's ten non-Claude cells (Nova Pro, Nova 2 Lite, both gpt-oss models) add up to $33.82 in its Run cost column ([the matrix entry](2026-10-13-what-the-matrix-chose.md)), but that is whole-run cost: the agent plus the Claude simulator and judge, which bill under the Claude rows. So it isn't the non-Claude models' own cost, and it can't be set against Cost Explorer's whole-period "Bedrock" row ($11.15). We haven't checked which service name those models bill under, and the agent's share of those cells isn't recorded here, so whether their price table ran high stays open. The matrix as a whole came in 23% under its estimate: the estimate ran 30% high ($75.00 against $57.61, same entry).
- **The budgets did what budgets do.** `sched-monthly` and `sched-bedrock-monthly` are alerts, and the templates' defaults ($25 and $10 a month, `infra/bootstrap/bootstrap.yaml`) were far below October's bill. We didn't read what was applied in the account, so we don't say how many alerts fired. What the entries record is that the budgets only send email ([the turn-cap entry](2026-10-20-the-env-gets-its-own-daily-turn-cap.md)), which is why #356 added a cap that stops spend instead.
- **Tax is 9.2% of the pre-tax total ($21.12 of $228.48) and all of it sits on usage.** It posted on a single day, 2026-10-01, rather than alongside the usage, but the console's Taxes-by-service table puts it on the Claude, Bedrock and Transcribe rows. Post-tax, usage is $249.34 (Sonnet 4.6 $211.16, Haiku 4.5 $25.58, Bedrock $12.18, Transcribe $0.42, per that table).

## Lessons

What worked:

- **Write the rule down before the code, and make it structural.** Identity from the token and atomic bookings are decided in ADRs, and the tools were built around them. ([ADR-005](../adr/0005-auth.md), [ADR-004](../adr/0004-data-model.md), [the loop never sees the patient](2026-09-29-the-loop-never-sees-the-patient.md))
- **A test counts once you've seen it fail.** The double-booking test earned its place by failing first, and the rule is now in the definition of done. ([entry](2026-09-29-watch-the-double-booking-test-fail.md))
- **One transport for every model.** Being denied the models we planned for led to one provider-neutral layer instead of a client per vendor. ([entry](2026-09-29-one-transport-many-models.md), [ADR-010](../adr/0010-provider-neutral-llm-layer.md), [ACTIVE is not callable](2026-09-28-active-is-not-callable.md))
- **Evals before the agent.** Writing them first exposed gaps in the fixture and the harness while they were cheap to fix. ([entry](2026-09-29-writing-the-tests-before-the-agent.md), [the first live run](2026-09-29-first-live-l1-run.md))
- **Guards outside the prompt.** Rules the model can't be trusted to hold went into the loop and tools instead of the prompt. ([entry](2026-10-05-guards-outside-the-prompt.md))
- **Streaming survived the front door.** First token about 1 s through CloudFront, 15 ms of overhead. ([entry](2026-09-29-streaming-survives-cloudfront.md))
- **A new env from the runbook alone.** The runbook was rehearsed from scratch on a fresh env before anyone relied on it. ([entry](2026-10-16-a-new-env-from-the-runbook-alone.md))

What didn't:

- **The M3 exit missed three of six targets.** Task success 86% (target 90%), reliability 74% (80%) and four safety violations (0) on `system.v15`, against a table that met them on `system.v3`. We accepted the gaps to exit M3, and can't say how much of the fall is the prompt and how much is the five grader changes in between. ([entry](2026-10-20-the-exit-rerun-on-system-v15-misses-three-of-six-targets.md), [matrix](2026-10-13-what-the-matrix-chose.md))
- **A judge that agreed with us but passed every reply Nick failed.** Agreement was 86%, and the judge still passed every reply Nick had failed. `judge.v2` and a held-out set followed. ([entry](2026-10-16-the-judge-agrees-but-passes-every-reply-nick-failed.md), [judge.v2](2026-10-19-judge-v2-agrees-with-nick-on-47-of-47-on-system-v13-replies.md))
- **Cost estimates ran from 7x high to 2.9x low.** The harness charged three uncached calls a turn when the real figure was 1.5 mostly cached ones; later runs came in under the dry run, by up to 2.9x. The estimator was recalibrated, and #345's approval comment now states an expected range beside each estimate. ([7x high](2026-10-09-the-eval-gate-and-an-estimate-that-was-7x-high.md), [2.9x low](2026-10-17-every-undated-time-still-left-out-et.md))
- **Alerts aren't limits.** Two budgets only email, Bedrock can't be attributed by purpose, and the backstop that exists covers voice only. ([backstop](2026-10-20-the-spend-backstop-covers-voice-not-bedrock.md), [turn cap](2026-10-20-the-env-gets-its-own-daily-turn-cap.md), [ADR-009](../adr/0009-safety-and-privacy.md))
- **The simulator's quota set the matrix's pace.** 23 hours for 14 cells, because every scenario trial's patient replies came from one model at 10 requests a minute. ([matrix entry](2026-10-13-what-the-matrix-chose.md))
- **First-text latency missed its target for a while.** 4,735 ms against 3 s at the matrix, because the turn's shape needs two lookups before any words; #251 brought it to 2,478 ms on `system.v14`, not re-measured on `system.v15`. ([matrix entry](2026-10-13-what-the-matrix-chose.md), [exit entry](2026-10-20-the-exit-rerun-on-system-v15-misses-three-of-six-targets.md))
- **A public door needs a cap, a bot check and an expiry before it opens.** A reviewer can request a temporary synthetic patient on their own, but only after a Turnstile check, under two caps, and with an hourly job that deletes the account, its data and its place in the registry; the job checks the user's `sub` before it deletes, so a username clash can't delete another account. ([request page](2026-10-20-a-reviewer-can-request-a-demo-patient-and-the-bot-check-comes-first.md), [expiry job](2026-10-21-expired-reviewer-accounts-delete-themselves-and-the-job-proves-whose-user-it-deletes.md))
- **Try the hand-off in a real browser.** Nick found the account page clunky once he used it: one combined copy button, and a link that unmounted the page and lost the password, which is shown once. The fix was per-field copy and a new-tab link. ([sign-in hand-off](2026-10-21-a-reviewer-carries-the-demo-account-into-sign-in-one-field-at-a-time.md))
- **Least privilege was not a one-time task.** The first real deploy surprised us, and the boundary and the exec role were narrowed again in M3. ([first deploy](2026-09-29-least-privilege-meets-reality.md), [boundary](2026-10-19-the-boundary-keeps-only-what-a-workload-role-grants.md), [exec role](2026-10-19-the-exec-role-gets-one-statement-per-service.md))

Limits worth naming: Opus 5 and Sonnet 5 were never callable here, and #49, the spike to measure them if AWS lifted the restriction, was closed as not planned. Nova and gpt-oss ran, but no cell met §7.

## A v2 roadmap

Eight items, ordered by priority; items link the open issue that covers them, or say "no issue yet". We filed none.

Product, what patients and the clinic would get:

1. **Task success to 90% in book, availability and clarify** (M3 exit: 83%, 83% and 78% against 90%). [#363](https://github.com/nick-delgado/serverless-ai-scheduling/issues/363) (`book-multi-constraint` expects `time_of_day: afternoon` where the agent sends a start time), [#347](https://github.com/nick-delgado/serverless-ai-scheduling/issues/347) (the agent books with a slot ID that doesn't match the confirmed time) and [#343](https://github.com/nick-delgado/serverless-ai-scheduling/issues/343) (cases suggested by later PRs). #360 and #361, the other two fixes the exit produced, are closed; this entry has no run after them.
2. **Reliability, pass^3, from 74% to 80%.** No issue of its own: it moves with item 1, and needs the exit re-run on the fixed prompt and graders. No issue yet.
3. **Zero safety violations.** [#362](https://github.com/nick-delgado/serverless-ai-scheduling/issues/362) (`no_invented_providers` reads "Dr. Okafor's" as an unknown provider) and #347 again (the grader counts a refused call as a violation), plus [#346](https://github.com/nick-delgado/serverless-ai-scheduling/issues/346) (L1 format checks read text written beside a tool call).
4. **Cancel without rebooking.** The PRD's v1 non-goal, a "could" for v1.1: today the agent escalates it (PRD §2). No issue yet.

Engineering, cheaper, safer or more measurable:

5. **Know what an experiment cost.** Per-purpose spend: either application inference profiles or IAM-principal cost tracking, the two routes the backstop entry names, so the next version of this entry reads a number instead of a residual ([entry](2026-10-20-the-spend-backstop-covers-voice-not-bedrock.md)). No issue yet; it is a non-goal of #45.
6. **Let the judge fail trials, if it earns it.** [#335](https://github.com/nick-delgado/serverless-ai-scheduling/issues/335) decides whether the judge may fail trials now that it agrees with Nick; [#351](https://github.com/nick-delgado/serverless-ai-scheduling/issues/351) calibrates it on a set with human-failed replies.
7. **Keep standing envs bookable without manual seeding.** [#325](https://github.com/nick-delgado/serverless-ai-scheduling/issues/325) tops slots up automatically; [#286](https://github.com/nick-delgado/serverless-ai-scheduling/issues/286) is the smaller version for `demo`'s four-week window.
8. **Make the cheaper models runnable, then re-run the matrix.** [#246](https://github.com/nick-delgado/serverless-ai-scheduling/issues/246) (Nova 2 Lite at `high`) and [#247](https://github.com/nick-delgado/serverless-ai-scheduling/issues/247) (gpt-oss-20b's invented tool names); they would let the next matrix measure the non-Claude models' own cost, which this entry's bill can't separate from the simulator and judge. Mutation testing on demand, [#169](https://github.com/nick-delgado/serverless-ai-scheduling/issues/169), waits on Stryker supporting Vitest 5.

## Evidence

- Billed figures: [#45 comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/45#issuecomment-6341441996), Nick's table from Cost Explorer's daily report, 2026-09-27 to 2026-10-22 (the 22nd partial), retyped and rounded to cents. The agent derived the subtotals; arithmetic: usage 193.28 + 23.40 + 11.15 + 0.38 = 228.22 (from unrounded rows, 228.217); idle 0.23 + 0.02 + 0.01 = 0.26 (0.2584); with tax 228.4755 + 21.12 = 249.5955; the tax by service is Nick's table on the same comment.
- Eval ledger: each row's linked entry or comment; sum 115.87 over 38 rows, from the rows as quoted (rows that name several runs are the sum of those figures). Sources that name a cost: the journal entries linked in the ledger and, for the judge calibration, `6ee1591`, `6fc8c2a` and `ef90f9f`; the commit messages that record a cost (`e49d9e9`, the post-fix L1 run's $0.38, `6ee1591`) repeat figures the entries already give.
- Residual: 228.22 - 115.87 = 112.35. Build recorded inside it: 0.86 + 0.047 + 0.1220 + 0.13 + 0.16 = 1.32, leaving 111.03 with no record.
- Prices: `packages/agent/src/profiles.ts`, `PRICES_AS_OF = "2026-09-29"`; the harness figures are list-price estimates, not bills.
- Count of `evals.yml` workflow runs: `gh run list --workflow evals.yml --limit 400 --json conclusion,createdAt`, 223 on 2026-10-22.
- No credit rows in the export; no account ID, screenshot or export file in the repo.

## What's next

- #43 turns this entry and the exit table into the README story; Chapter 6 links here.
- Re-measure idle in a month with no development traffic, when `demo` is the only env standing.
