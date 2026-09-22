import { NextResponse } from "next/server"
import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { readJson } from "@/lib/mca/http"
import { platformCompany, platformMutation, platformActionSchema,platformQuerySchema,platformPayments } from "@/lib/mca/platform-console"
import { apiError,AppError } from "@/lib/mca/errors"
type Context={params:Promise<{id:string}>}
export async function GET(request:Request,context:Context) {
  try{await requirePlatformAdmin();const parsed=platformQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));if(!parsed.success)throw new AppError(422,"invalid_query","Invalid financial filters.");const {id}=await context.params;const detail=await platformCompany(id);return NextResponse.json({...detail,financial:await platformPayments(parsed.data,id)},{headers:{"Cache-Control":"no-store"}})}catch(error){return apiError(error)}
}
export async function POST(request:Request,context:Context) {
  try{const actor=await requirePlatformAdmin();assertTrustedMutation(request);const input=await readJson(request,platformActionSchema);return NextResponse.json(await platformMutation((await context.params).id,actor.userId,input))}catch(error){return apiError(error)}
}
