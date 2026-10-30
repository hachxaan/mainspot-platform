#!/usr/bin/env bash
# Provisión del sitio LOCAL de UN negocio (DEV-E2E-04 P3): https://<slug>.<LOCAL_SITE_DOMAIN>.
# Comando de OPERACIÓN con privilegios (sudo para /etc/hosts, lxc para el LXC webserver); NUNCA lo
# ejecuta el proceso web. Idempotente: repetirlo no duplica ni cambia lo ya instalado. Un sitio por
# ejecución; no toca el bootstrap de app.mainspot.local.io ni otros sitios del LXC.
#
#   scripts/client-site-provision.sh <slug>            # alta (hosts + certificado + vhost + registro)
#   scripts/client-site-provision.sh <slug> --renew    # además reemite el certificado y reescribe el vhost
#   scripts/client-site-provision.sh <slug> --remove   # baja controlada SOLO de ese sitio
#
# Pasos del alta:
#   0. El negocio (client_website.slug) debe existir en la BD de desarrollo (mainspot_dev).
#   1. /etc/hosts del HOST: línea explícita «10.209.99.101 <host>» (con copia de seguridad; nunca se
#      borran otras líneas; /etc/hosts no admite comodines).
#   2. Certificado para ese hostname exacto emitido por la CA local mkcert (ya confiable en el sistema
#      y en NSS de Chrome); se copia al LXC por `lxc exec … sh -c 'cat > …'` (snap lxc no lee /tmp),
#      clave 0600 solo en el LXC; la copia local se destruye con shred.
#   3. Vhost nginx desde scripts/deploy/client-site.conf.template (HTTP/1.1, sin http2; solo
#      10.209.99.1/127.0.0.1/::1), `nginx -t` y `systemctl reload nginx`.
#   4. Registro en BD (scripts/client-site-register.ts): «Mi página» muestra el estado sin que el
#      proceso web use sudo. 5. Comprobación HTTPS con TLS verificado (sin -k).
# Solo resolución local: ningún DNS público ni publicación en Internet.
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="${1:-}"
MODE="${2:-}"
LXC="${MAINSPOT_SITE_LXC:-webserver}"
LXC_IP="${MAINSPOT_SITE_LXC_IP:-10.209.99.101}"
SSL_DIR=/etc/nginx/ssl
TEMPLATE=scripts/deploy/client-site.conf.template

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "uso: $0 <slug> [--renew|--remove]  (slug: minúsculas, dígitos y guiones)"
case "$MODE" in ''|--renew|--remove) ;; *) die "opción desconocida: $MODE (usa --renew o --remove)";; esac
case "$SLUG" in app|www|api|panel|admin) die "«$SLUG» es una etiqueta reservada";; esac

# --- Entorno de la BD de desarrollo (mismas reglas que scripts/dev-panel.sh; la URL con password
#     viaja solo por el entorno heredado, nunca por argumentos). --------------------------------
set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
set +a
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET MAINSPOT_DEV_TELEGRAM
PG_PORT="${MAINSPOT_DEV_PG_PORT:-55432}"
DEV_DB="${MAINSPOT_DEV_DB:-mainspot_dev}"
DATABASE_URL="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.hostname="127.0.0.1";u.port=process.argv[1];u.pathname="/"+process.argv[2];console.log(u.toString())' "$PG_PORT" "$DEV_DB")"
export DATABASE_URL APP_ENV=development JEV_MODE=disabled
DOMAIN="${LOCAL_SITE_DOMAIN:-mainspot.local.io}"
[[ "$DOMAIN" = "mainspot.local.io" ]] || die "la provisión se limita al dominio local mainspot.local.io"
HOST="${SLUG}.${DOMAIN}"
HOST_RE="${HOST//./\\.}"

# 0. El negocio debe existir (slug único en client_website).
LOOKUP="$(node scripts/client-site-register.ts lookup --slug "$SLUG" --domain "$DOMAIN")" || die "el negocio «$SLUG» no existe en ${DEV_DB}"
say "negocio: $LOOKUP"

command -v lxc >/dev/null || die "falta lxc"
lxc exec "$LXC" -- test -d "$SSL_DIR" || die "el LXC ${LXC} no tiene ${SSL_DIR}"

if [ "$MODE" = "--remove" ]; then
  # Baja controlada SOLO de este sitio: hosts (solo la línea exacta), vhost, cert/clave.
  if grep -qE "^[[:space:]]*${LXC_IP//./\\.}[[:space:]]+${HOST_RE}([[:space:]]|$)" /etc/hosts; then
    sudo cp /etc/hosts "/etc/hosts.bak-mainspot-site-$(date +%Y%m%d%H%M%S)"
    sudo sed -i -E "/^[[:space:]]*${LXC_IP//./\\.}[[:space:]]+${HOST_RE}([[:space:]]|$)/d" /etc/hosts
    say "hosts: eliminada la línea de ${HOST}"
  else
    say "hosts: no había línea para ${HOST}"
  fi
  lxc exec "$LXC" -- sh -c "rm -f /etc/nginx/sites-enabled/${HOST}.conf /etc/nginx/sites-available/${HOST}.conf"
  lxc exec "$LXC" -- sh -c "if [ -e ${SSL_DIR}/${HOST}-key.pem ]; then (command -v shred >/dev/null && shred -u ${SSL_DIR}/${HOST}-key.pem) || rm -f ${SSL_DIR}/${HOST}-key.pem; fi; rm -f ${SSL_DIR}/${HOST}.pem"
  lxc exec "$LXC" -- nginx -t
  lxc exec "$LXC" -- systemctl reload nginx
  say "nginx: sitio ${HOST} eliminado y recargado"
  node scripts/client-site-register.ts set --slug "$SLUG" --domain "$DOMAIN" --status removed
  exit 0
