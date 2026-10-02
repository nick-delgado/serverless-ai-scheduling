# Product Requirements Document — Cedar Ridge Health AI Scheduling Assistant

| | |
|---|---|
| **Status** | v1.0 draft (Phase 0) |
| **Owner** | Nick Delgado |
| **Last updated** | 2026-09-28 |
| **Related** | `docs/architecture.md`, `docs/adr/`, GitHub Project "AI Scheduling Assistant" |

> Cedar Ridge Health is a **fictional** clinic. All patients, providers, and data are synthetic.

## 1. Problem

Booking a medical appointment usually means phone queues, business hours, and hold music. Clinics lose staff time to routine scheduling calls. Web booking forms help, but they're rigid. They make patients translate "sometime next week, preferably afternoons, with the same dermatologist as last time" into dropdowns.

A conversational assistant can take a patient's request in their own words, typed or spoken, and turn it into a correct booking. It has to be **trustworthy**: it never books the wrong slot, never books without consent, never leaks data, and knows when to hand off to a human.

## 2. Goals and non-goals

**Goals (v1)**
- G1. An authenticated patient can check availability, book, and reschedule appointments through natural conversation, by text or voice.
- G2. The agent escalates to a human appropriately: it provides a phone number and emails staff a summary with the transcript.
- G3. The agent's quality is **measured**, not assumed. An evaluation harness reports task success, reliability, safety, latency, and cost per model.
- G4. Fully serverless on AWS, provisioned with CloudFormation/SAM, with near-zero idle cost.
- G5. The build process is documented as a story (README + journal + ADRs) for portfolio review.

**Non-goals (v1)**
- Cancellations without rebooking. (A "could" for v1.1; today the agent escalates these.)
- Real EHR/PM-system integration, insurance verification, payments.
- Real PHI, HIPAA compliance, or production clinical use.
- Multi-clinic or multi-location, provider-side UI, or staff dashboards.
- Languages other than English; phone-call (telephony) voice.
- Patient self-registration.

## 3. Personas

| Persona | Description | What they need |
|---|---|---|
| **Maria** (primary) | 38, busy parent, mostly on her phone, often uses voice | Fast booking in a few turns; afternoon slots; no forms |
| **Walter** (primary) | 71, less comfortable with tech, prefers talking to people | Patient, clear language; easy path to a human |
| **Front-desk staff** (secondary) | Receive escalations | A concise summary + transcript in their email; no context lost |
| **Portfolio reviewer** (secondary) | Hiring manager / engineer evaluating Nick | Can try the demo quickly; can read *why* decisions were made and see eval evidence |

## 4. User stories and functional requirements

Priorities use MoSCoW: **M**ust, **S**hould, **C**ould.

### 4.1 Authentication

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-001 | M | Patient logs in with username and password on a simple login page | Valid credentials → chat page. Invalid → inline error, no account enumeration. Enter key submits. No self-sign-up link. |
| FR-002 | M | Session persists across refreshes; patient can log out | Refresh keeps the patient logged in until the token expires (tokens refresh silently). Logout clears the session and returns to login. |
| FR-003 | M | Unauthenticated users can't reach the chat or API | Visiting `/chat` while logged out redirects to login. API calls without a valid token → 401. |

### 4.2 Chat experience

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-010 | M | After login, the assistant greets the patient | The greeting uses the patient's first name. If they have an upcoming appointment, it's mentioned ("I see you're booked with Dr. Lee on Tue Oct 7 at 2:30 PM"). The greeting appears within 1.5 s of page load. |
| FR-011 | M | Text chat input | Multiline input; Enter sends, Shift+Enter adds a newline. Send is disabled while empty or while the agent responds. Max 2,000 characters. |
| FR-012 | M | Processing feedback while the agent works | A typing/processing animation shows from send until the first text arrives. **Tool-status chips** show what the agent is doing (e.g., "Checking availability…"). |
| FR-013 | M | Agent responses appear a character at a time | Text renders progressively at a smooth, readable pace, never all at once. `prefers-reduced-motion` renders immediately. Screen readers get the final message via an `aria-live` region, not per character. |
| FR-014 | S | Conversation restored on refresh | Reloading within the session shows prior messages of the current conversation. |
| FR-015 | M | Errors are recoverable | Network or agent failure → a friendly error bubble with **Retry**. The patient's message is never lost. |
| FR-016 | S | Demo disclaimer | A persistent banner: "Demo — fictional clinic. Do not enter real health information." |

### 4.3 Voice input

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-020 | M | Mic button next to the text input | First tap triggers the browser mic-permission prompt. If denied, an inline explanation says how to enable it and that typing still works. |
| FR-021 | M | Recording overlay | While recording, a modal overlay shows an elapsed timer (m:ss), a level/pulse indicator, **Send**, and **Cancel**. Recording auto-stops at 60 s. Focus is trapped in the overlay; Esc cancels. |
| FR-022 | M | Transcription feedback | After Send, a spinner/animation with "Transcribing…" shows until the final transcript is ready (target ≤ 2 s p95, NFR-002). |
| FR-023 | M | Transcript posted as the patient's message | The final transcript appears as a patient chat bubble, then goes to the agent exactly like typed text. Empty transcript → "I didn't catch that", with nothing sent. |
| FR-024 | M | Transcription failure is recoverable | On error: a message plus options to retry recording or type instead. |

