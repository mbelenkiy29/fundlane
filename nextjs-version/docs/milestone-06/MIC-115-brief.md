# MIC-115 brief — Scheduled merchant follow-ups

**Depends on:** MIC-147
Exclusive: `src/lib/mca/comms/followups.ts`, `src/app/api/mca/comms/followups/**`, `src/components/mca/comms/followup-panel.tsx`, `tests/milestone06-followups.test.ts`, docs.

Frozen: status+channel+local schedule+template+retry; recheck status/consent/recipient before send; stage change skips; unique occurrence key on `mca_followup_occurrences`. Register `registerCommsJob("followup", ...)`.
