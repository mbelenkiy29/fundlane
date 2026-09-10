import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { getPsfConfiguration, updatePsfConfiguration } from "@/lib/mca/closing/service"

const schema = z.object({ enabled: z.boolean(), visibleToReps: z.boolean(), destination: z.string().optional(), signingSecret: z.string().optional() }).strict()
export async function GET(request: Request) { try { return NextResponse.json(await getPsfConfiguration(await requireClosingActor(request, "read", true))) } catch (error) { return apiError(error) } }
export async function PATCH(request: Request) { try { return NextResponse.json(await updatePsfConfiguration(await requireClosingActor(request, "write", true), await readJson(request, schema))) } catch (error) { return apiError(error) } }
