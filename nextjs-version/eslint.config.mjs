import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    // Generated synthetic platform browser bundle; lint its test sources instead.
    "output/playwright/platform-redesign/**",
    "next-env.d.ts",
    "pnpm-workspace.yaml",
    // Minified Edge bundles from scripts/supabase/build.mjs. Lint the TypeScript
    // entries under scripts/supabase/entries instead.
    "supabase/functions/**/runtime.js",
  ]),
]);
