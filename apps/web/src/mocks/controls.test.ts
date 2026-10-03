import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApiControls, MOCK_API_STORAGE_KEY, readMockApiOptions } from "./controls";
import { DEFAULT_MOCK_API_OPTIONS } from "./options";

afterEach(() => {
  localStorage.clear();
});

describe("schedMock controls", () => {
  it("merges set() changes over the stored options and persists them", () => {
    const controls = createMockApiControls(() => undefined);
    controls.set({ chatFault: "mid_stream" });
    const options = controls.set({ firstEventMs: 3000 });

    const expected = { ...DEFAULT_MOCK_API_OPTIONS, chatFault: "mid_stream", firstEventMs: 3000 };
    expect(options).toEqual(expected);
    expect(controls.options()).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(MOCK_API_STORAGE_KEY) ?? "null")).toEqual(expected);
  });

  it("reset() clears the stored options and the mock's conversations", () => {
    const resetApi = vi.fn();
    const controls = createMockApiControls(resetApi);
    controls.set({ session: "restore" });

    expect(controls.reset()).toEqual(DEFAULT_MOCK_API_OPTIONS);
    expect(localStorage.getItem(MOCK_API_STORAGE_KEY)).toBeNull();
    expect(controls.options()).toEqual(DEFAULT_MOCK_API_OPTIONS);
    expect(resetApi).toHaveBeenCalledOnce();
  });

  it("falls back to the defaults for a corrupt stored value", () => {
    localStorage.setItem(MOCK_API_STORAGE_KEY, "{not json");
    expect(readMockApiOptions()).toEqual(DEFAULT_MOCK_API_OPTIONS);
  });
});
