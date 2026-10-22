# 2026-10-21 — A reviewer carries the demo account into the sign-in form one field at a time

**Chapter:** 6. What I'd do next
**Milestone:** M4
**Related:** #369, PR #370, #357, #44, PRD FR-004

## What happened

Nick tried `demo` after #357 closed and found the account page clunky. It had one button, "Copy username and password", that put `Username: …\nPassword: …` on the clipboard as one block. Pasted into the sign-in form's username field it gave both lines. "Go to sign in" was an in-app link, so the account page unmounted and the password, shown once and kept only in that page's state, was gone.

Nick settled the design in the readiness review (r1/Q-1 (a)): per-field copy only. The agent replaced the combined button with a copy icon beside the username and another beside the password, each writing exactly that value, and made "Go to sign in" a plain link to `/login` that opens in a new tab. The account page stays open for the second field. This refines #357's A-8 ("a copy button and a link to `/login`").

## What we found

The readiness review asked the agent to check two things in jsdom before rewriting the sign-in test (A-5). Both were fine:

- Clicking a `target="_blank"` anchor in jsdom with React Router does nothing: the router stays on `/request-access`, the account view stays up and nothing reaches `console.error`. A test pins that the page is still there after the click.
- user-event's clipboard stub keeps its contents across `cleanup()` and a remount. The sign-in test still reads each value as it is copied, then stands in for the new tab with a fresh router at the link's own `href`.

## Why we chose what we chose

- **Per-field copy, no "Copy all details".** Nick's answer (Q-1 (a)). The alternative was a third button for saving the details as labelled lines. A reviewer can select the text by hand to save it.
- **Wording the spec left to the agent** (A-2, A-4, A-7): status "Copied the username." / "Copied the password."; failure "Couldn't copy the <field>. Select it on this page and copy it yourself."; link "Go to sign in (opens in a new tab)"; explanation "Each copy button copies one field. "Go to sign in" opens the sign-in page in a new tab, so keep this tab open until you have signed in: the password is shown once, and it is gone when this tab is closed or reloaded."
- **A local `CopyIcon`-style inline SVG inside a small `CopyButton`**, with `aria-label` as the name and the SVG hidden from assistive tech. No icon library: `apps/web/package.json` is outside the issue's owned paths.
- **A plain `<a href="/login">` instead of React Router's `Link`.** A new-tab link has to be a real anchor with an exact `href`; the router adds nothing for it, and nothing about the account passes to the new tab.
- **FR-004's requirement row is unchanged.** The password still comes in one response, is never stored and is gone on reload. Only its traceability row gains #369.

## What's next

Nick deploys the SPA to `demo` after merge (`scripts/deploy-web.sh demo`), requests an account and signs in with it in a real browser. Only that shows the real new tab.
