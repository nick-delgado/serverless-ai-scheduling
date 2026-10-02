/** The text FR-016 requires, word for word. */
export const DISCLAIMER_TEXT = "Demo — fictional clinic. Do not enter real health information.";

/**
 * The persistent demo disclaimer (FR-016). It sits in the app header on every route, including the
 * error and not-found pages, and has no dismiss control.
 */
export function DisclaimerBanner() {
  return (
    <p className="disclaimer" data-testid="disclaimer">
      <strong>Demo</strong> — fictional clinic. Do not enter real health information.
    </p>
  );
}
