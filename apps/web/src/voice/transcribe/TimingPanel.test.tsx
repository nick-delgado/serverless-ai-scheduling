/** The timing panel (#29 AC4, AC6; timing builds only): labels, script, summary, export, role check. */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAwsCredentials, resolveIdentityPoolId } from "../../auth";
import { FAKE_AWS_CREDENTIALS } from "../../auth/testing";
import { checkRoleScope } from "./roleCheck";
import { SCRIPTS } from "./scripts";
import TimingPanel from "./TimingPanel";
import { TimingStore, type TimingRun } from "./timing";

vi.mock("../../auth", () => ({
  getAwsCredentials: vi.fn(() => Promise.resolve(undefined)),
  resolveIdentityPoolId: vi.fn(() => undefined),
}));
vi.mock("./roleCheck", () => ({
  checkRoleScope: vi.fn((_region: string, _credentials: unknown, at: Date) =>
    Promise.resolve({
      at: at.toISOString(),
      action: "transcribe:ListTranscriptionJobs",
      denied: true,
      result: "AccessDeniedException",
    }),
  ),
}));

let store: TimingStore;

const RUN: TimingRun = {
  browser: "chrome-desktop",
  clip: "5s",
  deliberate: false,
  at: "2026-10-09T12:00:00.000Z",
  outcome: "ok",
  finals: 1,
  finalsBeforeSend: 0,
  stopToFinalMs: 180.4,
  sendToEndMs: 260,
};

beforeEach(() => {
  store = new TimingStore(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(resolveIdentityPoolId).mockReturnValue(undefined);
  vi.mocked(getAwsCredentials).mockResolvedValue(undefined);
});

const open = async () => userEvent.click(screen.getByText(/^Voice timing:/));

describe("TimingPanel", () => {
  it("shows the clip's script and the current labels, and changes them", async () => {
    render(<TimingPanel store={store} />);
    expect(screen.getByText(SCRIPTS["5s"])).toBeInTheDocument();
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/Browser/), "ios-safari");
    await userEvent.selectOptions(screen.getByLabelText(/Clip/), "60s");
    await userEvent.click(screen.getByLabelText(/Deliberate check/));
    expect(store.snapshot().labels).toEqual({ browser: "ios-safari", clip: "60s", deliberate: true });
    expect(screen.getByText(SCRIPTS["60s"])).toBeInTheDocument();
    expect(screen.getByText(/^Voice timing: ios-safari, 60s, deliberate/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Show script/));
    expect(screen.queryByText(SCRIPTS["60s"])).not.toBeInTheDocument();
  });

  it("counts each clip toward its mix, and shows the summary and the latest runs", async () => {
    store.addRun(RUN);
    store.addRun({
      ...RUN,
      at: "2",
      outcome: "failed",
      failure: "timeout",
      stopToFinalMs: undefined,
      sendToEndMs: undefined,
    });
    store.addRun({ ...RUN, at: "3", deliberate: true });
    render(<TimingPanel store={store} />);
    await open();
    expect(screen.getByRole("option", { name: "5s (2/7)" })).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /chrome-desktop/ });
    expect(row).toHaveTextContent("2 (2/0/0)");
    expect(row).toHaveTextContent("180 ms");
    expect(row).toHaveTextContent("260 ms");
    expect(screen.getByText(/failed \(timeout\), stop→final –/)).toBeInTheDocument();
    expect(screen.getByText(/\(deliberate\): ok/)).toBeInTheDocument();
  });

  it("deletes the last run, and clears everything after a confirm", async () => {
    store.addRun(RUN);
    store.addRun({ ...RUN, at: "2" });
    render(<TimingPanel store={store} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Delete last run" }));
    expect(store.snapshot().runs).toHaveLength(1);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(store.snapshot().runs).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(store.snapshot().runs).toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Delete last run" })).toBeDisabled();
  });

  it("downloads the record as a JSON file named for the browser", async () => {
    store.addRun(RUN);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:timing");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toMatch(/^voice-timing-chrome-desktop-.+\.json$/);
    });
    render(<TimingPanel store={store} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(click).toHaveBeenCalledTimes(1);
    const text = await createObjectURL.mock.calls[0]?.[0].text();
    expect(JSON.parse(text ?? "{}")).toMatchObject({ kind: "sched-voice-timing", runs: [RUN] });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:timing");
  });

  it("copies the record, or says to download when copying fails", async () => {
    store.addRun(RUN);
    const user = userEvent.setup();
    render(<TimingPanel store={store} />);
    await user.click(screen.getByText(/^Voice timing:/));
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(await screen.findByText("Copied the record.")).toBeInTheDocument();
    expect(JSON.parse(writeText.mock.calls[0]?.[0] ?? "{}")).toMatchObject({ runs: [RUN] });
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(await screen.findByText("Copy failed: use Download.")).toBeInTheDocument();
  });

  it("runs the role check and shows each result", async () => {
    const roleCheck = vi.fn(() => {
      store.addRoleCheck({
        at: "1",
        action: "transcribe:ListTranscriptionJobs",
        denied: true,
        result: "AccessDeniedException",
      });
      return Promise.resolve();
    });
    render(<TimingPanel store={store} roleCheck={roleCheck} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Role check" }));
    expect(await screen.findByText("Role check recorded.")).toBeInTheDocument();
    expect(
      screen.getByText(/transcribe:ListTranscriptionJobs denied \(AccessDeniedException\)/),
    ).toBeInTheDocument();
  });

  it("says why the role check can't run without Identity Pool credentials (the default check)", async () => {
    render(<TimingPanel store={store} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Role check" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/Role check failed: No Identity Pool credentials/),
    );
    expect(store.snapshot().roleChecks).toEqual([]);
  });

  it("by default checks with the patient's Identity Pool credentials, in the pool's region", async () => {
    vi.mocked(resolveIdentityPoolId).mockReturnValue("us-east-1:00000000-0000-4000-8000-000000000029");
    vi.mocked(getAwsCredentials).mockResolvedValue(FAKE_AWS_CREDENTIALS);
    render(<TimingPanel store={store} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Role check" }));
    expect(await screen.findByText("Role check recorded.")).toBeInTheDocument();
    expect(checkRoleScope).toHaveBeenCalledWith("us-east-1", FAKE_AWS_CREDENTIALS, expect.any(Date));
    expect(store.snapshot().roleChecks).toMatchObject([{ denied: true }]);
  });
});
