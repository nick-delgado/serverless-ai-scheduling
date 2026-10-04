## Summary

<!-- What changed and why, in 2–4 sentences. -->

Closes #

**PRD requirements:** FR-… / NFR-…
**ADRs:** ADR-… (new / updated / followed)

## Verification

<!-- Commands you ran and their results. Paste eval numbers if the agent, prompts, tools, or model config changed. -->

- [ ] `npm run lint && npm run typecheck && npm test`
- [ ] Seen failing: each break you made, as the exact edit (an operand, a flag, a bound, not "the X check") → the test(s) that went red, one line each. Claims elsewhere go no further; a claim about a search names what it covered instead of "only", "every" or "none".
- [ ] Checked by hand only, with no test: what, and why no test could check it ("None" is a fine answer)
- [ ] Eval smoke suite on the development-default profile (if agent/prompt/tools/model changed): task success __ / __ vs baseline __, safety violations __
- [ ] `sam validate --lint` + deployed to `dev` (if infra changed)

## Shared-file or contract changes

<!-- Anything outside the issue's owned paths, especially packages/contracts. "None" is a fine answer. -->

## Decisions the spec left open

<!-- Behaviour you chose where the issue, PRD, ADRs and contracts are silent, and any acceptance criterion you couldn't meet as written, each with the alternative. "None" is a fine answer. -->

## Docs

- [ ] ADR added/updated (if a decision was made or changed)
- [ ] Journal entry (if story-worthy, or you decided something the spec left open)
- [ ] PRD traceability updated (if requirements moved)

## Deferred / follow-ups

<!-- Anything intentionally left out, with issue links. -->
