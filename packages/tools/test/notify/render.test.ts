import { describe, expect, it } from "vitest";

import type { EscalationNotice } from "../../src/notify";
import { NOTICE } from "./fixtures";
import {
  escapeHtml,
  NO_PROFILE,
  NO_TRANSCRIPT,
  REASON_LABELS,
  renderEscalationEmail,
} from "../../src/notify/render";

const HOSTILE = `<script>alert("x")</script> & 'q' <img src=x onerror=alert(1)>`;
const HOSTILE_ESCAPED =
  "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &lt;img src=x onerror=alert(1)&gt;";

describe("escapeHtml", () => {
  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
  ])("escapes %s", (raw, escaped) => {
    expect(escapeHtml(`a${raw}b${raw}`)).toBe(`a${escaped}b${escaped}`);
  });

  it("leaves other text alone", () => {
    expect(escapeHtml("Maria Santos, 9:00 AM — ok")).toBe("Maria Santos, 9:00 AM — ok");
  });
});

describe("renderEscalationEmail", () => {
  it("puts every field of the notice in the text and HTML bodies", () => {
    const { text, html } = renderEscalationEmail(NOTICE);
    for (const body of [text, html]) {
      expect(body).toContain("Maria Santos, date of birth 1984-03-12");
      expect(body).toContain(REASON_LABELS.patient_requested);
      expect(body).toContain(NOTICE.createdLocal);
      expect(body).toContain(NOTICE.escalationId);
      expect(body).toContain(NOTICE.conversationId);
      expect(body).toContain(NOTICE.summary);
    }
    expect(text).toContain(
      "Patient: I need to talk to someone about my bill.\n\nAssistant: I'll connect you",
    );
    expect(html).toContain("<strong>Patient:</strong> I need to talk to someone about my bill.");
    expect(html).toContain("<strong>Assistant:</strong> I&#39;ll connect you with our front desk.");
    // Transcript order is kept.
    expect(html.indexOf("Patient:</strong>")).toBeLessThan(html.indexOf("Assistant:</strong>"));
  });

  it("has a staff-facing label for every reason", () => {
    expect(REASON_LABELS).toEqual({
      patient_requested: "Patient asked for a person",
      repeated_failure: "Repeated failed attempts",
      frustration: "Patient frustrated",
      out_of_scope: "Request only staff can handle",
    });
  });

  it.each(Object.entries(REASON_LABELS))("labels reason %s", (reason, label) => {
    const email = renderEscalationEmail({ ...NOTICE, reason: reason as EscalationNotice["reason"] });
    expect(email.subject).toBe(`Patient escalation: ${label} (${NOTICE.escalationId})`);
    expect(email.text).toContain(`Reason: ${label}`);
  });

  it("says no profile is on file when the patient is null", () => {
    const { text, html } = renderEscalationEmail({ ...NOTICE, patient: null });
    expect(text).toContain(`Patient: ${NO_PROFILE}`);
    expect(html).toContain(NO_PROFILE);
    expect(text).not.toContain("date of birth");
  });

  it("says no messages are stored when the transcript is empty", () => {
    const { text, html } = renderEscalationEmail({ ...NOTICE, transcript: [] });
    expect(text).toContain(`(${NO_TRANSCRIPT})`);
    expect(html).toContain(NO_TRANSCRIPT);
  });

  it("keeps the summary, transcript and patient out of the subject", () => {
    const { subject } = renderEscalationEmail({
      ...NOTICE,
      summary: `Bcc: someone\r\n${HOSTILE}`,
      patient: { firstName: "Mal\r\nBcc:", lastName: "x", dateOfBirth: "1984-03-12" },
    });
    expect(subject).toBe(`Patient escalation: ${REASON_LABELS.patient_requested} (${NOTICE.escalationId})`);
  });

  it.each([
    ["summary", { summary: HOSTILE }],
    ["transcript text", { transcript: [{ role: "patient", text: HOSTILE, createdAt: NOTICE.createdAt }] }],
    ["first name", { patient: { firstName: HOSTILE, lastName: "Santos", dateOfBirth: "1984-03-12" } }],
    ["last name", { patient: { firstName: "Maria", lastName: HOSTILE, dateOfBirth: "1984-03-12" } }],
    ["date of birth", { patient: { firstName: "Maria", lastName: "Santos", dateOfBirth: HOSTILE } }],
    ["local time", { createdLocal: HOSTILE }],
    ["escalation id", { escalationId: HOSTILE }],
    ["conversation id", { conversationId: HOSTILE }],
  ] as [string, Partial<EscalationNotice>][])("escapes the %s in the HTML", (_field, override) => {
    const { html, text } = renderEscalationEmail({ ...NOTICE, ...override });
    expect(html).toContain(HOSTILE_ESCAPED);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    // The plain-text part carries the text verbatim.
    expect(text).toContain(HOSTILE);
  });
});
