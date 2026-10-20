/**
 * The User Pool admin operations that create a patient, shared by `scripts/seed-users.ts` (the fixture
 * patients) and the request-access handler (temporary reviewer patients, #357). Both create a user the
 * same way (ADR-005): `AdminCreateUser` with no invitation message, then `AdminSetUserPassword` with
 * `Permanent: true`, so the user signs in with SRP straight away. Tests inject a fake, so nothing here needs AWS.
 */
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  type CognitoIdentityProviderClient,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";

/** What the pool is told about a new user: the username and the synthetic name (never an email or phone). */
export interface NewUser {
  username: string;
  givenName: string;
  familyName: string;
}

export interface CognitoAdmin {
  /** Creates the user without sending any message. Resolves false when the username already exists. */
  createUser(user: NewUser): Promise<boolean>;
  getSub(username: string): Promise<string>;
  setPermanentPassword(username: string, password: string): Promise<void>;
  /** Deletes the user. A user that does not exist counts as deleted. */
  deleteUser(username: string): Promise<void>;
}

/** Mirrors the User Pool's policy in infra/stacks/auth.yaml, so a bad password fails before any AWS call. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("is shorter than 12 characters");
  if (!/[a-z]/.test(password)) problems.push("has no lowercase letter");
  if (!/[A-Z]/.test(password)) problems.push("has no uppercase letter");
  if (!/[0-9]/.test(password)) problems.push("has no number");
  return problems;
}

export function cognitoAdmin(client: CognitoIdentityProviderClient, userPoolId: string): CognitoAdmin {
  return {
    async createUser(user) {
      try {
        await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: user.username,
            MessageAction: "SUPPRESS",
            UserAttributes: [
              { Name: "given_name", Value: user.givenName },
              { Name: "family_name", Value: user.familyName },
            ],
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof UsernameExistsException) return false;
        throw err;
      }
    },
    async getSub(username) {
      const out = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
      const sub = out.UserAttributes?.find((a) => a.Name === "sub")?.Value;
      if (!sub) throw new Error(`User ${username} has no sub attribute`);
      return sub;
    },
    async setPermanentPassword(username, password) {
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: username,
          Password: password,
          Permanent: true,
        }),
      );
    },
    async deleteUser(username) {
      try {
        await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
      } catch (err) {
        if (!(err instanceof UserNotFoundException)) throw err;
      }
    },
  };
}
