import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { importStatus, reviewSpreadsheetImport } from "@/lib/mca/imports/service"
export const runtime="nodejs";export const dynamic="force-dynamic";interface Context{params:Promise<{id:string}>}
export async function GET(request:Request,context:Context){try{const actor=await actorForDeals(await requireWorkspaceAccess(request,{roles:["admin","super_admin"],sessionOnly:true}));return NextResponse.json(await importStatus(actor,(await context.params).id),{headers:{"cache-control":"no-store"}})}catch(error){return apiError(error)}}
export async function PATCH(request:Request,context:Context){try{assertTrustedMutation(request);const actor=await actorForDeals(await requireWorkspaceAccess(request,{roles:["admin","super_admin"],sessionOnly:true}));const input=await request.json() as {expectedPreviewRevision:number;decisions:Array<{rowId:string;duplicateDecision?:"create"|"skip";assignmentMembershipId?:string}>};return NextResponse.json(await reviewSpreadsheetImport(actor,{runId:(await context.params).id,expectedPreviewRevision:input.expectedPreviewRevision,decisions:input.decisions??[]}))}catch(error){return apiError(error)}}
