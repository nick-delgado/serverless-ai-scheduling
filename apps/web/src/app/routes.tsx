import { Navigate, type RouteObject } from "react-router";

import { ChatPage } from "../chat/ChatPage";
import { LoginPage } from "../pages/LoginPage";
import { ErrorPage } from "./ErrorPage";
import { Layout } from "./Layout";
import { NotFoundPage } from "./NotFoundPage";

/**
 * The pages under the layout. #25 wraps /chat in its auth guard and decides where "/" goes once
 * there is a session; until then "/" goes to the login placeholder.
 */
export const pageRoutes: RouteObject[] = [
  { index: true, element: <Navigate to="/login" replace /> },
  { path: "login", element: <LoginPage /> },
  { path: "chat", element: <ChatPage /> },
  { path: "*", element: <NotFoundPage /> },
];

/**
 * The route tree. The error boundary sits on a pathless route inside the layout, so a page that
 * throws still renders with the header and disclaimer.
 */
export function appRoutes(pages: RouteObject[] = pageRoutes): RouteObject[] {
  return [{ element: <Layout />, children: [{ errorElement: <ErrorPage />, children: pages }] }];
}
