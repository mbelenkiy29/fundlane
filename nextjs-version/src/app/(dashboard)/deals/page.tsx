import type { Metadata } from "next"
import { DealsBook } from "@/components/mca/deals-book/deals-book"
import { DEALS_PAGE_TITLE } from "@/lib/mca/app-paths"

export const metadata: Metadata = { title: DEALS_PAGE_TITLE }

export default function DealsPage() {
  return <DealsBook />
}
