import type { StaticImageData } from "next/image"
import type { LucideIcon } from "lucide-react"
import { LayoutDashboard, FolderInput, ScanLine, ListFilter, Send, Handshake, MessagesSquare, Sparkles, Repeat2, ChartNoAxesCombined, UsersRound } from "lucide-react"
import pipeline from "../../../public/marketing/pipeline.png"
import capture from "../../../public/marketing/capture.png"
import review from "../../../public/marketing/review.png"
import submit from "../../../public/marketing/submit.png"
import renew from "../../../public/marketing/renew.png"
import offers from "../../../public/marketing/offers.png"
import reporting from "../../../public/marketing/reporting.png"
import team from "../../../public/marketing/team.png"

export type FeatureId = "pipeline" | "intake" | "underwriting" | "funders" | "submissions" | "closing" | "communications" | "assistant" | "renewals" | "reporting" | "team"
export type MarketingFeature = {
  id: FeatureId
  title: string
  headline: string
  summary: string
  icon: LucideIcon
  capabilities: readonly string[]
  note?: string
  image?: StaticImageData
  imageAlt?: string
  detail: { heading: string; rows: readonly (readonly [string, string])[] }
}

export const marketingFeatures: readonly MarketingFeature[] = [
  {
    id: "pipeline", title: "Pipeline and daily work", icon: LayoutDashboard,
    headline: "Know where every deal stands.",
    summary: "Keep deal records, ownership, and next steps together, from the first application to the next funding conversation.",
    capabilities: ["Follow applications through pipeline stages", "Assign deals and keep notes with the record", "Find the work that needs your attention"],
    image: pipeline, imageAlt: "Fundlane pipeline with synthetic brokerage deals across application and funding stages",
    detail: { heading: "One shared pipeline", rows: [["Application", "Harbor Coffee"], ["Ready to submit", "Cedar Auto Repair"], ["Funded", "Bluebird Logistics"]] },
  },
  {
    id: "intake", title: "Applications and documents", icon: FolderInput,
    headline: "Give every application a clear starting point.",
    summary: "Bring merchant information and supporting files into the deal, and see what still needs to be collected.",
    capabilities: ["Collect applications through configurable forms", "Import spreadsheets with field mapping and review", "Organize documents and request missing files"],
    image: capture, imageAlt: "Synthetic Harbor Coffee application and its required fields in Fundlane",
    detail: { heading: "Build the deal file", rows: [["Application", "Merchant details"], ["Import", "Map your columns"], ["Documents", "Collect and review"]] },
  },
  {
    id: "underwriting", title: "Underwriting", icon: ScanLine,
    headline: "Understand the file before the next handoff.",
    summary: "Review bank-statement analysis alongside the deal. Check extracted information and correct details before using them.",
    capabilities: ["Review bank-statement analysis", "Correct extracted data with review history", "Check document completeness before moving ahead"],
    image: review, imageAlt: "Fundlane underwriting review for an illustrative merchant application",
    detail: { heading: "A reviewable analysis", rows: [["Statements", "Analyze"], ["Extracted details", "Review and correct"], ["Missing information", "Resolve"]] },
  },
  {
    id: "funders", title: "Funder matching", icon: ListFilter,
    headline: "See the reasons behind the match.",
    summary: "Compare your deal with configured funder criteria. Understand eligibility, restrictions, and information gaps before selecting a destination.",
    capabilities: ["Manage funder profiles and criteria", "Compare eligibility and ranked fit", "Review why a funder was included or excluded"],
    note: "Fit scores explain configured criteria. They do not predict or guarantee approval.",
    detail: { heading: "From criteria to a shortlist", rows: [["Deal information", "Revenue · industry · history"], ["Funder criteria", "Compare requirements"], ["Eligibility", "Review fit and exclusions"]] },
  },
  {
    id: "submissions", title: "Submissions and automation", icon: Send,
    headline: "Send with context. Follow every submission.",
    summary: "Prepare the package, choose funders, and keep progress and exceptions visible in the same workflow.",
    capabilities: ["Review packages and preflight checks", "Track each destination and submission outcome", "Choose analyze-only, review-first, or enabled automatic-send modes"],
    note: "Automatic sending requires administrator enablement. Delivery depends on configured routes and providers.",
    image: submit, imageAlt: "Fundlane submission tracking with synthetic sent, queued, and exception records",
    detail: { heading: "Your workflow, your controls", rows: [["Analyze only", "Review the findings"], ["Review first", "Confirm before sending"], ["Automatic send", "Administrator enabled"]] },
  },
  {
    image: offers, imageAlt: "Fundlane offers and closing with a synthetic Northside Kitchen offer and complete terms",
    id: "closing", title: "Offers and closing", icon: Handshake,
    headline: "Carry the selected offer through to funding.",
    summary: "Keep offer terms, revisions, and outstanding requirements connected to the deal so the team can coordinate the close.",
    capabilities: ["Compare offers and track revisions", "Manage stipulations and merchant upload requests", "Track contract workflows and record funding"],
    note: "Signature and delivery workflows require the relevant provider setup.",
    detail: { heading: "A clear path to closing", rows: [["Offers", "Compare terms"], ["Stipulations", "Collect and verify"], ["Contract", "Track progress"], ["Funding", "Record the outcome"]] },
  },
  {
    id: "communications", title: "Communication and follow-ups", icon: MessagesSquare,
    headline: "Keep the next conversation connected.",
    summary: "Follow up with deal context at hand. Bring email workflows, reminders, and company SMS into the work your team already does.",
    capabilities: ["Use email templates and configured sender connections", "Track replies, reminders, and follow-up work", "Manage company SMS conversations and offer messages"],
    note: "Email and SMS availability depends on sender setup, provider activation, and company SMS approval.",
    detail: { heading: "Follow up with the full picture", rows: [["Funder email", "Submission context"], ["Merchant message", "Offer details"], ["Reminder", "The next action"]] },
  },
  {
    id: "assistant", title: "AI assistant", icon: Sparkles,
    headline: "Work through the details with an assistant.",
    summary: "Ask about accessible deals, prepare a draft, or work with a file without losing the context of your brokerage.",
    capabilities: ["Ask deal questions and draft communications", "Research public sources and work with supported files", "Review approval-required messages and submissions before execution"],
    note: "AI tools depend on enabled capabilities and available credits. Existing team permissions still apply.",
    detail: { heading: "Start with a useful question", rows: [["Understand", "What is missing from this deal?"], ["Prepare", "Draft a follow-up for review."], ["Review", "Summarize this document."]] },
  },
  {
    id: "renewals", title: "Advances and renewals", icon: Repeat2,
    headline: "Keep the relationship moving after funding.",
    summary: "Bring funding history into your next conversation. Track advances and surface renewal opportunities using your company’s criteria.",
    capabilities: ["Keep advance and funding history together", "Configure renewal eligibility thresholds", "Review and track renewal follow-up actions"],
    image: renew, imageAlt: "Fundlane renewal workspace with illustrative funding and eligibility records",
    detail: { heading: "From funded to the next conversation", rows: [["Advance", "Track history"], ["Eligibility", "Apply company criteria"], ["Renewal", "Plan the follow-up"]] },
  },
  {
    image: reporting, imageAlt: "Fundlane rep performance report with synthetic records and explicit financial visibility restrictions",
    id: "reporting", title: "Commissions and reporting", icon: ChartNoAxesCombined,
    headline: "Connect deal activity to team performance.",
    summary: "Follow commissions and payment records, then explore performance by rep, funder, and lead source.",
    capabilities: ["Track commission splits and payment records", "Review rep funnels and team contribution", "Explore funder performance and lead-source returns"],
    note: "Financial reporting follows each teammate’s visibility permissions.",
    detail: { heading: "See the work from every angle", rows: [["Rep funnel", "Applications through funding"], ["Funder analytics", "Submission outcomes"], ["Lead sources", "Cost and return"], ["Commissions", "Splits and payments"]] },
  },
  {
    id: "team", title: "Team and connections", icon: UsersRound,
    headline: "A shared workspace with the right access.",
    summary: "Keep ownership clear while giving each teammate access to the records and financial information their role needs.",
    capabilities: ["Manage company roles and deal assignments", "Control financial visibility and team access", "Configure supported connections, templates, and API keys"],
    note: "Connections require appropriate credentials and provider activation.",
    image: team, imageAlt: "Fundlane team management with synthetic members and role controls",
    detail: { heading: "Everyone has a role", rows: [["Owner", "Company visibility"], ["Manager", "Coordinate the team"], ["Rep", "Work assigned deals"]] },
  },
]

export const featuredIds: readonly FeatureId[] = ["intake", "underwriting", "funders", "submissions", "assistant", "reporting"]
