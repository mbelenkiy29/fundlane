# Funder provider readiness and hosted acceptance

This matrix records evidence available in this repository as of 2026-09-26. A registered adapter, saved credential, or configured API route is not proof of provider authorization or successful delivery. `MCA_FUNDER_READINESS_INVENTORY_ENABLED=true` exposes an admin-only, workspace-scoped inventory in Settings → Connections. Its default is `false`. It reports configured funders and registered adapters, credential presence without secret values, route state, code-level contract/callback capability, commercial-access evidence, and readiness. It does not inspect provider accounts. `MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED=true` makes replay of an API attempt already recorded as `sending` fail as `delivery_uncertain` for manual reconciliation; its default is `false` to preserve current production behavior.

| Provider adapter | API contract evidence | Callback evidence | Commercial access | Readiness |
| --- | --- | --- | --- | --- |
| sandbox | Local deterministic fixture; no external provider | Status poll fixture; no webhook | Local test only | Sandbox verified locally |
| expansion-capital-group | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| kapitus | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| fintegra | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| quantum-lends | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| channel-partners-capital | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| forward-financing | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| fundomate | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| rapid-finance | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| headway-capital | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| plexe | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| fora-financial | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| idea-financial | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| peac-solutions | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| can-capital | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| bitty-advance | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| lendini | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| lendr | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| everest-business-funding | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| ondeck | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |
| credibly | Mapping/fixture only | No verified provider callback | Not evidenced | Untested |

The registry blocks these named adapters in production. The sandbox adapter is also blocked in production. No real pilot destination has been authorized or exercised here, so none is live verified. Local test IDs such as `sandbox-attempt`, `evt-replay-1`, `timeout-controlled`, and `unknown-api-outcome` are synthetic correlation or event IDs, not provider receipts. The local tests cover sandbox submission/status normalization, stale or expired approval, duplicate callback, unknown status, a controlled timeout, environment-scoped credential failure, and uncertain API replay without another send. Credentials have no expiry timestamp in the current adapter schema, so an expired provider token needs a controlled provider response in hosted acceptance. These tests do not establish live provider acceptance or private hosted Storage behavior.

## Hosted setup and acceptance for Michael

1. Obtain written commercial/API access to one pilot provider and its current application, status, callback, idempotency, and document contracts. Record contract version, test account, callback authentication, permitted destinations, and whether the provider guarantees receipt deduplication.
2. Use an approved nonproduction Supabase project, synthetic merchant and private documents, and a controlled provider sandbox. Configure its API route and workspace credential in Settings → Connections. Never put secrets in the matrix or PR. Enable `MCA_FUNDER_READINESS_INVENTORY_ENABLED=true` only after checking admin visibility; use `MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED=true` for the controlled replay test. No callback URL or cron schedule can be prescribed until the provider publishes a contract; the repository's generic route `/api/mca/submissions/webhooks/{slug}` is not evidence of a working provider callback. Configure the provider console callback and signing secret only after verifying that contract. There is no provider cron schedule to add for this ticket.
3. Verify reviewed application fields, funder criteria, private documents, preflight, and explicit human send approval. Submit once with a sanitized correlation ID and retain the provider receipt. Check acceptance and status/offer or decline, ingest a signed reply, and verify the deal timeline. Record timestamps and sanitized event IDs.
4. Exercise timeout, duplicate callback, stale approval, expired credential, and unknown outcome. Reconcile provider receipts before any retry; confirm the provider saw at most one send. A database attempt row alone cannot prove this.
5. Promote a provider to sandbox verified or live verified only after attaching the provider authorization, contract, receipt, callback, timeline, and negative-case evidence. Keep unavailable paths labeled untested until then. A true live verification requires an authorized real destination and operational owner; local code cannot satisfy that part of issue #40.
