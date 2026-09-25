"use client"

import { DealWorkflowPicker } from "@/components/mca/deal-workflow-picker"
import { ExportPanel } from "@/components/mca/exports/export-panel"
import { OffersPanel } from "@/components/mca/offers/offers-panel"
import { ClosingPanel } from "@/components/mca/closing/closing-panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EXPORT_PANEL_COPY } from "@/lib/mca/exports/contracts"

export function OffersWorkspace() {
  return <div className="space-y-6 px-4 lg:px-6">
    <div><h1 className="text-2xl font-semibold tracking-tight">Offers and closing</h1><p className="mt-1 text-sm text-muted-foreground">Compare terms, select offers, collect closing documents and confirm funding.</p></div>
    <div id="mca-export-panel"><ExportPanel scopeNote={EXPORT_PANEL_COPY.offersWorkspace} /></div>
    <DealWorkflowPicker>{(deal, refresh) => <Tabs defaultValue="offers">
      <TabsList><TabsTrigger value="offers">Offers and funding</TabsTrigger><TabsTrigger value="closing">Closing and merchant messages</TabsTrigger></TabsList>
      <TabsContent value="offers"><OffersPanel dealId={deal.id} onChanged={refresh} /></TabsContent>
      <TabsContent value="closing"><ClosingPanel dealId={deal.id} onChanged={refresh} /></TabsContent>
    </Tabs>}</DealWorkflowPicker>
  </div>
}
