import { Link } from "react-router";

import { pageTitle } from "../app/pageTitle";

/** Placeholder until the login page lands (S1-02, #25). */
export function LoginPage() {
  return (
    <div className="page">
      <title>{pageTitle("Sign in")}</title>
      <h1>Sign in</h1>
      <p className="muted">The sign-in form arrives with #25.</p>
      <p>
        <Link to="/chat">Continue to the chat</Link>
      </p>
    </div>
  );
}
