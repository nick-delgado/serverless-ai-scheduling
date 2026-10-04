/**
 * A Cognito User Pool mock for Amplify Auth (S1-02, #25), registered with the mock API so tests and
 * the dev server sign in without AWS. It answers only requests for the mock app client
 * (`MOCK_COGNITO_CONFIG`); anything else passes through to the network, so a dev server built with
 * real pool IDs signs in to real Cognito.
 *
 * It behaves like the real pool where the app depends on it:
 * - `InitiateAuth` allows only `USER_SRP_AUTH`, and the password is checked with real SRP math
 *   (src/mocks/srp.ts), so only the right password signs in;
 * - unknown users get a challenge too and then the same `NotAuthorizedException` as a wrong
 *   password (PreventUserExistenceErrors);
 * - `FORCE_CHANGE_PASSWORD` users get `NEW_PASSWORD_REQUIRED`;
 * - `GetTokensFromRefreshToken` refreshes, `RevokeToken` (sign-out) revokes the refresh token.
 *
 * Tokens are unsigned JWTs (Amplify decodes them but never verifies them). Change the mock per test
 * with `configureCognitoMock`; `resetCognitoMock` forgets sessions and options.
 */
import { http, HttpResponse, passthrough } from "msw";
import { z } from "zod";

import { MOCK_COGNITO_CONFIG, MOCK_COGNITO_USERS, MOCK_PASSWORD, type MockCognitoUser } from "./cognitoUsers";
import { base64FromBytes, randomHex, type SrpChallenge, startChallenge, verifyPasswordClaim } from "./srp";

