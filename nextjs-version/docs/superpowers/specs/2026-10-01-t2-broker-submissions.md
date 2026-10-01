# T2 broker-controlled submissions

User-approved design: every outbound lender submission requires broker approval of the exact package and destination. Automatic lending/submission is off. Reuse application submission previews, immutable derivatives, attempt reservations, reply ingestion, extraction review and existing offer/accounting bridges.

At delivery, require a confirmed durable application preview scoped to workspace/deal/confirmation key, with a human creator and identical approved package. Reject automatic intent and missing/mutated approval before invoking a provider. Never rebuild a reviewed package at delivery. Older unapproved jobs must return to review. Interrupted approved sends remain uncertain until recorded operator reconciliation; no resend bypass via environment flags.

Reply extraction confirmation must pin the complete proposal (terms, evidence and matched job), not classification alone. Corrections must also reference the reviewed proposal. Check again under a locked reply row so concurrent re-extraction cannot change broker-approved terms. Preserve existing offer IDs, cents conversion, funded-terminal guards and reply deduplication.

Mailbox readiness uses owner PR208 at exact pin e7b9361c1d5cf4451d8fd71825f7f1737759c158. This reports incoming company mailbox activation separately from submission sender readiness. No invented direct-funder integrations; simulated providers and disposable PostgreSQL only. Existing email reconciliation needs broker authority and deal access. No production activation or security grants.

Generic deals retain a supported broker path: Submit to funders → Prepare preview → review exact email, attachment checksums and destination → Approve and send. Invalid destinations appear as independently rejected destinations. Preview confirmation is idempotent, expires after 30 minutes and rejects changed deal/package/sender/template settings. Legacy assistant confirmation gives this supported UI path; write API keys cannot act as human approvers.

After unknown delivery, an administrator records an accepted/not-sent result with evidence in the submissions panel before a new approved send. A receipt survives later audit/cache failures; retry completes bookkeeping without invoking the provider. Received terms require a full proposal key and locked reply recheck before creating/updating existing offers.

Migration 0070 only permits a generic preview's intake linkage to be null. Combined branch integration must reindex notifications0068, voice0069, then T2 0070; this branch contains only its real journal entry. All live-provider credentials, consumer/cron activation, direct funder contracts and full build/aggregate validation are separate remaining gates.
