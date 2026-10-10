import "./voice.css";

import { type RefObject, Suspense, useContext, useEffect, useId, useRef } from "react";

import { RecordingOverlay } from "./RecordingOverlay";
import { TranscriberContext } from "./TranscriberContext";
import { type MicNotice, useRecording } from "./useRecording";
import { TimingPanel } from "./voiceTiming";

export const MIC_LABEL = "Record a voice message";
/** The missing-config state (#29 r1/A-3): a build without the Identity Pool ID. */
export const NO_VOICE = "Voice input isn't set up on this site. You can type your message.";
export const NOTICES: Record<MicNotice, string> = {
  denied:
    "Microphone access is blocked. To use voice, allow the microphone for this site in your browser's site settings, then tap the mic again. You can also type your message.",
  unavailable: "No microphone is available here. You can type your message instead.",
};

export interface VoiceInputProps {
  /** Post a transcript as the patient's message: `useChat().send`. */
  onTranscript: (text: string) => boolean;
  /** The agent is responding: the mic is disabled, like Send (FR-011, FR-020). */
  responding: boolean;
  /** The message box, focused by "Type instead". */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Voice input (S6-01, #28; FR-020 to FR-024): the mic button `ChatPage` passes as the composer's
 * `accessory`, the denied / unavailable notice beside it, and the recording overlay. The Transcriber
 * comes from `TranscriberContext` and owns the mic permission and audio (r1/Q-1 (a)).
 *
 * When the overlay closes, focus goes back to the mic, or to the message box after "Type instead".
 */
export function VoiceInput({ onTranscript, responding, inputRef }: VoiceInputProps) {
  const transcriber = useContext(TranscriberContext);
  const recording = useRecording({ transcriber, onTranscript });
  const micRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();

  const open = recording.phase !== null;
  const wasOpen = useRef(false);
  const focusInputOnClose = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      if (focusInputOnClose.current) inputRef.current?.focus();
      else micRef.current?.focus();
      focusInputOnClose.current = false;
    }
    wasOpen.current = open;
  }, [open, inputRef]);

  const typeInstead = () => {
    focusInputOnClose.current = true;
    recording.close();
  };

  const unavailable = transcriber === null;

  return (
    <>
      {recording.notice && (
        <p className="voice-notice" role="alert">
          <span>{NOTICES[recording.notice]}</span>{" "}
          <button type="button" className="voice-notice__type" onClick={() => inputRef.current?.focus()}>
            Type instead
          </button>
        </p>
      )}
      {unavailable && (
        <span id={noteId} className="voice-note">
          {NO_VOICE}
        </span>
      )}
      <button
        ref={micRef}
        type="button"
        className="voice-mic"
        aria-label={MIC_LABEL}
        aria-describedby={unavailable ? noteId : undefined}
        disabled={responding || unavailable}
        onClick={recording.record}
      >
        <MicIcon />
      </button>
      {recording.phase && (
        <RecordingOverlay
          phase={recording.phase}
          elapsedMs={recording.elapsedMs}
          level={recording.level}
          onSend={recording.send}
          onResend={recording.resend}
          onRecordAgain={recording.record}
          onTypeInstead={typeInstead}
          onCancel={recording.close}
        />
      )}
      {TimingPanel && (
        <Suspense fallback={null}>
          <TimingPanel />
        </Suspense>
      )}
    </>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
      />
    </svg>
  );
}
