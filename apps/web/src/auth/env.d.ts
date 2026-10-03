/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cognito user pool ID, from SSM /sched/<env>/auth/user-pool-id at build time (apps/web/README.md). */
  readonly VITE_USER_POOL_ID?: string;
  /** The SPA's app client ID, from SSM /sched/<env>/auth/spa-client-id at build time. */
  readonly VITE_SPA_CLIENT_ID?: string;
}
