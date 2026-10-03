import { Navigate, Outlet } from "react-router";

import { useAuth } from "./AuthProvider";

/**
 * A layout route for pages that need a signed-in patient (FR-003): signed-out visitors go to
 * /login. While the stored session is read, it shows a status instead of either.
 */
export function RequireAuth() {
  const { state } = useAuth();
  if (state.status === "loading") return <SessionCheck />;
  if (state.status === "signedOut") return <Navigate to="/login" replace />;
  return <Outlet />;
}

export function SessionCheck() {
  return (
    <p className="page muted" role="status">
      Checking your session…
    </p>
  );
}
