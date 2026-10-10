/**
 * The timing panel for #29's AC4 and AC6 runs, in `VITE_VOICE_TIMING=1` builds only (r2/Q-2 (a)),
 * pinned to the top of the page above the recording overlay: the clip's script to read (while "Show
 * script" is on), and a collapsible box where the tester labels the next run (browser, clip,
 * deliberate check), sees each browser's numbers so far, exports the record as JSON, and runs the
 * role check.
 * It's a test tool, not patient UI: other builds don't contain it (`build.test.ts`).
 */
import "./timing.css";

import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { getAwsCredentials, identityPoolRegion, resolveIdentityPoolId } from "../../auth";
import { describeError } from "./mic";
import { SCRIPTS } from "./scripts";
import {
  BROWSERS,
  type Browser,
  CLIP_MIX,
  type Clip,
  CLIPS,
  exportTiming,
  summarize,
  type TimingStore,
  timingStore,
} from "./timing";

const ms = (value: number | undefined) => (value === undefined ? "–" : `${String(Math.round(value))} ms`);

export interface TimingPanelProps {
  store?: TimingStore;
  /** The role check; the default lazy-loads `roleCheck.ts` and uses the patient's credentials. */
  roleCheck?: () => Promise<void>;
}

async function defaultRoleCheck(store: TimingStore): Promise<void> {
  const identityPoolId = resolveIdentityPoolId(import.meta.env);
  const credentials = await getAwsCredentials();
  if (!identityPoolId || !credentials)
    throw new Error("No Identity Pool credentials: sign in on a deployed build");
  const { checkRoleScope } = await import("./roleCheck");
  store.addRoleCheck(await checkRoleScope(identityPoolRegion(identityPoolId), credentials, new Date()));
}

export default function TimingPanel({ store = timingStore, roleCheck }: TimingPanelProps) {
  const data = useSyncExternalStore(store.subscribe, store.snapshot);
  const [showScript, setShowScript] = useState(true);
  const [status, setStatus] = useState("");
  const { labels, runs, roleChecks } = data;
  const exportText = () => exportTiming(store.snapshot(), navigator.userAgent, new Date());

  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([exportText()], { type: "application/json" }));
    link.download = `voice-timing-${labels.browser}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const copy = () => {
    navigator.clipboard.writeText(exportText()).then(
      () => setStatus("Copied the record."),
      () => setStatus("Copy failed: use Download."),
    );
  };

  const checkRole = () => {
    setStatus("Checking the role…");
    (roleCheck ?? (() => defaultRoleCheck(store)))().then(
      () => setStatus("Role check recorded."),
      (error: unknown) => setStatus(`Role check failed: ${describeError(error)}`),
    );
  };

  const clear = () => {
    if (window.confirm("Delete every recorded run and role check in this browser?")) store.clear();
  };

  const summary = summarize(runs);
  // The runs that count, by `summarize`'s rule, for the browser being measured.
  const counted = summary.find((row) => row.browser === labels.browser)?.byClip;
  const done = (clip: Clip) => counted?.[clip] ?? 0;

  return createPortal(
    <div className="voice-timing">
      {showScript && (
        <p className="voice-timing__script">
          <strong>{labels.clip}:</strong> {SCRIPTS[labels.clip]}
        </p>
      )}
      <details className="voice-timing__panel">
        <summary>
          Voice timing: {labels.browser}, {labels.clip}
          {labels.deliberate ? ", deliberate" : ""} ({runs.length} runs)
        </summary>
        <div className="voice-timing__row">
          <label>
            Browser{" "}
            <select
              value={labels.browser}
              onChange={(e) => store.setLabels({ browser: e.target.value as Browser })}
            >
              {BROWSERS.map((browser) => (
                <option key={browser}>{browser}</option>
              ))}
            </select>
          </label>
          <label>
            Clip{" "}
            <select value={labels.clip} onChange={(e) => store.setLabels({ clip: e.target.value as Clip })}>
              {CLIPS.map((clip) => (
                <option key={clip} value={clip}>
                  {clip} ({done(clip)}/{CLIP_MIX[clip]})
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={labels.deliberate}
              onChange={(e) => store.setLabels({ deliberate: e.target.checked })}
            />{" "}
            Deliberate check (doesn&apos;t count)
          </label>
          <label>
            <input type="checkbox" checked={showScript} onChange={(e) => setShowScript(e.target.checked)} />{" "}
            Show script
          </label>
        </div>
        <table className="voice-timing__table">
          <caption>Runs that count, per browser</caption>
          <thead>
            <tr>
              <th>Browser</th>
              <th>Runs (5/20/60 s)</th>
              <th>Failed</th>
              <th>stop→final p95</th>
              <th>Send→end p95</th>
              <th>Final before Send</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((row) => (
              <tr key={row.browser}>
                <td>{row.browser}</td>
                <td>
                  {row.runs} ({row.byClip["5s"]}/{row.byClip["20s"]}/{row.byClip["60s"]})
                </td>
                <td>{row.failed}</td>
                <td>{ms(row.stopToFinalP95)}</td>
                <td>{ms(row.sendToEndP95)}</td>
                <td>{row.finalBeforeSend}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ol className="voice-timing__runs" reversed>
          {runs
            .slice(-5)
            .reverse()
            .map((run) => (
              <li key={run.at}>
                {run.browser} {run.clip}
                {run.deliberate ? " (deliberate)" : ""}: {run.outcome}
                {run.failure ? ` (${run.failure})` : ""}, stop→final {ms(run.stopToFinalMs)}, Send→end{" "}
                {ms(run.sendToEndMs)}
              </li>
            ))}
        </ol>
        {roleChecks.map((check) => (
          <p key={check.at}>
            Role check: {check.action} {check.denied ? "denied" : "NOT denied"} ({check.result})
          </p>
        ))}
        <div className="voice-timing__row">
          <button type="button" onClick={download}>
            Download JSON
          </button>
          <button type="button" onClick={copy}>
            Copy JSON
          </button>
          <button type="button" onClick={() => store.removeLastRun()} disabled={runs.length === 0}>
            Delete last run
          </button>
          <button type="button" onClick={checkRole}>
            Role check
          </button>
          <button type="button" onClick={clear}>
            Clear all
          </button>
        </div>
        <p role="status">{status}</p>
      </details>
    </div>,
    document.body,
  );
}
