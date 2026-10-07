import { z } from "zod";

/** Fixed facts about the (fictional) clinic. PRD §5. */
export const CLINIC = {
  name: "Cedar Ridge Health",
  address: "400 Cedar Ridge Pkwy",
  timezone: "America/New_York",
  timezoneAbbrev: "ET",
  phone: "1-800-555-0199",
  hours: "Mon–Fri, 8 AM–5 PM ET",
  openHour: 8,
  closeHour: 17,
  visitMinutes: 30,
} as const;

/**
 * What the patient reads when they reach the daily turn cap (ADR-009). One source for the chat API's
 * `RATE_LIMITED` error and the web mock's `daily_cap` fault (#104).
 */
export const DAILY_CAP_MESSAGE = `You've reached today's message limit for the assistant. Please try again tomorrow, or call our front desk at ${CLINIC.phone} (${CLINIC.hours}).`;

/** Shared limits so the API, tools, UI, and evals agree. */
export const LIMITS = {
  chatTextMaxChars: 2000,
  availabilityMaxSlots: 5,
  availabilityMaxRangeDays: 31,
  providersMaxResults: 20,
  reasonMaxChars: 300,
  escalationSummaryMinChars: 10,
  escalationSummaryMaxChars: 1000,
  /** Longest error text stored on an escalation's FAILED notification (`Escalation.notification.error`). */
  escalationNotificationErrorMaxChars: 500,
} as const;

export const SPECIALTIES = [
  "family_medicine",
  "pediatrics",
  "dermatology",
  "cardiology",
  "physical_therapy",
] as const;

export const Specialty = z.enum(SPECIALTIES);
export type Specialty = z.infer<typeof Specialty>;

export const SPECIALTY_LABELS: Record<Specialty, string> = {
  family_medicine: "Family medicine",
  pediatrics: "Pediatrics",
  dermatology: "Dermatology",
  cardiology: "Cardiology",
  physical_therapy: "Physical therapy",
};
