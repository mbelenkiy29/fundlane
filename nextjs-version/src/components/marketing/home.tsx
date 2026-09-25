import Image from "next/image"
import heroImage from "../../../public/marketing/architecture-hero.png"
import captureImage from "../../../public/marketing/capture.png"
import reviewImage from "../../../public/marketing/review.png"
import submitImage from "../../../public/marketing/submit.png"
import renewImage from "../../../public/marketing/renew.png"
import offersImage from "../../../public/marketing/offers.png"
import teamImage from "../../../public/marketing/team.png"
import Link from "next/link"
import {
  ArrowRight,
  Check,
  UsersRound,
  ChevronDown,
} from "lucide-react"
import { MarketingShell, DemoLink } from "./shell"
import { marketingFeatures } from "./catalog"
import { BentoVisual } from "./bento-visual"
import { ActivityStream } from "./activity-stream"
import { MARKETING_DESCRIPTION } from "@/lib/marketing/metadata"

const stages = [
  {
    name: "Application",
    title: "A complete picture starts with the application.",
    text: "Bring applications, imports, and supporting documents together. See what’s missing before the next handoff.",
    action: "Next action: review the deal file",
    image: captureImage,
    alt: "Synthetic Harbor Coffee deal in Fundlane’s application workspace",
  },
  {
    name: "Review",
    title: "Understand the deal before you send it.",
    text: "Review bank-statement analysis, correct extracted details, and compare funder eligibility. Understand the reasons behind a fit score.",
    action: "Next action: review eligible funders",
    image: reviewImage,
    alt: "Fundlane underwriting tools for a synthetic Harbor Coffee application",
  },
  {
    name: "Submit",
    title: "Keep every submission in view.",
    text: "Choose funders, review your package, and follow submission progress. Give exceptions and duplicate checks the attention they need.",
    action: "Next action: follow up on submissions",
    image: submitImage,
    alt: "Fundlane submission tracking with synthetic brokerage deals",
  },
  {
    name: "Offers and funding",
    title: "Turn the selected offer into a clear closing plan.",
    text: "Compare terms, track revisions, and collect outstanding requirements. Keep your team aligned through the funding decision.",
    action: "Next action: review closing requirements",
    image: offersImage,
    alt: "Fundlane offer terms for a synthetic Northside Kitchen application",
  },
  {
    name: "Renew",
    title: "The relationship continues after funding.",
    text: "Record funding, track the advance, and keep renewal opportunities visible. Carry the deal’s history into your next conversation.",
    action: "Next action: review renewal eligibility",
    image: renewImage,
    alt: "Fundlane renewal workspace with synthetic funding history",
  },
]
const faqs = [
  ["What can the AI assistant help with?", "Ask questions about accessible deals, draft communications, research public sources, and work with supported files. Approval-required messages and submissions stay under your control. Tools depend on enabled capabilities and available credits."],
  [
    "Who is Fundlane for?",
    "Fundlane is built for MCA brokerage owners and their teams. It brings the work of managing applications, underwriting, submissions, offers, and renewals into a shared workspace.",
  ],
  [
    "Can we bring our existing deals?",
    "Fundlane includes spreadsheet imports, field mapping, and review tools. In your demo, we can walk through how your current records and document packages would fit the import workflow.",
  ],
  [
    "How does funder matching work?",
    "Matching compares deal information against configured funder criteria. Rankings explain fit and eligibility, including missing information or restrictions. A fit score is not a prediction or guarantee of approval.",
  ],
  [
    "Can we connect our application forms and communication tools?",
    "Fundlane supports configurable intake and communication workflows. Availability depends on the provider, credentials, and activation requirements. We’ll review the tools your brokerage uses during the demo.",
  ],
  [
    "Can I control what my team sees?",
    "Company roles, deal assignments, and financial visibility controls help you give each teammate the access they need. The demo can cover how owners, managers, and reps work together.",
  ],
  [
    "What happens when I request a demo?",
    "Tell us about your brokerage and what you’d like to improve. We’ll use those details to follow up about a walkthrough of the product and your team’s requirements.",
  ],
]

