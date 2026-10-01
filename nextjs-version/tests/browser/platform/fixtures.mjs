// Synthetic records only. This module is substituted at bundle time, never in the app.
export const stamp = '2026-10-01T12:00:00.000Z'
export const companyId = 'company-a'
export const actor = { email: 'operator@example.test' }
export const company = { id: companyId, name: 'Synthetic Capital Partners', purchasedSeats: 8, selectedSeats: 8, occupiedSeats: 6, subscriptionStatus: 'active', billingState: 'customer', access: { status: 'active', seatLimit: 8, manualPaused: false, trialEndsAt: null, graceEndsAt: null } }
export const totals = [
  { currency: 'usd', due: '1280000', paid: '960000', remaining: '320000', refunded: '12000', disputed: '5000' },
  { currency: 'eur', due: '480000', paid: '400000', remaining: '80000', refunded: '0', disputed: '0' },
]
export const invoice = { stripe_invoice_id: 'in_synthetic', workspace_id: companyId, company_name: company.name, status: 'open', currency: 'usd', amount_due: '64000', amount_paid: '0', amount_remaining: '64000', created_at: stamp, invoice_url: null }
export const payment = { stripe_payment_id: 'pi_synthetic', stripe_invoice_id: invoice.stripe_invoice_id, workspace_id: companyId, company_name: company.name, status: 'succeeded', currency: 'usd', amount_paid: '39900', synced_at: stamp }
export const adjustment = { id: 're_synthetic', workspace_id: companyId, company_name: company.name, kind: 'refund', status: 'succeeded', amount: '12000', currency: 'usd', reason: 'Synthetic adjustment', livemode: 0, created_at: stamp }
export const notifications = [{ id: 'notice-pending', kind: 'billing.payment_failed', attempts: 1, deliveredAt: null, failed: true, availableAt: stamp }, { id: 'notice-delivered', kind: 'billing.trial_ending', attempts: 1, deliveredAt: stamp, failed: false, availableAt: stamp }]
export const detail = { company, access: company.access, owner: { email: 'owner@example.test', name: 'Synthetic Owner', status: 'active' }, subscription: { planName: 'Fundlane' }, pricing: { version: 'synthetic-catalog', purchasedMonthlyCents: 64000, selectedMonthlyCents: 64000 }, state: { selectedSeats: 8, pendingSeats: null }, memberships: [{ membershipId: 'membership-a', name: 'Synthetic Owner', email: 'owner@example.test', role: 'admin', status: 'active' }], seats: { occupied: 6, purchased: 8 }, billingState: { kind: 'customer', legacyExempt: false }, ownerCandidates: [], notifications }
export const audit = { id: 'audit-a', created_at: stamp, workspace_id: companyId, company_name: company.name, actor_user_id: 'operator-a', action: 'billing.access_updated', resource_type: 'workspace', resource_id: companyId, reason: 'Synthetic access review' }
export const adminAudit = { id: 'audit-admin-a', created_at: stamp, actor_email: actor.email, actor_user_id: 'operator-a', action: 'super_admin.first_access', target_workspace_id: companyId, target_type: 'workspace', target_id: companyId, reason: 'Synthetic review' }
export const roadmap = [{ id: 'roadmap-a', title: 'Better reporting', summary: 'Synthetic product update for browser verification.', status: 'in_progress', sort_order: 1, published: false, updated_at: stamp }]
export const demo = { request_id: 'demo-a', created_at: stamp, contact: { brokerage: 'Synthetic Brokerage', name: 'Demo Contact', email: 'demo@example.test', teamSize: '6–10', message: 'Please show our team the platform.' }, notification_status: 'unsent', notification_attempts: 1 }
export const queueCompany = { workspaceId: companyId, name: company.name, ownerEmail: 'owner@example.test', occupiedSeats: 6, purchasedSeats: 8, subscriptionStatus: 'active', accessState: 'active', smsReviewState: 'pending', providerState: 'unknown', observedAt: null, blockedReasons: ['provider_observation_unverified'] }
export const queueSms = { workspaceId: companyId, companyName: company.name, reviewState: 'pending', submittedAt: stamp, registrationSummary: [], latestOperation: null, blockedReasons: ['provider_observation_unverified'] }
export const smsCompany = { optOutReady: false, workspaceId: companyId, name: company.name, reviewState: 'pending', registrationState: 'unknown', emailVerified: true, suspended: false, numberLimit: 2, monthlyLimitCents: 10000, registrationLimitCents: 2000, profile: { legalName: 'Synthetic Capital Partners LLC', purpose: 'Requested application status updates only.', consentEvidence: 'Synthetic consent evidence' } }
export const status = { asOf: stamp, startedAt: stamp, window: '24h', stale: false,
  latest: { checked_at: stamp, website_ok: true, database_ok: true, website_ms: 17, database_ms: 23, deployment: 'Synthetic preview', metrics: { queued: 2, running: 1, failed: 0, retrying: 0, expired: 0, oldestSeconds: 60, emailQueued: 2, emailAccepted: 14, emailFailed: 0, emailBlocked: 0, emailUnknown: 0, reconnect: 0, documentWorkerHeartbeatAgeSeconds: 1 } },
  observedAvailability: 1, samples: 60, errors: 0, companies: 12, newCompanies: 2, activeUsers: 25, invitations: 8, submitted: 5, incidents: [],
  health: [{ time: stamp, websiteMs: 17, databaseMs: 23, errors: 0 }], usage: [{ day: '2026-10-01', activeUsers: 25, invitations: 8, submitted: 5 }],
}
export const platformQuerySchema = { parse: params => ({ q: '', status: '', ...params, offset: Number(params.offset ?? 0) }) }
export const requirePlatformPage = async () => actor
export const publicRoadmapEnabled = () => true
export const documentRuntimeEnabled = () => false
export const platformCompanies = async query => query.q === 'no-match' ? [] : Array.from({ length: 50 }, (_, i) => ({ ...company, id: i ? `company-${i}` : companyId, name: i ? `Synthetic Brokerage ${i}` : company.name }))
export const listBillingStateExceptions = async () => [{ id: companyId, name: company.name, legacyExempt: false }]
export const platformCompany = async () => detail
export const platformPayments = async query => ({ totals, invoices: query.q === 'no-match' ? [] : [invoice], payments: [payment], adjustments: [adjustment] })
export const platformAudit = async () => [audit]
export const listSuperAdminActions = async () => [adminAudit]
export const listDemoSubmissions = async () => [demo]
export const hasUnnotifiedDemoSubmissions = async () => true
export const listRoadmapItems = async () => roadmap

export class AppError extends Error {}
