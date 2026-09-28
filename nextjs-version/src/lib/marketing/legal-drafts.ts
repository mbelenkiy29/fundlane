/**
 * Draft, not reviewed by an attorney.
 * Prepared for Sentinel Tech Solutions LLC under Michael Belenkiy's
 * September 28, 2026 decision. Not yet in effect.
 * Render only behind MCA_LEGAL_DRAFT_PAGES_ENABLED === "true".
 * Preserve visible placeholders until reviewed. Do not enable publication here.
 * PR #130 must NEVER be merged by automation.
 */
export const legalPlaceholders = {
  company: "Sentinel Tech Solutions LLC",
  address: "7 Holly Hill Road, Marlboro, NJ [ZIP]",
  contact: "mike@sentineltechsolutions.io",
  effectiveDate: "[Effective date]",
} as const

export const legalDraftBanner = "DRAFT — Draft, not reviewed by an attorney. Not yet in effect."

export type LegalSection = { heading: string; paragraphs: readonly string[] }

export const termsSections: readonly LegalSection[] = [
  { heading: "Draft status and provider", paragraphs: [
    `Fundlane is operated by ${legalPlaceholders.company}, ${legalPlaceholders.address}. Contact ${legalPlaceholders.contact}. These Terms are a working draft, have not been reviewed by an attorney, and are not yet in effect.`,
  ] },
  { heading: "Eligibility and authority", paragraphs: [
    "Fundlane is intended for US business operations and authorized users aged 18 or older. A person subscribing for a company must have authority to bind it. Users must provide accurate account information; this does not represent that Fundlane verifies age or location.",
  ] },
  { heading: "The Fundlane service", paragraphs: [
    "Fundlane provides MCA merchant and deal CRM, documents, underwriting assistance, funder submissions, communications and follow-up tools. Available features depend on configuration. Fundlane does not make funding decisions or guarantee financing, collection results or regulatory compliance.",
  ] },
  { heading: "Accounts, workspaces and authorized users", paragraphs: [
    "A company administers its workspace, invitations and memberships. Roles and assignments control access under application permissions. The company is responsible for its authorized users, their activity and protecting account credentials; users must report suspected unauthorized access.",
  ] },
  { heading: "Customer data ownership and processing", paragraphs: [
    "Customers retain their rights in data they submit. They authorize Fundlane to host, process and transmit that data as needed to provide requested services and integrations. Where applicable, Fundlane acts as a processor or service provider for customer-controlled merchant records; customers remain responsible for their collection notices and permissions.",
    "[Attorney review: processor/service-provider contract terms and data processing addendum.]",
  ] },
  { heading: "Subscriptions, renewal and payment", paragraphs: [
    "Subscriptions renew and are billed through Stripe according to the agreed plan, selected seat quantity and amounts shown at Checkout. A company authorizes recurring charges to its selected payment method. Cancellation through Plans & Billing takes effect at the applicable subscription period end; cancellation does not itself erase data or create a refund.",
  ] },
  { heading: "Trials", paragraphs: [
    "Trial duration, capacity and eligibility are shown at signup. A card-backed Stripe trial may begin paid billing when the trial expires unless canceled before then. A no-card trial's expiry does not itself authorize a charge. Trial capacity and eligibility restrictions still apply.",
  ] },
  { heading: "Seats, proration and taxes", paragraphs: [
    "Under the pre-purchased seat model, removing or deactivating a user does not reduce your purchased seat quantity or subscription charges. An authorized administrator must request a seat reduction in Plans & Billing.",
    "Paid seat increases are prorated and invoiced immediately; additional paid capacity becomes available after payment is verified. Seat reductions take effect at renewal and do not create a mid-cycle credit.",
    "Seat changes during an eligible Stripe trial do not incur prorated charges; the selected quantity affects billing after the trial.",
    "If automatic seat assignment is enabled for your company, accepting an invitation when all purchased seats are in use adds a paid seat (prorated and charged immediately). Removing a user never reduces your purchased seats or charges.",
    "Listed prices exclude applicable taxes. Applicable taxes will be added where required.",
  ] },
  { heading: "Email, SMS and calendar integrations", paragraphs: [
    "Customers choose whether to connect available email, SMS and calendar services and are responsible for message content, recipient authorization and applicable communications law. Connected accounts and services can be revoked through available controls; already-sent communications may remain with recipients and providers.",
    "SMS opt-in is voluntary. Message frequency varies. Message and data rates may apply. Reply STOP to opt out. Where the sending service has configured HELP responses, reply HELP for assistance; you may also contact the sending company or mike@sentineltechsolutions.io.",
    "[Attorney review: configured SMS HELP responses and hosted STOP/HELP verification.]",
  ] },
  { heading: "AI-assisted features", paragraphs: [
    "When enabled, OpenAI-powered assistance can analyze documents, use permission-filtered deal information and, where configured, use hosted file analysis or public research. Customers must review outputs before use. AI output may be inaccurate and is not legal, financial, credit or regulatory advice; no provider retention or training guarantee is made here.",
  ] },
  { heading: "Acceptable use and broker compliance", paragraphs: [
    "Users may not access another company's data without permission, submit malicious files, send spam, deceive recipients or interfere with the service. Customers must have merchant authorization to collect, use and share records and must maintain any required licenses and disclosures.",
    "Customers are responsible for their own regulatory compliance, including applicable state commercial-financing disclosure laws and the Telephone Consumer Protection Act (TCPA). Fundlane may not be used for unlawful lending or collection practices.",
  ] },
  { heading: "Third-party services and funders", paragraphs: [
    "At a customer's direction, Fundlane may transmit selected information to funders, connected mailboxes, configured webhooks and other services. Those recipients may have their own terms and practices. Integration support does not mean every provider is active or that every recipient is Fundlane's subprocessor.",
  ] },
  { heading: "Suspension, termination and data export", paragraphs: [
    "Fundlane may restrict access to address misuse, security threats, legal requirements or payment failure, subject to applicable law and agreements. Subscription cancellation, access restriction and data deletion are separate events. Authorized users can use existing permission-scoped deal and offer exports or request assistance; a complete account archive and post-termination retrieval are not promised by this draft.",
    "[Attorney review: post-termination export window, available formats and assistance process.]",
    "[Attorney review: retention periods by data category, backup expiry and deletion procedures.]",
  ] },
  { heading: "Disclaimers", paragraphs: [
    "To the extent permitted by law, the Service is provided as is and as available, subject to express commitments and mandatory rights. Fundlane does not guarantee uninterrupted service, financing outcomes or correct AI output.",
  ] },
  { heading: "Limitation of liability", paragraphs: [
    "To the extent permitted by law, the parties would exclude indirect, incidental, special, consequential and lost-profit damages, subject to approved exceptions and mandatory rights.",
    "[Attorney review: liability cap, measurement period and exclusions from the limitation.]",
  ] },
  { heading: "Governing law and venue", paragraphs: [
    "These Terms are governed by the laws of the State of New Jersey, without regard to conflict-of-laws rules. Subject to applicable law, disputes arising from these Terms or the Service will be brought in the state courts located in Monmouth County, New Jersey. [Attorney review: federal jurisdiction, enforceability and mandatory-law exceptions.]",
  ] },
  { heading: "Changes and contact", paragraphs: [
    `Revised Terms would be published with an effective date and appropriate notice of material changes. [Attorney review: material-change notice method and advance-notice period.] Contact ${legalPlaceholders.company} at ${legalPlaceholders.address} or ${legalPlaceholders.contact}. This draft is not yet in effect.`,
  ] },
]

