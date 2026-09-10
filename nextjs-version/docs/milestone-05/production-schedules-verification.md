# Production schedules follow-up — 2026-09-09

User request: apply remaining schema and verify `/payments` so Milestone 5 software can persist.

## Database

- Verification branch `br-gentle-sound-aencsy8p`: 15 Drizzle migrations after `pnpm db:migrate -- --target=verification`.
- Production branch `br-aged-sun-aeqj80uv`: 15 migrations after `pnpm db:migrate -- --target=production`.
- Production tables present: `mca_reverse_consolidations`, `mca_distribution_schedules`, `mca_scheduled_installments`.
- Applied files: `0012_furry_ultimatum.sql`, `0013_mute_hedge_knight.sql`, `0014_youthful_silver_samurai.sql`.

## Railway

- Deployment `d04b4edb-54bd-4c84-8589-c8f30215cc37` SUCCESS on Fundlane production.
- `https://fundlane.io/sign-in` 200.
- `GET /api/mca/accounting/schedules` 401 when signed out (route is live).
- Authenticated bootstrap session: `/payments` 200; schedules API 403 without payment-table permission (same `requirePaymentActor` gate as payments).

## Sandbox click-through substitute

Disposable Next server `http://127.0.0.1:5841` with synthetic admin. End-to-end over HTTP:

1. Sign-in
2. Funded Harbor deal already present from sandbox seed + offer/funding
3. 60/40 split template
4. Reverse consolidation starting 2026-10-05, four $1,000 Mondays
5. Scheduler run inserted **8** expected installment rows
6. `GET /payments` 200

No in-app browser driver was available. No live merchant email, SMS, or DocuSeal request was sent. Sandbox database was removed when the server was stopped.
