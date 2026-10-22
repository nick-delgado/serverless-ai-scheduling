# Reviewer access

How to try the demo without asking anyone for a login. The deployed demo is a real environment (`demo`) with a fictional clinic, Cedar Ridge Health, and synthetic data only.

## Get an account

1. Open the demo from the link in this repository's **About → Website** field. That link is the current `demo` address; this repository does not print it anywhere else.
2. On the sign-in page, choose **Request demo access**.
3. Choose the one button. A short bot check runs first. If it passes, the page shows a username, a password and a made-up patient name, **once**, with a copy button beside the username and another beside the password. The page does not store the password: closing or reloading it loses it, and a reload shows the button again.
4. Choose **Go to sign in**. It opens a plain sign-in page in a new tab, so the account page stays open for the second field. The account page does not sign you in.

Then follow [script.md](script.md), a 3 to 5 minute walk through booking, voice, rescheduling, escalation and the eval report.

## If requests have run out

The page can run out: it says "Demo access requests have run out for now. Please contact Nick through the contact details in the project README." Use the contact line at the top of the [README](../../README.md) to message Nick. Use the same line if you would like a walkthrough instead. Nothing is created when the page says that.

## What you receive

A temporary patient account on `demo`: a username, a generated password and a made-up name, none of which are real. You start with no appointments. The assistant knows you only by that account, never by anything you type about who you are.

## Limits

These are the current defaults, set per environment. The runbook, [Deploy env](../runbooks/deploy-env.md), holds the values and how they change ("Daily turn caps", "The spend backstop" and "Reviewer access"); don't rely on a number here.

- **Expiry.** An account is deleted about 24 hours after it was issued. That removes the sign-in, its appointments and conversations, and puts any slot it held back to open.
- **Messages.** A per-account limit on messages per day (50 at present), and a demo-wide daily limit shared by every visitor. Over the demo-wide limit the assistant answers: "This demo has reached today's limit for the assistant. Please try again tomorrow, or see the project's README on GitHub to contact its author." Both reset at midnight Eastern.
- **Issuance.** The page issues a limited number of accounts per day and keeps a limited number alive at once.
- **Voice.** Voice messages have a monthly spend backstop. If it trips, voice stops until the month ends and typing still works.
- **Escalation.** Asking for a human sends an email to the clinic's staff inbox, which belongs to the project's author. It stays after your account is deleted. Don't type anything real into the chat.
- **Availability.** Appointment slots cover a few weeks from the day the demo was last seeded. This page promises no window.

## How access ends

Your account is deleted automatically about 24 hours after it was issued, by an hourly job; there is nothing for you to do. Nobody else is given your password, and this repository holds no credentials.
