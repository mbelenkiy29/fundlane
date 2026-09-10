import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { commitSpreadsheetImport } from "@/lib/mca/imports/service"
export const runtime="nodejs";interface Context{params:Promise<{id:string}>}
export async function POST(request:Request,context:Context){try{assertTrustedMutation(request);const actor=await actorForDeals(await requireWorkspaceAccess(request,{roles:["admin","super_admin"],sessionOnly:true}));const input=await request.json() as {expectedPreviewRevision:number};return NextResponse.json(await commitSpreadsheetImport(actor,{runId:(await context.params).id,expectedPreviewRevision:input.expectedPreviewRevision}))}catch(error){return apiError(error)}}
