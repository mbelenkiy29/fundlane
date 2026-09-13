import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { supabasePublicConfig } from "@/lib/supabase/config"
import { maintenanceResponse } from "@/lib/mca/maintenance/capture"
export default async function proxy(request:NextRequest){
  const paused=await maintenanceResponse(request)
  if(paused)return paused
  if(request.nextUrl.pathname==="/login")return NextResponse.redirect(new URL("/sign-in",request.url))
  if(request.nextUrl.pathname==="/register")return NextResponse.redirect(new URL("/sign-up",request.url))
  const requestHeaders=new Headers(request.headers)
  requestHeaders.set("x-mca-pathname",request.nextUrl.pathname)
  requestHeaders.set("x-mca-return-to",request.nextUrl.pathname+request.nextUrl.search)
  let response=NextResponse.next({request:{headers:requestHeaders}})
  // Public builds can render without credentials; protected handlers fail closed.
  if(!process.env.NEXT_PUBLIC_SUPABASE_URL||!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)return response
  const {url,key}=supabasePublicConfig()
  const client=createServerClient(url,key,{cookies:{getAll:()=>request.cookies.getAll(),setAll:values=>{
    values.forEach(({name,value})=>request.cookies.set(name,value))
    requestHeaders.set("cookie",request.cookies.toString())
    response=NextResponse.next({request:{headers:requestHeaders}})
    values.forEach(({name,value,options})=>response.cookies.set(name,value,options))
  }}})
  // Refresh cookie-backed sessions only; authorization always happens in the application gateway.
  await client.auth.getClaims()
  response.headers.set("Cache-Control","private, no-store")
  return response
}
export const config={matcher:["/((?!_next/static|_next/image|favicon.ico|icon-192.png|icon-512.png|sw.js|manifest.webmanifest).*)"]}
