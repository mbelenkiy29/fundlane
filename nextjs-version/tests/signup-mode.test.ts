import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { migratedAccountNoticeEnabled, signupMode } from "../src/lib/mca/signup-mode"

function renderAuth(mode: string | undefined, showNotice: string | undefined, magicLink = false, polish = false, legalDrafts = false) {
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
  env.MCA_MARKETING_POLISH_ENABLED = String(polish)
  env.MCA_LEGAL_DRAFT_PAGES_ENABLED = String(legalDrafts)
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8", env })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as { signup: string; signin: string }
}

test("unset and invalid signup modes retain legacy signup while Login has no creation link", () => {
  for (const value of [undefined, "OPEN", "closed", "true"]) {
    if (value === undefined) delete process.env.MCA_SIGNUP_MODE
    else process.env.MCA_SIGNUP_MODE = value
    assert.equal(signupMode(), "open")
    const markup = renderAuth(value, undefined)
    assert.match(markup.signup, /Create your company workspace/)
    assert.match(markup.signin, />Next</)
    assert.doesNotMatch(markup.signin, /Create a company workspace|href="\/sign-up"/)
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

test("legal links appear only in open sign-up with the legal pages flag", () => {
  const open = renderAuth("open", undefined, false, false, true).signup
  assert.match(open, /href="\/terms"[^>]*>Terms of Service</)
  assert.match(open, /href="\/privacy"[^>]*>Privacy Policy</)

  const defaultOpen = renderAuth("open", undefined).signup
  assert.doesNotMatch(defaultOpen, /href="\/(terms|privacy)"/)

  const inviteOnly = renderAuth("invite_only", undefined, false, false, true).signup
  assert.match(inviteOnly, /Fundlane is invite-only/)
  assert.doesNotMatch(inviteOnly, /href="\/(terms|privacy)"|Create your company workspace/)
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

test("invite-only Login starts with email Next and hides the migrated-account helper", () => {
  const markup = renderAuth("invite_only", "false", true).signin
  assert.match(markup, />Next</)
  assert.match(markup, /Continue with Google/)
  assert.doesNotMatch(markup, /Email me a sign-in link/)
  assert.match(markup, /New team members join through an invitation/)
  assert.doesNotMatch(markup, /Create a company workspace|migrated account/)
})

test("polished sign-up renders one visible h1 in either signup mode", () => {
  const open = renderAuth("open", undefined, false, true).signup
  const inviteOnly = renderAuth("invite_only", undefined, false, true).signup
  assert.match(open, /<h1 class="leading-none font-semibold">Create your company workspace<\/h1>/)
  assert.equal((open.match(/<h1\b/g) ?? []).length, 1)
  assert.match(inviteOnly, /<h1 class="text-xl font-semibold">Fundlane is invite-only<\/h1>/)
  assert.equal((inviteOnly.match(/<h1\b/g) ?? []).length, 1)
  assert.doesNotMatch(renderAuth("open", undefined).signup, /<h1\b/)
})
