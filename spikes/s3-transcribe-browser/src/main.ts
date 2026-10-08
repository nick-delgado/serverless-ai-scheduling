/**
 * The S-3 measurement page (#10): sign in, run scripted utterances, record the r1/Q-5 checklist, and
 * export redacted results for `results/`. Runs persist in this browser's local storage, keyed by the
 * selected browser label, so a reload (a Q-5 check) loses nothing.
 */
import {
  checkRoleScope,
  configured,
  credentials,
  REGION,
  type RoleScopeCheck,
  signInDemo,
  signOut,
} from "./auth";
import {
  type CaptureSession,
  CHUNK_SAMPLES,
  describe,
  type RunOutcome,
  STABILITY,
  start,
  TARGET_RATE,
  type EndMode,
} from "./capture";
import { redact } from "./redact";
import { BEST_EFFORT_TOTAL, type Length, LENGTHS, MAIN_TARGET, SCRIPTS, VARIANT_TARGET } from "./scripts";

const AUTO_SEND_MS = 60_000; // FR-021
type Variant = "main" | "stabilized";
type Check = "none" | "lock-screen" | "tab-switch" | "reload";
const MEASURED = ["ios-safari", "android-chrome", "chrome-desktop", "safari-macos"];
const VARIANT_BROWSERS = ["chrome-desktop", "ios-safari"];

interface RunRecord extends RunOutcome {
  id: string;
  at: string;
  browser: string;
  length: Length;
  variant: Variant;
  check: Check;
  endMode: EndMode;
  /** Word error rate against the script (informational; never a failure, r1/Q-6). */
  wer?: number;
}

interface Probe16k {
  at: string;
  constructed: boolean;
  reportedRate?: number;
  honoured?: boolean;
  micConnect?: string;
  error?: string;
}

interface EnvInfo {
  at: string;
  isSecureContext: boolean;
  mediaDevices: boolean;
  audioWorklet: boolean;
  /** An AudioContext created at page load, before any tap. */
  loadContextState?: string;
  loadContextRate?: number;
  micPermissionAtLoad?: string;
}

interface Checklist {
  permissionPromptFirstUse: string;
  permissionPromptOnReload: string;
  micIndicatorOffAfterStop: string;
  lockScreen: string;
  tabSwitch: string;
  notes: string;
}

