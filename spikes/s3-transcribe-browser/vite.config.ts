/**
 * The S-3 page's dev server and build (#10). Local-only: nothing here is ever deployed (AC1).
 *
 * - HTTPS always (getUserMedia and AudioWorklet need a secure context, r1/Q-3 (a)). The certificate
 *   is `@vitejs/plugin-basic-ssl`'s self-signed one, or `SPIKE_TLS_CERT` / `SPIKE_TLS_KEY` (paths
 *   outside the repo, e.g. from mkcert) when both are set.
 * - Listens on the LAN only with `SPIKE_LAN=1` (r1/Q-3 edges: only while a run is in progress).
 * - `POST /__results?name=raw-….json` (dev server only) writes an export from a phone into
 *   `results/`, redacted again with the exact IDs from `.env.local`.
 * - `vite build` writes `dist/` with a manifest, which `bundle-size.ts` reads (r1/A-3).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig, loadEnv, type Plugin } from "vite";

import { redact } from "./src/redact.ts";

const here = decodeURIComponent(new URL(".", import.meta.url).pathname);

function resultsEndpoint(known: string[]): Plugin {
  return {
    name: "s3-results-endpoint",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__results", (req, res) => {
        const name = basename(new URL(req.url ?? "", "https://x").searchParams.get("name") ?? "");
        if (req.method !== "POST" || !/^raw-[a-z-]+-[\dTZ-]+\.json$/.test(name)) {
          res.statusCode = 400;
          res.end("POST /__results?name=raw-<browser>-<timestamp>.json");
          return;
        }
        const parts: Buffer[] = [];
        req.on("data", (part: Buffer) => parts.push(part));
        req.on("end", () => {
          try {
            const body = redact(Buffer.concat(parts).toString("utf8"), known);
            JSON.parse(body);
            const file = join(here, "results", name);
            writeFileSync(file, `${body}\n`);
            res.end(`results/${name}`);
          } catch (error) {
            res.statusCode = 400;
            res.end(String(error));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, "VITE_");
  const known = [env.VITE_USER_POOL_ID, env.VITE_SPA_CLIENT_ID, env.VITE_IDENTITY_POOL_ID].filter(
    (v): v is string => Boolean(v),
  );
  const cert = process.env.SPIKE_TLS_CERT;
  const key = process.env.SPIKE_TLS_KEY;
  const customTls = Boolean(cert && key);
  return {
    root: here,
    envDir: here,
    plugins: [...(customTls ? [] : [basicSsl({ name: "s3-transcribe-spike" })]), resultsEndpoint(known)],
    server: {
      host: process.env.SPIKE_LAN === "1" ? "0.0.0.0" : "localhost",
      port: 5175,
      strictPort: true,
      ...(customTls && cert && key ? { https: { cert: readFileSync(cert), key: readFileSync(key) } } : {}),
    },
    preview: { host: "localhost", port: 5176, strictPort: true },
    build: {
      outDir: `${here}dist`,
      emptyOutDir: true,
      target: "es2022",
      manifest: true,
    },
  };
});
