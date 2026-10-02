# Protected enrollment operator browser checks

This renders the actual `/platform/onboarding` page, platform chrome, queue and recovery components. Existing server page guards are synthetic fixtures; all API calls are intercepted on a loopback server. It tests UI behavior, not provider authority or live delivery. No credentials, hosted database, network provider, browser download or application dependency is required.

From `nextjs-version`, use the installed Node 24 and Chrome/Playwright paths:

```sh
PLATFORM_BROWSER_OUT=/tmp/fundlane-onboarding-operator PLATFORM_BROWSER_ENTRY=tests/browser/onboarding-operator/entry.tsx node tests/browser/platform/build.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs PLATFORM_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tests/browser/onboarding-operator/run.mjs
```

The runner records 22 named checks, exact explicit POST bodies and read URLs in `/tmp/fundlane-onboarding-operator/report.json`, with four light/dark 1440/390px screenshots. Set `PLATFORM_BROWSER_OUT` on both commands to retain artifacts at another task-owned path outside the product tree. Failed runs retain completed assertions in `failed-report.json`. `OPERATOR_RED=1` limits the run to the inspection/detail feature check used before implementation.

Covered: four reviewed action DTOs; separate fresh draft step-up; receipt-owned message identity; pending duplicate guards; manual/30-second/visibility refresh; same-query stale versus denied snapshots; immutable drafts and revision conflicts; filter/pagination/selected-ID abort; runtime-off diagnostics; no-store/same-origin requests; labels, focus, horizontal overflow and page errors. Existing real-PG server regressions separately cover leases, provider/proof authority, negative evidence, suppression, revocation and audit rollback.

The actual React entry runs inside `StrictMode`. Set `OPERATOR_STRICT_READ=1` on the runner for the five-check read-lifecycle regression only: effect replay starts a replacement, delayed abandoned finalization cannot clear the replacement's loading/deduplication, replacement enables an explicit draft, stale reads preserve it with actions disabled, and denied reads clear diagnostics/draft. This focused mode records `strict-read-report.json` and sends zero POSTs.
