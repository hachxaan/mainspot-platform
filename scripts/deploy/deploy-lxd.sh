#!/usr/bin/env bash
# =============================================================================
# deploy-lxd.sh — MainSpot Platform: despliegue local reproducible en LXD.
#
# Topología (2 contenedores sobre la red LXD lxdbr0 con NAT):
#   mainspot-db    PostgreSQL 16 (Ubuntu 24.04)  — solo dentro de lxdbr0
#   mainspot-app   Node >= 24 (Ubuntu 24.04)     — API Express conectada a mainspot-db
#   proxy-http     device LXD: listen tcp:0.0.0.0:<APP_HOST_LISTEN_PORT> (host)
#                           -> connect tcp:127.0.0.1:<APP_CONTAINER_PORT> (app)
#
# Secretos (NUNCA en el repo):
#   ~/.config/mainspot/mainspot-secrets.env        (0600) POSTGRES_PASSWORD + JWT_SECRET
#   generados aleatoriamente (openssl rand -hex) en el primer deploy; opcional
#   TYPESAFE_API_KEY (añadida a mano) para JEV_MODE=shadow|primary (APR-0002).
# Config NO secreta overrideable:
#   ~/.config/mainspot/mainspot-deploy.env         (ver mainspot-deploy.env.example)
#
# Uso:
#   ./deploy-lxd.sh           idempotente: asegura contenedores/db/app/proxy
#   ./deploy-lxd.sh --update-code  copia el repo actual a mainspot-app, npm ci +
#                                  typecheck, reinicia mainspot.service (sin
#                                  recrear contenedores ni re-migrar BD)
#   ./deploy-lxd.sh --reset   destruye y recrea los contenedores mainspot-*
#   ./deploy-lxd.sh --destroy destruye los contenedores mainspot-* y el proxy
#
# Seguridad:
#   - pg_hba.conf de mainspot-db SOLO acepta la subred lxdbr0 (nunca WAN).
#   - JWT_SECRET requerido por la app (fail-fast IR-02): sin él no arranca.
#   - /etc/mainspot/mainspot.env dentro de mainspot-app con permisos 0600.
#   - No se imprimen ni comitean valores secretos.
# =============================================================================
set -euo pipefail

