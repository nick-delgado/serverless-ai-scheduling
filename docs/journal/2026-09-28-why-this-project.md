# 2026-09-28 — Why this project, and planning before building

**Chapter:** 1. The question
**Milestone:** M0 Foundations
**Related:** ADR-001…009, `docs/PRD.md`, desk research note

## What happened

The trigger was one line in a job posting for a Senior Full-Stack Product Engineer:

> "Have built or deeply explored an AI system beyond basic prompting or a thin API wrapper. Examples include a RAG pipeline, automated or tool-using agent, evaluation system, AI workflow, or model adaptation or post-training experiment."

Rather than describe something, we decided to build something that covers three of those examples at once:
- a **tool-using agent**,
- running an **AI workflow** (appointment scheduling),
- wrapped in an **evaluation system** that proves it works.

The domain is a patient booking a doctor's appointment. Everyone understands it, and it has real stakes: a wrong booking, a leaked record, or a missed emergency is obviously bad. That makes the evaluation story concrete.

Nick's first draft was specific about the user experience:
- a login page;
- a greeting from the agent;
- text chat, plus a mic button with a recording timer overlay and a "transcribing" spinner;
- responses that appear a character at a time;
- four capabilities: book, reschedule, check availability, and escalate to a human.

It was also specific about the platform: serverless AWS, CloudFormation, Bedrock, Transcribe, and DynamoDB. Two things were still open: where the agent should run, and which model.

We spent the first session **planning instead of coding**:
- desk research into the current AWS and Anthropic docs;
- nine ADRs;
- a PRD with numbered requirements and measurable eval targets;
- a runbook that gives AI agents scoped, short-lived access to the AWS account.

## Why we chose what we chose

- **We write our own agent loop instead of using a managed agent service** (ADR-001). The loop *is* the part that shows engineering: tool authorization, parallel tool calls, refusal handling, trace capture. Owning it also means the eval harness can run the exact production code in-process with a frozen clock.
- **The patient's identity comes from the login token, never from the model** (ADR-005/009). The obvious way to build this lets the LLM pass a `patientId` to its tools, which means a clever prompt could read someone else's records. We designed that out on day one.
- **Double-booking is impossible at the database level** (ADR-004). DynamoDB transactions with condition expressions, so even if the agent calls "book" twice, the data stays correct.
- **The model is a config value that the evals choose** (ADR-002). We default to Claude Opus 5 but will run a model × effort matrix (Opus 5, Sonnet 5, Haiku 4.5). The production model gets picked on measured task success, reliability, latency, and cost. Picking on vibes was not an option.
- **Evals are written before the agent** (ADR-008). Scenarios can be drafted straight from the PRD, which also makes them a spec.

## What surprised us

Research changed three assumptions from the first sketch:

1. **API Gateway REST APIs can stream now** (November 2025). The sketch used an HTTP API, which has a hard 30-second timeout. A multi-tool agent turn on a thinking model could hit that. REST API response streaming allows up to 15 minutes and lets us stream real tokens and live tool status ("Checking Dr. Lee's availability…") to the browser. (ADR-007)
2. **Transcribe Streaming wants real-time audio.** The obvious design is to record the clip, upload it, and transcribe it. But if a Lambda re-streams a finished clip at real-time pace, the patient waits about as long as they talked. Streaming from the browser *while* the patient speaks means the transcript is ready almost as soon as they tap send. (ADR-006)
3. **There are two Bedrock endpoints for Claude, and the vendors' docs lean different ways.** Anthropic presents the "Mantle" endpoint and SDK client; AWS recommends `bedrock-runtime` for new applications. We put the client behind an interface and let a spike decide. (ADR-002)

## Evidence

- Research sources: `docs/research/2026-09-28-desk-research.md`.
- `infra/bootstrap/bootstrap.yaml` passes `cfn-lint` 1.57.0 with no findings.

## What's next

- Nick sets up IAM Identity Center and deploys the bootstrap stack (runbook).
- Agents create the GitHub backlog. Then comes M1: the monorepo, the shared contracts, and a "walking skeleton" that streams one Bedrock response through CloudFront → API Gateway → Lambda. Spikes S-1 (model latency) and S-3 (browser transcription) run alongside.
