/**
 * The Cloudflare Turnstile widget (#357, owner decision r1/Q-1 (a)). It loads Cloudflare's script on first use and
 * renders the widget with the build's public site key; the token it produces goes to `onToken`, and `undefined`
 * means there is no valid token (expired, errored, or spent and reset). Cloudflare sees the visitor's IP address,
 * TLS fingerprint and User-Agent from this widget (ADR-009's amendment).
 */
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/** Loads the script once; rejects when it can't be loaded, and lets the next mount try again. */
function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("The bot check did not start."));
    };
    script.onerror = () => reject(new Error("The bot check could not be loaded."));
    document.head.append(script);
  }).catch((error: Error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

export interface TurnstileHandle {
  /** Asks for a fresh token: a token works once. */
  reset(): void;
}

export interface TurnstileProps {
  siteKey: string;
  onToken: (token: string | undefined) => void;
  /** The widget couldn't load. */
  onUnavailable: () => void;
  ref?: Ref<TurnstileHandle>;
}

export function Turnstile({ siteKey, onToken, onUnavailable, ref }: TurnstileProps) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | undefined>(undefined);
  const callbacks = useRef({ onToken, onUnavailable });
  // After each render, so the widget's callbacks (set once, in the effect below) always call the latest props.
  useEffect(() => {
    callbacks.current = { onToken, onUnavailable };
  });

  useImperativeHandle(ref, () => ({
    reset() {
      callbacks.current.onToken(undefined);
      if (widget.current) widget.current.api.reset(widget.current.id);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(
      (api) => {
        if (cancelled || !container.current) return;
        const id = api.render(container.current, {
          sitekey: siteKey,
          callback: (token) => callbacks.current.onToken(token),
          "expired-callback": () => callbacks.current.onToken(undefined),
          "error-callback": () => callbacks.current.onToken(undefined),
        });
        widget.current = { api, id };
      },
      () => {
        if (!cancelled) callbacks.current.onUnavailable();
      },
    );
    return () => {
      cancelled = true;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = undefined;
    };
  }, [siteKey]);

  return <div ref={container} className="access__widget" />;
}
