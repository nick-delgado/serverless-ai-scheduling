import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer, COUNTER_FROM } from "./Composer";

function setup(onSend: (text: string) => boolean = () => true) {
  const user = userEvent.setup();
  render(<Composer onSend={onSend} responding={false} accessory={<button type="button">Mic</button>} />);
  return { user, input: screen.getByRole("textbox", { name: "Message" }) };
}

describe("Composer", () => {
  it("passes the text as typed and clears when the send is taken", async () => {
    const onSend = vi.fn(() => true);
    const { user, input } = setup(onSend);
    await user.type(input, " Hi there {Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith(" Hi there ");
    expect(input).toHaveValue("");
  });

  it("doesn't call onSend for blank text, or while responding", async () => {
    const onSend = vi.fn(() => true);
    const user = userEvent.setup();
    const { rerender } = render(<Composer onSend={onSend} responding={false} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "   {Enter}");
    rerender(<Composer onSend={onSend} responding />);
    await user.type(input, "Hi{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the text when the send is refused", async () => {
    const { user, input } = setup(() => false);
    await user.type(input, "Hi{Enter}");
    expect(input).toHaveValue("Hi");
  });

  it("renders the accessory beside Send", () => {
    setup();
    expect(screen.getByRole("button", { name: "Mic" })).toBeVisible();
  });

  it("has no description below the counter threshold", async () => {
    const { user, input } = setup();
    await user.click(input);
    await user.paste("a".repeat(COUNTER_FROM - 1));
    expect(input).not.toHaveAttribute("aria-describedby");
  });
});
