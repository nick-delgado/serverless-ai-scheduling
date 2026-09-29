/**
 * Walking-skeleton page (#7): Cognito SRP sign-in, then POST /api/chat and render `text_delta`
 * events as they arrive. Deliberately bare: no React, no typewriter smoothing (FR-013 lands with
 * the real chat UI), no session restore. Delete this folder when S5-01 (#24) ships the SPA.
 */
import { parseStreamEventLine, type ChatStreamEvent } from "@sched/contracts";
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type ICognitoStorage,
} from "amazon-cognito-identity-js";

/** Keep tokens in memory only: a reload signs you out, and nothing lands in localStorage. */
class MemoryStorage implements ICognitoStorage {
  #items = new Map<string, string>();
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  clear(): void {
    this.#items.clear();
  }
}

const storage = new MemoryStorage();
const pool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_USER_POOL_ID,
  ClientId: import.meta.env.VITE_SPA_CLIENT_ID,
  Storage: storage,
});

/** USER_SRP_AUTH (the only password flow the app client allows). Resolves with the ID token. */
function signIn(username: string, password: string): Promise<string> {
  const user = new CognitoUser({ Username: username, Pool: pool, Storage: storage });
  return new Promise((resolve, reject) => {
    user.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
      onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
      onFailure: (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
      newPasswordRequired: () => reject(new Error("This user must set a new password first.")),
    });
  });
}

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const loginForm = element<HTMLFormElement>("login");
const chatForm = element<HTMLFormElement>("chat");
const reply = element<HTMLDivElement>("reply");
const status = element<HTMLParagraphElement>("status");

let idToken: string | null = null;

function setStatus(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = new FormData(loginForm);
  setStatus("Signing in…");
  signIn(String(data.get("username")), String(data.get("password")))
    .then((token) => {
      idToken = token;
      loginForm.hidden = true;
      chatForm.hidden = false;
      setStatus("Signed in.");
    })
    .catch((err: unknown) =>
      setStatus(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`, true),
    );
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = String(new FormData(chatForm).get("text")).trim();
  if (!idToken || !text) return;
  const button = chatForm.querySelector("button");
  if (button) button.disabled = true;
  sendMessage(idToken, text)
    .catch((err: unknown) =>
      setStatus(`Request failed: ${err instanceof Error ? err.message : String(err)}`, true),
    )
    .finally(() => {
      if (button) button.disabled = false;
    });
});

async function sendMessage(token: string, text: string): Promise<void> {
  reply.textContent = "";
  setStatus("Waiting for the first byte…");
  const t0 = performance.now();
  const ms = (): string => `${Math.round(performance.now() - t0)} ms`;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ clientMessageId: crypto.randomUUID(), text }),
  });
  const headersAt = ms();
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("ndjson")) {
    // e.g. API Gateway's own 401 {"message":"Unauthorized"}
    setStatus(`HTTP ${res.status}: ${await res.text()}`, true);
    return;
  }

  let chunks = 0;
  let deltas = 0;
  let firstDeltaAt: string | null = null;
  let buffered = "";
  const handle = (event: ChatStreamEvent): void => {
    if (event.type === "text_delta") {
      deltas += 1;
      firstDeltaAt ??= ms();
      reply.textContent += event.text;
    } else if (event.type === "error") {
      setStatus(`${event.code}: ${event.message}${event.retryable ? " (retryable)" : ""}`, true);
    } else if (event.type === "done") {
      setStatus(
        `HTTP ${res.status} · headers ${headersAt} · first text ${firstDeltaAt ?? "–"} · done ${ms()} · ` +
          `${deltas} text_delta events in ${chunks} network chunks · ${event.usage.outputTokens} output tokens`,
      );
    }
  };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks += 1;
    buffered += value;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) handle(parseStreamEventLine(line));
      newline = buffered.indexOf("\n");
    }
  }
}
