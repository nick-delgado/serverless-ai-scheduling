import "./RequestAccessPage.css";

import { CLINIC } from "@sched/contracts";
import { useRef, useState } from "react";
import { Link } from "react-router";

import { pageTitle } from "../app/pageTitle";
import { turnstileSiteKey, usesMockBotCheck } from "../access/config";
import { MOCK_BOT_CHECK_TOKEN } from "../mocks/cognitoUsers";
import { type AccessResult, requestAccess } from "../access/api";
import { Turnstile, type TurnstileHandle } from "../access/Turnstile";

/** The project README on GitHub, where Nick's contact details are (A-11). */
export const README_URL = "https://github.com/nick-delgado/serverless-ai-scheduling#readme";

type Account = Extract<AccessResult, { ok: true }>["account"];
type Failure = Extract<AccessResult, { ok: false }>;

export const UNAVAILABLE_MESSAGE = "The bot check could not be loaded. Please reload the page and try again.";

/** The expiry in the clinic's time zone, for example `Oct 21, 2026, 10:00 AM EDT`. */
export function formatExpiry(expiresAt: string): string {
  return new Date(expiresAt).toLocaleString("en-US", {
    timeZone: CLINIC.timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * "Request demo access" (#357, FR-001): one button and a bot check. It asks for nothing about the reviewer. The
 * sign-in details come back once and live in this component's state only, never in storage (A-8): a reload shows the
 * button again. The page doesn't sign the reviewer in; it links to /login.
 */
export function RequestAccessPage() {
  const env = import.meta.env;
  const siteKey = turnstileSiteKey(env);
  const mock = usesMockBotCheck(env);
  const [token, setToken] = useState<string | undefined>(mock ? MOCK_BOT_CHECK_TOKEN : undefined);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [account, setAccount] = useState<Account>();
  const [failure, setFailure] = useState<Failure>();
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);
  const widget = useRef<TurnstileHandle>(null);

  async function onRequest() {
    if (busy.current || token === undefined) return;
    busy.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      const result = await requestAccess(token);
      if (result.ok) {
        setAccount(result.account);
      } else {
        setFailure(result);
      }
    } finally {
      // A bot-check token works once, so the next try needs a fresh one.
      if (!mock) widget.current?.reset();
      busy.current = false;
      setPending(false);
    }
  }

  async function onCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (account) {
    return (
      <div className="page access">
        <title>{pageTitle("Your demo account")}</title>
        <h1>Your demo account</h1>
        <p className="muted">
          This is a made-up patient at {CLINIC.name}, created just for you. The password is shown once, so
          copy it now.
        </p>
        <dl className="access__details">
          <dt>Username</dt>
          <dd>
            <code>{account.username}</code>
          </dd>
          <dt>Password</dt>
          <dd>
            <code>{account.password}</code>
          </dd>
          <dt>Patient name</dt>
          <dd>
            {account.firstName} {account.lastName}
          </dd>
        </dl>
        <p className="muted">This account is due to expire on {formatExpiry(account.expiresAt)}.</p>
        <div className="access__actions">
          <button
            type="button"
            className="access__button"
            onClick={() => void onCopy(`Username: ${account.username}\nPassword: ${account.password}`)}
          >
            Copy username and password
          </button>
          <Link to="/login" className="access__link">
            Go to sign in
          </Link>
        </div>
        <p role="status" className="access__status">
          {copied ? "Copied." : ""}
        </p>
      </div>
    );
  }

  const unavailable = widgetFailed || (!mock && siteKey === undefined);
  const message = failure?.message ?? (unavailable ? UNAVAILABLE_MESSAGE : undefined);
  return (
    <div className="page access">
      <title>{pageTitle("Request demo access")}</title>
      <h1>Request demo access</h1>
      <p className="muted">
        Get a temporary demo patient for the {CLINIC.name} scheduling assistant. It takes one click and a
        quick check that you're a person. We don't ask for your name, email or anything else about you.
      </p>
      {siteKey !== undefined && !widgetFailed && (
        <Turnstile
          siteKey={siteKey}
          ref={widget}
          onToken={setToken}
          onUnavailable={() => setWidgetFailed(true)}
        />
      )}
      <p role="alert" className="access__error">
        {message}
      </p>
      {failure?.kind === "capped" && (
        <p>
          <a href={README_URL} className="access__link">
            Open the project README
          </a>
        </p>
      )}
      <div className="access__actions">
        <button
          type="button"
          className="access__button"
          disabled={token === undefined || failure?.kind === "capped"}
          aria-busy={pending}
          onClick={() => void onRequest()}
        >
          {pending ? "Creating your account…" : "Request demo access"}
        </button>
        <Link to="/login" className="access__link">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
