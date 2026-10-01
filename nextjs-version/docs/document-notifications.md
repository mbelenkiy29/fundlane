# Document alerts and optional reminders

The document vault includes **Document alerts**. Its read-only snapshot derives the existing four document buckets (application, bank statement, driver license, voided check) and existing open/received closing stipulations. It does not create requirements or consent records.

A broker selects an unresolved missing/requested/stale condition and queues a broker email alert. Optional merchant reminders require explicit selection, enabled company document notification policy, current consent through existing services, a published merchant template and an existing persisted closing request link. Email also requires a usable merchant sender. The result reports each audience independently; a blocked merchant reminder does not erase a broker alert. **Queued** means persisted for the existing notification runtime, not sent.

Published reminder templates use `{{document_request_url}}` and optionally `{{document_request_label}}`. Server guards resolve these values from the current tenant/deal/category/stipulation-bound persisted request. Document reminders reject the old generated upload URL variables, including republishing one after enqueue. Values are escaped by the existing renderer. No link tokens are returned in the alert snapshot or broker payload.

## Document conditions

- Only malware-clean current lineage versions satisfy requirements. Pending scans, validation-only `ready`, failed uploads/scans and quarantined documents do not.
- Statement freshness uses the immediately preceding completed **UTC calendar month**, with month/year/leap-day boundaries. Underwriting statement period records supply the covered month; upload dates and filenames do not. Future, malformed and duplicate periods do not satisfy freshness.
- A requested stipulation resolves when verified/waived or its linked current clean document matches the requested category. Recategorization or an unsafe replacement leaves the request unresolved.
- Closed/funded deals suppress conditions. At dispatch, a changed month, resolved condition, expired/revoked/consumed request, access loss, disabled company policy or consent/optout change suppresses delivery.

## Integration and operation

`src/lib/mca/documents/notification-service.ts` exposes `documentNotificationSnapshot` and `enqueueDocumentNotifications`. `src/lib/mca/documents/notification-condition.ts` registers type `document`, version `1`, and is explicitly bootstrapped by the foundation worker in each process. The authenticated session API is `/api/mca/documents/notifications`; it reads snapshots and queues approved selected events. The existing comms notification runtime handles delivery, uncertainty, receipts, safe retries and reconciliation. `MCA_NOTIFICATION_RUNTIME=enabled` remains an external runtime activation gate; no transport or scheduler is introduced here.

Stable event identities include deal/condition and, for merchant reminders, request link identity. Repeated actions retain the original event schedule/approval and reject changed content under the same identity. Accepted/uncertain events are not replayed; reconcile uncertain outcomes through the foundation. This producer is action-driven: it does not install an automatic periodic document discovery sweep. Automated discovery would require a separately approved existing-runtime integration with a bounded eligible-deal/recipient policy.

## External gates

No provider traffic, production credentials, hosted migrations, live consent claims or real merchant data were used. Apply/review the notification foundation prerequisite before this stacked feature. Confirm a safe application origin, published templates, existing closing requests, company policy, sender/provider configuration, actual consent, and hosted Auth/Storage acceptance before activation. This task does not change consent wording or enable any of those gates.
