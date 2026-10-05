/**
 * The web stack's SPA deep-link function (#99). `infra/` has no Vitest project, so this lives with the
 * other repo-level tests. It reads `infra/stacks/web.yaml` as text, takes `SpaDeepLinkFunction`'s inline
 * `FunctionCode` exactly as CloudFormation will publish it (no copy), runs it in a `node:vm` context and
 * checks which URIs become `/index.html`. It also checks that the function is associated with the
 * default behavior only. It proves the logic, not that CloudFront's `cloudfront-js-2.0` runtime accepts
 * the syntax: the `dev` deploy proves that.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const template = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "stacks", "web.yaml"),
  "utf8",
);
const lines = template.split("\n");

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The lines of the block that starts at the first line of `within` matching `header`: that line and
 * every following line that is blank or indented deeper than it.
 */
function block(header: RegExp, within: string[] = lines): string[] {
  const start = within.findIndex((line) => header.test(line));
  if (start === -1) throw new Error(`web.yaml: no line matches ${String(header)}`);
  const indent = indentOf(within[start] ?? "");
  const end = within.findIndex((line, i) => i > start && line.trim() !== "" && indentOf(line) <= indent);
  return within.slice(start, end === -1 ? undefined : end);
}

/**
 * The literal block scalar under SpaDeepLinkFunction's `FunctionCode: |`, dedented the way YAML reads
 * it. The search runs inside that resource's block, so another resource's `FunctionCode` can't be taken.
 */
function functionCode(): string {
  const [, ...body] = block(/^\s+FunctionCode: \|\s*$/, block(/^ {2}SpaDeepLinkFunction:$/));
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
  return body.map((l) => l.slice(indent)).join("\n") + "\n";
}

interface Request {
  method: string;
  uri: string;
  querystring: Record<string, { value: string }>;
  headers: Record<string, { value: string }>;
  cookies: Record<string, { value: string }>;
}

const handler = runInNewContext(`${functionCode()}\n;handler`, {}) as (event: {
  request: Request;
}) => Request;

function viewerRequest(uri: string): Request {
  return {
    method: "GET",
    uri,
    querystring: { code: { value: "abc" }, state: { value: "xyz" } },
    headers: { host: { value: "example.cloudfront.net" }, accept: { value: "text/html" } },
    cookies: {},
  };
}

/** The URI CloudFront forwards for a viewer request to `uri`. */
const forwarded = (uri: string): string => handler({ request: viewerRequest(uri) }).uri;

describe("SpaDeepLinkFunction (web.yaml)", () => {
  it.each([
    "/chat",
    "/login",
    "/",
    "/chat/",
    "/anything",
    "/no/such/route",
    "/a.b/chat",
    "/apis",
    "/apiary/x",
  ])("rewrites the extensionless path %s to /index.html", (uri) => {
    expect(forwarded(uri)).toBe("/index.html");
  });

  it.each([
    "/index.html",
    "/assets/index-3f2a1b.js",
    "/assets/missing.js",
    "/favicon.ico",
    "/chat/x.json",
    "/api",
    "/api/",
    "/api/chat",
    "/api/session",
  ])("passes %s through unchanged", (uri) => {
    const request = viewerRequest(uri);
    const before = structuredClone(request);
    expect(handler({ request })).toEqual(before);
  });

  it("changes only the URI: the query string, headers and method pass through as they are", () => {
    const request = viewerRequest("/login");
    const before = structuredClone(request);
    const out = handler({ request });
    expect(out).toEqual({ ...before, uri: "/index.html" });
  });
});

describe("web.yaml function association", () => {
  const defaultBehavior = block(/^ {8}DefaultCacheBehavior:$/).join("\n") + "\n";
  const cacheBehaviors = block(/^ {8}CacheBehaviors:$/).join("\n") + "\n";

  it("associates SpaDeepLinkFunction as viewer-request on the default behavior", () => {
    expect(defaultBehavior).toMatch(
      /FunctionAssociations:\n\s+- EventType: viewer-request\n\s+FunctionARN: !GetAtt SpaDeepLinkFunction\.FunctionARN\n/,
    );
  });

  it("associates no function anywhere else, so /api/* never runs it", () => {
    expect(cacheBehaviors).not.toMatch(/FunctionAssociations|SpaDeepLinkFunction/);
    expect(template.match(/FunctionAssociations:/g)).toHaveLength(1);
    expect(template.match(/!GetAtt SpaDeepLinkFunction\.FunctionARN/g)).toHaveLength(1);
  });

  it("publishes the function on the 2.0 runtime under an env-keyed name", () => {
    const fn = block(/^ {2}SpaDeepLinkFunction:$/).join("\n") + "\n";
    expect(fn).toMatch(/Type: AWS::CloudFront::Function\n/);
    expect(fn).toMatch(/Name: !Sub sched-\$\{Env\}-web-spa-deep-links\n/);
    expect(fn).toMatch(/AutoPublish: true\n/);
    expect(fn).toMatch(/Runtime: cloudfront-js-2\.0\n/);
  });
});
