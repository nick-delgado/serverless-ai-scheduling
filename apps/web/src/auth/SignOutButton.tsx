import "./SignOutButton.css";

import { useState } from "react";
import { useNavigate } from "react-router";

import { useAuth } from "./AuthProvider";

/** The header's sign-out control (FR-002), shown only to a signed-in patient. Ends on /login. */
export function SignOutButton() {
  const { state, signOut } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  if (state.status !== "signedIn") return null;

  async function onClick() {
    if (pending) return;
    setPending(true);
    try {
      await signOut();
    } catch (error) {
      // The local session is cleared either way (AuthProvider); only revoking it remotely failed.
      console.error("Sign-out failed", error);
    }
    setPending(false);
    void navigate("/login", { replace: true });
  }

  return (
    <button type="button" className="sign-out" aria-disabled={pending} onClick={() => void onClick()}>
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
