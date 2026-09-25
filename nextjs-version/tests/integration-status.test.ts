import test from "node:test"
import assert from "node:assert/strict"
import {
  closingMerchantPreviewGate,
  closingPsfDeliverGate,
  closingSendPreviewGate,
  emailChannelStatus,
  emailComposerGate,
  funderSubmissionChannelStatus,
  psfProviderReady,
  reminderSendGate,
  smsChannelStatus,
  submissionConfirmGate,
} from "../src/lib/mca/integrations/connection-status"

test("email connection status covers not connected, pending, expired, revoked, and connected", () => {
  assert.equal(emailChannelStatus([]).label, "Not connected")
  assert.match(emailChannelStatus([]).detail, /Not connected/)
  assert.equal(emailChannelStatus([{ state: "pending", hasCredential: false }]).label, "Pending")
  assert.equal(emailChannelStatus([{ state: "expired", hasCredential: true }]).label, "Expired")
  assert.equal(emailChannelStatus([{ state: "revoked", hasCredential: true }]).label, "Revoked")
  assert.equal(emailChannelStatus([{ state: "verified", hasCredential: true }]).label, "Connected")
  assert.equal(emailChannelStatus([{ state: "pending", conversationReady: true }]).label, "Connected")
})

test("sms connection status uses onboarding and account config without inventing readiness", () => {
  assert.equal(smsChannelStatus({}).label, "Not connected")
  assert.match(smsChannelStatus({}).detail, /Not connected/)
  assert.equal(smsChannelStatus({ accounts: [{ state: "active", providerConfigured: false }] }).label, "Pending")
  assert.equal(smsChannelStatus({
    onboarding: { registrationState: "submitted", platformReady: false, optOutReady: false, numbers: [] },
  }).label, "Pending")
  assert.equal(smsChannelStatus({
    onboarding: {
      reviewState: "approved",
      registrationState: "approved",
      platformReady: true,
      optOutReady: true,
      numbers: [{ id: "n1" }],
    },
  }).label, "Connected")
  assert.equal(smsChannelStatus({ accounts: [{ state: "active", providerConfigured: true }] }).label, "Connected")
  assert.equal(smsChannelStatus({ onboarding: { suspended: true, registrationState: "approved" } }).label, "Revoked")
  assert.equal(smsChannelStatus({
    onboarding: {
      suspended: true,
      reviewState: "approved",
      registrationState: "approved",
      platformReady: true,
      optOutReady: true,
      numbers: [{ id: "n1" }],
    },
  }).label, "Revoked")
  assert.equal(smsChannelStatus({
    onboarding: {
      reviewState: "pending",
      registrationState: "approved",
      platformReady: true,
      optOutReady: true,
      numbers: [{ id: "n1" }],
    },
  }).label, "Pending")
  assert.match(smsChannelStatus({
    onboarding: {
      reviewState: "pending",
      registrationState: "submitted",
      platformReady: true,
      optOutReady: true,
      numbers: [{ id: "n1" }],
    },
  }).detail, /business review approval|carrier registration approval/)
  assert.equal(smsChannelStatus({
    accounts: [{ state: "active", providerConfigured: true }],
    onboarding: { suspended: true, registrationState: "approved" },
  }).label, "Connected")
})

test("funder submission status is not connected until a route or credential exists", () => {
  assert.equal(funderSubmissionChannelStatus({}).label, "Not connected")
  assert.match(funderSubmissionChannelStatus({}).detail, /Not connected/)
  assert.equal(funderSubmissionChannelStatus({ funders: [{ active: true, routes: [] }] }).label, "Pending")
  assert.equal(funderSubmissionChannelStatus({
    funders: [{ active: true, routes: [{ active: true, kind: "email" }] }],
  }).label, "Connected")
  assert.equal(funderSubmissionChannelStatus({
    funders: [{ routes: [{ active: true, kind: "api" }] }],
  }).label, "Connected")
  assert.equal(funderSubmissionChannelStatus({
    funders: [{ active: false, routes: [{ active: true, kind: "email" }] }],
  }).label, "Pending")
  assert.equal(funderSubmissionChannelStatus({
    credentials: [{ hasCredential: true, active: true }],
  }).label, "Connected")
})

