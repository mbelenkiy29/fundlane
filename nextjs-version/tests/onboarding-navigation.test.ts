import assert from "node:assert/strict"
import test from "node:test"
import { interactionSetup, renderSetup, runClient } from "./helpers/public-entry-render"

test("changing Login email clears stale password errors", () => {
  const result = runClient(`${interactionSetup}
    const { SignInForm } = require("./src/app/(auth)/sign-in/sign-in-form.tsx");
    (async () => {
      let view = render(SignInForm);
      input(view.tree, "email").props.onChange({ target: { value: "unknown@example.test" } });
      await submit(render(SignInForm).tree);
      response = async () => { throw new Error("Email or password is incorrect."); };
      await submit(render(SignInForm).tree);
      view = render(SignInForm); assert.match(view.markup, /role="alert"/);
      button(view.tree, "Change email").props.onClick();
      console.log(JSON.stringify(render(SignInForm).markup));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `) as string
  assert.doesNotMatch(result, /role="alert"/)
  assert.match(result, />Next</)
})

test("pricing and only the exact enrollment route remain public with rollout switches disabled", () => {
  const result = runClient(`const paths=require('./src/lib/mca/app-paths.ts');console.log(JSON.stringify(['/pricing','/enrollment','/enrollment/extra'].map(paths.anonymousRequestDisposition)));`, { MCA_PUBLIC_PRICING_ENABLED: "false" })
  assert.deepEqual(result, ["public", "public", "not-found"])
})

const launchEnv = {
  MCA_PUBLIC_PRICING_ENABLED: "true",
  MCA_MARKETING_TRIAL_CTA_ENABLED: "true",
  MCA_SIGNUP_MODE: "open",
  MCA_ONBOARDING_RUNTIME_ENABLED: "true",
  MCA_STRIPE_FIRST_ONBOARDING_ENABLED: "true",
  MCA_STRIPE_BILLING_ENABLED: "true",
  MCA_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_synthetic",
  STRIPE_BASE_PRICE_ID: "price_syntheticbase",
  STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_syntheticseats",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_synthetic",
}

test("shared app path metadata still loads in a browser consumer", () => {
  const result = runClient(`
    const { buildSync } = require("esbuild");
    const bundle = buildSync({ entryPoints: ["src/lib/mca/app-paths.ts"], bundle: true, write: false, platform: "browser", format: "cjs" });
    const module = { exports: {} };
    new Function("module", "exports", "process", bundle.outputFiles[0].text)(module, module.exports, { env: {} });
    console.log(JSON.stringify({ title: module.exports.DEALS_PAGE_TITLE, signIn: module.exports.anonymousRequestDisposition("/sign-in") }));
  `)
  assert.deepEqual(result, { title: "Deals", signIn: "public" })
})

test("desktop, mobile and footer separate existing Login from Get Started pricing", () => {
  const markup = runClient(`${renderSetup}
    const { MarketingShell } = require("./src/components/marketing/shell.tsx");
    (async () => console.log(JSON.stringify(renderToStaticMarkup(await MarketingShell({ children: null })))))();
  `, launchEnv) as string
  const desktop = markup.match(/<div class="fl-nav-actions">([\s\S]*?)<\/div>/)?.[1] ?? ""
  const mobile = markup.match(/<nav aria-label="Mobile navigation">([\s\S]*?)<\/nav>/)?.[1] ?? ""
  const footer = markup.match(/<nav aria-label="Footer navigation">([\s\S]*?)<\/nav>/)?.[1] ?? ""
  for (const surface of [desktop, mobile, footer]) {
    assert.match(surface, /href="\/sign-in"[^>]*>Login<\/a>/)
    assert.match(surface, /href="\/pricing"[^>]*>Get Started<\/a>/)
    assert.doesNotMatch(surface, /href="\/sign-up"|Start free trial/)
  }
})

test("home purchase CTAs open pricing without an account, company or seat form", () => {
  const markup = runClient(`${renderSetup}
    const { MarketingHome } = require("./src/components/marketing/home.tsx");
    (async () => { const page = MarketingHome(); console.log(JSON.stringify(renderToStaticMarkup(await page.type(page.props)))); })();
  `, launchEnv) as string
  const main = markup.match(/<main[\s\S]*?<\/main>/)?.[0] ?? ""
  assert.equal((main.match(/href="\/pricing"[^>]*>Get Started<\/a>/g) ?? []).length, 3)
  assert.doesNotMatch(main, /href="\/sign-up"|<input[^>]+name="(?:email|password|companyName|seats)"/)
})

