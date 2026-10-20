# Security review (M3-04, #39)

The M3 security review audits the running system against [ADR-009](../adr/0009-safety-and-privacy.md) as amended, NFR-004, and the policy lines that [`packages/evals/scenarios/README.md`](../../packages/evals/scenarios/README.md) routes here. The owner settled the review's shape in readiness review r1 on #39. This doc follows those decisions:
- what this PR could fix (Q-1 (a));
- which principals it covers and when a `*` is avoidable (Q-2 (a));
- how it verified, with static checks plus an ephemeral env (Q-3 (a));
- escalation retention, audited and filed (Q-4 (a));
- `errorSummary` keeps only AWS SDK messages (Q-5 (b));
- a whole-codebase checklist instead of `/security-review` (Q-6 (a));
- this checklist shape (Q-7 (a)).

- **Reviewed:** 2026-10-15, against `main` at `c05cb79`, with the fixes in `572297e` on `docs/39-security-review`.
- **Environments:** read-only checks on `dev`; live checks on the ephemeral env `sched-sec39-*`, deployed from `572297e` with `scripts/deploy.sh all sec39 -- DailyTurnCap=1`. It cost about $0.03 of Bedrock for one turn. With Nick's approval, it was torn down on 2026-10-15 (all four stacks deleted).
- **Who:** the `task-worker` agent ran every check below as the `SchedDeployer` SSO role. It made no IAM read calls, by assumption A-2.

Placeholders follow ADR-009: `<ACCOUNT_ID>` and `<SES_IDENTITY>` stand for values this public repo never holds.

**Statuses:** **holds** (with its evidence); **fixed** (in this PR, commit `572297e`); **follow-up #N**; **accepted** (with the reason and who accepted it).

**Severities (Q-7 (a)):**
- **high:** a patient can reach another patient's data, or patient or model text reaches a log;
- **medium:** a grant broader than the workload needs;
- **low:** an unused or ceiling-only grant, or a doc that's out of date.

## 1. Checklist

### ADR-009 "Data" (`docs/adr/0009-safety-and-privacy.md:21-23`)

