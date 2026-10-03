/** The Cognito mock's own rules, where the app's tests don't reach them (src/mocks/cognito.ts). */
import { describe, expect, it } from "vitest";

import { MOCK_COGNITO_CONFIG } from "./cognitoUsers";

function cognito(operation: string, body: object): Promise<Response> {
  return fetch("https://cognito-idp.us-east-1.amazonaws.com/", {
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
});
