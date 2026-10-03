import "./LoginPage.css";

import { CLINIC } from "@sched/contracts";
import { type FormEvent, useId, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router";

import { pageTitle } from "../app/pageTitle";
import { useAuth } from "../auth/AuthProvider";
import { SessionCheck } from "../auth/RequireAuth";
import type { SignInResult } from "../auth/authService";

/** Inline errors. None of them says whether the username exists (FR-001). */
export const LOGIN_ERRORS = {
  empty: "Enter your username and password.",
  credentials: "The username or password is incorrect.",
  unsupported: "This account can't sign in here yet. Please contact the clinic.",
  unavailable: "We couldn't sign you in right now. Please try again in a moment.",
} as const satisfies Record<"empty" | Extract<SignInResult, { ok: false }>["reason"], string>;

/**
 * The patient's sign-in page (FR-001): a plain form, so Enter submits from either field. No
 * self-sign-up link (patients are created by the clinic). Signed-in visitors go straight to /chat.
 */
export function LoginPage() {
  const { state, signIn } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const errorId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);

  if (state.status === "loading") return <SessionCheck />;
  if (state.status === "signedIn") return <Navigate to="/chat" replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username")).trim();
    const password = String(data.get("password"));
    if (!username || !password) {
      setError(LOGIN_ERRORS.empty);
      return;
    }
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await signIn(username, password);
      if (result.ok) {
        void navigate("/chat", { replace: true });
        return;
      }
      setError(LOGIN_ERRORS[result.reason]);
      passwordRef.current?.select();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const describedBy = error ? errorId : undefined;
  return (
    <div className="page login">
      <title>{pageTitle("Sign in")}</title>
      <h1>Sign in</h1>
      <p className="muted">Sign in to chat with the {CLINIC.name} scheduling assistant.</p>
      <form className="login__form" onSubmit={(event) => void onSubmit(event)} aria-busy={pending} noValidate>
        <div className="login__field">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
        </div>
        <div className="login__field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            ref={passwordRef}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
        </div>
        <p id={errorId} className="login__error" role="alert">
          {error}
        </p>
        <button type="submit" className="login__submit" aria-disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
