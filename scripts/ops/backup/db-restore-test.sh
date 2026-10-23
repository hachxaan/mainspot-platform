#!/usr/bin/env bash
# =============================================================================
# db-restore-test.sh — prueba mensual de restauración (DEC-0026 / DEC-0027)
#
# 1. Elige el respaldo cifrado más reciente de ${MAINSPOT_BACKUP_DIR}
#    (o --file) y verifica su .sha256.
# 2. Levanta un PostgreSQL 16 desechable en Docker (puerto aleatorio solo en
#    127.0.0.1, datos en tmpfs) — o usa una BD scratch existente (--target).
# 3. Descifra en streaming (sin texto en claro en disco) → pg_restore.
# 4. Consultas de sanidad: schema_migrations, conteo exacto por tabla.
# 5. Si existe scripts/retention-run.ts: `node scripts/retention-run.ts
#    --reapply-exits` contra la BD scratch (DATABASE_URL) para probar que los
#    tenants dados de baja no se reintroducen desde el respaldo (DEC-0027).
#    Si no existe, se omite con un mensaje explícito.
# 6. Elimina el contenedor y escribe un informe fechado en
#    ${MAINSPOT_BACKUP_DIR}/restore-tests/. Código de salida != 0 si falla algo.
#
# Uso: scripts/ops/backup/db-restore-test.sh [--file RUTA.dump.enc]
#        [--target URL_SCRATCH] [--image postgres:16] [--help]
#   --target  BD scratch VACÍA y desechable (postgres://usuario:pw@host:port/db).
#             Preferible vía env MAINSPOT_RESTORE_TARGET_URL (no queda en `ps`).
#             Nunca se imprime (se muestra redactada).
# Variables: MAINSPOT_BACKUP_DIR, MAINSPOT_BACKUP_KEY (mismas que db-backup.sh),
#            MAINSPOT_RESTORE_IMAGE (default postgres:16).
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BACKUP_DIR="${MAINSPOT_BACKUP_DIR:-$HOME/.local/share/mainspot/backups}"
KEY_FILE="${MAINSPOT_BACKUP_KEY:-$HOME/.config/mainspot/backup/backup.key}"
IMAGE="${MAINSPOT_RESTORE_IMAGE:-postgres:16}"
TARGET_URL="${MAINSPOT_RESTORE_TARGET_URL:-}"
DUMP_FILE=""
ENC_ARGS=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)   # = db-backup.sh
SCRATCH_DB="mainspot_restore"
RETENTION_SCRIPT="scripts/retention-run.ts"

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)   DUMP_FILE="${2:?--file requiere ruta}"; shift 2 ;;
    --target) TARGET_URL="${2:?--target requiere URL}"; shift 2 ;;
    --image)  IMAGE="${2:?--image requiere imagen}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "argumento desconocido: $1" >&2; usage >&2; exit 2 ;;
  esac
done

RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_DIR="$BACKUP_DIR/restore-tests"
REPORT_FILE="$REPORT_DIR/restore-test-${RUN_TS}.txt"
mkdir -p -m 700 "$REPORT_DIR"
REPORT_TMP="$(mktemp "$REPORT_DIR/.restore-test-${RUN_TS}.XXXXXX")"
CNAME=""
STATUS_REASON=""

log() { local l; l="$(date -u +%H:%M:%SZ) $*"; printf '%s\n' "$l"; printf '%s\n' "$l" >>"$REPORT_TMP"; }
fail() { STATUS_REASON="$*"; exit 1; }

on_exit() {
  local rc=$?
  if [[ -n "$CNAME" ]]; then
    docker rm -f -v "$CNAME" >/dev/null 2>&1 || true
    if [[ -z "$(docker ps -aq --filter "name=^${CNAME}\$")" ]]; then
      log "contenedor eliminado: $CNAME"
    else
      log "ERROR: el contenedor $CNAME sigue existiendo"; rc=1
    fi
  fi
  if [[ $rc -eq 0 ]]; then
    log "RESULTADO: OK"
  else
    log "RESULTADO: FALLO (rc=$rc) ${STATUS_REASON:-error inesperado; ver stderr}"
  fi
  chmod 600 "$REPORT_TMP" && mv -f -- "$REPORT_TMP" "$REPORT_FILE"
  printf 'informe: %s\n' "$REPORT_FILE"
  exit "$rc"
}
trap on_exit EXIT

