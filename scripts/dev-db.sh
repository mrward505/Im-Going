#!/usr/bin/env bash
# Bootstrap the LOCAL dev PostgreSQL database for I'm Going (idempotent).
# Creates role + database if missing and starts the cluster if it is down.
# Safe to re-run. Prints the DATABASE_URL to use in server/.env.
set -euo pipefail

DB_USER="${DB_USER:-imgoing}"
DB_PASS="${DB_PASS:-imgoing_dev_password}"
DB_NAME="${DB_NAME:-imgoing}"
DB_PORT="${DB_PORT:-5432}"

run_psql() {
  if [ "$(id -un)" = "postgres" ]; then
    psql "$@"
  elif sudo -n true 2>/dev/null; then
    sudo -u postgres psql "$@"
  else
    echo "error: need passwordless sudo or a postgres shell to manage local Postgres" >&2
    exit 1
  fi
}

# Start a Debian/Ubuntu cluster if one exists but is offline.
if command -v pg_ctlcluster >/dev/null 2>&1 && command -v pg_lsclusters >/dev/null 2>&1; then
  if ! pg_lsclusters | grep -q online; then
    echo "starting postgres cluster..."
    VER=$(pg_lsclusters --no-header | awk '{print $1; exit}')
    CLUSTER=$(pg_lsclusters --no-header | awk '{print $2; exit}')
    sudo pg_ctlcluster "${VER:-16}" "${CLUSTER:-main}" start
  fi
elif command -v pg_ctl >/dev/null 2>&1; then
  echo "note: pg_ctlcluster not found; assuming Postgres is already running (env DATABASE_URL)."
fi

# Wait for readiness (pg_isready ships with postgresql-client).
if command -v pg_isready >/dev/null 2>&1; then
  until pg_isready -q -h 127.0.0.1 -p "$DB_PORT"; do sleep 0.5; done
fi

run_psql -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || run_psql -v ON_ERROR_STOP=1 -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'"

run_psql -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || run_psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"

echo "ok: DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@127.0.0.1:${DB_PORT}/${DB_NAME}"