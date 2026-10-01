# Cause taxonomy

The causes the root-cause analyst may assign. Each needs the evidence listed; without it,
choose a different cause or lower the confidence.

| ID | The agent went wrong because... | Evidence required | Usual remedy |
|---|---|---|---|
| `missing-instruction` | nothing in the project told it the right way | A documented search of the process inventory that finds no guidance on the point | Add the rule where it is loaded automatically, or add a guardrail |
| `ambiguous-instruction` | the guidance exists but can reasonably be read the way the agent read it | The quote, plus the reading that produces the agent's result | Rewrite the sentence; add an example of right and wrong |
| `conflicting-instructions` | two sources say different things | Both quotes | Remove one, or state which wins |
| `wrong-or-stale-instruction` | a doc, skill or template tells it to do what it did, and that is no longer right | The quote, plus the evidence that it is outdated (current code, a later ADR) | Correct or delete the instruction |
| `undiscoverable-context` | the right guidance exists, but not where the agent would load or find it | The guidance's location, and the absence of any pointer to it from an auto-loaded file or a matching skill description | Link it from the instruction file; move it; fix the skill's description |
| `spec-gap` | the issue or spec left a decision open, and the agent guessed | The spec's silence or ambiguity on the point, quoted in context | Tighten the issue template; add acceptance criteria; instruct the agent to ask |
| `misleading-precedent` | existing code models the wrong pattern, and the agent copied it | The existing code that does the same thing, `path:line` | Fix or mark the precedent; name the canonical example in the docs |
| `missing-guardrail` | nothing mechanical stopped it, though something could have | The check that would have failed, and its absence from the CI and lint config | Add the test, lint rule, type or CI check |
| `task-too-broad` | the task bundled too much for one PR, and quality fell across it | PR size and spread against the issue's scope; several unrelated requirement groups | Split issues; add a planning or decomposition step |
| `skill-not-triggered` | a project skill covers this, but was evidently not used | The skill, the mismatch between its description and the task, and output that contradicts it | Rewrite the skill's description; reference it from the instruction file |
| `agent-lapse` | the instruction was clear, in its path and unambiguous, and it did not follow it | The quote, its auto-loaded location, and the absence of any conflict or ambiguity | A guardrail. More prose rarely helps; if the instruction file is long, shortening it may |

## Choosing between neighbours

- **missing vs undiscoverable:** search the whole repository, not only the instruction
  files. If the rule exists anywhere, it is `undiscoverable-context`.
- **ambiguous vs agent-lapse:** write down the reading that leads to the agent's output. If
  it needs a strained interpretation, it is a lapse.
- **misleading-precedent vs missing-instruction:** when both hold, precedent is primary.
  Agents weight nearby code more heavily than distant prose.
- **spec-gap vs scope-creep findings:** a gap explains a guess about something the task
  required. It does not explain work nobody asked for.
- **missing-guardrail** is a contributing cause of almost everything detectable. Make it
  primary only when no instruction-level cause applies.
