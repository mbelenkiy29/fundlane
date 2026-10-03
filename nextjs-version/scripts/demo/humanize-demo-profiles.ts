import { createHash } from "node:crypto"

/** Deterministic, realistic-looking sample data for demo deals. Pure functions only (no DB, no secrets). */

export type EntityType = "llc" | "corporation" | "s_corporation" | "partnership" | "sole_proprietor"
/** Client-supplied details (the full CSV). When present they are used as-is; only owner emails/phones and the bank are generated. */
export type BusinessDetails = {
  ein: string; entityType: EntityType; address: { line1: string; city: string; state: string; postalCode: string; country: "US" }
  contactPhone: string; startDate: string; industry: string; monthlyRevenue: number; requestedAmount: number; fundingPurpose: string
  owners: Array<{ firstName: string; lastName: string; ownershipPercent: number }>
}
export type Business = { name: string; email: string; details?: BusinessDetails }
export type OwnerProfile = { firstName: string; lastName: string; ownershipPercent: number; isPrimary: boolean; email: string; phone: string; title: string }
export type DealProfile = {
  legalName: string; dbaName: string; entityType: EntityType; industry: string; fundingPurpose: string
  contactName: string; contactEmail: string; contactPhone: string; ein: string
  address: { line1: string; city: string; state: string; postalCode: string; country: "US" }
  owners: OwnerProfile[]; bankName: string; accountSuffix: string
  /** Only set for CSV-driven rows; the legacy name-only path keeps the deal's existing values. */
  startDate?: string; monthlyRevenue?: number; requestedAmount?: number
}

/** Every `TEST …` funder name seeded by seed-ben.ts, mapped to an invented (non-real) funder name. */
export const FUNDER_NAMES: Record<string, string> = {
  "TEST Cedar Capital": "Cedarbrook Merchant Capital",
  "TEST Harbor Funding": "Harborline Business Funding",
  "TEST Summit Finance": "Summitcrest Finance Group",
  "TEST Willow Capital": "Willowmere Capital Partners",
  "TEST Meadow Finance": "Meadowgate Funding Co.",
}

/** Invented bank names for sample statements. None of these is a real bank. */
export const BANK_NAMES = ["Bramblewood Community Bank", "Kestrel Valley Savings Bank", "Ashgrove Merchants Bank", "Pinemoor Federal Savings", "Quillfield Commerce Bank", "Hollowmere Trust Bank"]

/** CSV entity labels → the app's entity enum (src/lib/mca/deals/schema.ts ENTITY_TYPES). */
export const ENTITY_TYPE_MAP: Record<string, EntityType> = {
  "llc": "llc", "limited liability company": "llc",
  "c corporation": "corporation", "c corp": "corporation", "corporation": "corporation", "inc": "corporation",
  "s corporation": "s_corporation", "s corp": "s_corporation",
  "partnership": "partnership", "general partnership": "partnership",
  "sole proprietorship": "sole_proprietor", "sole proprietor": "sole_proprietor",
}

function readCsv(text: string): string[][] {
  const rows: string[][] = []
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue
    const cells: string[] = []; let cell = "", quoted = false
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (quoted) { if (ch === '"' && raw[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false; else cell += ch }
      else if (ch === '"') quoted = true
      else if (ch === ",") { cells.push(cell); cell = "" }
      else cell += ch
    }
    cells.push(cell); rows.push(cells.map(c => c.trim()))
  }
  return rows
}

const DETAIL_COLUMNS = ["ein", "entity type", "street address", "city", "state", "zip code", "contact phone", "business start date", "industry", "monthly revenue", "requested funding", "use of funds", "owners"] as const

/**
 * CSV reader: header row, `#` comment lines and blank lines skipped, double-quoted fields supported.
 * Two layouts: `Business Name,Email` (everything else generated), or the full client layout
 * `Business Name,Email,EIN,Entity Type,Street Address,City,State,ZIP Code,Contact Phone,Business Start Date,Industry,Monthly Revenue,Requested Funding,Use of Funds,Owners`
 * where Owners looks like `Joseph Patel (50%); Daniel Morrison (25%); Grace Moreno (25%)`.
 */
