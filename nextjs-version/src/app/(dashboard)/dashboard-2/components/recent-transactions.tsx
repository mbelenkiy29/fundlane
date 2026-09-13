"use client"

import Link from "next/link"
import { Eye, MoreHorizontal } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { NO_ACTIVITY_YET, type Dashboard2ActivityRow } from "@/lib/mca/dashboard2/map-kpis"

export function RecentTransactions({ activity }: { activity?: Dashboard2ActivityRow[] }) {
  const transactions = activity ?? []

  return (
    <Card className="cursor-pointer">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div>
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
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 cursor-pointer">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem className="cursor-pointer">View Details</DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer">Download Receipt</DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer">Contact Customer</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
