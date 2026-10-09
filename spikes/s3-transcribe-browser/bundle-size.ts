/**
 * Bundle size of the lazy Transcribe client (r1/A-3, AC3). Reads `dist/.vite/manifest.json` from
 * `vite build` and sums the chunks that `import("@aws-sdk/client-transcribe-streaming")` loads
 * (its chunk and every chunk it statically imports, recursively) minus what the entry chunk already
 * loads. Sizes are minified bytes and gzip (zlib level 9) bytes.
 *
 *   npm run bundle-size -w spikes/s3-transcribe-browser
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

interface Chunk {
  file: string;
  imports?: string[];
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  assets?: string[];
}

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8")) as Record<
  string,
  Chunk
>;

function closure(key: string, seen = new Set<string>()): Set<string> {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const dep of manifest[key]?.imports ?? []) closure(dep, seen);
  return seen;
}

function size(file: string): { min: number; gzip: number } {
  const bytes = readFileSync(join(dist, file));
  return { min: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}

const entryKey = Object.keys(manifest).find((k) => manifest[k]?.isEntry);
const lazyKey = Object.keys(manifest).find(
  (k) => k.includes("client-transcribe-streaming/") && manifest[k]?.isDynamicEntry,
);
if (!entryKey || !lazyKey)
  throw new Error("entry or the client-transcribe-streaming dynamic entry is missing from the manifest");

const entry = closure(entryKey);
const added = [...closure(lazyKey)].filter((k) => !entry.has(k));
const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const row = (label: string, s: { min: number; gzip: number }) =>
  `  ${label.padEnd(40)} ${kb(s.min).padStart(10)} min ${kb(s.gzip).padStart(10)} gzip`;
let min = 0;
let gzip = 0;
console.log("Chunks the dynamic import of @aws-sdk/client-transcribe-streaming adds:");
for (const key of added) {
  const file = manifest[key]?.file ?? key;
  const s = size(file);
  min += s.min;
  gzip += s.gzip;
  console.log(row(file, s));
}
console.log(`${row("total", { min, gzip })} (${min} / ${gzip} bytes)`);
console.log("Entry chunk(s), loaded before any mic use (aws-amplify sign-in and the page):");
for (const key of entry) {
  const file = manifest[key]?.file ?? key;
  console.log(row(file, size(file)));
}
for (const asset of manifest[entryKey]?.assets ?? []) {
  console.log(row(`${asset} (worklet asset)`, size(asset)));
}
