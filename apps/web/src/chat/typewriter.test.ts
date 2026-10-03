import { visibleText } from "@sched/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLIES } from "../mocks/fixtures";
import {
  DEFAULT_BASE_CPS,
  DEFAULT_CATCH_UP_SECONDS,
  DEFAULT_TICK_MS,
  Typewriter,
  type TypewriterOptions,
} from "./typewriter";

/** 50 characters/s with a 20 ms tick: exactly one character per tick at the base pace. */
const ONE_PER_TICK = { baseCps: 50, tickMs: 20, catchUpSeconds: 10 };

function make(options: Partial<TypewriterOptions> = {}) {
  const updates: string[] = [];
  const onComplete = vi.fn<(text: string) => void>();
  const typewriter = new Typewriter({
    ...ONE_PER_TICK,
    onUpdate: (text) => updates.push(text),
    onComplete,
    ...options,
  });
  return { typewriter, updates, onComplete };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Typewriter", () => {
  it("reveals nothing at once: the first character waits for the first tick", () => {
    const { typewriter } = make();
    typewriter.append("Hello there");
    expect(typewriter.text).toBe("");
    vi.advanceTimersByTime(19);
    expect(typewriter.text).toBe("");
    vi.advanceTimersByTime(1);
    expect(typewriter.text).toBe("H");
  });

  it("keeps one pace when more text arrives mid-run", () => {
    const { typewriter } = make();
    typewriter.append("a".repeat(10));
    vi.advanceTimersByTime(50); // 2 ticks, a third due at 60 ms
    typewriter.append("b".repeat(10));
    vi.advanceTimersByTime(50);
    expect(typewriter.text).toHaveLength(5);
  });

  it("types at a constant base pace while the backlog is small", () => {
    const { typewriter } = make();
    typewriter.append("a".repeat(30));
    vi.advanceTimersByTime(199);
    expect(typewriter.text).toHaveLength(9);
    vi.advanceTimersByTime(1);
    expect(typewriter.text).toHaveLength(10);
    vi.advanceTimersByTime(200);
    expect(typewriter.text).toHaveLength(20);
  });

  it("speeds up on a burst so the backlog drains within the catch-up window, then slows to the base pace", () => {
    const { typewriter, onComplete } = make({ catchUpSeconds: 1 });
    typewriter.append("a".repeat(1000));
    typewriter.finish();
    vi.advanceTimersByTime(20);
    // Rate = backlog / catch-up = 1000 characters/s, so 20 in the first tick instead of 1.
    expect(typewriter.text).toHaveLength(20);
    // At the base pace this takes 20 s. With catch-up: ~3 s to get under 50 characters, then 1 s.
    vi.advanceTimersByTime(4_500);
    expect(onComplete).toHaveBeenCalledWith("a".repeat(1000));
  });

  it("drops to the base pace once the backlog is under one catch-up window", () => {
    const { typewriter } = make({ catchUpSeconds: 1 });
    typewriter.append("a".repeat(49));
    vi.advanceTimersByTime(20);
    expect(typewriter.text).toHaveLength(1);
  });

  it("measures elapsed time, so a late tick (a throttled tab) reveals what it owes", () => {
    let now = 0;
    const { typewriter } = make({ now: () => now });
    typewriter.append("a".repeat(100));
    now = 1_000; // the tick fires a second late
    vi.advanceTimersByTime(20);
    expect(typewriter.text).toHaveLength(50);
  });

  it("doesn't spend a late tick's unused budget on the next text", () => {
    let now = 0;
    const { typewriter } = make({ now: () => now });
    typewriter.append("a".repeat(10));
    now = 1_000; // budget for 50 characters, only 10 to reveal
    vi.advanceTimersByTime(20);
    expect(typewriter.text).toHaveLength(10);
    typewriter.append("b".repeat(30));
    now += 20;
    vi.advanceTimersByTime(20);
    expect(typewriter.text).toHaveLength(11);
  });

  it("doesn't stall after the clock steps backwards", () => {
    let now = 1_000;
    const { typewriter } = make({ now: () => now });
    typewriter.append("a".repeat(10));
    now = 0;
    vi.advanceTimersByTime(20);
    expect(typewriter.text).toHaveLength(0);
    now = 20;
    vi.advanceTimersByTime(20);
    expect(typewriter.text).toHaveLength(1);
  });

  it("calls onUpdate only when the revealed text changes", () => {
    const { typewriter, updates } = make({ baseCps: 20 }); // 0.4 characters per tick
    typewriter.append("abc");
    vi.advanceTimersByTime(200);
    expect(updates).toEqual(["a", "ab", "abc"]);
  });

  it("with the defaults, types a 600-character burst in a few seconds, not at once", () => {
    expect([DEFAULT_BASE_CPS, DEFAULT_CATCH_UP_SECONDS, DEFAULT_TICK_MS]).toEqual([60, 0.75, 16]);
    const onComplete = vi.fn<(text: string) => void>();
    const typewriter = new Typewriter({ onUpdate: () => undefined, onComplete });
    typewriter.append("a".repeat(600));
    typewriter.finish();
    vi.advanceTimersByTime(DEFAULT_TICK_MS);
    // First tick: 600 / 0.75 = 800 characters/s for 16 ms.
    expect(typewriter.text).toHaveLength(12);
    vi.advanceTimersByTime(1_000);
    expect(onComplete).not.toHaveBeenCalled();
    // ~1.9 s to get under 45 characters (one catch-up window at 60/s), then ~0.75 s at 60/s.
    vi.advanceTimersByTime(2_500);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("doesn't turn idle time between deltas into a burst", () => {
    const { typewriter } = make();
    typewriter.append("abc");
    vi.advanceTimersByTime(60);
    expect(typewriter.text).toBe("abc");
    vi.advanceTimersByTime(5_000); // nothing arrives for 5 s
    typewriter.append("defghij");
    vi.advanceTimersByTime(20);
    expect(typewriter.text).toBe("abcd");
  });

  it("completes once, after finish() and only when everything received is revealed", () => {
    const { typewriter, onComplete } = make();
    typewriter.append("abcde");
    typewriter.finish();
    vi.advanceTimersByTime(80);
    expect(typewriter.text).toBe("abcd");
    expect(onComplete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("abcde");
    expect(vi.getTimerCount()).toBe(0);
    typewriter.finish();
    vi.advanceTimersByTime(1_000);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("doesn't complete without finish(), even when caught up", () => {
    const { typewriter, onComplete } = make();
    typewriter.append("ab");
    vi.advanceTimersByTime(1_000);
    expect(typewriter.text).toBe("ab");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("completes at once when finish() comes after everything is revealed", () => {
    const { typewriter, onComplete } = make();
    typewriter.append("ab");
    vi.advanceTimersByTime(40);
    typewriter.finish();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("ab");
  });

  it("ignores text appended after finish()", () => {
    const { typewriter, onComplete } = make();
    typewriter.append("ab");
    typewriter.finish();
    typewriter.append("cd");
    vi.runAllTimers();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("ab");
  });

  describe("reset (text_reset)", () => {
    it("cuts revealed text back to keepChars and carries on with what follows", () => {
      const { typewriter, updates, onComplete } = make();
      typewriter.append("Let me see. I can't");
      vi.advanceTimersByTime(15 * 20);
      expect(typewriter.text).toBe("Let me see. I c");
      typewriter.reset(12);
      expect(typewriter.text).toBe("Let me see. ");
      expect(updates.at(-1)).toBe("Let me see. ");
      typewriter.append("Dr. Lee");
      typewriter.finish();
      vi.runAllTimers();
      expect(onComplete).toHaveBeenCalledExactlyOnceWith("Let me see. Dr. Lee");
    });

    it("drops queued text beyond keepChars that was never revealed", () => {
      const { typewriter, updates } = make();
      typewriter.append("Let me see. I can't");
      vi.advanceTimersByTime(5 * 20);
      expect(typewriter.text).toBe("Let m");
      typewriter.reset(12);
      expect(typewriter.text).toBe("Let m");
      typewriter.finish();
      vi.runAllTimers();
      expect(typewriter.text).toBe("Let me see. ");
      expect(updates.some((text) => text.includes("I"))).toBe(false);
    });

    it("completes when a reset after finish-pending text leaves nothing to type", () => {
      const { typewriter, onComplete } = make();
      typewriter.append("abcdef");
      vi.advanceTimersByTime(60);
      typewriter.reset(2);
      typewriter.finish();
      expect(onComplete).toHaveBeenCalledExactlyOnceWith("ab");
    });

    it("ends with exactly visibleText() for the mock's reset reply", () => {
      const { typewriter, onComplete } = make({ baseCps: 60, tickMs: 16, catchUpSeconds: 0.75 });
      const { events, text } = REPLIES.reset;
      for (const event of events) {
        if (event.type === "text_delta") typewriter.append(event.text);
        else if (event.type === "text_reset") typewriter.reset(event.keepChars);
        vi.advanceTimersByTime(40);
      }
      typewriter.finish();
      vi.runAllTimers();
      expect(onComplete).toHaveBeenCalledExactlyOnceWith(visibleText(events));
      expect(visibleText(events)).toBe(text);
    });
  });

  describe("instant (prefers-reduced-motion)", () => {
    it("reveals each append immediately and completes on finish()", () => {
      const { typewriter, updates, onComplete } = make({ instant: true });
      typewriter.append("Hello ");
      expect(typewriter.text).toBe("Hello ");
      typewriter.append("there.");
      expect(updates).toEqual(["Hello ", "Hello there."]);
      typewriter.finish();
      expect(onComplete).toHaveBeenCalledExactlyOnceWith("Hello there.");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("stops typing and calls nothing after dispose()", () => {
    const { typewriter, updates, onComplete } = make();
    typewriter.append("abcdef");
    vi.advanceTimersByTime(40);
    typewriter.dispose();
    const count = updates.length;
    vi.runAllTimers();
    typewriter.append("more");
    typewriter.reset(0);
    typewriter.finish();
    vi.runAllTimers();
    expect(updates).toHaveLength(count);
    expect(onComplete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["typed", {}],
    ["instant", { instant: true }],
  ])("doesn't complete on finish() after dispose(), even with everything revealed (%s)", (_, options) => {
    const { typewriter, onComplete } = make(options);
    typewriter.append("ab");
    vi.advanceTimersByTime(40);
    expect(typewriter.text).toBe("ab");
    typewriter.dispose();
    typewriter.finish();
    vi.runAllTimers();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
