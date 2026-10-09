/** Test helpers for components that use auth: a controllable `AuthService`. */
import { vi } from "vitest";

import type { AuthService, AuthUser, AwsCredentials, SignInResult } from "./authService";

export interface FakeAuthService extends AuthService {
  /** Fire the service's change event, as Amplify's Hub does after a failed refresh. */
  emitChange(): void;
  user: AuthUser | undefined;
}

/** Synthetic Identity Pool credentials the fake returns while signed in (not a real key). */
export const FAKE_AWS_CREDENTIALS: AwsCredentials = {
  accessKeyId: "ASIAFAKEFAKEFAKEFAKE",
  secretAccessKey: "fake-secret-access-key",
  sessionToken: "fake-session-token",
};

/** A synthetic `sub` for a username, when a test doesn't give one. */
export function fakeSub(username: string): string {
  return `sub-${username}`;
}

/**
 * Starts signed out (or as `user`, with `fakeSub(username)` unless it gives a `sub`). `signIn`
 * succeeds for any username unless the test replaces it, e.g. with a promise it settles itself.
 */
export function fakeAuthService(user?: { username: string; sub?: string }): FakeAuthService {
  const listeners = new Set<() => void>();
  const fake: FakeAuthService = {
    user: user && { username: user.username, sub: user.sub ?? fakeSub(user.username) },
    currentUser: vi.fn(() => Promise.resolve(fake.user)),
    signIn: vi.fn((username: string): Promise<SignInResult> => {
      fake.user = { username, sub: fakeSub(username) };
      return Promise.resolve({ ok: true, user: fake.user });
    }),
    signOut: vi.fn(() => {
      fake.user = undefined;
      return Promise.resolve();
    }),
    getIdToken: vi.fn(() => Promise.resolve(fake.user ? "fake-id-token" : undefined)),
    getAwsCredentials: vi.fn(() => Promise.resolve(fake.user ? FAKE_AWS_CREDENTIALS : undefined)),
    onChange: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emitChange: () => listeners.forEach((listener) => listener()),
  };
  return fake;
}
