import Link from "next/link"
import { notFound } from "next/navigation"
import { MarketingShell } from "@/components/marketing/shell"
import { helpArticle, helpArticles } from "@/lib/marketing/help"
import { marketingMetadata } from "@/lib/marketing/metadata"

export function generateStaticParams() {
  return helpArticles.map(({ slug }) => ({ slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const article = helpArticle((await params).slug)
  return article ? marketingMetadata(article.title, `/help/${article.slug}`, article.summary) : {}
}

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const article = helpArticle((await params).slug)
  if (!article) notFound()
  return <MarketingShell jsonLd={{ title: article.title, path: `/help/${article.slug}`, description: article.summary }}>
    <main id="main" className="fl-container fl-help fl-help-article">
      <Link href="/help" className="fl-text-link">← All guides</Link>
      <h1>{article.title}</h1>
      <p>{article.summary}</p>
      <ol>{article.steps.map(step => <li key={step}>{step}</li>)}</ol>
      <Link href="/help" className="fl-text-link">Back to help center →</Link>
    </main>
  </MarketingShell>
}
