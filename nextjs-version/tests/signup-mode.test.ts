import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { migratedAccountNoticeEnabled, signupMode } from "../src/lib/mca/signup-mode"

function renderSignIn(mode: string | undefined, showNotice: string | undefined, magicLink = false) {
  const script = `
    const React = require("react");
    const { mock } = require("node:test");
    mock.module("server-only", { exports: {} });
    const { renderToStaticMarkup } = require("react-dom/server");
    const { SignInForm } = require("./src/app/(auth)/sign-in/sign-in-form.tsx");
    console.log(JSON.stringify({ signin: renderToStaticMarkup(React.createElement(SignInForm, { magicLinkEnabled: process.env.MCA_MAGIC_LINK_ENABLED === "true", inviteOnly: process.env.MCA_SIGNUP_MODE === "invite_only", showMigratedAccountNotice: process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE !== "false" })) }));
  `
  const env = { ...process.env }
  if (mode === undefined) delete env.MCA_SIGNUP_MODE
  else env.MCA_SIGNUP_MODE = mode
  if (showNotice === undefined) delete env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE
  else env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE = showNotice
  env.MCA_MAGIC_LINK_ENABLED = String(magicLink)
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { encoding: "utf8", env })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as { signin: string }
}

function signUpDestination(mode: string | undefined, stripeFirst = false) {
  const script = `
    const { mock } = require("node:test");
    mock.module("next/navigation", { exports: { redirect: destination => { throw { destination } } } });
    const SignUpPage = require("./src/app/(auth)/sign-up/page.tsx").default;
    let destination;
    try { SignUpPage() } catch (error) { destination = error.destination }
    console.log(JSON.stringify({ destination }));
  `
  const env = { ...process.env }
  if (mode === undefined) delete env.MCA_SIGNUP_MODE
  else env.MCA_SIGNUP_MODE = mode
  if (stripeFirst) env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED = "true"
  else delete env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { encoding: "utf8", env })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as { destination: string }
}

test("unset and invalid signup modes retain open mode while Login has no creation link", () => {
  for (const value of [undefined, "OPEN", "closed", "true"]) {
    if (value === undefined) delete process.env.MCA_SIGNUP_MODE
    else process.env.MCA_SIGNUP_MODE = value
    assert.equal(signupMode(), "open")
    const markup = renderSignIn(value, undefined)
    assert.match(markup.signin, />Next</)
    assert.doesNotMatch(markup.signin, /Create a company workspace|href="\/sign-up"/)
  }
  delete process.env.MCA_SIGNUP_MODE
})

test("public /sign-up always redirects home", () => {
  for (const value of [undefined, "open", "invite_only"]) {
    assert.equal(signUpDestination(value).destination, "/")
    assert.equal(signUpDestination(value, true).destination, "/")
  }
})

test("invite-only Login hides the creation link", () => {
  const markup = renderSignIn("invite_only", undefined)
  assert.match(markup.signin, /New team members join through an invitation/)
  assert.doesNotMatch(markup.signin, /Create a company workspace|href="\/sign-up"|Book a demo|href="\/demo"/)
})

test("migrated-account helper defaults to shown and can be hidden", () => {
  delete process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE
  assert.equal(migratedAccountNoticeEnabled(), true)
  assert.match(renderSignIn(undefined, undefined).signin, /migrated account/)
  process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE = "false"
  assert.equal(migratedAccountNoticeEnabled(), false)
  assert.doesNotMatch(renderSignIn(undefined, "false").signin, /migrated account/)
  delete process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE
})

test("invite-only Login starts with email Next and hides the migrated-account helper", () => {
  const markup = renderSignIn("invite_only", "false", true).signin
  assert.match(markup, />Next</)
  assert.match(markup, /Continue with Google/)
  assert.doesNotMatch(markup, /Email me a sign-in link/)
  assert.match(markup, /New team members join through an invitation/)
  assert.doesNotMatch(markup, /Create a company workspace|migrated account/)
})
