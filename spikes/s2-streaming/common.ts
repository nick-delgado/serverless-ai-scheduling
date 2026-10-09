/**
 * Shared bits for the S-2 spike scripts: config from SSM, the test user's credentials from the
 * git-ignored .env, Cognito SRP sign-in from Node, and redaction for anything written to results/.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthenticationDetails, CognitoUser, CognitoUserPool } from "amazon-cognito-identity-js";

export const here = dirname(fileURLToPath(import.meta.url));

export function ssm(name: string): string {
  return execFileSync(
    "aws",
    ["ssm", "get-parameter", "--name", name, "--query", "Parameter.Value", "--output", "text"],
    {
      encoding: "utf8",
    },
  ).trim();
}

export interface SpikeConfig {
  userPoolId: string;
  clientId: string;
  cloudfrontDomain: string;
  executeApiDomain: string;
  stage: string;
}

export function loadConfig(env: string): SpikeConfig {
  return {
    userPoolId: ssm(`/sched/${env}/auth/user-pool-id`),
    clientId: ssm(`/sched/${env}/auth/spa-client-id`),
    cloudfrontDomain: ssm(`/sched/${env}/web/domain`),
    executeApiDomain: ssm(`/sched/${env}/api/execute-api-domain`),
    stage: ssm(`/sched/${env}/api/stage-name`),
  };
}

/** Public results must not carry account IDs or live endpoint names. */
export function redactor(cfg: SpikeConfig): (s: string) => string {
  const apiId = cfg.executeApiDomain.split(".")[0] ?? "<none>";
  return (s) =>
    s
      .replaceAll(cfg.cloudfrontDomain, "<distribution>.cloudfront.net")
      .replaceAll(apiId, "<rest-api-id>")
      // Not inside a number: a fraction such as 6744.399999999674 has 12 digits after the point (#10).
      .replace(/(?<![\d.])\d{12}(?!\d)/g, "<account>");
}

/** USER_SRP_AUTH as the test user from spikes/s2-streaming/.env. Resolves with the ID token. */
export function signIn(cfg: SpikeConfig): Promise<string> {
  const envFile = join(here, ".env");
  if (!existsSync(envFile))
    throw new Error(`Missing ${envFile} (SKELETON_USERNAME / SKELETON_PASSWORD); see README.md`);
  process.loadEnvFile(envFile);
  const username = process.env.SKELETON_USERNAME ?? "";
  const password = process.env.SKELETON_PASSWORD ?? "";

  const pool = new CognitoUserPool({ UserPoolId: cfg.userPoolId, ClientId: cfg.clientId });
  const user = new CognitoUser({ Username: username, Pool: pool });
  return new Promise((resolve, reject) => {
    user.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
      onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
      onFailure: (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
      newPasswordRequired: () => reject(new Error("user needs a new password")),
    });
  });
}
