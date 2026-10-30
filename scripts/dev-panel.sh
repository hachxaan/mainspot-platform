#!/usr/bin/env bash
# Entorno de DESARROLLO del panel integrado (DEV-E2E-03): interfaz de Claude Design servida por
# Express + PostgreSQL real + worker del agente en el mismo proceso. Google, Meta y Telegram
# quedan SIMULADOS (sin credenciales); nada toca producción.
#
# Origen oficial: https://app.mainspot.local.io (proxy HTTPS del LXC webserver → este proceso en el
# puerto interno 3100). Este script NO configura ni verifica hosts, proxy ni certificados: eso es
# el bootstrap único de scripts/dev-domain-bootstrap.sh.
#
#   scripts/dev-panel.sh            # prepara la BD mainspot_dev y arranca (https://app.mainspot.local.io)
#   scripts/dev-panel.sh invite "Panadería Lupita" lupita@example.com   # alta + enlace de invitación
#   scripts/dev-panel.sh env        # imprime las variables (para tests o scripts propios)
#
# Variables: MAINSPOT_DEV_PORT (3100, upstream del proxy), MAINSPOT_DEV_PG_PORT (55432), MAINSPOT_DEV_DB
# (mainspot_dev), PUBLIC_BASE_URL (https://app.mainspot.local.io).
# Requiere .env con POSTGRES_USER/POSTGRES_PASSWORD, DATABASE_URL y JWT_SECRET (ver .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
set +a

PG_PORT="${MAINSPOT_DEV_PG_PORT:-55432}"
DEV_DB="${MAINSPOT_DEV_DB:-mainspot_dev}"
export PORT="${MAINSPOT_DEV_PORT:-3100}"

# PostgreSQL del docker-compose del repo, publicado solo en loopback.
if ! docker exec mainspot-platform-postgres-1 pg_isready -U "${POSTGRES_USER:-mainspot}" >/dev/null 2>&1; then
  POSTGRES_PORT="127.0.0.1:${PG_PORT}" docker compose up -d postgres >/dev/null
  for _ in $(seq 1 40); do
    docker exec mainspot-platform-postgres-1 pg_isready -U "${POSTGRES_USER:-mainspot}" >/dev/null 2>&1 && break
    sleep 1
  done
fi

# Mismas credenciales de .env, apuntando a la BD de desarrollo en el puerto local.
url_for() { node -e 'const u=new URL(process.argv[1]);u.hostname="127.0.0.1";u.port=process.argv[2];u.pathname="/"+process.argv[3];console.log(u.toString())' "$DATABASE_URL" "$PG_PORT" "$1"; }
DATABASE_URL="$(url_for "$DEV_DB")"
TEST_DATABASE_URL="$(url_for mainspot_test)"
export DATABASE_URL TEST_DATABASE_URL
export APP_ENV=development JEV_MODE=disabled CHANNEL_PRIMARY=simulated TELEGRAM_BOT_TOKEN= \
  REPUTATION_PROVIDER=simulated GOOGLE_GBP_TOKEN= SOCIAL_PROVIDER=simulated META_GRAPH_TOKEN= \
  DOMAIN_PROVIDER=simulated PAYMENT_PROVIDER=simulated \
  ENGAGEMENT_WORKER=on ENGAGEMENT_WORKER_INTERVAL_MS="${ENGAGEMENT_WORKER_INTERVAL_MS:-3000}" ENGAGEMENT_POLL_INTERVAL_MS=0 \
  PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://app.mainspot.local.io}"

case "${1:-serve}" in
  env)
    env | grep -E '^(DATABASE_URL|TEST_DATABASE_URL|APP_ENV|PORT|PUBLIC_BASE_URL|JEV_MODE|CHANNEL_PRIMARY|REPUTATION_PROVIDER|SOCIAL_PROVIDER|ENGAGEMENT_)=' | sed -E 's#(://[^:]+:)[^@]+@#\1***@#'
    ;;
  invite)
    shift
    node scripts/db-setup.ts >/dev/null
    exec node scripts/invite-owner.ts --business "${1:?nombre del negocio}" --email "${2:?correo de la dueña o dueño}"
    ;;
  serve)
    node scripts/db-setup.ts >/dev/null
    echo "MainSpot (desarrollo) en ${PUBLIC_BASE_URL} — BD ${DEV_DB} en 127.0.0.1:${PG_PORT}; proveedores simulados"
    exec node src/api/server.ts
    ;;
  *)
    echo "uso: $0 [serve|invite <negocio> <correo>|env]" >&2
    exit 2
    ;;
esac
