/**
 * The mic, the denied notice and the recording overlay (S6-01, #28; FR-020 to FR-024, NFR-005),
 * driven through a `MockTranscriber`. Fake time for the timer, the 60 s cap and the 10 s wait, with
 * `fireEvent` (user-event stalls under fake timers); no assertion on how long real I/O takes.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeTime } from "../chat/testUtils";
import { MOCK_LEVELS, MockTranscriber, type MockTranscriberOptions } from "./MockTranscriber";
import { NOT_CAUGHT, NOT_SENT, TRANSCRIBE_FAILED } from "./RecordingOverlay";
import { type Transcriber, type TranscriberCallbacks, TranscriberError } from "./transcriber";
import { TranscriberContext } from "./TranscriberContext";
import { FINAL_TIMEOUT_MS, formatElapsed, RECORDING_CAP_MS, TICK_MS } from "./useRecording";
import { MIC_LABEL, NO_VOICE, NOTICES, VoiceInput } from "./VoiceInput";

beforeEach(() => fakeTime());
afterEach(() => {
  vi.useRealTimers();
});

/** Advance fake time, settling promises between timers. */
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

interface Setup {
  onTranscript?: (text: string) => boolean;
  responding?: boolean;
}

function renderVoice(
  transcriber: Transcriber | null,
  { onTranscript = () => true, responding = false }: Setup = {},
) {
  const spy = vi.fn(onTranscript);
  function Harness() {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    return (
      <TranscriberContext.Provider value={transcriber}>
        <textarea aria-label="Message" ref={inputRef} />
        <VoiceInput onTranscript={spy} responding={responding} inputRef={inputRef} />
      </TranscriberContext.Provider>
    );
  }
  const view = render(<Harness />);
  return { ...view, onTranscript: spy };
}

const mic = () => screen.getByRole("button", { name: MIC_LABEL });
const dialog = () => screen.queryByRole("dialog", { name: "Voice message" });
const inDialog = () => within(dialog() as HTMLElement);
const status = () => inDialog().getByRole("status");
const timer = () => inDialog().getByRole("timer");
const button = (name: string) => inDialog().getByRole("button", { name });
const messageBox = () => screen.getByRole("textbox", { name: "Message" });

/** Tap the mic and let `start()` resolve (no start delay). */
async function startRecording(transcriber: MockTranscriber) {
  fireEvent.click(mic());
  await advance(0);
  expect(status()).toHaveTextContent("Recording");
  return transcriber.sessions[transcriber.sessions.length - 1];
}

function mock(options: MockTranscriberOptions = {}) {
  return new MockTranscriber(options);
}