# --- configuración NO secreta (defaults; override en mainspot-deploy.env) ----
SECRETS_DIR="${MAINSPOT_SECRETS_DIR:-$HOME/.config/mainspot}"
LXD_IMAGE="${LXD_IMAGE:-ubuntu:24.04}"
DB_CONTAINER="${DB_CONTAINER:-mainspot-db}"
APP_CONTAINER="${APP_CONTAINER:-mainspot-app}"
APP_INSIDE_DIR="${APP_INSIDE_DIR:-/opt/mainspot-platform}"
DB_USER="${DB_USER:-mainspot}"
DB_NAME="${DB_NAME:-mainspot}"
DB_TEST_NAME="${DB_TEST_NAME:-mainspot_test}"
APP_CONTAINER_PORT="${APP_CONTAINER_PORT:-3000}"
APP_HOST_LISTEN_PORT="${APP_HOST_LISTEN_PORT:-3000}"
# Variables de entorno de la app (no secretas; ver .env.example del repo)
APP_ENV="${APP_ENV:-production}"
LOG_LEVEL="${LOG_LEVEL:-info}"
AUDIT_MODE="${AUDIT_MODE:-fail_closed}"
JWT_TTL_MINUTES="${JWT_TTL_MINUTES:-60}"
SESSION_SOURCE="${SESSION_SOURCE:-backoffice}"
RATE_LIMIT_MAX="${RATE_LIMIT_MAX:-5}"
RATE_LIMIT_WINDOW_MS="${RATE_LIMIT_WINDOW_MS:-60000}"
RATE_LIMIT_LOCK_MS="${RATE_LIMIT_LOCK_MS:-60000}"
CHANNEL_PRIMARY="${CHANNEL_PRIMARY:-simulated}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_BASE_URL="${TELEGRAM_BASE_URL:-https://api.telegram.org}"
PREVIEW_TOKEN_TTL_MINUTES="${PREVIEW_TOKEN_TTL_MINUTES:-1440}"
APPROVAL_RATE_LIMIT_MAX="${APPROVAL_RATE_LIMIT_MAX:-10}"
APPROVAL_RATE_LIMIT_WINDOW_MS="${APPROVAL_RATE_LIMIT_WINDOW_MS:-60000}"
APPROVAL_RATE_LIMIT_LOCK_MS="${APPROVAL_RATE_LIMIT_LOCK_MS:-30000}"
DOMAIN_PROVIDER="${DOMAIN_PROVIDER:-simulated}"
HOSTINGER_API_BASE_URL="${HOSTINGER_API_BASE_URL:-https://api.hostinger.com}"
HOSTINGER_API_TOKEN="${HOSTINGER_API_TOKEN:-}"
MAINSPOT_DOMAIN_SUFFIX="${MAINSPOT_DOMAIN_SUFFIX:-sim.mainspot.local}"
REVIEW_THRESHOLD="${REVIEW_THRESHOLD:-4}"
REPUTATION_PROVIDER="${REPUTATION_PROVIDER:-simulated}"
SOCIAL_PROVIDER="${SOCIAL_PROVIDER:-simulated}"
META_GRAPH_VERSION="${META_GRAPH_VERSION:-v26.0}"
META_ADS_CHECK="${META_ADS_CHECK:-off}"
SOCIAL_SCHEDULER="${SOCIAL_SCHEDULER:-on}"
SOCIAL_SCHEDULER_INTERVAL_MS="${SOCIAL_SCHEDULER_INTERVAL_MS:-15000}"
SOCIAL_SCHEDULER_TIMEZONE="${SOCIAL_SCHEDULER_TIMEZONE:-America/Cancun}"
META_GRAPH_BASE_URL="${META_GRAPH_BASE_URL:-https://graph.facebook.com}"
PAYMENT_PROVIDER="${PAYMENT_PROVIDER:-simulated}"
# APR-0002: Jev como clasificador (la clave TYPESAFE_API_KEY va en el archivo de secretos).
JEV_MODE="${JEV_MODE:-disabled}"
JEV_PROVIDER="${JEV_PROVIDER:-}"
JEV_MODEL="${JEV_MODEL:-}"
JEV_DATA_SCOPE="${JEV_DATA_SCOPE:-synthetic}"
JEV_SYNTHETIC_TENANTS="${JEV_SYNTHETIC_TENANTS:-}"
JEV_DAILY_BUDGET_USD="${JEV_DAILY_BUDGET_USD:-1}"

# --- ubicaciones derivadas ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECRETS_FILE="$SECRETS_DIR/mainspot-secrets.env"
APP_ENV_TMP="$SECRETS_DIR/.tmp-mainspot-app.env"

log() { printf '[deploy-lxd] %s\n' "$*"; }
die() { printf '[deploy-lxd] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '1,60p' "$0" | grep -E '^#( Uso|   \./deploy|$)' | sed 's/^# //; s/^#$//'
}

source_overrides() {
  if [[ -f "$SECRETS_DIR/mainspot-deploy.env" ]]; then
    # shellcheck disable=SC1091
    source "$SECRETS_DIR/mainspot-deploy.env"
    log "overrides cargados de $SECRETS_DIR/mainspot-deploy.env"
  fi
}

require_cmds() {
  for c in lxc jq curl openssl; do
    command -v "$c" >/dev/null 2>&1 || die "falta '$c' en el host"
  done
}

ensure_secrets() {
  if [[ ! -s "$SECRETS_FILE" ]]; then
    install -d -m 700 "$SECRETS_DIR"
    umask 177
    cat > "$SECRETS_FILE" <<EOF
# MainSpot LXD deploy secrets - generated $(date -Is) - NO COMMIT
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
EOF
    chmod 600 "$SECRETS_FILE"
    log "secretos generados en $SECRETS_FILE (0600)"
  fi
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
}

lxc_state() { # $1 name -> estado o vacío
  lxc list --format json 2>/dev/null | jq -r --arg n "$1" '.[] | select(.name==$n) | .status' 2>/dev/null || true
}

wait_running() { # $1 container
  local n="$1"
  for _ in $(seq 1 60); do
    [[ "$(lxc_state "$n")" == "Running" ]] && return 0
    sleep 5
  done
  die "timeout esperando a '$n' Running"
}

wait_ip() { # $1 container -> imprime IPv4 eth0 cuando esté disponible (puede tardar unos segundos tras boot)
  local n="$1" ip
  for _ in $(seq 1 60); do
    ip="$(lxc list "$n" --format json 2>/dev/null | jq -r '.[0].state.network.eth0.addresses[]? | select(.family=="inet") | .address' | head -1)"
    [[ -n "$ip" ]] && { printf '%s' "$ip"; return 0; }
    sleep 5
  done
  return 1
}

container_ip() { # $1 container -> IPv4 eth0 (o exit 1 si no aparece)
  local ip
  ip="$(wait_ip "$1")" || return 1
  printf '%s' "$ip"
}

ensure_container() { # $1 container
  local n="$1" st ip
  st="$(lxc_state "$n")"
  if [[ -z "$st" ]]; then
    log "creando contenedor '$n' ($LXD_IMAGE)..."
    lxc launch "$LXD_IMAGE" "$n"
    wait_running "$n"
  elif [[ "$st" == "Stopped" ]]; then
    log "arrancando contenedor '$n'..."
    lxc start "$n"
    wait_running "$n"
  fi
  ip="$(container_ip "$n")" || die "no pude resolver la IP de '$n'"
  lxc config set "$n" boot.autostart true || true
  log "'$n' = $(lxc_state "$n")  IP=$ip"
}

# ----------------------------------------------------------------------------
# mainspot-db
# ----------------------------------------------------------------------------
provision_db() {
  local db_ip subnet pg_ver conf hba
  db_ip="$(container_ip "$DB_CONTAINER")" || die "no pude resolver la IP de '$DB_CONTAINER'"
  subnet="${PG_HBA_SUBNET:-$(printf '%s' "$db_ip" | cut -d. -f1-3).0/24}"

  lxc exec "$DB_CONTAINER" -- bash -s <<'EOF'
set -euo pipefail
if ! command -v psql >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq postgresql postgresql-contrib >/tmp/apt-db.log 2>&1
fi
service postgresql start >/dev/null 2>&1 || true
EOF
  pg_ver="$(lxc exec "$DB_CONTAINER" -- bash -c "pg_lsclusters -h | awk '{print \$1}' | head -1")"
  conf="/etc/postgresql/$pg_ver/main/postgresql.conf"
  hba="/etc/postgresql/$pg_ver/main/pg_hba.conf"

  # listen dentro de la red LXD + pg_hba restringido a la subred lxdbr0
  # (línea marcada # mainspot-lxd-managed: se reescribe en cada run — convergente).
  lxc exec "$DB_CONTAINER" --env conf="$conf" --env hba="$hba" --env subnet="$subnet" -- bash -s <<'EOF'
set -euo pipefail
sed -i 's/^#\?listen_addresses.*/listen_addresses = '\''*'\''/' "$conf"
grep -qE '^[[:space:]]*listen_addresses' "$conf" || echo "listen_addresses = '*'" >> "$conf"
sed -i '/# mainspot-lxd-managed/d' "$hba"
echo "host all all $subnet scram-sha-256 # mainspot-lxd-managed" >> "$hba"
service postgresql restart
sleep 2
EOF

  # role + bases (idempotente; sincroniza password con el secrets file).
  lxc exec "$DB_CONTAINER" --env PGPASSWORD="$POSTGRES_PASSWORD" -- bash -s <<'EOF'
set -euo pipefail
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mainspot') THEN
    CREATE ROLE mainspot LOGIN CREATEDB PASSWORD '$PGPASSWORD';
  ELSE
    ALTER ROLE mainspot LOGIN CREATEDB PASSWORD '$PGPASSWORD';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE mainspot OWNER mainspot' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='mainspot')\gexec
SELECT 'CREATE DATABASE mainspot_test OWNER mainspot' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='mainspot_test')\gexec
SQL
EOF
  log "$DB_CONTAINER listo (PostgreSQL $pg_ver, pg_hba subred $subnet)"
}

