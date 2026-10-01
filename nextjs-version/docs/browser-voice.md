# Desktop browser calling

Voice is user-operated: enable the browser panel, choose a merchant Call action, confirm Call merchant, and Answer/Reject incoming calls. Outbound phones resolve from an authorized deal on the server. Recording is always `do-not-record`; no transcription or recording tables/endpoints are added. Closing/ disabling the tab expires availability; there is no mobile or background calling guarantee. Keep only one calling tab enabled per company membership.

## Setup and external acceptance gates

1. Apply notification0068 then Voice0069 through the reviewed nonproduction/release migration procedure. Voice migration enables RLS, revokes public/browser-role access and grants the existing trusted server `mca_app` role SELECT/INSERT/UPDATE on config/intents/history plus DELETE only on presence. Policies follow the repository server trust model; authenticated service code enforces tenant/member filters. The role cannot delete call history, truncate configuration or disable RLS. The release securing script preserves these table-specific privileges; local tests run the actual securing script, verify INSERT/SELECT/UPDATE/presence DELETE, and execute token/history/presence services through an mca_app connection. These definitions are reviewed source; no hosted migration, role creation or security grants are applied by this task.
2. SMS owns existing company number identity and encrypted Twilio subaccount credentials. Voice pins SMS contract53e7947 and notifications fa14fe3+41a4264. A released/releasing/foreign-company number cannot be selected; SMS campaign registration does not establish or gate Voice capability. Company suspension blocks new calls.
3. Existing subaccount signing API key/secret, auth token and a TwiML Voice application SID must be configured by the authorized administrator outside this task. No credentials or numbers are created here. `MCA_VOICE_PUBLIC_ORIGIN` (fallback `MCA_APP_ORIGIN`) must be an exact public HTTPS origin.
4. Set that application's Voice URL to `ORIGIN/api/mca/voice/webhooks/WORKSPACE_ID/outbound` (POST) and the designated number's Voice URL to `ORIGIN/api/mca/voice/webhooks/WORKSPACE_ID/inbound` (POST). TwiML supplies `.../outcome` as the Dial action callback. Voice verification uses the canonical configured origin, account SID, unique bounded form fields and signature. Never configure callbacks for a different company's account/number.
5. Company admin visits `/settings/connections/voice`, selects the existing company number and existing application SID, and confirms callback configuration. Readiness checks local configuration; this confirmation is not evidence of a real provider call.
6. Before release, verify signed callbacks, real desktop audio permission/quality, inbound reachability, token refresh and browser/device errors with synthetic participants in authorized nonproduction. No actual calls, microphone acceptance, paid provisioning, number porting, OAuth grants or production mutations were performed here.

Broker missed-call events use the pinned notification foundation with kind `missed_call`, no invented deal ID, and one `voice-missed:CallSid` key per tenant/recipient. Intended available members receive the internal alert; with no available browser, active administrators receive it. Calls remain visibly missed in history when a recipient suppresses notifications or company policy disables alerts. Notification delivery/worker/provider activation belongs to the foundation task and is not established by enqueue tests.

## Interfaces

- `GET /api/mca/voice/readiness`: ready, numberId, phone, recording=`off`, blocker messages. `VoiceReadiness` is a read-only onboarding component, never registers audio.
- `POST /api/mca/voice/config`: admin-only existing numberId/applicationSid/callbacksConfirmed.
- `POST /api/mca/voice/token`: interactive session only; 300-second Voice token bound to tenant/member identity; rate-limited and no-store. SDK-only outgoing params contain IntentId, never trusted To/From.
- `POST /api/mca/voice/presence`: opt-in 300-second availability lease; disabled removes it.
- `POST /api/mca/voice/dial-intents`: visible dealId; one-use 60-second intent; destination and number rechecked at dispatch. `POST .../cancel` invalidates unconsumed intents.
- `GET /api/mca/voice/history`: tenant-only; admins company history, members their originated/intended calls. Terminal callbacks cannot regress outcomes.
- `VoiceLauncher({dealId,label?})` / `launchVoiceCall(dealId)` replace tel handoffs in the deals table, merchant sheet and Home renewal call action; launcher requests a reviewable call panel and never automatically dials.

Provider references: [Twilio Device](https://www.twilio.com/docs/voice/sdks/javascript/twiliodevice), [Access Tokens](https://www.twilio.com/docs/iam/access-tokens), [Dial](https://www.twilio.com/docs/voice/twiml/dial).

## Local evidence

Focused tests cover signed scoped five-minute grants, tenant identity separation, recording-off XML, forged/wrong-account/canonical URL/duplicate/oversized webhook bodies; SDK register/answer/reject/cancel/disconnect, delayed connect/setup cleanup and retry; interactive-role gates and number lifecycle; disposable Postgres migration, company/role/deal isolation, one-use/canceled/expired intents, released number/inactive membership, leased inbound routing, history isolation, terminal callback ordering and missed-call notification deduplication. They use mocks and disposable loopback Postgres on port56544. Build/aggregate evidence and independent review are recorded in the final PR; no hosted acceptance is inferred from these checks.