test("submit-to-funders stays disabled until a ready destination is selected", () => {
  const funder = {
    id: "f1",
    legalName: "Harbor Capital",
    route: { kind: "email", active: true },
    preflightErrors: [] as Array<{ message: string }>,
  }
  assert.equal(submissionConfirmGate({ loading: true, selectedIds: [], funders: [funder] }).enabled, false)
  assert.deepEqual(submissionConfirmGate({ loading: false, selectedIds: [], funders: [] }).missing, [
    "No active funders are available. Add a funder route before submitting.",
  ])
  assert.deepEqual(submissionConfirmGate({ loading: false, selectedIds: [], funders: [funder] }).missing, [
    "Select at least one funder.",
  ])
  assert.deepEqual(submissionConfirmGate({
    loading: false,
    selectedIds: ["f1"],
    funders: [{ ...funder, route: null, preflightErrors: [{ message: "Connect and verify a submission email sender before sending by email." }] }],
  }).missing, [
    "Harbor Capital has no active submission route.",
    "Harbor Capital: Connect and verify a submission email sender before sending by email.",
  ])
  assert.equal(submissionConfirmGate({ loading: false, selectedIds: ["f1"], funders: [funder] }).enabled, true)
})

test("email composer names each missing prerequisite", () => {
  const sender = { id: "s1", conversationReady: true }
  assert.deepEqual(emailComposerGate({
    isNew: true, dealId: "", recipient: null, senders: [], senderId: "", subject: "", body: "", waiting: false,
  }).missing, [
    "Choose a lead or merchant.",
    "Add an email address to this contact in the deal application.",
    "Not connected. Connect Gmail or Microsoft before sending email.",
    "Enter a subject.",
    "Enter a message.",
  ])
  assert.equal(emailComposerGate({
    isNew: true, dealId: "d1", recipient: "owner@example.test", senders: [sender], senderId: "s1",
    subject: "Offer", body: "Hello", waiting: false,
  }).enabled, true)
  assert.equal(emailComposerGate({
    isNew: false, dealId: "d1", recipient: "owner@example.test", senders: [sender], senderId: "s1",
    subject: "", body: "Thanks", waiting: true,
  }).enabled, false)
})

test("closing and reminder send actions stay disabled until ready", () => {
  assert.equal(closingSendPreviewGate({}).enabled, false)
  assert.equal(closingSendPreviewGate({ preview: { state: "sent" } }).enabled, false)
  assert.equal(closingSendPreviewGate({ preview: { state: "preview" } }).enabled, true)
  assert.match(closingMerchantPreviewGate({
    channel: "sms", emailReady: false, smsReady: false, smsConfigured: false, smsConsent: "unknown",
  }).missing[0], /Not connected/)
  assert.equal(closingMerchantPreviewGate({
    channel: "sms", emailReady: false, smsReady: true, smsConfigured: true, smsConsent: "opted_in",
  }).enabled, true)
  assert.match(closingPsfDeliverGate({
    revisionId: "r1", amount: "100", bankName: "Bank", routingNumber: "021000021", accountNumber: "123",
    businessName: "Cafe", contactName: "Pat", providerConnected: false,
  }).missing[0], /Not connected/)
  assert.equal(closingPsfDeliverGate({
    revisionId: "r1", amount: "100", bankName: "Bank", routingNumber: "021000021", accountNumber: "123",
    businessName: "Cafe", contactName: "Pat", providerConnected: true,
  }).enabled, true)
  assert.equal(reminderSendGate({ canSend: true, body: "" }).enabled, false)
  assert.equal(reminderSendGate({ canSend: true, body: "Checking status" }).enabled, true)
  assert.equal(psfProviderReady({}), false)
  assert.equal(psfProviderReady({ enabled: true, destinationConfigured: true }), false)
  assert.equal(psfProviderReady({
    enabled: true, destinationConfigured: true, signingSecretConfigured: true,
  }), true)
  assert.equal(psfProviderReady({ docuSealConfigured: true }), true)
})
