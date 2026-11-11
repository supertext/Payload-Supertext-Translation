# Demo Payload app with the Supertext translation plugin.
# Build context is the REPOSITORY ROOT (Railway: Dockerfile path `demo/Dockerfile`),
# so the image always contains the plugin as committed, packed like an npm release.
#
#   docker build -f demo/Dockerfile -t payload-supertext-demo .
#   docker run -p 3000:3000 -e DATABASE_URL=postgres://user:pass@host:5432/payload_demo \
#     -e PAYLOAD_SECRET=... -e SUPERTEXT_API_KEY=... payload-supertext-demo

FROM node:26-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1

# 1. Build and pack the plugin.
FROM base AS plugin
WORKDIR /repo
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY README.md CHANGELOG.md LICENSE ./
COPY docs ./docs
# `npm ci` runs the prepare script, which builds dist/.
RUN npm ci && npm pack && mv payload-supertext-translation-*.tgz /payload-supertext-translation.tgz

# 2. Build the demo app against the packed plugin.
FROM base AS builder
WORKDIR /app
COPY demo/package.json demo/package-lock.json demo/.npmrc ./
COPY demo/scripts ./scripts
COPY --from=plugin /payload-supertext-translation.tgz ./vendor/payload-supertext-translation.tgz
# The plugin tarball is rebuilt each time, so its lockfile hash is dropped first.
RUN node scripts/unpin-plugin.mjs && npm install --no-audit --no-fund
COPY demo/ ./
COPY --from=plugin /payload-supertext-translation.tgz ./vendor/payload-supertext-translation.tgz
RUN npm run build

# 3. Runtime: Next.js standalone server.
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
