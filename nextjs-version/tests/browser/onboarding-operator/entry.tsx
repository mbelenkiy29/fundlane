import { createRoot } from "react-dom/client"
import { StrictMode } from "react"
import { ThemeProvider } from "../../../src/components/theme-provider"
import { PlatformChrome } from "../../../src/components/mca/platform/platform-chrome"
import Onboarding from "../../../src/app/platform/onboarding/page"

async function render() {
  const theme = new URL(location.href).searchParams.get("theme") === "dark" ? "dark" : "light"
  const content = await Onboarding()
  createRoot(document.getElementById("root")!).render(<StrictMode><ThemeProvider defaultTheme={theme} storageKey="operator-preview-theme"><PlatformChrome email="operator@example.test" roadmapEnabled={false}>{content}</PlatformChrome></ThemeProvider></StrictMode>)
}
void render()
