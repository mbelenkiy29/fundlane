# Live-testing SMS & Email from the assistant chat

The assistant chat (drawer on every page + the `/assistant` workspace) has a
**Messages** panel per included deal: SMS and Email tabs, loaded threads with
unread badges, a thread picker, consent recording, preview-before-send, and
draft cards the assistant produces. This runbook gets a real end-to-end test
running with **your phone number** receiving the texts. The `/sms` and `/mail`
inbox pages are unchanged.

Everything here reuses the existing delivery services and gates — the panel is
just another front end for them. There is no new send path.

## Prerequisites

- The app running locally (`pnpm dev` from `nextjs-version/`) against a
  Postgres database — use a **dev database**, never production Supabase.
- A `.env.local` with the app-boot variables. Copy `.env.example` and fill them:
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service role, for identity resolution)
  - `DATABASE_URL` (Postgres connection string; localhost works without SSL)
  - `MCA_DATA_ENCRYPTION_KEY` (SMS recipients are encrypted with it)
  - `MCA_APP_ORIGIN`

Check what is still missing:

```bash
cd nextjs-version
node scripts/messaging/check-env.mjs
```

The checker splits variables into **app boot**, **SMS**, **email**, and
**assistant** groups.

## 1. Seed the test data (workspace, deal, consent)

The setup script creates a throwaway workspace, links its admin to your
Supabase Auth identity, creates a deal whose merchant contact **is your phone
number**, and records SMS opt-in consent — so the panel is immediately
sendable once a texting number is configured.

```bash
cd nextjs-version
node --env-file=.env.local --conditions=react-server --import tsx \
  scripts/messaging/seed-live-user.ts \
  --email you@example.com \
  --phone +14155551234 \
  --yes
```

Without `--yes` it only prints what it would write. Useful options:
`--deal "Name"`, `--workspace "Name"`, `--merchant-email`, `--admin-name`.
Run `--help` for the full list. The script prints the workspace id, deal id,
and the exact next steps.

> What it writes: one workspace, one membership, one deal (contact phone =
> your number, contact email = your email), one `mca_sms_consent_events`
> opt-in row, and a `supabase_user_id` link so your existing sign-in sees it.

## 2. Sign in and open the panel

1. Sign in with the email from the script; switch to the seeded workspace if the
   app doesn't land there.
2. Open the deal — either `/assistant` and pick the deal, or `/deals?deal=<id>`
   and press the Assistant button. The drawer/panel opens on the right.
3. **Include** the deal (the assistant's "include deal" toggle). The Messages
   panel only mounts when the deal is included — this is by design.
4. You should see the SMS tab with the merchant name, your number, the consent
   badge (now `opted_in`), the thread list, the loaded conversation, and the
   composer.

## 3. Test assistant drafts → review → send

1. In the chat, ask for a draft: *"Draft a text to the merchant asking for the
   missing tax return"* or *"Draft an email to the merchant following up."*
2. A **Draft** card appears in the chat (SMS/Email badge, recipient, body,
   amber note when the merchant contact is missing). The Messages panel opens
   with the composer pre-filled.
3. **Review in messenger** dismisses the card; **Dismiss** clears the prefill.
   The panel is where sending happens — nothing is sent from the chat itself.
4. In the panel: check the exact text → **Preview** (re-runs the consent gate
   and bounds checks) → **Send**.

## 4. Sending a real text (Twilio)

The panel reuses the existing SMS service. To actually deliver to your phone:

1. Add to `.env.local` and restart the app:

```bash
MCA_SMS_PROVIDER=twilio
MCA_SMS_PUBLIC_BASE_URL=https://<public-https-url>       # webhook/status URL
MCA_SMS_TWILIO_ACCOUNTS_JSON={
  "<workspaceId>": {
    "live-test": {
      "accountSid": "AC…",
      "apiKeySid": "SK…",
      "apiKeySecret": "…",
      "authToken": "…",
      "allowedSenders": ["+14155551234"]
    }
  }
}
```

   The workspace id is printed by the seed script (or use `"*"` as the key).
   `allowedSenders` must contain the number you want to send from.
2. Assign the texting number to the workspace in the SMS inbox (account setup),
   which creates the DB account row the panel lists.
3. Send from the panel. The consent gate is checked again at preview/send
   time; incoming replies update the thread.

## 5. Sending email

No environment variable is needed for email — senders are connected in-app via
Google/Microsoft OAuth:

1. Open the email inbox (`/mail`) and connect an account (Settings → Email or
   the inbox connection flow).
2. Back in the Messages panel, the Email tab lists that sender, loads
   conversations for the deal, and lets you draft/subject/recipient → queued
   delivery.
3. The merchant contact email comes from the deal's saved `contactEmail`
   (the seed script sets it to your email unless `--merchant-email` is given).

## Known constraints

- **Drafts only work on the native (Supabase) assistant runtime.** The legacy
  ChatKit service (`MCA_ASSISTANT_SERVICE_URL`) is suspended, so the
  `draft_merchant_message` tool only reaches the model there. The HTTPS route
  just answers on the native runtime too.
- The chat is read-only: drafts never send. Sending always goes through the
  panel's preview/consent gate (same gates as the inbox pages).
- SMS preview/send requires the account's provider to be configured
  (`providerConfigured` in the account list); the panel shows the gate text if
  not.
- The panel only mounts when the deal is explicitly included (privacy
  posture).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "No merchant mobile number on this deal" | The deal has no `contactPhone`; add it (or re-run the seed script). |
| Consent badge shows `consent_required` | Record opt-in with evidence in the panel's consent box, or re-run the seed script. |
| "This account's provider is not configured" | `MCA_SMS_TWILIO_ACCOUNTS_JSON` missing/mismatched for this workspace, or the account has no `allowedSenders` match. |
| Email tab shows "No connected email sender" | Connect a Google/Microsoft sender in `/mail` first. |
| No Draft card after asking | The assistant ran on the ChatKit runtime (disconnect it) or the tool didn't resolve the deal — ask again with the deal included. |
| Draft card shows a note instead of a body recipient | The deal is missing `contactPhone`/`contactEmail`, so the draft can't resolve a recipient. |