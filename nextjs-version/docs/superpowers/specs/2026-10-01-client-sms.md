# Client SMS integration design

Reuse the existing managed Twilio adapter, consent store, inbox and company provisioning. New numbers only; no porting, resource purchases, provider configuration or live traffic. Existing issue #42 external eligibility and pilot activation remain open.

Publish a server-only, read-only company number contract queried by workspace and number ID, containing local account ID, provider number SID, phone, assignment/activity, number state, company suspension and provider account identity. Provider credentials remain server-only via the existing `company(workspaceId)` / `provider(company)` resolver. Voice must apply its own capability/configuration gates and must not interpret SMS carrier registration as Voice approval. Callers must authorize tenant access before invoking the internal workspace-keyed query.

Managed SMS readiness returns stable blocker codes/messages and uses the same evaluator for account listings, route/send gating and onboarding number display. It verifies local number/account sender identity, active assignment, company/carrier/opt-out approval, credentials and public callback origin. No generic scheduler/retry implementation is added; notification foundation owns it.

Inbox replies preserve an uncertain attempt's idempotency key and exact payload until reconciled. Switching conversations clears the previous detail immediately and ignores late requests. Validation happens before inbound persistence, and callbacks remain available after company suspension. Existing repeated sends, signed inbound/status/registration callbacks, tenant/role isolation, suppression and failure tests are retained and expanded for identified gaps.

No migration is planned. Client status contains no credentials or provider secrets. Tests use disposable PostgreSQL on port 55443 with synthetic fixtures. Full aggregate/build await parent allocation.
