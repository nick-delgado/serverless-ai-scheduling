/**
 * Identity Pool credentials for a seeded demo patient on `dev` (r1/Q-1 (b)): Amplify `signIn`, then
 * `fetchAuthSession().credentials`, the path #29 r1/A-1 fixed. The pool IDs come from the
 * git-ignored `.env.local` that `npm run config` writes; the password is typed at run time.
 */
import { Amplify } from "aws-amplify";
import { fetchAuthSession, signIn, signOut } from "aws-amplify/auth";

import type { StaticCredentials } from "./capture";
import { describe } from "./capture";

export const REGION = "us-east-1";

const env = import.meta.env as Record<string, string | undefined>;
const userPoolId = env.VITE_USER_POOL_ID ?? "";
const userPoolClientId = env.VITE_SPA_CLIENT_ID ?? "";
const identityPoolId = env.VITE_IDENTITY_POOL_ID ?? "";

export const configured = Boolean(userPoolId && userPoolClientId && identityPoolId);

if (configured) {
  Amplify.configure({
    Auth: { Cognito: { userPoolId, userPoolClientId, identityPoolId, allowGuestAccess: false } },
  });
}

export async function signInDemo(username: string, password: string): Promise<string> {
  try {
    await signOut();
  } catch {
    // not signed in
  }
  const result = await signIn({ username: username.trim(), password });
  return result.isSignedIn ? "signed in" : `next step: ${result.nextStep.signInStep}`;
}

export { signOut };

/** Cached by Amplify; refreshed only when the credentials are near expiry. */
export async function credentials(): Promise<StaticCredentials | undefined> {
  const session = await fetchAuthSession();
  return session.credentials;
}

export interface RoleScopeCheck {
  at: string;
  action: "transcribe:ListTranscriptionJobs";
  /** preflight.ts waits for this field's name in the page's output; keep the two in sync. */
  denied: boolean;
  result: string;
}

/**
 * ADR-006's role-scoping item: the same credentials must be refused anything but the streaming
 * action. `@aws-sdk/client-transcribe` is imported only here, so it stays out of the measured chunks.
 */
export async function checkRoleScope(): Promise<RoleScopeCheck> {
  const creds = await credentials();
  if (!creds) throw new Error("no credentials: sign in first");
  const { TranscribeClient, ListTranscriptionJobsCommand } = await import("@aws-sdk/client-transcribe");
  const client = new TranscribeClient({ region: REGION, credentials: creds });
  const at = new Date().toISOString();
  try {
    await client.send(new ListTranscriptionJobsCommand({ MaxResults: 1 }));
    return {
      at,
      action: "transcribe:ListTranscriptionJobs",
      denied: false,
      result: "ALLOWED (role is too broad)",
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      at,
      action: "transcribe:ListTranscriptionJobs",
      denied: name === "AccessDeniedException",
      result: describe(error),
    };
  }
}