export function parseBusinessesCsv(text: string): Business[] {
  const [header, ...body] = readCsv(text)
  const cols = (header ?? []).map(h => h.toLowerCase())
  if (!/business/.test(cols[0] ?? "") || !/email/.test(cols[1] ?? "")) throw new Error("CSV header must start with: Business Name,Email")
  const rich = DETAIL_COLUMNS.some(c => cols.includes(c))
  if (rich) { const missing = DETAIL_COLUMNS.filter(c => !cols.includes(c)); if (missing.length) throw new Error(`CSV is missing columns: ${missing.join(", ")}`) }
  const seenEins = new Set<string>()
  return body.map((cells, index) => {
    const line = index + 2, [name, rawEmail] = cells, email = (rawEmail ?? "").toLowerCase()
    const fail = (msg: string): never => { throw new Error(`CSV row ${line} (${name}): ${msg}`) }
    if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) fail("needs a business name and a valid email")
    if (/\btest\b/i.test(name) || /\d/.test(name)) fail('business names must not contain "Test" or numbers')
    if (!rich) return { name, email }
    const get = (c: typeof DETAIL_COLUMNS[number]) => cells[cols.indexOf(c)] ?? ""
    const einDigits = get("ein").replace(/\D/g, "")
    if (einDigits.length !== 9) fail("EIN must have 9 digits")
    const ein = `${einDigits.slice(0, 2)}-${einDigits.slice(2)}`
    if (seenEins.has(ein)) fail(`EIN ${ein} is used by another row`); seenEins.add(ein)
    const entityType = ENTITY_TYPE_MAP[get("entity type").toLowerCase().replace(/[.,]/g, "").trim()] ?? fail(`unknown entity type "${get("entity type")}"`)
    const state = get("state").toUpperCase(), postalCode = get("zip code")
    if (!/^[A-Z]{2}$/.test(state)) fail("State must be a 2-letter code")
    if (!/^\d{5}$/.test(postalCode)) fail("ZIP Code must be 5 digits")
    const phoneDigits = get("contact phone").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")
    if (phoneDigits.length !== 10) fail("Contact Phone must be a 10-digit US number")
    const contactPhone = `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`
    const startDate = get("business start date")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(startDate))) fail("Business Start Date must be YYYY-MM-DD")
    const money = (c: "monthly revenue" | "requested funding") => { const v = Number(get(c).replace(/[$,\s]/g, "")); if (!Number.isFinite(v) || v <= 0) fail(`${c} must be a positive number`); return v }
    const owners = get("owners").split(";").map(s => s.trim()).filter(Boolean).map(s => {
      const m = /^(.+?)\s*\((\d+(?:\.\d+)?)\s*%\)$/.exec(s) ?? fail(`owner "${s}" must look like "First Last (50%)"`)
      const parts = m[1].trim().split(/\s+/); if (parts.length < 2) fail(`owner "${s}" needs a first and last name`)
      return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1], ownershipPercent: Number(m[2]) }
    })
    if (!owners.length) fail("needs at least one owner")
    const total = owners.reduce((a, o) => a + o.ownershipPercent, 0)
    if (Math.abs(total - 100) > 0.01) fail(`owner percentages add up to ${total}, not 100`)
    if (entityType === "sole_proprietor" && owners.length !== 1) fail("a sole proprietorship has exactly one owner")
    const required = { street: get("street address"), city: get("city"), industry: get("industry"), purpose: get("use of funds") }
    for (const [k, v] of Object.entries(required)) if (!v) fail(`${k} is empty`)
    return { name, email, details: {
      ein, entityType, address: { line1: required.street, city: required.city, state, postalCode, country: "US" as const }, contactPhone, startDate,
      industry: required.industry, monthlyRevenue: money("monthly revenue"), requestedAmount: money("requested funding"), fundingPurpose: required.purpose, owners,
    } }
  })
}

const hash = (seed: string) => createHash("sha256").update(seed).digest()
const pick = <T>(items: readonly T[], seed: string, offset = 0) => items[hash(seed).readUInt32BE(offset) % items.length]
const num = (seed: string, offset = 0) => hash(seed).readUInt32BE(offset)

