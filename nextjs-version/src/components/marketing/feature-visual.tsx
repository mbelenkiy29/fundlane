import Image from "next/image"
import { ArrowUpRight } from "lucide-react"
import type { MarketingFeature } from "./catalog"

/** Editorial product details are explicitly illustrative, never simulated live controls. */
export function FeatureVisual({ feature, compact = false }: { feature: MarketingFeature; compact?: boolean }) {
  const Icon = feature.icon
  if (feature.image && !compact) return (
    <figure className="fl-product-figure">
      <div className="fl-image-frame"><Image src={feature.image} alt={feature.imageAlt ?? feature.title} sizes="(max-width: 760px) 94vw, 680px" /></div>
      <figcaption>Illustrative data <a href={feature.image.src} target="_blank" rel="noopener noreferrer">View full-size preview <ArrowUpRight size={12} aria-hidden="true" /></a></figcaption>
    </figure>
  )
  return (
    <figure className={`fl-detail-figure${compact ? " fl-detail-compact" : ""}`}>
      <div className="fl-detail-heading"><Icon size={19} aria-hidden="true" /><span>{feature.detail.heading}</span></div>
      <dl>{feature.detail.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <figcaption>Illustrative workflow</figcaption>
    </figure>
  )
}
