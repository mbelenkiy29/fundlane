"use client"

import Link from "next/link"
import { Plus, Settings, FileText, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export function QuickActions({ onNewDeal }: { onNewDeal?: () => void }) {
  return (
    <div className="flex items-center space-x-2">
      <Button className="cursor-pointer" onClick={() => onNewDeal?.()}>
        <Plus className="h-4 w-4 mr-2" />
        New deal
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="cursor-pointer">
            <Settings className="h-4 w-4 mr-2" />
            Actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="cursor-pointer" asChild>
            <Link href="/reports">
              <FileText className="h-4 w-4 mr-2" />
              Generate Report
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer" asChild>
            <Link href="/deals">
              <Download className="h-4 w-4 mr-2" />
              Export Data
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" asChild>
            <Link href="/settings">
              <Settings className="h-4 w-4 mr-2" />
              Dashboard Settings
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
