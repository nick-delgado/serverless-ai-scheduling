## Summary

<!-- What changed and why, in 2–4 sentences. -->

Closes #

**PRD requirements:** FR-… / NFR-…
**ADRs:** ADR-… (new / updated / followed)

## Verification

<!-- Commands you ran and their results. Paste eval numbers if the agent, prompts, tools, or model config changed. -->

- [ ] `npm run lint && npm run typecheck && npm test`
- [ ] Seen failing: first run `npm run test:coverage && npm run coverage:changed` and give every line it prints a test (or a `/* v8 ignore next -- <reason> */` hint); coverage shows that a line ran, not that a test checks it. Then paste `npm run mutate -- … --markdown` output covering every changed source file. Claims elsewhere go no further; a claim about a search names what it covered instead of "only", "every" or "none".
- [ ] Checked by hand only, with no test: what, and why no test could check it ("None" is a fine answer)
- [ ] Eval smoke suite on the development-default profile (if agent/prompt/tools/model changed): task success __ / __ vs baseline __, safety violations __
- [ ] `sam validate --lint` + deployed to `dev` (if infra changed)

## Shared-file or contract changes

<!-- Anything outside the issue's owned paths, especially packages/contracts, and each copy of existing code with its source, even inside your paths (task-workflow step 5). "None" is a fine answer. -->

## Decisions the spec left open

<!-- Behaviour you chose where the issue, PRD, ADRs and contracts are silent, and any acceptance criterion you couldn't meet as written. List them once, each with the alternative it beat, in the journal entry's "Why we chose" section (a rule for one tool's behaviour stays in its handler header, which the list links), and link that entry here; a second list drifts. "None" is a fine answer. -->

**Departs from or questions an owner decision:** <!-- Each "Decisions and clarifications" item (or PR decision) you think is wrong or couldn't build as written: its ID, why, and what you built. "None" is a fine answer. -->

## Docs

- [ ] ADR added/updated (if a decision was made or changed)
- [ ] Journal entry (if story-worthy, or you decided something the spec left open)
- [ ] PRD traceability updated (if requirements moved)

## Deferred / follow-ups

<!-- Anything intentionally left out, with issue links. -->
