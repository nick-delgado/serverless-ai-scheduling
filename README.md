# Building an AI scheduling assistant that can prove it works

> A serverless, tool-using AI agent that helps patients book and reschedule doctor's appointments by text or voice, and an evaluation harness that measures whether it gets them right.
>
> **Status:** Milestones M0 through M4 are complete as of 2026-10-23: the agent, the eval harness, the deployed demo and this story are built. M3 closed with three eval targets (task success, reliability and safety violations) accepted as known gaps; [chapter 5](#chapter-5--what-the-evals-showed) has the numbers. Follow along in the [journal](docs/journal/) and on the [project board](https://github.com/users/nick-delgado/projects/1).
>
> **Contact:** if the demo's access requests have run out, or you'd like a walkthrough, message Nick Delgado on [LinkedIn](https://www.linkedin.com/in/i-delgado/).
>
> *Cedar Ridge Health is a fictional clinic. All data is synthetic.*

---

## See it working

- **The demo:** the link in this repository's **About → Website** field. Request a temporary patient account on its sign-in page; no one has to send you a login. How that works, and its limits: [reviewer access](docs/demo/reviewer-access.md).
- **The recording:** [a walkthrough video](https://www.youtube.com/watch?v=W6v7YrnZttA) (unlisted on YouTube), about 4 minutes: request an account, book by text, send a voice message, reschedule, escalate.

## Chapter 0 — Words from the Human in the Outer Loop

This is perhaps more of a closing thought than a preface but I wanted to put it towards the top of the README because I wanted this to be read while the attention is fresh as one starts reading the README file. These are a few of my own observations and thoughts in my own words after having completed the last milestone of this project. Here they are in no particular order:

- **Time flies**. I greatly underestimated how long this would take. I expected to finish it over a weekend, or a week at most. And part of this is due to my own rigidity and desire to do it in a more traditional software development style while adding full AI development. I didn't want to take a one-shot or "vibe coded" approach. While this did take more time than I expected I also ended up simultaneously working on my own personal agentic review harness project, so it was worth it.
- **Review process**. As anyone who has done AI driven development knows it is very hard to do a standard pull request review when AI can generate so much code and the temptation to skim it and just accept it is great. But I believe that review is still needed, AI agents are not infallible no matter how well you prompt them and what level of effort you select. And while linters and unit tests are a great start they are not to be trusted. Even with the frontier models like Claude Opus 5.5 on high effort it can still screw up unit tests. Not that it writes them incorrectly per se but rather it misses some logic checks or sometimes writes tests that can't fail and it then reports that it has succeeded.
- **Tokens, tokens, tokens**. When the industry started shifting towards AI driven development I questioned what some were saying that AI was going to be more economical than paying for an engineering team. I still am skeptical about that. I do believe that AI can generate more code than an engineer by a 10x or 20x factor but that it's also cheaper relative to what a human can produce is still undecided in my mind. Sure, vibe coding and one-shots can generate output but production-ready output in my mind requires the iterative generate-validate loop which consumes tokens which increases cost. I'm still trying to find the right balance between choosing what model and what effort level for the task at hand in the effort to bring costs down.
- **AWS**. On paper (and in their training material) the promise of Bedrock is very attractive. The serverless model they provide with a unified interface to switch between all the different models they offer in their catalog is super enticing. But when implementation time came my fantasies hit a wall. First off, the whole hassle of trying to get my account to be provisioned to use Bedrock - something in my account somehow was not right for them. Then, when that got sorted out, I hit another wall...the requests per minute limit. Sonnet 4.6 is limited to 10 AI requests per minute on my new account. OK, request an increase in quota through the Service Quotas request page. Problem 1: the minimum you can request jumps to 10,000 requests per minute (way more than I need). Problem 2: request for the "bare" minimum was denied. So I stayed stuck at 10 requests per minute which made the eval harness runs take hours. Also, notice that I mentioned Sonnet 4.6...4.6 was what was offered for Haiku, Sonnet, and Opus. In their Bedrock catalog they show the latest models (5 and 5.5) but those are set to 0 (yes, zero) requests per minute - so, turned off. And again, you can only request the "bare" minimum of 10,000 rpm...so that was denied. While I am frustrated at the experience with Bedrock I do believe that AWS has a good service overall. I have been using their products for more than a decade now and I am generally pleased with their products and innovations. I just wished that this particular product was more fleshed out and available for solo developers or new accounts.

Nick Delgado

## Chapter 1 — The question

It started with one line in a job posting: *"Have built or deeply explored an AI system beyond basic prompting or a thin API wrapper."*

The easy answer is a chatbot that forwards your message to an LLM and prints the reply. We wanted the harder one: an agent that **acts** on real data, where getting it wrong has consequences, and where we can show with numbers how often it gets it right.

So the premise is simple. A patient logs into a clinic's portal and says, in their own words and by voice if they like, *"I need to see a dermatologist next week, afternoons are better."* An AI agent:
- checks real availability;
- offers concrete options;
- confirms before it books anything;
- handles "actually, can we move my Tuesday appointment?";
- knows when to hand the patient to a human.

What turns the demo into an engineering project is the part nobody sees: **an evaluation harness**. It runs dozens of simulated patients against the agent. It checks the database to confirm the right appointment was booked. And it tries to trick the agent into leaking someone else's records.

→ Full entry: [Why this project, and planning before building](docs/journal/2026-09-28-why-this-project.md)

## Chapter 2 — Designing before building

Before writing any code, we did the research and wrote down our decisions. Three of them shaped everything else:

- **The agent can't choose whose data it sees.** The patient's identity comes from their login token and is injected into every tool call. The model never gets a "patient ID" argument to fill in. No prompt, however clever, can make it read another patient's chart. ([ADR-005](docs/adr/0005-auth.md), [ADR-009](docs/adr/0009-safety-and-privacy.md))
- **Double-booking is impossible, not just unlikely.** Bookings are DynamoDB transactions with conditions. If the agent calls "book" twice, or two patients grab the same slot, the data stays correct. ([ADR-004](docs/adr/0004-data-model.md))
- **The evals pick the model.** The plan was to run Claude Opus 5, Sonnet 5 and Haiku 4.5 through the same scenarios and ship the one that met the targets for success, reliability, latency, and cost. [Chapter 5](#chapter-5--what-the-evals-showed) tells what ran (six profiles; AWS never entitled Opus 5 and Sonnet 5) and what shipped, `sonnet-4.6` at effort `high`, with three targets accepted as known gaps. ([ADR-002](docs/adr/0002-model-and-bedrock-client.md), [ADR-008](docs/adr/0008-evaluation-strategy.md))

Research also overturned two of our first assumptions:
- **Streaming the reply:** API Gateway can now stream responses, so the agent's words and its "checking availability…" status reach the browser as they happen. ([ADR-007](docs/adr/0007-chat-transport.md))
- **Voice input:** the fastest design is to stream the patient's voice to Amazon Transcribe *while* they talk, not after. ([ADR-006](docs/adr/0006-voice-transcription.md))

All ten decisions are in [`docs/adr/`](docs/adr/); the requirements are in the [PRD](docs/PRD.md).

## Chapter 3 — The walking skeleton

The first milestone was meant to prove that one request could cross every layer. What it proved first was how many ways the layers could say no. Spike S-1 was supposed to be the easy one: call three Claude models on Bedrock and time a tool-use round trip. The model catalog listed Opus 5, Sonnet 5 and Haiku 4.5 as `ACTIVE`, and the first run returned three 403s. Our first theory was that least privilege had blocked a Marketplace agreement, and it was wrong: the admin role got the same error, because the denial was an account-level entitlement that only AWS Support could lift. Sonnet 4.6 and Haiku 4.5 were open and every Opus was closed, so we built for the models we could call, and AWS later [declined the request](docs/journal/2026-10-09-aws-declined-opus-5-and-the-quota-increases.md) for the others. ([The entry](docs/journal/2026-09-28-active-is-not-callable.md))

The first real deploy hit the same kind of wall from the other side. Agents sign in as a role that can only drive CloudFormation, and CloudFormation acts as an execution role that can only create IAM roles carrying a permissions boundary. The first deploy failed in about ten seconds: when you deploy with an execution role, CloudFormation expands the SAM transform *as that role*, and we had granted the transform to the caller only. The fix went into the bootstrap stack. The same pass showed that the account's Bedrock quotas for Sonnet 4.6 and Haiku 4.5 were 10 requests a minute against a default of 10,000, which explained the throttling of the day before and set the pace of every eval run to come. ([The entry](docs/journal/2026-09-29-least-privilege-meets-reality.md))

Then the risk the chat depends on. API Gateway REST APIs had gained Lambda response streaming only ten months earlier, and the agent's status chips and token-by-token text both need events to reach the browser while it is still working. We built the thinnest path through every layer, browser to CloudFront to API Gateway to Lambda to Claude on Bedrock and back as a stream, and measured 10 paced requests through CloudFront against 10 directly. Nothing buffered: the first token arrived at 1.03 s through CloudFront and 1.04 s direct, about 15 ms of added overhead, and about 85% of the wait is Bedrock. ([The entry](docs/journal/2026-09-29-streaming-survives-cloudfront.md))

Last, the rule the whole data layer rests on: a slot can't be booked twice. Its headline test, ten parallel bookings of one slot producing exactly one success, passed on the first run, and that was the problem. The in-memory store checks and writes with no `await` between them, so it can't race, and a test that can't fail says nothing. The agent inserted one `await` between "is the slot open?" and "mark it booked", the read-then-write race our rules forbid, and 10 of 10 bookings succeeded on one slot with three contract tests red; reverted, it was 1 of 10. "A test counts once you've seen it fail" went into our definition of done. ([The entry](docs/journal/2026-09-29-watch-the-double-booking-test-fail.md))

→ Full entry: ["ACTIVE" in the model catalog doesn't mean you can call it](docs/journal/2026-09-28-active-is-not-callable.md)

## Chapter 4 — Teaching the agent to schedule

With the layers proven, the question became how we would know the agent worked. So before any agent code existed, an agent wrote the tests: 40 multi-turn scenarios and 22 single-turn (L1) cases, each run against a fixed clinic fixture with a frozen clock. Writing them first exposed gaps in the fixture and the harness while they were cheap to fix, and the first live run, on the two cheapest high-quota models against a draft prompt, found a model inventing appointment times that our own L1 grader had not been checking for. gpt-oss-20b passed 13 of 22 cases and Nova Pro 16 of 22. ([Evals first](docs/journal/2026-09-29-writing-the-tests-before-the-agent.md), [the first live run](docs/journal/2026-09-29-first-live-l1-run.md))

The loop came next, and its first rule is that it never learns whose data it touches. The chat handler builds the tool executor from the verified login token and hands it to the loop already bound to that patient, so "identity comes from the token, never the model" is enforced by the loop's type signature rather than by discipline. Every loop test passed on the first run, which made us distrust them, so we broke the loop on purpose in six ways (parallel tools run one by one, results split across messages, a cache breakpoint dropped, history mutated, a retry skipped, tools run at the iteration cap). Each break turned at least one of the package's 47 tests red. ([The entry](docs/journal/2026-09-29-the-loop-never-sees-the-patient.md))

We had planned to run the agent on Claude Opus 5 or Sonnet 5. AWS denied both, and OpenAI's proprietary models on Bedrock the same way, which left a loop written against one vendor's types. A probe sent our real tool definitions through the Bedrock Converse API, and five models answered with a correct `check_availability` call, so Converse became the only transport and every difference between models moved into a profile as data. The differences were many: each model disagreed about where cache points are allowed and whether reasoning can be sent back. A live five-turn run per profile had five of six profiles making the right tool call 5 of 5 times, while gpt-oss-120b made it 3 of 5 and put a `<reasoning>` block into the text a patient would read in 2 of 5 turns, which the adapter now strips. ([The entry](docs/journal/2026-09-29-one-transport-many-models.md), [ADR-010](docs/adr/0010-provider-neutral-llm-layer.md))

Then the prompt. The first draft passed 19 of 22 L1 cases on Sonnet 4.6; system prompt v1 passed all 22, and all 66 trials of a three-trial run. The same exercise showed that one trial can lie: a single-trial run had Nova Pro at 22 of 22, while three trials of the same prompt gave 14 with 6 safety violations, which is why the exit runs use three trials per case. The prompt was also not enough for every model, a question the next chapter returns to. ([The entry](docs/journal/2026-10-02-system-prompt-v1.md))

A single turn can't test a conversation, so an LLM now plays the patient. Its first live scenario run, 8 scenarios with Sonnet 4.6 on both sides, passed 5 and reported 3 safety violations, and none was the agent's fault. The grader rejected a patient's "Yes, that's perfect, go ahead and make that change!" because its list of hedge words contained "change", and it read "from Tuesday, October 13 to Wednesday, October 14, 2026 at 2:00 PM" as one offered time. The failures that were real, week arithmetic and ten times listed in one message, went to the prompt. A wrong grader reads exactly like an unsafe agent, which set up what the evals had to show next. ([The entry](docs/journal/2026-10-02-the-simulated-patient-says-yes-like-a-person.md))

We built all of this with several AI agents working in parallel, and two habits from that work held up. Readiness reviews, where a fresh agent reads an issue and asks the owner what it leaves open before work starts, cut the questions the spec left to the pull request from 1.14 to 0.55 per 1,000 changed lines. And "seen failing" needed a tool: a small runner applies a list of exact edits one at a time and prints which tests went red, which turns each pull request's evidence into a checkable table. Stryker, which we tried as the alternative, scored 6.74% on our tools package until we patched it for Vitest 5, and 93.55% after. ([Readiness reviews](docs/journal/2026-10-05-readiness-reviews-halved-the-open-questions.md), [mutation tools](docs/journal/2026-10-05-mutation-tools-find-what-nobody-wrote-down.md))

→ Full entry: [The agent loop never learns whose data it touches](docs/journal/2026-09-29-the-loop-never-sees-the-patient.md)

## Chapter 5 — What the evals showed

Chapter 4 produced a prompt that worked for Sonnet 4.6, so the milestone's real question was which model should run the chat. AWS had [declined](docs/journal/2026-10-09-aws-declined-opus-5-and-the-quota-increases.md) Opus 5, Sonnet 5 and the quota increases, which left six profiles, the two Claude ones at 10 requests a minute. The matrix ran Sonnet 4.6, Nova 2 Lite and both gpt-oss models at three effort levels each, plus Haiku 4.5 and Nova Pro: 14 cells, every case three times, in 23 hours for $57.61. No cell met PRD §7 as the matrix scored it, and one came close. `sonnet-4.6` at effort `high` passed 92% of scenario cases against 83% at `medium`; that 92% is the 2026-10-13 figure, and the re-run in the table below puts it at 86%. We shipped it ([ADR-002](docs/adr/0002-model-and-bedrock-client.md)). ([The matrix](docs/journal/2026-10-13-what-the-matrix-chose.md))

A number is not a verdict, and the first full scenario run, before the matrix, showed why. It reported 4 safety violations. One was a cross-patient case and went to its own issue. Of the other three, one was the agent's: it offered a 2:30 PM slot no tool had returned, hedged as "if available", because the availability tool returned only the five earliest slots and could not show it a later one. The other two were our own graders and scenario wording, so we filed the tool fix and the grader fixes to land before the matrix counted anything. Some failures a prompt can't fix at all: Nova Pro kept 3 safety violations in 66 trials, `<thinking>` leaking into replies and once a patient-typed ID in an escalation summary, so code, not prompt, now strips those tags and redacts IDs from escalation summaries. ([One real violation in three](docs/journal/2026-10-05-one-real-safety-violation-in-three.md), [guards outside the prompt](docs/journal/2026-10-05-guards-outside-the-prompt.md))

The LLM judge scores tone and clarity beside every scenario trial, but nobody had checked it against a person. Nick scored 20 transcripts, 49 transcript-and-dimension pairs, and the judge agreed on 42 of them (86%), above the 80% target on its first run. But all six replies Nick failed were clarity 3s, and the judge passed every one: every agreement was a shared pass. A sharper clarity rubric (`judge.v2`) agreed on 47 of 47 pairs of a held-out set, though that set holds no reply Nick failed, so whether the judge can catch a weak reply is still open ([#351](https://github.com/nick-delgado/serverless-ai-scheduling/issues/351)). ([The calibration](docs/journal/2026-10-16-the-judge-agrees-but-passes-every-reply-nick-failed.md), [judge.v2](docs/journal/2026-10-19-judge-v2-agrees-with-nick-on-47-of-47-on-system-v13-replies.md))

Then a pull request's CI gate caught the failure we feared most. The agent had restated "Tuesday, October 13 at 1:00 PM ET", the patient said "Yes, go ahead", and the booking was written for the 12:00 PM slot from an earlier offer: `book_appointment` took an opaque slot ID, and nothing checked that the model had copied the right one. The agent was honest about it and offered to move the appointment, and the graders flagged three safety violations in that trial, but a booking the patient had not agreed to existed. Both write tools now take the provider, date and time the patient confirmed, and answer `CONFIRMATION_MISMATCH` and write nothing when they differ from the slot. ([The entry](docs/journal/2026-10-16-the-tools-check-what-the-patient-confirmed.md))

Speed was the one target no effort level fixed. On the deployed stack the first words of a reply took 4,735 ms at p50 against a 3 s target, and `medium` effort only brought it to 4,102 ms, because every turn made three model calls (`find_providers`, `check_availability`, then the answer) and visible text began only with the third. One required sentence ahead of the first lookup moved the first words to the first model call: 2,478 ms at p50 on `system.v14`, against 4,250 ms for the same 30 turns the day before, without it. ([A line before the first lookup](docs/journal/2026-10-19-a-line-before-the-first-lookup.md), [the matrix](docs/journal/2026-10-13-what-the-matrix-chose.md))

M3's exit re-ran the two PRD §7 runs on the prompt we ship, `system.v15`, because the graders had tightened five times since the matrix. It missed three of the six targets it measured: task success 86%, reliability 74% and 4 safety violations. Those 4 are one case in two trials, `clarify-voice-garbled-provider`, a booking that was right whose restatement left out the reason the patient gave with the yes, not a data leak. The clock-time check alone is in 8 of the 13 failed scenario trials, and we can't say how much of the fall from 92% and 87% is the prompt and how much is stricter graders. Nick accepted the gaps as known, with a fix issue for each cause. The six rows below are the ones a reader needs. ([The exit re-run](docs/journal/2026-10-20-the-exit-rerun-on-system-v15-misses-three-of-six-targets.md), [the time check](docs/journal/2026-10-17-the-time-check-reads-every-clock-time.md))

| Metric (`sonnet-4.6` at effort `high`, `system.v15`) | Result | PRD §7 target | Met? |
|---|---|---|---|
| Task success, scenario mode, core categories, pass@1 | 86% | ≥ 90% | not met |
| Reliability, scenario mode, core categories, pass^3 | 74% | ≥ 80% | not met |
| Safety violations, both modes | 4 (l1 0, scenario 4): one case, two trials, `clarify-voice-garbled-provider`, a restatement that omits the reason the patient gives with the yes | 0 | not met |
| Emergency cases pass every trial, both modes | l1 2/2, scenario 2/2 | 100% | met |
| Agent cost per completed conversation (NFR-003) | $0.0729 | ≤ $0.25 | met |
| NFR-001 first text, p50 (from the 2026-10-19 measurement on `system.v14`, not the 2026-10-20 run) | 2,478 ms | ≤ 3 s | met |

> The full table, with the rubric and judge-agreement rows, is in [ADR-002's 2026-10-20 amendment](docs/adr/0002-model-and-bedrock-client.md#amendment-2026-10-20-the-exit-table-re-run-on-systemv15-345). #360 and #361 changed two graders since that run ([the hours remark and the closing question](docs/journal/2026-10-22-an-hours-remark-and-a-one-day-closing-question-are-not-offers.md), [the reason in the yes](docs/journal/2026-10-22-a-reason-in-the-yes-is-the-patients-own-word.md)), and the table hasn't been re-run.

→ Full entry: [The exit re-run on `system.v15` misses task success, reliability and safety; M3 exits with the gaps accepted](docs/journal/2026-10-20-the-exit-rerun-on-system-v15-misses-three-of-six-targets.md)

## Chapter 6 — What I'd do next

The project has billed $249.60 as of 2026-10-22: $228.48 before tax and $21.12 tax, all of it October usage. Claude on Bedrock is $216.68 of that (Sonnet 4.6 $193.28, Haiku 4.5 $23.40), and with Bedrock's other models and Transcribe the usage services come to $228.22 of the $228.48, 99.9%. The agents can't read billing, so the figures come from the Cost Explorer export Nick posted. ([The cost entry](docs/journal/2026-10-22-billed-249-dollars-nearly-all-claude-on-bedrock-and-idle-is-26-cents.md))

The serverless stack we spent most of the milestones designing is the cheap part. Against NFR-003's $5 a month for an idle environment, October to the 22nd billed $0.26, 88% of it DynamoDB, and that is an upper bound, since build traffic ran through it. The cost of this project is its evaluation: the eval runs we wrote down sum to at least $115.87, the matrix's $57.61 being half of that, and "at least" is the honest word, because the cost of most CI-gate runs was never written down, which leaves the build side as an upper bound of $112.35 and not a figure we know. ([Idle against NFR-003](docs/journal/2026-10-22-billed-249-dollars-nearly-all-claude-on-bedrock-and-idle-is-26-cents.md#idle-against-nfr-003))

A public demo needs a door that doesn't cost whatever anyone asks of it. A reviewer can request a temporary synthetic patient on their own, behind a Cloudflare Turnstile check, under an env-wide daily turn cap (default 200) beside the per-patient one, and an hourly job deletes the account, its data and its place in the registry, checking that the Cognito user's `sub` is the entry's first so a username clash can't delete someone else's account. The cap matters because budgets only send email (defaults $25 and $10 a month), and the spend backstop that exists switches off voice, not Bedrock: Bedrock spend can't be told apart by purpose without changing the model IDs. ([The request page](docs/journal/2026-10-20-a-reviewer-can-request-a-demo-patient-and-the-bot-check-comes-first.md), [the turn cap](docs/journal/2026-10-20-the-env-gets-its-own-daily-turn-cap.md), [the backstop](docs/journal/2026-10-20-the-spend-backstop-covers-voice-not-bedrock.md), [the expiry job](docs/journal/2026-10-21-expired-reviewer-accounts-delete-themselves-and-the-job-proves-whose-user-it-deletes.md))

What worked was writing the rule down before the code and making it structural (identity from the token, atomic bookings), counting a test only once we had seen it fail, and rehearsing the runbook on a fresh environment before anyone relied on it. What didn't: the M3 exit missed 86% task success, 74% reliability and 4 safety violations against [#37's exit table](docs/adr/0002-model-and-bedrock-client.md#amendment-2026-10-12-production-profile-37), which met them on `system.v3`, and `judge.v1`, which agreed with Nick on 86% of pairs, passed every reply he failed (`judge.v2` agreed on 47 of 47 held-out pairs, though that set holds no failed reply; chapter 5 has both). Cost estimates ran from 7x high to 2.9x low ([the lessons](docs/journal/2026-10-22-billed-249-dollars-nearly-all-claude-on-bedrock-and-idle-is-26-cents.md#lessons)). The limits are plain: Opus 5 and Sonnet 5 were never callable here, so we never measured them, and the Nova and gpt-oss models ran but no cell met §7.

A second version would start where the exit missed: task success to 90% in book, availability and clarify (83%, 83% and 78% at the exit) through [#363](https://github.com/nick-delgado/serverless-ai-scheduling/issues/363), [#347](https://github.com/nick-delgado/serverless-ai-scheduling/issues/347) and [#343](https://github.com/nick-delgado/serverless-ai-scheduling/issues/343); reliability to 80%, which moves with it; zero safety violations through [#362](https://github.com/nick-delgado/serverless-ai-scheduling/issues/362), #347 and [#346](https://github.com/nick-delgado/serverless-ai-scheduling/issues/346). #360 and #361, the other two fixes the exit produced, are done, and no run since has re-measured the table. Then cancel without rebooking, which the agent escalates today, and per-purpose spend so the next version of this chapter reads a number instead of a residual. Further out: let the judge fail trials if it earns it ([#335](https://github.com/nick-delgado/serverless-ai-scheduling/issues/335), [#351](https://github.com/nick-delgado/serverless-ai-scheduling/issues/351)), keep standing envs bookable without manual seeding ([#325](https://github.com/nick-delgado/serverless-ai-scheduling/issues/325), [#286](https://github.com/nick-delgado/serverless-ai-scheduling/issues/286)), and make the cheaper models runnable ([#246](https://github.com/nick-delgado/serverless-ai-scheduling/issues/246), [#247](https://github.com/nick-delgado/serverless-ai-scheduling/issues/247)) so the next matrix can price them.

→ Full entry: [The project has billed $249.60 as of 2026-10-22, nearly all of it Claude on Bedrock, and idle runs at $0.26 so far](docs/journal/2026-10-22-billed-249-dollars-nearly-all-claude-on-bedrock-and-idle-is-26-cents.md)

---

## How it's built (at a glance)

| Layer | Technology |
|---|---|
| Frontend | React + Vite (TypeScript), S3 + CloudFront |
| API | API Gateway REST API (response streaming), Cognito authorizer |
| Agent | Our own tool-use loop in Lambda (Node.js 24) on **Claude in Amazon Bedrock** |
| Data | DynamoDB single-table design |
| Voice | Amazon Transcribe Streaming from the browser (Cognito Identity Pool credentials) |
| Escalation | Amazon SES email to front-desk staff |
| Infrastructure | AWS SAM / CloudFormation, one stack per domain |
| Quality | Custom eval harness: simulated patients, state-based grading, LLM judge, CI gate |

![System diagram. The patient's browser (React SPA) reaches CloudFront with S3 over HTTPS and, through API Gateway with the Cognito User Pool authorizer, three Lambda functions: ChatFn (the agent loop, with Bedrock Converse and the tool registry, which reads and writes DynamoDB and sends escalation email through SES), SessionFn (greeting and restore) and RequestAccessFn (reviewer access, checked by Cloudflare Turnstile). An hourly EventBridge rule starts ExpireFn, which deletes expired reviewer accounts. The browser also streams voice to Amazon Transcribe with credentials from the Cognito Identity Pool. The functions share one DynamoDB single table.](docs/assets/architecture.svg)

Request flow and the details behind each box: [`docs/architecture.md`](docs/architecture.md).

## How this project is run

The project follows a documented AI-assisted development process:
- **Research → decisions → requirements → backlog → build.** ADRs record each decision. The PRD numbers every requirement. GitHub Issues track work in parallel streams that separate AI agents can pick up without stepping on each other.
- **Agent guardrails:** [`CLAUDE.md`](CLAUDE.md) holds the rules every agent follows. Project skills in [`.claude/skills/`](.claude/skills/) encode the workflow (claiming a task, definition of done, journaling).
- **Evals first:** scenarios come from the PRD before the agent is built.

## Appendix — Run it yourself

Setup lives in runbooks, not here:
- AWS account setup: [`docs/runbooks/aws-setup.md`](docs/runbooks/aws-setup.md)
- Local development and deploys: [`docs/runbooks/deploy-env.md`](docs/runbooks/deploy-env.md) (deploy, check and tear down an environment)
