import "./chat.css";

import { createContext, useContext, useEffect, useRef } from "react";

import { pageTitle } from "../app/pageTitle";
import { useOptionalAuth } from "../auth/AuthProvider";
import { type ChatApi, createChatApi } from "./api";
import { Composer } from "./Composer";
import { type ChatTurn, type Greeting, useChat, type UseChatOptions } from "./useChat";

/**
 * The API the chat page talks to. The default sends no `Authorization` header (the mock API needs
 * none); #36 provides one built with `createChatApi({ getToken })` from the login's session.
 */
export const ChatApiContext = createContext<ChatApi>(createChatApi());

export interface ChatPageProps extends UseChatOptions {
  /** Overrides the context's API (tests). */
  api?: ChatApi;
}

/**
 * The chat page (S5-02, #26): greeting, messages, the streaming reply, the error bubble with Retry,
 * and the composer. The patient's `sub` and the 401 handling (sign out, which routes to sign-in) come
 * from the auth context unless the props give them (#27).
 */
export function ChatPage({ api: apiProp, ...options }: ChatPageProps) {
  const contextApi = useContext(ChatApiContext);
  const auth = useOptionalAuth();
  const chat = useChat(apiProp ?? contextApi, {
    ...options,
    sub: options.sub ?? (auth?.state.status === "signedIn" ? auth.state.user.sub : undefined),
    onUnauthorized: options.onUnauthorized ?? (auth ? () => void auth.signOut() : undefined),
  });
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Retry removes its own button: put focus back in the message box rather than lose it.
  const retry = () => {
    chat.retry();
    inputRef.current?.focus();
  };

  // Keep the latest text in view as messages arrive and the reply types out.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [chat.messages, chat.turn?.text, chat.turn?.chips.length, chat.greeting]);

  return (
    <div className="chat">
      <title>{pageTitle("Chat")}</title>
      <h1 className="chat__title">Chat</h1>

      <ol className="chat__log" aria-label="Conversation">
        {chat.greeting.state === "ready" && (
          <li className="bubble bubble--assistant">{chat.greeting.text}</li>
        )}
        {chat.messages.map((message) => (
          <li key={message.id} className={`bubble bubble--${message.role}`}>
            {message.role === "patient" && <span className="visually-hidden">You: </span>}
            {message.text}
          </li>
        ))}
        {chat.turn && chat.turn.text.length > 0 && (
          <li className="bubble bubble--assistant" aria-busy="true">
            {chat.turn.text}
          </li>
        )}
        {chat.error && (
          <li className="bubble bubble--error">
            <p className="bubble__error-text" role="alert">
              {chat.error.message}
            </p>
            {chat.error.retryable && (
              <button type="button" className="bubble__retry" onClick={retry}>
                Retry
              </button>
            )}
          </li>
        )}
      </ol>

      <Activity greeting={chat.greeting} turn={chat.turn} />

      {/* Completed messages only, never per character (FR-013, NFR-005). */}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="announcer">
        {chat.announcement}
      </div>
      <div ref={endRef} />

      <div className="chat__composer">
        <Composer onSend={chat.send} responding={chat.responding} inputRef={inputRef} />
      </div>
    </div>
  );
}

/**
 * What the assistant is doing (FR-012): the typing indicator from send until the first text (and
 * while the greeting loads), and the tool-status chips of the current turn. A status region, so a
 * screen reader hears each chip's label once.
 */
function Activity({ greeting, turn }: { greeting: Greeting; turn: ChatTurn | null }) {
  const typing = greeting.state === "loading" || turn?.waiting === true;
  const chips = turn?.chips ?? [];
  return (
    <div className="chat__activity" role="status">
      {chips.length > 0 && (
        <ul className="chips" aria-label="What the assistant is doing">
          {chips.map((chip, index) => (
            <li
              key={`${String(index)}-${chip.tool}`}
              className={index === chips.length - 1 ? "chip chip--current" : "chip"}
            >
              {chip.label}
            </li>
          ))}
        </ul>
      )}
      {typing && (
        <div className="typing" data-testid="typing-indicator">
          <span className="typing__dot" aria-hidden="true" />
          <span className="typing__dot" aria-hidden="true" />
          <span className="typing__dot" aria-hidden="true" />
          <span className="visually-hidden">The assistant is typing…</span>
        </div>
      )}
    </div>
  );
}
