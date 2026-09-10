import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { commitCsvUpdate } from "@/lib/mca/imports/service"
export const runtime="nodejs";interface Context{params:Promise<{id:string}>}
export async function POST(request:Request,context:Context){try{assertTrustedMutation(request);const actor=await actorForDeals(await requireWorkspaceAccess(request,{roles:["admin","super_admin"],sessionOnly:true}));const body=await request.json() as {expectedPreviewRevision:number};return NextResponse.json(await commitCsvUpdate(actor,{runId:(await context.params).id,expectedPreviewRevision:body.expectedPreviewRevision}))}catch(error){return apiError(error)}}
