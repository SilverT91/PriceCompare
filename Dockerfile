# PriceCompare as a container (see compose.yaml and tools/deploy.ps1).
#   docker build --target test .   type check and unit tests (no network)
#   docker compose up -d --build   the app, on 127.0.0.1:8787 of the host
# Node runs the TypeScript directly; there is no build step.

FROM node:26.12.0-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./

# Type check and tests, with the dev dependencies. A failing test fails the build.
FROM base AS test
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm test

FROM base AS app
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
COPY data ./data
# Listen on every interface inside the container; compose.yaml publishes the port on the host's
# 127.0.0.1 only. The SQLite file lives in the /data volume, so it survives a new image.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 PRICE_COMPARE_DB=/data/price-compare.sqlite
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "src/node/server.ts"]
