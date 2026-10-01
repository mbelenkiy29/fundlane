# Synthetic platform browser verification

Run from `nextjs-version/`:

```sh
node tests/browser/platform/build.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs PLATFORM_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tests/browser/platform/run.mjs
```

The build bundles the actual platform pages and client components with synthetic server services and lightweight Next router/link substitutes. The runner starts its own loopback server and intercepts API calls. It checks all portal pages at 1440 and 390 pixels in both themes, mobile navigation, account links, filters, pagination, audit step-up, company/SMS actions, Roadmap publication, and loading/error/stale states. Screenshots and a JSON report stay in `output/playwright/platform-redesign/`.

This verifies UI behavior without production credentials, hosted reads, notifications, or provider calls. Real Supabase sessions and hosted acceptance remain separate from these fixtures.
