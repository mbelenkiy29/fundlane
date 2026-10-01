import { consumeRequestRateLimit } from "@/lib/mca/auth"
import { assertStrictPlatformMutation, withSuperAdminAction } from "@/lib/mca/platform-audit"
import { NextResponse } from "next/server"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { readJson } from "@/lib/mca/http"
import { platformCompany, platformMutation, platformActionSchema,platformQuerySchema,platformPayments } from "@/lib/mca/platform-console"
import { apiError,AppError } from "@/lib/mca/errors"
type Context={params:Promise<{id:string}>}
export async function GET(request:Request,context:Context) {
  try{await requireSuperAdmin(request);const parsed=platformQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));if(!parsed.success)throw new AppError(422,"invalid_query","Invalid financial filters.");const {id}=await context.params;const detail=await platformCompany(id);return NextResponse.json({...detail,financial:await platformPayments(parsed.data,id)},{headers:{"Cache-Control":"no-store"}})}catch(error){return apiError(error)}
}
export async function POST(request:Request,context:Context) {
  try{const actor=await requireSuperAdmin(request);assertStrictPlatformMutation(request);assertTrustedMutation(request);await consumeRequestRateLimit(`platform-mutation:${actor.userId}`,20);const input=await readJson(request,platformActionSchema);return NextResponse.json(await withSuperAdminAction({actor,action:`platform.${input.action}`,workspaceId:(await context.params).id,targetType:"workspace",targetId:(await context.params).id,reason:input.reason,request},async ()=>platformMutation((await context.params).id,actor.userId,input)), { headers: { "Cache-Control": "no-store" } })}catch(error){return apiError(error)}
}
