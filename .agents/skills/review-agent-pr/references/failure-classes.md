# Failure classes

A failure class names **what went wrong** in the code, where a cause (see
`cause-taxonomy.md`) names **why**. Causes drift as a project's instructions change: the
same failure can be a "missing instruction" one week and an "agent lapse" the next, after
a rule for it is written. A failure class stays put, so it is what the project counts to
see whether a change to its agent setup worked.

The project's tracked classes are listed in the latest batch record on its tracking issue
(section "Tracked failure classes"), maintained by `improve-agent-process`. Until a project
has its own list, use this one. Tag every finding with exactly one class; use `other` when
none fits, and never invent a class in a review: new classes are added by
`improve-agent-process`.

| Class | A finding belongs here when |
|---|---|
| `test-cannot-fail` | A test exists for the behaviour but would still pass if the behaviour were broken: one condition, operand, flag or branch untested, an assertion too loose, a mock that replaces the code under test. |
| `behaviour-untested` | A behaviour the spec or the PR depends on has no test at all. |
| `claim-beyond-evidence` | A test name, comment, PR description, journal entry or commit message claims more than the code or tests show. |
| `spec-guess` | The PR decided something the spec left open and did not say so. |
| `spec-deviation` | The PR contradicts the spec, an acceptance criterion or an owner decision. |
| `scope-drift` | The PR changed things the task did not ask for, or missed files its own criteria need. |
| `duplication` | New code repeats something that already exists (a helper, constant, type, schema). |
| `stale-restatement` | A doc, comment, message or copy of a value no longer matches what the PR changed. |
| `behaviour-defect` | The code gives a wrong result, crashes, mishandles an edge case, or breaks a safety or security rule (where no class above fits better). |
| `convention` | A documented standard or an established convention is not followed (naming, structure, layering, error handling). |
| `maintainability` | A code smell with no behavioural effect: bloat, coupling, dead code, needless indirection. |
| `other` | None of the above. |
