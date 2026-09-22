import "server-only"
import {redirect} from "next/navigation"
import {requirePlatformAdmin} from "./platform-auth"
import {AppError} from "./errors"
export async function requirePlatformPage() {
  try {return await requirePlatformAdmin()} catch(error) {
    if(error instanceof AppError){
      if(error.code==="mfa_required") redirect("/account-security?returnTo=%2Fplatform")
      if(error.status===401) redirect("/sign-in?next=%2Faccount-security")
      if(error.code==="platform_admin_required") redirect("/errors/forbidden")
    }
    throw error
  }
}
