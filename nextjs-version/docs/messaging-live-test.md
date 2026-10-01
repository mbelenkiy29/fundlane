# Live SMS test for the assistant

Use an approved nonproduction workspace and text only the owner's approved mobile number. A Twilio trial account cannot be used: Fundlane submits a `From` sender and free-text `Body`, which this flow requires. Do not put real customer data in the test workspace.

## Managed number flow

1. Sign in to the test workspace as an administrator. In **Settings → Connections**, complete company SMS onboarding: verify the owner email, submit the company profile, obtain operator approval, and wait for the Twilio campaign to become approved. The workspace needs its SMS allowances and provider configuration before purchase.
2. Search for a local number, review its monthly price, purchase it, and assign it to the test employee. Wait until registration is active. The scheduled SMS worker refreshes campaign status and can activate a number after the configured registration wait when Twilio sends no number event.
3. Create a deal whose contact phone is the owner's approved number. Record opt-in consent with specific evidence in the deal's SMS composer. Use **STOP** and **START** on that number if testing keyword handling; START clears suppression only when a new inbound message arrives.
4. Open the deal in the assistant, include it, ask for an SMS draft, and review the draft in the Messages panel. Preview and send there. Review the saved message and the owner's phone for delivery. The assistant draft itself does not send.

Managed onboarding needs the workspace's Twilio ISV configuration and a public HTTPS origin. See [company onboarding](sms/company-onboarding.md) for the operator and campaign setup.

## Existing manually configured sender

Use this path only if the workspace already has a Twilio account and sender outside managed number provisioning. Set the server environment for that explicit workspace ID; `*` is not a workspace key. The credential reference must use uppercase letters, numbers, or underscores and start with a letter. `LIVE_TEST` is valid.

```text
MCA_SMS_PUBLIC_BASE_URL=https://fundlane.io
MCA_SMS_TWILIO_ACCOUNTS_JSON={"<workspace-id>":{"LIVE_TEST":{"accountSid":"AC...","apiKeySid":"SK...","apiKeySecret":"...","authToken":"...","allowedSenders":["+1..."]}}}
```

In **Settings → Connections → Existing manually configured SMS senders**, add the Twilio sender with credential reference `LIVE_TEST`, and assign the employee. `allowedSenders` must include that exact sender. Copy the read-only account ID and webhook URLs shown there into the Twilio sender configuration. For the apex origin, they are:

```text
https://fundlane.io/api/mca/sms/webhooks/twilio/<accountId>/inbound
https://fundlane.io/api/mca/sms/webhooks/twilio/<accountId>/status
```

Use the same deal, evidence-backed consent, assistant review, preview, and send steps above. If the panel cannot show URLs, correct `MCA_SMS_PUBLIC_BASE_URL` before configuring Twilio; inbound and status signature validation depend on the public origin.
