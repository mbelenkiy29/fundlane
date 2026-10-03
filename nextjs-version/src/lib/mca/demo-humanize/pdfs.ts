import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { ENTITY_LABELS, type DealProfile } from "./profiles"

/** Sample PDFs for demo deals. Every page carries the testing-only footer; bank names are invented. Output is deterministic. */
export const SAMPLE_FOOTER = "SAMPLE — FOR SOFTWARE TESTING ONLY"
const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z")
type Fonts = { regular: PDFFont; bold: PDFFont; sign: PDFFont }
export type PdfDeal = { profile: DealProfile; monthlyRevenue: number; requestedAmount: number; startDate: string | null; createdAt: string; displayId: string }

function rng(seed: string) {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0)
  return () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const money = (cents: number) => (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const longDate = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
const shortDate = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`

async function newDoc(title: string) {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setTitle(title); doc.setSubject(SAMPLE_FOOTER); doc.setProducer("Fundlane sample data generator"); doc.setCreator("Fundlane sample data generator")
  doc.setCreationDate(FIXED_DATE); doc.setModificationDate(FIXED_DATE)
  const fonts: Fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), sign: await doc.embedFont(StandardFonts.TimesRomanItalic) }
  return { doc, fonts }
}
function footer(page: PDFPage, fonts: Fonts, n: number, total: number) {
  const { width } = page.getSize(), size = 8
  page.drawLine({ start: { x: 40, y: 34 }, end: { x: width - 40, y: 34 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
  page.drawText(SAMPLE_FOOTER, { x: (width - fonts.bold.widthOfTextAtSize(SAMPLE_FOOTER, size)) / 2, y: 22, size, font: fonts.bold, color: rgb(0.45, 0.1, 0.1) })
  const label = `Page ${n} of ${total}`
  page.drawText(label, { x: width - 40 - fonts.regular.widthOfTextAtSize(label, size), y: 22, size, font: fonts.regular, color: rgb(0.4, 0.4, 0.4) })
}
const right = (page: PDFPage, text: string, x: number, y: number, size: number, font: PDFFont) => page.drawText(text, { x: x - font.widthOfTextAtSize(text, size), y, size, font })
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = []; let line = ""
  for (const word of text.split(/\s+/)) { const next = line ? `${line} ${word}` : word; if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = word } else line = next }
  if (line) lines.push(line)
  return lines
}

type Txn = { day: number; description: string; credit: number; debit: number }
function monthTransactions(deal: PdfDeal, year: number, month: number, r: () => number): Txn[] {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const businessDays = Array.from({ length: daysInMonth }, (_, i) => i + 1).filter(d => ![0, 6].includes(new Date(Date.UTC(year, month, d)).getUTCDay()))
  const day = () => businessDays[Math.floor(r() * businessDays.length)]
  const depositTotal = Math.round(deal.monthlyRevenue * 100 * (0.9 + r() * 0.2))
  const depositKinds = ["MERCHANT CARD SETTLEMENT", "MERCHANT CARD SETTLEMENT", "MERCHANT CARD SETTLEMENT", "MOBILE CHECK DEPOSIT", "ACH CREDIT CUSTOMER PAYMENT", "BRANCH CASH DEPOSIT"]
  const count = 14 + Math.floor(r() * 6)
  const weights = Array.from({ length: count }, () => 0.5 + r()); const sum = weights.reduce((a, b) => a + b, 0)
  const txns: Txn[] = []
  let allocated = 0
  weights.forEach((w, i) => { const amt = i === count - 1 ? depositTotal - allocated : Math.round(depositTotal * w / sum); allocated += amt; txns.push({ day: day(), description: depositKinds[Math.floor(r() * depositKinds.length)], credit: amt, debit: 0 }) })
  const spend = depositTotal * (0.86 + r() * 0.12)
  const debits: Array<[string, number]> = [["PAYROLL DIRECT DEPOSIT BATCH", 0.17], ["PAYROLL DIRECT DEPOSIT BATCH", 0.17], ["PAYROLL TAX PAYMENT", 0.07], ["ACH DEBIT COMMERCIAL RENT", 0.1], ["SUPPLIER PAYMENT INV " + (4000 + Math.floor(r() * 5000)), 0.14], ["SUPPLIER PAYMENT INV " + (4000 + Math.floor(r() * 5000)), 0.11], ["BUSINESS CARD AUTOPAY", 0.08], ["UTILITY PAYMENT ELECTRIC & GAS", 0.03], ["EQUIPMENT LEASE PAYMENT", 0.04], ["GENERAL LIABILITY INSURANCE", 0.03], ["TELECOM & INTERNET SERVICES", 0.01], ["MERCHANT PROCESSING FEES", 0.025]]
  const dsum = debits.reduce((a, [, w]) => a + w, 0)
  for (const [description, w] of debits) txns.push({ day: day(), description, credit: 0, debit: Math.round(spend * w / dsum * (0.9 + r() * 0.2)) })
  txns.push({ day: businessDays[businessDays.length - 1], description: "MONTHLY SERVICE FEE", credit: 0, debit: 1500 })
  return txns.sort((a, b) => a.day - b.day || b.credit - a.credit)
}

export async function bankStatementPdf(deal: PdfDeal): Promise<{ bytes: Uint8Array; filename: string; months: string[] }> {
  const p = deal.profile
  const created = new Date(deal.createdAt)
  const months = [4, 3, 2, 1].map(back => new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth() - back, 1)))
  const { doc, fonts } = await newDoc(`${p.bankName} — Business Checking Statements — ${p.dbaName}`)
  const r = rng(`statement:${p.ein}:${deal.displayId}`)
  let balance = Math.round(deal.monthlyRevenue * 100 * (0.2 + r() * 0.25))
  months.forEach((start, index) => {
    const page = doc.addPage([612, 792]), y0 = 750
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
    page.drawText(p.bankName, { x: 40, y: y0, size: 18, font: fonts.bold, color: rgb(0.08, 0.2, 0.4) })
    page.drawText("Business Checking Statement", { x: 40, y: y0 - 18, size: 10, font: fonts.regular })
    right(page, `Statement period: ${longDate(start)} – ${longDate(end)}`, 572, y0, 9, fonts.regular)
    right(page, `Account number: XXXXXX${p.accountSuffix}`, 572, y0 - 13, 9, fonts.regular)
    right(page, "Customer service: (800) 555-0100", 572, y0 - 26, 9, fonts.regular)
    let y = y0 - 60
    for (const [i, line] of [p.legalName, `DBA ${p.dbaName}`, p.address.line1, `${p.address.city}, ${p.address.state} ${p.address.postalCode}`].entries()) { page.drawText(line, { x: 40, y: y - i * 13, size: 10, font: i === 0 ? fonts.bold : fonts.regular }) }
    const txns = monthTransactions(deal, start.getUTCFullYear(), start.getUTCMonth(), r)
    const credits = txns.reduce((a, t) => a + t.credit, 0), debits = txns.reduce((a, t) => a + t.debit, 0)
    const opening = balance
    y -= 75
    page.drawRectangle({ x: 40, y: y - 52, width: 532, height: 66, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.75, color: rgb(0.96, 0.97, 0.99) })
    page.drawText("Account summary", { x: 50, y, size: 10, font: fonts.bold })
    const summary: Array<[string, string]> = [["Beginning balance", money(opening)], [`Deposits and credits (${txns.filter(t => t.credit).length})`, money(credits)], [`Withdrawals and debits (${txns.filter(t => t.debit).length})`, money(-debits)], ["Ending balance", money(opening + credits - debits)]]
    summary.forEach(([label, value], i) => { const col = i < 2 ? 50 : 320, row = y - 18 - (i % 2) * 15; page.drawText(label, { x: col, y: row, size: 9, font: fonts.regular }); right(page, value, col + 240, row, 9, i === 3 ? fonts.bold : fonts.regular) })
    y -= 80
    page.drawText("Transaction detail", { x: 40, y, size: 10, font: fonts.bold }); y -= 16
    const cols = { date: 40, desc: 80, credit: 400, debit: 480, bal: 572 }
    page.drawText("Date", { x: cols.date, y, size: 8, font: fonts.bold }); page.drawText("Description", { x: cols.desc, y, size: 8, font: fonts.bold })
    right(page, "Credits", cols.credit, y, 8, fonts.bold); right(page, "Debits", cols.debit, y, 8, fonts.bold); right(page, "Balance", cols.bal, y, 8, fonts.bold)
    page.drawLine({ start: { x: 40, y: y - 4 }, end: { x: 572, y: y - 4 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) }); y -= 16
    for (const t of txns) {
      balance += t.credit - t.debit
      page.drawText(shortDate(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), t.day))), { x: cols.date, y, size: 8, font: fonts.regular })
      page.drawText(t.description, { x: cols.desc, y, size: 8, font: fonts.regular })
      if (t.credit) right(page, money(t.credit), cols.credit, y, 8, fonts.regular)
      if (t.debit) right(page, money(t.debit), cols.debit, y, 8, fonts.regular)
      right(page, money(balance), cols.bal, y, 8, fonts.regular)
      y -= 13
    }
    y -= 10
    for (const line of wrap(`${p.bankName} is a fictitious bank. This statement was generated as sample data for software testing and does not describe a real account.`, fonts.regular, 7, 532)) { page.drawText(line, { x: 40, y, size: 7, font: fonts.regular, color: rgb(0.4, 0.4, 0.4) }); y -= 9 }
    footer(page, fonts, index + 1, months.length)
  })
  const mon = (d: Date) => MONTHS[d.getUTCMonth()].slice(0, 3)
  const slug = p.bankName.replace(/[^A-Za-z0-9]+/g, "-")
  return { bytes: await doc.save({ useObjectStreams: false }), filename: `${slug}-Statements-${mon(months[0])}-${months[0].getUTCFullYear()}-to-${mon(months[3])}-${months[3].getUTCFullYear()}.pdf`, months: months.map(d => d.toISOString().slice(0, 7)) }
}

export async function signedApplicationPdf(deal: PdfDeal): Promise<{ bytes: Uint8Array; filename: string }> {
  const p = deal.profile
  const signedAt = new Date(deal.createdAt)
  const { doc, fonts } = await newDoc(`Business Funding Application — ${p.dbaName}`)
  const page1 = doc.addPage([612, 792]), page2 = doc.addPage([612, 792])
  let y = 750
  page1.drawText("Business Funding Application", { x: 40, y, size: 18, font: fonts.bold, color: rgb(0.1, 0.2, 0.35) })
  right(page1, `Reference: ${deal.displayId}`, 572, y + 4, 9, fonts.regular); right(page1, `Date: ${longDate(signedAt)}`, 572, y - 9, 9, fonts.regular)
  y -= 34
  const section = (page: PDFPage, title: string) => { page.drawRectangle({ x: 40, y: y - 4, width: 532, height: 18, color: rgb(0.9, 0.93, 0.97) }); page.drawText(title, { x: 46, y, size: 10, font: fonts.bold }); y -= 24 }
  const field = (page: PDFPage, label: string, value: string, x = 46, w = 250) => { page.drawText(label, { x, y: y + 10, size: 7, font: fonts.regular, color: rgb(0.4, 0.4, 0.4) }); page.drawText(value, { x, y: y - 2, size: 10, font: fonts.regular }); page.drawLine({ start: { x, y: y - 6 }, end: { x: x + w, y: y - 6 }, thickness: 0.4, color: rgb(0.7, 0.7, 0.7) }) }
  const row = (page: PDFPage, a: [string, string], b?: [string, string]) => { field(page, a[0], a[1]); if (b) field(page, b[0], b[1], 316); y -= 30 }
  const entity = ENTITY_LABELS[p.entityType]
  const usd = (dollars: number) => money(Math.round(dollars * 100)).replace(/\.00$/, "")
  section(page1, "Business information")
  row(page1, ["Legal business name", p.legalName], ["DBA", p.dbaName])
  row(page1, ["Entity type", entity], ["Federal Tax ID (EIN)", p.ein])
  row(page1, ["Business start date", deal.startDate ?? ""], ["Industry", p.industry])
  row(page1, ["Business address", p.address.line1], ["City, State ZIP", `${p.address.city}, ${p.address.state} ${p.address.postalCode}`])
  row(page1, ["Business phone", p.contactPhone], ["Business email", p.contactEmail])
  row(page1, ["Average monthly revenue", usd(deal.monthlyRevenue)], ["Primary bank", p.bankName])
  section(page1, "Funding request")
  row(page1, ["Amount requested", usd(deal.requestedAmount)], ["Requested product", "Merchant cash advance"])
  field(page1, "Use of funds", p.fundingPurpose, 46, 520); y -= 30
  section(page1, "Owners")
  for (const [i, o] of p.owners.entries()) {
    row(page1, [`Owner ${i + 1} name`, `${o.firstName} ${o.lastName}`], ["Title", o.title])
    row(page1, ["Ownership", `${o.ownershipPercent}%`], ["Mobile phone", o.phone])
    row(page1, ["Email", o.email])
  }
  footer(page1, fonts, 1, 2)
  y = 750
  page2.drawText("Authorization and signature", { x: 40, y, size: 14, font: fonts.bold, color: rgb(0.1, 0.2, 0.35) }); y -= 28
  const terms = [
    `Each undersigned owner certifies that the information in this application is true and complete, and that they are authorized to sign on behalf of ${p.legalName}${p.legalName.endsWith(".") ? "" : "."}`,
    "The undersigned authorize the recipient and its funding partners to verify the information provided, to obtain business and personal credit reports, and to contact the bank and trade references listed, for the purpose of evaluating this request.",
    "This application is not a commitment to provide funding. Any offer will be presented separately with its own terms.",
    "Electronic signatures below have the same effect as handwritten signatures.",
  ]
  for (const para of terms) { for (const line of wrap(para, fonts.regular, 10, 532)) { page2.drawText(line, { x: 40, y, size: 10, font: fonts.regular }); y -= 14 } y -= 8 }
  y -= 20
  for (const o of p.owners) {
    page2.drawText(`/s/ ${o.firstName} ${o.lastName}`, { x: 46, y, size: 20, font: fonts.sign, color: rgb(0.05, 0.1, 0.35) })
    page2.drawLine({ start: { x: 40, y: y - 6 }, end: { x: 300, y: y - 6 }, thickness: 0.6, color: rgb(0.3, 0.3, 0.3) })
    page2.drawText(`${o.firstName} ${o.lastName}, ${o.title}`, { x: 40, y: y - 18, size: 9, font: fonts.regular })
    page2.drawText(`Signed electronically ${longDate(signedAt)}`, { x: 330, y: y - 18, size: 9, font: fonts.regular })
    y -= 70
  }
  footer(page2, fonts, 2, 2)
  return { bytes: await doc.save({ useObjectStreams: false }), filename: `${p.dbaName.replace(/[^A-Za-z0-9]+/g, "-").replace(/-$/, "")}-Signed-Application.pdf` }
}
