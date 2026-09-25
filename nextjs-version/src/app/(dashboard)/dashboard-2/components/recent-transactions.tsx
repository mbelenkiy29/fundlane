"use client"

import { useState } from "react"
import Link from "next/link"
import { Eye, MoreHorizontal } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { DealMessages } from "@/components/mca/email/deal-messages"
import { NO_ACTIVITY_YET, transactionReceipt, type Dashboard2ActivityRow } from "@/lib/mca/dashboard2/map-kpis"

export function RecentTransactions({ activity }: { activity?: Dashboard2ActivityRow[] }) {
  const transactions = activity ?? []
  const [selected, setSelected] = useState<{ row: Dashboard2ActivityRow; contact: boolean } | null>(null)

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <CardTitle>Recent Transactions</CardTitle>
          <CardDescription>Latest funding and payment activity</CardDescription>
        </div>
        <Button variant="outline" size="sm" className="cursor-pointer" asChild>
          <Link href="/payments">
            <Eye className="h-4 w-4 mr-2" />
            View All
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_ACTIVITY_YET}</p>
        ) : transactions.map((transaction) => (
          <div key={transaction.id} >
            <div className="flex p-3 rounded-lg border gap-2">
              <Avatar className="h-8 w-8">
                <AvatarFallback>{transaction.customer.name.split(" ").map(n => n[0]).join("").slice(0, 2)}</AvatarFallback>
              </Avatar>
              <div className="flex flex-1 items-center flex-wrap justify-between gap-1">
                <div className="flex items-center space-x-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{transaction.customer.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{transaction.customer.email}</p>
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                  <Badge
                    variant={
                      transaction.status === "completed" ? "default" :
                      transaction.status === "pending" ? "secondary" : "destructive"
                    }
                    className="cursor-pointer"
                  >
                    {transaction.status}
                  </Badge>
                  <div className="text-right">
                    <p className="text-sm font-medium">{transaction.amount}</p>
                    <p className="text-xs text-muted-foreground">{transaction.date}</p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 cursor-pointer" aria-label={`Actions for ${transaction.customer.name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem className="cursor-pointer" onSelect={() => setSelected({ row: transaction, contact: false })}>View Details</DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" asChild>
                        <a download={`transaction-${transaction.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`} href={`data:text/plain;charset=utf-8,${encodeURIComponent(transactionReceipt(transaction))}`}>Download Receipt</a>
                      </DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" onSelect={() => setSelected({ row: transaction, contact: true })}>Contact Customer</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.contact ? "Contact Customer" : "Transaction Details"}</DialogTitle>
            <DialogDescription>{selected?.row.customer.name}</DialogDescription>
          </DialogHeader>
          {selected && (selected.contact ? (
            <DealMessages key={selected.row.dealId} dealId={selected.row.dealId} channel="email" />
          ) : (
            <div className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt>Reference</dt><dd className="break-all">{selected.row.id}</dd>
                <dt>Description</dt><dd>{selected.row.customer.email}</dd>
                <dt>Type</dt><dd className="capitalize">{selected.row.kind}</dd>
                <dt>Amount</dt><dd>{selected.row.amount}</dd>
                <dt>Status</dt><dd className="capitalize">{selected.row.recordedStatus}</dd>
                <dt>Date</dt><dd>{selected.row.at}</dd>
              </dl>
              <p className="text-sm text-muted-foreground">Downloads are demo/internal transaction summaries, not bank receipts or proof of settlement.</p>
              <Button variant="outline" asChild>
                <Link href={`/pipeline?deal=${encodeURIComponent(selected.row.dealId)}`}>Open Deal</Link>
              </Button>
            </div>
          ))}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
