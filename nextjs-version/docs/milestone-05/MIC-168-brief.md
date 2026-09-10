# MIC-168 brief — Email or text offers and record merchant pitch

Preview/pitch/consent already exist. Remaining software: extract merchant offer SMS transport out of `closing/service.ts` so it does not import `TwilioSmsTransport`. `deliverClosingSms` already uses `getSmsAdapter`.

**Exclusive:**
- `src/lib/mca/closing/offer-sms.ts`
- `tests/milestone05-mic-168.test.ts`
- `docs/milestone-05/MIC-168-report.md`
- `docs/milestone-05/MIC-168-acceptance.md`

**Do not edit:** `closing/service.ts`, `closing-panel.tsx`, `sms/service.ts`, `sms/adapters/registry.ts`, schema, Linear. Conductor will wire your export into `sendMerchantOfferPreview`.

**Required export:**
```ts
export function createMerchantOfferSmsTransport(
  actor: DealActor,
  dealId: string,
  transport?: TwilioSmsTransport,
): ClosingTransport
```
Map `deliverClosingSms` results to `ClosingTransportResult`: accepted+externalId → sent; failed → failed; unknown → blocked with `provider_outcome_unknown`. Catch `AppError` as failed. `deliver` uses `deliveryMode: "never_attempted"`; `reconcile` uses `"reconcile_only"`.

**Tests:** failed adapter/AppError records no pitch (unit-test the transport mapping); unknown outcome is blocked not sent. You may import `setClosingTransportForTests` only if you add a focused HTTP test in your exclusive file — prefer unit tests of `createMerchantOfferSmsTransport` with a fake `deliverClosingSms` if you inject a dep; otherwise test mapping helpers you export.

Keep `TwilioSmsTransport` as an optional override argument so existing closing tests stay green after conductor wiring.

**No live SMS or email.** Remaining gate: live merchant email/SMS to a controlled recipient/handset. Do not mark Linear Done.
