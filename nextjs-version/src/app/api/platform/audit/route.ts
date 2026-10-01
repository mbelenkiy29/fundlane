import { NextResponse } from "next/server"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { platformAudit, platformQuerySchema } from "@/lib/mca/platform-console"
import { apiError, AppError } from "@/lib/mca/errors"
export async function GET(request:Request) {
  try{await requireSuperAdmin(request);const parsed=platformQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));if(!parsed.success)throw new AppError(422,"invalid_query","Invalid search filters.");return NextResponse.json(await platformAudit(parsed.data),{headers:{"Cache-Control":"no-store"}})}catch(error){return apiError(error)}
}
