"use client"

import { Columns3, MessageSquare, Phone } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useVoiceReady } from "@/components/mca/voice/voice-launcher"
import { Card } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCents, formatMcaDate } from "@/components/mca/accounting/format"
import { ordinal } from "@/lib/mca/deals/book-math"
import type { BookRow, ServicingStatus } from "@/lib/mca/deals/book-contracts"

const STATUS_LABEL: Record<ServicingStatus, string> = {
  active: "Active",
  paid_off: "Paid off",
  defaulted: "Defaulted",
  in_collections: "In collections",
}

function statusClass(status: ServicingStatus): string {
  if (status === "active") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (status === "paid_off") return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
  if (status === "defaulted") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
}

export const BOOK_COLUMNS = [
  { id: "business", label: "Business", defaultVisible: true },
  { id: "funder", label: "Lender / funder", defaultVisible: true },
  { id: "advanceNumber", label: "Advance #", defaultVisible: true },
  { id: "principal", label: "Advance amount", defaultVisible: true },
  { id: "payback", label: "Payback", defaultVisible: false },
  { id: "factorRate", label: "Factor rate", defaultVisible: false },
  { id: "fundedAt", label: "Date funded", defaultVisible: false },
  { id: "term", label: "Term / payments", defaultVisible: false },
  { id: "frequency", label: "Frequency", defaultVisible: false },
  { id: "paymentAmount", label: "Payment amount", defaultVisible: false },
  { id: "balance", label: "Balance remaining", defaultVisible: false },
  { id: "paidDown", label: "% paid down", defaultVisible: true },
  { id: "status", label: "Status", defaultVisible: true },
  { id: "rep", label: "Broker / rep", defaultVisible: false },
  { id: "commission", label: "Commission earned", defaultVisible: false },
  { id: "nextPayment", label: "Next payment", defaultVisible: true },
  { id: "contact", label: "Contact", defaultVisible: true },
] as const

export type BookColumnId = (typeof BOOK_COLUMNS)[number]["id"]

export function BookColumnPicker({ visible, onChange, showCommission }: {
  visible: Set<BookColumnId>
  onChange: (id: BookColumnId, next: boolean) => void
  showCommission: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm"><Columns3 className="size-4" />Columns</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
        {BOOK_COLUMNS.filter((column) => column.id !== "commission" || showCommission).map((column) => (
          <DropdownMenuCheckboxItem key={column.id} checked={visible.has(column.id)} onCheckedChange={(checked) => onChange(column.id, Boolean(checked))}>
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function BookTable({ rows, visible, onOpen, onSms, onCall }: {
  rows: BookRow[]
  visible: Set<BookColumnId>
  onOpen: (row: BookRow) => void
  onSms: (row: BookRow) => void
  onCall: (row: BookRow) => void
}) {
  const voiceReady = useVoiceReady()
  const show = (id: BookColumnId) => visible.has(id)
  return (
    <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {show("business") && <TableHead className="sticky left-0 z-10 min-w-48 bg-background">Business</TableHead>}
              {show("funder") && <TableHead>Lender / funder</TableHead>}
              {show("advanceNumber") && <TableHead>Advance #</TableHead>}
              {show("principal") && <TableHead>Advance amount</TableHead>}
              {show("payback") && <TableHead>Payback</TableHead>}
              {show("factorRate") && <TableHead>Factor</TableHead>}
              {show("fundedAt") && <TableHead>Date funded</TableHead>}
              {show("term") && <TableHead>Term</TableHead>}
              {show("frequency") && <TableHead>Frequency</TableHead>}
              {show("paymentAmount") && <TableHead>Payment</TableHead>}
              {show("balance") && <TableHead>Balance</TableHead>}
              {show("paidDown") && <TableHead>% paid down</TableHead>}
              {show("status") && <TableHead>Status</TableHead>}
              {show("rep") && <TableHead>Broker / rep</TableHead>}
              {show("commission") && <TableHead>Commission</TableHead>}
              {show("nextPayment") && <TableHead>Next payment</TableHead>}
              {show("contact") && <TableHead>Contact</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="cursor-pointer" onClick={() => onOpen(row)}>
                {show("business") && <TableCell className="sticky left-0 z-10 bg-background">
                  <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={(event) => { event.stopPropagation(); onOpen(row) }}>{row.dbaName || row.legalName}</button>
                  <p className="text-xs text-muted-foreground">{row.legalName}{row.dbaName ? ` · ${row.displayId}` : ` · ${row.displayId}`}</p>
                </TableCell>}
                {show("funder") && <TableCell>{row.funderName}</TableCell>}
                {show("advanceNumber") && <TableCell>{ordinal(row.advanceNumber)}</TableCell>}
                {show("principal") && <TableCell>{formatCents(row.principalCents)}</TableCell>}
                {show("payback") && <TableCell>{formatCents(row.paybackCents)}</TableCell>}
                {show("factorRate") && <TableCell>{row.factorRate?.toFixed(4) ?? "—"}</TableCell>}
                {show("fundedAt") && <TableCell>{formatMcaDate(row.fundedAt)}</TableCell>}
                {show("term") && <TableCell>{row.termMonths ? `${row.termMonths} mo` : "—"}{row.paymentCount ? ` · ${row.paymentCount}` : ""}</TableCell>}
                {show("frequency") && <TableCell className="capitalize">{row.paymentFrequency ?? "—"}</TableCell>}
                {show("paymentAmount") && <TableCell>{formatCents(row.periodicPaymentCents)}</TableCell>}
                {show("balance") && <TableCell>{formatCents(row.balanceRemainingCents)}</TableCell>}
                {show("paidDown") && <TableCell>{row.paidDownBasisPoints === null ? "—" : `${(row.paidDownBasisPoints / 100).toFixed(1)}%`}{row.paidDownEstimated ? <span className="ml-1 text-xs text-muted-foreground">est.</span> : null}</TableCell>}
                {show("status") && <TableCell><Badge variant="outline" className={statusClass(row.servicingStatus)}>{STATUS_LABEL[row.servicingStatus]}</Badge></TableCell>}
                {show("rep") && <TableCell>{row.assignedRep ?? "—"}</TableCell>}
                {show("commission") && <TableCell>{formatCents(row.commissionEarnedCents ?? null)}</TableCell>}
                {show("nextPayment") && <TableCell>{row.nextPaymentDate ? formatMcaDate(row.nextPaymentDate) : "—"}</TableCell>}
                {show("contact") && <TableCell>
                  <div className="flex gap-1" onClick={(event) => event.stopPropagation()}>
                    <Button size="icon" variant="outline" className="size-8" aria-label={`Text ${row.legalName}`} onClick={() => onSms(row)}><MessageSquare className="size-3.5" /></Button>
                    {!row.contactPhone ? <Button size="icon" variant="outline" className="size-8" aria-label={`Call ${row.legalName}`} disabled><Phone className="size-3.5" /></Button>
                      : voiceReady ? <Button size="icon" variant="outline" className="size-8" aria-label={`Call ${row.legalName}`} onClick={() => onCall(row)}><Phone className="size-3.5" /></Button>
                      : <Button size="icon" variant="outline" className="size-8" aria-label={`Call ${row.legalName}`} asChild><a href={`tel:${row.contactPhone}`}><Phone className="size-3.5" /></a></Button>}
                  </div>
                </TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
    </Card>
  )
}
