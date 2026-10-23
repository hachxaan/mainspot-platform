#!/usr/bin/env bash
# =============================================================================
# db-backup.sh — respaldo diario cifrado de la BD de MainSpot (DEC-0026)
#
# Se ejecuta en el HOST (no dentro de los contenedores):
#   lxc exec mainspot-db -- pg_dump -Fc <DB>  ──▶ openssl (AES-256, en streaming)
#   ──▶ ${MAINSPOT_BACKUP_DIR}/mainspot-db-<UTC>.dump.enc (+ .sha256)
#
# - El volcado en claro NUNCA toca disco: se cifra en el pipe.
# - Escritura atómica (temporal + mv) y verificación del flujo cifrado
#   (descifrado en memoria → pg_restore --list) antes de publicarlo.
# - Retención: borra respaldos cifrados con más de 14 días (DEC-0026), solo
#   después de un respaldo correcto.
# - Una línea de log por ejecución (stdout + ${MAINSPOT_BACKUP_DIR}/backup.log).
# - Clave simétrica: ~/.config/mainspot/backup/backup.key (0600). Se genera con
#   `openssl rand` si falta. Nunca se imprime. Se rechaza si sus permisos son
#   más amplios que 0600.
#
# Uso: scripts/ops/backup/db-backup.sh [--help]
# Variables (no secretas, opcionales):
#   MAINSPOT_BACKUP_DIR   destino           (default ~/.local/share/mainspot/backups)
#   MAINSPOT_BACKUP_KEY   archivo de clave  (default ~/.config/mainspot/backup/backup.key)
#   BACKUP_RETENTION_DAYS días de retención (default 14, DEC-0026)
#   DB_CONTAINER / DB_NAME  (defaults de deploy-lxd.sh: mainspot-db / mainspot)
# =============================================================================
set -euo pipefail
umask 077

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
[[ $# -eq 0 ]] || { echo "uso: $0 [--help]" >&2; exit 2; }

# Defaults alineados con scripts/deploy/deploy-lxd.sh
DB_CONTAINER="${DB_CONTAINER:-mainspot-db}"
DB_NAME="${DB_NAME:-mainspot}"
BACKUP_DIR="${MAINSPOT_BACKUP_DIR:-$HOME/.local/share/mainspot/backups}"
KEY_DIR="$HOME/.config/mainspot/backup"
KEY_FILE="${MAINSPOT_BACKUP_KEY:-$KEY_DIR/backup.key}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
# Parámetros de cifrado (db-restore-test.sh usa los mismos).
ENC_ARGS=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)

LOG_FILE="$BACKUP_DIR/backup.log"
STARTED_EPOCH="$(date -u +%s)"
RESULT_MSG=""
TMP_FILE=""

emit() { # una sola línea por ejecución
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) db-backup $1"
  printf '%s\n' "$line"
  if [[ -d "$BACKUP_DIR" ]]; then printf '%s\n' "$line" >>"$LOG_FILE" || true; fi
}

fail() { RESULT_MSG="$*"; exit 1; }

on_exit() {
  local rc=$?
  [[ -n "$TMP_FILE" && -e "$TMP_FILE" ]] && rm -f -- "$TMP_FILE"
  local dur=$(( $(date -u +%s) - STARTED_EPOCH ))
  if [[ $rc -eq 0 ]]; then
    emit "status=OK ${RESULT_MSG} duration_s=${dur}"
  else
    emit "status=FAIL rc=${rc} reason=\"${RESULT_MSG:-error inesperado (ver stderr)}\" duration_s=${dur}"
  fi
}
trap on_exit EXIT

for bin in lxc openssl sha256sum flock find stat; do
  command -v "$bin" >/dev/null 2>&1 || fail "falta binario requerido: $bin"
done
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$RETENTION_DAYS" -ge 1 ]] || fail "BACKUP_RETENTION_DAYS inválido"

mkdir -p -m 700 "$BACKUP_DIR" || fail "no pude crear $BACKUP_DIR"

