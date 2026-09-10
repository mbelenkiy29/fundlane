# MIC-147 report — Personalized message templates and offer/document variables

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-147
**Status:** implemented locally with synthetic fixtures. Conductor mounts the editor; do not mark Linear Done from this agent.

## Contract

Workspace templates persist on existing `mca_message_templates` / `mca_message_template_versions` (migration `0012`; schema not edited). Channel `email | sms`. Scope `merchant | followup | digest | request_info`.

Typed registry covers deal/business/owner/rep (originator + closer aliases), all/selected/highest offers, document-check summaries, and scoped upload URLs (`auto`, `statements`, `dlvc`, `closingDocs`, `moreStips`). `{missing_docs_upload_url}` aliases `{other_docs_upload_url}`. Commission, buy rate, and fee tokens are denylisted on merchant-facing scopes.

Render produces subject + HTML + plain text for email and compact text for SMS. HTML escapes interpolated values; missing fields stay empty (never `undefined`/`null`/invented amounts). Offer blocks omit commission/buy rate/factor/fees. Upload URLs HMAC-bind `workspaceId + dealId + target`.

Unknown `{{variable}}` / `{variable}` tokens replace with empty in preview and **block publish** (`422 unknown_variable`). Merchant `{{commission}}` / `{{buy_rate}}` → `422 forbidden_variable`. Draft saves keep the same version id; a save after publish creates the next version. Replay of publish keeps `published_version_id`.

## API

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/mca/comms/templates` | admin/super_admin session |
| POST | `/api/mca/comms/templates` | admin/super_admin session + trusted mutation |
| GET | `/api/mca/comms/templates/variables` | `deals:read` |
| POST | `/api/mca/comms/templates/preview` | `deals:read`; deal must be visible |
| POST | `/api/mca/comms/templates/validate` | `deals:read` |
| GET/PATCH | `/api/mca/comms/templates/:id` | admin session (PATCH is a mutation) |
| POST | `/api/mca/comms/templates/:id/publish` | admin/super_admin session + trusted mutation |
| GET | `/api/mca/comms/templates/:id/versions` | admin session |

`runtime = "nodejs"`, `cache-control: no-store`. Preview without `dealId` uses the synthetic Atlas Corporation fixture. `deals:read` cannot list or publish. Intake keys 403. Cross-workspace deal/template 404.

MIC-115 can call `getPublishedMessageTemplate` / `renderPublishedMessageTemplate` (strict: unknown tokens still throw, never emit literals).

## Tests

```
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-templates.test.ts
```

3/3 passed.

Covered: business/owner/rep; all/selected/highest offers; scoped upload `did=` + target; HTML vs SMS escaping; missing values empty; commission/buy rate/fee omitted; other deal and other workspace isolated; unknown blocks publish and is not left as `{{unknown}}`; forbidden commission tokens; draft identity; version history; admin publish vs `deals:read` preview; rep visibility; UI loading/empty/validation/success/failure copy.

## Files

- `src/lib/mca/comms/templates.ts`
- `src/app/api/mca/comms/templates/route.ts`
- `src/app/api/mca/comms/templates/variables/route.ts`
- `src/app/api/mca/comms/templates/preview/route.ts`
- `src/app/api/mca/comms/templates/validate/route.ts`
- `src/app/api/mca/comms/templates/[id]/route.ts`
- `src/app/api/mca/comms/templates/[id]/publish/route.ts`
- `src/app/api/mca/comms/templates/[id]/versions/route.ts`
- `src/components/mca/comms/template-editor.tsx`
- `tests/milestone06-templates.test.ts`
- `docs/milestone-06/MIC-147-report.md`
- `docs/milestone-06/MIC-147-acceptance.md`

Did not edit schema, `comms/contracts.ts`, settings pages, or deal workspace.

## Remaining gates

None for provider access. Merchant-upload URLs are signed and deal-scoped; the existing stipulation upload page does not yet consume the `template-upload:` token format. Follow-up send (MIC-115) must call `renderPublishedMessageTemplate` rather than interpolating locally.

## Handoff

Mount `TemplateEditor` from `src/components/mca/comms/template-editor.tsx` on a settings communications/templates surface. Admin/super_admin only for the catalog. Preview against a visible deal uses `deals:read`.