export const privacySections: readonly LegalSection[] = [
  { heading: "Draft status, scope and contact", paragraphs: [
    `This unreviewed Privacy Policy draft describes Fundlane's website visitors, demo inquiries, workspace users and people whose information customers submit. ${legalPlaceholders.company}, ${legalPlaceholders.address}, can be contacted at ${legalPlaceholders.contact}. It is not yet in effect.`,
  ] },
  { heading: "Our role and our customers’ role", paragraphs: [
    "Fundlane handles its own website, account and billing administration. For customer-controlled merchant records, Fundlane processes information to provide the customer's requested service. Merchant requests may need coordination with the relevant customer. This draft does not assert that a data processing addendum has been signed.",
    "[Attorney review: processor/service-provider contract terms and data processing addendum.]",
  ] },
  { heading: "Information we collect and its sources", paragraphs: [
    "Information can include account names, emails, credentials and memberships; demo names, work emails, brokerage, team size and messages; business and owner contacts, identifiers, financing and financial records; uploaded documents; communications; integration credentials and tokens; and request, security, delivery and audit events.",
    "Sources include direct entry, customer uploads, merchant upload portals, connected mailboxes and calendars, integration providers and provider callbacks. Uploaded documents can contain sensitive information beyond structured fields.",
  ] },
  { heading: "How we use information", paragraphs: [
    "We use information to authenticate users, provide workspace tools and document processing, carry out requested communications and submissions, administer billing, provide support, secure and troubleshoot the service, and maintain auditability.",
  ] },
  { heading: "Merchant documents and upload links", paragraphs: [
    "Applications, statements, identification and checks may contain sensitive information. Documents use private storage and authorized workspace access; scoped upload and signed download links can also permit merchants without workspace accounts to provide or receive selected files. Customers must have authority to collect and share them.",
  ] },
  { heading: "Billing and payment information", paragraphs: [
    "Stripe hosts payment collection. Fundlane maintains customer, subscription and invoice references and billing status, not full card numbers. Stripe Checkout may request billing address and tax ID when configured. Trial-abuse checks may process limited signup or payment-method signals where configured; this does not mean every user has a collected fingerprint.",
  ] },
  { heading: "AI and document analysis", paragraphs: [
    "When enabled, OpenAI receives prompts, conversation context, authorized deal data and selected files or document contents for assistance and analysis. Configured hosted file tools and public research may process related inputs. Application requests can set provider storage options, but this draft does not promise provider zero retention or no training.",
    "[Attorney review: AI provider retention, training restrictions and applicable contractual settings.]",
  ] },
  { heading: "Connected email and calendar accounts", paragraphs: [
    "When connected, Google Gmail or Microsoft mailboxes may allow reading and sending messages, recipients, attachments, threads and delivery or reply data; Fundlane stores OAuth credentials needed for the connection. Google Calendar can read selected calendars and synchronize Fundlane activity events. Disconnecting stops future authorized use but cannot recall sent messages or guarantee removal of remote events.",
  ] },
  { heading: "SMS communications and choices", paragraphs: [
    "When enabled, Twilio processes phone numbers, message contents and delivery events; Fundlane records opt-in evidence and suppression choices. SMS opt-in is voluntary. Message frequency varies. Message and data rates may apply. Reply STOP to opt out. Where the sending service has configured HELP responses, reply HELP for assistance; you may also contact the sending company or mike@sentineltechsolutions.io.",
    "Mobile information collected for SMS consent is not shared with third parties for their marketing purposes.",
    "[Attorney review: configured SMS HELP responses and hosted STOP/HELP verification.]",
  ] },
  { heading: "Recipients, service providers and subprocessors", paragraphs: [
    "Core infrastructure includes Vercel for hosting, Supabase for Auth, PostgreSQL database and private storage, and Stripe for billing. When configured, OpenAI processes AI inputs; Twilio handles SMS; useSend or a configured delivery receiver handles transactional email; Cloudmersive or Verisys may receive files or signed URLs for scanning.",
    "Customer-connected or customer-selected recipients can include Google and Microsoft mailboxes, Google Calendar or Drive where used, funders, custom webhooks, DataMerch, DocuSeal and configured form or intake providers. Such recipients are not all Fundlane subprocessors. SMTP, SendGrid and Postmark adapter support alone does not establish production use. Supabase Auth's SMTP provider, external webhook operators, provider legal entities, processing regions and contractual roles remain unconfirmed.",
    "[Attorney review: deployed providers, contracting entities, processing locations and subprocessor roles.]",
  ] },
  { heading: "Cookies, browser storage and analytics", paragraphs: [
    "Supabase session cookies support sign-in; a cookie remembers active workspace selection and sidebar_state remembers the sidebar preference. Local storage remembers theme preferences. The reviewed application has no identified advertising or third-party analytics SDK, while hosting-side analytics and the complete cookie inventory require confirmation.",
    "[Attorney review: hosting-side analytics and complete cookie/storage inventory.]",
  ] },
  { heading: "Security and operational records", paragraphs: [
    "Workspace roles and assignments, selected-field encryption, private document storage and limited-access links help control access. Audit events and operational monitoring record activity and errors. These measures do not guarantee absolute security, comprehensive log redaction, universal scanning or certification.",
  ] },
  { heading: "Retention, deletion and exports", paragraphs: [
    "Information is retained according to its purpose and applicable obligations. Existing controls include permission-scoped deal and offer exports, selective assistant deletion and expiring assistant-file or download tokens. Token expiry is not a promise of file, backup or provider deletion; a complete account archive and erasure procedure are not established.",
    "[Attorney review: retention periods by data category, backup expiry and deletion procedures.] [Proposed for review: operational logs 30 days; assistant files 90 days; customer content deleted 90 days after account closure; billing, ledger and audit records 7 years; backups roll off within 30 days; legal holds suspend deletion.]",
  ] },
  { heading: "US state privacy rights", paragraphs: [
    `Where applicable, individuals may request access or knowledge, correction, deletion and portability, and exercise nondiscrimination, authorized-agent or appeal rights. Applicable sale, sharing, targeted-advertising and sensitive-data choices may also apply. Send requests to ${legalPlaceholders.contact}; we may verify identity and coordinate customer-controlled records with the relevant customer.`,
    "[Attorney review: state-law applicability, request verification, response deadlines, authorized agents and appeals.]",
    "[Attorney review: sale, sharing, targeted advertising, sensitive-data uses and Global Privacy Control handling.]",
  ] },
  { heading: "US operations and children", paragraphs: [
    "Fundlane is intended for business operations in the United States and is not directed to individuals under 18. This does not guarantee that storage or provider processing occurs only in the United States.",
  ] },
  { heading: "Changes to this policy", paragraphs: [
    "Future revisions would carry an effective date and appropriate notice of material changes. [Attorney review: material-change notice method and advance-notice period.] This draft is not yet in effect.",
  ] },
]