# --- clave simétrica -----------------------------------------------------------
if [[ ! -e "$KEY_FILE" ]]; then
  mkdir -p -m 700 "$(dirname "$KEY_FILE")" || fail "no pude crear el directorio de la clave"
  chmod 700 "$(dirname "$KEY_FILE")"
  ( umask 077; openssl rand -base64 48 >"$KEY_FILE.tmp.$$" ) || fail "openssl rand falló"
  chmod 600 "$KEY_FILE.tmp.$$"
  mv -f -- "$KEY_FILE.tmp.$$" "$KEY_FILE"
fi
[[ -f "$KEY_FILE" && ! -L "$KEY_FILE" ]] || fail "la clave no es un archivo regular: $KEY_FILE"
[[ "$(stat -c %u "$KEY_FILE")" == "$(id -u)" ]] || fail "la clave no pertenece al usuario actual"
key_mode="$(stat -c %a "$KEY_FILE")"
(( (8#$key_mode & 8#177) == 0 )) || fail "permisos de la clave demasiado amplios ($key_mode); se exige 0600 o más restrictivo"
[[ -s "$KEY_FILE" ]] || fail "la clave está vacía"

# --- exclusión mutua -----------------------------------------------------------
exec 9>"$BACKUP_DIR/.db-backup.lock"
flock -n 9 || fail "otra ejecución de db-backup.sh está en curso"

# --- volcado + cifrado en streaming (escritura atómica) ------------------------
lxc info "$DB_CONTAINER" >/dev/null 2>&1 || fail "contenedor $DB_CONTAINER no disponible"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
name="mainspot-db-${ts}.dump.enc"
final="$BACKUP_DIR/$name"
TMP_FILE="$(mktemp "$BACKUP_DIR/.${name}.tmp.XXXXXX")"

if ! lxc exec "$DB_CONTAINER" --mode=non-interactive -- \
      sudo -u postgres pg_dump -Fc --no-password -d "$DB_NAME" </dev/null \
    | openssl enc -e "${ENC_ARGS[@]}" -salt -pass "file:$KEY_FILE" >"$TMP_FILE"; then
  fail "pg_dump/cifrado falló"
fi
[[ -s "$TMP_FILE" ]] || fail "respaldo cifrado vacío"

# Verificación: descifrar en memoria y listar el TOC (no escribe texto en claro).
if command -v pg_restore >/dev/null 2>&1; then
  toc_entries="$(openssl enc -d "${ENC_ARGS[@]}" -pass "file:$KEY_FILE" <"$TMP_FILE" \
                  | pg_restore --list | grep -cv '^;')" || fail "verificación (descifrado + pg_restore --list) falló"
  [[ "$toc_entries" -gt 0 ]] || fail "TOC del volcado vacío"
else
  toc_entries="n/a"
fi

chmod 600 "$TMP_FILE"
mv -f -- "$TMP_FILE" "$final"
TMP_FILE=""
( cd "$BACKUP_DIR" && sha256sum -- "$name" >".${name}.sha256.tmp" && mv -f -- ".${name}.sha256.tmp" "${name}.sha256" ) \
  || fail "no pude escribir ${name}.sha256"
chmod 600 "$final.sha256"
size="$(stat -c %s "$final")"
sha="$(cut -d' ' -f1 "$final.sha256")"

# --- retención (DEC-0026): >RETENTION_DAYS días --------------------------------
pruned=0
while IFS= read -r -d '' old; do
  rm -f -- "$old" "$old.sha256"
  pruned=$((pruned + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'mainspot-db-*.dump.enc' \
           -mmin "+$((RETENTION_DAYS * 24 * 60))" -print0)
# temporales huérfanos de ejecuciones abortadas (>1 día)
find "$BACKUP_DIR" -maxdepth 1 -type f -name '.mainspot-db-*.tmp*' -mmin +1440 -delete 2>/dev/null || true
# .sha256 sin su respaldo
for s in "$BACKUP_DIR"/mainspot-db-*.dump.enc.sha256; do
  if [[ -e "$s" && ! -e "${s%.sha256}" ]]; then rm -f -- "$s"; fi
done
kept="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'mainspot-db-*.dump.enc' | wc -l)"

RESULT_MSG="file=${final} size_bytes=${size} sha256=${sha} toc_entries=${toc_entries} pruned=${pruned} kept=${kept} retention_days=${RETENTION_DAYS}"
