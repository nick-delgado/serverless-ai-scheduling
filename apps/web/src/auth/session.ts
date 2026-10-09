/**
 * The app's one auth service, and the token getter the API clients take (S1-02, #25).
 *
 * Cognito settings come from the build (`resolveCognitoConfig`); the dev server and tests fall back
 * to the Cognito mock's pool unless `VITE_MOCK_API=off`. Production builds drop that fallback.
 */
import { MOCK_COGNITO_CONFIG } from "../mocks/cognitoUsers";
import { type AuthService, type AwsCredentials, createAmplifyAuthService } from "./authService";
import { resolveCognitoConfig } from "./config";

let service: AuthService | undefined;

export function defaultAuthService(): AuthService {
  service ??= createAmplifyAuthService(() =>
    resolveCognitoConfig(
      import.meta.env,
      import.meta.env.DEV && import.meta.env.VITE_MOCK_API !== "off" ? MOCK_COGNITO_CONFIG : undefined,
    ),
  );
  return service;
}

/**
 * The patient's current Cognito ID token for `Authorization: <token>`, refreshed silently when near
 * expiry; `undefined` when signed out. Rejects on transient errors (see `AuthService.getIdToken`).
 * Pass it to API clients as their token getter.
 */
export function getIdToken(): Promise<string | undefined> {
  return defaultAuthService().getIdToken();
}

/**
 * The patient's Identity Pool credentials, for voice only (S6-02, #29); `undefined` when signed out or
 * the build has no Identity Pool. Rejects when Cognito can't issue them. Text chat never calls this.
 */
export function getAwsCredentials(): Promise<AwsCredentials | undefined> {
  return defaultAuthService().getAwsCredentials();
}
