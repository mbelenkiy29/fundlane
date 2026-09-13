export const NEW_DEAL_FILE_CATEGORIES = ["application", "statement", "voided_check", "driver_license"] as const
export type NewDealFileCategory = (typeof NEW_DEAL_FILE_CATEGORIES)[number]

export const NEW_DEAL_FILE_CATEGORY_LABELS: Record<NewDealFileCategory, string> = {
  application: "Application",
  statement: "Bank statement",
  voided_check: "Voided check",
  driver_license: "ID",
}

export const NEW_DEAL_FILE_ACCEPT = "application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"

export function isPdfFile(file: { name: string; type?: string }): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
}

export function classifyNewDealFilename(filename: string): NewDealFileCategory | undefined {
  const name = filename.toLowerCase()
  if (name.includes("statement")) return "statement"
  if (name.includes("check")) return "voided_check"
  const tokens = name.replace(/[^a-z0-9]+/g, " ").trim()
  if (name.includes("license") || name.includes("passport") || /(?:^|\s)id(?:\s|$)/.test(tokens)) return "driver_license"
  return undefined
}

export function classifyNewDealFiles(files: Array<{ name: string; type?: string }>): NewDealFileCategory[] {
  const categories = files.map((file) => classifyNewDealFilename(file.name))
  if (!categories.includes("application")) {
    const index = files.findIndex((file, item) => isPdfFile(file) && !categories[item])
    if (index >= 0) categories[index] = "application"
  }
  return categories.map((category) => category ?? "statement")
}
