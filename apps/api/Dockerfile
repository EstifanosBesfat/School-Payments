# Build from the repository root:
#   docker build -f apps/api/Dockerfile -t payment-api .
FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat openssl
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile --filter @payment/api...

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
COPY tsconfig.base.json tsconfig.base.json
RUN pnpm --filter @payment/shared build \
 && pnpm --filter @payment/db build \
 && pnpm --filter @payment/api build \
 && pnpm --filter @payment/api --prod deploy /out

FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat openssl wget
WORKDIR /app
ENV NODE_ENV=production
ENV RUN_WORKERS=false
COPY --from=build /out/ ./
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/packages/db/prisma ./prisma
USER node
EXPOSE 4000
# Liveness only. Docker does not restart the container when this fails.
# Load balancers should use /health/ready, which also checks Postgres and Redis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
CMD ["node", "dist/main.js"]

FROM runner AS worker
ENV RUN_WORKERS=true
USER node
# The worker process does not listen on HTTP, so the API liveness probe must not be inherited.
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]

# Default image is the HTTP API. Build the worker with --target worker.
FROM runner