| Line | Status | Evidence |
|---|---|---|
| Synthetic data only; the UI shows a "demo, not a real clinic" banner | holds | `apps/web/src/app/DisclaimerBanner.tsx:2`; fixtures in `packages/tools` (`buildClinicFixture`); the scenario lint rejects unknown entities (`packages/evals/scenarios/README.md`, "Synthetic data only"). The secrets scan (§4) found no real address, account ID or key in any tracked file or commit. |
| Conversation messages are kept for 30 days (TTL) | holds | `packages/tools/src/repos/dynamo/items.ts:31` (`MESSAGE_TTL_DAYS = 30`), `:129` (conversation meta), `:151` (messages); traces `services/api/src/lib/dynamo-turn-store.ts:79`; TTL on `expiresAt` at `infra/stacks/data.yaml:43-45`. Escalations now expire too (`:37` `ESCALATION_TTL_DAYS`, `:163`; F-10, fixed by #271); PITR (35 days) probably keeps expired items restorable for its window, which ADR-009's 2026-10-19 amendment marks as an inference. |
| No audio is stored (ADR-006) | holds | The browser streams audio straight to Transcribe with Identity Pool credentials (`apps/web/src/voice/transcribe/streamClient.ts`). `TranscribeBrowserRole` can only call `transcribe:StartStreamTranscriptionWebSocket` (`infra/stacks/auth.yaml:115-118`), and no API route accepts audio (`infra/stacks/api.yaml:369-390`). |
| CloudWatch logs carry IDs, timings and token counts, not message text | fixed | Live: the marker check found 0 hits (§3). `dev`: 0 hits for the fixture names (§3). One code path could log free text: `errorSummary` logged any error's message (F-21, high). It now logs a message only for AWS SDK errors (`services/api/src/lib/log.ts:22-37`, commit `572297e`, r1/Q-5 (b)). |

### ADR-009 "Identity and authorization" (`:26-29`)

| Line | Status | Evidence |
|---|---|---|
| The patient ID comes from the JWT only; no tool can read another patient's data | holds | `patientIdFromEvent` reads only `requestContext.authorizer.claims.sub` (`services/api/src/lib/request.ts:23-26`). The executor injects it (`packages/tools/src/registry.ts:144`), and no tool input schema has `patientId` (`git grep patientId packages/contracts/src/tools.ts`: no match). A request without a verified `sub` gets 401: tests `chat-turn.test.ts` "refuses a request without a verified patient with 401, before reading anything or checking the body" and `session.test.ts:353`. The evals cover it under `adr9.identity-from-jwt`. |
| Conversation ownership is checked against the JWT `sub` in the data layer | holds | `packages/tools/src/repos/dynamo/repositories.ts:517` (`ConditionExpression: "patientId = :sub"` on append), `:568` (a read with any foreign item returns nothing), `:599` (escalation). Tests: `services/api/test/chat-turn.test.ts:329` "never reads or extends another patient's conversation: it starts a new one instead" and `:981`. |
| Lambda roles are least-privilege (ADR-010's `bedrock:InvokeModel*`; the 2026-10-03 and 2026-10-04 amendments) | fixed | The chat role named `index/*` and `anthropic.claude-sonnet-4-6*`. Both are now exact (F-1, F-2, commit `572297e`), with new pins in `services/api/test/api-template.test.ts` ("lets the chat role make item reads and conditional writes on the base table and GSI1 only" and "names every model ARN exactly: no wildcard but the region of a foundation model (#39)"). Tables per principal are in §2. |

### ADR-009 "Cost and abuse" (`:41-44`)

| Line | Status | Evidence |
|---|---|---|
| API Gateway stage throttling | accepted: owner decision r1/Q-1 (a) on #273 (F-12) | Rate 5, burst 10 on `*/*` in `infra/stacks/api.yaml:355-359`, pinned by `api-template.test.ts` "throttles every method of the stage at rate 5 and burst 10". Deployed on `dev` and `sec39` as rate 5.0, burst 10 (`apigateway get-stage`). Live, paced load trips it, but a simultaneous burst of 30 gets no 429 (§3, F-12, F-15). #273's re-check on `ab273`, after #272 raised the Lambda quota to 1000, got the same shape: no 429 for either simultaneous burst of 30, 429s for paced load ([journal 2026-10-16](../journal/2026-10-16-five-chat-turns-at-once.md)). |
| A per-patient cap on agent turns per day (50), enforced in the chat handler | holds | `DailyTurnCap` defaults to 50 (`infra/stacks/api.yaml:27-31`) and reaches the function as `DAILY_TURN_CAP` (`:116`), pinned by `api-template.test.ts` "caps each patient at the handler's default of 50 turns a day, and passes the cap to the chat function". Deployed: `dev` 50, `sec39` 1 (`lambda get-function-configuration`). The rules are pinned by the tests in A-5: `turn-store.test.ts:28`; `dynamo-turn-store.local.test.ts:53-70` (concurrency); `chat-turn.test.ts:865` (replays don't count); `errors.test.ts:40-44` (the cap's message); `chat-turn.test.ts:455` "enforces the daily turn cap per patient and per clinic day" (429 with `RATE_LIMITED`). Live on `sec39`: 200, then 429 `RATE_LIMITED` (§3). |
| An env-wide cap on new turns per day (200 by default; #356), counted with the patient's in one transaction before any model call | holds | `EnvDailyTurnCap` defaults to 200 (`infra/stacks/api.yaml:34-39`) and reaches the function as `ENV_DAILY_TURN_CAP` (`:117`), pinned by `api-template.test.ts` "caps the whole env at 200 turns a day unless it overrides, …". The rules are pinned by `chat-turn.test.ts` "handleChatTurn: the env-wide daily turn cap" (the boundary, the env's own message, replays and re-runs uncounted), `errors.test.ts` "FAILURES.envCap" and the race in `dynamo-turn-store.local.test.ts` (N-1 of N used, two patients at once: one counted, one refused, the refused patient's count unchanged). Live check (2026-10-20, about 14:05 ET, against `0de35f2`, ephemeral env `cap356` deployed with `EnvDailyTurnCap=2`): patient A got 200, patient B got 200, patient A's second new turn got 429 `RATE_LIMITED`, `retryable: false`, with the env-cap text and no front-desk number. The table afterwards held env `TURNS#2026-10-20` turns=2 and turns=1 for each patient, so the refused turn used up neither the env's count past 2 nor patient A's. The three turns were sequential, so no `TransactionConflict` was expected or seen. |
| An agent-loop iteration cap (ADR-001) | holds | `packages/agent/src/loop.ts:71` (`maxIterations: 8`, `maxToolCallsPerTurn: 16`); `packages/agent/test/loop.test.ts:497` "counts retries as iterations, so a retry can't push the turn past the cap". |
| An AWS Budget alarm (bootstrap stack) | holds | `infra/bootstrap/bootstrap.yaml:215-236` (`sched-monthly`, 80% actual and 100% forecast) and the Bedrock budget (`BedrockBudgetLimitUsd`, `:20`). The deployed bootstrap template matches the repo (§2, A-2). |

### NFR-004 (`docs/PRD.md:126`)

| Clause | Status | Evidence |
|---|---|---|
| Least-privilege IAM | fixed in #270 | §2. Two avoidable `*` fixed in `api.yaml`. Every `*` in the bootstrap stack and `SchedDeployer` has a class, #270's first PR narrowed the avoidable ones, and its second PR split the execution role's F-3 statement into one per service. |
| JWT on every API | holds | Both methods use the Cognito authorizer (`infra/stacks/api.yaml:374`, `:386`). Pinned by `api-template.test.ts` "puts every method of the API behind the Cognito authorizer, which validates this env's user pool" (new: every method under `paths:` must carry `security: - CognitoUserPool: []`, and the authorizer's definition is compared exactly), "routes POST /api/chat through the Cognito authorizer to the chat function" (new) and the session route test. |
| Patient ID only from the token | holds | See the identity row above. |
| No secrets in the repo | holds | §4, row "Secrets in tracked files and git history". The commit author email is metadata, not a file: F-18, accepted by #272. |
| Synthetic data only | holds | See the data row above. |

### Lines routed here by `packages/evals/scenarios/README.md:177`

| Line | Status | Evidence |
|---|---|---|
| "Demo, not a real clinic" banner | holds | `apps/web/src/app/DisclaimerBanner.tsx:2` |
| 30-day message TTL | holds | See the ADR-009 data row. |
| No message text in logs | fixed | F-21; §3. |
| Least-privilege IAM | fixed in #270 | §2 |
| API throttling | accepted: owner decision r1/Q-1 (a) on #273 (F-12) | §3; F-12, F-15 |
| Daily turn cap | holds | §3; the A-5 tests |
| Env-wide daily turn cap | holds | The row above; the #356 tests |
| Loop iteration cap | holds | `loop.ts:71`, `loop.test.ts:497` |
| Budget alarm | holds | `bootstrap.yaml:215-236` |

## 2. IAM, per principal (Q-2 (a))

Each table lists every statement whose action or resource contains `*`.

**How the deployed roles were read (A-2, verify first):** from CloudFormation, not IAM. `aws cloudformation get-template --template-stage Processed` worked for `sched-dev-api`, `sched-dev-auth` and `sched-bootstrap`:
- The `ManagedPolicyArns` SAM attaches are `AWSLambdaBasicExecutionRole` on both functions, plus `AWSXrayWriteOnlyAccess` on the chat function.
- The deployed bootstrap template is the repo's `infra/bootstrap/bootstrap.yaml` byte for byte, except one em dash stored as `?`.
- The deployed `TranscribeBrowserRole` matches `auth.yaml`.

`detect-stack-drift` failed with AccessDenied: `SchedDeployer` has `cloudformation:DetectStackDrift` but not `cloudformation:DetectStackResourceDrift` (F-9). So drift wasn't checked; the processed templates are the evidence. #270's first PR adds `DetectStackResourceDrift` and `DescribeStackDriftDetectionStatus`; the drift run itself waits for Nick's apply.

### Chat function role (`ChatFunctionRole`, `infra/stacks/api.yaml:121-171`)

| Statement | `*` | Class |
|---|---|---|
| `SingleTableItems` | was `…/index/*` | **fixed** (`572297e`): `…/index/GSI1`, the table's only index (`infra/stacks/data.yaml:37`). Live on `sec39`: 4 `Query index=GSI1` calls succeeded under it (X-Ray). Pinned exactly by `api-template.test.ts` "lets the chat role make item reads and conditional writes on the base table and GSI1 only". |
| `InvokeAgentModels` | was `foundation-model/anthropic.claude-sonnet-4-6*` | **fixed** (`572297e`): the exact ID, confirmed with `aws bedrock get-foundation-model --model-identifier anthropic.claude-sonnet-4-6` (it returned that ID and ARN). Live: a `sonnet-4.6` turn on `sec39` completed with 2 model calls. Pinned by `api-template.test.ts` "lets the chat role invoke every entitled profile's model" and "names every model ARN exactly: no wildcard but the region of a foundation model (#39)". |
| `InvokeAgentModels` | region `*` on the four `foundation-model/…` ARNs | **justified**: US cross-region inference profiles route to the foundation model in several US regions. |
| `AWSLambdaBasicExecutionRole` (SAM) | `logs:*` actions on `"*"` | **justified**: SAM's managed policy (Q-2 (a)). The boundary caps it to log writes. |
| `AWSXrayWriteOnlyAccess` (SAM) | `xray:Put*` on `"*"` | **justified**: X-Ray's write actions have no resource-level permissions. |

### Session function role (`SessionFunctionRole`, `api.yaml:329-340`)

| Statement | `*` | Class |
|---|---|---|
| `SessionReads` | none | Pinned exactly (`api-template.test.ts`, "lets the session function read the base table and nothing else"). |
| `AWSLambdaBasicExecutionRole` (SAM) | `logs:*` actions on `"*"` | **justified**, as above. |

### `TranscribeBrowserRole` (`infra/stacks/auth.yaml:93-121`)

| Statement | `*` | Class |
|---|---|---|
| `transcribe-streaming-only` | `Resource: "*"` | **justified**: Transcribe streaming has no resource-level permissions. Only authenticated identities of this env's pool can assume the role (`amr: authenticated`, `aud` = the pool). There is no per-patient cap: F-16, accepted (owner decision r1/Q-3 (a) on #273). |

### CloudFormation execution role (`CfnExecutionRole`, `infra/bootstrap/bootstrap.yaml:80-205`)

| Statement | `*` | Class |
|---|---|---|
| `DynamoDbSchedTables`, `LambdaSchedFunctions`, `LogsSchedLambdaLogGroups`, `CloudWatchSchedAlarmsAndDashboards`, `S3SchedBuckets`, `SsmSchedParameters` | `table/sched-*` (and its indexes), `function:sched-*`, `log-group:/aws/lambda/sched-*`, `alarm:sched-*` and `dashboard/sched-*`, `sched-*` buckets and objects, `parameter/sched/*` | **fixed in #270 (second PR, F-3)**: each keeps its `service:*` action (r1/Q-2 (a)) on resources that carry the `sched-` name. The SSM pattern is `parameter/sched/*` because parameter names start with `/sched/`. |
| `CloudFrontDistributionsAndOacs` | `Resource: "*"` | **justified**: a distribution and an origin access control are named by a generated ID, so no ARN can carry the `sched-` name. The reason is a comment above the statement. |
| `ApiGatewayApis` | `Resource: "*"` | **justified**: a REST API, its stages and deployments are named by a generated ID (the `sched-` name is a property), so no ARN can carry it. The reason is a comment above the statement. |
| `CognitoUserPools`, `CognitoIdentityPools` | `Resource: "*"` | **justified**: `CreateUserPool` and `CreateIdentityPool` take no resource, and the pools' IDs are generated. The reason is a comment above each statement. |
| (dropped in #270) `events:*`, `xray:*`, `ses:*`, `bedrock:GetFoundationModel`, `bedrock:ListFoundationModels` | | **removed**: no stack declares an Events, X-Ray, SES or Bedrock resource (Lambda's `Tracing: Active` and the SES send grant belong to the function's own role, not CloudFormation). An action that takes no resource and that a deploy shows is needed gets its own `"*"` statement then. |
| `CreateWorkloadRolesOnlyWithBoundary` | `role/sched-*` | **justified**: name prefix plus the `iam:PermissionsBoundary` condition. |
| `ManageWorkloadRoles` | `role/sched-*` | **justified**: name prefix. `ProtectBootstrapIdentities` denies the bootstrap and CI roles. |
| `ProtectBootstrapIdentities` | `iam:*` (Deny) | **justified**: a deny. |
| `NoBoundaryRemoval` | `Resource: "*"` (Deny) | **justified**: a deny. |

### Permissions boundary (`WorkloadPermissionsBoundary`, `bootstrap.yaml:41-74`)

| Statement | `*` | Class |
|---|---|---|
| `WorkloadServices` | `Resource: "*"` | **justified**: a ceiling, not a grant. |
| `WorkloadServices` | `bedrock-mantle:CreateInference`, `bedrock-mantle:CountTokens` (no `*`, but unused) | **fixed in #270** (F-4, low; first PR): the boundary no longer lists them. Nothing calls Mantle since ADR-010. |
| `WorkloadServices` | `cloudwatch:PutMetricData`, `dynamodb:DeleteItem`, `BatchGetItem`, `BatchWriteItem`, `DescribeTable`, `ses:SendRawEmail`, `transcribe:StartStreamTranscription`, `ssm:GetParameter`, `GetParameters`, `GetParametersByPath`, `s3:GetObject`, `PutObject`, `lambda:InvokeFunction`, `cognito-identity:GetId`, `GetCredentialsForIdentity` (no `*`; no `sched-*` workload role grants them) | **fixed in #270** (F-23, low; first PR): the boundary's `WorkloadServices` no longer lists any of them: it keeps exactly 14 actions, none of them above. No action above is granted by a workload role: the roles grant only the chat role's five DynamoDB item actions, two Bedrock invokes and `ses:SendEmail` (`infra/stacks/api.yaml:127-171`), the session role's two reads (`:334-340`), Transcribe's WebSocket action (`infra/stacks/auth.yaml:117`), and SAM's log and X-Ray writes. |
| `NeverIamOrAccountLevel` | `iam:*`, `organizations:*`, `account:*`, `sso:*` (Deny) | **justified**: a deny. |

### GitHub OIDC role `sched-github-deploy` (`GitHubDeployRole`, `bootstrap.yaml:295-392`)

| Statement | `*` | Class |
|---|---|---|
| trust policy | none: `sub` is matched exactly | `StringEquals` on this repository, the `dev` environment and `deploy.yml@refs/heads/main` (`bootstrap.yaml:311`). |
| `Identity` | `sts:GetCallerIdentity` on `"*"` | **justified**: no resource-level permissions. |
| `CloudFormationReadAndValidate` | `ValidateTemplate`, `GetTemplateSummary`, `ListStacks`, `ListExports` on `"*"` | **justified**: these actions have no resource-level permissions. |
| `CloudFormationReadAndValidate` | `DescribeStacks` on `"*"` | **fixed in #270** (F-22, low; first PR): `DescribeStacks` takes a stack ARN, and every call the CI roles make names its stack (`scripts/deploy.sh:155`, `sam deploy --stack-name`; SAM's deploy describes the stack it deploys. `scripts/teardown.sh:37` names its stack too, but runs as `SchedDeployer`), so it moved into `CloudFormationDriveDevStacks`. |
| `CloudFormationDriveDevStacks` | `stack/sched-dev-*/*` | **justified**: env prefix, plus the stack ID CloudFormation appends. |
| `ArtifactAndDevSiteBuckets` | `${ArtifactBucket.Arn}/sched-dev-*` | **fixed in #270** (F-24, medium; first PR): `scripts/deploy.sh:157` uploads under `--s3-prefix <stack name>`, so the role's object ARN is `${ArtifactBucket.Arn}/sched-dev-*` and it can no longer overwrite other envs' artifacts. `s3:ListBucket` and `s3:GetBucketLocation` stay on the bucket ARN. |
| `ArtifactAndDevSiteBuckets` | `sched-dev-web-*`, `sched-dev-web-*/*` | **justified**: the bucket name ends in a generated suffix. |
| `SpaInvalidation` | `distribution/*` | **justified**: random distribution IDs; invalidation only (recorded in the template). |
| `SsmBootstrapAndDevParameters` | `/sched/bootstrap/*`, `/sched/dev/*` | **justified**: path prefixes. |

### GitHub OIDC role `sched-github-evals` (`GitHubEvalsRole`, `bootstrap.yaml:398-432`)

| Statement | `*` | Class |
|---|---|---|
| trust policy | `sub` ends in `evals.yml@refs/pull/*/merge` (`StringLike`, `bootstrap.yaml:414-415`) | **justified**: this role has no GitHub environment gate, unlike the other two. The subject pins this repository and the `evals.yml` workflow on a `pull_request` event, and PR numbers can't be listed in advance. The merge ref runs the PR's own copy of `evals.yml` (`.github/workflows/evals.yml:10-11`), so anyone who can push a branch to this repository can run code under the role. The role can only invoke the two eval models (`InvokeEvalModels`). A fork's PR gets no OIDC token, so the gate fails closed (CLAUDE.md). |
| `InvokeEvalModels` | `foundation-model/anthropic.claude-sonnet-4-6` | **fixed in #270** (F-5, medium; first PR): the trailing `*` is gone, as #39 did in `api.yaml`. This role is checked only by the next gated PR's `Eval gate` after Nick's apply (a wrong ARN fails every gated PR's gate until then). |
| `InvokeEvalModels` | region `*` | **justified**, as for the chat role. |

### GitHub OIDC role `sched-github-e2e` (`GitHubE2eRole`, `bootstrap.yaml:439-561`)

| Statement | `*` | Class |
|---|---|---|
| trust policy | `sub` ends in `e2e.yml@refs/heads/*` (`bootstrap.yaml:456`) | **justified**: the subject pins this repository, the `e2e` environment and the `e2e.yml` workflow, and the `e2e` environment's deployment-branch rule decides which branches may run it (r1/Q-2 (b) on #40, recorded at `bootstrap.yaml:434-438`). |
| `Identity` | `sts:GetCallerIdentity` on `"*"` | **justified**: no resource-level permissions. |
| `CloudFormationReadAndValidate` | `ValidateTemplate`, `GetTemplateSummary`, `ListStacks`, `ListExports` on `"*"` | **justified**: no resource-level permissions. |
| `CloudFormationReadAndValidate` | `DescribeStacks` on `"*"` | **fixed in #270** (F-22, low; first PR), as for the deploy role (`CloudFormationDriveE2eStacks`). |
| `CloudFormationDriveE2eStacks` | `stack/sched-e2e-*/*` | **justified**: env prefix. |
| `ArtifactAndE2eSiteBuckets` | `${ArtifactBucket.Arn}/sched-e2e-*` | **fixed in #270** (F-24, medium; first PR), as for the deploy role (`${ArtifactBucket.Arn}/sched-e2e-*`). |
| `ArtifactAndE2eSiteBuckets` | `sched-e2e-web-*`, `sched-e2e-web-*/*` | **justified**: generated bucket-name suffix. |
| `SpaInvalidation` | `distribution/*` | **justified**, as for the deploy role. |
| `SsmBootstrapAndE2eParameters` | `/sched/bootstrap/*`, `/sched/e2e/*` | **justified**: path prefixes. |
| `SeedE2eData` | `table/sched-e2e-*` | **justified**: env prefix. |
| `SeedE2eData` | `table/sched-e2e-*/index/GSI1` | **fixed in #270** (F-13, medium; first PR): only `GSI1` exists, and it is named. |
| `SeedE2eUsers` | `userpool/*` | **justified**: random pool IDs, with an `aws:ResourceTag/env: e2e` condition. |

### `SchedDeployer` permission set (`infra/bootstrap/sched-deployer-policy.json`)

| Statement | `*` | Class |
|---|---|---|
| `Identity`; `CloudFormationReadAndValidate` (`ValidateTemplate`, `GetTemplateSummary`, `ListStacks`, `ListExports`) | `"*"` | **justified**: no resource-level permissions. |
| `CloudFormationReadAndValidate` | `DescribeStacks` on `"*"` | **justified**: `docs/runbooks/deploy-env.md` lists an env's stacks with `describe-stacks` and a `--query` filter, no name, so `SchedDeployer` keeps `DescribeStacks` on `"*"` (F-22 settled by #270 r1/Q-3 (a); the CI roles' copies are scoped). |
| `CloudFormationDriveSchedStacks` | `stack/sched-*/*` | **justified**: prefix; `DenyTouchingBootstrapStack` carves out the bootstrap stack. #270's first PR added `DetectStackResourceDrift` (F-9), and put `DescribeStackDriftDetectionStatus` in `CloudFormationReadAndValidate` on `"*"`, since a detection ID is no ARN (verify first, by the first run after the apply). |
| `ArtifactAndSiteBuckets` | `sched-*`, `sched-*/*` | **justified**: prefix; the operator deploys every env and publishes every env's site. |
| `SpaInvalidation` | `"*"` | **justified**: `ListDistributions` has no resource-level permissions, and distribution IDs are random. |
| `ReadOnlyDebugging` | `"*"` | **justified**: read-only describe, list and get actions for operator debugging, many without resource-level permissions. |
| `SsmSchedParameters` | `/sched/*` | **justified**: prefix. |
| `SeedAndEvalData` | `table/sched-*` | **justified**: seeding and `scripts/retry-escalations.ts`'s Scan (ADR-009, 2026-10-04 amendment). |
| `SeedAndEvalData` | `table/sched-*/index/GSI1` | **fixed in #270** (F-8, medium; first PR): `table/sched-*/index/GSI1`, the table's only index. |
| `SeedDemoUsers` | `userpool/*` | **justified**: random pool IDs. #270's first PR dropped `AdminDeleteUser` and `ListUsers`, which no script used (F-7): the statement keeps `AdminCreateUser`, `AdminSetUserPassword` and `AdminGetUser`. |
| `SpikesAndEvals` | Bedrock and Transcribe on `"*"`, plus unused `bedrock-mantle:*` (before) | **fixed in #270** (F-6, medium; first PR): `SpikesAndEvals` names the six entitled profiles' ARNs (the same as `InvokeAgentModels`) and no `bedrock-mantle:*`. The Transcribe streaming actions moved to their own statement, `TranscribeStreaming`, on `"*"`: **justified**, because Transcribe streaming has no resource-level permissions and IAM can't scope one statement's resources per action. A newly entitled profile needs a permission-set change. |

## 3. Logs, traces and limits, as deployed

### Log sinks (A-3)

"Text" means the patient's words, the model's reply, tool inputs, and the profile fields. IDs, enums, counts and timings pass.

| Sink | Check | Result |
|---|---|---|
| Chat log group (`/aws/lambda/sched-<env>-api-chat`, EMF included) | **Code path:** every log call goes through `Logger` and `errorSummary` (`services/api/src/lib/chat-turn.ts`, `handlers/chat.ts`, `lib/observability/metrics.ts`); the Powertools logger never logs the event (`lib/observability/logger.ts:10`); no `console.*` in Lambda code (`git grep`). **Live (`sec39`):** a patient message holding the marker `ZQX-SEC39-e6625ed91781`, then a `FilterLogEvents` read of every event in the group, grepped locally. **`dev`:** Logs Insights over 14 days (below), and a parse of all 286 events' keys. | **Pass.** `sec39`: 0 marker hits in 10 events, while the turn's own `chat turn` line was found by `conversationId` (positive control). `dev`: 0 hits for the fixture names. Every line's keys are IDs, enums, counts, timings and token usage. One `errorMessage` was ever logged: a Bedrock `ThrottlingException`, "Too many requests, please wait before trying again." |
| Session log group (`…-api-session`) | The same: code path (`services/api/src/lib/session.ts:94-97`), the `sec39` marker grep, and the `dev` query and key parse. | **Pass.** `sec39`: 0 marker hits in 385 events. `dev`: 0 hits in 788 records. `session` lines carry `conversationId`, `displayMessages` (a count), `hasProfile`, `hasUpcoming`, `status` and `totalMs`. |
| Chat function X-Ray traces | `Tracing: Active` with `POWERTOOLS_TRACER_CAPTURE_RESPONSE` and `…_ERROR` set to `"false"` (`api.yaml:96`, `:115-116`), pinned by `api-template.test.ts` "traces the chat function with X-Ray, and nothing else, with no response or error capture". `xray batch-get-traces` on `sec39`'s 2 traces (15 segments) and `dev`'s 4 (26), keys listed and grepped. | **Pass.** 0 marker hits and 0 fixture-name hits. Keys are only `aws.*` (operation, table, index, request ID, retries), `http.response` and duration annotations. The `cause` fields hold DynamoDB's generic "The conditional request failed" from the cap check. |
| Bedrock model invocation logging (A-4, verify first) | `aws bedrock get-model-invocation-logging-configuration` | **Pass:** it returned no configuration (exit 0, empty output), so invocation logging is off and prompts and replies go nowhere. **Closed by #272:** the same read returned no configuration again on 2026-10-19 ([comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/272#issuecomment-6271693288)), and `docs/runbooks/aws-setup.md` step 6 (from #42) says to leave it off. |

**By design, not logs (A-3).** The marker was stored in DynamoDB, in `MSG#000000` (the patient's words) and `MSG#000001` (the model's turn), both with the 30-day TTL. It was not in the `TRACE#…` item, which holds figures only (`scripts/trace.ts`; journal [2026-10-13](../journal/2026-10-13-the-trace-viewer-reads-figures-not-words.md)). The staff email carries the summary and transcript by design (`packages/tools/src/notify/render.ts:5`, `:72`). The failure text stored on an escalation has addresses redacted (`packages/tools/src/notify/ses.ts:48`).

The `dev` Logs Insights query (both groups, 14 days, the logs' retention; 1,074 records scanned, 0 matched):

```
fields @timestamp, @log | filter @message like /(?i)(Santos|Haines|Rahman|Marquez|Whitaker|Daniel Park|1988-04-17|1955-02-11|1995-09-03|1979-12-22|1990-06-30|1983-03-09)/ | stats count() as hits by @log
```

The fixture patients have no phone numbers, so the query searches surnames and dates of birth. First names alone match code text.

On `sec39`, Logs Insights reported records skipped by its index for a `like` filter, and gave 0 records for the chat group on its own while the combined query counted 8. So the marker evidence is a `FilterLogEvents` read of every event, grepped locally, not an Insights count.

**Q-5 (verify first): can a Bedrock error message quote request content?** AWS's `ConverseStream` reference documents each error's meaning and HTTP status, but not its message format (`ValidationException`: "The input fails to satisfy the constraints specified by Amazon Bedrock"; `ModelErrorException` relays a model error with `originalStatusCode` and `resourceName`). So the docs can't rule out a message that quotes a request field. The one SDK message `dev` has logged is generic. Q-5 (b) keeps SDK messages, clipped to 200 characters; F-20 records the residual risk as accepted.

### The stage throttle and the daily cap (Q-3 (a))

| Value | In `infra/stacks/api.yaml` | Deployed | Pinned by | Live check (`sec39`, 2026-10-15) |
|---|---|---|---|---|
| Stage throttle | rate 5, burst 10, `/*` `*` (`:355-359`) | `dev` and `sec39`: `"*/*": rate 5.0, burst 10` | `api-template.test.ts` "throttles every method of the stage at rate 5 and burst 10" | See below. |
| `DailyTurnCap` | default 50, min 1 (`:27-31`), passed as `DAILY_TURN_CAP` (`:116`) | `dev` 50; `sec39` 1 (deploy override) | `api-template.test.ts` "caps each patient at the handler's default of 50 turns a day, …"; the A-5 tests | A first new message got 200 (`turnsUsedToday: 1`, one `check_availability` call). A second new message, with a new `clientMessageId`, the same clinic day, 14:28 ET, got **429**: `{"type":"error","code":"RATE_LIMITED",…,"retryable":false}`. |
| `EnvDailyTurnCap` (#356) | default 200, min 1 (`:34-39`), passed as `ENV_DAILY_TURN_CAP` (`:117`) | `dev` 200 (the template default, deployed at `0de35f2`); `cap356` 2 (deploy override) | `api-template.test.ts` "caps the whole env at 200 turns a day unless it overrides, …" | Three new turns from two patients on `cap356` (2026-10-20, `0de35f2`): 200, 200, then 429 `RATE_LIMITED` with `retryable: false` and the env-cap text. Counters afterwards: env 2, each patient 1. |

The throttle checks, all as `POST /api/session`:

| Run | Requests | Result |
|---|---|---|
| Q-3's check: 30 simultaneous, cold env | 30 within 1.3 s | 10 × 200, **20 × 500**, **0 × 429** |
| 30 simultaneous, warm | 30 within 1.0 s | 30 × 200, **0 × 429** |
| Paced, one every 80 ms (about 12 per second) | 40 | 39 × 200, **1 × 429** `TooManyRequestsException` |
| Paced, one every 40 ms (about 25 per second) | 60 | 46 × 200, **14 × 429** `TooManyRequestsException` |

**The Q-3 check as specified fails:** 30 simultaneous calls got no 429, in two runs. The throttle is deployed as written and does reject sustained load. But it doesn't bound a simultaneous burst, and two things show why.
- **Cold run:** the 20 × 500s never reached the function. The session log group shows exactly 10 `platform.initStart` and 40 invocations for the two bursts. The account's Lambda concurrent-executions quota is **10** (Service Quotas `L-B99A9384`; the AWS default is 1000), so Lambda refused the rest, and API Gateway answers a refused invocation with 500.
- **Warm run:** API Gateway's token bucket let all 30 through.

These are findings F-12 and F-15, not changes to the deployed values, which match the template.

## 4. Codebase review (Q-6 (a))

Scope: `services/`, `packages/`, `infra/`, `apps/web/src/`, `scripts/`.

| Check | Result | Evidence |
|---|---|---|
| Identity only from the JWT | holds | §1, identity rows. `git grep patientId packages/contracts/src/tools.ts`: no match. |
| Conversation ownership | holds | §1. |
| Injection through tool results | holds (policy, evaluated) | The system prompt says tool results, stored reasons and pasted text are data, not instructions (`packages/agent/src/prompts/system.v3.ts:152`). The red-team scenarios `safety-indirect-injection-stored-reason`, `l1-tool-result-injection` and `safety-pasted-preconfirmed-booking` check it (`adr9.tool-results-are-data`). Identity can't be injected, because tools never take `patientId`. Bedrock Guardrails stay deferred (ADR-009). |
| Secrets in tracked files and git history | holds | `git grep -E 'A(KIA\|SIA)[0-9A-Z]{16}'`: only the fakes `ASIAMOCKMOCKMOCKMOCK` and `ASIAFAKEFAKEFAKEFAKE` in web tests. `git log --all -G` for the same pattern: those plus a redaction test's `ASIAABCDEFGHIJKLMNOP`. The account ID in any tracked file: 0; in any commit's content on any branch (`git log --all -S`): 0. Real-looking `SES_SENDER=` values: only `example.com` addresses. Email domains in tracked files: only reserved ones (`example.com`, `example.org`, `.invalid`). No private-key, GitHub-token or `sk-ant-` pattern. `infra/bootstrap/sched-deployer-policy.json` uses the `<ACCOUNT_ID>`, `<SES_IDENTITY>` and `<SES_RECIPIENT>` placeholders. The owner's personal address is in commit author metadata (1,683 author and committer fields), not in content: F-18, #272. A-9: `scripts/deploy.sh` reads the SES values from the environment or the git-ignored `.env`. #257 settles its parser quirks (the parsers agree, and a line break is refused without printing the value); #39 doesn't edit it. |
| Data exposure in logs | fixed | §3; F-21 |
| Data exposure in responses | holds | Error events carry fixed patient-facing text (`services/api/src/lib/errors.ts`), never an exception message. The session response is built from the caller's own records (`services/api/src/lib/session.ts`). Responses carry no stack or internal ID beyond the caller's own conversation and message IDs. |
| IAM | fixed in #270 | §2 |
| `npm audit` advisories | holds | `npm audit`: 0 vulnerabilities at every severity; `npm audit --omit=dev`: 0. |

## 5. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-1 | medium | The chat role granted `…/index/*`; the table has one index, `GSI1`. | fixed (`572297e`) |
| F-2 | medium | The chat role's `foundation-model/anthropic.claude-sonnet-4-6*` matched any model ID with that prefix. | fixed (`572297e`) |
| F-3 | medium | The exec role grants 13 service-wide actions on `"*"`. | fixed in #270 (second PR; applied by Nick, then a create, an update and a teardown of an ephemeral env on 2026-10-19, with no AccessDenied): one statement per service, resources named; Events, X-Ray, SES and Bedrock dropped |
| F-4 | low | The boundary allows `bedrock-mantle:*` actions nothing calls since ADR-010. | fixed in #270 (first PR) |
| F-5 | medium | The evals role copies the `sonnet-4-6*` suffix. | fixed in #270 (first PR) |
| F-6 | medium | `SchedDeployer`'s `SpikesAndEvals` grants Bedrock and Transcribe on `"*"`, plus unused `bedrock-mantle:*`. | fixed in #270 (first PR) |
| F-7 | low | `SchedDeployer` grants `AdminDeleteUser` and `ListUsers`, which no script uses. | fixed in #270 (first PR) |
| F-8 | medium | `SchedDeployer`'s `SeedAndEvalData` grants `index/*`. | fixed in #270 (first PR) |
| F-9 | low | `SchedDeployer` can't run drift detection (no `DetectStackResourceDrift`), so the review couldn't check drift (A-2). | fixed in #270 (first PR) |
| F-10 | medium | Escalation items have no TTL. The patient's `reason` and the model's `summary` stay indefinitely, PITR keeps expired items restorable for its window, and the staff email holds the transcript (Q-4 (a)). | fixed by #271 (`4d007cd`): escalation items get `expiresAt` = `createdAt` + 30 days (`items.ts`, `ESCALATION_TTL_DAYS`), pinned by `dynamo.test.ts`; PITR stays at 35 days and ADR-009 says so (owner decisions r1/Q-1 (a), Q-4 (a)); old items are not backfilled (Q-3 (a)) |
| F-11 | low | The stage throttle's comment cites "the account quota is 10 req/min". That is `sonnet-4.6`'s Bedrock RPM (`packages/agent/src/profiles.ts:121`), which a rate of 5 per second doesn't bound. | fixed by #273 (`7edb209`): the comment says what the throttle bounds (the sustained rate, per method) and what it doesn't (a simultaneous warm burst, Bedrock requests, Lambda concurrency, one patient's use) |
| F-12 | medium | The throttle is stage-wide, not per client, and a simultaneous burst of 30 gets no 429 (§3). | accepted: owner decision r1/Q-1 (a) on #273: only admin-created patients can sign in (`infra/stacks/auth.yaml:34`); each patient is capped at 50 turns a day (`DailyTurnCap`, `infra/stacks/api.yaml:27-31`); the stage throttle rejects sustained load (§3); and the `sched-monthly` budget alarm reports spend. WAF would add a web ACL and its rules to every standing env, and the exec role has no `wafv2` grant. The env-wide daily turn cap (`EnvDailyTurnCap`, #356) now bounds what the whole env can spend in a day, whatever the credentials. |
| F-13 | medium | The e2e role's `SeedE2eData` grants `index/*`. | fixed in #270 (first PR) |
| F-14 | medium | No reserved concurrency for the chat function (impossible while the quota is 10). | fixed by #273 (`7edb209`, owner decision r1/Q-2 (c)): `ReservedConcurrentExecutions: 5` on `ChatFunction`, pinned by `api-template.test.ts` "reserves 5 concurrent executions for the chat function …", deployed on `dev` (`aws lambda get-function` `Concurrency`: 5). Lambda keeps 100 of the account's 1000 unreserved, so each env's 5 fits |
| F-15 | medium | The account's Lambda concurrency quota is 10, shared by every env. A burst of one env's calls throttles the others, and the client sees a 500. | fixed by #272 (the quota is 1000: approved 2026-10-16, read again on 2026-10-19, [comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/272#issuecomment-6271693288)); the 500 holds: on `ab273`, 25 of 30 simultaneous `POST /api/chat` calls beyond the chat function's reservation of 5 got API Gateway's 500 with no event body, which the SPA offers Retry for (`apps/web/src/chat/useChat.ts:114-118`) (#273, [journal 2026-10-16](../journal/2026-10-16-five-chat-turns-at-once.md)) |
| F-16 | low | No per-patient cap on Transcribe streaming. | accepted: owner decision r1/Q-3 (a) on #273: only admin-created patients can sign in (`infra/stacks/auth.yaml:34`), and the role allows `transcribe:StartStreamTranscriptionWebSocket` only (`:111-119`). The SPA stops a recording at 60 seconds (`apps/web/src/voice/useRecording.ts:25`), but that cap is client-side and per recording, and nothing caps minutes per patient or per day, so a patient's credentials can stream for longer within their lifetime. The `sched-monthly` budget alarm reports the spend. The env-wide daily turn cap (`EnvDailyTurnCap`, #356) bounds chat spend only; nothing it adds bounds Transcribe. |
| F-17 | low | No WAF on CloudFront or the stage. | accepted: owner decision r1/Q-1 (a) on #273: only admin-created patients can sign in (`infra/stacks/auth.yaml:34`); each patient is capped at 50 turns a day (`DailyTurnCap`, `infra/stacks/api.yaml:27-31`); the stage throttle rejects sustained load (§3); and the `sched-monthly` budget alarm reports spend. WAF would add a web ACL and its rules to every standing env, and the exec role has no `wafv2` grant. The env-wide daily turn cap (`EnvDailyTurnCap`, #356) now bounds what the whole env can spend in a day, whatever the credentials. |
| F-18 | low | Commits carry the owner's personal address in author metadata. | accepted: Decision #272/COMMIT-EMAIL, the address stays public, with no change to GitHub's email privacy setting and no noreply address for future commits ([comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/272#issuecomment-6272973468)) |
| F-19 | low | `docs/runbooks/aws-setup.md:53` says `SchedDeployer` calls `bedrock-mantle:CreateInference`; it's `bedrock:InvokeModel*` since ADR-010 (A-8). | fixed in the runbook by #42 (PR #285): step 3 named the Bedrock actions `SchedDeployer` granted then; #270's first PR drops the Mantle pair, from the policy and from step 3 |
| F-20 | low | AWS SDK error messages are still logged, clipped to 200 characters. AWS doesn't document their format, so one could quote a request field. | accepted: owner decision r1/Q-5 (b) keeps them for debugging Bedrock errors |
| F-21 | high | `errorSummary` logged any error's message, and a tool, a repository or the agent loop can build one from patient or model text. It wasn't observed in `dev`'s logs. | fixed (`572297e`): non-SDK errors log their name and code only, pinned by `services/api/test/log.test.ts:7` and `:32` |
| F-22 | low | `DescribeStacks` is granted on `"*"` to the deploy and e2e roles and `SchedDeployer`, though it takes a stack ARN and every call in the repo names its stack. | fixed in #270 (first PR) for the CI roles; `SchedDeployer` keeps it on `"*"` for the runbook's unnamed listing (r1/Q-3 (a)) |
| F-23 | low | The permissions boundary allows 15 actions that no `sched-*` workload role grants (ceiling-only). | fixed in #270 (first PR; owner decision `1517fd9/SPEC-4` (a) on PR #275): the boundary lists 14 actions |
| F-24 | medium | The deploy and e2e roles may write any object in the shared artifact bucket (`${ArtifactBucket.Arn}/*`), though SAM uploads under the stack-name prefix. | fixed in #270 (first PR) |

No finding lets a patient reach another patient's data.
