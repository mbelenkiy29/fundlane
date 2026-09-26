/** Editable draft copy. Legal review must replace the placeholders before either notice takes effect. */
export const legalPlaceholders = {
  company: "[Company legal name]",
  address: "[Company mailing address]",
  contact: "[contact email]",
  updated: "[date pending legal review]",
} as const

export type LegalSection = { heading: string; paragraphs: readonly string[] }

export const termsSections: readonly LegalSection[] = [
  { heading: "Who may use Fundlane", paragraphs: [
    `These draft terms would govern use of Fundlane by a company and its authorized users. The contracting provider is ${legalPlaceholders.company}, at ${legalPlaceholders.address}. Users must provide accurate account information, protect their credentials, and use only the workspaces and information they are authorized to access. A company is responsible for the users it invites and the information they submit.`,
  ] },
  { heading: "The service and your data", paragraphs: [
    "Fundlane provides tools for MCA teams to manage applications, merchant records, documents, underwriting, submissions, communications, offers, and follow-up work. Features and provider integrations depend on configuration and may change. The company and its users remain responsible for reviewing information and decisions made through the service, obtaining any required merchant permissions, and complying with applicable law.",
    "The company retains responsibility for the information it uploads or enters. It authorizes Fundlane to host, process, and transmit that information as needed to provide the requested features, including configured integrations and communications. Do not upload information you lack authority to use or share. Fundlane does not make funding or legal decisions for a company.",
  ] },
  { heading: "Communications and SMS", paragraphs: [
    "If a company enables email or SMS tools, it is responsible for recipient permissions and message content. SMS opt-in is voluntary; message frequency varies and message and data rates may apply. Recipients can reply STOP to opt out or HELP for help. Contact the sending company or Fundlane at the contact below for assistance. Mobile information collected for SMS consent is not shared with third parties for their marketing purposes.",
  ] },
  { heading: "Subscriptions", paragraphs: [
    "Where a paid subscription is offered, subscriptions are billed through Stripe according to the plan shown at checkout. A company can cancel through the in-app billing settings.",
  ] },
  { heading: "Acceptable use and access", paragraphs: [
    "Users may not use Fundlane to violate law, access another company's data without permission, interfere with the service, or submit malicious content. We may restrict access when needed to address misuse, security concerns, or legal requirements. We may update the service and these terms; any effective terms and notice of changes require legal review before publication.",
  ] },
  { heading: "Contact", paragraphs: [
    `Questions about these draft terms can be sent to ${legalPlaceholders.contact}.`,
  ] },
]

export const privacySections: readonly LegalSection[] = [
  { heading: "Who this draft covers", paragraphs: [
    `This draft describes Fundlane's website and workspace data practices. The provider is ${legalPlaceholders.company}, at ${legalPlaceholders.address}. A brokerage using Fundlane controls the merchant information its users submit and is responsible for its own notices and permissions. Contact ${legalPlaceholders.contact} with privacy questions.`,
  ] },
  { heading: "Information we handle", paragraphs: [
    "We handle account details such as names, work email addresses, company names, credentials, and membership information. Supabase Auth handles email and password sessions and Google sign-in when selected. We also handle demo inquiry details, workspace records, and technical information such as browser, request, and security logs needed to run the service.",
    "Workspace users may enter merchant and owner contact information, business identifiers, financial details, and application answers. They may upload bank statements, applications, and other documents, including sensitive personal information. Configured communications can include email and SMS messages, recipients, delivery events, and replies. Calendar connections may process event information when enabled.",
  ] },
  { heading: "How we use and disclose information", paragraphs: [
    "We use this information to authenticate users, provide workspace features, process documents and communications, support customers, operate billing, detect abuse, and maintain the service. A company can choose to send information to its selected funders and connected services through the app. Authorized users in that company's workspace may access its records according to their permissions.",
    "Service providers used for these functions include Supabase for authentication, database and private file storage; Vercel for web hosting; Stripe for subscription checkout and billing; OpenAI for enabled assistant or document analysis features; UseSend or other configured email delivery providers; and Twilio or another configured SMS provider. Connected Google services may process sign-in or calendar data when a user enables them. Provider access depends on the features and integrations used. We may disclose information where required by law or to protect users and the service.",
  ] },
  { heading: "Storage, security, and retention", paragraphs: [
    "Uploaded documents are kept in private storage, with access controlled by application permissions and limited access links. The application encrypts selected sensitive database fields, including certain merchant identifiers and contact details, before storing them. This does not mean every field or uploaded file is encrypted by the application. We use security measures appropriate to the service, but no system can guarantee absolute security.",
    "We retain information while needed to provide the service, address security or operational needs, and meet applicable obligations. Retention can vary by record and provider; backup copies may persist until their normal expiry. A company or individual can request access, correction, or deletion at the contact above. We may need to verify a request, coordinate with the relevant company, and retain information where required or permitted by law.",
  ] },
  { heading: "Cookies, sessions, and choices", paragraphs: [
    "The app uses cookies and similar browser storage for authentication, active workspace selection, and interface preferences. Hosting and security services may process request information to deliver and protect the site. You can manage browser storage through your browser, though disabling essential session storage may prevent sign-in.",
    "SMS opt-in is voluntary. Message frequency varies; message and data rates may apply. Reply STOP to opt out or HELP for help. Mobile information collected for SMS consent is not shared with third parties for marketing purposes. Contact the sending company or Fundlane at the contact above for assistance. You can also choose whether to connect Google sign-in or calendar features where available.",
  ] },
  { heading: "Changes", paragraphs: [
    "After legal approval, updates to this notice will be shown on this page with a revised date. This draft is not yet in effect.",
  ] },
]
