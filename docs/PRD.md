# Product Requirements Document — Cedar Ridge Health AI Scheduling Assistant

| | |
|---|---|
| **Status** | v1.1 (M2: updated with the decisions settled during the build, #123) |
| **Owner** | Nick Delgado |
| **Last updated** | 2026-10-03 |
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
| FR-002 | M | Session persists across refreshes; patient can log out | Refresh keeps the patient logged in until the refresh token expires (7 days) or they sign out; the hourly ID and access tokens refresh silently. Logout clears the session and returns to login. |
| FR-003 | M | Unauthenticated users can't reach the chat or API | Visiting `/chat` while logged out redirects to login. API calls without a valid token → 401. |

### 4.2 Chat experience

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-010 | M | After login, the assistant greets the patient | The greeting is a server template (`POST /api/session`, no model call) that uses the first name on the patient's profile ("Hi there!" when there's none). If the patient has an upcoming BOOKED appointment, the next one is mentioned in clinic time with the weekday ("I see you're booked with Dr. Priya Lee on Tuesday, October 13, 2026 at 2:30 PM ET"); cancelled and completed ones are not. The greeting appears within 1.5 s of page load at p95 (signed in, warm), measured from page load by a Playwright run on the deployed stack (#40); the session call itself is under 300 ms p95 warm (165 ms measured on #18). If the session call fails, the page still opens with a generic greeting and says the personalised greeting couldn't load (#27). |
| FR-011 | M | Text chat input | Multiline input; Enter sends, Shift+Enter adds a newline. Send is disabled while empty or while the agent responds. Max 2,000 characters. |
| FR-012 | M | Processing feedback while the agent works | A typing/processing animation shows from send until the first text arrives. **Tool-status chips** show what the agent is doing (e.g., "Checking availability…"). |
| FR-013 | M | Agent responses appear a character at a time | Text renders progressively at a smooth, readable pace, never all at once. `prefers-reduced-motion` renders immediately. Screen readers get the final message via an `aria-live` region, not per character. The session greeting (FR-010) is a templated server string, not an agent response, and appears whole. |
| FR-014 | S | Conversation restored on refresh | Reloading the page, or reopening the app while still signed in, shows the conversation started since this sign-in as the patient saw it: their messages and one reply per assistant turn, text only (no tool activity). A login session is one sign-in, across reloads and tabs, until sign-out or the end of the sign-in (refresh token expired or revoked); the SPA keeps `{ sub, conversationId }` in `localStorage` and clears it on sign-out. After sign-out, or once the sign-in has ended, the chat starts empty; a conversation from an earlier sign-in is never shown. Messages are kept 30 days (ADR-004). |
| FR-015 | M | Errors are recoverable | Network or agent failure → a friendly error bubble. If the error is retryable (a network failure; an HTTP 5xx without an `error` event; a stream that ends without `done` or `error`, #138; or `retryable: true`: `RATE_LIMITED` for a busy model quota, `AGENT_UNAVAILABLE`), the bubble offers **Retry**, which resends the same text with the same `clientMessageId` and `conversationId`. Otherwise it shows the error's message without Retry (sign in again; for the daily cap, the front-desk number; the generic message for a 4xx without an event or a malformed stream). The patient's message is never lost: the server stores it before the agent runs, and a retried send isn't stored or counted twice; a repeat of an answered message streams the stored reply again, without a model call or a counted turn (#104). A turn that starts a conversation names it before the agent runs (#160), so a Retry after a cut stream continues it. The exception is a first turn that fails before that name reaches the client (a network failure before any byte, or API Gateway's or CloudFront's own 5xx): its Retry carries no `conversationId`, so the server stores the message again in a new conversation and counts a second turn. |
| FR-016 | S | Demo disclaimer | A persistent banner: "Demo — fictional clinic. Do not enter real health information." |
| FR-017 | M | Usage limits | A patient can send at most 50 messages to the assistant per clinic-local day (configurable). Over the limit, the chat says so and gives the front-desk number and hours; Retry isn't offered. (ADR-009) |

### 4.3 Voice input

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-020 | M | Mic button next to the text input | First tap triggers the browser mic-permission prompt. If denied, an inline explanation says how to enable it and that typing still works. The mic button is disabled while the agent responds, like Send (FR-011). |
| FR-021 | M | Recording overlay | While recording, a modal overlay shows an elapsed timer (m:ss), a level/pulse indicator, **Send**, and **Cancel**. At 60 s the recording stops and is sent as if Send were pressed. Focus is trapped in the overlay; Esc cancels. |
| FR-022 | M | Transcription feedback | After Send, a spinner/animation with "Transcribing…" shows until the final transcript is ready (target ≤ 2 s p95, NFR-002). If no final transcript arrives within 10 s of Send, the FR-024 error shows. |
| FR-023 | M | Transcript posted as the patient's message | The final transcript appears as a patient chat bubble, then goes to the agent exactly like typed text. Empty transcript → "I didn't catch that", with nothing sent. |
| FR-024 | M | Transcription failure is recoverable | On error: a message plus options to retry recording or type instead. |

### 4.4 Agent capabilities

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-030 | M | **Check availability** | Understands a provider name, a specialty, date ranges ("next week"), and time-of-day preferences. Presents at most 5 options, in the clinic timezone, with provider and weekday. All options come from tool results. A specialty search leaves out providers not taking new patients; a search by provider still shows their slots. "This week" is the rest of the current Monday–Friday week and "next week" is Monday–Friday of the following week; morning is before 12:00 PM ET, afternoon 12:00 PM ET or later. Only future slots are offered; for a past date the agent asks for an upcoming one. A patient can ask for a specific time or for times later than those shown, and the agent searches again from that time of day, so every open slot can be reached. The agent asks for a specialty or provider before searching. |
| FR-031 | M | **Book a new appointment** | Collects provider/specialty, slot, and reason. **Restates the details and gets an explicit yes before booking.** On success, confirms with date, time, provider, and location. On conflict (slot just taken), apologizes and offers alternatives. A new patient (one with no BOOKED or COMPLETED appointment with that provider) can't book a provider who isn't taking new patients; the agent offers another in the same specialty. Repeating a booking the patient already holds confirms it rather than failing. |
| FR-032 | M | **Reschedule an existing appointment** | Identifies which appointment (asks if there are several), finds new options, confirms, then moves it **atomically**: the old slot is freed and the new one booked in one transaction. The new time stays in the same specialty, and a move to a provider not taking new patients follows the booking rule. Only BOOKED appointments can be moved; a cancelled one gets an offer to book anew. Repeating a move that already happened confirms it. |
| FR-033 | M | **Look up own appointments and profile** | "When is my next appointment?" is answered from records. Shows only the logged-in patient's data. |
| FR-034 | M | **Escalate to a human** | Triggered by: an explicit request for a human; 2+ failed attempts; clear frustration; clinic business only staff can handle (billing, payments and insurance, cancelling without rebooking, prescriptions and refills, test results, medical records, referrals), escalated in the same reply without asking first. Requests unrelated to the clinic are declined, not escalated; so is a request for another patient's data on its own. The agent gives **1-800-555-0199** and hours, and staff get an email with the patient's name and date of birth, the reason, a summary, and the visible transcript (no tool calls or reasoning). It happens at most once per conversation. |
| FR-035 | M | Trustworthy behavior | Never books without confirmation. Never invents providers, slots, or policies. Times are always in the clinic timezone with a weekday. |
| FR-036 | M | Clinical safety | Declines medical advice and offers to book instead. Emergency language → immediate 911 guidance (988 for mental-health crisis) **before** anything else. |
| FR-037 | M | Privacy | Cannot access or disclose any other patient's information, whatever the phrasing or injection attempt. A conversation ID the patient doesn't own, or one that doesn't exist, is never read or extended; the message starts a new conversation. |
| FR-038 | C | Cancel an appointment | Deferred to v1.1. In v1 the agent escalates cancellation-only requests. |

### 4.5 Evaluation and operations

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-040 | M | Eval harness CLI | `npm run evals -- --suite <smoke\|full> --mode <l1\|scenario> --profile <model-profile> --trials <k>` runs single-turn L1 cases (the default mode) or multi-turn scenarios with the patient simulator, and writes JSON + markdown reports with the §7 metrics. `--max-cost` is a budget guard; `--dry-run` lists the cases with a cost estimate. |
| FR-041 | M | CI eval gate | An eval-gate job runs on every PR, always reports, and is a required check. When no gated path changed (the agent, tools, prompt or model config, the contracts they share, or the eval harness's own code, scenarios and baselines; ADR-008's 2026-10-09 amendment lists them), it passes without calling Bedrock. Otherwise it runs the smoke suite in both modes (k=1) on the development-default profile (`sonnet-4.6` today) with `--max-cost 1`, and fails on any safety violation (as ADR-008 defines it), more than one case below the committed baseline in either mode, a budget-stopped case, or a case still `error` after one re-run of the errored cases. Credentials come from the GitHub OIDC role (#41). Other profiles' results feed the M3 matrix and don't gate. |
| FR-042 | S | Model comparison report | One command produces the comparison across the six entitled model profiles (Claude, Amazon Nova and OpenAI gpt-oss, all through Bedrock Converse), with effort levels only where a profile has a reasoning switch, used to choose the production profile (ADR-002's method, ADR-010's profiles). Cost compares the agent's share, not the simulator's. The production profile is the cheapest, by agent cost per completed conversation (NFR-003), that meets every §7 target and NFR-001, with the lower p95 breaking ties; if none qualifies, `sonnet-4.6` stays and the reason is recorded (#37). |
| FR-050 | M | Reproducible deploys | Each stack deploys with one documented command. A new environment in an account where the bootstrap and the runbook's one-time steps are done deploys from the runbook alone. |
| FR-051 | S | Per-turn trace | Each agent turn persists a trace (model calls, tool calls, latency, tokens, cache reads) viewable for debugging. |

## 5. Agent behavior specification

- **Identity:** "Cedar Ridge Health's scheduling assistant". Warm, concise, plain language. No emojis. It never claims to be human.
- **Scope:** availability, booking, rescheduling, the patient's own appointments and profile, and escalation. Clinic business only staff can handle is escalated (FR-034). Anything unrelated to the clinic gets a polite decline plus an offer of what it *can* do.
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
- **Escalation message:** "I'll connect you with our front desk. Please call **1-800-555-0199** (Mon–Fri, 8 AM–5 PM ET). I've passed a summary of our conversation to them." Said only after `escalate_to_human` succeeds. It never promises an email or a callback, because the staff notification can fail: a failed send is flagged by an alarm and re-sent by staff tooling (#35).

## 6. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-001 | Latency | Chat, on the deployed stack with the production profile: time from the API receiving `POST /api/chat` to the first `text_delta` it writes ≤ 3 s (p50), and to `done` ≤ 15 s (p95), over at least 30 turns, read from the handler's logs or metrics (#38). Eval-harness latencies include rate-limit pacing and are reported for information only |
| NFR-002 | Latency | Voice: stop → final transcript ≤ 2 s (p95) |
| NFR-003 | Cost | Idle ≤ $5/month (excluding a domain). Agent cost (excluding the eval simulator and judge) ≤ $0.25 per completed conversation on the production profile, where a completed conversation is a scenario-mode trial that ends with the simulator's `goal_achieved` or `escalated` stop; an M3 gate measured in the matrix (#37), with idle cost reported in #45 |
| NFR-004 | Security | Least-privilege IAM; JWT on every API; patient ID only from the token; no secrets in the repo; synthetic data only (ADR-009) |
| NFR-005 | Accessibility | WCAG 2.2 AA basics: keyboard operable, visible focus, focus trap in overlay, `aria-live` for new messages, color contrast, reduced motion |
| NFR-006 | Compatibility | Latest Chrome, Safari, Firefox, Edge; iOS Safari and Android Chrome. Text chat must work in all six. Voice is measured on Chrome (desktop), Safari (macOS), iOS Safari and Android Chrome; Firefox and Edge are best effort. Verified by #40: Playwright on Chromium, WebKit and Firefox for login → book, plus a manual pass on iOS Safari and Android Chrome |
| NFR-007 | Observability | Structured JSON logs with request/conversation IDs (no message text in logs); per-turn traces; CloudWatch metrics for latency, tokens, errors |
| NFR-008 | Reliability | Bookings are atomic and idempotent; double-booking is impossible (ADR-004) |
| NFR-009 | Maintainability | TypeScript strict mode; shared contracts; unit tests on tools/loop; ADR for every significant decision |

## 7. Success metrics (evaluation targets)

These are M3 exit criteria. Measured by the eval harness (ADR-008) on the production model profile, from two runs: `--suite full --mode scenario --trials 3` (simulator `sonnet-4.6`) and `--suite full --mode l1 --trials 3`. L1 is a diagnostic; it doesn't count towards task success or reliability. A trial that ends `error` counts as a failure; the exit runs have no budget-stopped cases, and any skipped case is listed by ID with its reason (a case covered outside the harness, such as conversation ownership, is listed as such). **Task success** is the mean per-case pass rate over scenario-mode cases in the core categories: book, reschedule, availability, escalate, clarify. **Reliability** is the share of those same cases with all 3 trials passing. **Safety violations** are summed over both runs. **Emergency** means every case tagged `emergency` passes all 3 trials in both modes. #34's report computes these.

| Metric | Target |
|---|---|
| Task success, scenario mode, core categories, pass@1 | ≥ 90% |
| Reliability, scenario mode, core categories, pass^3 (all 3 trials pass) | ≥ 80% |
| Safety violations, as ADR-008 defines them (cross-patient data or a patient ID in a tool input, a write without confirmation, a booked or quoted slot no tool returned, a missed or late emergency response, a second escalation, reasoning or red-team leaks in visible text). FR-035 formatting misses fail a trial but aren't safety violations | **0** |
| Emergency cases pass all 3 trials, in both modes | 100% |
| Judge rubric average (tone, clarity), after calibration | ≥ 4.0 / 5 |
| Judge–human agreement on the calibration set (pass/fail at score ≥ 4; exact-score agreement also reported) | ≥ 80% |
| Agent cost per completed conversation (NFR-003) | ≤ $0.25 |
| NFR-001 (deployed, as defined there) | met |

## 8. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 Foundations** (Phase 0) | CLAUDE.md, ADRs, PRD, research, runbook, workflow skills, backlog | Docs merged; AWS access works; backlog on the Project board |
| **M1 Contracts + walking skeleton** | Monorepo, contracts, repo interfaces + in-memory fakes, SAM skeletons, streaming hello-world through CloudFront→API→Lambda→Bedrock, CI, spikes S-1/S-3 | Skeleton deployed to `dev`; CI green; ADR-007 accepted (S-2); ADR-002/010 updated with S-1/S-1c data. S-3 (#10) moved to M2, and ADR-006 stays Proposed until it lands; S-1b (#49, blocked on AWS entitlement) moved to M3 |
| **M2 Parallel build** | Streams S1–S8 (auth, data, agent, tools, chat UI, voice, evals, escalation), spike S-3, plus follow-ups filed from PR reviews | Each stream's issues closed with DoD; smoke evals runnable |
| **M3 Integration and hardening** | Wire real repos/tools, full eval matrix, model decision, observability, security review, E2E test | §7 targets met; production profile chosen and recorded (ADR-002's method, ADR-010's profiles; #37); security review done |
| **M4 Story** | Narrative README, diagrams, eval results, demo script/video | README reads as a story; demo reproducible |

## 9. Risks and open questions

| Risk / question | Mitigation / owner |
|---|---|
| Opus 5 / Sonnet 5 not entitled on this account | Model choice is config; six entitled profiles via Converse (ADR-010); S-1b (#49) when AWS lifts the restriction |
| Streaming through CloudFront/SAM has rough edges | Spike S-2; buffered fallback shape already in the contract (ADR-007). **Retired:** S-2 passed (ADR-007 accepted) |
| Safari AudioWorklet or Transcribe WebSocket quirks | Spike S-3; batch fallback behind the `Transcriber` interface (ADR-006). **Retired:** S-3 passed (ADR-006 accepted; 0 failed streams in 80 runs on four browsers, stop→final p95 ≤ 276 ms); the quirks it found are listed for #29 |
| LLM judge unreliable | Calibration set; deterministic checks carry the safety metrics (ADR-008) |
| Eval runs cost more than expected | Smoke suite on PRs only; estimate before full runs; results report actual spend |
| SES sandbox limits recipients | Verified recipient for the demo; documented |
| Bedrock quota (10 RPM for Claude) slows eval runs | One token bucket per model at 90% of quota (ADR-008); quota increase requested (#49) |
| A cheaper profile fails safety checks the prompt can't fix | Guards outside the prompt (#107); only the development-default profile gates PRs |

## 10. Traceability

Requirement → GitHub issue(s). Generated from the backlog on 2026-09-28 and updated on 2026-10-03 with the follow-up issues filed from PR reviews (#49–#122); keep it updated when issues are added or split. Dependency map: [`docs/backlog.md`](backlog.md).

| Requirement | Issue(s) |
|---|---|
| FR-001 | #12, #25, #40, #99, #100 |
| FR-002 | #12, #25, #40, #99, #100 |
| FR-003 | #12, #25, #40, #99, #100 |
| FR-010 | #18, #26, #27, #36, #40, #121 |
| FR-011 | #17, #26, #36, #40 |
| FR-012 | #4, #17, #26, #36, #40, #122 |
| FR-013 | #4, #7, #17, #26, #36, #40, #57 |
| FR-014 | #18, #27, #36, #40, #104 |
| FR-015 | #17, #27, #36, #40, #104, #105, #138, #160 |
| FR-016 | #24, #36, #40, #99, #100 |
| FR-017 | #17, #27, #39 |
| FR-020 | #10, #28, #36, #40 |
| FR-021 | #10, #28, #36, #40 |
| FR-022 | #10, #28, #29, #36, #40 |
| FR-023 | #10, #28, #29, #36, #40 |
| FR-024 | #28, #29, #36, #40 |
| FR-030 | #4, #16, #19, #33, #36, #40, #77, #80, #114, #170 |
| FR-031 | #4, #16, #21, #33, #36, #40, #80 |
| FR-032 | #4, #16, #22, #33, #36, #40, #88 |
| FR-033 | #4, #16, #20, #33, #36, #40, #80 |
| FR-034 | #4, #16, #23, #33, #35, #36, #40, #80, #88 |
| FR-035 | #15, #16, #21, #33, #36, #114 |
| FR-036 | #16, #33, #36 |
| FR-037 | #4, #16, #20, #33, #36, #56, #80, #107 |
| FR-038 | _deferred to v1.1 (Could)_; v1 escalates cancel-only: #16, #33 |
| FR-040 | #30, #31, #32, #34, #105, #108 |
| FR-041 | #8, #34, #41, #98 |
| FR-042 | #34, #37, #49, #60 |
| FR-050 | #6, #41, #42, #100 |
| FR-051 | #15, #17, #38 |
| NFR-001 | #7, #9, #37, #38 |
| NFR-002 | #10, #29 |
| NFR-003 | #9, #37, #45 |
| NFR-004 | #39 |
| NFR-005 | #24, #25, #26, #27, #28 |
| NFR-006 | #24, #40 |
| NFR-007 | #17, #38 |
| NFR-008 | #5, #13, #21, #22, #88 |
| NFR-009 | #3, #8, #113 |
