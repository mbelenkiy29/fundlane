import { NextResponse } from "next/server"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { ownerQueueQuerySchema } from "@/lib/mca/platform-contracts"
import { listCompanyOperations, listSmsReviewQueue } from "@/lib/mca/platform-queues"
import { apiError, AppError } from "@/lib/mca/errors"
export async function GET(request:Request) {
  try {
    const actor=await requireSuperAdmin(request)
    const params=new URL(request.url).searchParams
    const kind=params.get("kind")??"companies"
    const query=ownerQueueQuerySchema.safeParse(Object.fromEntries(params))
    if(!query.success||!["companies","sms"].includes(kind))throw new AppError(422,"invalid_query","Invalid queue filters.")
    return NextResponse.json(await (kind==="sms"?listSmsReviewQueue:listCompanyOperations)(actor,query.data),{headers:{"Cache-Control":"private, no-store"}})
  } catch(error) {return apiError(error)}
}
