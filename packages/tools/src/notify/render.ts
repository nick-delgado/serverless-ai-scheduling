/**
 * The staff email for an escalation (FR-034, #35): a subject, a plain-text body and a simple HTML body.
 *
 * Everything in a notice except the ids, the reason and the timestamps is untrusted text: the summary is
 * the model's, the transcript is the patient's and the model's words, and the profile fields were typed by
 * a person (ADR-009, CLAUDE.md rule 5). So:
 * - the subject carries no notice text at all, only our reason label and the escalation id;
 * - every value in the HTML body goes through `escapeHtml`, including the ones we trust today;
 * - the plain-text body includes the text verbatim (a text/plain part is never interpreted).
 */
import type { EscalationReason } from "@sched/contracts";

import type { EscalationNotice } from "./index";

export const REASON_LABELS: Record<EscalationReason, string> = {
  patient_requested: "Patient asked for a person",
  repeated_failure: "Repeated failed attempts",
  frustration: "Patient frustrated",
  out_of_scope: "Request only staff can handle",
};

export const NO_PROFILE = "No profile on file";
export const NO_TRANSCRIPT = "No messages stored";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for an HTML element body or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function patientLine(notice: EscalationNotice): string {
  const p = notice.patient;
  return p ? `${p.firstName} ${p.lastName}, date of birth ${p.dateOfBirth}` : NO_PROFILE;
}

const speaker = (role: "patient" | "assistant"): string => (role === "patient" ? "Patient" : "Assistant");

export function renderEscalationEmail(notice: EscalationNotice): RenderedEmail {
  const reason = REASON_LABELS[notice.reason];
  const facts: [label: string, value: string][] = [
    ["Patient", patientLine(notice)],
    ["Reason", reason],
    ["When", notice.createdLocal],
    ["Escalation", notice.escalationId],
    ["Conversation", notice.conversationId],
  ];

  const text = [
    "A patient conversation was handed to the front desk.",
    "",
    ...facts.map(([label, value]) => `${label}: ${value}`),
    "",
    "Summary:",
    notice.summary,
    "",
    "Transcript:",
    notice.transcript.length === 0
      ? `(${NO_TRANSCRIPT})`
      : notice.transcript.map((l) => `${speaker(l.role)}: ${l.text}`).join("\n\n"),
  ].join("\n");

  const e = escapeHtml;
  const cell = "padding:2px 12px 2px 0;vertical-align:top";
  const transcriptHtml =
    notice.transcript.length === 0
      ? `<p><em>${e(NO_TRANSCRIPT)}</em></p>`
      : notice.transcript
          .map(
            (l) =>
              `<p style="margin:0 0 10px;white-space:pre-wrap"><strong>${e(speaker(l.role))}:</strong> ${e(l.text)}</p>`,
          )
          .join("\n");
  const html = [
    "<!doctype html>",
    '<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a">',
    "<p>A patient conversation was handed to the front desk.</p>",
    "<table>",
    ...facts.map(
      ([label, value]) =>
        `<tr><th style="${cell};text-align:left">${e(label)}</th><td style="${cell}">${e(value)}</td></tr>`,
    ),
    "</table>",
    "<h3>Summary</h3>",
    `<p style="white-space:pre-wrap">${e(notice.summary)}</p>`,
    "<h3>Transcript</h3>",
    transcriptHtml,
    "</body></html>",
  ].join("\n");

  return { subject: `Patient escalation: ${reason} (${notice.escalationId})`, text, html };
}
