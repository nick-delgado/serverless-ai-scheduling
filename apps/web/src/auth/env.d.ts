/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cognito user pool ID, from SSM /sched/<env>/auth/user-pool-id at build time (apps/web/README.md). */
  readonly VITE_USER_POOL_ID?: string;
  /** The SPA's app client ID, from SSM /sched/<env>/auth/spa-client-id at build time. */
  readonly VITE_SPA_CLIENT_ID?: string;
  /** Identity Pool ID, from SSM /sched/<env>/auth/identity-pool-id; optional, voice only (S6-02, #29). */
  readonly VITE_IDENTITY_POOL_ID?: string;
  /** "on" shows the "Request demo access" link and route (#357); from SSM /sched/<env>/api/request-access at build time. */
  readonly VITE_REQUEST_ACCESS?: string;
  /** The public Cloudflare Turnstile site key of the request page (#357); from TURNSTILE_SITE_KEY at build time. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /** "1" compiles in voice's stop→final timing record and its export panel (#29 r2/Q-2); never set for dev. */
  readonly VITE_VOICE_TIMING?: string;
}
