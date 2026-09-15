# Multi-stage build: compile the pnpm monorepo, run the gateway
# (serves the dashboard static build + MCP/control-plane HTTP).

FROM node:22-bookworm AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/gateway apps/gateway
COPY apps/dashboard apps/dashboard

RUN pnpm -r build

# --- runtime ---

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && groupadd --system yusetu \
  && useradd --system --gid yusetu --home-dir /app --shell /usr/sbin/nologin yusetu

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    YUSETU_DATA_DIR=/app/data

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/gateway ./apps/gateway
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build /app/apps/dashboard/package.json ./apps/dashboard/package.json

RUN mkdir -p /app/data && chown -R yusetu:yusetu /app

USER yusetu

EXPOSE 8080
VOLUME ["/app/data"]

CMD ["pnpm", "--filter", "@yusetu/gateway", "start"]
