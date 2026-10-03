/** The Cognito mock's own rules, where the app's tests don't reach them (src/mocks/cognito.ts). */
import { describe, expect, it } from "vitest";

import { MOCK_COGNITO_CONFIG } from "./cognitoUsers";

describe("Cognito mock", () => {
  it("refuses password flows other than USER_SRP_AUTH, like the real app client", async () => {
    const response = await fetch("https://cognito-idp.us-east-1.amazonaws.com/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: MOCK_COGNITO_CONFIG.userPoolClientId,
        AuthParameters: { USERNAME: "maria.santos", PASSWORD: "anything" },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ __type: "InvalidParameterException" });
  });
});
