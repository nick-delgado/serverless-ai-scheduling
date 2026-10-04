/**
 * The recording overlay (FR-021 to FR-024, NFR-005): a modal dialog with the m:ss timer, the level
 * indicator, Send recording and Cancel, then "Transcribing…" and the errors.
 *
 * - Focus moves to the phase's first button whenever the phase changes (so it's never lost when a
 *   button goes away), and Tab / Shift+Tab wrap inside the dialog. The trap is hand-written because
 *   jsdom's `HTMLDialogElement` has no `showModal()`.
 * - A click on the dialog's background focuses the dialog itself (`tabIndex={-1}`), not the page
 *   behind it, and Shift+Tab from there goes to the last button.
 * - Esc cancels, in every phase.
 * - The ticking timer is not a live region. The phase line ("Recording", "Transcribing…") is a status
 *   and the errors are alerts, so each is announced once.
 */
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { formatElapsed, type RecordingPhase } from "./useRecording";

export const NOT_CAUGHT = "I didn't catch that.";
export const TRANSCRIBE_FAILED = "Sorry, we couldn't turn that into text.";
export const NOT_SENT = "Your message wasn't sent. Try Send again in a moment.";

export interface RecordingOverlayProps {
  phase: RecordingPhase;
  elapsedMs: number;
  level: number;
  onSend: () => void;
  onResend: () => void;
  onRecordAgain: () => void;
  onTypeInstead: () => void;
  onCancel: () => void;
}

const STATUS: Record<RecordingPhase["name"], string> = {
  starting: "Starting…",
  recording: "Recording",
  transcribing: "Transcribing…",
  empty: "",
  failed: "",
  unsent: "",
};

const FOCUSABLE = "button:not(:disabled), [href], textarea, input, select, [tabindex]:not([tabindex='-1'])";

export function RecordingOverlay(props: RecordingOverlayProps) {
  const { phase, elapsedMs, level, onCancel } = props;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [phase.name]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      onCancel();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    // Cancel is in every phase, so there's always at least one.
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const showTimer = phase.name === "recording" || phase.name === "transcribing";

  return createPortal(
    <div className="voice-backdrop">
      <div
        ref={dialogRef}
        className="voice-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="voice-dialog__title">
          Voice message
        </h2>

        <div className="voice-dialog__meter">
          {phase.name === "recording" && (
            <span
              className="voice-level"
              data-testid="voice-level"
              aria-hidden="true"
              style={{ "--level": String(level) } as CSSProperties}
            />
          )}
          {phase.name === "transcribing" && <span className="voice-spinner" aria-hidden="true" />}
          {showTimer && (
            <span className="voice-dialog__timer" role="timer" aria-label="Recording time">
              {formatElapsed(elapsedMs)}
            </span>
          )}
        </div>

        <p className="voice-dialog__status" role="status">
          {STATUS[phase.name]}
        </p>
        {phase.name === "empty" && (
          <p className="voice-dialog__error" role="alert">
            {NOT_CAUGHT}
          </p>
        )}
        {phase.name === "failed" && (
          <p className="voice-dialog__error" role="alert">
            {TRANSCRIBE_FAILED}
          </p>
        )}
        {phase.name === "unsent" && (
          <>
            <p className="voice-dialog__transcript" data-testid="voice-transcript">
              {phase.text}
            </p>
            <p className="voice-dialog__error" role="alert">
              {NOT_SENT}
            </p>
          </>
        )}

        <div className="voice-dialog__actions">
          <PhaseActions {...props} />
          <button type="button" className="voice-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The phase's own buttons, primary first; Cancel follows them in every phase. */
function PhaseActions({ phase, onSend, onResend, onRecordAgain, onTypeInstead }: RecordingOverlayProps) {
  switch (phase.name) {
    case "recording":
    case "unsent":
      return (
        <button
          type="button"
          className="voice-button voice-button--primary"
          aria-label="Send recording"
          onClick={phase.name === "recording" ? onSend : onResend}
        >
          Send
        </button>
      );
    case "empty":
    case "failed":
      return (
        <>
          <button type="button" className="voice-button voice-button--primary" onClick={onRecordAgain}>
            Record again
          </button>
          <button type="button" className="voice-button" onClick={onTypeInstead}>
            Type instead
          </button>
        </>
      );
    default:
      return null;
  }
}