interface Store {
  runs: RunRecord[];
  checklist: Checklist;
  envLoads: EnvInfo[];
  roleScope?: RoleScopeCheck;
  probe16k?: Probe16k;
  pending?: { id: string; at: string; length: Length; variant: Variant; check: Check };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const browserSelect = $<HTMLSelectElement>("browser");
const lengthSelect = $<HTMLSelectElement>("length");
const variantSelect = $<HTMLSelectElement>("variant");
const checkSelect = $<HTMLSelectElement>("check");
const endMode: EndMode =
  new URLSearchParams(location.search).get("end") === "iterable" ? "end-iterable" : "empty-event";

// ---- storage (best effort: a private window may refuse it) ---------------------------------------

function emptyStore(): Store {
  return {
    runs: [],
    envLoads: [],
    checklist: {
      permissionPromptFirstUse: "",
      permissionPromptOnReload: "",
      micIndicatorOffAfterStop: "",
      lockScreen: "",
      tabSwitch: "",
      notes: "",
    },
  };
}
const key = () => `s3:${browserSelect.value}`;
function load(): Store {
  try {
    const raw = localStorage.getItem(key());
    return raw ? { ...emptyStore(), ...(JSON.parse(raw) as Store) } : emptyStore();
  } catch {
    return emptyStore();
  }
}
function save(store: Store): void {
  try {
    localStorage.setItem(key(), JSON.stringify(store));
  } catch {
    $("export-status").textContent = "Local storage unavailable: export before leaving the page.";
  }
}
let store: Store;

function guessBrowser(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Android/.test(ua)) return "android-chrome";
  if (/iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios-safari";
  if (/Chrome\//.test(ua)) return "chrome-desktop";
  return "safari-macos";
}
try {
  browserSelect.value = localStorage.getItem("s3:browser") ?? guessBrowser();
} catch {
  browserSelect.value = guessBrowser();
}

// ---- environment ---------------------------------------------------------------------------------

async function environment(): Promise<EnvInfo> {
  const info: EnvInfo = {
    at: new Date().toISOString(),
    isSecureContext: window.isSecureContext,
    mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    audioWorklet: typeof AudioWorkletNode !== "undefined",
  };
  try {
    const ctx = new AudioContext();
    info.loadContextState = ctx.state;
    info.loadContextRate = ctx.sampleRate;
    await ctx.close();
  } catch (error) {
    info.loadContextState = `error: ${describe(error)}`;
  }
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    info.micPermissionAtLoad = status.state;
  } catch {
    info.micPermissionAtLoad = "query unsupported";
  }
  return info;
}

function renderEnv(info: EnvInfo): void {
  const flag = (ok: boolean, text: string) =>
    `<span class="${ok ? "ok" : "bad"}">${ok ? "✔" : "✘"} ${text}</span>`;
  $("env").innerHTML = [
    flag(info.isSecureContext, `isSecureContext: ${info.isSecureContext}`),
    flag(info.mediaDevices, "navigator.mediaDevices.getUserMedia"),
    flag(info.audioWorklet, "AudioWorkletNode"),
    flag(
      configured,
      configured ? "pool IDs configured (.env.local)" : "pool IDs missing: run npm run config",
    ),
    `<span class="muted">AudioContext at load: ${info.loadContextState ?? "?"} @ ${info.loadContextRate ?? "?"} Hz · mic permission at load: ${info.micPermissionAtLoad ?? "?"}</span>`,
  ].join("<br>");
}

// ---- auth ----------------------------------------------------------------------------------------

async function refreshAuthStatus(): Promise<void> {
  try {
    const creds = await credentials();
    $("auth-status").innerHTML = creds
      ? `<span class="ok">Identity Pool credentials ready</span> (expire ${creds.expiration?.toLocaleTimeString() ?? "?"})`
      : "Not signed in.";
  } catch (error) {
    $("auth-status").innerHTML = `<span class="bad">${describe(error)}</span>`;
  }
}

$("signin").onclick = async () => {
  const password = $<HTMLInputElement>("password");
  $("auth-status").textContent = "Signing in…";
  try {
    const step = await signInDemo($<HTMLInputElement>("username").value, password.value);
    $("auth-status").textContent = step;
  } catch (error) {
    $("auth-status").innerHTML = `<span class="bad">${describe(error)}</span>`;
  } finally {
    password.value = "";
  }
  await refreshAuthStatus();
};
$("signout").onclick = async () => {
  await signOut();
  await refreshAuthStatus();
};
$("scope").onclick = async () => {
  try {
    store.roleScope = await checkRoleScope();
    save(store);
    $("scope-result").textContent = JSON.stringify(store.roleScope, null, 2);
  } catch (error) {
    $("scope-result").textContent = describe(error);
  }
};

$("probe").onclick = async () => {
  const probe: Probe16k = { at: new Date().toISOString(), constructed: false };
  let media: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE });
    probe.constructed = true;
    probe.reportedRate = ctx.sampleRate;
    probe.honoured = ctx.sampleRate === TARGET_RATE;
    media = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      ctx.createMediaStreamSource(media).connect(ctx.destination);
      probe.micConnect = "ok";
    } catch (error) {
      probe.micConnect = describe(error);
    }
  } catch (error) {
    probe.error = describe(error);
  } finally {
    for (const track of media?.getTracks() ?? []) track.stop();
    await ctx?.close().catch(() => undefined);
  }
  store.probe16k = probe;
  save(store);
  $("scope-result").textContent = JSON.stringify(probe, null, 2);
  renderChecklist();
};

// ---- runs ----------------------------------------------------------------------------------------

let session: CaptureSession | undefined;
let timerHandle: ReturnType<typeof setInterval> | undefined;
let autoSendHandle: ReturnType<typeof setTimeout> | undefined;
let recordingSince = 0;

function setRunning(running: boolean): void {
  $<HTMLButtonElement>("start").disabled = running;
  $<HTMLButtonElement>("send").disabled = !running;
  $<HTMLButtonElement>("cancel").disabled = !running;
  for (const s of [browserSelect, lengthSelect, variantSelect, checkSelect]) s.disabled = running;
}

