# Stripe webhook delivery acceptance — task 4.2

## Result: PASS

### Out-of-order extension — 2026-09-22 02:52 UTC

`webhook-delivery-evidence-2.json` passed all original checks plus genuine signed
out-of-order delivery. Run `fundlane-webhook-89470023-240c-4a9d-a4be-d20b2ce3bc12`
held CLI-forwarded requests in memory, delivered cancellation
`evt_1UIJosBP3qJwlwmsMOdglbWW` before older active update
`evt_1UIJorBP3qJwlwmsfGEWNLEB`, and verified both returned HTTP 200 with independent
durable receipts. Fresh provider reads kept the entitlement canceled and access
blocked after each delivery. The control company remained unchanged. Original
provider signatures were retained; no signatures or event payloads were fabricated.
All owned resources, listener output and disposable database were cleaned.

Executed **2026-09-22 02:21 UTC** against the explicitly verified FundLane sandbox
`acct_1UIDeIBP3qJwlwms`, using Stripe CLI **1.51.1** and SDK API version
`2026-08-26.dahlia`. The supplied sandbox key successfully authorized `stripe listen`;
there was no restricted-key permission blocker.

Runner: `scripts/stripe/acceptance-webhook.ts`.

| Acceptance | Observed evidence |
| --- | --- |
| Genuine delivery/signature | Stripe generated `customer.subscription.updated` and CLI forwarded its original body/signature over loopback HTTP. The imported application `src/app/api/webhooks/stripe/route.ts` POST handler returned **200**, `reconciled: true`. |
| Provider authenticity | The delivered event ID was independently retrieved through Stripe's Events API and verified as a test-mode subscription update. No locally generated signature or fabricated event was used. |
| Durable company-scoped receipt | An independent PostgreSQL connection read exactly one receipt for the event, expected workspace and expected customer after the HTTP response. |
| Entitlement reconciliation | The company obtained the verified paid `active` entitlement with one seat. A separate control company acquired no entitlement. |
| Duplicate delivery | Reposting the exact captured HTTP body/signature returned **200**, `duplicate: true`. Full receipt, entitlement and audit snapshots were unchanged. |
| Tampered payload | Appending one whitespace byte while retaining the genuine signature returned **400**. Full database snapshots were unchanged. |
| No redirect-based grant in this harness | A paid provider subscription alone left local entitlements empty before delivery. An untrusted success/session-ID URL returned 404 from the harness and did not change receipts, entitlements or audits. This is not a browser Checkout-return-page certification. |
| Real time | Node's real wall clock and the real CLI signature timestamp were used; no test clock, replay clock or Date mocking was enabled. |

## Traceable, non-secret identifiers

- Run: `fundlane-webhook-cdf3d120-79ac-410d-ac21-f86f9f8d5d90`
- Event: `evt_1UIJKiBP3qJwlwms70QdTBQ1`
- Workspace: `6a444861-8f6f-439a-8204-5b27fc0ca38d`
- Customer: `cus_VIvAsvbIQ5uzHe`
- Subscription: `sub_1UIJKeBP3qJwlwmsCz0IL44P`
- Disposable database: `fundlane_test_stripe_webhook_4340046d2f`
- Archived product: `prod_VIvAWSfqhYzByO`
- Archived prices: `price_1UIJKdBP3qJwlwmsSOy79oSy`, `price_1UIJKdBP3qJwlwms6fRE3mXb`

Machine-readable evidence is stored privately at
`/private/var/folders/4b/5cndy0z540n59lxr7hx1h0780000gn/T/opencode/webhook-delivery-evidence.json`
(mode 0600). It contains only IDs, checks and cleanup outcomes.

## Reproduction

Run from `nextjs-version/` with Node 24+, installed dependencies, Stripe CLI,
and the disposable PostgreSQL cluster listening on `127.0.0.1:55439`:

```sh
node --conditions=react-server \
  --env-file=/private/path/fundlane-stripe-sandbox.env \
  --import tsx scripts/stripe/acceptance-webhook.ts \
  --apply --evidence=/private/path/new-webhook-evidence.json
```

The private environment file supplies `STRIPE_SECRET_KEY`, `MCA_STRIPE_MODE=test`,
and `MCA_TEST_DATABASE_ADMIN_URL` for that disposable loopback cluster. The runner
verifies the fixed sandbox account before mutations and explicitly sets the CLI's
`STRIPE_API_KEY` environment override so a different default CLI profile cannot
select another account. Keys are never CLI arguments or printed.

The listener subscribes to `customer.subscription.updated` and
`customer.subscription.deleted` with `--latest`.
Its signing secret is captured in process memory; raw CLI output is confined to a
mode-0600 file inside a private temporary directory and deleted during cleanup.
The HTTP bridge calls the application's actual POST export and converts its
Response back to Node HTTP. It does not run Next.js/Vercel routing or deploy an
endpoint. Request bodies and signatures are retained only in process memory.

A new randomly named database is created and all checked Drizzle migrations are
applied through the existing test-database helper. The runner creates its own
tagged product/prices/customer/subscription and two synthetic local companies.
It does not reuse the core acceptance runner's resources.

## Cleanup and verification

All cleanup completed successfully:

- CLI listener stopped and loopback HTTP server closed.
- Owned subscription canceled and owned customer deleted.
- Owned prices and product archived (Stripe retains their historical records).
- Application connections closed and the disposable database dropped.
- Secret-bearing private listener output deleted.

Checks passed:

```sh
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint scripts/stripe/acceptance-webhook.ts
```

No production application changes, deployment, commit, or build artifacts were
needed. Task 4.2's real signature/delivery acceptance is independently evidenced;
hosted webhook endpoint configuration and browser return-page acceptance are
outside this loopback delivery result.
