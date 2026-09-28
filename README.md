# Building an AI scheduling assistant that can prove it works

> A serverless, tool-using AI agent that helps patients book and reschedule doctor's appointments by text or voice, and an evaluation harness that measures whether it gets them right.
>
> **Status:** Phase 0 complete (planning and foundations). The build is in progress. Follow along in the [journal](docs/journal/) and on the [project board](https://github.com/users/nick-delgado/projects/1).
>
> *Cedar Ridge Health is a fictional clinic. All data is synthetic.*

---

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
- **The evals pick the model.** Claude Opus 5, Sonnet 5, and Haiku 4.5 all run through the same scenarios. The one that ships is the one that meets the targets for success, reliability, latency, and cost. ([ADR-002](docs/adr/0002-model-and-bedrock-client.md), [ADR-008](docs/adr/0008-evaluation-strategy.md))

Research also overturned two of our first assumptions:
- **Streaming the reply:** API Gateway can now stream responses, so the agent's words and its "checking availability…" status reach the browser as they happen. ([ADR-007](docs/adr/0007-chat-transport.md))
- **Voice input:** the fastest design is to stream the patient's voice to Amazon Transcribe *while* they talk, not after. ([ADR-006](docs/adr/0006-voice-transcription.md))

All nine decisions are in [`docs/adr/`](docs/adr/); the requirements are in the [PRD](docs/PRD.md).

## Chapter 3 — The walking skeleton

*Coming in M1.* One request through every layer: browser → CloudFront → API Gateway → Lambda → Claude on Bedrock, and back as a stream.

## Chapter 4 — Teaching the agent to schedule

*Coming in M2.* The agent loop, the tools, and the first eval scores.

## Chapter 5 — What the evals showed

*Coming in M3.* Model × effort results, what broke, and what we changed.

## Chapter 6 — What I'd do next

*Coming in M4.*

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

Architecture diagram and request flow: [`docs/architecture.md`](docs/architecture.md).

## How this project is run

The project follows a documented AI-assisted development process:
- **Research → decisions → requirements → backlog → build.** ADRs record each decision. The PRD numbers every requirement. GitHub Issues track work in parallel streams that separate AI agents can pick up without stepping on each other.
- **Agent guardrails:** [`CLAUDE.md`](CLAUDE.md) holds the rules every agent follows. Project skills in [`.claude/skills/`](.claude/skills/) encode the workflow (claiming a task, definition of done, journaling).
- **Evals first:** scenarios come from the PRD before the agent is built.

## Appendix — Run it yourself

Setup lives in runbooks, not here:
- AWS account setup: [`docs/runbooks/aws-setup.md`](docs/runbooks/aws-setup.md)
- Local development and deploys: *coming with M1*
