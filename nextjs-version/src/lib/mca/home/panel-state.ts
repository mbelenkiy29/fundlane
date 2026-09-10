import { HOME_COPY, type HomeQueueItem } from "./contracts"

export type HomePanelStatus = "loading" | "empty" | "validation" | "success" | "error"

export interface HomePanelView {
  status: HomePanelStatus
  message: string
  items: HomeQueueItem[]
}

export function homeQueueView(input: {
  loading: boolean
  error?: string
  fieldErrors?: Record<string, string[]>
  items?: HomeQueueItem[]
}): HomePanelView {
  const items = input.items ?? []
  if (input.loading) return { status: "loading", message: HOME_COPY.loading, items }
  if (input.fieldErrors && Object.keys(input.fieldErrors).length) {
    return { status: "validation", message: HOME_COPY.validation, items }
  }
  if (input.error) return { status: "error", message: input.error, items }
  if (!items.length) return { status: "empty", message: HOME_COPY.empty, items }
  return { status: "success", message: HOME_COPY.title, items }
}
