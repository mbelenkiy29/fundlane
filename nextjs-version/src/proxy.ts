import { clerkMiddleware } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export default clerkMiddleware(async (_auth, request: NextRequest) => {
  if (request.nextUrl.pathname === "/login") return NextResponse.redirect(new URL("/sign-in", request.url))
  if (request.nextUrl.pathname === "/register") return NextResponse.redirect(new URL("/sign-up", request.url))
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-mca-pathname", request.nextUrl.pathname)
  requestHeaders.set("x-mca-return-to", request.nextUrl.pathname + request.nextUrl.search)
  return NextResponse.next({ request: { headers: requestHeaders } })
}, { jwtKey: process.env.CLERK_JWT_KEY })

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon-192.png|icon-512.png|sw.js|manifest.webmanifest).*)"] }