# ----------------------------------------------------------------------------
# mainspot-app
# ----------------------------------------------------------------------------
provision_app() {
  local db_ip node_major tar_tmp
  db_ip="$(container_ip "$DB_CONTAINER")" || die "no pude resolver la IP de '$DB_CONTAINER'"

  # Node >= 24 (type-stripping nativo para src/**/*.ts; el repo no usa build).
  node_major="$(lxc exec "$APP_CONTAINER" -- node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || true)"
  if [[ -z "$node_major" || "$node_major" -lt 24 ]]; then
    log "instalando Node 24 vía NodeSource (apt trae $node_major/viejo)..."
    lxc exec "$APP_CONTAINER" -- bash -s <<'EOF'
set -euo pipefail
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/tmp/nodesource.log 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs curl ca-certificates >/tmp/apt-node.log 2>&1
EOF
  fi
  log "node en $APP_CONTAINER: $(lxc exec "$APP_CONTAINER" -- node -v) npm=$(lxc exec "$APP_CONTAINER" -- npm -v)"

  # Copia del repo (idempotente: siempre refresca; nunca arrastra secretos).
  tar_tmp="/tmp/mainspot-src-$$.tar.gz"
  tar -czf "$tar_tmp" --exclude='node_modules' --exclude='.git' --exclude='.deploy' --exclude='.env' -C "$REPO_ROOT" .
  lxc file push "$tar_tmp" "$APP_CONTAINER/tmp/mainspot-src.tar.gz" >/dev/null
  rm -f "$tar_tmp"
  log "npm ci en $APP_CONTAINER (puede tardar ~1 min en la primera ejecución)..."
  lxc exec "$APP_CONTAINER" -- bash -c "rm -rf $APP_INSIDE_DIR && mkdir -p $APP_INSIDE_DIR && tar -xzf /tmp/mainspot-src.tar.gz -C $APP_INSIDE_DIR && rm /tmp/mainspot-src.tar.gz && cd $APP_INSIDE_DIR && npm ci --no-audit --no-fund >/tmp/npm-ci.log 2>&1 && echo npm_ci_done" || die "npm ci falló (ver: lxc exec $APP_CONTAINER -- cat /tmp/npm-ci.log)"

  # env file de la app (0600, propietario mainspot) — construido en el host y
  # pusheado; la copia local temporal se borra al terminar.
  umask 177
  cat > "$APP_ENV_TMP" <<EOF
# MainSpot LXD deploy env - generado por scripts/deploy/deploy-lxd.sh - NO COMMIT
APP_ENV=${APP_ENV}
PORT=${APP_CONTAINER_PORT}
LOG_LEVEL=${LOG_LEVEL}
AUDIT_MODE=${AUDIT_MODE}
DATABASE_URL=postgres://${DB_USER}:${POSTGRES_PASSWORD}@${db_ip}:5432/${DB_NAME}
JWT_SECRET=${JWT_SECRET}
JWT_TTL_MINUTES=${JWT_TTL_MINUTES}
SESSION_SOURCE=${SESSION_SOURCE}
RATE_LIMIT_MAX=${RATE_LIMIT_MAX}
RATE_LIMIT_WINDOW_MS=${RATE_LIMIT_WINDOW_MS}
RATE_LIMIT_LOCK_MS=${RATE_LIMIT_LOCK_MS}
CHANNEL_PRIMARY=${CHANNEL_PRIMARY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_BASE_URL=${TELEGRAM_BASE_URL}
PREVIEW_TOKEN_TTL_MINUTES=${PREVIEW_TOKEN_TTL_MINUTES}
APPROVAL_RATE_LIMIT_MAX=${APPROVAL_RATE_LIMIT_MAX}
APPROVAL_RATE_LIMIT_WINDOW_MS=${APPROVAL_RATE_LIMIT_WINDOW_MS}
APPROVAL_RATE_LIMIT_LOCK_MS=${APPROVAL_RATE_LIMIT_LOCK_MS}
DOMAIN_PROVIDER=${DOMAIN_PROVIDER}
HOSTINGER_API_BASE_URL=${HOSTINGER_API_BASE_URL}
HOSTINGER_API_TOKEN=${HOSTINGER_API_TOKEN}
MAINSPOT_DOMAIN_SUFFIX=${MAINSPOT_DOMAIN_SUFFIX}
REVIEW_THRESHOLD=${REVIEW_THRESHOLD}
REPUTATION_PROVIDER=${REPUTATION_PROVIDER}
CONNECTOR_TOKEN_KEY=${CONNECTOR_TOKEN_KEY:-}
GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID:-}
GOOGLE_OAUTH_CLIENT_SECRET=${GOOGLE_OAUTH_CLIENT_SECRET:-}
GOOGLE_OAUTH_REDIRECT_URI=${GOOGLE_OAUTH_REDIRECT_URI:-}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:3000}
SOCIAL_PROVIDER=${SOCIAL_PROVIDER}
META_APP_ID=${META_APP_ID:-}
META_APP_SECRET=${META_APP_SECRET:-}
META_GRAPH_VERSION=${META_GRAPH_VERSION}
META_ADS_CHECK=${META_ADS_CHECK}
SOCIAL_SCHEDULER=${SOCIAL_SCHEDULER}
SOCIAL_SCHEDULER_INTERVAL_MS=${SOCIAL_SCHEDULER_INTERVAL_MS}
SOCIAL_SCHEDULER_TIMEZONE=${SOCIAL_SCHEDULER_TIMEZONE}
META_GRAPH_BASE_URL=${META_GRAPH_BASE_URL}
PAYMENT_PROVIDER=${PAYMENT_PROVIDER}
JEV_MODE=${JEV_MODE}
JEV_PROVIDER=${JEV_PROVIDER}
TYPESAFE_API_KEY=${TYPESAFE_API_KEY:-}
JEV_MODEL=${JEV_MODEL}
JEV_DATA_SCOPE=${JEV_DATA_SCOPE}
JEV_SYNTHETIC_TENANTS=${JEV_SYNTHETIC_TENANTS}
JEV_DAILY_BUDGET_USD=${JEV_DAILY_BUDGET_USD}
EOF
  chmod 600 "$APP_ENV_TMP"
  lxc exec "$APP_CONTAINER" -- bash -c 'mkdir -p /etc/mainspot && useradd -r -s /usr/sbin/nologin mainspot 2>/dev/null || true'
  lxc file push "$APP_ENV_TMP" "$APP_CONTAINER/etc/mainspot/mainspot.env" >/dev/null
  rm -f "$APP_ENV_TMP"
  lxc exec "$APP_CONTAINER" -- bash -c 'chown mainspot:mainspot /etc/mainspot/mainspot.env && chmod 600 /etc/mainspot/mainspot.env'

  # migraciones + seed (idempotente; DATABASE_URL del env file).
  lxc exec "$APP_CONTAINER" -- bash -c "set -a; source /etc/mainspot/mainspot.env; set +a; cd $APP_INSIDE_DIR && node scripts/db-setup.ts >/tmp/db-setup.log 2>&1 && tail -1 /tmp/db-setup.log"

  # systemd unit (a prueba de reinicio: enabled + Restart=on-failure).
  lxc file push "$SCRIPT_DIR/mainspot.service" "$APP_CONTAINER/etc/systemd/system/mainspot.service" >/dev/null
  lxc exec "$APP_CONTAINER" -- bash -c "systemctl daemon-reload && systemctl enable mainspot.service >/dev/null 2>&1 && systemctl restart mainspot.service && sleep 3 && systemctl is-active mainspot.service"
}

