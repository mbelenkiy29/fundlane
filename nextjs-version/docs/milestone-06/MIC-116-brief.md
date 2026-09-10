# MIC-116 brief — Lead source CAC and ROI

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-116
**Depends on:** MIC-110 (Wave 1), MIC-112

Exclusive: `src/lib/mca/reports/lead-roi.ts`, `src/app/api/mca/reports/lead-roi/**`, `src/components/mca/reports/lead-roi.tsx`, `tests/milestone06-lead-roi.test.ts`, docs.

Frozen: cost per funded merchant vs per funded deal; ROI = (attributed collected commission − purchase cost) / purchase cost; zero-cost → undefined not infinity; renewals do not inflate acquisition counts. Conductor mounts on /reports.
