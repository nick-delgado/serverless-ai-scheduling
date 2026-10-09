/**
 * Where the SPA's Cognito settings come from (S1-02, #25). The user pool and app client IDs are not
 * secrets, but they stay out of the repo: they're baked in at build time from `VITE_USER_POOL_ID`
 * and `VITE_SPA_CLIENT_ID` (SSM `/sched/<env>/auth/user-pool-id` and `/auth/spa-client-id`; see
 * apps/web/README.md). The dev server and tests fall back to the Cognito mock in src/mocks.
 *
 * The Identity Pool ID (`VITE_IDENTITY_POOL_ID`, SSM `/sched/<env>/auth/identity-pool-id`; S6-02 #29)
 * is optional and outside the "both or neither" rule: without it sign-in still works and only voice
 * leaves the real path. It's ignored on the mock fallback, whose tokens can't be exchanged (r1/A-2).
 */

export interface CognitoConfig {
  userPoolId: string;
  userPoolClientId: string;
  /** The Identity Pool that exchanges the ID token for Transcribe-only AWS credentials (ADR-005, ADR-006). */
  identityPoolId?: string;
}

export interface CognitoEnv {
  VITE_USER_POOL_ID?: string;
  VITE_SPA_CLIENT_ID?: string;
  VITE_IDENTITY_POOL_ID?: string;
}

/**
 * The build's Cognito settings: both IDs from the environment, or `fallback` (the mock's, in
 * development) when neither is set. Setting only one of them is a mistake, not a reason to use the
 * mock.
 */
export function resolveCognitoConfig(env: CognitoEnv, fallback?: CognitoConfig): CognitoConfig {
  const userPoolId = env.VITE_USER_POOL_ID?.trim() ?? "";
  const userPoolClientId = env.VITE_SPA_CLIENT_ID?.trim() ?? "";
  if (userPoolId && userPoolClientId) {
    const identityPoolId = env.VITE_IDENTITY_POOL_ID?.trim() ?? "";
    return identityPoolId
      ? { userPoolId, userPoolClientId, identityPoolId }
      : { userPoolId, userPoolClientId };
  }
  if (!userPoolId && !userPoolClientId && fallback) return fallback;
  throw new Error(
    "Sign-in is not configured: set both VITE_USER_POOL_ID and VITE_SPA_CLIENT_ID at build time (apps/web/README.md).",
  );
}

/**
 * The build's Identity Pool ID, or `undefined` when there is none or sign-in uses the mock (the IDs
 * aren't both set). Never throws: a missing ID only takes voice off the real path.
 */
export function resolveIdentityPoolId(env: CognitoEnv): string | undefined {
  try {
    return resolveCognitoConfig(env).identityPoolId;
  } catch {
    return undefined;
  }
}