redact_url() { printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'; }

log "== MainSpot — prueba de restauración (DEC-0026) run=$RUN_TS host=$(hostname) =="

for bin in openssl sha256sum docker; do
  command -v "$bin" >/dev/null 2>&1 || fail "falta binario requerido: $bin"
done

# --- clave ---------------------------------------------------------------------
[[ -f "$KEY_FILE" && ! -L "$KEY_FILE" ]] || fail "no existe la clave de respaldo ($KEY_FILE)"
[[ "$(stat -c %u "$KEY_FILE")" == "$(id -u)" ]] || fail "la clave no pertenece al usuario actual"
key_mode="$(stat -c %a "$KEY_FILE")"
(( (8#$key_mode & 8#177) == 0 )) || fail "permisos de la clave demasiado amplios ($key_mode)"

# --- respaldo + sha256 ---------------------------------------------------------
if [[ -z "$DUMP_FILE" ]]; then
  DUMP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'mainspot-db-*.dump.enc' -printf '%f\n' \
                | sort | tail -n 1)"
  [[ -n "$DUMP_FILE" ]] || fail "no hay respaldos en $BACKUP_DIR"
  DUMP_FILE="$BACKUP_DIR/$DUMP_FILE"
fi
[[ -f "$DUMP_FILE" ]] || fail "no existe $DUMP_FILE"
[[ -f "$DUMP_FILE.sha256" ]] || fail "falta $DUMP_FILE.sha256"
log "respaldo: $DUMP_FILE ($(stat -c %s "$DUMP_FILE") bytes, mtime $(date -u -r "$DUMP_FILE" +%Y-%m-%dT%H:%M:%SZ))"
( cd "$(dirname "$DUMP_FILE")" && sha256sum --strict -c -- "$(basename "$DUMP_FILE").sha256" ) >>"$REPORT_TMP" 2>&1 \
  || fail "verificación sha256 FALLIDA"
log "sha256 verificado: $(cut -d' ' -f1 "$DUMP_FILE.sha256")"

decrypt() { openssl enc -d "${ENC_ARGS[@]}" -pass "file:$KEY_FILE" <"$DUMP_FILE"; }

# --- destino scratch -----------------------------------------------------------
export TARGET_URL
if [[ -n "$TARGET_URL" ]]; then
  log "destino: BD scratch existente $(redact_url "$TARGET_URL")"
  DB_URL="$TARGET_URL"
  pg_tool() { # herramientas cliente de $IMAGE contra la URL (no aparece en argv)
    local tool="$1"; shift
    docker run --rm -i --network host -e TARGET_URL "$IMAGE" \
      sh -c 'tool="$1"; shift; exec "$tool" -d "$TARGET_URL" "$@"' sh "$tool" "$@"
  }
else
  CNAME="msp-restore-test-$(printf '%s' "$RUN_TS" | tr 'A-Z' 'a-z')"
  SCRATCH_PW="$(openssl rand -hex 24)"
  POSTGRES_PASSWORD="$SCRATCH_PW" docker run -d --name "$CNAME" \
    --label mainspot.restore-test=1 \
    -e POSTGRES_PASSWORD -e POSTGRES_DB="$SCRATCH_DB" \
    --tmpfs /var/lib/postgresql/data:rw \
    -p 127.0.0.1::5432 "$IMAGE" >/dev/null || fail "no pude arrancar el contenedor $IMAGE"
  log "contenedor: $CNAME ($IMAGE, datos en tmpfs)"
  ready=0
  for _ in $(seq 1 90); do
    init_logs="$(docker logs "$CNAME" 2>&1 || true)"
    if [[ "$init_logs" == *'PostgreSQL init process complete'* ]] \
       && docker exec "$CNAME" pg_isready -q -U postgres -d "$SCRATCH_DB" >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 1
  done
  [[ $ready -eq 1 ]] || fail "PostgreSQL desechable no quedó listo en 90 s"
  host_port="$(docker port "$CNAME" 5432/tcp)"
  host_port="${host_port%%$'\n'*}"
  port="${host_port##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || fail "no pude resolver el puerto publicado"
  log "PostgreSQL listo en 127.0.0.1:$port (puerto aleatorio) — $(docker exec "$CNAME" postgres --version)"
  DB_URL="postgres://postgres:${SCRATCH_PW}@127.0.0.1:${port}/${SCRATCH_DB}"
  pg_tool() {
    local tool="$1"; shift
    docker exec -i "$CNAME" "$tool" -U postgres -d "$SCRATCH_DB" "$@"
  }
fi

psql_q() { pg_tool psql -X -A -t -q -v ON_ERROR_STOP=1 -c "$1"; }

# --- restauración ----------------------------------------------------------------
existing="$(psql_q "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" \
  || fail "no pude conectar con la BD scratch"
[[ "$existing" == "0" ]] || fail "la BD scratch no está vacía ($existing tablas en public)"

restore_start=$(date +%s)
if ! decrypt | pg_tool pg_restore --no-owner --no-privileges --exit-on-error >>"$REPORT_TMP" 2>&1; then
  fail "descifrado/pg_restore falló (ver informe)"
fi
log "pg_restore OK en $(( $(date +%s) - restore_start )) s (--no-owner --no-privileges --exit-on-error)"

# --- sanidad -----------------------------------------------------------------------
COUNTS_SQL="SELECT t.tablename || '=' || (xpath('/row/c/text()',
  query_to_xml(format('SELECT count(*) AS c FROM %I.%I', t.schemaname, t.tablename), false, true, '')))[1]::text
  FROM pg_tables t WHERE t.schemaname = 'public' ORDER BY t.tablename"

sanity() { # $1 = etiqueta
  local mig last tables counts
  mig="$(psql_q "SELECT count(*) FROM schema_migrations")" || fail "schema_migrations ilegible"
  [[ "$mig" =~ ^[0-9]+$ && "$mig" -gt 0 ]] || fail "schema_migrations vacía"
  last="$(psql_q "SELECT max(file) FROM schema_migrations")"
  tables="$(psql_q "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
  counts="$(psql_q "$COUNTS_SQL")" || fail "conteo por tabla falló"
  log "[$1] schema_migrations=$mig (última: $last; repo: $(find "$REPO_DIR/migrations" -maxdepth 1 -name '*.sql' | wc -l) archivos) tablas_public=$tables"
  log "[$1] filas por tabla: $(printf '%s' "$counts" | tr '\n' ' ')"
}
sanity "restaurado"

# --- re-aplicación de bajas (DEC-0027) ---------------------------------------------
if [[ -f "$REPO_DIR/$RETENTION_SCRIPT" ]]; then
  command -v node >/dev/null 2>&1 || fail "node no está en PATH (requerido por $RETENTION_SCRIPT)"
  log "ejecutando: DATABASE_URL=<scratch> node $RETENTION_SCRIPT --reapply-exits"
  if ! ( cd "$REPO_DIR" && DATABASE_URL="$DB_URL" node "$RETENTION_SCRIPT" --reapply-exits ) >>"$REPORT_TMP" 2>&1; then
    fail "$RETENTION_SCRIPT --reapply-exits falló (ver informe)"
  fi
  log "re-aplicación de bajas OK"
  sanity "tras-reapply-exits"
else
  log "OMITIDO: $RETENTION_SCRIPT no existe todavía en el repo; no se verificó la re-aplicación de bajas (DEC-0027)."
fi
