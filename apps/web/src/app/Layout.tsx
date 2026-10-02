import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";

import { DisclaimerBanner } from "./DisclaimerBanner";

/**
 * The shell every route renders inside: skip link, header (disclaimer + clinic name), and a <main>
 * that scrolls on its own so the header stays in view (pages that need a fixed composer, like chat,
 * can fill it with a flex column).
 */
export function Layout() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);

  // A client-side navigation doesn't move focus or announce anything, so move focus to <main>
  // (WCAG 2.4.3). Skip the first render: on page load the browser's own focus handling is right.
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    mainRef.current?.focus();
  }, [pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        <DisclaimerBanner />
        <div className="app-brand">
          <span className="app-brand__name">Cedar Ridge Health</span>
          <span className="app-brand__tagline">Scheduling assistant</span>
        </div>
      </header>
      <main id="main" className="app-main" ref={mainRef} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