test("pricing discloses the first-user offer, required card and automatic conversion", () => {
  const markup = runClient(`${renderSetup}
    const PricingPage = require("./src/app/(dashboard)/pricing/page.tsx").default;
    (async () => { const page = PricingPage(); console.log(JSON.stringify(renderToStaticMarkup(await page.type(page.props)))); })();
  `, launchEnv) as string
  assert.match(markup, /\$399 per month per company/)
  assert.match(markup, /including the first user/)
  assert.match(markup, /base monthly first-user price of \$399 per month/)
  assert.match(markup, /applicable Checkout discounts and tax/)
  assert.match(markup, /14-day free trial/)
  assert.match(markup, /A card is required/)
  assert.match(markup, /automatically[^<]*\$399[^<]*month[^<]*unless[^<]*cancel/i)
  assert.match(markup, /Sales tax is added where applicable/)
  assert.match(markup, /Stripe[^<]*first scheduled charge date/)
  assert.doesNotMatch(markup, /href="\/sign-up"|<form|name="(?:companyName|email|password|seats)"/)
})

test("pricing remains truthful and keeps Login available when creation is disabled", () => {
  const markup = runClient(`${renderSetup}
    const PricingPage = require("./src/app/(dashboard)/pricing/page.tsx").default;
    (async () => { const page = PricingPage(); console.log(JSON.stringify(renderToStaticMarkup(await page.type(page.props)))); })();
  `, { ...launchEnv, MCA_STRIPE_FIRST_ONBOARDING_ENABLED: "false" }) as string
  assert.match(markup, /trial enrollment is currently unavailable/i)
  assert.match(markup, /<button[^>]*disabled[^>]*>Start 14-day free trial/)
  assert.match(markup, /href="\/sign-in"[^>]*>Login<\/a>/)
  assert.doesNotMatch(markup, /href="\/sign-up"|no.card|start paid|buy now/i)
})

test("email Next stages password locally, keeps recovery and preserves neutral retry", () => {
  const result = runClient(`${interactionSetup}
    const { SignInForm } = require("./src/app/(auth)/sign-in/sign-in-form.tsx");
    (async () => {
      let view = render(SignInForm);
      const initial = view.markup;
      assert.equal(input(view.tree, "password"), undefined);
      assert.ok(button(view.tree, "Next"));
      input(view.tree, "email").props.onChange({ target: { value: "unknown@example.test" } });
      view = render(SignInForm);
      await submit(view.tree);
      view = render(SignInForm);
      assert.equal(calls.length, 0);
      assert.ok(input(view.tree, "password"));
      input(view.tree, "password").props.onChange({ target: { value: "synthetic-password" } });
      response = async () => { throw new Error("Email or password is incorrect. Verify your email or recover your account if needed."); };
      await submit(render(SignInForm).tree);
      const failed = render(SignInForm);
      assert.equal(button(failed.tree, "Login").props.disabled, false);
      response = async () => ({});
      await submit(failed.tree);
      console.log(JSON.stringify({ initial, failed: failed.markup, calls, destination: window.location.href }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `)
  assert.match(result.initial, /for="sign-in-email"/)
  assert.match(result.initial, /Continue with Google/)
  assert.match(result.initial, /migrated account/)
  assert.match(result.initial, /New team members join through an invitation/)
  assert.doesNotMatch(result.initial, /href="\/sign-up"|Create a company workspace/)
  assert.match(result.failed, /role="alert"[^>]*>Email or password is incorrect/)
  assert.match(result.failed, /for="sign-in-password"/)
  assert.match(result.failed, /href="\/forgot-password"/)
  assert.deepEqual(result.calls, [
    { path: "/api/auth/sign-in", input: { email: "unknown@example.test", password: "synthetic-password" } },
    { path: "/api/auth/sign-in", input: { email: "unknown@example.test", password: "synthetic-password" } },
  ])
  assert.equal(result.destination, "/accept-invite?token=abcdefghijklmnopqrst")
})

test("verification recovery stays signup verification and MFA retains its request contract", () => {
  const result = runClient(`${interactionSetup}
    const { SignInForm } = require("./src/app/(auth)/sign-in/sign-in-form.tsx");
    (async () => {
      let view = render(SignInForm);
      assert.ok(button(view.tree, "Next"));
      input(view.tree, "email").props.onChange({ target: { value: "invited@example.test" } });
      await submit(render(SignInForm).tree);
      view = render(SignInForm);
      await button(view.tree, "Resend email verification").props.onClick();
      await new Promise(resolve => setImmediate(resolve));
      view = render(SignInForm);
      const verification = view.markup;
      input(view.tree, "code").props.onChange({ target: { value: "123456" } });
      await submit(render(SignInForm).tree);
      states.length = 0;
      response = async path => path === "/api/auth/sign-in" ? { mfaRequired: true } : {};
      view = render(SignInForm);
      input(view.tree, "email").props.onChange({ target: { value: "invited@example.test" } });
      await submit(render(SignInForm).tree);
      view = render(SignInForm);
      input(view.tree, "password").props.onChange({ target: { value: "synthetic-password" } });
      await submit(render(SignInForm).tree);
      view = render(SignInForm);
      const mfa = view.markup;
      input(view.tree, "code").props.onChange({ target: { value: "recovery-code" } });
      await submit(render(SignInForm).tree);
      console.log(JSON.stringify({ verification, mfa, calls }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `)
  assert.match(result.verification, /Verify your email/)
  assert.doesNotMatch(result.verification, /Verify your sign-in/)
  assert.match(result.mfa, /for="sign-in-totp"/)
  assert.match(result.mfa, /single-use recovery code/)
  assert.deepEqual(result.calls[0], { path: "/api/auth/resend", input: { email: "invited@example.test", next: "/accept-invite?token=abcdefghijklmnopqrst" } })
  assert.deepEqual(result.calls[1], { path: "/api/auth/verify", input: { email: "invited@example.test", code: "123456" } })
  assert.deepEqual(result.calls.at(-1), { path: "/api/auth/mfa", input: { action: "challenge", code: "recovery-code" } })
})

