/**
 * The chat page's state: the greeting, the messages, and the turn in progress.
 *
 * A turn runs from send until its reply has been fully typed out:
 * - `waiting` is true from send until the first `text_delta` arrives (FR-012: the typing indicator
 *   starts on send, because the API's headers only come with its first event, ADR-007);
 * - `status` events become tool-status chips for the rest of the turn;
 * - `text_delta` / `text_reset` go through the typewriter (FR-013); `done` lets it finish;
 * - when the typewriter has revealed everything, the reply joins the messages and is announced once
 *   through the live region (not per character).
 *
 * Errors end the turn with `error` set. The retry bubble, keeping the failed message and restoring the
 * conversation are #27; `failTurn` and the `ChatHttpError` / `ChatProtocolError` types are its seams.
 */
import { CLINIC, type ChatStreamEvent, type ToolName } from "@sched/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatApi } from "./api";
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

/** Shown when the session call fails, so the page still opens with a greeting. */
export const FALLBACK_GREETING = `Hi! I'm the ${CLINIC.name} scheduling assistant. How can I help today?`;

/** Shown when a turn fails without a message of its own (network, 401, a broken stream). */
export const GENERIC_ERROR = "Something went wrong. Please try again.";

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export interface UseChatOptions {
  /** Read at the start of each turn. Defaults to the `prefers-reduced-motion` media query. */
  reducedMotion?: () => boolean;
}

export function useChat(api: ChatApi, options: UseChatOptions = {}) {
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion;
  const [greeting, setGreeting] = useState<Greeting>({ state: "loading" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [turn, setTurn] = useState<ChatTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The latest completed message, for the polite live region. */
  const [announcement, setAnnouncement] = useState("");

  const conversationId = useRef<string | undefined>(undefined);
  const active = useRef<{ controller: AbortController; typewriter: Typewriter } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getSession(controller.signal).then(
      (session) => {
        setGreeting({ state: "ready", text: session.greeting });
        setAnnouncement(session.greeting);
      },
      () => {
        // An aborted call (unmount, or React's strict-mode remount) must not overwrite the greeting.
        if (controller.signal.aborted) return;
        setGreeting({ state: "ready", text: FALLBACK_GREETING });
        setAnnouncement(FALLBACK_GREETING);
      },
    );
    return () => controller.abort();
  }, [api]);

  // Unmounting stops the turn: no more fetch, no more typing.
  useEffect(
    () => () => {
      active.current?.controller.abort();
      active.current?.typewriter.dispose();
      active.current = null;
    },
    [],
  );

  const send = useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      if (text.length === 0 || active.current) return false;

      const clientMessageId = crypto.randomUUID();
      const controller = new AbortController();
      let messageId: string | undefined;
      let ended = false;

      // `end` runs once per turn. A transport error after the reply completed (the connection drops
      // after `done`) must not turn a finished reply into an error.
      const end = () => {
        ended = true;
        typewriter.dispose();
        active.current = null;
        setTurn(null);
      };
      const failTurn = (message: string) => {
        if (ended) return;
        end();
        setError(message);
      };

      const typewriter = new Typewriter({
        instant: reducedMotion(),
        onUpdate: (shown) => setTurn((t) => (t ? { ...t, text: shown } : t)),
        onComplete: (final) => {
          end();
          setMessages((list) => [
            ...list,
            { id: messageId ?? `${clientMessageId}-reply`, role: "assistant", text: final },
          ]);
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
          case "done":
            conversationId.current = event.conversationId;
            messageId = event.messageId;
            typewriter.finish();
            break;
          case "error":
            failTurn(event.message);
            break;
        }
      };

      setError(null);
      setMessages((list) => [...list, { id: clientMessageId, role: "patient", text }]);
      setTurn({ text: "", waiting: true, chips: [] });

      api
        .sendChat(
          { conversationId: conversationId.current, clientMessageId, text },
          onEvent,
          controller.signal,
        )
        .catch(() => failTurn(GENERIC_ERROR));
      return true;
    },
    [api, reducedMotion],
  );

  return { greeting, messages, turn, error, announcement, responding: turn !== null, send };
}
