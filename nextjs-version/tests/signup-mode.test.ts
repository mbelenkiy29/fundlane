import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { migratedAccountNoticeEnabled, signupMode } from "../src/lib/mca/signup-mode"

function renderAuth(mode: string | undefined, showNotice: string | undefined, magicLink = false) {
  const script = `
    const React = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    const SignUpPage = require("./src/app/(auth)/sign-up/page.tsx").default;
    const { SignInForm } = require("./src/app/(auth)/sign-in/sign-in-form.tsx");
    console.log(JSON.stringify({ signup: renderToStaticMarkup(React.createElement(SignUpPage)), signin: renderToStaticMarkup(React.createElement(SignInForm, { magicLinkEnabled: process.env.MCA_MAGIC_LINK_ENABLED === "true", inviteOnly: process.env.MCA_SIGNUP_MODE === "invite_only", showMigratedAccountNotice: process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE !== "false" })) }));
  `
  const env = { ...process.env }
  if (mode === undefined) delete env.MCA_SIGNUP_MODE
  else env.MCA_SIGNUP_MODE = mode
  if (showNotice === undefined) delete env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE
  else env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE = showNotice
  env.MCA_MAGIC_LINK_ENABLED = String(magicLink)
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8", env })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as { signup: string; signin: string }
}

test("unset and invalid signup modes retain the existing open copy", () => {
  for (const value of [undefined, "OPEN", "closed", "true"]) {
    if (value === undefined) delete process.env.MCA_SIGNUP_MODE
    else process.env.MCA_SIGNUP_MODE = value
    assert.equal(signupMode(), "open")
    const markup = renderAuth(value, undefined)
    assert.match(markup.signup, /Create your company workspace/)
    assert.match(markup.signin, /Create a company workspace/)
  }
  delete process.env.MCA_SIGNUP_MODE
})

test("invite-only page offers a demo and sign-in hides the creation link", () => {
  const markup = renderAuth("invite_only", undefined)
  assert.match(markup.signup, /Fundlane is invite-only/)
  assert.match(markup.signup, /href="\/demo"/)
  assert.doesNotMatch(markup.signup, /Create your company workspace/)
  assert.match(markup.signin, /New team members join through an invitation/)
  assert.doesNotMatch(markup.signin, /Create a company workspace/)
})

test("migrated-account helper defaults to shown and can be hidden", () => {
  delete process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE
  assert.equal(migratedAccountNoticeEnabled(), true)
  assert.match(renderAuth(undefined, undefined).signin, /migrated account/)
  process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE = "false"
  assert.equal(migratedAccountNoticeEnabled(), false)
  assert.doesNotMatch(renderAuth(undefined, "false").signin, /migrated account/)
  delete process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE
})

test("invite-only sign-in can show magic link while hiding the migrated-account helper", () => {
  const markup = renderAuth("invite_only", "false", true).signin
  assert.match(markup, /Email me a sign-in link/)
  assert.match(markup, /New team members join through an invitation/)
  assert.doesNotMatch(markup, /Create a company workspace|migrated account/)
})
