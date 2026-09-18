FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG MCA_MARKETING_PRIVACY_URL
ENV MCA_MARKETING_PRIVACY_URL=$MCA_MARKETING_PRIVACY_URL
RUN pnpm build && node scripts/assistant/build-worker.mjs && node scripts/marketing/build-inbox.mjs

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends clamav ca-certificates gosu && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/.next/assistant-worker.cjs ./assistant-worker.cjs
COPY --from=build /app/.next/marketing-inbox.cjs ./marketing-inbox.cjs
COPY scripts/assistant/supervisor.cjs ./supervisor.cjs
COPY scripts/railway/start.sh /usr/local/bin/fundlane-start
RUN chmod 755 /usr/local/bin/fundlane-start
EXPOSE 3000
CMD ["/usr/local/bin/fundlane-start"]