describe("formatElapsed", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [9_000, "0:09"],
    [59_999, "0:59"],
    [60_000, "1:00"],
    [65_000, "1:05"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe("the mic button (FR-020)", () => {
  it("opens the overlay, which asks the Transcriber for the mic, with focus inside", async () => {
    const transcriber = mock({ startDelayMs: 500 });
    renderVoice(transcriber);
    fireEvent.click(mic());

    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(status()).toHaveTextContent("Starting…");
    expect(transcriber.starts).toBe(1);
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    expect(inDialog().queryByRole("timer")).not.toBeInTheDocument();
  });

  it("is disabled while the agent responds, like Send", () => {
    renderVoice(mock(), { responding: true });
    expect(mic()).toBeDisabled();
  });

  it("is enabled otherwise, with no note, and doesn't take focus on render", () => {
    renderVoice(mock());
    expect(mic()).toBeEnabled();
    expect(mic()).not.toHaveAttribute("aria-describedby");
    expect(mic()).not.toHaveFocus();
  });

  it("a second tap before start() resolves cancels the first recording", async () => {
    const transcriber = mock({ startDelayMs: 500 });
    renderVoice(transcriber);
    fireEvent.click(mic());
    fireEvent.click(mic());
    await advance(500);

    expect(transcriber.sessions.map((session) => session.state)).toEqual(["cancelled", "recording"]);
    expect(status()).toHaveTextContent("Recording");
  });

  it("is disabled with a one-line note when there's no Transcriber", () => {
    renderVoice(null);
    expect(mic()).toBeDisabled();
    expect(mic()).toHaveAccessibleDescription(NO_VOICE);
  });

  it("denied: closes the overlay and shows the guidance beside the composer, with Type instead", async () => {
    const transcriber = mock({ denied: true });
    renderVoice(transcriber);
    fireEvent.click(mic());
    await advance(0);

    expect(dialog()).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(NOTICES.denied);
    expect(mic()).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Type instead" }));
    expect(messageBox()).toHaveFocus();
  });

  it("denied, then a later tap asks again and clears the notice", async () => {
    const transcriber = mock({ denied: true });
    renderVoice(transcriber);
    fireEvent.click(mic());
    await advance(0);
    transcriber.options = {};

    await startRecording(transcriber);
    expect(transcriber.starts).toBe(2);
    expect(screen.queryByText(NOTICES.denied)).not.toBeInTheDocument();
  });

  it("unavailable: its own message, with Type instead", async () => {
    renderVoice(mock({ unavailable: true }));
    fireEvent.click(mic());
    await advance(0);

    expect(dialog()).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(NOTICES.unavailable);
    expect(screen.getByRole("button", { name: "Type instead" })).toBeInTheDocument();
  });

  it("a start() rejection that isn't a TranscriberError counts as failed", async () => {
    renderVoice({ start: () => Promise.reject(new Error("boom")) });
    fireEvent.click(mic());
    await advance(0);

    expect(inDialog().getByRole("alert")).toHaveTextContent(TRANSCRIBE_FAILED);
  });

  it("a start() failure that isn't denied or unavailable shows the FR-024 error in the overlay", async () => {
    renderVoice(mock({ error: "start" }));
    fireEvent.click(mic());
    await advance(0);

    expect(inDialog().getByRole("alert")).toHaveTextContent(TRANSCRIBE_FAILED);
    expect(button("Record again")).toBeInTheDocument();
  });
});

describe("the recording overlay (FR-021)", () => {
  it("starts the m:ss timer when recording begins, not on the tap", async () => {
    renderVoice(mock({ startDelayMs: 1_500 }));
    fireEvent.click(mic());
    await advance(1_500);
    expect(status()).toHaveTextContent("Recording");
    expect(timer()).toHaveTextContent("0:00");

    await advance(5_000);
    // From the tap it would be 6.5 s.
    expect(timer()).toHaveTextContent("0:05");
  });

  it("shows the Transcriber's input level", async () => {
    const transcriber = mock({ levelIntervalMs: 100 });
    renderVoice(transcriber);
    await startRecording(transcriber);
    await advance(100);
    expect(screen.getByTestId("voice-level").style.getPropertyValue("--level")).toBe(String(MOCK_LEVELS[0]));
    await advance(100);
    expect(screen.getByTestId("voice-level").style.getPropertyValue("--level")).toBe(String(MOCK_LEVELS[1]));
  });

  it("starts the level at 0 again on Record again", async () => {
    const transcriber = mock({ levelIntervalMs: 100, transcript: "" });
    renderVoice(transcriber);
    await startRecording(transcriber);
    await advance(100);
    fireEvent.click(button("Send recording"));
    await advance(0);
    fireEvent.click(button("Record again"));
    await advance(0);
    expect(screen.getByTestId("voice-level").style.getPropertyValue("--level")).toBe("0");
  });

  it("is a labelled modal dialog whose Send keeps the visible word", async () => {
    const transcriber = mock();
    renderVoice(transcriber);
    await startRecording(transcriber);
    expect(button("Send recording")).toHaveTextContent(/^Send$/);
    expect(button("Cancel")).toBeInTheDocument();
  });

  it("traps focus: Tab from the last button wraps to the first, Shift+Tab from the first to the last", async () => {
    const transcriber = mock();
    renderVoice(transcriber);
    await startRecording(transcriber);
    const send = button("Send recording");
    const cancel = button("Cancel");
    expect(send).toHaveFocus();

    cancel.focus();
    // Prevented, so the browser doesn't also move focus out of the dialog.
    expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(false);
    expect(send).toHaveFocus();

    expect(fireEvent.keyDown(send, { key: "Tab", shiftKey: true })).toBe(false);
    expect(cancel).toHaveFocus();
  });

  it("leaves Tab alone between the first and last buttons", async () => {
    const transcriber = mock();
    renderVoice(transcriber);
    await startRecording(transcriber);
    const send = button("Send recording");
    // Not prevented: the browser moves on by itself.
    expect(fireEvent.keyDown(send, { key: "Tab" })).toBe(true);
    expect(send).toHaveFocus();
    const cancel = button("Cancel");
    cancel.focus();
    expect(fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true })).toBe(true);
    expect(cancel).toHaveFocus();
  });

  it("Shift+Tab from the dialog itself (after a click on its background) goes to the last button", async () => {
    const transcriber = mock();
    renderVoice(transcriber);
    await startRecording(transcriber);
    const box = dialog() as HTMLElement;
    box.focus();
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(button("Cancel")).toHaveFocus();
  });

  it("keeps focus inside the dialog when the focused button goes away", async () => {
    const transcriber = mock({ neverFinal: true });
    renderVoice(transcriber);
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(0);
    expect(button("Cancel")).toHaveFocus();
  });

  it("stops the timer at Send", async () => {
    const transcriber = mock({ neverFinal: true });
    renderVoice(transcriber);
    await startRecording(transcriber);
    await advance(3_000);
    fireEvent.click(button("Send recording"));
    await advance(5_000);
    expect(timer()).toHaveTextContent("0:03");
  });

  it("Cancel discards the recording, closes, and puts focus back on the mic", async () => {
    const transcriber = mock();
    const { onTranscript } = renderVoice(transcriber);
    const session = await startRecording(transcriber);
    fireEvent.click(button("Cancel"));
    await advance(RECORDING_CAP_MS + FINAL_TIMEOUT_MS);

    expect(dialog()).not.toBeInTheDocument();
    expect(session?.state).toBe("cancelled");
    expect(onTranscript).not.toHaveBeenCalled();
    expect(mic()).toHaveFocus();
  });

  it("Esc cancels while recording", async () => {
    const transcriber = mock();
    const { onTranscript } = renderVoice(transcriber);
    const session = await startRecording(transcriber);
    fireEvent.keyDown(button("Send recording"), { key: "Escape" });
    await advance(RECORDING_CAP_MS + FINAL_TIMEOUT_MS);

    expect(dialog()).not.toBeInTheDocument();
    expect(session?.state).toBe("cancelled");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("Esc cancels while transcribing, and the transcript that arrives later isn't sent", async () => {
    const transcriber = mock({ delayMs: 2_000 });
    const { onTranscript } = renderVoice(transcriber);
    const session = await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(0);
    fireEvent.keyDown(button("Cancel"), { key: "Escape" });
    await advance(2_000);

    expect(dialog()).not.toBeInTheDocument();
    expect(session?.state).toBe("cancelled");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("Cancel while starting cancels the session that start() resolves with later", async () => {
    const transcriber = mock({ startDelayMs: 1_000 });
    renderVoice(transcriber);
    fireEvent.click(mic());
    fireEvent.click(button("Cancel"));
    await advance(1_000);

    expect(dialog()).not.toBeInTheDocument();
    expect(transcriber.sessions).toHaveLength(1);
    expect(transcriber.sessions[0]?.state).toBe("cancelled");
  });

  it("unmounting cancels the recording", async () => {
    const transcriber = mock();
    const { unmount } = renderVoice(transcriber);
    const session = await startRecording(transcriber);
    unmount();
    expect(session?.state).toBe("cancelled");
  });
});

describe("the 60 s cap (FR-021)", () => {
  it("sends at 60 s as if Send were pressed, showing 1:00", async () => {
    const transcriber = mock({ delayMs: 1_000, transcript: "Book Wednesday" });
    const { onTranscript } = renderVoice(transcriber);
    const session = await startRecording(transcriber);

    await advance(RECORDING_CAP_MS - TICK_MS);
    expect(status()).toHaveTextContent("Recording");
    expect(timer()).toHaveTextContent("0:59");
    expect(session?.state).toBe("recording");

    await advance(TICK_MS);
    expect(status()).toHaveTextContent("Transcribing…");
    expect(timer()).toHaveTextContent("1:00");
    expect(session?.state).toBe("stopped");

    await advance(1_000);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Book Wednesday");
    expect(dialog()).not.toBeInTheDocument();
  });

  it("reads the clock, not the ticks, so a throttled tab still stops at 60 s", async () => {
    const transcriber = mock({ neverFinal: true });
    renderVoice(transcriber);
    await startRecording(transcriber);
    // The clock jumps 65 s while no timer fires, as in a background tab.
    vi.setSystemTime(Date.now() + RECORDING_CAP_MS + 5_000);
    await advance(TICK_MS);
    expect(status()).toHaveTextContent("Transcribing…");
    expect(timer()).toHaveTextContent("1:00");
  });

  it("shows the FR-024 error 10 s after the auto-send if no final transcript arrives", async () => {
    const transcriber = mock({ neverFinal: true });
    renderVoice(transcriber);
    await startRecording(transcriber);
    await advance(RECORDING_CAP_MS + FINAL_TIMEOUT_MS - 1);
    expect(status()).toHaveTextContent("Transcribing…");
    await advance(1);
    expect(inDialog().getByRole("alert")).toHaveTextContent(TRANSCRIBE_FAILED);
  });
});

describe("transcription (FR-022 to FR-024)", () => {
  it("Send shows Transcribing… with a spinner, then posts the trimmed transcript and closes", async () => {
    const transcriber = mock({ delayMs: 1_000, transcript: "  Book Wednesday at 10  " });
    const { onTranscript } = renderVoice(transcriber);
    const session = await startRecording(transcriber);
    await advance(3_000);
    fireEvent.click(button("Send recording"));
    await advance(0);

    expect(status()).toHaveTextContent("Transcribing…");
    expect(timer()).toHaveTextContent("0:03");
    expect(session?.state).toBe("stopped");
    expect(onTranscript).not.toHaveBeenCalled();

    await advance(1_000);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Book Wednesday at 10");
    expect(dialog()).not.toBeInTheDocument();
    expect(mic()).toHaveFocus();
  });

  it("an empty transcript shows I didn't catch that and sends nothing", async () => {
    const transcriber = mock({ transcript: "  \n " });
    const { onTranscript } = renderVoice(transcriber);
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(0);

    expect(inDialog().getByRole("alert")).toHaveTextContent(NOT_CAUGHT);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(button("Record again")).toHaveFocus();
    expect(button("Type instead")).toBeInTheDocument();
  });

  it("Record again starts a new recording at once in the same overlay", async () => {
    const transcriber = mock({ transcript: "" });
    renderVoice(transcriber);
    await startRecording(transcriber);
    await advance(3_000);
    fireEvent.click(button("Send recording"));
    await advance(0);
    fireEvent.click(button("Record again"));
    await advance(0);

    expect(transcriber.starts).toBe(2);
    expect(status()).toHaveTextContent("Recording");
    expect(timer()).toHaveTextContent("0:00");
  });

  it("no final transcript within 10 s of Send: the FR-024 error, the session cancelled", async () => {
    const transcriber = mock({ neverFinal: true });
    renderVoice(transcriber);
    const session = await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(FINAL_TIMEOUT_MS - 1);
    expect(status()).toHaveTextContent("Transcribing…");
    expect(session?.state).toBe("stopped");

    await advance(1);
    expect(inDialog().getByRole("alert")).toHaveTextContent(TRANSCRIBE_FAILED);
    expect(session?.state).toBe("cancelled");
    expect(button("Record again")).toBeInTheDocument();
    expect(button("Type instead")).toBeInTheDocument();
  });

  it("a transcript that arrives after the 10 s timeout is discarded", async () => {
    const transcriber = mock({ delayMs: FINAL_TIMEOUT_MS + 2_000 });
    const { onTranscript } = renderVoice(transcriber);
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(FINAL_TIMEOUT_MS + 2_000);

    expect(onTranscript).not.toHaveBeenCalled();
    expect(inDialog().getByRole("alert")).toHaveTextContent(TRANSCRIBE_FAILED);
  });

  it("a transcript in time clears the 10 s timer", async () => {
    const transcriber = mock({ delayMs: 1_000 });
    const { onTranscript } = renderVoice(transcriber, { onTranscript: () => false });
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(1_000 + FINAL_TIMEOUT_MS);

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(inDialog().queryByText(TRANSCRIBE_FAILED)).not.toBeInTheDocument();
  });

  it("stop() failing shows the FR-024 error", async () => {
    const transcriber = mock({ error: "stop" });
    const { onTranscript } = renderVoice(transcriber);
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(0);

    expect(inDialog().getByRole("alert")).toHaveTextContent(TRANSCRIBE_FAILED);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("a failure while recording shows the FR-024 error and cancels the session", async () => {
    const transcriber = mock({ error: "recording", errorAfterMs: 2_000 });
    renderVoice(transcriber);
    const session = await startRecording(transcriber);
    await advance(2_000);

    expect(inDialog().getByRole("alert")).toHaveTextContent(TRANSCRIBE_FAILED);
    expect(session?.state).toBe("cancelled");
    expect(inDialog().queryByRole("timer")).not.toBeInTheDocument();
  });

  it("Type instead closes the overlay and focuses the message box", async () => {
    const transcriber = mock({ neverFinal: true });
    renderVoice(transcriber);
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(FINAL_TIMEOUT_MS);
    fireEvent.click(button("Type instead"));
    await advance(0);

    expect(dialog()).not.toBeInTheDocument();
    expect(messageBox()).toHaveFocus();
  });

  it("send() returning false keeps the overlay open with the transcript, and Send tries again", async () => {
    const transcriber = mock({ transcript: "Book Wednesday" });
    const answers = [false, true];
    const { onTranscript } = renderVoice(transcriber, { onTranscript: () => answers.shift() ?? false });
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(0);

    expect(dialog()).toBeInTheDocument();
    expect(screen.getByTestId("voice-transcript")).toHaveTextContent("Book Wednesday");
    expect(inDialog().getByRole("alert")).toHaveTextContent(NOT_SENT);
    expect(inDialog().queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(button("Send recording"));
    await advance(0);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "Book Wednesday");
    expect(dialog()).not.toBeInTheDocument();
  });

  it("send() returning false again keeps the overlay open", async () => {
    const transcriber = mock({ transcript: "Book Wednesday" });
    const { onTranscript } = renderVoice(transcriber, { onTranscript: () => false });
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(0);
    fireEvent.click(button("Send recording"));
    await advance(0);

    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("voice-transcript")).toHaveTextContent("Book Wednesday");
  });

  it("Cancel while a failing stop() is pending: the failure doesn't reopen the overlay", async () => {
    const transcriber = mock({ error: "stop", delayMs: 1_000 });
    renderVoice(transcriber);
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(0);
    fireEvent.click(button("Cancel"));
    await advance(1_000);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("Cancel while a denied start() is pending: no notice", async () => {
    renderVoice(mock({ denied: true, startDelayMs: 500 }));
    fireEvent.click(mic());
    fireEvent.click(button("Cancel"));
    await advance(500);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("after Type instead, a later Cancel puts focus back on the mic, not the message box", async () => {
    const transcriber = mock({ transcript: "" });
    renderVoice(transcriber);
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    await advance(0);
    fireEvent.click(button("Type instead"));
    await advance(0);
    expect(messageBox()).toHaveFocus();

    await startRecording(transcriber);
    fireEvent.click(button("Cancel"));
    await advance(0);
    expect(mic()).toHaveFocus();
  });

  it("uses the latest onTranscript when the transcript arrives", async () => {
    const transcriber = mock({ delayMs: 1_000, transcript: "Book Wednesday" });
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    function Harness({ onTranscript }: { onTranscript: (text: string) => boolean }) {
      const inputRef = useRef<HTMLTextAreaElement>(null);
      return (
        <TranscriberContext.Provider value={transcriber}>
          <VoiceInput onTranscript={onTranscript} responding={false} inputRef={inputRef} />
        </TranscriberContext.Provider>
      );
    }
    const { rerender } = render(<Harness onTranscript={first} />);
    await startRecording(transcriber);
    fireEvent.click(button("Send recording"));
    rerender(<Harness onTranscript={second} />);
    await advance(1_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("Book Wednesday");
  });
});

/** A Transcriber whose session ignores cancel(), to check that the overlay drops stale callbacks. */
function stubbornTranscriber() {
  const calls: TranscriberCallbacks[] = [];
  const transcriber: Transcriber = {
    start: (callbacks = {}) => {
      calls.push(callbacks);
      return Promise.resolve({ stop: () => new Promise<string>(() => undefined), cancel: () => undefined });
    },
  };
  return { transcriber, calls };
}

describe("callbacks from an earlier recording", () => {
  it("an error reported after Cancel doesn't reopen the overlay", async () => {
    const { transcriber, calls } = stubbornTranscriber();
    renderVoice(transcriber);
    fireEvent.click(mic());
    await advance(0);
    fireEvent.click(button("Cancel"));
    act(() => calls[0]?.onError?.(new TranscriberError("failed")));
    expect(dialog()).not.toBeInTheDocument();
  });

  it("a level reported by the previous recording is ignored", async () => {
    const { transcriber, calls } = stubbornTranscriber();
    renderVoice(transcriber);
    fireEvent.click(mic());
    await advance(0);
    fireEvent.keyDown(button("Send recording"), { key: "Escape" });
    fireEvent.click(mic());
    await advance(0);
    act(() => calls[0]?.onLevel?.(0.9));
    expect(screen.getByTestId("voice-level").style.getPropertyValue("--level")).toBe("0");
    act(() => calls[1]?.onLevel?.(0.4));
    expect(screen.getByTestId("voice-level").style.getPropertyValue("--level")).toBe("0.4");
  });
});
