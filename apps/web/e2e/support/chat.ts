/**
 * Driving the deployed SPA (#40): sign in, send a patient turn, and read what the turn did from its `/api/chat`
 * response (parsed with `@sched/contracts`) and from the chips the page showed while it streamed.
 *
 * `observePage` installs two recorders in the page before the app loads:
 *   - the chips, by a MutationObserver, because the page removes them when the turn ends, so a check after the turn
 *     would miss them. The DOM drops a repeated consecutive label (`useChat.ts`), so the specs test that a chip
 *     appeared; counts come from the stream;
 *   - each `/api/chat` response body, by teeing the stream inside `fetch`: Chromium can't hand Playwright the body of
 *     a streamed response the page has read ("No data found for resource"), and the tee leaves the app's half
 *     streaming as before.
 */
import type { ToolName } from "@sched/contracts";
import { expect, type Page } from "@playwright/test";

import {
  describeTurn,
  mergeAttempts,
  nextScriptMessage,
  readTurnBody,
  shouldRetryTurn,
  type StreamedTurn,
  throttleDelayMs,
  type TurnRecord,
  type WriteScript,
} from "../lib/turns";
import { recordConversation } from "../lib/run-dir";
import { appUrl, type FixtureLogin } from "./env";

/** A turn takes seconds (#251: `done` p95 7.3–7.9 s on `dev`); this leaves room for a slow one. */
const TURN_TIMEOUT_MS = 90_000;

declare global {
  interface Window {
    __e2eChips?: string[];
    /** Each `/api/chat` body the page read, or why it couldn't be read. */
    __e2eBodies?: ({ body: string } | { readError: string })[];
  }
}

/** Records the chips the page shows and the `/api/chat` bodies it reads. Call before the first `goto`. */
export async function observePage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new WeakSet<Element>();
    const chips: string[] = (window.__e2eChips = []);
    new MutationObserver(() => {
      for (const chip of document.querySelectorAll(".chat__activity .chip")) {
        if (seen.has(chip)) continue;
        seen.add(chip);
        chips.push(chip.textContent);
      }
    }).observe(document, { childList: true, subtree: true });

    const bodies: NonNullable<Window["__e2eBodies"]> = (window.__e2eBodies = []);
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== "/api/chat" || !response.body) return response;
      const [ours, theirs] = response.body.tee();
      void new Response(ours).text().then(
        (body) => bodies.push({ body }),
        (error: unknown) => bodies.push({ readError: String(error) }),
      );
      return new Response(theirs, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  });
}

/** The chat's assistant bubbles, the greeting included (`ChatPage.tsx`). */
export const ASSISTANT_BUBBLE = ".chat__log > li.bubble--assistant";

/** The greeting bubble that names the patient (the fallback greeting doesn't, r1/Q-6). */
export const greeting = (page: Page, firstName: string) =>
  page.locator(ASSISTANT_BUBBLE, { hasText: firstName }).first();

export const usernameField = (page: Page) => page.getByLabel("Username");
export const passwordField = (page: Page) => page.getByLabel("Password");

/**
 * Signs in on `<base>/login` (default: `E2E_BASE_URL`), submitting with Enter (FR-001), and waits for the chat's
 * greeting by the patient's first name.
 */
export async function signIn(page: Page, login: FixtureLogin, base?: string): Promise<void> {
  await page.goto(base === undefined ? appUrl("/login") : `${base}/login`);
  await usernameField(page).fill(login.username);
  await passwordField(page).fill(login.password);
  await passwordField(page).press("Enter");
  await expect(page).toHaveURL(/\/chat$/);
  await expect(greeting(page, login.firstName)).toBeVisible();
}

/**
 * Sends one patient message and waits for the turn to end: its whole `/api/chat` body read, and in the page a new
 * completed assistant bubble or the error bubble. A turn the Bedrock quota throttled is retried with the app's Retry
 * button (`shouldRetryTurn`), as a patient would, and stays one turn. Returns what the turn did, records its
 * conversation for the cost estimate, and logs its tools (never its text).
 */
export async function sendTurn(page: Page, index: number, message: string): Promise<TurnRecord> {
  const before = await page.locator(`${ASSISTANT_BUBBLE}:not([aria-busy])`).count();
  await page.evaluate(() => {
    window.__e2eChips?.splice(0);
    window.__e2eBodies?.splice(0);
  });

  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill(message);
  await input.press("Enter");
  const attempts = [await turnEnd(page, before)];
  while (shouldRetryTurn(attempts.at(-1) as StreamedTurn, attempts.length - 1)) {
    const delay = throttleDelayMs(attempts.length);
    console.log(`  turn ${String(index + 1)}: throttled (RATE_LIMITED); Retry in ${String(delay / 1000)} s`);
    await page.waitForTimeout(delay);
    await page.evaluate(() => window.__e2eBodies?.splice(0));
    await page.getByRole("button", { name: "Retry" }).click();
    attempts.push(await turnEnd(page, before));
  }

  const chips = await page.evaluate(() => window.__e2eChips?.splice(0) ?? []);
  const turn: TurnRecord = { index, chips, ...mergeAttempts(attempts) };
  recordConversation(process.env.E2E_RUN_DIR, turn.conversationId);
  console.log(`  ${describeTurn(turn)}`);
  return turn;
}

/** Waits for one attempt's `/api/chat` body, then for the page to show its end: a new completed reply or the error. */
async function turnEnd(page: Page, completedBefore: number): Promise<StreamedTurn> {
  const read = await page.waitForFunction(() => window.__e2eBodies?.[0], undefined, {
    timeout: TURN_TIMEOUT_MS,
  });
  const result = (await read.jsonValue()) as { body: string } | { readError: string };
  if ("readError" in result) throw new Error(`The /api/chat body couldn't be read: ${result.readError}`);
  const completed = page.locator(`${ASSISTANT_BUBBLE}:not([aria-busy])`);
  const errors = page.locator(".chat__log > li.bubble--error");
  await expect
    .poll(async () => (await completed.count()) > completedBefore || (await errors.count()) > 0, {
      timeout: TURN_TIMEOUT_MS,
    })
    .toBe(true);
  return readTurnBody(result.body);
}

/** Runs a booking or reschedule script (r1/Q-2 (a)) until the write ran, a turn failed, or the turn cap. */
export async function runWriteScript(page: Page, script: WriteScript, tool: ToolName): Promise<TurnRecord[]> {
  const turns: TurnRecord[] = [];
  for (let message = nextScriptMessage(script, turns, tool); message !== undefined;) {
    turns.push(await sendTurn(page, turns.length, message));
    message = nextScriptMessage(script, turns, tool);
  }
  return turns;
}
