import { createRoot } from "react-dom/client"
import { ThemeProvider } from "../../../src/components/theme-provider"
import { PlatformChrome } from "../../../src/components/mca/platform/platform-chrome"
import Overview from "../../../src/app/platform/page"
import Companies from "../../../src/app/platform/companies/page"
import Company from "../../../src/app/platform/companies/[id]/page"
import Payments from "../../../src/app/platform/payments/page"
import Audit from "../../../src/app/platform/audit/page"
import Monitoring from "../../../src/app/platform/monitoring/page"
import Sms from "../../../src/app/platform/sms/page"
import Roadmap from "../../../src/app/platform/roadmap/page"
import Loading from "../../../src/app/platform/loading"
import ErrorPage from "../../../src/app/platform/error"

async function render() {
  const url = new URL(location.href)
  const searchParams = Promise.resolve(Object.fromEntries(url.searchParams))
  const pages: Record<string, () => Promise<React.ReactNode>> = {
    "/platform": () => Overview(),
    "/platform/companies": () => Companies({ searchParams }),
    "/platform/companies/company-a": () => Company({ params: Promise.resolve({ id: "company-a" }), searchParams }),
    "/platform/payments": () => Payments({ searchParams }),
    "/platform/audit": () => Audit({ searchParams }),
    "/platform/monitoring": () => Monitoring(),
    "/platform/sms": () => Sms({ searchParams }),
    "/platform/roadmap": () => Roadmap(),
  }
  const fixture = url.searchParams.get("fixture")
  const content = fixture === "loading" ? <Loading /> : fixture === "error" ? <ErrorPage error={new Error("Synthetic platform error")} reset={() => location.reload()} /> : await (pages[url.pathname] ?? pages["/platform"])()
  createRoot(document.getElementById("root")!).render(<ThemeProvider defaultTheme={url.searchParams.get("theme") === "dark" ? "dark" : "light"} storageKey="platform-preview-theme"><PlatformChrome userId="00000000-0000-4000-8000-000000000001" email="operator@example.test" roadmapEnabled={url.searchParams.get("roadmap") !== "off"}>{content}</PlatformChrome></ThemeProvider>)
}
void render()
