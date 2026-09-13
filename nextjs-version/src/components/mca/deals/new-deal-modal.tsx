"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ApplicationScanPanel } from "@/components/mca/documents/application-scan-panel"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { DealDetail } from "@/lib/mca/deals/schema"
import { DealForm, applyWriteInput, emptyDraft, formPayload, type DraftForm } from "@/components/mca/deals/deal-form"
import { DuplicateMerchantDialog } from "@/components/mca/deals/duplicate-merchant-dialog"
import { loadAttachPayload, lookupMerchantMatches, merchantMatchesFromError } from "@/components/mca/deals/merchant-lookup"
import type { MerchantMatch } from "@/lib/mca/merchants/contracts"

export function NewDealModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (deal: { id: string; displayId: string; draftState?: string }) => void
}) {
  const [tab, setTab] = React.useState("ai")
  const [form, setForm] = React.useState<DraftForm>(emptyDraft)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({})
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID())
  const [attachMerchantId, setAttachMerchantId] = React.useState<string>()
  const [forceDuplicate, setForceDuplicate] = React.useState(false)
  const [match, setMatch] = React.useState<MerchantMatch>()
  const [duplicateOpen, setDuplicateOpen] = React.useState(false)
  const [proceedOnChoice, setProceedOnChoice] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setTab("ai")
    setForm(emptyDraft())
    setFieldErrors({})
    setSaving(false)
    setError(undefined)
    setIdempotencyKey(crypto.randomUUID())
    setAttachMerchantId(undefined)
    setForceDuplicate(false)
    setMatch(undefined)
    setDuplicateOpen(false)
    setProceedOnChoice(false)
  }, [open])

  function handleCreated(deal: { id: string; displayId: string; draftState?: string }) {
    onCreated?.(deal)
    onOpenChange(false)
  }

  async function createFromForm(next: DraftForm, flags: { attachMerchantId?: string; forceDuplicate?: boolean }) {
    setSaving(true)
    setFieldErrors({})
    setError(undefined)
    try {
      const deal = await requestJson<DealDetail>("/api/mca/deals", {
        method: "POST",
        body: JSON.stringify({
          ...formPayload(next),
          idempotencyKey,
          attachMerchantId: flags.attachMerchantId,
          forceDuplicate: flags.forceDuplicate,
        }),
      })
      handleCreated(deal)
    } catch (caught) {
      const matches = merchantMatchesFromError(caught)
      if (matches[0]) {
        setMatch(matches[0])
        setProceedOnChoice(true)
        setDuplicateOpen(true)
        return
      }
      if (caught instanceof RequestError) {
        setFieldErrors(caught.fieldErrors ?? {})
        setError(caught.message)
        return
      }
      setError(caught instanceof Error ? caught.message : "Could not save the draft.")
    } finally {
      setSaving(false)
    }
  }

  async function saveManual(overrides?: { form?: DraftForm; attachMerchantId?: string; forceDuplicate?: boolean }) {
    const current = overrides?.form ?? form
    const attach = overrides && "attachMerchantId" in overrides ? overrides.attachMerchantId : attachMerchantId
    const force = overrides && "forceDuplicate" in overrides ? Boolean(overrides.forceDuplicate) : forceDuplicate
    setSaving(true)
    setError(undefined)
    try {
      if (!attach && !force) {
        const matches = await lookupMerchantMatches({ ein: current.ein, owners: current.owners })
        if (matches[0]) {
          setMatch(matches[0])
          setProceedOnChoice(true)
          setDuplicateOpen(true)
          return
        }
      }
      await createFromForm(current, { attachMerchantId: attach, forceDuplicate: force })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Merchant lookup failed.")
    } finally {
      setSaving(false)
    }
  }

  async function attachExisting() {
    if (!match) return
    setSaving(true)
    setError(undefined)
    try {
      const payload = await loadAttachPayload(match.merchantId)
      const merged = applyWriteInput(form, payload.fields)
      setForm(merged)
      setAttachMerchantId(payload.merchantId)
      setForceDuplicate(false)
      setDuplicateOpen(false)
      if (proceedOnChoice) await createFromForm(merged, { attachMerchantId: payload.merchantId, forceDuplicate: false })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the existing merchant.")
    } finally {
      setSaving(false)
    }
  }

  function createAnyway() {
    setForceDuplicate(true)
    setAttachMerchantId(undefined)
    setDuplicateOpen(false)
    if (proceedOnChoice) void saveManual({ forceDuplicate: true, attachMerchantId: undefined })
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>Upload an application or enter merchant details. Partial drafts are allowed.</DialogDescription>
          </DialogHeader>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="ai">AI Upload</TabsTrigger>
              <TabsTrigger value="manual">Manual Entry</TabsTrigger>
            </TabsList>
            <TabsContent value="ai" forceMount className={tab === "ai" ? undefined : "hidden"}>
              {open ? <ApplicationScanPanel embedded onCreated={handleCreated} /> : null}
            </TabsContent>
            <TabsContent value="manual" forceMount className={tab === "manual" ? undefined : "hidden"}>
              <DealForm form={form} setForm={setForm} fieldErrors={fieldErrors} />
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button type="button" onClick={() => void saveManual()} disabled={saving}>
                  {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Save as Draft
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <DuplicateMerchantDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        merchantName={match?.legalName ?? ""}
        busy={saving}
        onAttach={() => void attachExisting()}
        onCreateNew={createAnyway}
      />
    </>
  )
}
