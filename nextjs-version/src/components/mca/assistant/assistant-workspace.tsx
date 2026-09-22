"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AssistantChat, type AssistantDeal } from "./chatkit-session"
import { DealContextBar, searchDealEntities } from "./deal-context-bar"
import { NativeChat, type AssistantDraft } from "./native-chat"
import { ChatMessages } from "./chat-messages"
import { useAssistantSession } from "./assistant-panel"
import { threadFromSearch, threadHref } from "@/lib/mca/assistant/chatkit-ui"

export function AssistantWorkspace() {
  const session = useAssistantSession()
  const router = useRouter()
  const search = useSearchParams()
  const [initialThread] = useState(() => threadFromSearch(search.toString()))
  const [deal, setDeal] = useState<AssistantDeal>(null)
  const [includedDealId, setIncludedDealId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AssistantDraft | null>(null)
  const [chatAttempt, setChatAttempt] = useState(0)
  useEffect(() => {
    session?.requestChatkit()
  }, [session])
  const onThreadChange = useCallback((threadId: string | null) => {
    const href = threadHref("/assistant", threadId)
    if (`${window.location.pathname}${window.location.search}` !== href) router.replace(href, { scroll: false })
  }, [router])
  if (!session) {
    return (
      <p role="status" className="p-4 text-sm">
        AI Assistant is currently unavailable. Check the feature configuration with your administrator.
      </p>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DealContextBar
        deal={deal}
        onDealChange={setDeal}
        includedDealId={includedDealId}
        onIncludedDealChange={setIncludedDealId}
      />
      {session.runtime === "supabase" ? (
        <NativeChat
          surface="page"
          deal={deal}
          includedDealId={includedDealId}
          onIncludedDealChange={setIncludedDealId}
          showIncludeToggle={false}
          initialThread={initialThread}
          onThreadChange={onThreadChange}
          onDraft={setDraft}
          onDraftDismissed={(id) =>
            setDraft((current) => (current?.id === id ? null : current))
          }
        />
      ) : !session.domainKey ? (
        <p className="p-4 text-sm" role="status">
          The assistant is awaiting configuration.
        </p>
      ) : session.scriptError ? (
        <p className="p-4 text-sm" role="alert">
          The assistant could not load. Reload the page to try again.
        </p>
      ) : session.scriptReady ? (
        <AssistantChat
          key={chatAttempt}
          surface="page"
          domainKey={session.domainKey}
          deal={deal}
          includedDealId={includedDealId}
          onIncludedDealChange={setIncludedDealId}
          initialThread={initialThread}
          onThreadChange={onThreadChange}
          onTagSearch={searchDealEntities}
          onRetry={() => setChatAttempt((attempt) => attempt + 1)}
        />
      ) : (
        <p className="p-4 text-sm" role="status">
          Loading assistant…
        </p>
      )}
      {includedDealId && deal?.id === includedDealId && (
        <ChatMessages dealId={deal.id} surface="page" draft={draft} />
      )}
    </div>
  )
}
