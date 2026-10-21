/**
 * Build-time settings of the reviewer access page (#357). `scripts/deploy-web.sh` sets them from SSM
 * `/sched/<env>/api/request-access` and the git-ignored `TURNSTILE_SITE_KEY`; a build without them has the page off.
 */

export interface AccessEnv {
  VITE_REQUEST_ACCESS?: string;
  VITE_TURNSTILE_SITE_KEY?: string;
  VITE_MOCK_API?: string;
  DEV?: boolean;
}

/** Whether this build shows the "Request demo access" link and route: exactly `on`. */
export function requestAccessEnabled(env: AccessEnv): boolean {
  return env.VITE_REQUEST_ACCESS?.trim() === "on";
}

/** The public Turnstile site key, or undefined when the build has none. */
export function turnstileSiteKey(env: AccessEnv): string | undefined {
  return env.VITE_TURNSTILE_SITE_KEY?.trim() || undefined;
}

/**
 * Whether the page may run without a widget: the dev server with no site key and the mock API on (as
 * `src/auth/session.ts` reads it), where the mock API accepts a fixed token. A production build without a site key shows the page as unavailable instead.
 */
export function usesMockBotCheck(env: AccessEnv): boolean {
  return env.DEV === true && env.VITE_MOCK_API !== "off" && turnstileSiteKey(env) === undefined;
}
