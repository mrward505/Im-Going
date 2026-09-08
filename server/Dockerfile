# I'm Going API — production image (Render free web service).
# Bun runtime; migrations run at container boot (docker-entrypoint.sh), then
# the Fastify server starts. Expects all config via environment (see DEPLOY.md).
FROM oven/bun:1 AS base
WORKDIR /app

# Install deps first for a stable layer (bun.lock is committed).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy the rest of the server (migrations, seed, src, data).
COPY . .

# Cheap non-root: oven/bun images ship a `bun` user; own the app dir and drop
# privileges. Data dir must stay writable for local file uploads.
RUN mkdir -p /app/data/uploads && chown -R bun:bun /app
USER bun

EXPOSE 8081
ENTRYPOINT ["./docker-entrypoint.sh"]
