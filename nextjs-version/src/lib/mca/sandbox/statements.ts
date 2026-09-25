import "server-only"

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { AppError } from "../errors"
import { closedLookbackMonths } from "../underwriting/lookback"
import { getWorkspaceSettings } from "../workspaces"

export interface SampleStatement {
  id: string
  filename: string
  period: string
  merchantName: string
  merchantId: string
  bankName: string
  description: string
  mimeType: "application/pdf"
  synthetic: true
}

const SAMPLE_MERCHANTS = [
  {
    id: "qa-pizza",
    name: "QA Test Pizza LLC",
    industry: "Limited-service restaurants (synthetic pizza merchant)",
    depositsCents: [184_250_00, 191_080_00, 176_440_00] as const,
  },
  {
    id: "demo-retail",
    name: "Sandbox Demo Retail LLC",
    industry: "Retail storefront (synthetic demo merchant)",
    depositsCents: [96_220_00, 101_450_00, 88_760_00] as const,
  },
] as const

const SYNTHETIC_BANK = "Sandbox National Bank (SYNTHETIC — not a real bank)"
const BANNER = "SYNTHETIC SAMPLE — NOT A REAL BANK STATEMENT — NOT FOR LIVE UNDERWRITING"

export function sampleStatementPeriods(timeZone = "America/New_York"): string[] {
  return closedLookbackMonths(3, timeZone)
}

export function listSampleStatementCatalog(timeZone = "America/New_York"): SampleStatement[] {
  const periods = sampleStatementPeriods(timeZone)
  return SAMPLE_MERCHANTS.flatMap((merchant) =>
    periods.map((period) => ({
      id: `${merchant.id}-${period}`,
      filename: `${merchant.id}-${period}-SYNTHETIC.pdf`,
      period,
      merchantName: merchant.name,
      merchantId: merchant.id,
      bankName: SYNTHETIC_BANK,
      description: `Synthetic ${period} checking statement for ${merchant.name}. Labeled as fake data for upload and underwriting tests.`,
      mimeType: "application/pdf" as const,
      synthetic: true as const,
    })),
  )
}

export async function listSampleStatementsForWorkspace(workspaceId: string): Promise<SampleStatement[]> {
  const settings = await getWorkspaceSettings(workspaceId)
  return listSampleStatementCatalog(settings.timezone || "America/New_York")
}

export async function getSampleStatementPdf(id: string, workspaceId?: string): Promise<{ statement: SampleStatement; bytes: Uint8Array }> {
  const catalog = workspaceId ? await listSampleStatementsForWorkspace(workspaceId) : listSampleStatementCatalog()
  const statement = catalog.find((item) => item.id === id)
  if (!statement) throw new AppError(404, "sample_statement_not_found", "That synthetic sample statement was not found.")
  const merchant = SAMPLE_MERCHANTS.find((item) => item.id === statement.merchantId)
  if (!merchant) throw new AppError(404, "sample_statement_not_found", "That synthetic sample statement was not found.")
  const periodIndex = catalog.filter((item) => item.merchantId === merchant.id).findIndex((item) => item.id === statement.id)
  const depositsCents = merchant.depositsCents[Math.max(0, periodIndex)] ?? merchant.depositsCents[0]
  return { statement, bytes: await renderSampleStatementPdf(statement, merchant.industry, depositsCents) }
}

async function renderSampleStatementPdf(statement: SampleStatement, industry: string, depositsCents: number): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  document.setTitle(`${BANNER} ${statement.period}`)
  document.setAuthor("Fundlane sandbox (synthetic)")
  document.setSubject("Synthetic bank statement for QA and sales demos. Not a real account.")
  document.setKeywords(["synthetic", "sandbox", "not-a-real-bank-statement", "fundlane"])
  document.setProducer("Fundlane sandbox")
  document.setCreator("Fundlane sandbox")
  const page = document.addPage([612, 792])
  const font = await document.embedFont(StandardFonts.Courier)
  const bold = await document.embedFont(StandardFonts.CourierBold)
  const deposits = (depositsCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
  const averageDaily = ((depositsCents * 0.42) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
  const lines = [
    BANNER,
    "Do not send this file to a real lender. It is workspace demo data only.",
    "",
    `Institution: ${statement.bankName}`,
    "Routing number: 000000000 (synthetic)",
    "Account number: XXXXXX4242 (synthetic)",
    `Account holder: ${statement.merchantName}`,
    `Industry: ${industry}`,
    `Statement period: ${statement.period}-01 through ${statement.period}-28`,
    "Account type: Business checking (synthetic)",
    "",
    `Total deposits: ${deposits}`,
    "NSF / overdraft count: 0",
    `Average daily balance: ${averageDaily}`,
    "Ending balance: synthetic figure for extraction tests only",
    "",
    "Selected synthetic activity",
    `${statement.period}-03  ACH SETTLEMENT (SYNTHETIC)        +${deposits}`,
    `${statement.period}-11  PAYROLL (SYNTHETIC)               -$8,420.00`,
    `${statement.period}-18  RENT (SYNTHETIC)                  -$4,200.00`,
    `${statement.period}-24  SUPPLIER (SYNTHETIC)              -$2,175.50`,
    "",
    "This PDF is generated on demand. It contains no real merchant, bank, or personal data.",
    `Sample id: ${statement.id}`,
  ]
  let y = 750
  for (const [index, line] of lines.entries()) {
    page.drawText(line, {
      x: 40,
      y,
      size: index === 0 ? 9 : 10,
      font: index === 0 ? bold : font,
      color: index === 0 ? rgb(0.55, 0.1, 0.1) : rgb(0.08, 0.08, 0.08),
      maxWidth: 532,
    })
    y -= index === 0 ? 18 : 16
  }
  return document.save({ useObjectStreams: false })
}
