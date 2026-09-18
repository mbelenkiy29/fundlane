import type { ChatKitOptions, StartScreenPrompt, ThemeOption } from "@openai/chatkit-react"

export type ChatKitSurface = "page" | "drawer"

export const CHATKIT_DISCLAIMER =
  "Reads deals and underwriting. Does not send messages or change records."

export const CHATKIT_START_PROMPTS: StartScreenPrompt[] = [
  { label: "Summarize my pipeline", prompt: "Summarize my current pipeline by status.", icon: "analytics" },
  { label: "Find a deal", prompt: "Help me find a deal by merchant name.", icon: "search" },
  { label: "Check underwriting", prompt: "Check existing underwriting on a deal.", icon: "notebook" },
]

export function chatkitUiOptions(input: {
  surface: ChatKitSurface
  colorScheme: "light" | "dark"
  accent: string
  background: string
  foreground: string
}): Omit<
  Pick<
    ChatKitOptions,
    "theme" | "header" | "history" | "startScreen" | "composer" | "disclaimer" | "thread" | "threadItemActions" | "frameTitle"
  >,
  "theme"
> & { theme: ThemeOption } {
  const page = input.surface === "page"
  return {
    frameTitle: "MCA workspace assistant",
    theme: {
      colorScheme: input.colorScheme,
      radius: "round",
      density: page ? "normal" : "compact",
      color: {
        accent: { primary: input.accent, level: 2 },
        surface: { background: input.background, foreground: input.foreground },
      },
      typography: {
        baseSize: 14,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      },
    },
    header: { enabled: page },
    history: { enabled: true, showDelete: true, showRename: true },
    startScreen: {
      greeting: "What would you like to know?",
      prompts: CHATKIT_START_PROMPTS,
    },
    composer: { placeholder: "Ask about your deals…", attachments: { enabled: false } },
    threadItemActions: { feedback: false, retry: true },
    thread: { autoScroll: true },
    disclaimer: { text: CHATKIT_DISCLAIMER },
  }
}

export function threadFromSearch(search: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search
  const value = new URLSearchParams(query).get("thread")?.trim() ?? ""
  if (!value || value.length > 128) return null
  return value
}

export function threadHref(pathname: string, threadId: string | null): string {
  if (!threadId) return pathname
  return `${pathname}?thread=${encodeURIComponent(threadId)}`
}
