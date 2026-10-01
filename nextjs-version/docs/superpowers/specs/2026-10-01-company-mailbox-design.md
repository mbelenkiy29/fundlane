# Company mailbox readiness and disconnect

The approved feature connects broker/company Gmail and Microsoft 365 merchant mailboxes and reliably associates only Fundlane conversations. Reuse sender OAuth, sender authorization, fenced conversation polling and the work-email connection component. System Auth/team/billing delivery and private intake #39 are distinct activation paths.

Provide a session-only, no-store GET /api/mca/senders/readiness returning only authorized merchant Google/Microsoft sender metadata, provider configuration booleans, connection status and consumer health (disabled/missing/stale/healthy). A configured grant is not delivery proof: overall readiness requires a conversation-ready sender, configured provider, enabled consumer and completed tick within ten minutes. OAuth token expiry alone remains refreshable. Consumer timestamps are operational heartbeat only; never expose other company counts or conversation data.

Export getMailboxReadiness(actor) for onboarding composition and CompanyMailboxConnections component for the onboarding owner. Reuse PersonalEmailConnections and show provider/consumer gates and explicit disconnect. Disconnect clears OAuth credentials and pending authorization states atomically, preserves conversation history and queued/unknown message identity, and blocks credentials being restored by an OAuth callback already in flight. Reconnect remains explicit. Continue existing current-role/company/deal authorization and provider mocks.

No schema changes, provider grants, real sends, schedule enablement, hosted mutations, or changes to notification scheduler/aggregator. Foundation notification API is unpinned: this independently useful readonly contract does not depend on it. #38 hosted pilot and #39 actual inbound webhook/delivery remain external gates. Polling uses existing authenticated cron; inbound provider webhook verification is not part of this OAuth adapter.

Tests must cover authorized/foreign/shared sender visibility, API-key rejection, configuration/runtime/heartbeat gates, expired grants, disconnect persistence and OAuth callback race, both provider adapter flows and sent/reply dedup/unknown recovery. Local fixtures and unique disposable PostgreSQL only.

Self-review: scoped metadata, explicit activation distinction, no ambiguous provider-readiness claim; interfaces independent of notification proposal.
