/** The text FR-016 requires, word for word. */
export const DISCLAIMER_TEXT = "Demo — fictional clinic. Do not enter real health information.";

/** The leading word, shown in bold. */
const DISCLAIMER_LEAD = "Demo";

/**
 * The persistent demo disclaimer (FR-016). It sits in the app header on every route, including the
 * error and not-found pages, and has no dismiss control.
 */
export function DisclaimerBanner() {
  return (
    <p className="disclaimer">
      <strong>{DISCLAIMER_LEAD}</strong>
      {DISCLAIMER_TEXT.slice(DISCLAIMER_LEAD.length)}
    </p>
  );
}
