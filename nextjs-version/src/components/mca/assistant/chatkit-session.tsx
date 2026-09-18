"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChatKit, useChatKit, type Entity } from "@openai/chatkit-react"
import { useTheme } from "@/hooks/use-theme"
import { Button } from "@/components/ui/button"
import { chatkitDealHref } from "@/lib/mca/assistant/chatkit-entities"
import { chatkitUiOptions, type ChatKitSurface } from "@/lib/mca/assistant/chatkit-ui"

export type AssistantDeal = { id: string; label: string } | null

const lightColors = {
  accent: "oklch(0.42 0.16 155)",
  background: "oklch(1 0 0)",
  foreground: "oklch(0.145 0 0)",
}
const darkColors = {
  accent: "oklch(0.72 0.16 155)",
  background: "oklch(0.145 0 0)",
  foreground: "oklch(0.985 0 0)",
}

function resolvedColorScheme(theme: string): "light" | "dark" {
  if (theme === "dark" || theme === "light") return theme
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function AssistantChat({
  surface,
  domainKey,
  deal,
  includedDealId,
  onIncludedDealChange,
  showIncludeToggle = false,
  initialThread = null,
  onThreadChange,
  onTagSearch,
  onRetry,
}: {
  surface: ChatKitSurface
  domainKey: string
  deal: AssistantDeal
  includedDealId: string | null
  onIncludedDealChange?: (id: string | null) => void
  showIncludeToggle?: boolean
  initialThread?: string | null
  onThreadChange?: (threadId: string | null) => void
  onTagSearch?: (query: string) => Promise<Entity[]>
  onRetry: () => void
}) {
  const [ready, setReady] = useState(false)
  const [slowLoad, setSlowLoad] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [responding, setResponding] = useState(false)
  const requests = useRef(new Set<AbortController>())
  const included = useRef(includedDealId)
  const dealId = useRef(deal?.id ?? null)
  const onThreadChangeRef = useRef(onThreadChange)
  const onTagSearchRef = useRef(onTagSearch)
  const { theme } = useTheme()
  const colorScheme = resolvedColorScheme(theme)
  const colors = colorScheme === "dark" ? darkColors : lightColors
  useEffect(() => {
    included.current = includedDealId
    dealId.current = deal?.id ?? null
    onThreadChangeRef.current = onThreadChange
    onTagSearchRef.current = onTagSearch
  })
  useEffect(() => {
    if (ready) return
    const timeout = setTimeout(() => setSlowLoad(true), 15_000)
    return () => clearTimeout(timeout)
  }, [ready])
  useEffect(() => {
    const active = requests.current
    return () => {
      for (const controller of active) controller.abort()
      active.clear()
    }
  }, [])
  const ui = useMemo(
    () =>
      chatkitUiOptions({
        surface,
        colorScheme,
        accent: colors.accent,
        background: colors.background,
        foreground: colors.foreground,
      }),
    [surface, colorScheme, colors]
  )
  const chat = useChatKit({
    api: {
      url: "/api/mca/chatkit",
      domainKey,
      async fetch(input, init) {
        const controller = new AbortController()
        requests.current.add(controller)
        const headers = new Headers(init?.headers)
        if (dealId.current && included.current === dealId.current) headers.set("x-mca-deal-id", dealId.current)
        const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
        try {
          const response = await fetch(input, { ...init, credentials: "same-origin", headers, signal })
          if (!response.ok) {
            const data = await response.clone().json().catch(() => null)
            setError(data?.error?.message || "The assistant is unavailable. Please retry.")
          }
          if (!response.body) {
            requests.current.delete(controller)
            return response
          }
          const reader = response.body.getReader()
          return new Response(
            new ReadableStream({
              async pull(target) {
                try {
                  const part = await reader.read()
                  if (part.done) {
                    requests.current.delete(controller)
                    target.close()
                  } else target.enqueue(part.value)
                } catch (e) {
                  requests.current.delete(controller)
                  target.error(e)
                }
              },
              async cancel() {
                controller.abort()
                requests.current.delete(controller)
                await reader.cancel().catch(() => {})
              },
            }),
            { status: response.status, statusText: response.statusText, headers: response.headers }
          )
        } catch (e) {
          requests.current.delete(controller)
          throw e
        }
      },
    },
    initialThread,
    ...ui,
    theme: {
      ...ui.theme,
      typography: {
        ...ui.theme.typography,
        fontSources: [
          {
            family: "Inter",
            src: new URL("/fonts/inter/inter-latin-variable.woff2", window.location.origin).href,
            weight: "100 900",
            style: "normal",
            display: "swap",
          },
        ],
      },
    },
    entities: onTagSearch
      ? {
          showComposerMenu: true,
          onTagSearch: (query) => onTagSearchRef.current?.(query) ?? Promise.resolve([]),
          onClick(entity) {
            const href = chatkitDealHref(entity)
            if (href) window.location.assign(href)
          },
        }
      : undefined,
    onReady: () => setReady(true),
    onThreadChange: (event) => onThreadChangeRef.current?.(event.threadId),
    onResponseStart: () => {
      setError(null)
      setResponding(true)
    },
    onResponseEnd: () => setResponding(false),
    onError: () => {
      setResponding(false)
      setError((previous) => previous || "The response was interrupted. Retry or start a new conversation.")
    },
  })
  return (
    <>
      {showIncludeToggle && deal && (
        <label className="flex items-center gap-2 border-b px-4 py-2 text-xs">
          <input
            type="checkbox"
            checked={includedDealId === deal.id}
            onChange={(event) => onIncludedDealChange?.(event.target.checked ? deal.id : null)}
          />
          Include {deal.label}
        </label>
      )}
      {error && (
        <div role="alert" className="border-b p-3 text-sm">
          {error}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null)
              void chat.setThreadId(null)
            }}
          >
            New conversation
          </Button>
        </div>
      )}
      {responding && (
        <Button
          variant="ghost"
          size="sm"
          className="self-end"
          onClick={() => {
            for (const controller of requests.current) controller.abort()
            setResponding(false)
          }}
        >
          Stop response
        </Button>
      )}
      <div className="relative min-h-0 flex-1">
        {!ready && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-4 text-sm"
            role="status"
            aria-live="polite"
          >
            <p>{slowLoad ? "The assistant is taking longer than expected to load." : "Loading assistant…"}</p>
            {slowLoad && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry loading
              </Button>
            )}
          </div>
        )}
        <ChatKit control={chat.control} className="block h-full w-full" />
      </div>
    </>
  )
}