ensure_proxy() {
  if ! lxc config device get "$APP_CONTAINER" proxy-http type >/dev/null 2>&1; then
    log "añadiendo device proxy-http: listen 0.0.0.0:$APP_HOST_LISTEN_PORT -> $APP_CONTAINER:$APP_CONTAINER_PORT"
    lxc config device add "$APP_CONTAINER" proxy-http proxy \
      "connect=tcp:127.0.0.1:$APP_CONTAINER_PORT" \
      "listen=tcp:0.0.0.0:$APP_HOST_LISTEN_PORT"
  else
    log "device proxy-http ya existe ($(lxc config device get "$APP_CONTAINER" proxy-http listen))"
  fi
}

# ----------------------------------------------------------------------------
# --update-code: despliega SOLO el código actualizado (sin recrear contenedores,
# sin re-migrar la BD, sin tocar secretos). Reutiliza el mismo mecanismo de copia
# que provision_app: tar del repo (excluye node_modules/.git/.deploy/.env) → push
# → extraer sobre /opt/mainspot-platform → npm ci → typecheck → restart unit.
# ----------------------------------------------------------------------------
update_code() {
  ensure_container "$APP_CONTAINER"
  if [[ "$(lxc_state "$APP_CONTAINER")" != "Running" ]]; then
    die "$APP_CONTAINER no está Running"
  fi

  local tar_tmp
  tar_tmp="/tmp/mainspot-src-$$.tar.gz"
  tar -czf "$tar_tmp" --exclude='node_modules' --exclude='.git' --exclude='.deploy' --exclude='.env' -C "$REPO_ROOT" .
  lxc file push "$tar_tmp" "$APP_CONTAINER/tmp/mainspot-src.tar.gz" >/dev/null
  rm -f "$tar_tmp"

  log "extrayendo código en $APP_INSIDE_DIR + npm ci + typecheck..."
  lxc exec "$APP_CONTAINER" -- bash -c "cd $APP_INSIDE_DIR && tar -xzf /tmp/mainspot-src.tar.gz -C . && rm /tmp/mainspot-src.tar.gz && npm ci --no-audit --no-fund >/tmp/npm-ci.log 2>&1 && npm run typecheck >/tmp/typecheck.log 2>&1 && echo build_ok" \
    || die "npm ci/typecheck falló (ver: lxc exec $APP_CONTAINER -- cat /tmp/npm-ci.log; lxc exec $APP_CONTAINER -- cat /tmp/typecheck.log)"

  log "reiniciando mainspot.service..."
  lxc exec "$APP_CONTAINER" -- bash -c "systemctl restart mainspot.service && sleep 3 && systemctl is-active mainspot.service"
  wait_health
  log "--- update-code completo: $APP_INSIDE_DIR actualizado, mainspot.service reiniciado ---"
}

