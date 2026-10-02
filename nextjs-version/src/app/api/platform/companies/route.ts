import { NextResponse } from "next/server"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { platformCompanies, platformQuerySchema } from "@/lib/mca/platform-console"
import { apiError, AppError } from "@/lib/mca/errors"
export async function GET(request:Request) {
  try {await requireSuperAdmin(request);const parsed=platformQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));if(!parsed.success)throw new AppError(422,"invalid_query","Invalid search filters.");return NextResponse.json(await platformCompanies(parsed.data),{headers:{"Cache-Control":"private, no-store","X-MCA-Snapshot-At":new Date().toISOString()}})}catch(error){return apiError(error)}
}
