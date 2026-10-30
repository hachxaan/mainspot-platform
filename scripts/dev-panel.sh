#!/usr/bin/env bash
# Entorno de DESARROLLO del panel integrado (DEV-E2E-03): interfaz de Claude Design servida por
# Express + PostgreSQL real + worker del agente en el MISMO proceso (un solo `node`, un solo worker).
# Google, Meta, dominios y pagos quedan SIMULADOS (sin credenciales); nada toca producción.
#
# Telegram: simulado por defecto. El canal REAL (webhook público vía KVM/WireGuard → este proceso)
# solo se activa de forma EXPLÍCITA con MAINSPOT_DEV_TELEGRAM=real en el archivo protegido
# ~/.config/mainspot/telegram-webhook.env (0600; ver scripts/deploy/telegram-webhook.env.example).
# En modo real faltan TELEGRAM_BOT_TOKEN o TELEGRAM_WEBHOOK_SECRET ⇒ el arranque ABORTA (fail closed,
# código 78 = EX_CONFIG). La mera presencia de un token NUNCA activa el canal, y las variables
# TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET y MAINSPOT_DEV_TELEGRAM de .env se ignoran.
# TELEGRAM_WEBHOOK_SECRET del archivo protegido se aplica en ambos modos: así el endpoint
# /api/telegram/webhook exige la cabecera secreta siempre que el servidor esté expuesto.
#
# Origen oficial: https://app.mainspot.local.io (proxy HTTPS del LXC webserver → este proceso en el
# puerto interno 3100). Este script NO configura ni verifica hosts, proxy ni certificados: eso es
# el bootstrap único de scripts/dev-domain-bootstrap.sh. Como servicio persistente se ejecuta desde
# scripts/deploy/mainspot-local.service (ExecStart=… serve).
#
#   scripts/dev-panel.sh            # prepara la BD mainspot_dev y arranca (https://app.mainspot.local.io)
#   scripts/dev-panel.sh invite "Panadería Lupita" lupita@example.com   # alta + enlace de invitación
#   scripts/dev-panel.sh env        # imprime las variables (secretos enmascarados)
#
# Variables: MAINSPOT_DEV_PORT (3100, upstream del proxy), MAINSPOT_DEV_PG_PORT (55432), MAINSPOT_DEV_DB
# (mainspot_dev), PUBLIC_BASE_URL (https://app.mainspot.local.io), MAINSPOT_TELEGRAM_ENV_FILE
# (ruta del archivo protegido; por defecto $XDG_CONFIG_HOME/mainspot/telegram-webhook.env).
# Requiere .env con POSTGRES_USER/POSTGRES_PASSWORD, DATABASE_URL y JWT_SECRET (ver .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."

EX_CONFIG=78

set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
set +a
# Telegram nunca se configura desde .env en este entorno (solo desde el archivo protegido).
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET MAINSPOT_DEV_TELEGRAM

PG_PORT="${MAINSPOT_DEV_PG_PORT:-55432}"
DEV_DB="${MAINSPOT_DEV_DB:-mainspot_dev}"
export PORT="${MAINSPOT_DEV_PORT:-3100}"

# --- Telegram: archivo protegido (opcional) -------------------------------------------------------
TELEGRAM_ENV_FILE="${MAINSPOT_TELEGRAM_ENV_FILE:-${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}/mainspot/telegram-webhook.env}"
if [ -e "$TELEGRAM_ENV_FILE" ]; then
  perm="$(stat -c '%a' "$TELEGRAM_ENV_FILE")"
  if [ $(( 8#$perm & 8#077 )) -ne 0 ]; then
    echo "ERROR: $TELEGRAM_ENV_FILE debe ser 0600 (actual $perm); no se carga ningún secreto." >&2
    exit "$EX_CONFIG"
  fi
  set -a
  # shellcheck disable=SC1090
  . "$TELEGRAM_ENV_FILE"
  set +a
fi
TELEGRAM_MODE="${MAINSPOT_DEV_TELEGRAM:-simulated}"
case "$TELEGRAM_MODE" in
  real)
    if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]; then
      echo "ERROR: MAINSPOT_DEV_TELEGRAM=real exige TELEGRAM_BOT_TOKEN y TELEGRAM_WEBHOOK_SECRET en $TELEGRAM_ENV_FILE (fail closed)." >&2
      exit "$EX_CONFIG"
    fi
    CHANNEL_PRIMARY=telegram
    ;;
  simulated)
    CHANNEL_PRIMARY=simulated
    TELEGRAM_BOT_TOKEN=
    ;;
  *)
    echo "ERROR: MAINSPOT_DEV_TELEGRAM debe ser real|simulated (actual: $TELEGRAM_MODE)." >&2
    exit "$EX_CONFIG"
    ;;
