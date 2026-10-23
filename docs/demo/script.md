# Demo script

A walk through the scheduling assistant in about 3 to 5 minutes, as a brand-new temporary patient. It covers five beats, in this order: request an account and sign in, book by text, send a voice message, reschedule that same booking, and escalate to a human.

Use desktop Chrome: voice is shown there only (Safari and mobile browsers work too, see `apps/web/e2e/MANUAL.md`, but the timing here is for Chrome). The sign-in address is the link in this repository's **About → Website** field. You need no account to start: the first beat issues one. How access works, and its limits, is in [reviewer-access.md](reviewer-access.md).

The script names no username, password or patient name, because the app makes up all three for each account. Where it says "the name the account page showed", use the made-up name from your own account.

Cedar Ridge Health is a fictional clinic and all data is synthetic. Type the quoted lines as written; the agent understands other wording. The lines are adapted from the e2e specs, the runbook's check turn and the manual checklist, and Nick's timed dry run checked them before the recording.

## 1. Request an account and sign in (about 30 seconds)

1. Open the address from the About field. On the sign-in page, choose **Request demo access**.
2. Choose the one button on the page. A username, a password and a patient name appear, once; [reviewer-access.md](reviewer-access.md) describes the page.
3. Choose **Go to sign in**; it opens in a new tab and leaves the account page open. Copy the username, paste it, go back, copy the password, paste it, and sign in.

**Expect:** the chat opens with a greeting that uses the name the account page showed. Nothing is booked yet.

## 2. Book by text (about 60 seconds)

Ask for a provider who is taking new patients, Dr. Priya Lee (dermatology). Dr. Marcus Brooks is not accepting new patients, so don't pick him.

1. Send: `What times does Dr. Priya Lee have open next week for a skin check?` The reason for the visit is in the line because the assistant asks for it before it books.
2. Status chips show while it works ("Looking up providers…", "Checking availability…"), then the reply lists times. Name a provider and a week: an open question such as "What appointments are available next week?" gets a clarifying question back instead of times.
3. Send: `The earliest of those works for me.` The assistant restates the provider, time and reason, and asks before it books. Nothing is booked yet.
4. Send: `Yes, please book it.`

**Expect:** a confirmation with the provider, date and time.

## 3. Send a voice message (about 40 seconds)

1. Choose the microphone button ("Record a voice message") beside Send. Allow the microphone when the browser asks. If you deny it, a message says how to enable it, and typing still works.
2. Say: "What appointments do I have coming up?" then choose **Send**.
3. The overlay shows a timer and a level bar, then "Transcribing…", and your words appear as your own chat bubble.

**Expect:** the agent answers as it would to typed text, and lists the booking from beat 2. Voice has its own spend limit and can be off for the rest of a month; if the overlay says "Sorry, we couldn't turn that into text." and it keeps saying so, the voice backstop may have tripped; say that to your reviewer and move on, since typing carries every other beat.

## 4. Reschedule that same booking (about 45 seconds)

In the same conversation:

1. Send: `I need to reschedule my appointment with Dr. Priya Lee to next Thursday.` (any weekday other than the booked one, in the weeks the clinic is open).
2. The assistant offers times on that day. Send: `The earliest of those works for me.`
3. It restates the move and asks. Send: `Yes, please reschedule it.`

**Expect:** a confirmation of the same appointment on its new time, not a second appointment. Asking "What appointments do I have?" lists one.

## 5. Escalate to a human (about 20 seconds)

Send: `I'd like to speak with someone at the front desk, please.`

**Expect:** the assistant tells you it is passing the conversation to the clinic's staff and gives the front-desk phone number and hours. An escalation emails the clinic's staff inbox, which belongs to the project's author; the demo shows only this chat reply, never that inbox.

## What to leave out

- Don't open the staff inbox, a console, or any environment other than `demo`. `demo`'s address in the address bar is fine: it is already public in the repository's About field (r2/Q-2).
- The take's username and password may show on screen in the recording (r2/Q-1): it is a temporary account, deleted about 24 hours after it was issued at present (the runbook holds the current value), and the per-env turn caps bound what anyone could spend with it before then.
