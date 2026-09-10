# MIC-147 brief — Personalized message templates and offer/document variables

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-147
**Depends on:** MIC-156 (Wave 1), MIC-109, MIC-121, MIC-106 contracts
**Do not start until MIC-156 is review-clean.**

Exclusive: `src/lib/mca/comms/templates.ts`, `src/app/api/mca/comms/templates/**`, `src/components/mca/comms/template-editor.tsx`, `tests/milestone06-templates.test.ts`, report/acceptance docs.

Frozen: typed variable registry; channel-aware escaping; all/selected/highest offers; scoped upload links; version history on `mca_message_templates` / versions. Unknown variable blocks publish. Merchant templates cannot access commissions or another deal.
