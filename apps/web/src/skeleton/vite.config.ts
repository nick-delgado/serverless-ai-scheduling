/**
 * Build config for the throwaway walking-skeleton page (#7). Run from anywhere:
 *   npx vite build --config apps/web/src/skeleton/vite.config.ts
 * Output: apps/web/dist/skeleton/ (git-ignored). The real SPA (S5-01, #24) gets its own config.
 */
import { defineConfig } from "vite";

const here = decodeURIComponent(new URL(".", import.meta.url).pathname);

export default defineConfig({
  root: here,
  base: "/",
  // amazon-cognito-identity-js pulls in buffer@4, which reads a Node-style `global`.
  define: { global: "globalThis" },
  build: {
    outDir: `${here}../../dist/skeleton`,
    emptyOutDir: true,
    target: "es2023",
  },
});
