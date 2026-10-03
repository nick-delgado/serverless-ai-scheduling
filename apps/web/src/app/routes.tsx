import { Navigate, type RouteObject } from "react-router";

import { AuthProvider } from "../auth/AuthProvider";
import type { AuthService } from "../auth/authService";
import { RequireAuth } from "../auth/RequireAuth";
import { ChatPage } from "../chat/ChatPage";
import { LoginPage } from "../pages/LoginPage";
import { ErrorPage } from "./ErrorPage";
import { Layout } from "./Layout";
import { NotFoundPage } from "./NotFoundPage";

/**
 * The pages under the layout. /chat needs a signed-in patient (FR-003). "/" goes to /chat, so a
 * signed-in patient lands in the chat and everyone else ends up on /login via the guard.
 */
export const pageRoutes: RouteObject[] = [
  { index: true, element: <Navigate to="/chat" replace /> },
  { path: "login", element: <LoginPage /> },
  { element: <RequireAuth />, children: [{ path: "chat", element: <ChatPage /> }] },
  { path: "*", element: <NotFoundPage /> },
];

/**
 * The route tree. The error boundary sits on a pathless route inside the layout, so a page that
 * throws still renders with the header and disclaimer. Auth state wraps everything; tests can pass
 * their own `AuthService`.
 */
export function appRoutes(pages: RouteObject[] = pageRoutes, auth?: AuthService): RouteObject[] {
  return [
    {
      element: (
        <AuthProvider service={auth}>
          <Layout />
        </AuthProvider>
      ),
      children: [{ errorElement: <ErrorPage />, children: pages }],
    },
  ];
}
