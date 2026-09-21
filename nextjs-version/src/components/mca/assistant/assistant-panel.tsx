"use client"

import { createContext, useContext, useEffect, useRef, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import Script from "next/script"
import { MessageSquare, X } from "lucide-react"
import { NativeChat } from "./native-chat"
import { ChatMessages } from "./chat-messages"
import { AssistantChat, type AssistantDeal } from "./chatkit-session"
import { Button } from "@/components/ui/button"

type AssistantRuntime = "chatkit" | "supabase"
type AssistantSession = {
  open: () => void
  deal: AssistantDeal
  setDeal: (deal: AssistantDeal) => void
  domainKey: string
  runtime: AssistantRuntime
  scriptReady: boolean
  scriptError: boolean
  requestChatkit: () => void
}
const AssistantContext = createContext<AssistantSession | null>(null)
export function useAssistantDeal(dealId?: string, label?: string) {
  const setter = useContext(AssistantContext)?.setDeal
  useEffect(() => {
    setter?.(dealId ? { id: dealId, label: label || "selected deal" } : null)
    return () => setter?.(null)
  }, [setter, dealId, label])
}
export function useAssistantSession() {
  return useContext(AssistantContext)
}
export function AssistantButton({ onOpen }: { onOpen?: () => void } = {}) {
  const assistant = useContext(AssistantContext)
  if (!assistant) return null
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        onOpen?.()
        assistant.open()
      }}
      aria-label="Open assistant"
    >
      <MessageSquare className="size-4" />
      <span className="hidden sm:inline">Assistant</span>
    </Button>
  )
}

export function AssistantProvider({
  children,
  domainKey,
  runtime = "chatkit",
}: {
  children: React.ReactNode
  domainKey: string
  runtime?: AssistantRuntime
}) {
  const [deal, setDeal] = useState<AssistantDeal>(null)
  const opener = useRef<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [scriptRequested, setScriptRequested] = useState(false)
  const [scriptReady, setScriptReady] = useState(false)
  const [scriptError, setScriptError] = useState(false)
  const [chatAttempt, setChatAttempt] = useState(0)
  const [includedDeal, setIncludedDeal] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ channel: "sms" | "email"; dealId: string; body: string } | null>(null)
  const [mobile, setMobile] = useState(false)
  const loadScript = mounted || scriptRequested
  useEffect(() => {
    if (!mounted) return
    const frame = requestAnimationFrame(() => {
      if (open) panel.current?.querySelector<HTMLButtonElement>("button")?.focus()
      else
        (opener.current?.isConnected
          ? opener.current
          : document.querySelector<HTMLElement>('[aria-label="Open assistant"]')
        )?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, mounted])
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)")
    const update = () => setMobile(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  return (
    <AssistantContext.Provider
      value={{
        deal,
        setDeal,
        domainKey,
        runtime,
        scriptReady,
        scriptError,
        requestChatkit: () => setScriptRequested(true),
        open: () => {
          opener.current = document.activeElement as HTMLElement
          setMounted(true)
          setOpen(true)
        },
      }}
    >
      {children}
      {loadScript && runtime === "chatkit" && (
        <Script
          src="https://cdn.platform.openai.com/deployments/chatkit/chatkit.js"
          strategy="afterInteractive"
          onReady={() => setScriptReady(true)}
          onError={() => setScriptError(true)}
        />
      )}
      {mounted && (
        <Dialog.Root open={open} onOpenChange={setOpen} modal={mobile}>
          <Dialog.Portal forceMount>
            {mobile && open && <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />}
            <Dialog.Content
              ref={panel}
              forceMount
              style={{ display: open ? undefined : "none" }}
              className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col border-l bg-background shadow-xl sm:w-[440px]"
              onInteractOutside={(event) => {
                if (!mobile) event.preventDefault()
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                ;(opener.current?.isConnected
                  ? opener.current
                  : document.querySelector<HTMLElement>('[aria-label="Open assistant"]')
                )?.focus()
              }}
            >
              <div className="flex items-start justify-between border-b p-4">
                <div>
                  <Dialog.Title className="text-base font-semibold">MCA assistant</Dialog.Title>
                  <Dialog.Description className="text-sm text-muted-foreground">
                    Private to you in this company. Reads deals and underwriting.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <Button size="icon" variant="ghost" aria-label="Close assistant">
                    <X />
                  </Button>
                </Dialog.Close>
              </div>
              {runtime === "supabase" ? (
                <NativeChat surface="drawer" deal={deal} onDraft={setDraft} />
              ) : !domainKey ? (
                <p className="p-4 text-sm" role="status">
                  The assistant is awaiting configuration.
                </p>
              ) : scriptError ? (
                <p className="p-4 text-sm" role="alert">
                  The assistant could not load. Reload the page to try again.
                </p>
              ) : scriptReady ? (
                <AssistantChat
                  key={chatAttempt}
                  surface="drawer"
                  domainKey={domainKey}
                  deal={deal}
                  includedDealId={includedDeal}
                  onIncludedDealChange={setIncludedDeal}
                  showIncludeToggle
                  onRetry={() => setChatAttempt((attempt) => attempt + 1)}
                />
              ) : (
                <p className="p-4 text-sm" role="status">
                  Loading assistant…
                </p>
              )}
              {includedDeal && deal?.id === includedDeal && (
                <ChatMessages dealId={deal.id} surface="drawer" draft={draft} />
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </AssistantContext.Provider>
  )
}
