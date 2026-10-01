# T0 local acceptance foundation

## Design
Prove local acceptance for #35/#46/#49 using checked migrations, synthetic companies and restricted users, existing document/job services, and disposable loopback PostgreSQL. Add an encrypted synthetic recovery integration drill that restores actual pg_dump output and separately captured private document bytes, validates linked rows and hashes, and exercises negative missing/corrupt/wrong-key cases. This is a local staging equivalent for application SQL/services, not Supabase Auth/Storage or hosted scanner proof.

Reuse documents-core, jobs-worker, foundation-core and ops-backup-safety coverage. Do not change shared auth/schema or scheduler contracts. All data, keys and files are disposable, no provider sends, no hosted resource changes. Archive encryption uses Node AES-256-GCM only within this test fixture; the operational backup tool still uses age and requires independent real-age acceptance.

## Deliverables
- Reproducible loopback PostgreSQL runner with unique port and cleanup.
- Real DB plus document-byte restore integration test and sanitized duration/hash diagnostics.
- Acceptance matrix/runbook and explicit blocked hosted/operator gates.

## Limits
Simulated killed claims are lease expiry tests, not literal production process interruption. Scanner fixtures are safe synthetic responses, not engine malware detection. No hosted readiness claim, alert delivery, provider activation, or launch approval.
