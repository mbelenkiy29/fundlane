import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account access",
  description: "Secure access to your MCA workspace",
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      {children}
    </div>
  );
}
