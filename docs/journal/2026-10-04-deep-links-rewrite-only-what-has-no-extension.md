# 2026-10-04 — Deep links: the edge rewrites only what has no file extension, and never `/api`

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #99, PR #95 (SPEC-1 (a)), PR #132, ADR-003, ADR-007, PRD FR-001, FR-002, FR-003, FR-016

## What happened

The SPA has path routes (`/login`, `/chat`), and the Vite dev server falls back to `index.html` for any of them. The deployed site didn't: CloudFront asked S3 for an object called `chat`, S3 had none, and because CloudFront may only `GetObject`, S3 answered 403. A refresh on the chat page, or a link to it, was a broken page. Before this change, `dev` returned 403 for `GET /chat` and `GET /login`.

The web stack's comment from #7 had already ruled out the usual fix. `CustomErrorResponses` are distribution-wide, so mapping 403/404 to `index.html` would also turn the API's 401 into a 200 HTML page, and the SPA would read a signed-out request as success. So the web stack now has a CloudFront Function, `SpaDeepLinkFunction`, on the viewer-request event of the default behavior only. If the last path segment has no `.`, it sets the URI to `/index.html`; everything else passes through.

## Why we chose what we chose

- **Rewrite by "no extension in the last segment", not by an allowlist of routes.** An allowlist would have to change with every route the SPA adds. With the rule, an unknown path such as `/anything` serves the app and react-router shows `NotFoundPage`, instead of S3's 403. The cost is that a missing extensionless object would look like the app, and the build has none.
- **The last segment, not the whole URI.** `/a.b/chat` is still a route. Checking the whole URI for a dot would have passed it through to a 403.
- **`/` and `/chat/` are rewritten too.** `/` is the object `DefaultRootObject` already serves, and react-router matches `/chat/` to the `/chat` route. No redirects: only the URI changes, so the query string and the headers reach S3 as they were.
- **`/api` and `/api/...` are guarded inside the function as well.** The `/api/*` behavior never runs the function, but `/api` with no trailing slash matches the default behavior, and without the guard it would return the app with a 200. Now it gets S3's 403. The guard is `/api` exactly or the `/api/` prefix, so `/apis` is an ordinary route.
- **A unit test that runs the YAML's code, not a copy.** `scripts/web-template.test.ts` reads `infra/stacks/web.yaml` as text, takes the `FunctionCode` block scalar, and runs it with `node:vm`. Parsing the template with a YAML library would have meant a new root dependency and custom tags for `!Sub`/`!GetAtt`; indentation-aware text slicing is enough for one block. The same file checks that the only `FunctionAssociations` sits under `DefaultCacheBehavior`. It proves the logic, not that the `cloudfront-js-2.0` runtime accepts the code; the `dev` deploy proved that.
- **No ADR.** The approach was decided at #7 (the template comment) and in PR #95's SPEC-1 (a); this is that decision carried out.

## What surprised us

Breaking each piece of the function one at a time found a piece that didn't matter. The first version took the last segment as `uri.substring(uri.lastIndexOf('/') + 1)`. Dropping the `+ 1` changes the segment from `chat` to `/chat`, and no test can tell, because a slash never contains a dot. We removed it rather than keep code no test could see broken. Every other break (each `/api` operand, `||` to `&&`, the guard's `return`, `lastIndexOf` to `indexOf`, the dot test, the target URI, returning a fresh object, and the association's event type and placement) turned a test red.

## Evidence

- Before, on `dev`: `GET /chat` 403, `GET /login` 403, `GET /assets/missing.js` 403, `POST /api/chat` 401.
- After `scripts/deploy.sh web dev` and the distribution reporting `Deployed`: `GET /chat`, `/login`, `/chat/`, `/anything`, `/` and `/chat?x=1` all 200 `text/html` (the body has `<div id="root">`); a built `/assets/*.js` 200 `text/javascript`; `/assets/missing.js` 403; `/api` 403; `POST /api/chat` 401 `application/json`.
- 22 cases in `scripts/web-template.test.ts`; 17 breaks, each red (listed in the PR).

## What's next

- #36 (M3-01) can deploy the SPA for the end-to-end run and rely on refresh and direct links.
