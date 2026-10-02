import { Link } from "react-router";

import { pageTitle } from "./pageTitle";

export function NotFoundPage() {
  return (
    <div className="page">
      <title>{pageTitle("Page not found")}</title>
      <h1>Page not found</h1>
      <p>
        There's nothing at this address. <Link to="/chat">Go to the chat</Link>.
      </p>
    </div>
  );
}
