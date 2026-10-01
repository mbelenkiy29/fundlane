# Synthetic merchant funnel browser checks

Run from `nextjs-version/` with Node 24 and locked app dependencies installed:

1. `node tests/browser/application-funnel/build.mjs`
2. `python3 -m http.server 55413 --bind 127.0.0.1 --directory output/playwright/t12`
3. `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs T12_CHROME_PATH=/absolute/path/to/chrome node tests/browser/application-funnel/run.mjs`

Use an installed Playwright runtime, or install it in a disposable temporary directory. Neither the application dependencies nor provider configuration is changed. All HTTP calls are intercepted with synthetic fixtures; no database or hosted upload is used. Screenshots stay in `output/playwright/t12/`. The actual `FunnelForm` and `PublicApplication` components and the app's Tailwind stylesheet are bundled, without adding a fixture route to the product.

The scenarios exercise 390 and 768 widths: explicit save, resume in a fresh component, lifecycle-write suppression, fractional entry, owner correction, failed save before submit, ready/blocked file counts, quarantine upload recovery feedback, preservation of local answers after upload, inactive-link load errors and long-value overflow. Server scope/correlation and real submission are covered separately in disposable database tests; intercepted browser responses do not establish hosted Auth/Storage/scanner readiness.