export function MarketingHome() {
  return (
    <MarketingShell
      immersive
      jsonLd={{ title: "MCA brokerage software, from application to renewal", path: "/" }}
    >
      <main id="main">
        <section className="fl-hero">
          <Image src={heroImage} alt="" fill sizes="100vw" preload className="fl-hero-background" />
          <div className="fl-hero-scrim" />
          <div className="fl-container fl-hero-content">
            <div className="fl-hero-copy">
              <p className="fl-audience"><span />The workspace for MCA brokerages</p>
              <h1>Run your MCA brokerage from application to renewal.</h1>
              <p className="fl-hero-description">{MARKETING_DESCRIPTION}</p>
              <div className="fl-actions"><DemoLink /><Link href="#workflow" className="fl-text-link">Explore the workflow <ArrowRight size={17} aria-hidden="true" /></Link></div>
            </div>
            <div className="fl-hero-foot"><span>One connected deal workflow</span><a href="#activity">Explore Fundlane <span aria-hidden="true">↓</span></a></div>
          </div>
        </section>
        <div id="activity"><ActivityStream /></div>
        <section className="fl-container fl-metrics" aria-label="The Fundlane workspace">
          {[["11", "categories", "Every part of the deal"], ["5", "stages", "Application through renewal"], ["3", "modes", "Control how submissions move"], ["1", "workspace", "A shared view for your team"]].map(([value, unit, description]) => <div key={unit}><p><span>{value}</span> <small>{unit}</small></p><p>{description}</p></div>)}
        </section>
        <section className="fl-container fl-purpose">
          <p className="fl-section-label">Built around the life of a deal</p>
          <h2>A shared picture.<br />A clear next step.</h2>
          <p>An application becomes a review. A submission becomes a conversation. An offer becomes the next opportunity. Fundlane connects the information and the people behind each handoff.</p>
          <div className="fl-purpose-points"><span><Check size={16} aria-hidden="true" />The deal’s full context</span><span><Check size={16} aria-hidden="true" />Clear team ownership</span><span><Check size={16} aria-hidden="true" />Visible next actions</span></div>
        </section>
        <section id="workflow" className="fl-section fl-workflow-section">
          <div className="fl-container">
            <div className="fl-section-heading">
              <p className="fl-section-label">How it works</p>
              <h2>
                Every deal has a next step.
                <br />
                Make it a clear one.
              </h2>
              <p>
                Follow the work from first application to the next funding
                conversation.
              </p>
            </div>
            <fieldset className="fl-workflow">
              <legend className="fl-sr-only">Explore the deal workflow</legend>
              {stages.map((stage, i) => (
                <input
                  className="fl-stage-radio"
                  type="radio"
                  name="workflow"
                  id={`fl-stage-${i}`}
                  key={stage.name}
                  defaultChecked={i === 0}
                  aria-label={stage.name}
                />
              ))}
              <div className="fl-stage-labels">
                {stages.map((stage, i) => (
                  <label htmlFor={`fl-stage-${i}`} key={stage.name}>
                    <span>{i + 1}</span>
                    {stage.name}
                  </label>
                ))}
              </div>
              <div className="fl-stage-panels">
                {stages.map((stage, i) => (
                  <div
                    className={`fl-stage-panel fl-stage-panel-${i}`}
                    key={stage.name}
                  >
                    <div className="fl-stage-copy">
                      <h3>{stage.title}</h3>
                      <p>{stage.text}</p>
                      <div className="fl-next-action">
                        <Check size={16} aria-hidden="true" />
                        {stage.action}
                      </div>
                      <Link className="fl-text-link" href="/demo">
                        See it in your demo
                        <ArrowRight size={16} aria-hidden="true" />
                      </Link>
                    </div>
                    <figure>
                      <Image
                        src={stage.image}
                        alt={stage.alt}
                        sizes="(max-width: 760px) 94vw, 720px"
                      />
                      <figcaption>
                        Illustrative data ·{" "}
                        <a
                          href={stage.image.src}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="fl-inline-link"
                        >
                          View full-size preview
                        </a>
                      </figcaption>
                    </figure>
                  </div>
                ))}
              </div>
            </fieldset>
          </div>
        </section>
        <section id="product" className="fl-section fl-container">
          <div className="fl-section-heading fl-heading-split">
            <div>
              <p className="fl-section-label">Built around your work</p>
              <h2>
                The whole deal.
                <br />
                All within reach.
              </h2>
            </div>
            <p>
              Give your team a shared view of the work, the handoffs, and the
              details that matter.
            </p>
          </div>
          <div className="fl-feature-grid">
            {[...marketingFeatures.filter(feature => ["underwriting", "funders", "closing"].includes(feature.id)), ...marketingFeatures.filter(feature => !["underwriting", "funders", "closing"].includes(feature.id))].map(feature => (
              <article key={feature.id}>
                <BentoVisual feature={feature} />
                <div className="fl-card-copy"><h3><Link href={`/features#${feature.id}`}>{feature.title}<ArrowRight size={17} aria-hidden="true" /></Link></h3><p>{feature.summary}</p><ul className="fl-card-capabilities">{feature.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul>{feature.note && <p className="fl-feature-note">{feature.note}</p>}</div>
              </article>
            ))}
          </div>
          <div className="fl-feature-more"><Link href="/features" className="fl-button fl-button-secondary">Explore all features <ArrowRight size={16} aria-hidden="true" /></Link></div>
        </section>
        <section className="fl-team-section">
          <div className="fl-container fl-team-grid">
            <div>
              <UsersRound size={28} strokeWidth={1.5} aria-hidden="true" />
              <h2>
                Your team, working
                <br />
                from the same page.
              </h2>
              <p>
                Keep ownership clear and financial information in the right
                hands. See the work across your brokerage without losing the
                details of a single deal.
              </p>
              <ul>
                <li>
                  <Check />
                  Clear assignments for reps and managers
                </li>
                <li>
                  <Check />
                  Role-based access and financial visibility
                </li>
                <li>
                  <Check />
                  Team, funder, and lead-source reporting
                </li>
              </ul>
              <DemoLink />
            </div>
            <figure className="fl-team-image">
              <Image
                src={teamImage}
                alt="Fundlane company team controls with synthetic team members"
                sizes="(max-width: 760px) 94vw, 660px"
              />
              <figcaption>
                Give each teammate the right access. Illustrative data.
              </figcaption>
            </figure>
          </div>
        </section>
        <section id="faq" className="fl-section fl-container fl-faq">
          <div className="fl-section-heading">
            <p className="fl-section-label">A few things to know</p>
            <h2>Before we meet.</h2>
            <p>
              Have a question specific to your brokerage?
              <br />
              <Link href="/demo" className="fl-inline-link">
                Bring it to your demo.
              </Link>
            </p>
          </div>
          <div className="fl-faq-items">
            {faqs.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="fl-closing">
          <div className="fl-container">
            <div>
              <p className="fl-section-label">Let’s walk through it</p>
              <h2>
                A clearer way to run
                <br />
                your brokerage.
              </h2>
              <p>See how Fundlane brings your deal workflow together.</p>
            </div>
            <DemoLink />
          </div>
        </section>
      </main>
    </MarketingShell>
  )
}
