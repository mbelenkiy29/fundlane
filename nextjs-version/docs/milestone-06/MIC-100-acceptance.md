# MIC-100 acceptance

Linear: https://linear.app/michael-belenkiy/issue/MIC-100

Synthetic fixture: workspace with admin, manager, originator rep, outsider rep, and a second workspace. Deals: formula merchant assigned to the rep (`legalName= =2+3`, owner identity `4321`, offer commission $4,000), hidden admin-only merchant, funded merchant with a committed funding event and ledger payments, plus a cross-workspace deal.

## Linear boxes

- [x] A rep's export contains only visible records and allowed fields.
  - Rep deals CSV includes the assigned formula merchant and omits the admin-only merchant, other-workspace merchant, EIN, identity last 4, owner email, commissions, and `mca_accounting_payments` ids.
  - Rep offers CSV includes Northstar on the visible deal and omits the hidden offer and `commissionCents`.
  - Rep `all_deals_owners` / `funded_deals` → `403 permission_denied`.
- [x] Exported row count matches the query snapshot and embedded formula text is inert.
  - `job.rowCount` equals `listDeals` for the same actor/filters (rep, manager, admin).
  - Empty `status=closed` export is headers only (`rowCount=0`).
  - Cells starting with `= + - @ tab CR` are prefixed with `'`. Deal/offer UUIDs are tab-prefixed identifiers, not numeric.
- [x] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
  - Role-scoped deals/offers; admin all-deals-and-owners (unmasked EIN/identity last 4, five owner slots); funded-deals (one committed row, no ledger ids).
  - Async job: `async: true` → `queued` → process → `ready`; retry `correlationId` keeps the same job id.
  - Download token expiry (`410 export_download_expired`); other workspace (`404`).
- [x] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
  - `exportPanelView` covers loading / disabled / empty / validation / queued / failed / ready.
  - Panel copy in `EXPORT_PANEL_COPY`. Retry POSTs the original `correlationId`.
- [x] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.
  - Unauthenticated `401`; `deals:read` key cannot POST; rep cannot workspace-export; `exportDeals: false` → `403 action_disabled`.
  - Audit metadata has job id, kind, rowCount, checksum, token **row** id — not the download secret, API key secret, identity last 4, or owner email.

## Not a payment export

Manifests and generated CSV omit commission, buy rate, fee, splits, accounting record ids, and ledger payment ids. Funded export is funding events only.

## Remaining gates

None. No live provider or OAuth. Conductor still needs to mount `ExportPanel` on Deals; `GET /api/mca/deals/export` remains until remount.
