import { MerchantUploadPanel } from "@/components/mca/closing/merchant-upload-panel"

export default async function MerchantUploadPage({ params }: { params: Promise<{ token: string }> }) {
  return <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6"><MerchantUploadPanel token={(await params).token} /></main>
}