const FIRST = ["James", "Maria", "David", "Aisha", "Michael", "Sofia", "Daniel", "Priya", "Anthony", "Elena", "Marcus", "Grace", "Kevin", "Yesenia", "Robert", "Hannah", "Luis", "Mei", "Thomas", "Fatima", "Brian", "Rachel", "Carlos", "Nadia", "Patrick", "Olivia", "Samuel", "Leah", "Victor", "Danielle", "Raymond", "Ana", "Gregory", "Tamika", "Joseph", "Irene", "Andre", "Monica", "Eric", "Rosa", "Steven", "Jasmine", "Nathan", "Claire", "Omar", "Bianca", "Frank", "Lauren", "Hector", "Diane", "Kenji", "Natalie", "Vincent", "Teresa", "Dmitri", "Keisha", "Paul", "Sandra", "Ahmed", "Megan"]
const LAST = ["Alvarez", "Brennan", "Castillo", "Donnelly", "Esposito", "Fitzgerald", "Garcia", "Haddad", "Iverson", "Jablonski", "Kowalski", "Lindqvist", "Morales", "Nakamura", "O'Connor", "Patel", "Quintero", "Rossi", "Sullivan", "Tran", "Underwood", "Vasquez", "Whitaker", "Xiong", "Yamamoto", "Zielinski", "Abernathy", "Barrett", "Chen", "Delgado", "Ellison", "Ferreira", "Gallagher", "Hoffman", "Ibrahim", "Jensen", "Kim", "Lombardi", "Mitchell", "Novak", "Okafor", "Pereira", "Ramirez", "Shapiro", "Thornton", "Vargas", "Walsh", "Young", "Acosta", "Bianchi", "Coleman", "Dubois", "Engel", "Fischer", "Greco", "Hernandez", "Jacobs", "Kaplan", "Molina", "Reyes"]
const STREETS = ["Main Street", "Market Street", "Oak Avenue", "Maple Avenue", "Broad Street", "Washington Street", "Park Avenue", "Elm Street", "Church Street", "Center Street", "Union Avenue", "Highland Avenue", "Front Street", "Water Street", "Franklin Avenue", "Lincoln Avenue", "Grove Street", "Mill Road", "Bridge Street", "Commerce Drive"]
type Place = { city: string; state: string; zip: string; area: string }
const PLACES: Place[] = [
  { city: "New York", state: "NY", zip: "10011", area: "212" }, { city: "Brooklyn", state: "NY", zip: "11215", area: "718" },
  { city: "Yonkers", state: "NY", zip: "10701", area: "914" }, { city: "Hoboken", state: "NJ", zip: "07030", area: "201" },
  { city: "Montclair", state: "NJ", zip: "07042", area: "973" }, { city: "Stamford", state: "CT", zip: "06901", area: "203" },
  { city: "Boston", state: "MA", zip: "02116", area: "617" }, { city: "Providence", state: "RI", zip: "02903", area: "401" },
  { city: "Philadelphia", state: "PA", zip: "19103", area: "215" }, { city: "Baltimore", state: "MD", zip: "21230", area: "410" },
  { city: "Richmond", state: "VA", zip: "23220", area: "804" }, { city: "Charlotte", state: "NC", zip: "28203", area: "704" },
  { city: "Atlanta", state: "GA", zip: "30307", area: "404" }, { city: "Orlando", state: "FL", zip: "32803", area: "407" },
  { city: "Tampa", state: "FL", zip: "33606", area: "813" }, { city: "Nashville", state: "TN", zip: "37206", area: "615" },
  { city: "Columbus", state: "OH", zip: "43215", area: "614" }, { city: "Chicago", state: "IL", zip: "60614", area: "312" },
  { city: "Austin", state: "TX", zip: "78704", area: "512" }, { city: "Dallas", state: "TX", zip: "75204", area: "214" },
  { city: "Denver", state: "CO", zip: "80205", area: "303" }, { city: "Phoenix", state: "AZ", zip: "85004", area: "602" },
  { city: "San Diego", state: "CA", zip: "92104", area: "619" }, { city: "Portland", state: "OR", zip: "97214", area: "503" },
]
/** Names that hint at a place get a matching city. */
const PLACE_HINTS: Array<[RegExp, Place]> = [
  [/granite state/i, { city: "Manchester", state: "NH", zip: "03101", area: "603" }],
  [/hudson valley/i, { city: "Poughkeepsie", state: "NY", zip: "12601", area: "845" }],
  [/blue ridge/i, { city: "Asheville", state: "NC", zip: "28801", area: "828" }],
  [/sandy hook/i, { city: "Highlands", state: "NJ", zip: "07732", area: "732" }],
  [/valley forge/i, { city: "King of Prussia", state: "PA", zip: "19406", area: "610" }],
  [/beacon hill/i, { city: "Boston", state: "MA", zip: "02108", area: "617" }],
  [/union square|canal street|fulton street|kensington|midtown/i, { city: "New York", state: "NY", zip: "10003", area: "212" }],
  [/kingsbridge/i, { city: "Bronx", state: "NY", zip: "10463", area: "718" }],
  [/chestnut hill/i, { city: "Philadelphia", state: "PA", zip: "19118", area: "215" }],
  [/pebble beach/i, { city: "Monterey", state: "CA", zip: "93940", area: "831" }],
  [/golden gate/i, { city: "San Francisco", state: "CA", zip: "94117", area: "415" }],
  [/sunset strip|silver lake/i, { city: "Los Angeles", state: "CA", zip: "90026", area: "323" }],
  [/rockport/i, { city: "Rockport", state: "MA", zip: "01966", area: "978" }],
  [/kingston/i, { city: "Kingston", state: "NY", zip: "12401", area: "845" }],
  [/bridgeport/i, { city: "Bridgeport", state: "CT", zip: "06604", area: "203" }],
  [/palisades/i, { city: "Fort Lee", state: "NJ", zip: "07024", area: "201" }],
]

