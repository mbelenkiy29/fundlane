# MIC-158 brief — Outbound workflow webhooks

Exclusive: `src/lib/mca/comms/webhooks.ts`, `src/app/api/mca/comms/webhooks/**`, `src/components/mca/comms/webhook-console.tsx`, `tests/milestone06-webhooks.test.ts`, docs.

Frozen: versioned envelopes for offers, deal transitions, assignments, submissions; transactional outbox; HMAC; bounded retries; replay keeps event_id; SSRF-safe destinations; assignment notifies only authorized configured recipients. Tables `mca_workflow_webhook_*`. Register `registerCommsJob("webhook_outbox", ...)`.