function clearTimers(): void {
  clearInterval(timerHandle);
  clearTimeout(autoSendHandle);
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate: word-level edit distance over the script's word count. */
function wordErrorRate(reference: string, hypothesis: string): number {
  const r = words(reference);
  const h = words(hypothesis);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= h.length; j += 1) {
      const sub = (prev[j - 1] ?? 0) + (r[i - 1] === h[j - 1] ? 0 : 1);
      cur.push(Math.min(sub, (prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1));
    }
    prev = cur;
  }
  return r.length ? (prev[h.length] ?? 0) / r.length : 0;
}

$("start").onclick = async () => {
  const length = lengthSelect.value as Length;
  const variant = variantSelect.value as Variant;
  const check = checkSelect.value as Check;
  $("partial").textContent = "";
  $("last").textContent = "";
  setRunning(true);
  try {
    // Credentials before the tap timestamp, outside every measured window (r1/Q-1, r1/A-1).
    $("run-status").textContent = "Fetching credentials…";
    const creds = await credentials();
    if (!creds) throw new Error("Not signed in.");
    const tapAt = performance.now();
    const id = `${browserSelect.value}-${Date.now()}`;
    store.pending = { id, at: new Date().toISOString(), length, variant, check };
    save(store);
    $("run-status").textContent = "Starting…";
    session = await start({
      region: REGION,
      credentials: creds,
      stabilization: variant === "stabilized",
      endMode,
      tapAt,
      onLevel: (level) => ($<HTMLMeterElement>("level").value = level),
      onPartial: (text) => ($("partial").textContent = text),
      onError: (failure) => {
        $("run-status").innerHTML =
          `<span class="bad">Stream failed while recording: ${failure.kind} ${failure.detail}</span> Press Send to record it.`;
      },
    });
    recordingSince = performance.now();
    $("run-status").textContent = "Recording: read the script, then press Send right after the last word.";
    timerHandle = setInterval(() => {
      const s = Math.floor((performance.now() - recordingSince) / 1000);
      $("timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 250);
    autoSendHandle = setTimeout(() => void finish("auto"), AUTO_SEND_MS);
  } catch (error) {
    clearTimers();
    session = undefined;
    delete store.pending;
    save(store);
    setRunning(false);
    $("run-status").innerHTML = `<span class="bad">Could not start: ${describe(error)}</span>`;
  }
};

async function finish(reason: "send" | "auto"): Promise<void> {
  const current = session;
  const pending = store.pending;
  if (!current || !pending) return;
  session = undefined;
  clearTimers();
  $<HTMLButtonElement>("send").disabled = true;
  $("run-status").textContent = "Transcribing…";
  const outcome = await current.stop(reason);
  const record: RunRecord = {
    ...outcome,
    id: pending.id,
    at: pending.at,
    browser: browserSelect.value,
    length: pending.length,
    variant: pending.variant,
    check: pending.check,
    endMode,
    ...(outcome.transcript
      ? { wer: Number(wordErrorRate(SCRIPTS[pending.length], outcome.transcript).toFixed(3)) }
      : {}),
  };
  store.runs.push(record);
  delete store.pending;
  save(store);
  setRunning(false);
  $("run-status").innerHTML = record.ok
    ? `<span class="ok">OK</span> stop→final ${Math.round(record.latencyMs ?? NaN)} ms${record.cold ? " (cold)" : ""}`
    : `<span class="bad">FAILED: ${record.failure?.kind}</span> ${record.failure?.detail ?? ""}`;
  $("last").textContent = JSON.stringify(
    {
      latencyMs: record.latencyMs,
      sendToEndMs: record.sendToEndMs,
      wer: record.wer,
      transcript: record.transcript,
      marks: record.marks,
      ws: record.ws,
      audio: record.audio,
    },
    null,
    2,
  );
  render();
}

$("send").onclick = () => void finish("send");
$("cancel").onclick = () => {
  session?.cancel();
  session = undefined;
  clearTimers();
  delete store.pending;
  save(store);
  setRunning(false);
  $("run-status").textContent = "Cancelled (not recorded).";
};

// ---- rendering -----------------------------------------------------------------------------------

function renderScript(): void {
  $("script").textContent = SCRIPTS[lengthSelect.value as Length];
}

function counted(r: RunRecord): boolean {
  return r.check === "none";
}

function renderProgress(): void {
  const browser = browserSelect.value;
  const runs = store.runs;
  if (!MEASURED.includes(browser)) {
    const done = runs.filter(counted).length;
    $("progress").innerHTML = `Best effort (r1/A-7): ${done} / ${BEST_EFFORT_TOTAL} utterances, any length.`;
    return;
  }
  const variants: Variant[] = VARIANT_BROWSERS.includes(browser) ? ["main", "stabilized"] : ["main"];
  const rows = LENGTHS.map((length) => {
    const cells = variants.map((variant) => {
      const set = runs.filter((r) => counted(r) && r.length === length && r.variant === variant);
      const target = variant === "main" ? MAIN_TARGET[length] : VARIANT_TARGET[length];
      const failed = set.filter((r) => !r.ok).length;
      const done = set.length >= target;
      return `<td class="${done ? "ok" : ""}">${set.length} / ${target}${failed ? ` <span class="bad">(${failed} failed)</span>` : ""}</td>`;
    });
    return `<tr><td>${length}</td>${cells.join("")}</tr>`;
  });
  const checks = runs.filter((r) => !counted(r)).length;
  $("progress").innerHTML =
    `<table><tr><th>Length</th>${variants.map((v) => `<th>${v}</th>`).join("")}</tr>${rows.join("")}</table>` +
    `<div class="muted">Deliberate-check runs (not counted): ${checks}. Failed main streams count toward r1/Q-2 (more than one fails the browser).</div>`;
}

const CHECK_FIELDS: [keyof Checklist, string, string[]][] = [
  ["permissionPromptFirstUse", "Permission prompt on first use", ["", "yes", "no"]],
  ["permissionPromptOnReload", "Prompt again after reload", ["", "repeats", "does not repeat", "not tried"]],
  [
    "micIndicatorOffAfterStop",
    "Mic indicator turns off after Send",
    ["", "yes", "no", "after a delay", "not tried"],
  ],
  [
    "lockScreen",
    "Lock screen mid-recording (phones)",
    [
      "",
      "not tried",
      "kept recording",
      "stream failed",
      "audio stopped, stream kept",
      "page reloaded",
      "other (notes)",
    ],
  ],
  [
    "tabSwitch",
    "Switch tab mid-recording (phones)",
    [
      "",
      "not tried",
      "kept recording",
      "stream failed",
      "audio stopped, stream kept",
      "page reloaded",
      "other (notes)",
    ],
  ],
];

function autoChecklist(): Record<string, unknown> {
  const rates = [...new Set(store.runs.map((r) => r.audio.contextRate))];
  const states = [...new Set(store.runs.map((r) => r.audio.contextStateAtCreate))];
  const main = store.runs.filter((r) => counted(r) && r.variant === "main");
  return {
    contextSampleRates: rates,
    contextStateWhenCreatedOnTap: states,
    contextStateAtLoad: [...new Set(store.envLoads.map((e) => e.loadContextState))],
    sixteenKHzHonoured: store.probe16k?.honoured ?? "not tried",
    sixteenKHzMicConnect: store.probe16k?.micConnect ?? store.probe16k?.error ?? "not tried",
    micPermissionAtLoads: store.envLoads.map((e) => e.micPermissionAtLoad),
    failedMainStreams: main.filter((r) => !r.ok).length,
  };
}

function renderChecklist(): void {
  const c = store.checklist;
  $("checklist").innerHTML =
    CHECK_FIELDS.map(
      ([field, label, options]) =>
        `<label>${label} <select data-field="${field}">${options
          .map((o) => `<option ${c[field] === o ? "selected" : ""}>${o}</option>`)
          .join("")}</select></label>`,
    ).join("") +
    `<label>Notes <input data-field="notes" style="width: 100%" value="${c.notes.replace(/"/g, "&quot;")}"></label>` +
    `<pre>${JSON.stringify(autoChecklist(), null, 2)}</pre>`;
  for (const input of $("checklist").querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-field]")) {
    input.onchange = () => {
      store.checklist[input.dataset.field as keyof Checklist] = input.value;
      save(store);
    };
  }
}

function renderRuns(): void {
  const rows = [...store.runs]
    .reverse()
    .map(
      (r) =>
        `<tr><td>${r.at.slice(11, 19)}</td><td>${r.length}</td><td>${r.variant}</td><td>${r.check}</td>` +
        `<td class="${r.ok ? "ok" : "bad"}">${r.ok ? "ok" : r.failure?.kind}</td>` +
        `<td>${r.latencyMs !== undefined ? Math.round(r.latencyMs) : "–"}</td><td>${r.cold ? "cold" : ""}</td><td>${r.wer ?? "–"}</td></tr>`,
    );
  $("runs").innerHTML =
    `<table><tr><th>time</th><th>len</th><th>variant</th><th>check</th><th>result</th><th>stop→final ms</th><th></th><th>WER</th></tr>${rows.join("")}</table>`;
}

function render(): void {
  renderScript();
  renderProgress();
  renderChecklist();
  renderRuns();
}

// ---- export --------------------------------------------------------------------------------------

function exportJson(): { name: string; body: string } {
  const payload = {
    spike: "S-3",
    issue: 10,
    exportedAt: new Date().toISOString(),
    browser: browserSelect.value,
    userAgent: navigator.userAgent,
    config: {
      region: REGION,
      languageCode: "en-US",
      mediaEncoding: "pcm",
      sampleRateHertz: TARGET_RATE,
      chunkSamples: CHUNK_SAMPLES,
      stabilizedVariant: { EnablePartialResultsStabilization: true, PartialResultsStability: STABILITY },
      autoSendMs: AUTO_SEND_MS,
    },
    envLoads: store.envLoads,
    roleScope: store.roleScope,
    probe16k: store.probe16k,
    checklist: { manual: store.checklist, auto: autoChecklist() },
    scripts: SCRIPTS,
    runs: store.runs,
  };
  const stamp = payload.exportedAt.replace(/[:.]/g, "-");
  return { name: `raw-${browserSelect.value}-${stamp}.json`, body: redact(JSON.stringify(payload, null, 2)) };
}

$("save").onclick = async () => {
  const { name, body } = exportJson();
  try {
    const res = await fetch(`/__results?name=${encodeURIComponent(name)}`, { method: "POST", body });
    $("export-status").textContent = res.ok ? `Saved ${await res.text()}` : `Save failed: HTTP ${res.status}`;
  } catch (error) {
    $("export-status").textContent = `Save failed: ${describe(error)}. Use Download instead.`;
  }
};
$("download").onclick = () => {
  const { name, body } = exportJson();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
};
$("clear").onclick = () => {
  if (!confirm(`Delete every stored run for ${browserSelect.value}? Export first.`)) return;
  store = emptyStore();
  save(store);
  render();
};

// ---- boot ----------------------------------------------------------------------------------------

function selectBrowser(): void {
  try {
    localStorage.setItem("s3:browser", browserSelect.value);
  } catch {
    // ignore
  }
  store = load();
  render();
}

browserSelect.onchange = selectBrowser;
lengthSelect.onchange = renderScript;
store = load();

// A run that was pending when the page went away is recorded as interrupted. r1/Q-2 doesn't count it
// when it was a deliberate check (reload, lock screen); with check "none" it counts as a failure.
if (store.pending) {
  const p = store.pending;
  store.runs.push({
    id: p.id,
    at: p.at,
    browser: browserSelect.value,
    length: p.length,
    variant: p.variant,
    check: p.check,
    endMode,
    ok: false,
    failure: { kind: "interrupted", detail: "page unloaded mid-recording" },
    cold: false,
    transcript: "",
    finalCount: 0,
    finalsAfterStop: 0,
    marks: {},
    ws: {},
    audio: { contextRate: 0, contextStateAtCreate: "closed", chunksSent: 0, bytesSent: 0, secondsSent: 0 },
    visibility: [],
  });
  delete store.pending;
}
render();
void environment().then((info) => {
  store.envLoads.push(info);
  save(store);
  renderEnv(info);
  renderChecklist();
});
void refreshAuthStatus();
