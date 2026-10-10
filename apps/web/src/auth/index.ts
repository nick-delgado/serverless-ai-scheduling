/**
 * The auth seam (S1-02, #25). API clients take `getIdToken` as their token getter and send the raw
 * ID token as `Authorization`; components read the state with `useAuth`.
 */
export {
  type AuthService,
  type AuthUser,
  type AwsCredentials,
  createAmplifyAuthService,
  type SignInResult,
} from "./authService";
export { type AuthContextValue, AuthProvider, type AuthState, useAuth } from "./AuthProvider";
export {
  type CognitoConfig,
  identityPoolRegion,
  resolveCognitoConfig,
  resolveIdentityPoolId,
  usesCognitoMock,
} from "./config";
export { RequireAuth } from "./RequireAuth";
export { defaultAuthService, getAwsCredentials, getIdToken } from "./session";
