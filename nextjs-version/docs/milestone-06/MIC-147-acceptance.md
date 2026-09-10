# MIC-147 acceptance — Personalized message templates and offer/document variables

Executed locally with synthetic Postgres fixtures. Scope: typed variable registry, channel-aware rendering, all/selected/highest offers, scoped upload links, version history, unknown-variable publish gate, merchant commission/other-deal denylist. Live merchant send is out of scope (MIC-115).

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| An unknown variable blocks publish instead of sending literal placeholder text | Passed | `tests/milestone06-templates.test.ts` — draft with `{{not_a_real_variable}}` saves; `POST .../publish` returns `422 unknown_variable`; preview text is `Hello ` with no `{{not_a_real_variable}}`; `publishedVersionId` stays null |
| A merchant template cannot access private commission or another deal's data | Passed | Offer formatter omits `commissionCents` / buy rate / fees (`9,999` / `8,888` / `1.35` absent). `{{commission}}` publish → `422 forbidden_variable`. Deal A preview has no OtherCorp / deal B id / other-workspace merchant. Rep cannot preview an unassigned deal (`404`). Cross-workspace deal `404` |
| Demonstrate every implementation requirement with a realistic synthetic scenario | Passed | Atlas `<Corp>` + John Galt owner, Casey originator / Hank closer, $50k selected and $100k highest, missing 4 of 4 docs, HMAC upload URLs with `did` + `target`. Synthetic preview uses Atlas Corporation / `$100,000` / `rec19g6wlw9hzlxw` |
| Loading, empty, validation, success and failure states; retries preserve identity | Passed | `TemplateEditor` copy for loading, empty catalog, name/body required, unknown/forbidden, published, `role="alert"`. Draft PATCH reuses version id; publish replay keeps `published_version_id`; post-publish save creates version 2 |
| Direct API requests enforce the same permissions as the UI; secrets excluded | Passed | Admin session list/create/publish; rep list/create 403, assigned-deal preview 200; `deals:read` preview 200 / list+publish 403; `deals:write` publish 403; intake 403. JSON omits `credentialCipher` / `password_hash` |

Command:

```
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-templates.test.ts
```

3/3 passed.

## Behavior

- Registry: `deal_id`, `deal_uuid`, `deal_url`, business/owner/originator/closer/rep, offer summaries, `docs_check_summary` / `missing_docs`, scoped upload URLs. Aliases: `rep_*` → originator; `missing_docs_upload_url` → `other_docs_upload_url`.
- Tokens: `{{name}}` and `{name}`. Unknown or forbidden names are emptied on render and block publish.
- Email: subject (newlines stripped), HTML (value-escaped, newlines → `<br>`), plain text. SMS: compact `Offer 1: $50,000, 24 months, $2,200.00 monthly`.
- Missing values are empty strings. Highest/selected/all use current eligible revisions on **that** deal only.
- Upload URL: `{origin}/merchant-upload/{hmac}?wid=&did=&target=` with HMAC `template-upload:workspace:deal:target`.
- Admin/super_admin session publishes. `deals:read` previews a visible deal or the synthetic fixture.

## UI

`TemplateEditor` lists drafts/published templates, variable picker grouped by deal/business/owner/rep/offers/documents/uploads, save draft, publish (disabled when unknown/forbidden), deal preview, synthetic preview, and version history. Conductor mounts it in settings.

## Local vs live gates

Local fixtures prove registry, escaping, offer modes, scoped links, publish gates, permissions, and version identity. No live merchant email/SMS. Fixture success is not production sending readiness.
