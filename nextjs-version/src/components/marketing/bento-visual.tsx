import type { MarketingFeature } from "./catalog"
import { FeatureVisual } from "./feature-visual"
import { StatusChip } from "./status-chip"

export function BentoVisual({ feature }: { feature: MarketingFeature }) {
  if (!["underwriting", "funders", "closing"].includes(feature.id)) return <FeatureVisual feature={feature} compact />
  return <figure className="fl-bento-visual">
    <div className="fl-visual-title">{feature.detail.heading}</div>
    {feature.id === "underwriting" && <dl className="fl-review-rows">{[["Merchant details", "PASS"], ["Bank statements", "PASS"], ["Missing pages", "CHECK"]].map(([label, status]) => <div key={label}><dt>{label}</dt><dd><StatusChip status={status === "PASS" ? "success" : "neutral"}>{status}</StatusChip></dd></div>)}</dl>}
    {feature.id === "funders" && <div className="fl-criteria-bars">{[["Example Capital", 4, 1], ["Sample Funding", 3, 2], ["Demo Finance", 2, 3]].map(([name, met, review]) => <div key={name}><div><span>{name}</span><span>{met}/5 met</span></div><div className="fl-stacked-bar"><span style={{ width: `${Number(met) * 20}%` }} /><span style={{ width: `${Number(review) * 20}%` }} /></div></div>)}<p>5 illustrative criteria · Blue: met · Gray: review</p></div>}
    {feature.id === "closing" && <div className="fl-offer-diff"><div><span>Offer revision</span><span>v1 → v2</span></div><p className="fl-diff-before">− Term: 6 months</p><p className="fl-diff-modified">~ Term: 8 months</p><p className="fl-diff-added">+ Updated stipulations</p><p className="fl-diff-added">+ Revision saved to deal</p></div>}
    <figcaption>Illustrative {feature.id === "closing" ? "terms, not a financing offer" : "workflow"}</figcaption>
  </figure>
}