wait_health() {
  local url="http://127.0.0.1:$APP_HOST_LISTEN_PORT/health"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      log "health OK: $url"
      return 0
    fi
    sleep 3
  done
  die "la app no responde en $url"
}

destroy_all() {
  local n
  for n in "$APP_CONTAINER" "$DB_CONTAINER"; do
    if [[ -n "$(lxc_state "$n")" ]]; then
      log "destruyendo '$n'..."
      lxc delete -f "$n"
    fi
  done
  log "contenedores MainSpot destruidos. Secretos conservados en $SECRETS_FILE"
  log "para purgar también secretos: rm -rf '$SECRETS_DIR'"
}

# ----------------------------------------------------------------------------
trap 'rm -f "$APP_ENV_TMP"' EXIT

MODE="${1:-deploy}"
case "$MODE" in
  --destroy) source_overrides; require_cmds; destroy_all; exit 0 ;;
  --reset)   source_overrides; require_cmds; destroy_all ;;
  --update-code) source_overrides; require_cmds; ensure_secrets; update_code; exit 0 ;;
  --help|-h) usage; exit 0 ;;
esac

source_overrides
require_cmds
SECRETS_FILE="$SECRETS_DIR/mainspot-secrets.env"
APP_ENV_TMP="$SECRETS_DIR/.tmp-mainspot-app.env"
ensure_secrets

log "repo   : $REPO_ROOT"
log "red LXD: $(lxc network show lxdbr0 2>/dev/null | awk '/ipv4.address/{print $2}')"

ensure_container "$DB_CONTAINER"
ensure_container "$APP_CONTAINER"
provision_db
provision_app
ensure_proxy
wait_health

log "Despliegue convergente. URL: http://localhost:$APP_HOST_LISTEN_PORT"
log "Health: http://localhost:$APP_HOST_LISTEN_PORT/health"
