/**
 * Login (#40, r1/A-3), on every browser, with no model calls: FR-001 (valid credentials reach the chat, invalid ones
 * show an inline error, Enter submits), FR-002 (a reload stays signed in, sign-out returns to login) and FR-003
 * (`/chat` while signed out goes to login). The invalid case signs in as a username that doesn't exist, never as the
 * E2E patient with a wrong password, so Cognito's lockout can't block the patient.
 */
import { expect, test } from "@playwright/test";

import { greeting, passwordField, signIn, usernameField } from "./support/chat";
import { appUrl, e2eEnv, patientLogin } from "./support/env";

test("/chat while signed out goes to the sign-in page (FR-003)", async ({ page }) => {
  await page.goto(appUrl("/chat"));
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("unknown credentials show an inline error and stay on sign-in (FR-001)", async ({ page }) => {
  await page.goto(appUrl("/login"));
  await usernameField(page).fill("e2e.nobody");
  await passwordField(page).fill("Not-a-real-password-1");
  await passwordField(page).press("Enter");
  await expect(page.getByRole("alert")).toHaveText(/incorrect/);
  await expect(usernameField(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/\/login$/);
});

test("valid credentials reach the chat; a reload stays signed in; sign-out returns to login (FR-001, FR-002)", async ({
  page,
}) => {
  const login = patientLogin(e2eEnv());
  await signIn(page, login);

  await page.reload();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(greeting(page, login.firstName)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(appUrl("/chat"));
  await expect(page).toHaveURL(/\/login$/);
});
