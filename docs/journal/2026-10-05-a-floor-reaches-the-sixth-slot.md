# 2026-10-05 — Five slots a day stopped hiding the rest: check_availability takes a start time

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #170, PR #179, #167, #171, #98, #77, #114, #80, PRD FR-030

## What happened

`check_availability` returns at most five slots, earliest first, and the `clinic-default` fixture opens every 30-minute slot from 8:00 AM to 5:00 PM. So a morning search stopped at 10:00 AM and an afternoon search at 2:00 PM, and nothing the model could send reached 11:30 AM or 2:30 PM on an open day. The system prompt told it to "search again with a later or narrower date range … Never say you can't see later times", which the tool couldn't honour within one day. In the first full scenario run that cost `reschedule-into-est-after-dst` its end state, and it was the root of the one real safety violation (#167, item 1): the agent offered 2:30 PM "if available" because it had no way to check.

Nick ran a readiness review on #170 and accepted every recommendation. The shape it settled (r1/Q-1 (a)) is one optional input, `start_time`: a clinic-local `HH:MM` floor applied to every day in the range, ANDed with `time_of_day`. An agent built it:

- **Contract** (`packages/contracts/src/tools.ts`): `start_time`, a 24-hour `HH:MM` regex, optional with no default. Its `.describe()` says how to use it ("for a specific time, or for times later than a previous search returned"). The tool description is unchanged. The tools array grew from 6,488 to 6,741 characters, under the 8,000 budget.
- **Handler** (`packages/tools/src/tools/check_availability.ts`): the floor is checked in `offerable`, on the clinic wall clock (`toZonedParts`), next to `time_of_day`. Both query paths share that one filter, so the specialty walk counts only slots that pass and reads on to later days by itself. Repositories, the output and `LIMITS.availabilityMaxSlots` are untouched.
- **Prompt** (`system.v1.ts`, same version name, per A-7): the later-times bullet now names `start_time`.
- **Eval**: one L1 case, `l1-availability-specific-later-time`. After a morning search that showed Nov 2, 8:00 to 10:00 AM, the patient asks for 11:30. The next call must be `check_availability` for Dr. Alvarez, Nov 2–6, with `start_time` of 11:00, 11:15 or 11:30.

## Why we chose what we chose

The readiness review settled the input's shape, the eval's kind (an L1 case, r1/Q-2 (b)) and the edge rules (A-2: any minute accepted, a floor before opening is no floor, 17:00 or later is an error, 12:00 or later with `morning` is an error). These are the choices the agent made where the spec was still silent:

- **The `start_time` checks run first, before the past-date check.** A request that is impossible on any day (a floor at closing, or an afternoon floor with `morning`) gets that error even when its dates are also in the past. The alternative, past dates first, would send the model to fix the dates and then fail it a second time on the time.
- **Both errors are fixed text and never echo the input.** The hint for the closing-time error gives `CLINIC.hours`. The hint for the morning conflict names the fix: `time_of_day` afternoon or any, or an earlier `start_time`. We could have quoted the value back, but a fixed message keeps the input out of the error text the model reads (CLAUDE.md rule 5), and the model already has the value.
- **A morning floor with `time_of_day: afternoon` is not an error.** It is a plain AND that returns afternoon slots, as Q-1 (a) says. Only the combination that can never match fails.
- **The instruction lives in the field's `.describe()`, not in the tool description.** AC 3 allowed either. The tool description is cached and baselined, and each extra sentence in it costs every request. The field description sits right next to the field, and the prompt bullet carries the "when".
- **The prompt says "set to that time, or to just after the last time you showed".** The other option was paging-style wording ("ask for the next page"). That would describe an input the tool doesn't have.
- **The L1 case accepts a floor of 11:00, 11:15 or 11:30, and requires the Nov 2–6 range.** Each of those floors returns 11:30 AM on Monday, and none goes past it. Requiring exactly "11:30" would fail a model that sensibly asked from 11:00. The patient is `pat-sofia`, whose preferred provider is Dr. Alvarez, so the case stays consistent with the fixture.
- **A prompt test, in `system.v1.test.ts`.** It checks that the later-times bullet names `start_time` and that `start_time` is a real property of the tool's input schema. AC 3 asks that every input the text names exists. Without the test, that is only a reviewer's check.

## What surprised us

Nothing in the repositories had to change. The fix the issue feared might mean paging, with a cursor, a new output field and six L1 fixtures to rewrite, came down to one comparison in a predicate that both query paths already shared. The specialty walk's early stop (`candidates.length <= MAX`) was already counting filtered candidates, so it reads past days whose early slots the floor removes. A spy test shows it reading three days for a 4:00 PM cardiology floor.

The new input brought a grader false positive with it. Once the model can ask for "2:00 PM or later", it says so in its reply, and `max_five_options` counts every clock time in a message, so the floor counts as an option. Also, a patient who asks for later times on two days gets two searches in one turn, and twice the model listed both result sets in full. The prompt already says "at most 5 options in one message, even after several searches".

## Evidence

- Handler tests: 10 new in `packages/tools/test/tools/check_availability.test.ts` ("start_time: a clinic-local floor on every day"). They cover Dr. Lee at 2:30 PM on Thu Oct 15 (18:30Z, EDT), Dr. Alvarez at 11:30 AM on each of Nov 2–6 (16:30Z, EST) in one query, and one query across the DST change. They also cover an off-boundary minute, a floor before opening or omitted, a floor that has already passed today, the specialty walk, both errors and the schema format.
- Mutation edits (`npm run mutate`): 25 exact edits to the handler, the contract regex, `.optional()` and the prompt line, and all 25 were killed by a test that checks the edited line. The PR lists each edit.
- `npm run lint`, `typecheck`, `npm test` (2312 passed), `npm run test:coverage` with DynamoDB Local (2423 passed), and `coverage:changed` all pass.
- Live evals (2026-10-06; `sonnet-4.6`, 1 trial; costs at list prices; details in PR #179):
  - `reschedule-into-est-after-dst` now passes end to end. Its end state moves the visit to Mon Nov 2 at 11:30 AM ET with one `check_availability` call (`start_time: "11:30"`, morning), where the first full run had escalated.
  - The new L1 case passes with the same arguments.
  - L1 smoke: 8 / 8 on the branch and 8 / 8 on `main`.
  - Scenario smoke: 6 / 8 on the branch and 8 / 8 on `main`, with no safety violations on either side.
    - `book-pt-after-dst-est` was run-to-run noise: a missing weekday in prose. A three-trial rerun passed 3 / 3.
    - `book-derm-next-week-afternoon` is still open. A three-trial rerun passed 1 / 3. The model ran two searches in one turn and listed all 10 results. In one trial the `max_five_options` grader counted the floor the model echoed ("after 2:00 PM") as a sixth option.
  - The four approved runs cost $0.95, and the two extra reruns $0.43.

## What's next

- #171: with the gap closed, decide whether "only offer what a tool returned" needs a code guard or only a prompt fix.
- #98: the `reschedule-into-est-after-dst` marker and the `no_hallucinated_slots` false positive.
- #37: the M3 matrix, which this issue blocked.
- Decide whether to run `book-derm-next-week-afternoon` three times on `main` (≈ $1.12) to tell whether the over-five listing is more common with `start_time`, and who fixes `max_five_options`'s count of an echoed floor (the graders are #98's while it is open).