test("Google keeps the safe continuation and browser navigation with busy controls", () => {
  const result = runClient(`${interactionSetup}
    const { SignInForm } = require("./src/app/(auth)/sign-in/sign-in-form.tsx");
    (async () => {
      let finish;
      response = () => new Promise(resolve => { finish = resolve; });
      const initial = render(SignInForm);
      const pending = button(initial.tree, "Continue with Google").props.onClick();
      const busy = render(SignInForm);
      assert.equal(input(busy.tree, "email").props.disabled, true);
      assert.equal(form(busy.tree).props["aria-busy"], true);
      finish({ url: "https://synthetic-provider.test/authorize" });
      await pending;
      console.log(JSON.stringify({ calls, navigations, markup: busy.markup }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `)
  assert.deepEqual(result.calls, [{ path: "/api/auth/google", input: { next: "/accept-invite?token=abcdefghijklmnopqrst" } }])
  assert.deepEqual(result.navigations, ["https://synthetic-provider.test/authorize"])
  assert.match(result.markup, /Connecting to Google/)
})

test("magic link remains existing-user login and email changes return to local Next", () => {
  const result = runClient(`${interactionSetup}
    const { SignInForm } = require("./src/app/(auth)/sign-in/sign-in-form.tsx");
    (async () => {
      const props = { magicLinkEnabled: true };
      let view = render(SignInForm, props);
      input(view.tree, "email").props.onChange({ target: { value: "member@example.test" } });
      await submit(render(SignInForm, props).tree);
      view = render(SignInForm, props);
      assert.equal(input(view.tree, "password").props.autoFocus, true);
      input(view.tree, "password").props.onChange({ target: { value: "must-be-cleared" } });
      view = render(SignInForm, props);
      await button(view.tree, "Email me a sign-in link").props.onClick();
      view = render(SignInForm, props);
      const sent = view.markup;
      button(view.tree, "Change email").props.onClick();
      view = render(SignInForm, props);
      assert.ok(button(view.tree, "Next"));
      assert.equal(input(view.tree, "password"), undefined);
      await submit(view.tree);
      view = render(SignInForm, props);
      assert.equal(input(view.tree, "password").props.value, "");
      console.log(JSON.stringify({ sent, calls }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `)
  assert.match(result.sent, /If an account exists, we&#x27;ve sent a link/)
  assert.deepEqual(result.calls, [{ path: "/api/auth/magic-link", input: { email: "member@example.test", next: "/accept-invite?token=abcdefghijklmnopqrst" } }])
})

test("trial presentation prevents repeated starts and offers a sanitized retry after failure", () => {
  const result = runClient(`${interactionSetup}
    const { TrialStartButton } = require("./src/components/marketing/trial-start-button.tsx");
    (async () => {
      let attempts = 0, rejectStart;
      const props = { available: true, onStart: async () => { attempts++; await new Promise((resolve, reject) => { rejectStart = reject; }); } };
      const initial = render(TrialStartButton, props);
      const start = button(initial.tree, "Start 14-day free trial").props.onClick;
      const first = start();
      await start();
      const busy = render(TrialStartButton, props);
      assert.equal(button(busy.tree, "Opening secure Checkout…").props.disabled, true);
      rejectStart(new Error("provider payload must not be shown"));
      await first;
      const failed = render(TrialStartButton, props);
      assert.equal(button(failed.tree, "Start 14-day free trial").props.disabled, false);
      const retry = button(failed.tree, "Start 14-day free trial").props.onClick();
      rejectStart(new Error("another raw provider error"));
      await retry;
      console.log(JSON.stringify({ attempts, busy: busy.markup, failed: failed.markup }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `)
  assert.equal(result.attempts, 2)
  assert.match(result.busy, /aria-busy="true"/)
  assert.match(result.failed, /role="alert"/)
  assert.match(result.failed, /Please try again/)
  assert.doesNotMatch(result.failed, /provider payload|raw provider error/)
})

test("trial presentation fails closed without availability or an integrated start callback", () => {
  const result = runClient(`${renderSetup}
    const { TrialStartButton } = require("./src/components/marketing/trial-start-button.tsx");
    console.log(JSON.stringify([false, true].map(available => renderToStaticMarkup(React.createElement(TrialStartButton, { available })))));
  `) as string[]
  for (const markup of result) {
    assert.match(markup, /trial enrollment is currently unavailable/i)
    assert.match(markup, /disabled/)
    assert.match(markup, /href="\/sign-in"[^>]*>Login<\/a>/)
    assert.doesNotMatch(markup, /href="\/sign-up"/)
  }
})
