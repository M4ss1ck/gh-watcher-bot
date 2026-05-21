# syntax=docker/dockerfile:1

# Stage 1: install dependencies and typecheck
FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle.config.ts ./

RUN bun run typecheck

# Stage 2: production image with only production dependencies
FROM oven/bun:1-alpine AS production
WORKDIR /app

RUN apk add --no-cache su-exec

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle.config.ts ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN addgroup -g 1001 -S bunjs && \
    adduser -S bot -u 1001 -G bunjs && \
    mkdir -p /app/data && \
    chown -R bot:bunjs /app

ENV NODE_ENV=production

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD ["bun", "run", "src/healthcheck.ts"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
