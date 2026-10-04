/**
 * The chat page's state: the greeting, the messages, the turn in progress, and the error, if any.
 *
 * A turn runs from send until its reply has been fully typed out:
 * - `waiting` is true from send until the first `text_delta` arrives (FR-012: the typing indicator
 *   starts on send, because the API's headers only come with its first event, ADR-007);
 * - `status` events become tool-status chips for the rest of the turn;
 * - `text_delta` / `text_reset` go through the typewriter (FR-013); `done` lets it finish;
 * - when the typewriter has revealed everything, the reply joins the messages and is announced once
 *   through the live region (not per character).
 *
 * Errors (FR-015, #27) end the turn with `error` set; the patient's message stays in the list.
 * - Retry is offered only for a stream `error` event with `retryable: true`, or a network failure
 *   (anything `fetch` or the reader throws that isn't a `ChatHttpError` or `ChatProtocolError`). It
 *   resends the same text with the same `clientMessageId` and `conversationId`, without adding the
 *   message again. Any other error shows its message without Retry (the daily cap's front-desk number).
 * - A 401 (the session call's or a turn's) means the sign-in has ended: `onUnauthorized` is called,
 *   which signs the patient out and so routes to sign-in.
 *
 * Restore (FR-014, #27): on load, `POST /api/session`'s conversation is shown only if it is the one
 * this login session has been using (`loginSession.ts`); otherwise the chat starts empty and the next
 * turn starts a new conversation. A failed session call shows the fallback greeting with an error and
 * Retry (a 401 instead routes to sign-in, as above).
 */
import { CLINIC, type ChatStreamEvent, type ToolName } from "@sched/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { type ChatApi, ChatHttpError } from "./api";
import { conversationToRestore, readLoginSession, writeLoginSession } from "./loginSession";
import { ChatProtocolError } from "./streamClient";
import { Typewriter } from "./typewriter";

export interface ChatMessage {
  id: string;
  role: "patient" | "assistant";
  text: string;
}

export interface ToolChip {
  tool: ToolName;
  label: string;
}

export interface ChatTurn {
  /** The assistant text revealed so far. */
  text: string;
  /** True until the first `text_delta` (and again if a `text_reset` drops every character). */
  waiting: boolean;
  /** One chip per `status` event, in order; a repeat of the latest label is not added again. */
  chips: ToolChip[];
}

export type Greeting = { state: "loading" } | { state: "ready"; text: string };

export interface ChatError {
  message: string;
  /** Whether `retry` will try again: the failed turn, or the session call. */
  retryable: boolean;
}

/** Shown when the session call fails, so the page still opens with a greeting. */
export const FALLBACK_GREETING = `Hi! I'm the ${CLINIC.name} scheduling assistant. How can I help today?`;

/** Shown when a turn fails without a message of its own (network, a broken stream, an HTTP error). */
export const GENERIC_ERROR = "Something went wrong. Please try again.";

/** Shown when the session call fails (other than a 401). */
export const SESSION_ERROR = "We couldn't load your conversation. You can try again, or send a message.";

/** Shown on a 401: the sign-in has ended. */
export const SIGNED_OUT_ERROR = "Your sign-in has ended. Please sign in again.";

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface UseChatOptions {
  /** Read at the start of each turn. Defaults to the `prefers-reduced-motion` media query. */
  reducedMotion?: () => boolean;
  /**
   * The signed-in patient's Cognito `sub`, for the login-session rule. Without it no conversation is
   * restored and none is remembered.
   */
  sub?: string;
  /** Called when the API answers 401: the sign-in has ended. */
  onUnauthorized?: () => void;
}

/** What Retry repeats: a failed turn (its message is already in the list), or the session call. */
type RetryTarget = { kind: "turn"; text: string; clientMessageId: string } | { kind: "session" };

function isUnauthorized(error: unknown): boolean {
  return error instanceof ChatHttpError && error.status === 401;
}

/** A network failure: what `fetch` or the reader throws, as opposed to an answer the API gave. */
function isNetworkFailure(error: unknown): boolean {
  return !(error instanceof ChatHttpError) && !(error instanceof ChatProtocolError);
}

