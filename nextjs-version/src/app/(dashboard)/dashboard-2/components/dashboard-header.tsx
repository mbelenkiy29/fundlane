"use client"

import { useState } from "react"
import { Calendar, Clock, RefreshCw, Filter } from "lucide-react"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import type { Dashboard2DateRange } from "@/lib/mca/dashboard2/map-kpis"

export function DashboardHeader({
  dateRange,
  onDateRangeChange,
  onRefresh,
  refreshing,
  lastUpdated,
}: {
  dateRange?: Dashboard2DateRange
  onDateRangeChange?: (range: Dashboard2DateRange) => void
  onRefresh?: () => void
  refreshing?: boolean
  lastUpdated?: string
} = {}) {
  const [uncontrolledRange, setUncontrolledRange] = useState<Dashboard2DateRange>("30d")
  const range = dateRange ?? uncontrolledRange
  const updated = lastUpdated || "—"

  function handleRange(next: Dashboard2DateRange) {
    onDateRangeChange?.(next)
    if (dateRange == null) setUncontrolledRange(next)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-3xl font-bold">Overview</CardTitle>
            <CardDescription className="text-base mt-2">
              Funded volume, commissions, and pipeline activity for the selected range
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="cursor-pointer">
              <Clock className="h-3 w-3 mr-1" />
              Live Data
            </Badge>
            <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => onRefresh?.()} disabled={refreshing}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
        
        <Separator className="my-4" />
        
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Date Range:</span>
              <Select value={range} onValueChange={(value) => handleRange(value as Dashboard2DateRange)}>
                <SelectTrigger className="w-40 max-w-full cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7d" className="cursor-pointer">Last 7 days</SelectItem>
                  <SelectItem value="30d" className="cursor-pointer">Last 30 days</SelectItem>
                  <SelectItem value="90d" className="cursor-pointer">Last 90 days</SelectItem>
                  <SelectItem value="1y" className="cursor-pointer">Last year</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" className="cursor-pointer">
              <Filter className="h-4 w-4 mr-2" />
              Filters
            </Button>
          </div>
          
          <div className="text-sm text-muted-foreground">
            Last updated: {updated}
          </div>
        </div>
      </CardHeader>
    </Card>
  )
}
