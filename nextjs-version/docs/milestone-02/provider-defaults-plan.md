# Milestone 2 provider defaults

Selected September 8, 2026 under the user's delegated provider/setup decision (“you choose I dont know”). This supersedes the unresolved *product-choice* gate in Lane B. It does not claim that external accounts, credentials, forms, or addresses exist.

## MIC-181: Zoho Forms JSON with private Google Drive attachments

Select contract version `zoho_forms_json_drive_v1`. Zoho supports naming webhook payload parameters and custom authorization headers; use `application/json`, General authorization, and `Authorization: Bearer <generated MCA admission secret>`. Configure explicit top-level parameters rather than assuming Zoho supplies MCA's existing `data`/`attachments` envelope. [Zoho webhook configuration](https://help.zoho.com/portal/en/kb/forms/integrations/webhooks/articles/webhook-configuration).

Configure a Zoho Unique ID field as payload `entryId`. Configure a hidden Single Line field with the integration's fixed form identifier as `formId`. Map business inputs to `legalName`, `contactEmail`, `contactPhone`, `ein`, `state`, `monthlyRevenue`, and owner fields to named flat parameters, e.g. `ownerFirstName`, `ownerLastName`, `ownerOwnershipPercent`. MCA mapping sends those owner parameters to `owners.0.firstName`, `owners.0.lastName`, `owners.0.ownershipPercent`. Use the existing administrator-selected assignment pool/default assignment behavior; confirm with an active rep fixture. Unique ID is a supported Zoho field; do not claim undocumented automatic `entry_id` metadata. [Zoho Unique ID](https://help.zoho.com/portal/en/kb/forms/field-types/form-fields/identifier/articles/unique-id).

JSON cannot carry native file bytes. Choose Settings → Submissions & Storage → Manage Form Attachments → Google Drive, authenticate Zoho to the workspace's Drive folder, and map one PDF application upload to webhook parameter `applicationFile`, one statement upload to `statementFile`. Zoho documents links for attachments stored externally; a flat string link is the selected receiver contract. Accept a bounded array of such links if needed for multiple uploads, with explicit validation rather than silent coercion. Actual account delivery must verify link serialization. [Zoho response formats](https://help.zoho.com/portal/en/kb/forms/integrations/webhooks/articles/response-format-for-content-type), [Google Drive attachment setup](https://help.zoho.com/portal/en/kb/forms/form-settings/submissions-storage/manage-form-attachments/articles/save-attachments-in-google-drive).

