"use client"

import { useState } from "react"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Users, MapPin, TrendingUp, Target, UserIcon } from "lucide-react"
import {
  EMPTY_DASHBOARD2,
  NO_ACTIVITY_YET,
  type Dashboard2GrowthMetrics,
  type Dashboard2GrowthPoint,
  type Dashboard2ShareRow,
} from "@/lib/mca/dashboard2/map-kpis"

const chartConfig = {
  new: {
    label: "New merchants",
    color: "var(--chart-1)",
  },
  returning: {
    label: "Returning",
    color: "var(--chart-2)",
  },
  churn: {
    label: "Churned",
    color: "var(--chart-3)",
  },
}

export function CustomerInsights({
  growth,
  growthMetrics,
  industries,
  states,
}: {
  growth?: Dashboard2GrowthPoint[]
  growthMetrics?: Dashboard2GrowthMetrics
  industries?: Dashboard2ShareRow[]
  states?: Dashboard2ShareRow[]
}) {
  const [activeTab, setActiveTab] = useState("growth")
  const customerGrowthData = growth ?? EMPTY_DASHBOARD2.growth
  const metrics = growthMetrics ?? EMPTY_DASHBOARD2.growthMetrics
  const demographicsData = industries ?? EMPTY_DASHBOARD2.industries
  const regionsData = states ?? EMPTY_DASHBOARD2.states
  const growthEmpty = customerGrowthData.length === 0 || customerGrowthData.every((row) => row.new === 0 && row.returning === 0 && row.churn === 0)

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Customer Insights</CardTitle>
        <CardDescription>Growth trends and demographics</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3 bg-muted/50 p-1 rounded-lg h-12">
            <TabsTrigger
              value="growth"
              className="cursor-pointer flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-foreground"
            >
              <TrendingUp className="h-4 w-4" />
              <span className="hidden sm:inline">Growth</span>
            </TabsTrigger>
            <TabsTrigger
              value="demographics"
              className="cursor-pointer flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-foreground"
            >
              <UserIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Demographics</span>
            </TabsTrigger>
            <TabsTrigger
              value="regions"
              className="cursor-pointer flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-foreground"
            >
              <MapPin className="h-4 w-4" />
              <span className="hidden sm:inline">Regions</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="growth" className="mt-8 space-y-6">
            <div className="grid gap-6">
              {/* Chart and Key Metrics Side by Side */}
              <div className="grid grid-cols-10 gap-6">
                {/* Chart Area - 70% */}
                <div className="col-span-10 xl:col-span-7">
                  <h3 className="text-sm font-medium text-muted-foreground mb-6">Customer Growth Trends</h3>
                  {growthEmpty ? (
                    <div className="flex h-[375px] items-center justify-center text-sm text-muted-foreground">{NO_ACTIVITY_YET}</div>
                  ) : (
                    <ChartContainer config={chartConfig} className="h-[375px] w-full">
                      <BarChart data={customerGrowthData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis
                          dataKey="month"
                          className="text-xs"
                          tick={{ fontSize: 12 }}
                          tickLine={{ stroke: 'var(--border)' }}
                          axisLine={{ stroke: 'var(--border)' }}
                        />
                        <YAxis
                          className="text-xs"
                          tick={{ fontSize: 12 }}
                          tickLine={{ stroke: 'var(--border)' }}
                          axisLine={{ stroke: 'var(--border)' }}
                          domain={[0, 'dataMax']}
                        />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="new" fill="var(--color-new)" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="returning" fill="var(--color-returning)" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="churn" fill="var(--color-churn)" radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ChartContainer>
                  )}
                </div>

                {/* Key Metrics - 30% */}
                <div className="col-span-10 xl:col-span-3 space-y-5">
                  <h3 className="text-sm font-medium text-muted-foreground mb-6">Key Metrics</h3>
                  <div className="grid grid-cols-3 gap-5">
                    <div className="p-4 rounded-lg max-lg:col-span-3 xl:col-span-3 border">
                      <div className="flex items-center gap-2 mb-2">
                        <TrendingUp className="h-4 w-4 text-primary" />
                        <span className="text-sm font-medium">Total Customers</span>
                      </div>
                      <div className="text-2xl font-bold">{metrics.totalCustomers}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                        {metrics.totalCustomersHint}
                      </div>
                    </div>

                    <div className="p-4 rounded-lg max-lg:col-span-3 xl:col-span-3 border">
                      <div className="flex items-center gap-2 mb-2">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">Retention Rate</span>
                      </div>
                      <div className="text-2xl font-bold">{metrics.retention}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                        {metrics.retentionHint}
                      </div>
                    </div>

                    <div className="p-4 rounded-lg max-lg:col-span-3 xl:col-span-3 border">
                      <div className="flex items-center gap-2 mb-2">
                        <Target className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">Collections today</span>
                      </div>
                      <div className="text-2xl font-bold">{metrics.collections}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                        {metrics.collectionsHint}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="demographics" className="mt-8">
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="border-b">
                    <TableHead className="py-5 px-6 font-semibold">Industry</TableHead>
                    <TableHead className="text-right py-5 px-6 font-semibold">Merchants</TableHead>
                    <TableHead className="text-right py-5 px-6 font-semibold">Percentage</TableHead>
                    <TableHead className="text-right py-5 px-6 font-semibold">Funded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {demographicsData.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-5 px-6 text-sm text-muted-foreground">{NO_ACTIVITY_YET}</TableCell>
                    </TableRow>
                  ) : demographicsData.map((row, index) => (
                    <TableRow key={`${row.label}-${index}`} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="font-medium py-5 px-6">{row.label}</TableCell>
                      <TableCell className="text-right py-5 px-6">{row.customers.toLocaleString()}</TableCell>
                      <TableCell className="text-right py-5 px-6">{row.percentage}</TableCell>
                      <TableCell className="text-right py-5 px-6">
                        <span className={`font-medium ${row.growthColor}`}>{row.revenue}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-end space-x-2 py-6">
              <div className="text-muted-foreground text-sm hidden sm:block">
                0 of {demographicsData.length} row(s) selected.
              </div>
              <div className="space-x-2 space-y-2">
                <Button variant="outline" size="sm" disabled>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled>
                  Next
                </Button>
              </div>
            </div>
          </TabsContent>


          <TabsContent value="regions" className="mt-8">
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="border-b">
                    <TableHead className="py-5 px-6 font-semibold">State</TableHead>
                    <TableHead className="text-right py-5 px-6 font-semibold">Merchants</TableHead>
                    <TableHead className="text-right py-5 px-6 font-semibold">Funded</TableHead>
                    <TableHead className="text-right py-5 px-6 font-semibold">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {regionsData.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-5 px-6 text-sm text-muted-foreground">{NO_ACTIVITY_YET}</TableCell>
                    </TableRow>
                  ) : regionsData.map((row, index) => (
                    <TableRow key={`${row.label}-${index}`} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="font-medium py-5 px-6">{row.label}</TableCell>
                      <TableCell className="text-right py-5 px-6">{row.customers.toLocaleString()}</TableCell>
                      <TableCell className="text-right py-5 px-6">{row.revenue}</TableCell>
                      <TableCell className="text-right py-5 px-6">
                        <span className={`font-medium ${row.growthColor}`}>{row.percentage}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-end space-x-2 py-6">
              <div className="text-muted-foreground text-sm hidden sm:block">
                0 of {regionsData.length} row(s) selected.
              </div>
              <div className="space-x-2 space-y-2">
                <Button variant="outline" size="sm" disabled>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled>
                  Next
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
