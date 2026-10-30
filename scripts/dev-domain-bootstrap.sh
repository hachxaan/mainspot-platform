#!/usr/bin/env bash
# BOOTSTRAP ÚNICO del dominio de desarrollo https://app.mainspot.local.io (instalación inicial o
# máquina nueva). NO forma parte del arranque diario: scripts/dev-panel.sh no lo llama ni verifica
# nada de esto. Ejecutado el 2026-10-30 (evidencia: evidence/dev-domain-bootstrap.txt).
#
#   scripts/dev-domain-bootstrap.sh            # instala lo que falte; no toca lo ya instalado
#   scripts/dev-domain-bootstrap.sh --renew    # además reemite el certificado (p. ej. al caducar)
#
# Pasos:
#   1. /etc/hosts del host: 10.209.99.101 app.mainspot.local.io (sudo).
#   2. Certificado del dominio emitido por la CA local mkcert del host (ya confiable en el almacén
#      del sistema y en NSS de Chrome; si falta, `mkcert -install`). Solo el LXC guarda la clave.
#   3. Virtual host HTTPS en nginx del LXC webserver (scripts/deploy/app.mainspot.local.io.conf):
#      proxy a Express en el host 10.209.99.1:3100 (IP del host en lxdbr0; 127.0.0.1 del LXC no es el
#      host). Solo se agrega este sitio; no se modifican otros.
#   4. Comprobación única: HTTPS con TLS verificado y /health a través del proxy.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN=app.mainspot.local.io
LXC=webserver
LXC_IP=10.209.99.101
SSL_DIR=/etc/nginx/ssl
VHOST=scripts/deploy/${DOMAIN}.conf
RENEW=${1:-}

say() { printf '%s\n' "$*"; }

# 1. hosts
if grep -qE "^[[:space:]]*${LXC_IP//./\\.}[[:space:]]+${DOMAIN//./\\.}([[:space:]]|$)" /etc/hosts; then
  say "hosts: ya existe ${LXC_IP} ${DOMAIN}"
else
  sudo cp /etc/hosts "/etc/hosts.bak-mainspot-domain-$(date +%Y%m%d%H%M%S)"
  echo "${LXC_IP} ${DOMAIN}" | sudo tee -a /etc/hosts >/dev/null
  say "hosts: agregado ${LXC_IP} ${DOMAIN}"
fi

# 2. certificado (CA local mkcert)
if lxc exec "$LXC" -- test -s "${SSL_DIR}/${DOMAIN}.pem" && [ "$RENEW" != "--renew" ]; then
  say "tls: el certificado ya existe en ${LXC}:${SSL_DIR} (usa --renew para reemitirlo)"
else
  command -v mkcert >/dev/null || { say "falta mkcert"; exit 1; }
  mkcert -install >/dev/null 2>&1 || true   # idempotente: CA local en sistema y NSS
  T=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/mainspot-tls.XXXXXX")
  trap 'shred -u "$T"/*-key.pem 2>/dev/null || true; rm -rf "$T"' EXIT
  mkcert -cert-file "$T/${DOMAIN}.pem" -key-file "$T/${DOMAIN}-key.pem" "$DOMAIN" >/dev/null 2>&1
  lxc exec "$LXC" -- sh -c "umask 022; cat > ${SSL_DIR}/${DOMAIN}.pem" < "$T/${DOMAIN}.pem"
  lxc exec "$LXC" -- sh -c "umask 077; cat > ${SSL_DIR}/${DOMAIN}-key.pem" < "$T/${DOMAIN}-key.pem"
  say "tls: certificado emitido por la CA local e instalado en ${LXC} ($(openssl x509 -in "$T/${DOMAIN}.pem" -noout -enddate))"
fi

# 3. virtual host
if lxc exec "$LXC" -- test -e "/etc/nginx/sites-enabled/${DOMAIN}.conf" && [ "$RENEW" != "--renew" ]; then
  say "nginx: el sitio ${DOMAIN} ya está habilitado"
else
  lxc exec "$LXC" -- sh -c "cat > /etc/nginx/sites-available/${DOMAIN}.conf" < "$VHOST"
  lxc exec "$LXC" -- ln -sfn "/etc/nginx/sites-available/${DOMAIN}.conf" "/etc/nginx/sites-enabled/${DOMAIN}.conf"
  lxc exec "$LXC" -- nginx -t
  lxc exec "$LXC" -- systemctl reload nginx
  say "nginx: sitio ${DOMAIN} habilitado y recargado"
fi
[ "$RENEW" = "--renew" ] && lxc exec "$LXC" -- systemctl reload nginx

# 4. comprobación única (requiere MainSpot arrancado: scripts/dev-panel.sh)
curl -fsS -o /dev/null -w "https://${DOMAIN}/health → %{http_code} (TLS verify=%{ssl_verify_result})\n" "https://${DOMAIN}/health" \
  || say "aviso: el proxy responde pero MainSpot no está arrancado (scripts/dev-panel.sh)"
