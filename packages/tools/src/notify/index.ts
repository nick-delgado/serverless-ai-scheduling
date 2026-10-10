/**
 * The Notifier seam (#23): how `escalate_to_human` tells front-desk staff about a handoff (FR-034).
 *
 * Tools depend only on this interface, injected through `ToolContext.notifier` (CLAUDE.md rule 3), so the
 * eval harness and unit tests run with `RecordingNotifier` and never send email. The SES implementation
 * (#35) is `./ses.ts`, a separate entry point (`@sched/tools/ses`); the chat handler wires it (#36).
 *
 * Everything in a notice except the ids is untrusted text (the patient's words, the model's summary):
 * an implementation must escape it for its medium (e.g. HTML email) and never interpret it.
 */
import type { EscalationNotice, Notifier, NotifyResult } from "./types";

export * from "./notice";
export * from "./render";
export * from "./types";

/** In-memory Notifier for tests and evals: records every notice; can be told to fail. */
export class RecordingNotifier implements Notifier {
  readonly sent: EscalationNotice[] = [];
  private failure: Error | undefined;

  /** Make subsequent calls throw `error` (or succeed again with `undefined`). */
  failWith(error: Error | undefined): void {
    this.failure = error;
  }

  notifyEscalation(notice: EscalationNotice): Promise<NotifyResult> {
    if (this.failure) return Promise.reject(this.failure);
    this.sent.push(structuredClone(notice));
    return Promise.resolve({ messageId: `recorded-${String(this.sent.length)}` });
  }
}
