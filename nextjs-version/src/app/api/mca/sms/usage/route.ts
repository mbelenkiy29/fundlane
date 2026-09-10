import { NextResponse } from "next/server"
import { requireSmsActor } from "@/lib/mca/sms/http"
import { apiError } from "@/lib/mca/errors"
import { usageRows } from "@/lib/mca/sms/maintenance"
export async function GET(request: Request) {
  try {
    const a = await requireSmsActor(request, {
      mode: "read",
      admin: true,
      settings: true,
    })
    const result = await usageRows(a.workspaceId)
    if (new URL(request.url).searchParams.get("format") === "csv") {
      const columns = [
        "period",
        "category",
        "estimated_cents",
        "actual_cents",
        "quantity",
        "updated_at",
      ]
      const cell = (v: unknown) =>
        `"${String(v ?? "")
          .replace(/^[=+@-]/, "'")
          .replace(/"/g, '""')}"`
      return new Response(
        [
          columns.join(","),
          ...result.usage.map((r) => columns.map((k) => cell(r[k])).join(",")),
        ].join("\n"),
        {
          headers: {
            "content-type": "text/csv",
            "content-disposition": "attachment; filename=sms-usage.csv",
            "cache-control": "no-store",
          },
        }
      )
    }
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    })
  } catch (e) {
    return apiError(e)
  }
}
