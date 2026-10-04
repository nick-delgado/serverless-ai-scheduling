# 2026-10-03 — The Cognito mock does real SRP, because SRP never sends the password

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #25, ADR-005, PRD FR-001, FR-002, FR-003, NFR-005; unblocks #36

## What happened

The login page (#25) needed a mock Cognito, so the app's tests and the dev server could sign in without AWS. The obvious mock checks the password the client sends. With `USER_SRP_AUTH`, the only password flow our app client allows (ADR-005), the client never sends one. Amplify sends `SRP_A`, gets back a salt, `SRP_B` and a secret block, and answers with an HMAC signature that it can only compute if it knows the password.

That leaves three choices. The mock could accept any signature, so a wrong password signs in and the "inline error" tests prove nothing. It could fake the failure with a knob, so the tests only show that the knob works. Or it could do the server half of SRP-6a. The agent building #25 took the third: about 140 lines (`apps/web/src/mocks/srp.ts`) that mirror Amplify's encoding (the 3072-bit RFC 5054 group, Java-style padded hex, HKDF with "Caldera Derived Key"). The mock now behaves like the real pool where the app depends on it: only the right password signs in, an unknown user gets a challenge and then the same `NotAuthorizedException` (PreventUserExistenceErrors), refresh uses `GetTokensFromRefreshToken`, and sign-out revokes the refresh token.

## Why we chose what we chose

- **Mock at the HTTP layer, under real Amplify**, rather than behind our own `AuthService` interface. The acceptance criteria are mostly Amplify's behaviour: session in local storage across a reload, silent refresh near expiry, tokens cleared when the refresh token is revoked. A fake service would only test our assumptions about Amplify. The interface still exists, and a fake of it drives the tests about timing and call counts.
- **Build-time config** (`VITE_USER_POOL_ID`, `VITE_SPA_CLIENT_ID`), as the walking skeleton did, rather than a runtime `config.json`. One fewer request on load. Nothing supplies the IDs yet: Nick decided in the PR #120 review that the deploy script planned in #100 must read `/sched/<env>/auth/user-pool-id` and `/sched/<env>/auth/spa-client-id` from SSM, pass them to the build, and fail before building when either is missing. The mock fallback sits behind `import.meta.env.DEV`, so production builds leave it out.
- **`/` goes to `/chat`.** The guard then sends a signed-out visitor to `/login`, so `/` is never a dead end.

## What surprised us

- **Amplify 6.22 refreshes with `GetTokensFromRefreshToken`**, not `InitiateAuth` with `REFRESH_TOKEN_AUTH`. A mock written from older docs would never have seen a refresh. The agent checked it against the real dev pool too: a forced refresh returned a new ID token.
- **The mock had a case bug, and a test found it.** The real pool is case-insensitive, so the agent added a test that signs in as `Maria.Santos`. It failed. The mock computed the SRP verifier from the username as typed, but Amplify signs with `USER_ID_FOR_SRP`, the canonical name the mock returned. Real Cognito would have accepted that sign-in.
- **`getCurrentUser()` isn't local-only.** It refreshes expired tokens first, so a transient error at page load can make a stored session look signed out. Amplify then refuses a new `signIn` with `UserAlreadyAuthenticatedException`. The service handles this by signing out and retrying once.

## Evidence

- `apps/web/src/auth/authService.test.ts`, `src/pages/LoginPage.test.tsx`, `src/auth/session.test.ts`: real Amplify against the mock, including refresh, revocation and reload.
- Real dev pool, signed in once headlessly through `createAmplifyAuthService` as the seeded demo patient: a wrong password and an unknown user both returned `credentials`, the right password signed in, `getIdToken` returned an ID token, a forced refresh returned a new one, and after sign-out both the token and the user were `undefined`.
- Bundle: 410 KB (125 KB gzip) before, 544 KB (164 KB gzip) with Amplify Auth.

## What's next

- #36 wires `getIdToken` into the chat client; #100's `deploy-web.sh` builds the SPA with the pool IDs from SSM.
- #28 (voice) adds the Identity Pool to the same `Amplify.configure` call for Transcribe credentials.
