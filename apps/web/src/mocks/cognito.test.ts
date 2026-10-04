/** The Cognito mock's own rules, where the app's tests don't reach them (src/mocks/cognito.ts). */
import { getResponse, isPassthroughResponse } from "msw";
import { describe, expect, it } from "vitest";

import { cognitoHandlers, configureCognitoMock } from "./cognito";
import { MOCK_COGNITO_CONFIG } from "./cognitoUsers";

const ENDPOINT = "https://cognito-idp.us-east-1.amazonaws.com/";

/** Ask the Cognito handlers directly (no network) what they do with a request carrying `body`. */
async function handle(body: string): Promise<Response | undefined> {
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body,
  });
  return getResponse(cognitoHandlers, request);
}

const initiateAuth = (clientId: string) =>
  JSON.stringify({
    ClientId: clientId,
    AuthFlow: "USER_SRP_AUTH",
    AuthParameters: { USERNAME: "maria.santos", SRP_A: "2" },
  });

function cognito(operation: string, body: object): Promise<Response> {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify({ ClientId: MOCK_COGNITO_CONFIG.userPoolClientId, ...body }),
  });
}

describe("Cognito mock", () => {
  it("challenges with the canonical username whatever case was typed, like the real pool", async () => {
    const response = await cognito("InitiateAuth", {
      AuthFlow: "USER_SRP_AUTH",
      AuthParameters: { USERNAME: "MARIA.Santos", SRP_A: "2" },
    });
    expect(await response.json()).toMatchObject({
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: { USER_ID_FOR_SRP: "maria.santos", USERNAME: "maria.santos" },
    });
  });

  it("refuses password flows other than USER_SRP_AUTH, like the real app client", async () => {
    const response = await cognito("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "maria.santos", PASSWORD: "anything" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ __type: "InvalidParameterException" });
  });

  it.each([
    ["another app client", initiateAuth("realspaclient0000000000000")],
    ["a body that isn't JSON", "not json"],
    ["a JSON body that isn't an object", "[]"],
  ])("passes %s through to the network", async (_, body) => {
    const response = await handle(body);
    expect(response && isPassthroughResponse(response)).toBe(true);
  });

  it("passes another app client through even while it fails its own calls", async () => {
    configureCognitoMock({ fault: "network" });
    const response = await handle(initiateAuth("realspaclient0000000000000"));
    expect(response && isPassthroughResponse(response)).toBe(true);
  });

  it("answers the mock app client itself", async () => {
    const response = await handle(initiateAuth(MOCK_COGNITO_CONFIG.userPoolClientId));
    expect(response && isPassthroughResponse(response)).toBe(false);
    expect(response?.status).toBe(200);
  });

  it.each([
    ["InitiateAuth", { AuthFlow: "USER_SRP_AUTH", AuthParameters: { USERNAME: 42, SRP_A: "2" } }],
    ["RespondToAuthChallenge", { ChallengeName: "PASSWORD_VERIFIER", ChallengeResponses: { USERNAME: 42 } }],
  ])("rejects %s parameters that aren't strings with a 400", async (operation, body) => {
    const response = await cognito(operation, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ __type: "InvalidParameterException" });
  });
});
