/**
 * Where the SPA's Cognito settings come from (S1-02, #25). The user pool and app client IDs are not
 * secrets, but they stay out of the repo: they're baked in at build time from `VITE_USER_POOL_ID`
 * and `VITE_SPA_CLIENT_ID` (SSM `/sched/<env>/auth/user-pool-id` and `/auth/spa-client-id`; see
 * apps/web/README.md). The dev server and tests fall back to the Cognito mock in src/mocks.
 */

export interface CognitoConfig {
  userPoolId: string;
  userPoolClientId: string;
}

export interface CognitoEnv {
  VITE_USER_POOL_ID?: string;
  VITE_SPA_CLIENT_ID?: string;
}

/**
 * The build's Cognito settings: both IDs from the environment, or `fallback` (the mock's, in
 * development) when neither is set. Setting only one of them is a mistake, not a reason to use the
 * mock.
 */
export function resolveCognitoConfig(env: CognitoEnv, fallback?: CognitoConfig): CognitoConfig {
  const userPoolId = env.VITE_USER_POOL_ID?.trim() ?? "";
  const userPoolClientId = env.VITE_SPA_CLIENT_ID?.trim() ?? "";
  if (userPoolId && userPoolClientId) return { userPoolId, userPoolClientId };
  if (!userPoolId && !userPoolClientId && fallback) return fallback;
  throw new Error(
    "Sign-in is not configured: set both VITE_USER_POOL_ID and VITE_SPA_CLIENT_ID at build time (apps/web/README.md).",
  );
}
