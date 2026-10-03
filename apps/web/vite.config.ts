/**
 * The SPA's build, dev server and Vitest project (S5-01, #24).
 *
 * - `npm run build -w apps/web` writes static assets to `apps/web/dist/`: `index.html` plus hashed files
 *   under `assets/`, the layout the web stack's bucket expects (`infra/stacks/web.yaml`).
 * - `npm run dev -w apps/web` serves the app with the MSW mock API (src/mocks). The worker script is
 *   served by the dev server only, so it never reaches a production bundle.
 */
import react from "@vitejs/plugin-react";
import { msw } from "msw/vite";
import { defineConfig } from "vitest/config";

const here = decodeURIComponent(new URL(".", import.meta.url).pathname);

export default defineConfig({
  root: here,
  base: "/",
  plugins: [react(), { ...msw({ mode: "worker-only" }), apply: "serve" }],
  build: {
    outDir: `${here}dist`,
    emptyOutDir: true,
    target: "es2023",
  },
  test: {
    name: "@sched/web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: { include: [/tokens\.css/] },
  },
});
