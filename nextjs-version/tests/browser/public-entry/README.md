# Public-entry browser checks

Run in the repo-backed cloud environment with app dependencies installed. Provider requests are intercepted with synthetic fixtures; no real Checkout, account, email or company is created.

```sh
node tests/browser/public-entry/build.mjs
MCA_PLAYWRIGHT_MODULE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core \
MCA_BROWSER_EXECUTABLE_PATH=/usr/lib/chromium/chromium \
node tests/browser/public-entry/run.mjs
```

Without overrides the runner resolves `playwright-core` and its installed Chromium. `MCA_PUBLIC_BROWSER_DIRECTORY` selects the artifact directory (default `/tmp/task6-public-entry-browser`); results are written to `results.json`. `MCA_BROWSER_CASE` optionally limits named cases.

The suite includes separate Login, mobile keyboard wrapping and overflow restoration, direct trial start, multiple simultaneous Get Started controls, cross-tab browser binding, unavailable browsers, neutral retry, verified identity/MFA and explicit company claim.