type Kind = { industry: string; purposes: string[] }
/** Ordered: first matching rule wins. */
const KINDS: Array<[RegExp, Kind]> = [
  [/medical supply/i, { industry: "Medical Supply Retail", purposes: ["Inventory purchase for a new home-care equipment line", "Bulk purchase of mobility and respiratory supplies at a volume discount", "Working capital while waiting on insurance reimbursements"] }],
  [/dent(al|istry)/i, { industry: "Dental Practice", purposes: ["Purchase a digital X-ray and intraoral scanner", "Build out two additional treatment rooms", "Working capital to bridge slow insurance reimbursements"] }],
  [/vet|animal hospital/i, { industry: "Veterinary Clinic", purposes: ["Purchase new surgical and dental equipment", "Expand kennel and recovery area", "Hire an additional veterinary technician"] }],
  [/pediatric|family medicine|urgent care|dermatology|chiropractic|physical therapy|counseling/i, { industry: "Medical Practice", purposes: ["Purchase new diagnostic equipment", "Upgrade practice management and billing software", "Bridge insurance reimbursement delays and cover payroll"] }],
  [/optical/i, { industry: "Optometry & Eyewear", purposes: ["Expand frame inventory ahead of back-to-school season", "Purchase a new retinal imaging system", "Remodel the showroom and fitting area"] }],
  [/pharmacy/i, { industry: "Pharmacy", purposes: ["Inventory purchase and wholesaler prepayment", "Install an automated prescription dispensing system", "Working capital while waiting on PBM reimbursements"] }],
  [/pet grooming|kennel/i, { industry: "Pet Services", purposes: ["Add grooming stations and a second bathing tub", "Expand boarding capacity with new kennels", "Purchase a mobile grooming van"] }],
  [/car wash/i, { industry: "Car Wash", purposes: ["Replace the tunnel conveyor and brushes", "Install a water reclamation system", "Launch a monthly membership program with new pay stations"] }],
  [/auto|tire|collision/i, { industry: "Auto Repair", purposes: ["Purchase a second vehicle lift and diagnostic scanner", "Parts inventory and tire stock for the winter season", "Hire two additional certified technicians"] }],
  [/marine|marina/i, { industry: "Marine Services", purposes: ["Dock repairs and new boat slips before the season opens", "Purchase a travel lift for haul-outs", "Parts inventory and seasonal payroll"] }],
  [/bakery|bagels|cafe|coffee|ice cream/i, { industry: "Bakery & Cafe", purposes: ["Purchase a new deck oven and mixer", "Open a second location", "Inventory and seasonal staffing for the holidays"] }],
  [/catering/i, { industry: "Catering", purposes: ["Purchase a refrigerated delivery van", "Kitchen equipment upgrade for larger events", "Working capital for wedding-season staffing"] }],
  [/pizza|grill|diner|bistro|deli|kitchen|taqueria|steakhouse|ramen|cuisine|saloon|sports bar|wine bar|brewing/i, { industry: "Restaurant", purposes: ["Kitchen equipment upgrade (new walk-in cooler and range)", "Patio build-out to add outdoor seating", "Inventory and payroll during the slow season", "Renovate the dining room"] }],
  [/plumbing|hvac|heating|mechanical/i, { industry: "Plumbing & HVAC", purposes: ["Add two service vans to the fleet", "Equipment and parts inventory for the heating season", "Payroll for new hires on a commercial contract"] }],
  [/electric(?!s)|solar/i, { industry: "Electrical Contractor", purposes: ["Purchase a bucket truck", "Materials for a large commercial contract", "Payroll for additional licensed electricians"] }],
  [/roofing|construction|paving|excavation|builders|welding/i, { industry: "Construction", purposes: ["Purchase heavy equipment (skid steer and trailer)", "Materials and labor for a new commercial contract", "Bridge cash flow between progress payments"] }],
  [/painting|flooring|floors|glass|locksmith|appliance repair/i, { industry: "Home Services", purposes: ["Add a second service vehicle", "Purchase materials inventory at bulk pricing", "Marketing campaign and hiring for the busy season"] }],
  [/landscap|tree service|garden center/i, { industry: "Landscaping & Outdoor", purposes: ["Purchase a new truck and mowing equipment", "Seasonal inventory and spring payroll", "Expand into commercial maintenance contracts"] }],
  [/laundr|cleaners|cleaning/i, { industry: "Cleaning & Laundry", purposes: ["Replace washers and dryers with high-efficiency machines", "Add a pickup and delivery van", "Hire and train additional cleaning crews"] }],
  [/tailor|bridal/i, { industry: "Apparel & Alterations", purposes: ["Inventory purchase for the upcoming season", "Expand the fitting area and add sewing stations", "Marketing and payroll ahead of wedding season"] }],
  [/salon|nail|barber|spa|tattoo/i, { industry: "Beauty & Personal Care", purposes: ["Remodel and add new service stations", "Product inventory and retail display", "Hire additional stylists and technicians"] }],
  [/fitness|yoga/i, { industry: "Fitness Studio", purposes: ["Purchase new strength and cardio equipment", "Renovate locker rooms", "Marketing for a new member drive"] }],
  [/trucking|movers|moving/i, { industry: "Trucking & Logistics", purposes: ["Down payment on an additional box truck", "Fuel, insurance and maintenance costs", "Payroll for seasonal drivers"] }],
  [/realty/i, { industry: "Real Estate Brokerage", purposes: ["Office expansion and agent recruiting", "Marketing and listing technology", "Working capital between closings"] }],
  [/insurance/i, { industry: "Insurance Agency", purposes: ["Hire two licensed producers", "Purchase an agency management system", "Acquire a book of business from a retiring agent"] }],
  [/accounting|tax/i, { industry: "Accounting & Tax", purposes: ["Seasonal staffing for tax season", "Upgrade tax and practice software", "Office renovation"] }],
  [/security/i, { industry: "Security Services", purposes: ["Purchase monitoring equipment and install inventory", "Add two installer vehicles", "Payroll for new commercial accounts"] }],
  [/photography|print|frames|sign/i, { industry: "Creative & Print Services", purposes: ["Purchase a new large-format printer", "Equipment upgrade and studio build-out", "Marketing and seasonal staffing"] }],
  [/event rentals/i, { industry: "Event Rentals", purposes: ["Purchase additional tents, tables and linens", "Add a delivery truck", "Seasonal payroll for setup crews"] }],
  [/daycare|senior living/i, { industry: "Care Services", purposes: ["Facility improvements required for licensing", "Hire additional staff to meet ratios", "Working capital while waiting on state reimbursements"] }],
  [/storage|campground/i, { industry: "Storage & Lodging", purposes: ["Add new units and site improvements", "Security and access-control upgrades", "Seasonal maintenance and payroll"] }],
  [/hardware|liquors|market|grocery|boutique|jewelers|electronics|mattress|pawn|surf|bike|pool supply|florist|furniture|farm stand/i, { industry: "Retail", purposes: ["Inventory purchase ahead of the holiday season", "Store remodel and new fixtures", "Add an e-commerce site and fulfillment space", "Bulk inventory purchase at a supplier discount"] }],
]
const FALLBACK: Kind = { industry: "Retail", purposes: ["Working capital for inventory and payroll", "Equipment purchase", "Expansion into a second location"] }

