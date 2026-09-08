#!/bin/sh
# Container entrypoint: migrate first, then start the API.
# Render injects $PORT; env.ts defaults HOST to 0.0.0.0 when
# NODE_ENV=production, so no extra flags are needed here.
set -eu

echo "==> running migrations"
bun run migrate

echo "==> starting imgoing-api (PORT=${PORT:-8081})"
exec bun src/index.ts