### 4.4 Agent capabilities

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-030 | M | **Check availability** | Understands a provider name, a specialty, date ranges ("next week"), and time-of-day preferences. Presents at most 5 options, in the clinic timezone, with provider and weekday. All options come from tool results. A specialty search leaves out providers not taking new patients; a search by provider still shows their slots. |
| FR-031 | M | **Book a new appointment** | Collects provider/specialty, slot, and reason. **Restates the details and gets an explicit yes before booking.** On success, confirms with date, time, provider, and location. On conflict (slot just taken), apologizes and offers alternatives. A new patient can't book a provider who isn't taking new patients; the agent offers another in the same specialty. |
| FR-032 | M | **Reschedule an existing appointment** | Identifies which appointment (asks if there are several), finds new options, confirms, then moves it **atomically**: the old slot is freed and the new one booked in one transaction. The new time stays in the same specialty, and a move to a provider not taking new patients follows the booking rule. |
| FR-033 | M | **Look up own appointments and profile** | "When is my next appointment?" is answered from records. Shows only the logged-in patient's data. |
| FR-034 | M | **Escalate to a human** | Triggered by: an explicit request for a human; 2+ failed attempts; clear frustration; an out-of-scope request (billing, cancellation-only, prescriptions). The agent gives **1-800-555-0199** and hours, and staff get an email with a summary and transcript. It happens at most once per conversation. |
| FR-035 | M | Trustworthy behavior | Never books without confirmation. Never invents providers, slots, or policies. Times are always in the clinic timezone with a weekday. |
| FR-036 | M | Clinical safety | Declines medical advice and offers to book instead. Emergency language → immediate 911 guidance (988 for mental-health crisis) **before** anything else. |
| FR-037 | M | Privacy | Cannot access or disclose any other patient's information, whatever the phrasing or injection attempt. |
| FR-038 | C | Cancel an appointment | Deferred to v1.1. In v1 the agent escalates cancellation-only requests. |

### 4.5 Evaluation and operations

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-040 | M | Eval harness CLI | `npm run evals -- --suite <smoke\|full> --profile <model-profile> --trials <k>` runs scenarios and writes JSON + markdown reports with the §7 metrics. |
| FR-041 | M | CI eval gate | PRs touching agent, tools, prompts, or model config run the smoke suite. The PR fails on any safety violation or on a task-success regression beyond tolerance. |
| FR-042 | S | Model comparison report | One command produces the model × effort matrix used to choose the production model (ADR-002). |
| FR-050 | M | Reproducible deploys | Each stack deploys with one documented command. A clean-account deploy works from the runbook alone. |
| FR-051 | S | Per-turn trace | Each agent turn persists a trace (model calls, tool calls, latency, tokens, cache reads) viewable for debugging. |

## 5. Agent behavior specification

- **Identity:** "Cedar Ridge Health's scheduling assistant". Warm, concise, plain language. No emojis. It never claims to be human.
- **Scope:** availability, booking, rescheduling, the patient's own appointments and profile, and escalation. Everything else gets a polite decline plus an offer of what it *can* do.
- **Conversation rules:**
  1. Ask at most one clarifying question at a time.
  2. Offer concrete options, not open questions, when possible.
  3. Confirm before any write.
  4. After a write, summarize what changed.
- **Clinic facts (fixture):**
  - Timezone America/New_York. Hours Mon–Fri 8:00–17:00.
  - 1 location: 400 Cedar Ridge Pkwy (fictional).
  - Specialties: family medicine, pediatrics, dermatology, cardiology, physical therapy.
  - 8 providers. Visits are 30 min.
- **Escalation message:** "I'll connect you with our front desk. Please call **1-800-555-0199** (Mon–Fri, 8 AM–5 PM ET). I've also sent them a summary of our conversation so you won't have to repeat yourself."

## 6. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-001 | Latency | Chat: time to first streamed token ≤ 3 s (p50), full turn ≤ 15 s (p95), on the chosen production model profile |
| NFR-002 | Latency | Voice: stop → final transcript ≤ 2 s (p95) |
| NFR-003 | Cost | Idle ≤ $5/month (excluding a domain). Target ≤ $0.25 per completed scheduling conversation, to be confirmed after spike S-1 |
| NFR-004 | Security | Least-privilege IAM; JWT on every API; patient ID only from the token; no secrets in the repo; synthetic data only (ADR-009) |
| NFR-005 | Accessibility | WCAG 2.2 AA basics: keyboard operable, visible focus, focus trap in overlay, `aria-live` for new messages, color contrast, reduced motion |
| NFR-006 | Compatibility | Latest Chrome, Safari, Firefox, Edge; iOS Safari and Android Chrome |
| NFR-007 | Observability | Structured JSON logs with request/conversation IDs (no message text in logs); per-turn traces; CloudWatch metrics for latency, tokens, errors |
| NFR-008 | Reliability | Bookings are atomic and idempotent; double-booking is impossible (ADR-004) |
| NFR-009 | Maintainability | TypeScript strict mode; shared contracts; unit tests on tools/loop; ADR for every significant decision |

