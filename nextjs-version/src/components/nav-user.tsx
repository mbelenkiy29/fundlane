"use client"

import { CircleUser, EllipsisVertical, LogOut, Settings } from "lucide-react"
import Link from "next/link"
import { requestJson } from "@/lib/mca/client"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"

export function NavUser({ user }: { user: { name: string; email: string; avatar: string } }) {
  const { isMobile } = useSidebar()

  async function signOut() {
    await requestJson("/api/auth/sign-out",{method:"POST"})
    window.location.href="/sign-in"
  }

  return <SidebarMenu><SidebarMenuItem><DropdownMenu>
    <DropdownMenuTrigger asChild><SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
      <span className="flex size-8 items-center justify-center rounded-lg bg-muted"><CircleUser className="size-5" /></span>
      <span className="grid min-w-0 flex-1 text-left text-sm leading-tight"><span className="truncate font-medium">{user.name}</span><span className="truncate text-xs text-muted-foreground">{user.email}</span></span>
      <EllipsisVertical className="ml-auto size-4" />
    </SidebarMenuButton></DropdownMenuTrigger>
    <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
      <DropdownMenuLabel><span className="block truncate">{user.name}</span><span className="block truncate text-xs font-normal text-muted-foreground">{user.email}</span></DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup><DropdownMenuItem asChild><Link href="/settings/profile"><CircleUser /> Profile</Link></DropdownMenuItem><DropdownMenuItem asChild><Link href="/settings"><Settings /> Workspace settings</Link></DropdownMenuItem></DropdownMenuGroup>
      <DropdownMenuItem asChild><Link href="/onboarding?switch=1">Switch company</Link></DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={signOut}><LogOut /> Sign out</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu></SidebarMenuItem></SidebarMenu>
}
