import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireExtractRead, requireExtractWrite } from "@/lib/mca/submissions/extract-outcomes"
import {
  extractOfferLink,
  getOfferLinkExtraction,
  listOfferLinkExtractions,
  type OfferLinkRunInput,
} from "@/lib/mca/submissions/offer-links"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireExtractRead(request)
    const params = new URL(request.url).searchParams
    const replyId = params.get("replyId")
    const dealId = params.get("dealId")
    if (replyId) return NextResponse.json(await getOfferLinkExtraction(actor, replyId), { headers: noStore })
    if (dealId) return NextResponse.json(await listOfferLinkExtractions(actor, dealId), { headers: noStore })
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", {
      replyId: ["Choose a funder reply or deal to load offer-link extraction."],
    })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireExtractWrite(request)
    let input: OfferLinkRunInput
    try {
      input = await request.json() as OfferLinkRunInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await extractOfferLink(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
