import { SettingsShell } from "@/components/mca/settings-shell"

export default function Layout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>
}