fi

# 1. hosts (línea explícita; sin comodines; sin tocar otras líneas)
if grep -qE "^[[:space:]]*${LXC_IP//./\\.}[[:space:]]+${HOST_RE}([[:space:]]|$)" /etc/hosts; then
  say "hosts: ya existe ${LXC_IP} ${HOST}"
else
  sudo cp /etc/hosts "/etc/hosts.bak-mainspot-site-$(date +%Y%m%d%H%M%S)"
  echo "${LXC_IP} ${HOST}" | sudo tee -a /etc/hosts >/dev/null
  say "hosts: agregado ${LXC_IP} ${HOST}"
fi

# 2. certificado del hostname exacto (CA local mkcert); clave solo en el LXC
CERT_NOT_AFTER=""
if lxc exec "$LXC" -- test -s "${SSL_DIR}/${HOST}.pem" && [ "$MODE" != "--renew" ]; then
  say "tls: el certificado de ${HOST} ya existe en ${LXC}:${SSL_DIR} (usa --renew para reemitirlo)"
  CERT_NOT_AFTER="$(lxc exec "$LXC" -- openssl x509 -in "${SSL_DIR}/${HOST}.pem" -noout -enddate | cut -d= -f2)"
else
  command -v mkcert >/dev/null || die "falta mkcert"
  T=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/mainspot-site.XXXXXX")
  trap 'shred -u "$T"/*-key.pem 2>/dev/null || true; rm -rf "$T"' EXIT
  mkcert -cert-file "$T/${HOST}.pem" -key-file "$T/${HOST}-key.pem" "$HOST" >/dev/null 2>&1
  lxc exec "$LXC" -- sh -c "umask 022; cat > ${SSL_DIR}/${HOST}.pem" < "$T/${HOST}.pem"
  lxc exec "$LXC" -- sh -c "umask 077; cat > ${SSL_DIR}/${HOST}-key.pem && chmod 600 ${SSL_DIR}/${HOST}-key.pem" < "$T/${HOST}-key.pem"
  CERT_NOT_AFTER="$(openssl x509 -in "$T/${HOST}.pem" -noout -enddate | cut -d= -f2)"
  say "tls: certificado de ${HOST} emitido por la CA local e instalado en ${LXC} (caduca ${CERT_NOT_AFTER})"
fi
CERT_ISO="$(date -u -d "$CERT_NOT_AFTER" +%Y-%m-%dT%H:%M:%SZ)"

# 3. vhost propio (plantilla con el hostname exacto); solo se reescribe si cambia
RENDERED="$(sed "s/__HOST__/${HOST}/g" "$TEMPLATE")"
# Con --renew siempre se reescribe y recarga (el certificado cambió).
if lxc exec "$LXC" -- test -e "/etc/nginx/sites-enabled/${HOST}.conf" \
   && [ "$MODE" != "--renew" ] \
   && [ "$(lxc exec "$LXC" -- cat "/etc/nginx/sites-available/${HOST}.conf")" = "$RENDERED" ]; then
  say "nginx: el sitio ${HOST} ya está habilitado con la misma configuración"
else
  printf '%s\n' "$RENDERED" | lxc exec "$LXC" -- sh -c "cat > /etc/nginx/sites-available/${HOST}.conf"
  lxc exec "$LXC" -- ln -sfn "/etc/nginx/sites-available/${HOST}.conf" "/etc/nginx/sites-enabled/${HOST}.conf"
  lxc exec "$LXC" -- nginx -t
  lxc exec "$LXC" -- systemctl reload nginx
  say "nginx: sitio ${HOST} habilitado y recargado"
fi

# 4. Esperar a los nuevos workers de nginx; 404 es válido si aún no hay versión publicada.
# Cualquier fallo TLS o de conexión persistente aborta, no se disfraza de alta correcta.
curl --retry 5 --retry-all-errors --retry-delay 1 -sS -o /dev/null \
  -w "https://${HOST}/ → HTTP %{http_code} (TLS verify=%{ssl_verify_result})\n" "https://${HOST}/"

# 5. Registrar la provisión solo después de verificar HTTPS, sin -k.
node scripts/client-site-register.ts set --slug "$SLUG" --domain "$DOMAIN" --status provisioned --cert-not-after "$CERT_ISO"
