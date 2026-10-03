import { LIMITS } from "@sched/contracts";
import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useState } from "react";

/** The character counter appears from here on, so it doesn't distract in normal use. */
export const COUNTER_FROM = LIMITS.chatTextMaxChars - 200;

export interface ComposerProps {
  /** Returns true if the message was taken (the composer then clears). */
  onSend: (text: string) => boolean;
  /** The agent is responding: Send is disabled, and Enter doesn't send. Typing stays possible. */
  responding: boolean;
  /** Extra controls beside Send, e.g. the microphone button (#28). */
  accessory?: ReactNode;
}

/**
 * The message box (FR-011): multiline; Enter sends, Shift+Enter adds a newline; Send is disabled
 * while the text is blank or the agent is responding; at most `LIMITS.chatTextMaxChars` characters.
 */
export function Composer({ onSend, responding, accessory }: ComposerProps) {
  const [text, setText] = useState("");
  const id = useId();
  const counterId = `${id}-counter`;
  const canSend = !responding && text.trim().length > 0;
  const showCounter = text.length >= COUNTER_FROM;

  const submit = () => {
    if (canSend && onSend(text)) setText("");
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an IME is composing confirms the composition; it must not send.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <form className="composer" onSubmit={onSubmit}>
      <label className="visually-hidden" htmlFor={`${id}-input`}>
        Message
      </label>
      <textarea
        id={`${id}-input`}
        className="composer__input"
        rows={2}
        maxLength={LIMITS.chatTextMaxChars}
        placeholder="Ask about appointments…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        aria-describedby={showCounter ? counterId : undefined}
      />
      <div className="composer__actions">
        {showCounter && (
          <span id={counterId} className="composer__counter">
            {text.length.toLocaleString("en-US")} / {LIMITS.chatTextMaxChars.toLocaleString("en-US")}
          </span>
        )}
        {accessory}
        <button type="submit" className="composer__send" disabled={!canSend}>
          Send
        </button>
      </div>
    </form>
  );
}
