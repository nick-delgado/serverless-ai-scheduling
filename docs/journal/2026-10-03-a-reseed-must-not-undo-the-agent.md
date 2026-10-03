# 2026-10-03 — A re-seed must not undo what the agent booked, so the data seed only adds what's missing

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #14 (S2-02), #12 (S1-01), #13 (S2-01), #36 (M3-01), ADR-004, ADR-005

## What happened

S2-02 added `scripts/seed-data.ts`. It loads the `clinic-default` fixture into an env's table: 8 providers, 4 weeks of slots starting today, a `PATIENT#<sub>` profile for each patient in the Cognito mapping from `seed-users.ts`, and the fixture's sample appointments. Every fixture patient ID is rewritten to the patient's `sub`. The tests run against DynamoDB Local. It hasn't run against `dev` yet: that writes to a shared table, which needs Nick's OK.

## Why we chose what we chose

**A normal run only adds what's missing (a decision the spec left open).** The issue asked for "idempotent, re-running doesn't duplicate". `writeSeed` (#13) does unconditional puts, so the simple version is idempotent on the same day. But it breaks in two ways once the env is in use:

- A re-run would write every slot as the fixture has it, so a slot the agent had booked since would become OPEN again. Its appointment would still say BOOKED, and that slot could be booked twice.
- The fixture places appointments relative to the base date, and the base date is "today". So on a later day, the same appointment ID lands on a different slot. Re-putting it would move the appointment, and its old slot would stay BOOKED, held by an appointment that no longer points at it.

So the script reads the seed-owned partitions first and writes only the slots and appointments that aren't stored yet. Provider and patient profiles are rewritten with the same content, and a profile keeps its stored `createdAt`. A BOOKED fixture appointment is added only if its slot isn't stored yet. A slot whose appointment was skipped is written OPEN. The subset still goes through `writeSeed`, so `validateSeed` checks every write against the booking invariants. The other option was to refuse any run against a non-empty table unless `--reset` was given. That's safer to reason about, but rolling the window forward would then always wipe the agent's bookings.

**Other choices the spec left open:**
- "Today" is the clinic-local date (America/New_York), not the UTC date and not this week's Monday. At 10 PM in New York it's already tomorrow in UTC, and a seed run then would otherwise skip a whole clinic day.
- Fixture patients with no mapping row are skipped, with their appointments, and the slots those held are written OPEN. Keeping them under their fixture IDs would put profiles in the table that no Cognito user can reach, and leave fixture IDs in a deployed table.
- `--reset` deletes the fixture providers' partitions (profiles and all slots) and each mapped patient's profile and appointments, agent-made ones too. It keeps conversations. It confirms by asking for the table name, or takes it as `--confirm <table-name>`. Without either, for example with no terminal, it refuses before reading the table.
- The table name comes from SSM `/sched/<env>/data/table-name`. The mapping must belong to the env's current User Pool (`/sched/<env>/auth/user-pool-id`), so subs from a deleted pool are never written. `--env` is required, with no default, because this script writes to shared data.

## What surprised us

Two of my 47 deliberate breaks stayed green at first. The first was not reopening the slot of a skipped appointment. My "later day" test re-ran the seed 6 days later, and every fixture appointment's new slot was still inside the first run's window, so it already existed. Only a run weeks later reaches a new slot, and the test now does that. The second was ignoring the CLI's injected clock: no test asserted the date it produced.

The DynamoDB Local tests also failed once out of three runs on a busy machine. Each seed writes about 2,900 items in batches of 25, which can take longer than Vitest's 5-second default timeout. The suite now allows 60 seconds per test.

## Evidence

- `scripts/seed-data.test.ts`: 25 tests, 13 of them against DynamoDB Local.
- 47 breaks to `scripts/seed-data.ts` in the first round. Each one turned at least one test red after the two tests above were added.
- The review of PR #117 found three gaps. The `--reset` delete loop, the SSM reader and the client wiring were checked only by hand. "Never overwrites a booking" booked a slot the second run never wrote, so it couldn't catch an overwrite. The "refuses" test compared only item counts. I made the adapters injectable, added stub tests and a reset test for unmapped patients, and moved the agent-booked slot inside both runs' windows. Then I ran 24 more breaks, and each one turned a test red. They covered the retry, the attempt cap, the backoff, the batch size, the SSM name, the empty-value check, the region default, `AWS_REGION`, the endpoint wiring, the slot filter, the confirmation order, and a reset that deletes unmapped patients.

## What's next

- The first `dev` load. Nick approved a normal run (no `--reset`), and the orchestrator runs it after the review fixes; its counts go in PR #117.
- For #36 (M3-01): the seeded `dev` window starts on the run date, not the eval base date (2026-10-05), so deployed data matches the in-memory fixture in shape, not in dates or patient IDs.
