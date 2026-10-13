/**
 * Driving the deployed SPA (#40): sign in, send a patient turn, and read what the turn did from its `/api/chat`
 * response (parsed with `@sched/contracts`) and from the chips the page showed while it streamed.
 *
 * The chips are recorded in the page by a MutationObserver (`watchChips`), because the page removes them when the turn
 * ends: a check after the turn would miss them. The DOM drops a repeated consecutive label (`useChat.ts`), so the specs
 * test that a chip appeared; counts come from the stream.
 */
import { expect, type Page, type Response } from "@playwright/test";

import {
  readTurnBody,
  type TurnRecord,
  type WriteScript,
  describeTurn,
  nextScriptMessage,
} from "../lib/turns";
import type { ToolName } from "@sched/contracts";
import { appUrl, type PatientLogin, recordConversation } from "./env";

/** A turn takes seconds (#251: `done` p95 7.3–7.9 s on `dev`); this leaves room for a slow one. */
export const TURN_TIMEOUT_MS = 90_000;

declare global {
  interface Window {
    __e2eChips?: string[];
  }
}

/** Records every chip label the page shows, in order, into `window.__e2eChips`. Call before the first `goto`. */
export async function watchChips(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new WeakSet<Element>();
    window.__e2eChips = [];
    new MutationObserver(() => {
      for (const chip of document.querySelectorAll(".chat__activity .chip")) {
        if (seen.has(chip)) continue;
        seen.add(chip);
        window.__e2eChips?.push(chip.textContent);
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/** The greeting bubble that names the patient (the fallback greeting doesn't, r1/Q-6). */
export const greeting = (page: Page, firstName: string) =>
  page.locator(".chat__log > li.bubble--assistant", { hasText: firstName }).first();

export const usernameField = (page: Page) => page.getByLabel("Username");
export const passwordField = (page: Page) => page.getByLabel("Password");

/** Signs in on /login, submitting with Enter (FR-001), and waits for the chat's greeting. */
export async function signIn(page: Page, login: PatientLogin, firstName: string): Promise<void> {
  await page.goto(appUrl("/login"));
  await usernameField(page).fill(login.username);
  await passwordField(page).fill(login.password);
  await passwordField(page).press("Enter");
  await expect(page).toHaveURL(/\/chat$/);
  await expect(greeting(page, firstName)).toBeVisible();
}

const isChatPost = (response: Response) =>
  new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST";

/**
 * Sends one patient message and waits for the turn to end in the page: a new completed assistant bubble, or the error
 * bubble. Returns what the turn did, and records its conversation for the cost estimate. Logs the turn's tools.
 */
export async function sendTurn(page: Page, index: number, message: string): Promise<TurnRecord> {
  const completed = page.locator(".chat__log > li.bubble--assistant:not([aria-busy])");
  const errors = page.locator(".chat__log > li.bubble--error");
  const before = await completed.count();
  await page.evaluate(() => window.__e2eChips?.splice(0));

  const response = page.waitForResponse(isChatPost, { timeout: TURN_TIMEOUT_MS });
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill(message);
  await input.press("Enter");
  const streamed = readTurnBody(await (await response).text());
  await expect
    .poll(async () => (await completed.count()) > before || (await errors.count()) > 0, {
      timeout: TURN_TIMEOUT_MS,
    })
    .toBe(true);

  const chips = await page.evaluate(() => window.__e2eChips?.splice(0) ?? []);
  const turn: TurnRecord = { index, message, chips, ...streamed };
  recordConversation(turn.conversationId);
  console.log(`  ${describeTurn(turn)}`);
  return turn;
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
