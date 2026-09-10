import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { updateCsvTemplate } from "@/lib/mca/imports/service"
export const runtime="nodejs"
export async function GET(request:Request){try{await requireWorkspaceAccess(request,{roles:["admin","super_admin"],sessionOnly:true});return new Response(updateCsvTemplate,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=deal-updates-template.csv","cache-control":"no-store"}})}catch(error){return apiError(error)}}
