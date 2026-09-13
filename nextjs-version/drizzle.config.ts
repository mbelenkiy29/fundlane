import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/lib/mca/db/chatkit.ts", "./src/lib/mca/db/schema.ts", "./src/lib/mca/db/marketing.ts", "./src/lib/mca/db/assistant-credits.ts", "./src/lib/mca/db/assistant-experience.ts", "./src/lib/mca/db/milestone05-*.ts", "./src/lib/mca/db/milestone06.ts", "./src/lib/mca/db/sms-onboarding.ts", "./src/lib/mca/db/merchant-remittance.ts"],
  out: "./drizzle",
  strict: true,
  verbose: true,
});