export function useChat(api: ChatApi, options: UseChatOptions = {}) {
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion;
  const [greeting, setGreeting] = useState<Greeting>({ state: "loading" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [turn, setTurn] = useState<ChatTurn | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  /** The latest completed message, for the polite live region. */
  const [announcement, setAnnouncement] = useState("");
  /** Bumped by a session Retry, which runs the session effect again. */
  const [sessionAttempt, setSessionAttempt] = useState(0);

  const conversationId = useRef<string | undefined>(undefined);
  const active = useRef<{ controller: AbortController; typewriter: Typewriter } | null>(null);
  /** What Retry does for the current error; `null` when there is nothing to retry. */
  const retryTarget = useRef<RetryTarget | null>(null);
  /** Set by the first send: a session answered after it must not restore over the new turn. */
  const sent = useRef(false);

  // Read when a call settles, not when it starts, so the latest values apply.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const showError = useCallback((message: string, retry: RetryTarget | null) => {
    retryTarget.current = retry;
    setError({ message, retryable: retry !== null });
  }, []);

  const clearError = useCallback(() => {
    retryTarget.current = null;
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.getSession(controller.signal).then(
      (session) => {
        setGreeting({ state: "ready", text: session.greeting });
        setAnnouncement(session.greeting);
        if (sent.current) return;
        const restore = conversationToRestore(session.conversationId, latest.current.sub, readLoginSession());
        if (restore === undefined) return;
        conversationId.current = restore;
        setMessages(session.messages.map(({ id, role, text }) => ({ id, role, text })));
      },
      (failure: unknown) => {
        // An aborted call (unmount, or React's strict-mode remount) must not overwrite the greeting.
        if (controller.signal.aborted) return;
        setGreeting({ state: "ready", text: FALLBACK_GREETING });
        setAnnouncement(FALLBACK_GREETING);
        // A send since then has started a conversation of its own: there's nothing left to load.
        if (sent.current) return;
        if (isUnauthorized(failure)) {
          showError(SIGNED_OUT_ERROR, null);
          latest.current.onUnauthorized?.();
          return;
        }
        showError(SESSION_ERROR, { kind: "session" });
      },
    );
    return () => controller.abort();
  }, [api, sessionAttempt, showError]);

  // Unmounting stops the turn: no more fetch, no more typing.
  useEffect(
    () => () => {
      active.current?.controller.abort();
      active.current?.typewriter.dispose();
    },
    [],
  );

  /** Run one turn for a message already in the list. Retry calls it again with the same arguments. */
  const runTurn = useCallback(
    (text: string, clientMessageId: string) => {
      const controller = new AbortController();
      // Set by `done`, which is the only way a turn completes.
      let messageId = "";
      let doneReceived = false;
      let ended = false;

      // `end` runs once per turn. A transport error after `done` (the connection drops, or the stream
      // sends more) must not turn the reply into an error, whether or not it has finished typing: the
      // server stored it, and the typewriter finishes it.
      const end = () => {
        ended = true;
        typewriter.dispose();
        active.current = null;
        setTurn(null);
      };
      const failTurn = (message: string, retryable: boolean) => {
        if (ended) return;
        end();
        showError(message, retryable ? { kind: "turn", text, clientMessageId } : null);
      };

      const typewriter = new Typewriter({
        instant: reducedMotion(),
        onUpdate: (shown) => setTurn((t) => (t ? { ...t, text: shown } : t)),
        onComplete: (final) => {
          end();
          setMessages((list) => [...list, { id: messageId, role: "assistant", text: final }]);
          setAnnouncement(final);
        },
      });
      active.current = { controller, typewriter };

      const onEvent = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "status":
            setTurn((t) => {
              if (!t) return t;
              const last = t.chips[t.chips.length - 1];
              if (last?.label === event.label) return t;
              return { ...t, chips: [...t.chips, { tool: event.tool, label: event.label }] };
            });
            break;
          case "text_delta":
            typewriter.append(event.text);
            setTurn((t) => (t ? { ...t, waiting: false } : t));
            break;
          case "text_reset":
            typewriter.reset(event.keepChars);
            if (typewriter.received.length === 0) setTurn((t) => (t ? { ...t, waiting: true } : t));
            break;
          case "done": {
            conversationId.current = event.conversationId;
            const { sub } = latest.current;
            if (sub !== undefined) writeLoginSession({ sub, conversationId: event.conversationId });
            messageId = event.messageId;
            doneReceived = true;
            typewriter.finish();
            break;
          }
          case "error":
            failTurn(event.message, event.retryable);
            break;
        }
      };

      clearError();
      // Empty the live region, so a reply equal to the last announcement is still a change to announce.
      setAnnouncement("");
      setTurn({ text: "", waiting: true, chips: [] });

      api
        .sendChat(
          { conversationId: conversationId.current, clientMessageId, text },
          onEvent,
          controller.signal,
        )
        .catch((failure: unknown) => {
          if (doneReceived) return;
          if (isUnauthorized(failure)) {
            failTurn(SIGNED_OUT_ERROR, false);
            latest.current.onUnauthorized?.();
            return;
          }
          failTurn(GENERIC_ERROR, isNetworkFailure(failure));
        });
    },
    [api, reducedMotion, showError, clearError],
  );

  const send = useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      if (text.length === 0 || active.current) return false;
      const clientMessageId = crypto.randomUUID();
      sent.current = true;
      setMessages((list) => [...list, { id: clientMessageId, role: "patient", text }]);
      runTurn(text, clientMessageId);
      return true;
    },
    [runTurn],
  );

  /** Retry what failed: the last turn (same text, `clientMessageId` and conversation) or the session call. */
  const retry = useCallback(() => {
    const target = retryTarget.current;
    // Nothing to retry, or a second call before the first re-rendered (it cleared the target).
    if (!target) return;
    if (target.kind === "turn") {
      runTurn(target.text, target.clientMessageId);
      return;
    }
    clearError();
    setGreeting({ state: "loading" });
    setSessionAttempt((n) => n + 1);
  }, [runTurn, clearError]);

  return { greeting, messages, turn, error, announcement, responding: turn !== null, send, retry };
}
