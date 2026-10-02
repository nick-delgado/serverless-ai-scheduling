# 2026-10-02 — The patient ID is a `sub` Cognito picks, so seeding users comes before seeding profiles

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #12 (S1-01), #14 (S2-02), #25 (S1-02), #29 (S6-02), ADR-005, ADR-006, PRD FR-001–FR-003

## What happened

S1-01 finished the auth stack. `sched-dev-auth` already had the User Pool and the SPA client from #6, and the deployed API's authorizer and a dev test user depended on them. The agent added a Cognito Identity Pool, its authenticated role, and `/sched/<env>/auth/identity-pool-id`. The role's only permission is `transcribe:StartStreamTranscriptionWebSocket`. Before deploying, the agent previewed the change set and checked that neither the pool nor the client would be replaced. Then it wrote `scripts/seed-users.ts`, which creates the six synthetic fixture patients as Cognito users and writes a git-ignored file mapping each one to its Cognito `sub`.

## Why we chose what we chose

**The mapping exists because we can't choose the `sub`.** The API reads the patient ID from the verified token's `sub` (CLAUDE.md rule 1, ADR-005). Cognito generates that value, and nobody can set it. The fixture gives Maria a fixed UUID (`3f6c…9e01`) that the evals rely on, but her deployed patient ID is whatever `sub` Cognito gave her. So `.seed/cognito-users.<env>.json` maps the fixture alias and fixture patient ID to the `sub`, and the data seed (#14) rewrites the fixture's patient IDs from it. In-memory evals keep the fixed IDs.

**Profiles stay with #14 (a decision the spec left open).** ADR-005 says `seed-users.ts` also writes each `PATIENT#<sub>` profile, but the issue gives that to S2-02, and `scripts/seed-data.ts` is #14's path. The agent followed the issue: one script owns Cognito and the other owns the table, with the mapping file between them. The other option was to have this script write the profiles too. Then two scripts would write patient rows.

**Other choices the spec left open:**
- Usernames are `<first>.<last>` (`maria.santos`). The users have no email attribute, because the repo is public and recovery is admin-only.
- A patient is seeded only when `.env` sets their `DEMO_PASSWORD_<NAME>`. A misspelled variable name is an error, so a typo can't skip a user without anyone noticing. The script checks passwords against the pool's policy before it calls AWS, and errors name the variable, never the value.
- Running it again is safe. An existing user keeps its `sub`, and its password is reset to the one in `.env`, so changing a demo password means editing `.env` and re-running.
- The Identity Pool disables the classic flow, so the browser can't ask for a role. It turns on `ServerSideTokenCheck`, so a signed-out user can't get new credentials.

## What surprised us

The change-set preview had a `Modify` on every existing resource, including the User Pool. All of them came from stack tags: `deploy.sh` stamps `git-branch` and `git-commit` on each deploy, and those tags reach every resource (`RequiresRecreation: Never`). One `Modify` looked worse: `UserPoolArnParam` showed a change to its `Value` as well. That comes from `!GetAtt UserPool.Arn`. CloudFormation can't resolve an attribute of a resource it's updating, so it marks the value as possibly changed. The ARN didn't change.

A smaller one: Identity Pool names can't contain hyphens, and `Env` can (`pr-52`). The name is built as `!Join ["_", !Split ["-", …]]`.

## Evidence

- Change-set preview: four `Add`s (IdentityPool, IdentityPoolRoles, TranscribeBrowserRole, IdentityPoolIdParam), and five `Modify`s, all `Replacement: False`.
- Live checks on dev, with tokens and passwords never printed:
  - all six demo users signed in with USER_SRP_AUTH, and each ID token's `sub` matched the mapping;
  - a second run reported `exists` for every user with the same subs;
  - `GetId` without a login returned `NotAuthorizedException`;
  - with Maria's ID token, the pool issued credentials for `sched-dev-auth-TranscribeBrowserRole-*`;
  - with those credentials, `ssm:GetParameter` and `dynamodb:DescribeTable` both returned `AccessDeniedException`.
- Mutation checks: weakening the password policy, removing the typo check, keeping mapping rows from a recreated pool, skipping the permanent password, and logging the password each make a `scripts/seed-users.test.ts` test fail.

## What's next

- #14 reads `.seed/cognito-users.<env>.json` to key `PATIENT#<sub>` profiles.
- #29 is the first real `StartStreamTranscriptionWebSocket` call. The permission this role allows hasn't been exercised yet; so far only the denials have.
