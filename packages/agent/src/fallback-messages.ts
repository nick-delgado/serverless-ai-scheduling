/**
 * Fixed replies the loop sends when the model can't produce one: after a second refusal, a second
 * `max_tokens` stop, or the iteration cap. They follow ADR-009: say what happened plainly, offer the
 * front desk, and never leave an emergency without the 911/988 line.
 *
 * The loop streams them as `text_delta` events and appends them to history as an ordinary assistant
 * message, so the next turn's model sees what the patient saw.
 */
import { CLINIC } from "@sched/contracts";

const FRONT_DESK = `our front desk at ${CLINIC.phone} (${CLINIC.hours})`;

export const FALLBACK_MESSAGES = {
  /** Both the primary and the fallback model refused. */
  refusal:
    `I'm sorry, I can't help with that here. For anything else about your appointments, you can reach ` +
    `${FRONT_DESK}. If this is an emergency, call 911, or call or text 988 for a mental health crisis.`,
  /** The reply still didn't fit after the retry with a larger budget, or the context window is full. */
  maxTokens:
    `I'm sorry, I couldn't finish my reply to that. Could you ask again in a shorter way? ` +
    `You can also reach ${FRONT_DESK}.`,
  /** The turn hit the iteration cap (ADR-001). */
  iterationLimit:
    `I'm sorry, I wasn't able to finish that request. Would you like me to connect you with our front desk? ` +
    `You can also call them at ${CLINIC.phone} (${CLINIC.hours}).`,
} as const;
