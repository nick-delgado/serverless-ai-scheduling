import { EXAMPLES } from "@sched/contracts/testing";

import type { EscalationNotice } from "../../src/notify";

/** Synthetic notice (Cedar Ridge fixture people are fictional). */
export const NOTICE: EscalationNotice = {
  escalationId: EXAMPLES.EscalationId,
  conversationId: EXAMPLES.ConversationId,
  patient: {
    firstName: EXAMPLES.Patient.firstName,
    lastName: EXAMPLES.Patient.lastName,
    dateOfBirth: EXAMPLES.Patient.dateOfBirth,
  },
  reason: "patient_requested",
  summary: "Patient wants to discuss a billing question with a person.",
  createdAt: "2026-10-05T13:00:00Z",
  createdLocal: "Monday, October 5, 2026 at 9:00 AM ET",
  transcript: [
    { role: "patient", text: "I need to talk to someone about my bill.", createdAt: "2026-10-05T12:59:00Z" },
    { role: "assistant", text: "I'll connect you with our front desk.", createdAt: "2026-10-05T13:00:00Z" },
  ],
};
