import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { cancelImport } from "@/lib/mca/imports/service"
export const runtime="nodejs";interface Context{params:Promise<{id:string}>}
export async function POST(request:Request,context:Context){try{assertTrustedMutation(request);const actor=await actorForDeals(await requireWorkspaceAccess(request,{roles:["admin","super_admin"],sessionOnly:true}));await cancelImport(actor,(await context.params).id);return NextResponse.json({cancelled:true})}catch(error){return apiError(error)}}
