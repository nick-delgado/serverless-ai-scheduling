/**
 * The Cognito mock's pool and users (S1-02, #25). Constants only, with no imports, so the auth code
 * can name the mock pool behind `import.meta.env.DEV` and production builds drop it.
 *
 * The users are fictional (Cedar Ridge Health), and the password is accepted only by the mock in
 * src/mocks/cognito.ts, in tests and on the dev server. No real Cognito pool has it.
 */

/** Region `us-east-1`, like the real pool; Amplify derives the endpoint from the ID. */
export const MOCK_COGNITO_CONFIG = {
  userPoolId: "us-east-1_MockPool01",
  userPoolClientId: "mockspaclient000000000000a",
} as const;

/** The only password the mock accepts. Mock-only: it signs in to nothing real. */
export const MOCK_PASSWORD = "Mock-only-pass-1";

export interface MockCognitoUser {
  username: string;
  sub: string;
  givenName: string;
  /** `FORCE_CHANGE_PASSWORD` answers a correct password with `NEW_PASSWORD_REQUIRED`. */
  status: "CONFIRMED" | "FORCE_CHANGE_PASSWORD";
}

/** The token the mock `POST /api/request-access` accepts; the dev server's mock bot check sends it (#357). */
export const MOCK_BOT_CHECK_TOKEN = "mock-turnstile-token";

/** The temporary patient the mock's `POST /api/request-access` issues (#357); it signs in with MOCK_PASSWORD. */
export const MOCK_ISSUED_USER = {
  username: "user-mock0001",
  sub: "5c4b3a29-1807-4f6e-9d5c-3b2a19087f6e",
  givenName: "Noor",
  familyName: "Vance",
} as const;

export const MOCK_COGNITO_USERS: readonly MockCognitoUser[] = [
  {
    username: "maria.santos",
    sub: "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e",
    givenName: "Maria",
    status: "CONFIRMED",
  },
  {
    username: "new.patient",
    sub: "9a8b7c6d-5e4f-4031-9213-a4b5c6d7e8f9",
    givenName: "Sam",
    status: "FORCE_CHANGE_PASSWORD",
  },
  {
    username: MOCK_ISSUED_USER.username,
    sub: MOCK_ISSUED_USER.sub,
    givenName: MOCK_ISSUED_USER.givenName,
    status: "CONFIRMED",
  },
];
