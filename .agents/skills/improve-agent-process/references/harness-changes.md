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

| ID | Version | Change | Kind | Skill | Target |
|---|---|---|---|---|---|
| H1 | 2026.10.06 | Exchange contract: every hand-off validated; counts and findings.json written by script | guardrail | review-agent-pr, review-agent-issue | none |
| H2 | 2026.10.06 | Readiness answers applied by script from Decision lines only; `ALL` leaves the riskiest assumptions to explicit answers | guardrail | review-agent-issue | spec-deviation, spec-guess |
| H3 | 2026.10.06 | Readiness format: designs the work must produce are questions; fewer, checkable assumptions; reuse as import / move and share / ask; one-story consistency pass | words | review-agent-issue | spec-guess, duplication |
| H4 | 2026.10.06 | Spec moves listed in the manifest; "Spec moved" findings classed `spec-moved` and left out of agent counts | guardrail | review-agent-pr | spec-deviation |
| H5 | 2026.10.06 | Related upcoming issues: suggestions kept consistent with them; "Defer to #N" option under guardrails | words | review-agent-pr, address-pr-review | overridden |
| H6 | 2026.10.06 | Cost of each review recorded where the runtime reports it | guardrail | review-agent-pr | none |
