# CSV imports and home trends

Spreadsheet uploads now accept CSV only in new imports, bulk updates, and historical imports. The parser treats values as text, preserves leading zeroes and literal formulas, handles quoted commas/newlines and escaped quotes, and rejects malformed quoting, binary control bytes, oversized files, excess columns and excess rows. Existing 25 MiB, 10,000-row and 200-column limits remain. No spreadsheet engine or external antivirus API handles CSV parsing. Existing mapping, review, authorization, encrypted staging and commit semantics remain intact.

Google Sheets are exported as CSV (the first sheet); Excel files must be exported to CSV before import. Historical import-format types are retained so existing records remain readable. PDF, bank-statement, image and document attachment workflows remain separate and retain their existing scan requirements. The closed Cloudmersive PR is not included, and there is no new scanner subscription requirement for CSV imports.

Home adds interactive 12-month funding/commission charts, 14-day expected/received collection lines, merchant activity and recent financial movements, sourced from the existing authorized home KPI response. Charts label their own time windows independently of the MTD/YTD summary controls. These are transaction trends, not reconstructed bank balance histories. Restricted amounts do not render charts. Mobile KPI cards use two columns; zero-valued sparkline series render flat rather than disappearing.

Verification: 36 focused tests pass across CSV parsing, import core, historical uploads, home KPI mapping and home KPI authorization. The near-maximum CSV fixture contains 10,000 rows and 200 columns and parses without truncation. Browser checks with temporary synthetic fixtures cover desktop/mobile rendering, funding/commission switching, and restricted financial views. The temporary preview route was removed after testing.

Production build, TypeScript, and targeted ESLint passed. Graphify update and cluster-only were run from the checkout root. Changes are local on `feat/csv-imports-home-trends`; no production deployment was performed.
