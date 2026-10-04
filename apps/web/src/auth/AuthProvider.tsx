/**
 * Auth state for components (S1-02, #25): `loading` while the stored session is read, then
 * `signedIn` or `signedOut`. Sign-in and sign-out go through here so the state changes with them;
 * a failed silent refresh or a sign-out elsewhere is picked up from the service's change events.
 *
 * Each of those also ends the chat's login session (FR-014, #27): a sign-in starts a new one, and a
 * sign-out or an ended sign-in (the change events: `signedOut`, `tokenRefresh_failure`) clears it, so
 * the chat won't restore a conversation from an earlier sign-in.
 */
import { createContext, type ReactNode, use, useEffect, useMemo, useState } from "react";

import { clearLoginSession } from "../chat/loginSession";
import type { AuthService, AuthUser, SignInResult } from "./authService";
import { defaultAuthService } from "./session";

export type AuthState =
  { status: "loading" } | { status: "signedOut" } | { status: "signedIn"; user: AuthUser };

export interface AuthContextValue {
  state: AuthState;
  signIn(username: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ service, children }: { service?: AuthService; children: ReactNode }) {
  const auth = service ?? defaultAuthService();
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    const sync = () => {
      void auth.currentUser().then((user) => {
        setState(user ? { status: "signedIn", user } : { status: "signedOut" });
      });
    };
    sync();
    return auth.onChange(() => {
      clearLoginSession();
      sync();
    });
  }, [auth]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      async signIn(username, password) {
        const result = await auth.signIn(username, password);
        if (result.ok) {
          clearLoginSession();
          setState({ status: "signedIn", user: result.user });
        }
        return result;
      },
      async signOut() {
        try {
          await auth.signOut();
        } finally {
          clearLoginSession();
          setState({ status: "signedOut" });
        }
      },
    }),
    [auth, state],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (!value) throw new Error("useAuth needs an <AuthProvider> above it");
  return value;
}

/** The auth context, or `null` outside an `<AuthProvider>` (a page rendered on its own in tests). */
export function useOptionalAuth(): AuthContextValue | null {
  return use(AuthContext);
}
