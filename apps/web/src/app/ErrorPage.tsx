import { Link, useRouteError } from "react-router";

import { pageTitle } from "./pageTitle";

/**
 * Shown when a page throws while rendering. It renders inside the layout, so the disclaimer stays.
 * The error goes to the console only: its message isn't written for patients.
 */
export function ErrorPage() {
  const error = useRouteError();
  console.error(error);
  return (
    <div className="page" role="alert">
      <title>{pageTitle("Something went wrong")}</title>
      <h1>Something went wrong</h1>
      <p>
        This page couldn't be shown. <Link to="/chat">Go back to the chat</Link> or reload the page.
      </p>
    </div>
  );
}
