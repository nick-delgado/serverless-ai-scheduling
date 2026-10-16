# Harness changes

Changes to the review harness itself (`review-agent-pr`, `address-pr-review`,
`review-agent-issue`, `improve-agent-process`), recorded like a project's batch rows so
they can be measured the same way. The harness's maintainers add a row for each change
that could move a count; `improve-agent-process` measures them (step 2), splitting the
reviews by the harness version on each data line instead of by when work began.

A target is a failure class, or a reviewer signal (step 3): `rejected` (share of reported
findings the verifier rejected), `overridden` (owner decisions against the
recommendation), `disputed-upheld` (disputes a later round agreed with), `fix-introduced`
(defects introduced by a suggested fix), `late-find` (findings in code an earlier round
passed), `rounds` (review rounds per PR), `cost` (tokens per review). `none` means the
change is mechanics that no count measures; it is listed so the record is complete.

A reviewer change can move a count either way: one that makes the reviewer see more (say,
reading the whole spec) raises its target's count in first reviews. Such rows say
"expected: up"; measure them against reviewer signals (`late-find`), and split project
measurements at their version.

| ID | Version | Change | Kind | Skill | Target |
|---|---|---|---|---|---|
| H1 | 2026.10.06 | Exchange contract: every hand-off validated; counts and findings.json written by script | guardrail | review-agent-pr, review-agent-issue | none |
| H2 | 2026.10.06 | Readiness answers applied by script from Decision lines only; `ALL` leaves the riskiest assumptions to explicit answers | guardrail | review-agent-issue | none (mechanics: how answers are applied, not whether they are right; was spec-deviation, spec-guess until 2026.10.08) |
| H3 | 2026.10.06 | Readiness format: designs the work must produce are questions; fewer, checkable assumptions; reuse as import / move and share / ask; one-story consistency pass | words | review-agent-issue | spec-guess, duplication |
| H4 | 2026.10.06 | Spec moves listed in the manifest; "Spec moved" findings classed `spec-moved` and left out of agent counts | guardrail | review-agent-pr | spec-deviation |
| H5 | 2026.10.06 | Related upcoming issues: suggestions kept consistent with them; "Defer to #N" option under guardrails | words | review-agent-pr, address-pr-review | overridden |
| H6 | 2026.10.06 | Cost of each review recorded where the runtime reports it | guardrail | review-agent-pr | none |
| H7 | 2026.10.06.1 | Table cells with an escaped pipe (`\|`) parsed whole (readiness apply, decisions, validators, findings.json) | guardrail | review-agent-issue, review-agent-pr | none (bug fix) |
| H8 | 2026.10.06.2 | Spec files read to their last line, checked against "(read to line n of n)"; long output read from files in ranges | guardrail | review-agent-pr, review-agent-issue | spec-guess, spec-deviation (expected: up); late-find |
| H9 | 2026.10.06.3 | Linked issues saved as trimmed background (no tracking issue, no PR review traffic), searched rather than read whole | guardrail | review-agent-pr, review-agent-issue | cost |
| H10 | 2026.10.06.3 | Readiness: prescribed read-only commands run first; edits and assumptions checked against instruction-file rules; option text claims only what it covers; placements marked required or suggestion | words | review-agent-issue | spec-deviation, spec-guess, claim-beyond-evidence |
| H11 | 2026.10.06.3 | CI summary drops cancelled check runs that a later run of the same check replaced | guardrail | review-agent-pr | none (bug fix) |
| H12 | 2026.10.08 | Readiness apply keeps what it dropped: edits that add `##` sections, each assumption's "Makes stale" lines, the Reuse pointers, the options not chosen | guardrail | review-agent-issue | spec-deviation, duplication, stale-restatement |
| H13 | 2026.10.08 | Readiness questions carry a required "Edges" line (boundaries, concurrent calls, edit-and-assumption cases, evidence artifact, complete or minimum lists), checked and copied into the issue | guardrail | review-agent-issue | spec-guess, spec-open (escaped questions) |
| H14 | 2026.10.08 | Only files relied on as a whole are read to their end (brief, manifest, the task's own spec for the spec-working readers); cost recorded by phase | guardrail | review-agent-pr, review-agent-issue | cost |
| H15 | 2026.10.08 | Decided options test every branch they add; fixes that set a number name the numbers it must agree with | words | address-pr-review, review-agent-pr | fix-introduced |
| H16 | 2026.10.08 | Measurement: denominator per class, a within-chance check, no verdict across an "expected: up" reviewer change | guardrail | improve-agent-process | none (measurement) |
| H30 | 2026.10.15 | Fewer resends: the read extent is required only from the reviewers that work from the spec; ambiguous citations name their candidates (and the verifier writes full paths); a read count one past the end is accepted; resends get their own cost line; the read-only rule is stated by purpose (no executing project code or tooling; text tools allowed) | guardrail, words | review-agent-pr, review-agent-issue | cost |
| H29 | 2026.10.15 | Broad test names: `broad-test-names.sh` lists the names a fix round added that claim more than one case, and `post-response.sh` refuses a response that does not address each. H23's wording failed | guardrail | address-pr-review | claim-beyond-evidence |
| H28 | 2026.10.15 | Readiness verifier checks each option's summary against its edges, the criteria it narrows and the tools it prescribes | words | review-agent-issue | spec-deviation, spec-guess |
| H27 | 2026.10.15 | Readiness apply keeps nested "Edges" and "Makes stale" bullets, and reads markers in the ID column ("A-4 (verify first)") | guardrail | review-agent-issue | none (bug fix) |
| H26 | 2026.10.11.1 | Regression tests for the harness's scripts (33 cases, offline, on Linux and macOS in CI), from the real rounds and runs that exposed each bug; the contradiction check no longer flags text that covers each option in turn | guardrail | all | none (harness quality) |
| H25 | 2026.10.11 | Read-only rule names the commands it forbids (`npx`, `tsx`, scripts, package managers); re-check verifiers' cost recorded; read-to-the-end counts accept the last non-blank line | words, guardrail | review-agent-pr, review-agent-issue | none (bug fix) |
| H24 | 2026.10.11 | Validation stamp: the assembly script refuses a verified.md or root-cause.md that has not passed validation as it is now | guardrail | review-agent-pr | none (mechanics) |
| H23 | 2026.10.11 | Fix rounds: break comparisons at their boundary and swap the values a decision reads; decisions carried out as tests follow the test rules; search before naming who uses something; correct every record the PR adds. H15's wording failed | words | address-pr-review | fix-introduced, test-cannot-fail, claim-beyond-evidence, stale-restatement |
| H22 | 2026.10.11 | Readiness: prescribed checks quote an input they must reject; "stays as is" cites its search; measured criteria say where the number is seen | words | review-agent-issue | spec-guess, test-cannot-fail |
| H21 | 2026.10.11 | Readiness: each question carries a required "Makes stale" line; owned paths widened by line numbers are rejected (whole files, with their follow-on edits) | guardrail | review-agent-issue | stale-restatement, scope-drift |
| H20 | 2026.10.11 | Readiness apply: qualifiers between owned paths no longer end the list; "reopens"/"replaces" mark every entry form superseded; reuse pointers moved to "Readiness notes", out of the owner's decisions; paths and text written for an option not chosen are flagged to check | guardrail | review-agent-issue | spec-deviation |
| H19 | 2026.10.08.2 | Readiness apply adds every path of an "Owned paths: +" list (not only the first), skips paths already listed, and treats "nothing (…)" stale cells as nothing | guardrail | review-agent-issue | none (bug fix) |
| H18 | 2026.10.08.1 | Run record per review round: orchestrator and each subagent's model, effort, tokens and time, in `run.json`, the report's cost table and a hidden run line; labelled comparison runs; model choice per run | guardrail | review-agent-pr, improve-agent-process | none (measurement) |
| H17 | 2026.10.08 | Fixes: CI summary groups runs by check, workflow and event; findings.json without root-cause.md; "None." minor-table row; tracked classes from tables and lists; line counts by either wc or awk | guardrail | review-agent-pr, review-agent-issue | none (bug fix) |
