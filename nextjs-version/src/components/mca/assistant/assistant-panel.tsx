"use client"

import { createContext, useContext, useEffect, useRef, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { ChatKit, useChatKit } from "@openai/chatkit-react"
import Script from "next/script"
import { useTheme } from "@/hooks/use-theme"
import { MessageSquare, X } from "lucide-react"
import { Button } from "@/components/ui/button"

type SelectedDeal = { id: string; label: string } | null
const AssistantContext = createContext<{ open: () => void; deal: SelectedDeal; setDeal: (deal: SelectedDeal) => void } | null>(null)
export function useAssistantDeal(dealId?: string, label?: string) {
  const setter = useContext(AssistantContext)?.setDeal
  useEffect(() => {
    setter?.(dealId ? { id: dealId, label: label || "selected deal" } : null)
    return () => setter?.(null)
  }, [setter, dealId, label])
}
export function AssistantButton({ onOpen }: { onOpen?: () => void } = {}) {
  const assistant = useContext(AssistantContext)
  if (!assistant) return null
  return <Button variant="outline" size="sm" onClick={() => { onOpen?.(); assistant.open() }} aria-label="Open assistant"><MessageSquare className="size-4" /><span className="hidden sm:inline">Assistant</span></Button>
}

export function AssistantProvider({ children, domainKey }: { children: React.ReactNode; domainKey: string }) {
  const [deal, setDeal] = useState<SelectedDeal>(null)
  const opener = useRef<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [scriptReady, setScriptReady] = useState(false)
  const [scriptError, setScriptError] = useState(false)
  const [chatAttempt, setChatAttempt] = useState(0)
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    if (!mounted) return
    const frame = requestAnimationFrame(() => {
      if (open) panel.current?.querySelector<HTMLButtonElement>("button")?.focus()
      else (opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('[aria-label="Open assistant"]'))?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, mounted])
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)")
    const update = () => setMobile(media.matches)
    update(); media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  return <AssistantContext.Provider value={{ deal, setDeal, open: () => { opener.current = document.activeElement as HTMLElement; setMounted(true); setOpen(true) } }}>
    {children}
    {mounted && <>
      <Script src="https://cdn.platform.openai.com/deployments/chatkit/chatkit.js" strategy="afterInteractive" onReady={() => setScriptReady(true)} onError={() => setScriptError(true)} />
      <Dialog.Root open={open} onOpenChange={setOpen} modal={mobile}>
        <Dialog.Portal forceMount>
          {mobile && open && <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />}
          <Dialog.Content ref={panel} forceMount style={{ display: open ? undefined : "none" }}
            className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col border-l bg-background shadow-xl sm:w-[440px]"
            onInteractOutside={event => { if (!mobile) event.preventDefault() }}
            onCloseAutoFocus={event => { event.preventDefault(); (opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('[aria-label="Open assistant"]'))?.focus() }}>
            <div className="flex items-start justify-between border-b p-4">
              <div><Dialog.Title className="text-base font-semibold">MCA assistant</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">Private to you in this company. Reads deals and underwriting.</Dialog.Description></div>
              <Dialog.Close asChild><Button size="icon" variant="ghost" aria-label="Close assistant"><X /></Button></Dialog.Close>
            </div>
            {!domainKey ? <p className="p-4 text-sm" role="status">The assistant is awaiting configuration.</p>
              : scriptError ? <p className="p-4 text-sm" role="alert">The assistant could not load. Reload the page to try again.</p>
              : scriptReady ? <AssistantChat key={chatAttempt} domainKey={domainKey} onRetry={() => setChatAttempt(attempt => attempt + 1)} /> : <p className="p-4 text-sm" role="status">Loading assistant…</p>}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>}
  </AssistantContext.Provider>
}

