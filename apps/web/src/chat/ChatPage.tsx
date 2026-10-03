import { pageTitle } from "../app/pageTitle";

/** Placeholder until the chat page lands (S5-02, #26). */
export function ChatPage() {
  return (
    <div className="page">
      <title>{pageTitle("Chat")}</title>
      <h1>Chat</h1>
      <p className="muted">The chat arrives with #26. In development, the mock API already answers.</p>
    </div>
  );
}
