/**
 * The patient's Cognito session, through Amplify Auth with Cognito only (ADR-005, S1-02 #25).
 *
 * - Sign-in is USER_SRP_AUTH (the only password flow the app client allows).
 * - Amplify keeps the tokens in local storage, so a reload keeps the patient signed in (FR-002).
 *   `getIdToken` refreshes them silently with the refresh token when they are near expiry.
 * - Sign-out revokes the refresh token and clears the stored tokens.
 *
 * Failures are reported without saying whether the username exists (FR-001): a wrong password and
 * an unknown user are both `credentials`.
 */
import { Amplify } from "aws-amplify";
import { fetchAuthSession, getCurrentUser, signIn, signOut } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";

import type { CognitoConfig } from "./config";

export interface AuthUser {
  username: string;
}

export type SignInResult =
  | { ok: true; user: AuthUser }
  /**
   * - `credentials`: wrong username or password (or an empty one), never which;
   * - `unsupported`: the password was right, but Cognito wants a step this page doesn't offer
   *   (a new password, for an admin-created user who never set one);
   * - `unavailable`: anything else (network, service or configuration errors).
   */
  | { ok: false; reason: "credentials" | "unsupported" | "unavailable" };

export interface AuthService {
  /**
   * The signed-in user from the stored session (refreshed first if its tokens have expired);
   * `undefined` when signed out or the session can't be used right now.
   */
  currentUser(): Promise<AuthUser | undefined>;
  signIn(username: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  /**
   * The current ID token (what the API's authorizer checks, sent raw as `Authorization`),
   * refreshed first if it is near expiry; `undefined` when signed out or the session can't be
   * refreshed. Rejects on transient errors (offline, Cognito unavailable), which a retry can fix.
   */
  getIdToken(): Promise<string | undefined>;
  /** Calls `listener` when the session may have changed elsewhere (a failed refresh, another sign-out). */
  onChange(listener: () => void): () => void;
}

/** Errors Cognito and Amplify raise for bad credentials; none of them says whether the user exists. */
const CREDENTIAL_ERRORS = new Set([
  "NotAuthorizedException",
  "UserNotFoundException",
  "EmptySignInUsername",
  "EmptySignInPassword",
]);

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/**
 * An `AuthService` on Amplify. `config` is resolved on first use, so a build without Cognito
 * settings still renders the login page (sign-in then fails as `unavailable`).
 */
export function createAmplifyAuthService(config: () => CognitoConfig): AuthService {
  let configured = false;
  const ensureConfigured = () => {
    if (configured) return;
    const { userPoolId, userPoolClientId } = config();
    Amplify.configure({ Auth: { Cognito: { userPoolId, userPoolClientId } } });
    configured = true;
  };

  return {
    async currentUser() {
      try {
        ensureConfigured();
        const { username } = await getCurrentUser();
        return { username };
      } catch {
        return undefined;
      }
    },

    async signIn(username, password) {
      try {
        ensureConfigured();
        const input = { username: username.trim(), password };
        const result = await signIn(input).catch(async (error: unknown) => {
          // A stored session that couldn't be refreshed just now (offline at load) still counts as
          // signed in to Amplify. The patient is signing in again, so drop it and retry once.
          if (errorName(error) !== "UserAlreadyAuthenticatedException") throw error;
          await signOut();
          return signIn(input);
        });
        // Amplify drops the half-finished sign-in when the next attempt starts.
        if (result.nextStep.signInStep !== "DONE") return { ok: false, reason: "unsupported" };
        const user = await getCurrentUser();
        return { ok: true, user: { username: user.username } };
      } catch (error) {
        if (CREDENTIAL_ERRORS.has(errorName(error))) return { ok: false, reason: "credentials" };
        console.error("Sign-in failed", error);
        return { ok: false, reason: "unavailable" };
      }
    },

    async signOut() {
      ensureConfigured();
      await signOut();
    },

    async getIdToken() {
      try {
        ensureConfigured();
      } catch {
        return undefined;
      }
      const { tokens } = await fetchAuthSession();
      return tokens?.idToken?.toString();
    },

    onChange(listener) {
      return Hub.listen("auth", ({ payload }) => {
        if (payload.event === "signedOut" || payload.event === "tokenRefresh_failure") listener();
      });
    },
  };
}
