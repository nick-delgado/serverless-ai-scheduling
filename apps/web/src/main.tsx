import "./styles/global.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import { appRoutes } from "./app/routes";

/**
 * Start the MSW mock API before the first request (dev server only). `VITE_MOCK_API=off` sends
 * requests to the real `/api` instead. Production builds drop this branch and the mock code with it.
 */
async function startMockApi(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.VITE_MOCK_API === "off") return;
  const { startMockWorker } = await import("./mocks/browser");
  await startMockWorker();
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

await startMockApi();
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={createBrowserRouter(appRoutes())} />
  </StrictMode>,
);
