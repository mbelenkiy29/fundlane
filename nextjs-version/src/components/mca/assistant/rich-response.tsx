"use client"
import { useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Check, Copy, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import type { Citation } from "@/lib/mca/assistant/experience-contracts"

function safeLink(href: string) {
  if (/^https?:\/\//i.test(href)) return href
  if (
    /^\/(?:deals\?|assistant\?|api\/mca\/assistant\/files\/)[a-zA-Z0-9?=&_%./-]+$/.test(
      href
    )
  )
    return href
  return ""
}
export function RichResponse({
  text,
  citations = [],
  copy = true
}: {
  text: string
  citations?: Citation[]
  copy?: boolean
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="min-w-0">
      <div className="space-y-3 break-words text-sm leading-7 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-xs [&_pre_code]:p-0">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={safeLink}
          components={{
            a: ({ href, children }) =>
              href ? (
                <a
                  href={href}
                  target={href.startsWith("http") ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
            img: ({ alt }) => (
              <span className="text-muted-foreground">{alt || "Image"}</span>
            ),
            table: ({ children }) => <Table aria-label="Assistant response">{children}</Table>,
            thead: ({ children }) => <TableHeader>{children}</TableHeader>,
            tbody: ({ children }) => <TableBody>{children}</TableBody>,
            tr: ({ children }) => <TableRow>{children}</TableRow>,
            th: ({ children, style }) => <TableHead style={style}>{children}</TableHead>,
            td: ({ children, style }) => <TableCell style={style}>{children}</TableCell>
          }}
        >
          {text.replace(
            /(^|\s)(\/deals\?deal=[a-zA-Z0-9_-]+(?:&tab=[a-zA-Z0-9_-]+)?)/g,
            "$1[Open deal]($2)"
          )}
        </ReactMarkdown>
      </div>
      {!!citations.length && (
        <div aria-label="Sources" className="mt-4 flex flex-wrap gap-2">
          {citations.map((c, i) => (
            <a
              key={c.url}
              href={safeLink(c.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              <span className="text-primary">{i + 1}</span>
              <span className="truncate">
                {c.title || new URL(c.url).hostname}
              </span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ))}
        </div>
      )}
      {copy && text && (
        <Button
          variant="ghost"
          size="sm"
          aria-label="Copy response"
          className="mt-2 h-7 px-2 text-xs text-muted-foreground"
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              })
              .catch(() => {})
          }
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      )}
    </div>
  )
}