const ENDPOINT = "https://cognito-idp.us-east-1.amazonaws.com/";
const TARGET_PREFIX = "AWSCognitoIdentityProviderService.";
const POOL_NAME = MOCK_COGNITO_CONFIG.userPoolId.split("_")[1] ?? "";
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${MOCK_COGNITO_CONFIG.userPoolId}`;

export interface CognitoMockOptions {
  /** Lifetime of issued ID and access tokens. Amplify treats anything under 5 s as already expired. */
  tokenLifetimeSeconds: number;
  /** `network`: every call fails at the network level; `internal`: every call is a 500. */
  fault: "none" | "network" | "internal";
}

const DEFAULT_OPTIONS: CognitoMockOptions = { tokenLifetimeSeconds: 3600, fault: "none" };

interface PendingChallenge {
  user: MockCognitoUser | undefined;
  clientA: bigint;
  srp: SrpChallenge;
}

let options: CognitoMockOptions = DEFAULT_OPTIONS;
/** Pending PASSWORD_VERIFIER challenges, by SECRET_BLOCK. */
const challenges = new Map<string, PendingChallenge>();
/** Live refresh tokens and whose they are. */
const refreshTokens = new Map<string, MockCognitoUser>();
const counters = { refreshes: 0, revocations: 0 };

export function configureCognitoMock(changes: Partial<CognitoMockOptions>): void {
  options = { ...options, ...changes };
}

export function resetCognitoMock(): void {
  options = DEFAULT_OPTIONS;
  challenges.clear();
  refreshTokens.clear();
  counters.refreshes = 0;
  counters.revocations = 0;
}

/** What the mock has seen: refreshes served, refresh tokens revoked, sessions still live. */
export function cognitoMockStats(): { refreshes: number; revocations: number; liveSessions: number } {
  return { ...counters, liveSessions: refreshTokens.size };
}

/** Revoke every refresh token, as if the sessions expired or were signed out elsewhere. */
export function expireCognitoSessions(): void {
  refreshTokens.clear();
}

function cognitoError(type: string, message: string, status = 400): Response {
  return HttpResponse.json(
    { __type: type, message },
    { status, headers: { "x-amzn-errortype": `${type}:` } },
  );
}

const notAuthorized = () => cognitoError("NotAuthorizedException", "Incorrect username or password.");

function base64Url(value: object): string {
  return base64FromBytes(new TextEncoder().encode(JSON.stringify(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jwt(payload: object): string {
  return `${base64Url({ kid: "mock", alg: "none" })}.${base64Url(payload)}.mock-signature`;
}

function tokensFor(user: MockCognitoUser, originJti: string) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + options.tokenLifetimeSeconds;
  const common = { sub: user.sub, iss: ISSUER, origin_jti: originJti, auth_time: iat, iat, exp };
  return {
    IdToken: jwt({
      ...common,
      token_use: "id",
      aud: MOCK_COGNITO_CONFIG.userPoolClientId,
      "cognito:username": user.username,
      given_name: user.givenName,
      jti: crypto.randomUUID(),
    }),
    AccessToken: jwt({
      ...common,
      token_use: "access",
      client_id: MOCK_COGNITO_CONFIG.userPoolClientId,
      username: user.username,
      scope: "aws.cognito.signin.user.admin",
      jti: crypto.randomUUID(),
    }),
    ExpiresIn: options.tokenLifetimeSeconds,
    TokenType: "Bearer",
  };
}

function findUser(username: string): MockCognitoUser | undefined {
  // The real pool is case-insensitive (UsernameConfiguration.CaseSensitive: false).
  return MOCK_COGNITO_USERS.find((user) => user.username === username.toLowerCase());
}

/** A request body: a JSON object, or `{}` for anything else (so a non-mock request passes through). */
const RequestBody = z.record(z.string(), z.unknown()).catch({});
type Body = z.infer<typeof RequestBody>;
/** `AuthParameters` and `ChallengeResponses` are string maps in Cognito's API; absent means empty. */
const StringMap = z.record(z.string(), z.string()).default({});

/** The string map at `key`, or a 400 like Cognito's when it isn't one. */
function stringMap(body: Body, key: string): Record<string, string> | Response {
  const parsed = StringMap.safeParse(body[key]);
  return parsed.success
    ? parsed.data
    : cognitoError("InvalidParameterException", `${key} must be a map of strings`);
}

async function initiateAuth(body: Body): Promise<Response> {
  if (body.AuthFlow !== "USER_SRP_AUTH") {
    return cognitoError(
      "InvalidParameterException",
      `${String(body.AuthFlow)} flow not enabled for this client`,
    );
  }
  const params = stringMap(body, "AuthParameters");
  if (params instanceof Response) return params;
  const { USERNAME: username = "", SRP_A: srpA = "" } = params;
  const user = findUser(username);
  // Unknown users get a challenge too and fail at the next step, the same way as a wrong password.
  const userIdForSrp = user?.username ?? username;
  const srp = await startChallenge(POOL_NAME, userIdForSrp, MOCK_PASSWORD);
  const secretBlock = base64FromBytes(crypto.getRandomValues(new Uint8Array(64)));
  challenges.set(secretBlock, { user, clientA: BigInt(`0x${srpA}`), srp });
  return HttpResponse.json({
    ChallengeName: "PASSWORD_VERIFIER",
    ChallengeParameters: {
      SALT: srp.saltHex,
      SRP_B: srp.serverB.toString(16),
      SECRET_BLOCK: secretBlock,
      USER_ID_FOR_SRP: userIdForSrp,
      USERNAME: userIdForSrp,
    },
  });
}

async function respondToAuthChallenge(body: Body): Promise<Response> {
  const responses = stringMap(body, "ChallengeResponses");
  if (responses instanceof Response) return responses;
  const secretBlock = responses.PASSWORD_CLAIM_SECRET_BLOCK ?? "";
  const pending = challenges.get(secretBlock);
  if (body.ChallengeName !== "PASSWORD_VERIFIER" || !pending) return notAuthorized();
  const verified = await verifyPasswordClaim(pending.srp, {
    poolName: POOL_NAME,
    userIdForSrp: responses.USERNAME ?? "",
    clientA: pending.clientA,
    secretBlock,
    timestamp: responses.TIMESTAMP ?? "",
    signature: responses.PASSWORD_CLAIM_SIGNATURE ?? "",
  });
  const { user } = pending;
  if (!verified || !user) return notAuthorized();
  if (user.status === "FORCE_CHANGE_PASSWORD") {
    return HttpResponse.json({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: randomHex(32),
      ChallengeParameters: { USER_ID_FOR_SRP: user.username, requiredAttributes: "[]", userAttributes: "{}" },
    });
  }
  const refreshToken = `mock-refresh-${randomHex(24)}`;
  refreshTokens.set(refreshToken, user);
  return HttpResponse.json({
    ChallengeParameters: {},
    AuthenticationResult: { ...tokensFor(user, randomHex(16)), RefreshToken: refreshToken },
  });
}

function getTokensFromRefreshToken(body: Body): Response {
  const user = refreshTokens.get(String(body.RefreshToken));
  if (!user) return cognitoError("NotAuthorizedException", "Refresh Token has been revoked");
  counters.refreshes += 1;
  return HttpResponse.json({ AuthenticationResult: tokensFor(user, randomHex(16)) });
}

function revokeToken(body: Body): Response {
  if (refreshTokens.delete(String(body.Token))) counters.revocations += 1;
  return HttpResponse.json({});
}

export const cognitoHandlers = [
  http.post(ENDPOINT, async ({ request }) => {
    const body = RequestBody.parse(
      await request
        .clone()
        .json()
        .catch(() => undefined),
    );
    if (body.ClientId !== MOCK_COGNITO_CONFIG.userPoolClientId) return passthrough();
    if (options.fault === "network") return HttpResponse.error();
    if (options.fault === "internal") {
      return cognitoError("InternalErrorException", "Internal server error.", 500);
    }
    const operation = request.headers.get("x-amz-target")?.replace(TARGET_PREFIX, "");
    switch (operation) {
      case "InitiateAuth":
        return initiateAuth(body);
      case "RespondToAuthChallenge":
        return respondToAuthChallenge(body);
      case "GetTokensFromRefreshToken":
        return getTokensFromRefreshToken(body);
      case "RevokeToken":
        return revokeToken(body);
      default:
        return cognitoError(
          "InvalidParameterException",
          `The Cognito mock doesn't implement ${String(operation)}`,
        );
    }
  }),
];