MCA must parse only recognized Google Drive file links (`https://drive.google.com/file/d/<id>/view` and `https://drive.google.com/open?id=<id>`), validate the file ID, and construct `https://www.googleapis.com/drive/v3/files/<id>?alt=media`. Retrieve with the configured **Google OAuth bearer token**, never the current generic `Zoho-oauthtoken` header. Only `www.googleapis.com` receives that credential; retain existing HTTPS, host, redirect, size, and timeout checks. The OAuth principal must have read access to the Zoho upload folder/files and a content-read scope. An encrypted expiring access token with explicit rotation/retry is sufficient for this bounded work; automatic OAuth refresh is separate production setup. [Google Drive download contract](https://developers.google.com/workspace/drive/api/guides/manage-downloads).

Example *synthetic configured payload*, not a captured live event:

```json
{
  "formId": "mca-application-v1",
  "entryId": "MCA-000001",
  "legalName": "Fixture Bakery LLC",
  "contactEmail": "owner@example.test",
  "monthlyRevenue": "42000",
  "ownerFirstName": "Fixture",
  "ownerLastName": "Owner",
  "ownerOwnershipPercent": "100",
  "applicationFile": "https://drive.google.com/file/d/fixture_application_id/view",
  "statementFile": "https://drive.google.com/open?id=fixture_statement_id"
}
```

Persist explicit selected contract/attachment method; mark this selected contract approved under the delegated decision. Preserve a gate for genuinely unknown custom contracts. Ordinary integration edits must preserve approval instead of resetting it whenever the approval checkbox is omitted. UI should explain Google Drive token and named field setup, with configured/local-tested/live-unverified states separately represented.

Tests: documented flat fixture + authenticated ingress creates expected business, owner, rep and two stored PDFs; identical delivery is idempotent; changed event conflicts; wrong form, missing ID, malformed/foreign link and missing admission fail; expired Drive credential leaves recoverable attachment error; rotation and retry complete attachments without another deal. Keep existing other-provider tests passing.

## MIC-184: Postmark Inbound, provider-issued address

Choose an existing Postmark Server dedicated to this workspace, or create one when authorized credentials exist. Use its actual `InboundHash@inbound.postmarkapp.com` address; this avoids requiring a purchased domain. A Server has one inbound stream and webhook. Read `InboundHash` through the server API; configure `InboundHookUrl` to the public HTTPS MCA email route. Postmark supports HTTP Basic authentication in the configured webhook URL. Choose username `mca` and the one-time generated admission secret as password; hash the secret locally and never expose the credential-bearing URL in status or logs. [Inbound server setup](https://postmarkapp.com/developer/user-guide/inbound/configure-an-inbound-server).

Add explicit gateway `postmark` versus legacy/custom gateway configuration. Authenticate Basic before parsing any JSON, validate both username and secret, and maintain existing bearer behavior only for the explicit custom contract. Map actual Postmark fields: `FromFull.Email` → sender, `OriginalRecipient` → route, `Subject` and `TextBody` → content. Preserve Postmark `MessageID` as delivery correlation. For deduplication prefer a valid original `Message-ID` header in `Headers` when supplied; otherwise use `MessageID`. Postmark's generated ID alone does not prove deduplication of two separately forwarded copies. Preserve original identity when available, document the limit for forwarding clients that generate a new Message-ID, and test both identity paths. [Inbound webhook schema](https://postmarkapp.com/developer/webhooks/inbound-webhook).

Map `Attachments[].Name`, `ContentType`, `Content`, `ContentLength`, `ContentID` into the existing attachment pipeline. Decode strict base64 with bounded aggregate/request size and individual decoded size; reject malformed encodings and declared/decoded size mismatch before any deal side effect. Set stable per-attachment IDs including original message identity and array index to prevent same-filename collisions. Ignore CID image signature graphics, retain PDFs even when they have a ContentID, and use the existing document extraction/scanning/storage contracts. Postmark documents base64 attachment data and a 35 MB cumulative provider limit; MCA can impose a smaller explicit bound. [Parse an email](https://postmarkapp.com/developer/user-guide/inbound/parse-an-email).

No Postmark schema contains the current custom `application` or `forwardingConfirmation` booleans. Do not accept these as provider features. Provider-issued addresses work directly without a forwarding setup flow. If forwarding confirmation is recognized from actual sender/subject/body, retain it as a review item and do not auto-follow links or send email.

Tests: real-shaped Postmark JSON through Basic-auth ingress extracts one application, assigns active rep, ignores inline logo, stores PDFs and queues one receipt; repeated callback and original-Message-ID replay keep one intake; unauthorized Basic credentials, wrong recipient, sender rules, bad base64, size mismatch/oversize, two same-named files, and extraction failure have deterministic coverage. Use fixture extraction and receipt transport, not outbound email. Existing receipt idempotency and lease tests stay intact.

## Provisioning prerequisites and truthful status

Root checked available tools and local configuration: no Postmark/Zoho provider tools or named credentials are available. Thus **no real address is provisioned**. Implement setup/readiness and a server verification/provisioning path that uses actual authenticated provider responses when credentials become available; never generate a plausible-looking address locally. Prefer idempotent reuse by saved server ID, and verify name/workspace before mutating an existing server. The account token is used only server-side (`X-Postmark-Account-Token`); persist server ID/hash as evidence and keep secrets encrypted. [Servers API](https://postmarkapp.com/developer/api/servers-api).

Missing concrete prerequisites: authenticated Postmark account/account token, workspace server ID (or authorized free-tier creation), public deployed HTTPS webhook origin, Zoho Forms account/form and Drive OAuth grant, live model credentials. Postmark says inbound processing can be configured while account approval is pending; do not conflate outbound sender approval with inbound readiness. Verify account-specific feature availability; do not upgrade or spend money. [Account approval](https://postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work), [free Developer plan](https://postmarkapp.com/pricing/).

Complete local adapter acceptance now. MIC-181 can move to local acceptance complete after the selected-contract tests pass, with live account setup disclosed. MIC-184 remains open for its literal real-address provisioning requirement until a provider response supplies an address. Outbound receipt sending remains unperformed and unauthorized. The product choice is resolved; credentials/account access are the remaining external prerequisite.

## Implementation evidence

Implemented September 8, 2026 in Lane B. The selected Zoho contract is persisted and locally approved; an unknown contract key still gates intake. Its authenticated synthetic fixture creates the expected deal, owner, active-rep assignment, application, and statement, then proves event replay/conflict, exact `entryId`, link validation, Google-only bearer delivery, expired-token retry, credential rotation, and completion without a second deal.

The Postmark adapter authenticates Basic before parsing, maps the actual inbound schema, prefers a valid original Message-ID, validates all retained base64 attachments and aggregate size before deal creation, assigns the active rep, retains CID PDFs, ignores CID images, uses stable array-index identities for same-named files, queues the receipt, and records extraction/forwarding failures for review. The credential-dependent setup route verifies or explicitly creates a named server, reads the provider-issued address, and configures the inbound hook only for a deployed HTTPS origin. Its account token is not persisted. No live Postmark request or outbound email was made.

Focused verification: `pnpm exec node --conditions=react-server --import tsx --test tests/intake-core.test.ts` passed 12/12 in 434 ms; `pnpm exec tsc --noEmit --pretty false` and scoped Lane B ESLint passed. Independent review in `provider-defaults-review.md` found no blocker. MIC-181 is recommended Done for local acceptance. MIC-184 remains open because no credentialed Postmark account/server and public deployment origin were available to return and activate a real inbound address.

## Bounded Sol B implementation task

Implement only the two selected contracts above in Lane B-owned intake files, API/UI, tests, and Lane B acceptance evidence. Do not change shared/package files or other lanes without root coordination. Add contract/gateway metadata compatibly in the intake repository if needed. Prioritize complete Zoho flat JSON/Drive attachment acceptance and genuine Postmark Basic/JSON/base64 ingress plus honest readiness. Do not create accounts, invent addresses, upgrade plans, or send mail. Run targeted intake tests, TypeScript and scoped lint; report exact test evidence and remaining real provisioning prerequisite to root. Update stale customer-choice gate language in Lane B evidence, preserving the distinction between selected contract, synthetic verification, and live provider readiness.
