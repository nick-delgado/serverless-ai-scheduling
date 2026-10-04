/**
 * Voice through the chat page (#28): the mic is the composer's accessory, a transcript goes through
 * `useChat().send` like typed text (FR-023), and the mic is disabled while the agent responds (FR-020,
 * FR-011). Real timers: the MockTranscriber has no delays here, and `until` waits on real I/O hops.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { server } from "../mocks/node";
import { MockTranscriber } from "../voice/MockTranscriber";
import { TranscriberContext } from "../voice/TranscriberContext";
import { MIC_LABEL, NOTICES } from "../voice/VoiceInput";
import { ChatPage } from "./ChatPage";
import { captureChatBodies, doneEvent, gate, instant, log, serveEvents, until } from "./testUtils";

afterEach(() => {
  server.events.removeAllListeners();
  localStorage.clear();
});

async function renderPage(transcriber: MockTranscriber) {
  render(
    <TranscriberContext.Provider value={transcriber}>
      <ChatPage reducedMotion={instant} />
    </TranscriberContext.Provider>,
  );
  await until(() => screen.queryByText(SESSIONS.upcoming.greeting, { selector: "li" }) !== null);
}

const mic = () => screen.getByRole("button", { name: MIC_LABEL });
const messageBox = () => screen.getByRole("textbox", { name: "Message" });

async function speak() {
  fireEvent.click(mic());
  await until(() => screen.queryByRole("button", { name: "Send recording" }) !== null);
  fireEvent.click(screen.getByRole("button", { name: "Send recording" }));
}

describe("ChatPage: voice", () => {
  it("shows the mic in the composer, beside Send", async () => {
    await renderPage(new MockTranscriber());
    const form = messageBox().closest("form") as HTMLElement;
    expect(within(form).getByRole("button", { name: MIC_LABEL })).toBeEnabled();
  });

  it("posts the transcript as the patient's message and sends it like typed text, leaving a draft alone", async () => {
    const bodies = captureChatBodies();
    await renderPage(new MockTranscriber({ transcript: "Book Wednesday" }));
    fireEvent.change(messageBox(), { target: { value: "half-typed draft" } });

    await speak();
    await until(() => within(log()).queryByText("Book Wednesday") !== null);
    expect(within(log()).getByText("Book Wednesday").closest("li")).toHaveClass("bubble--patient");
    await until(() => bodies.length === 1);
    expect(bodies[0]?.text).toBe("Book Wednesday");
    expect(messageBox()).toHaveValue("half-typed draft");
    await until(() => within(log()).queryByText(REPLIES.tools.text) !== null);
  });

  it("disables the mic while the agent responds, and enables it again after the reply", async () => {
    const held = gate();
    serveEvents([{ type: "text_delta", text: "Sure." }, doneEvent()], { 1: held.promise });
    await renderPage(new MockTranscriber());
    expect(mic()).toBeEnabled();

    fireEvent.change(messageBox(), { target: { value: "Hi" } });
    fireEvent.keyDown(messageBox(), { key: "Enter" });
    expect(mic()).toBeDisabled();

    held.open();
    await until(() => within(log()).queryByText("Sure.") !== null && !mic().hasAttribute("disabled"));
    expect(mic()).toBeEnabled();
  });

  it("denied: the guidance beside the composer, and Type instead focuses the message box", async () => {
    await renderPage(new MockTranscriber({ denied: true }));
    fireEvent.click(mic());
    await until(() => screen.queryByText(NOTICES.denied) !== null);
    fireEvent.click(screen.getByRole("button", { name: "Type instead" }));
    expect(messageBox()).toHaveFocus();
  });
});