/** IRS-assigned EIN prefixes (format-valid; the numbers themselves are made up). */
const EIN_PREFIXES = ["10", "11", "12", "13", "14", "15", "16", "20", "21", "22", "23", "24", "25", "26", "27", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "41", "42", "43", "44", "45", "46", "47", "48", "51", "52", "53", "54", "55", "56", "57", "58", "59", "61", "62", "63", "64", "65", "66", "67", "68", "71", "72", "73", "74", "75", "76", "77", "81", "82", "83", "84", "85", "86", "87", "88", "90", "91", "92", "93", "94", "95", "98", "99"]

const phone = (area: string, seed: string) => `(${area}) 555-01${String(num(seed) % 100).padStart(2, "0")}`

/** `used` carries EINs and owner names already handed out in this batch, so each stays unique. */
export function buildProfile(index: number, business: Business, used: Set<string>): DealProfile {
  if (business.details) return buildProfileFromDetails(business, business.details)
  const seed = `humanize-v1:${business.name}`
  const kind = KINDS.find(([re]) => re.test(business.name))?.[1] ?? FALLBACK
  const place = PLACE_HINTS.find(([re]) => re.test(business.name))?.[1] ?? pick(PLACES, `${seed}:place`)
  const inc = business.name.endsWith("Co.") || num(`${seed}:entity`) % 3 === 0
  const base = business.name.replace(/[.,]+$/, "")
  const legalName = inc ? (business.name.endsWith("Co.") ? `${business.name}, Inc.` : `${base} Inc.`) : `${base} LLC`
  const domain = business.email.split("@")[1]
  const ownerCount = (index * 7) % 5 === 3 ? 2 : 1 // exactly 20% of deals get a second owner
  const splits = [[60, 40], [51, 49], [50, 50], [70, 30], [75, 25]]
  const split = ownerCount === 2 ? pick(splits, `${seed}:split`) : [100]
  const contactPhone = phone(place.area, `${seed}:phone`)
  const ownerPhone = (n: number) => { // mobile numbers differ from the business line and from each other
    let value = "", attempt = 0
    do value = phone(place.area, `${seed}:owner-phone:${n}:${attempt++}`); while (value === contactPhone || owners.some(o => o.phone === value))
    return value
  }
  const owners: OwnerProfile[] = []
  for (let n = 0; n < ownerCount; n++) {
    let first = "", last = "", attempt = 0
    do { // owner names are unique across the batch (tracked in `used` with a "name:" prefix)
      first = pick(FIRST, `${seed}:first:${n}:${attempt}`); last = pick(LAST, `${seed}:last:${n}:${attempt}`)
      if (n === 1 && num(`${seed}:family`) % 3 === 0) last = owners[0].lastName // some co-owners are family
      attempt++
    } while (used.has(`name:${first} ${last}`) || (n === 1 && first === owners[0].firstName))
    used.add(`name:${first} ${last}`)
    owners.push({ firstName: first, lastName: last, ownershipPercent: split[n], isPrimary: n === 0, email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}@${domain}`,
      phone: ownerPhone(n), title: n === 0 ? (inc ? "President" : "Managing Member") : (inc ? "Vice President" : "Member") })
  }
  let ein = "", attempt = 0
  do { ein = `${pick(EIN_PREFIXES, `${seed}:ein:${attempt}`)}-${String(num(`${seed}:ein:${attempt}`, 4) % 10_000_000).padStart(7, "0")}`; attempt++ } while (used.has(ein))
  used.add(ein)
  return {
    legalName, dbaName: business.name, entityType: inc ? "corporation" : "llc", industry: kind.industry,
    fundingPurpose: pick(kind.purposes, `${seed}:purpose`),
    contactName: `${owners[0].firstName} ${owners[0].lastName}`, contactEmail: business.email,
    contactPhone, ein,
    address: { line1: `${10 + num(`${seed}:street-no`) % 4980} ${pick(STREETS, `${seed}:street`)}`, city: place.city, state: place.state, postalCode: place.zip, country: "US" },
    owners, bankName: pick(BANK_NAMES, `${seed}:bank`), accountSuffix: String(num(`${seed}:acct`) % 10000).padStart(4, "0"),
  }
}

/** Legal name the way the business would register it: "X LLC", "X Inc."; partnerships and sole proprietors trade under the name itself. */
export function legalNameFor(name: string, entityType: EntityType): string {
  const base = name.replace(/[.,]+$/, "")
  if (entityType === "llc") return /\bLLC$/i.test(base) ? base : `${base} LLC`
  if (entityType === "corporation" || entityType === "s_corporation") return /\b(Inc|Corp|Corporation)$/i.test(base) ? `${base}.` : name.endsWith("Co.") ? `${name}, Inc.` : `${base} Inc.`
  return name
}
export const ENTITY_LABELS: Record<EntityType, string> = { llc: "Limited Liability Company", corporation: "C Corporation", s_corporation: "S Corporation", partnership: "Partnership", sole_proprietor: "Sole Proprietorship" }
function ownerTitle(entityType: EntityType, n: number, count: number): string {
  if (entityType === "sole_proprietor") return "Owner"
  if (entityType === "partnership") return n === 0 ? "Managing Partner" : "Partner"
  if (entityType === "llc") return n === 0 ? "Managing Member" : "Member"
  return n === 0 ? "President" : count > 2 && n === 2 ? "Secretary" : "Vice President"
}

/** CSV-driven profile: client values used as given; only owner emails (.test domain of the business) and 555-01XX mobile numbers are generated. */
function buildProfileFromDetails(business: Business, d: BusinessDetails): DealProfile {
  const seed = `humanize-v1:${business.name}`
  const domain = business.email.split("@")[1]
  const area = d.contactPhone.slice(1, 4)
  const taken = new Set([d.contactPhone]), emails = new Set<string>()
  const owners: OwnerProfile[] = d.owners.map((o, n) => {
    let ph = "", attempt = 0
    do ph = phone(area, `${seed}:owner-phone:${n}:${attempt++}`); while (taken.has(ph) && attempt < 500)
    taken.add(ph)
    const local = `${o.firstName}.${o.lastName}`.toLowerCase().normalize("NFD").replace(/[^a-z.]/g, "")
    let email = `${local}@${domain}`, k = 2
    while (emails.has(email)) email = `${local}${k++}@${domain}`
    emails.add(email)
    return { firstName: o.firstName, lastName: o.lastName, ownershipPercent: o.ownershipPercent, isPrimary: n === 0, email, phone: ph, title: ownerTitle(d.entityType, n, d.owners.length) }
  })
  return {
    legalName: legalNameFor(business.name, d.entityType), dbaName: business.name, entityType: d.entityType, industry: d.industry, fundingPurpose: d.fundingPurpose,
    contactName: `${owners[0].firstName} ${owners[0].lastName}`, contactEmail: business.email, contactPhone: d.contactPhone, ein: d.ein, address: d.address, owners,
    bankName: pick(BANK_NAMES, `${seed}:bank`), accountSuffix: String(num(`${seed}:acct`) % 10000).padStart(4, "0"),
    startDate: d.startDate, monthlyRevenue: d.monthlyRevenue, requestedAmount: d.requestedAmount,
  }
}

export function matchedIndustryRule(name: string): boolean { return KINDS.some(([re]) => re.test(name)) }