esac
export MAINSPOT_DEV_TELEGRAM="$TELEGRAM_MODE" CHANNEL_PRIMARY TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"

# PostgreSQL del docker-compose del repo, publicado solo en loopback.
if ! docker exec mainspot-platform-postgres-1 pg_isready -U "${POSTGRES_USER:-mainspot}" >/dev/null 2>&1; then
  POSTGRES_PORT="127.0.0.1:${PG_PORT}" docker compose up -d postgres >/dev/null
  for _ in $(seq 1 40); do
    docker exec mainspot-platform-postgres-1 pg_isready -U "${POSTGRES_USER:-mainspot}" >/dev/null 2>&1 && break
    sleep 1
  done
fi

# Mismas credenciales de .env, apuntando a la BD de desarrollo en el puerto local. La URL (con
# password) viaja por el entorno heredado, nunca por argumentos visibles en `ps`.
url_for() { node -e 'const u=new URL(process.env.DATABASE_URL);u.hostname="127.0.0.1";u.port=process.argv[1];u.pathname="/"+process.argv[2];console.log(u.toString())' "$PG_PORT" "$1"; }
DATABASE_URL="$(url_for "$DEV_DB")"
TEST_DATABASE_URL="$(url_for mainspot_test)"
export DATABASE_URL TEST_DATABASE_URL
export APP_ENV=development JEV_MODE=disabled \
  REPUTATION_PROVIDER=simulated GOOGLE_GBP_TOKEN= SOCIAL_PROVIDER=simulated META_GRAPH_TOKEN= \
  DOMAIN_PROVIDER=simulated PAYMENT_PROVIDER=simulated \
  ENGAGEMENT_WORKER=on ENGAGEMENT_WORKER_INTERVAL_MS="${ENGAGEMENT_WORKER_INTERVAL_MS:-3000}" ENGAGEMENT_POLL_INTERVAL_MS=0 \
  PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://app.mainspot.local.io}"

case "${1:-serve}" in
  env)
    env | grep -E '^(DATABASE_URL|TEST_DATABASE_URL|APP_ENV|PORT|PUBLIC_BASE_URL|JEV_MODE|CHANNEL_PRIMARY|MAINSPOT_DEV_TELEGRAM|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|REPUTATION_PROVIDER|SOCIAL_PROVIDER|ENGAGEMENT_)=' \
      | sed -E 's#(://[^:]+:)[^@]+@#\1***@#; s#^(TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET)=.+#\1=***#'
    ;;
  invite)
    shift
    node scripts/db-setup.ts >/dev/null
    exec node scripts/invite-owner.ts --business "${1:?nombre del negocio}" --email "${2:?correo de la dueña o dueño}"
    ;;
  serve)
    node scripts/db-setup.ts >/dev/null
    echo "MainSpot (desarrollo) en ${PUBLIC_BASE_URL} — BD ${DEV_DB} en 127.0.0.1:${PG_PORT}; Telegram ${TELEGRAM_MODE}, resto de proveedores simulados"
    exec node src/api/server.ts
    ;;
  *)
    echo "uso: $0 [serve|invite <negocio> <correo>|env]" >&2
    exit 2
    ;;
esac
