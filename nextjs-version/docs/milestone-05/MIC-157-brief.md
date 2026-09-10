# MIC-157 brief — PSF document request and webhook-to-signature workflow

Software exists: generic HTTPS webhook + DocuSeal provider (`closing/psf-docuseal-service.ts`). MIC-158 (M6 outbound webhooks) is now Done. Linear is In Progress for DocuSeal credentials / approved PSF template / controlled signing.

**Exclusive:** `src/lib/mca/closing/psf-activation.ts` (only if a real remaining software gap), `tests/milestone05-mic-157.test.ts` (optional), `docs/milestone-05/MIC-157-report.md`, `docs/milestone-05/MIC-157-acceptance.md`.

**Do not edit:** `closing/service.ts`, `psf-docuseal-service.ts` (read-only unless a proven bug — then `NEEDS_CONDUCTOR`), `comms/webhooks.ts`, schema, Linear.

Prove: failed webhook stays failed; confirmation reuses one external request identity; bank fields encrypted/masked; API keys cannot configure PSF.

Do not invent a DocuSeal template or paste tokens. Remaining gate: `MCA_DOCUSEAL_PSF_CONNECTIONS_JSON` + approved template/bindings + controlled signing run. See `docs/milestone-05/docuseal-psf-activation.md`. **No live DocuSeal request.** Do not mark Linear Done.
