import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { markContractFinalReview } from "@/lib/mca/closing/service"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { try { return NextResponse.json(await markContractFinalReview(await requireClosingActor(request, "write", true), (await params).id)) } catch (error) { return apiError(error) } }
