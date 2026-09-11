import type { Metadata } from "next"
import { MarketingHome } from "@/components/marketing/home"
import { marketingMetadata } from "@/lib/marketing/metadata"

export const metadata: Metadata = marketingMetadata("MCA brokerage software, from application to renewal", "/")

export default function HomePage() {
  return <MarketingHome />
}
