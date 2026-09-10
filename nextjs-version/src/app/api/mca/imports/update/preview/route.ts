import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { previewCsvUpdate } from "@/lib/mca/imports/service"
export const runtime="nodejs";export const dynamic="force-dynamic"
export async function POST(request:Request){try{assertTrustedMutation(request);const actor=await actorForDeals(await requireWorkspaceAccess(request,{roles:["admin","super_admin"],sessionOnly:true}));const form=await request.formData();const file=form.get("file");if(!(file instanceof File))throw new AppError(422,"import_file_required","Choose an update CSV.");const mapping=typeof form.get("mapping")==="string"?JSON.parse(String(form.get("mapping"))) as Record<string,string>:undefined;return NextResponse.json(await previewCsvUpdate(actor,{sourceId:String(form.get("sourceId")??""),batchId:String(form.get("batchId")??""),filename:file.name,bytes:new Uint8Array(await file.arrayBuffer()),mapping}),{status:201})}catch(error){return apiError(error)}}
