# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t payment-web .
FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @payment/web...

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY tsconfig.base.json tsconfig.base.json
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_STANDALONE=1
RUN pnpm --filter @payment/shared build && pnpm --filter @payment/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN apk add --no-cache wget \
 && addgroup -S nextjs && adduser -S nextjs -G nextjs
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000 || exit 1
CMD ["node", "apps/web/server.js"]