## 7. Success metrics (evaluation targets)

Measured by the eval harness (ADR-008) on the production model profile. These are M3 exit criteria.

| Metric | Target |
|---|---|
| Task success, core scenarios (book, reschedule, availability, escalate, clarify), pass@1 | ≥ 90% |
| Reliability, pass^3 (all 3 trials pass) | ≥ 80% |
| Safety violations (cross-patient data, write without confirmation, hallucinated slot, missed emergency) | **0** |
| Emergency scenarios handled correctly | 100% |
| Judge rubric average (tone, clarity), after calibration | ≥ 4.0 / 5 |
| Judge–human agreement on the calibration set | ≥ 80% |
| NFR-001 latency targets | met |

## 8. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 Foundations** (Phase 0) | CLAUDE.md, ADRs, PRD, research, runbook, workflow skills, backlog | Docs merged; AWS access works; backlog on the Project board |
| **M1 Contracts + walking skeleton** | Monorepo, contracts, repo interfaces + in-memory fakes, SAM skeletons, streaming hello-world through CloudFront→API→Lambda→Bedrock, CI, spikes S-1/S-3 | Skeleton deployed to `dev`; CI green; ADR-002/006/007 updated with spike data |
| **M2 Parallel build** | Streams S1–S8 (auth, data, agent, tools, chat UI, voice, evals, escalation) | Each stream's issues closed with DoD; smoke evals runnable |
| **M3 Integration and hardening** | Wire real repos/tools, full eval matrix, model decision, observability, security review, E2E test | §7 targets met; ADR-002 accepted; security review done |
| **M4 Story** | Narrative README, diagrams, eval results, demo script/video | README reads as a story; demo reproducible |

## 9. Risks and open questions

| Risk / question | Mitigation / owner |
|---|---|
| Opus 5 turn latency too high for chat | Effort tuning; the eval matrix may pick Sonnet 5 (ADR-002) |
| Streaming through CloudFront/SAM has rough edges | Spike S-2; buffered fallback shape already in the contract (ADR-007) |
| Safari AudioWorklet or Transcribe WebSocket quirks | Spike S-3; batch fallback behind the `Transcriber` interface (ADR-006) |
| LLM judge unreliable | Calibration set; deterministic checks carry the safety metrics (ADR-008) |
| Eval runs cost more than expected | Smoke suite on PRs only; estimate before full runs; results report actual spend |
| SES sandbox limits recipients | Verified recipient for the demo; documented |

## 10. Traceability

Requirement → GitHub issue(s). Generated from the backlog on 2026-09-28; keep it updated when issues are added or split. Dependency map: [`docs/backlog.md`](backlog.md).

| Requirement | Issue(s) |
|---|---|
| FR-001 | #12, #25, #40 |
| FR-002 | #12, #25, #40 |
| FR-003 | #12, #25, #40 |
| FR-010 | #18, #26, #36, #40 |
| FR-011 | #17, #26, #36, #40 |
| FR-012 | #4, #17, #26, #36, #40 |
| FR-013 | #4, #7, #17, #26, #36, #40 |
| FR-014 | #18, #27, #36, #40 |
| FR-015 | #17, #27, #36, #40 |
| FR-016 | #24, #36, #40 |
| FR-020 | #10, #28, #36, #40 |
| FR-021 | #10, #28, #36, #40 |
| FR-022 | #10, #29, #36, #40 |
| FR-023 | #10, #29, #36, #40 |
| FR-024 | #28, #29, #36, #40 |
| FR-030 | #4, #16, #19, #33, #36, #40 |
| FR-031 | #4, #16, #21, #33, #36, #40 |
| FR-032 | #4, #16, #22, #33, #36, #40 |
| FR-033 | #4, #16, #20, #33, #36, #40 |
| FR-034 | #4, #16, #23, #33, #35, #36, #40 |
| FR-035 | #15, #16, #21, #33, #36 |
| FR-036 | #16, #33, #36 |
| FR-037 | #4, #16, #20, #33, #36 |
| FR-038 | _deferred to v1.1 (Could)_ |
| FR-040 | #30, #34 |
| FR-041 | #8, #34 |
| FR-042 | #34, #37 |
| FR-050 | #6, #42 |
| FR-051 | #15, #17, #38 |
| NFR-001 | #7, #9 |
| NFR-002 | #10, #29 |
| NFR-003 | #9 |
| NFR-004 | #39 |
| NFR-005 | #24, #25, #26, #28 |
| NFR-006 | #24 |
| NFR-007 | #17, #38 |
| NFR-008 | #5, #13, #21, #22 |
| NFR-009 | #3, #8 |
