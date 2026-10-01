import "server-only"
import {redirect} from "next/navigation"
import {requireSuperAdmin} from "./platform-auth"
import {AppError} from "./errors"
import {recordFirstSuperAdminAccess} from "./platform-audit"
export async function requirePlatformPage() {
  try {const actor=await requireSuperAdmin();await recordFirstSuperAdminAccess(actor);return actor} catch(error) {
    if(error instanceof AppError){
      if(error.code==="mfa_required") redirect("/account-security?returnTo=%2Fplatform")
      if(error.status===401) redirect("/sign-in?next=%2Faccount-security")
      if(error.code==="platform_admin_required" || error.code==="super_admin_required") redirect("/errors/forbidden")
    }
    throw error
  }
}
