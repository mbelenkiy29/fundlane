"use client"

import Link from "next/link"
import { useState } from "react"
import { VoiceLauncher } from "@/components/mca/voice/voice-launcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { DocumentPanel } from "@/components/mca/documents/document-panel"
import { DealMessages } from "@/components/mca/email/deal-messages"
import { formatCents, formatMcaDate } from "@/components/mca/accounting/format"
import { ordinal } from "@/lib/mca/deals/book-math"
import type { BookDetail } from "@/lib/mca/deals/book-contracts"

const STATUS_LABEL = { active: "Active", paid_off: "Paid off", defaulted: "Defaulted", in_collections: "In collections" } as const

export function MerchantSheet({ detail, open, onOpenChange, focusSms }: {
  detail: BookDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
  focusSms?: boolean
}) {
  const [channel,setChannel]=useState<"sms"|"email">("sms")
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {!detail ? <p className="p-4 text-sm text-muted-foreground">Loading merchant…</p> : <>
          <SheetHeader>
            <SheetTitle>{detail.dbaName || detail.legalName}</SheetTitle>
            <SheetDescription>{detail.legalName} · {detail.displayId} · {detail.funderName} · {ordinal(detail.advanceNumber)} position</SheetDescription>
          </SheetHeader>
          <div className="space-y-5 px-4 pb-8">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{STATUS_LABEL[detail.servicingStatus]}</Badge>
              {detail.renewalEligible && <Badge>Renewal eligible</Badge>}
              {detail.contactPhone && <VoiceLauncher dealId={detail.dealId} />}
              <Button size="sm" variant="outline" onClick={()=>{setChannel("sms");document.getElementById("merchant-sms")?.scrollIntoView({behavior:"smooth"})}}>Text</Button>
              <Button size="sm" variant="outline" onClick={()=>{setChannel("email");document.getElementById("merchant-sms")?.scrollIntoView({behavior:"smooth"})}}>Email</Button>
              <Button size="sm" variant="outline" asChild><Link href={`/pipeline?deal=${detail.dealId}`}>Full application</Link></Button>
            </div>
            <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3">
              {([
                ["Advance amount", formatCents(detail.principalCents)],
                ["Payback", formatCents(detail.paybackCents)],
                ["Factor", detail.factorRate?.toFixed(4) ?? "—"],
                ["Date funded", formatMcaDate(detail.fundedAt)],
                ["Payment", formatCents(detail.periodicPaymentCents)],
                ["Frequency", detail.paymentFrequency ?? "—"],
                ["Balance", formatCents(detail.balanceRemainingCents)],
                ["Paid down", detail.paidDownBasisPoints === null ? "—" : `${(detail.paidDownBasisPoints / 100).toFixed(1)}%${detail.paidDownEstimated ? " est." : ""}`],
                ["Next payment", detail.nextPaymentDate ? formatMcaDate(detail.nextPaymentDate) : "—"],
                ["Rep", detail.assignedRep ?? "—"],
                ...(detail.commissionEarnedCents !== undefined ? [["Commission", formatCents(detail.commissionEarnedCents)] as const] : []),
              ] as Array<[string, string]>).map(([label, value]) => (
                <div key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="text-sm font-medium">{value}</p></div>
              ))}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">Updated documents</h3>
              <DocumentPanel dealId={detail.dealId} />
            </div>
            <div id="merchant-sms">
              <DealMessages dealId={detail.dealId} channel={channel} />
            </div>
            {focusSms && <p className="text-xs text-muted-foreground">The SMS composer is in the Messages section. Consent is required before a send.</p>}
          </div>
        </>}
      </SheetContent>
    </Sheet>
  )
}
