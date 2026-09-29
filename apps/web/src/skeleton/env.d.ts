/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** From SSM /sched/<env>/auth/user-pool-id at build time (see README.md). */
  readonly VITE_USER_POOL_ID: string;
  /** From SSM /sched/<env>/auth/spa-client-id at build time. */
  readonly VITE_SPA_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
