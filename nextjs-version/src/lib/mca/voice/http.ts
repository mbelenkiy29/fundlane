import "server-only"
import { assertTrustedMutation,requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import { getWorkspaceSettings } from "../workspaces"
import { AppError } from "../errors"
export async function requireVoiceActor(request:Request,write=false){
 if(write)assertTrustedMutation(request)
 const context=await requireWorkspaceAccess(request,{sessionOnly:true,roles:["rep","manager","admin","super_admin"]})
 if(!(await getWorkspaceSettings(context.workspaceId)).pageVisibility.deals)throw new AppError(403,"page_disabled","Calling is disabled for this company.")
 return actorForDeals(context)
}
