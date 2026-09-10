# Lane B cross-review: attachment and receipt queues

Reviewed September 8, 2026 after the concurrency and lost-response fixes. This was a narrow read-only review of `src/lib/mca/intake/repository.ts`, `service.ts`, `email.ts`, and the queue regression in `tests/intake-core.test.ts`.

## Result

No blocking issue remains in the reviewed queue paths.

- Attachment workers acquire work in an immediate transaction. Pending/retryable work must be due; an active fetch cannot be claimed until its lease expires. Every attempt gets a new opaque token.
- Attachment completion compares the active token. A stale worker cannot change state or replace the stored document after a lease is reclaimed. The document write uses a stable intake/attachment idempotency key, so replay after a worker loss resolves to the same vault record.
- Receipt workers use the same transaction, lease, token, and compare-and-set pattern. Sent receipts are never eligible for another claim.
- Receipt transport uses the stable `Idempotency-Key: intake-receipt:<receipt-id>` on every attempt. This covers the ambiguous case where the provider accepted delivery but the response was lost, assuming the configured provider honors its idempotency contract.
- The focused regression holds the first attachment and receipt workers open while starting a second worker, proves only one external call occurs, expires and reclaims abandoned attachment and receipt leases, and proves stale completions cannot overwrite recovered state. It also proves the receipt transport key remains identical across a lost-response retry.

## Verification

`node --conditions=react-server --import tsx --test --test-concurrency=1 --test-name-pattern='workers claim attachments and receipts once' tests/intake-core.test.ts`

Result: 1 passed, 0 failed.

The test uses synthetic fetch/storage/provider doubles. It does not claim that a production email webhook supports idempotency; deployment must select and verify a provider that honors the sent key.
