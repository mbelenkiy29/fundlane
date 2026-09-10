# MIC-117 brief — Follow-up sender fallback, CC and BCC

**Depends on:** MIC-115
Exclusive: `src/lib/mca/comms/sender-fallback.ts`, `src/app/api/mca/comms/sender-fallback/**`, `tests/milestone06-sender-fallback.test.ts`, docs.

Frozen: workspace-shared vs originator merchant sender; verified fallback used once when originator is down; template CC and fallback BCC independent from submission rep-copy; neither sender available → visible failure, not success.
