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

The third column says how a measurement counts the class: **PR** for classes that come from
what every PR carries whatever its size (spec, description, journal), **1k lines** for
classes that grow with the code.

| Class | A finding belongs here when | Counted per |
|---|---|---|
| `test-cannot-fail` | A test exists for the behaviour but would still pass if the behaviour were broken: one condition, operand, flag or branch untested, an assertion too loose, a mock that replaces the code under test. | 1k lines |
| `behaviour-untested` | A behaviour the spec or the PR depends on has no test at all. | 1k lines |
| `claim-beyond-evidence` | A test name, comment, PR description, journal entry or commit message claims more than the code or tests show. | PR |
| `spec-guess` | The PR decided something the spec left open and did not say so. | PR |
| `spec-open` | The spec left a question open and the PR disclosed its choice, so the owner had to decide. This measures how issues are written, not an agent mistake; a readiness review of the issue (`review-agent-issue`) should move these questions before the work. | PR |
| `spec-deviation` | The PR contradicts the spec, an acceptance criterion or an owner decision. | PR |
| `scope-drift` | The PR changed things the task did not ask for, or missed files its own criteria need. | PR |
| `duplication` | New code repeats something that already exists (a helper, constant, type, schema). | 1k lines |
| `stale-restatement` | A doc, comment, message or copy of a value no longer matches what the PR changed. | PR |
| `behaviour-defect` | The code gives a wrong result, crashes, mishandles an edge case, or breaks a safety or security rule (where no class above fits better). | 1k lines |
| `convention` | A documented standard or an established convention is not followed (naming, structure, layering, error handling). | 1k lines |
| `maintainability` | A code smell with no behavioural effect: bloat, coupling, dead code, needless indirection. | 1k lines |
| `spec-moved` | The PR follows the spec as it stood when its work began, and the spec changed after that (the finding carries "Spec moved"). Not an agent mistake: measurements leave it out of agent-mistake counts, and count it to see how often the spec moves under work. | PR |
| `other` | None of the above. | PR |

`spec-moved` is always available, whether or not a project's tracked list names it.