function AssistantChat({ domainKey, onRetry }: { domainKey: string; onRetry: () => void }) {
  const [ready, setReady] = useState(false)
  const [slowLoad, setSlowLoad] = useState(false)
  useEffect(() => {
    if (ready) return
    const timeout = setTimeout(() => setSlowLoad(true), 15_000)
    return () => clearTimeout(timeout)
  }, [ready])
  const selectedDeal = useContext(AssistantContext)?.deal
  const currentDeal = selectedDeal?.id
  const [includedDeal, setIncludedDeal] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [responding, setResponding] = useState(false)
  const requests = useRef(new Set<AbortController>())
  const { theme } = useTheme()
  const resolvedTheme = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme
  useEffect(() => {
    const active = requests.current
    return () => { for (const controller of active) controller.abort(); active.clear() }
  }, [])
  const chat = useChatKit({
    api: { url: "/api/mca/chatkit", domainKey,
      async fetch(input, init) {
        const controller = new AbortController()
        requests.current.add(controller)
        const headers = new Headers(init?.headers)
        if (currentDeal && includedDeal === currentDeal) headers.set("x-mca-deal-id", currentDeal)
        const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
        try {
          const response = await fetch(input, { ...init, credentials: "same-origin", headers, signal })
          if (!response.ok) {
            const data = await response.clone().json().catch(() => null)
            setError(data?.error?.message || "The assistant is unavailable. Please retry.")
          }
          if (!response.body) { requests.current.delete(controller); return response }
          const reader = response.body.getReader()
          return new Response(new ReadableStream({
            async pull(target) {
              try {
                const part = await reader.read()
                if (part.done) { requests.current.delete(controller); target.close() } else target.enqueue(part.value)
              } catch (e) { requests.current.delete(controller); target.error(e) }
            },
            async cancel() { controller.abort(); requests.current.delete(controller); await reader.cancel().catch(() => {}) },
          }), { status: response.status, statusText: response.statusText, headers: response.headers })
        } catch (e) { requests.current.delete(controller); throw e }
      },
    },
    frameTitle: "MCA workspace assistant",
    onReady: () => setReady(true),
    theme: {
      colorScheme: resolvedTheme === "dark" ? "dark" : "light",
      typography: {
        baseSize: 14,
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        // The ChatKit frame cannot inherit the app's next/font face or CSS variables.
        fontSources: [{
          family: "Inter",
          src: new URL("/fonts/inter/inter-latin-variable.woff2", window.location.origin).href,
          weight: "100 900",
          style: "normal",
          display: "swap",
        }],
      },
    },
    history: { enabled: true, showDelete: true, showRename: true },
    composer: { placeholder: "Ask about your deals…", attachments: { enabled: false } },
    threadItemActions: { feedback: false, retry: true },
    startScreen: { greeting: "What would you like to know?", prompts: [
      { label: "Summarize my pipeline", prompt: "Summarize my current pipeline by status." },
      { label: "Find a deal", prompt: "Help me find a deal by merchant name." },
    ] },
    onResponseStart: () => { setError(null); setResponding(true) },
    onResponseEnd: () => setResponding(false),
    onError: () => { setResponding(false); setError(previous => previous || "The response was interrupted. Retry or start a new conversation.") },
  })
  return <>
    {currentDeal && <label className="flex items-center gap-2 border-b px-4 py-2 text-xs">
      <input type="checkbox" checked={includedDeal === currentDeal} onChange={e => setIncludedDeal(e.target.checked ? currentDeal : null)} />Include {selectedDeal?.label}
    </label>}
    {error && <div role="alert" className="border-b p-3 text-sm">{error}<Button size="sm" variant="ghost" onClick={() => { setError(null); void chat.setThreadId(null) }}>New conversation</Button></div>}
    {responding && <Button variant="ghost" size="sm" className="self-end" onClick={() => { for (const controller of requests.current) controller.abort(); setResponding(false) }}>Stop response</Button>}
    <div className="relative min-h-0 flex-1">
      {!ready && <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-4 text-sm" role="status" aria-live="polite">
        <p>{slowLoad ? "The assistant is taking longer than expected to load." : "Loading assistant…"}</p>
        {slowLoad && <Button variant="outline" size="sm" onClick={onRetry}>Retry loading</Button>}
      </div>}
      <ChatKit control={chat.control} className="block h-full w-full" />
    </div>
  </>
}
