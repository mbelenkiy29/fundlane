# Desktop browser calls

User-approved scope: a broker deliberately enables desktop browser calling, calls merchants from the company-designated Twilio number, answers inbound calls, sees call state/history and missed-call alerts. Recording is OFF. No AI voice, number migration, mobile/background guarantee, live calls, provider provisioning or credential generation in this task. Implementation follows the user's explicit plan-and-execute instruction.

## Architecture

Use Twilio Voice JavaScript SDK Device in a persistent authenticated workspace panel. Browser registration is opt-in; microphone access happens only after the user's call/answer action. A session-only token endpoint authenticates workspace membership and roles, rejects API keys/cross-site mutations, rate-limits issuance and signs a 5-minute Voice grant bound to a server-generated tenant/member identity. Never return provider credentials. Refresh tokens only while the panel is enabled.

Outbound calls consume an expiring one-use server dial intent bound to the same identity and a visible deal. The server resolves the deal phone; client-supplied To/From never determines routing. A signed Twilio application webhook consumes the intent, rechecks tenant/member/deal/number readiness, creates history and emits Dial Number with the designated caller ID and record=do-not-record. Cancellation before connect invalidates the intent. No automatic dial retries.

Inbound signed webhooks bind account SID and To to the designated number. Route only to opt-in, unexpired browser presence for active permitted company memberships. Never infer tenant from browser or webhook parameters. Persist parent call SID; Dial action callback provides authoritative answered/missed outcome. Reject invalid signatures, account/number mismatch, oversized/duplicate form parameters and unsupported call states. Use canonical configured HTTPS callback URL, never forwarded host. Callback replay is idempotent, terminal outcomes cannot regress, and missed events are transactionally deduplicated.

## Modules and dependencies

Voice owns src/lib/mca/voice/, src/components/mca/voice/, /api/mca/voice/, additive voice database schema/migration and provider activation documentation. Reuse requireWorkspaceAccess, actorForDeals/getDeal, pg transactions, encryption, existing Twilio form verification and UI components. Shared app mount and call entrypoint edits are minimal and coordinated.

SMS owner supplies pinned read-only designated-number and credential contract; no independent number ownership table/provisioning. Notifications owner supplies pinned internal missed-call enqueue interface. Onboarding consumes exported VoiceReadiness UI and GET /api/mca/voice/readiness. Dependent shared edits wait for pinned commits. Credential readiness may use existing SMS subaccount API key only if explicitly approved by contract; Voice app SID and callback activation must be declared per tenant. Until configured, readiness returns blockers and token/dial endpoints fail closed.

## UX

Enable calling / Disable calling, incoming Answer / Reject, outgoing Call / Cancel, connected Disconnect, error with manual Retry registration, visible number and recording-off notice. Presence expires when tab closes; no offline/mobile promise. Persist history and missed alerts without recording/transcript artifacts. Call SDK errors never expose credentials or raw provider responses. Clean up listeners/device on unmount/logout/workspace change; async registration/connect completions must not resurrect a canceled call.

## Verification and activation

Synthetic/mocked SDK/provider tests only. Cover authentication/API keys, roles, tenant/deal isolation, expiry/replay, forged callback/account/number, terminal order, missed-call dedupe and cancellation races. Local disposable Postgres only. Typecheck/lint; build/aggregate after parent allocation. Independent review and separate draft PR for human review. Provider credentials, app/number webhooks, real browser audio acceptance and hosted migrations are explicit external gates.

Self-review: scope matches approved request; shared interfaces are dependency gates rather than invented APIs; no provider activation or security grants are performed.
