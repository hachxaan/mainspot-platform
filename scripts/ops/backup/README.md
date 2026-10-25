# Respaldos de la BD de MainSpot (DEC-0026 / DEC-0027)

Implementa la política de respaldos aprobada:

- **DEC-0026**: respaldo **diario**, **cifrado**, conservado **14 días**, con
  **prueba de restauración mensual**.
- **DEC-0027**: «Los respaldos deberán cumplir su propia política de expiración y
  evitar la reintroducción operativa de datos dados de baja». La expiración la
  aplica `db-backup.sh` (borra respaldos > 14 días); la no-reintroducción se
  prueba en `db-restore-test.sh` re-aplicando las bajas sobre la copia restaurada
  (`scripts/retention-run.ts --reapply-exits`; ver README principal §10.1).

Todo corre en el **host** (usuario `administrador`), no dentro de los contenedores LXD.

| Archivo | Función |
|---|---|
| `db-backup.sh` | `lxc exec mainspot-db -- sudo -u postgres pg_dump -Fc mainspot` → cifrado en streaming → `mainspot-db-<UTC>.dump.enc` + `.sha256`; poda > 14 días; 1 línea de log por ejecución |
| `db-restore-test.sh` | verifica sha256, descifra el respaldo más reciente en un PostgreSQL 16 desechable (Docker) y ejecuta consultas de sanidad + re-aplicación de bajas; informe fechado |
| `systemd/mainspot-db-backup.{service,timer}` | timer de usuario diario 03:15 (hora local, `Persistent=true`) |
| `systemd/mainspot-db-restore-test.{service,timer}` | timer de usuario mensual: primer domingo 04:00 (hora local, `Persistent=true`) |
| `db-backup-remote.py` | **productor remoto, desactivado por defecto** (contrato `backup-object-storage` v1 §8): copia el `.dump.enc` + manifiesto a Garage S3, verifica, comprueba §10.1; sin `remote.env` termina `status=DISABLED` sin tocar la red |
| `systemd/mainspot-db-backup-remote.{service,timer}` | timer de usuario horario (minuto 20) para el productor remoto; **no instalado ni habilitado** |

## Ubicaciones y permisos

| Qué | Ruta (default) | Permisos |
|---|---|---|
| Clave simétrica | `~/.config/mainspot/backup/backup.key` (override `MAINSPOT_BACKUP_KEY`) | dir 0700, archivo 0600 |
| Respaldos cifrados | `${MAINSPOT_BACKUP_DIR:-~/.local/share/mainspot/backups}/mainspot-db-<YYYYMMDDTHHMMSSZ>.dump.enc` | dir 0700, archivos 0600 |
| Checksum | `<respaldo>.sha256` (formato `sha256sum`, nombre relativo) | 0600 |
| Log de respaldos | `${MAINSPOT_BACKUP_DIR}/backup.log` (una línea por ejecución; también a stdout/journal) | 0600 |
| Informes de restauración | `${MAINSPOT_BACKUP_DIR}/restore-tests/restore-test-<UTC>.txt` | dir 0700, archivos 0600 |
| Configuración del productor remoto (no existe hoy) | `~/.config/mainspot/backup/remote.env` (override `MAINSPOT_REMOTE_CONFIG`) | 0600 (se rechaza si es más amplio) |
| Log del productor remoto | `${MAINSPOT_BACKUP_DIR}/backup-remote.log` (una línea por respaldo; también a stdout/journal) | 0600 |

Defaults de BD tomados de `scripts/deploy/deploy-lxd.sh`: contenedor `mainspot-db`,
base `mainspot` (overrides `DB_CONTAINER`, `DB_NAME`). El volcado usa el rol
`postgres` por peer auth dentro del contenedor: **no** requiere ni lee ningún password.

## Cifrado

- `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt -pass file:<clave>`
  (OpenSSL 3). La clave (`openssl rand -base64 48`) se genera en la primera
  ejecución si no existe y **nunca se imprime**.
- El volcado en claro **nunca toca disco**: `pg_dump` → `openssl` por pipe; en la
  restauración, `openssl -d` → `pg_restore` por pipe, y el PostgreSQL desechable
  guarda sus datos en `tmpfs` (RAM).
- `openssl enc` no es AEAD: la integridad la garantiza el `.sha256` (verificado
  antes de restaurar) y la verificación del TOC (`pg_restore --list`) sobre el
  flujo descifrado antes de publicar cada respaldo.
- **Custodia de la clave**: sin `backup.key` los respaldos son irrecuperables.
  Guardar una copia de la clave fuera del host (gestor de secretos / bóveda
  offline). Rotar la clave implica que los respaldos previos sigan necesitando la
  clave anterior hasta que expiren (≤ 14 días).
- Ambos scripts se niegan a ejecutarse si la clave no pertenece al usuario o tiene
  permisos más amplios que 0600.

## `db-backup.sh`

```bash
scripts/ops/backup/db-backup.sh            # ejecución manual
scripts/ops/backup/db-backup.sh --help
```

1. Comprueba binarios (`lxc`, `openssl`, `sha256sum`, `flock`…), crea dirs 0700,
   genera/valida la clave, toma un `flock` (no hay ejecuciones solapadas).
2. `pg_dump -Fc` cifrado en streaming a un temporal oculto en el mismo directorio.
3. Verifica: archivo no vacío + descifrado en memoria → `pg_restore --list` con > 0
   entradas (si `pg_restore` está en el host).
4. `mv` atómico al nombre final y escribe `.sha256` (también temp + `mv`).
5. Retención: borra `mainspot-db-*.dump.enc` (+ su `.sha256`) con mtime > 14 días
   (`BACKUP_RETENTION_DAYS`, default 14) **solo tras un respaldo correcto**, además
   de temporales huérfanos (> 1 día) y `.sha256` sin respaldo.
6. Emite una línea `status=OK file=… size_bytes=… sha256=… toc_entries=… pruned=… kept=…`
   o `status=FAIL rc=… reason="…"`; código de salida ≠ 0 en cualquier fallo.

## `db-restore-test.sh`

```bash
scripts/ops/backup/db-restore-test.sh                       # último respaldo, Docker postgres:16 desechable
scripts/ops/backup/db-restore-test.sh --file <ruta>.dump.enc
MAINSPOT_RESTORE_TARGET_URL='postgres://…/scratch' scripts/ops/backup/db-restore-test.sh   # BD scratch existente (vacía)
scripts/ops/backup/db-restore-test.sh --help
```

1. Valida la clave, elige el respaldo más reciente (orden por timestamp UTC del
   nombre) y ejecuta `sha256sum --strict -c`.
2. Sin `--target`: `docker run postgres:16` con nombre `msp-restore-test-<ts>`,
   etiqueta `mainspot.restore-test=1`, datos en `tmpfs`, password aleatorio
   (vía entorno, nunca impreso) y puerto **aleatorio asignado por Docker solo en
   127.0.0.1** (no toca `msp-test-pg` ni 127.0.0.1:55433). Con `--target` /
   `MAINSPOT_RESTORE_TARGET_URL` usa esa BD scratch (debe estar vacía; la URL se
   muestra redactada y se pasa a los clientes por entorno, no por argv).
3. Descifrado en streaming → `pg_restore --no-owner --no-privileges --exit-on-error`.
4. Sanidad: `schema_migrations` > 0 (con última migración vs. nº de archivos en
   `migrations/`), número de tablas en `public` y `count(*)` exacto por tabla.
5. Si existe `scripts/retention-run.ts`: `DATABASE_URL=<scratch> node scripts/retention-run.ts --reapply-exits`
   (salida al informe; fallo ⇒ exit ≠ 0) y repite la sanidad. Si no existe, lo
   indica explícitamente con `OMITIDO:` en la salida y el informe. El script usa
   solo `DATABASE_URL`, vuelve a anonimizar los tenants del registro
   `anonymized_tenant` de la copia y devuelve ≠ 0 si alguno no se puede anonimizar.
6. `trap EXIT`: `docker rm -f -v` del contenedor y comprobación de que ya no
   existe; escribe el informe (`RESULTADO: OK` / `RESULTADO: FALLO …`) incluso si
   falla.

## Instalación de los timers (no se instalan solos; en este host habilitados el 2026-10-22, ver §8)

Las unidades son de **usuario** (`administrador`; el usuario ya tiene
`Linger=yes`, así que corren sin sesión abierta). Rutas absolutas al repo en
`/home/administrador/codeart/mainspoot/mainspot-platform`; si el repo se mueve o
cambia la versión de Node de nvm, ajustar `WorkingDirectory`, `ExecStart` y
`Environment=PATH` antes de instalar.

```bash
mkdir -p ~/.config/systemd/user
cp scripts/ops/backup/systemd/mainspot-db-*.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mainspot-db-backup.timer mainspot-db-restore-test.timer
systemctl --user list-timers 'mainspot-db-*'
# ejecución manual / logs
systemctl --user start mainspot-db-backup.service
journalctl --user -u mainspot-db-backup.service -u mainspot-db-restore-test.service -n 50
# deshabilitar
systemctl --user disable --now mainspot-db-backup.timer mainspot-db-restore-test.timer
```

Calendarios (`systemd-analyze calendar`): `*-*-* 03:15:00` (diario) y
`Sun *-*-01..07 04:00:00` (primer domingo del mes; próximo: 2026-11-01 04:00 EST).

## Copia remota (Garage S3): contrato, no activada

El contrato de integración con el servicio S3 de respaldos (Garage en Hostinger
KVM 4, `https://s3.mainspot.canonflow.dev`, bucket `mainspot-backups`) está en
[`docs/contracts/backup-object-storage/v1/CONTRACT.md`](../../../docs/contracts/backup-object-storage/v1/CONTRACT.md),
publicado en GitHub en la rama `contract/backup-object-storage-v1`, commit
`21537dee08bd439df823f350c87d17d754da17a6`. Copia el mismo `.dump.enc` que produce
`db-backup.sh`, sin transformarlo, más un manifiesto con MAC. Estos scripts **no
cambian** y la transferencia remota **no está activada**: espera las decisiones de
QS-0010 y QS-0011, un informe de conformidad del servicio real, el productor
implementado y probado (sección siguiente) y la aprobación explícita del propietario
(§2.3 del contrato; DEC-0047 exige además la copia protegida antes de activar).

## Productor remoto (no activado)

`db-backup-remote.py` implementa el productor de §8 del contrato (Python 3.10+,
`boto3` ≥ 1.36; importa por ruta `docs/contracts/backup-object-storage/v1/reference/manifest_tool.py`
para `key_id`, MAC, claves de objeto y validación del manifiesto). **No está activado:**
sin el archivo de configuración, o con `MAINSPOT_REMOTE_BACKUP_ENABLED` distinto
de `1`, termina con `status=DISABLED`, código 0, sin crear ningún cliente S3 ni leer
la clave de cifrado (verificado con `strace -e trace=network`: 0 llamadas de red).
Las unidades `systemd/mainspot-db-backup-remote.{service,timer}` existen pero **no se
instalan ni se habilitan** (DEC-0047 / DEC-0049 §7): instalarlas es parte de la puerta
de activación, no de este cambio.

```bash
scripts/ops/backup/db-backup-remote.py               # DISABLED mientras no exista remote.env con ENABLED=1
scripts/ops/backup/db-backup-remote.py --check-only  # solo la comprobación diaria (§10.1)
scripts/ops/backup/db-backup-remote.py --dry-run     # todo salvo las escrituras remotas
scripts/ops/backup/db-backup-remote.py --help
```

### Configuración (`~/.config/mainspot/backup/remote.env`, 0600; ruta en `MAINSPOT_REMOTE_CONFIG`)

| Clave | Valor |
|---|---|
| `MAINSPOT_REMOTE_BACKUP_ENABLED` | `1` activa; ausente o cualquier otro valor = desactivado |
| `S3_ENDPOINT` | `https://s3.mainspot.canonflow.dev` (debe ser `https://`; `--lab-allow-http` solo en laboratorio) |
| `S3_REGION` / `S3_BUCKET` | `garage` / `mainspot-backups` |
| `DEPLOYMENT_ID` / `DATABASE` | `mainspot-pilot` / `mainspot` (§7.2) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | credencial `mainspot-backup-writer` (formato de §6.4; el productor no admite el formato `S3_*` de la conformidad) |
| `MAINSPOT_BACKUP_DIR`, `MAINSPOT_BACKUP_KEY` | opcionales; el entorno tiene prioridad (mismos defaults que `db-backup.sh`) |

La clave `backup.key` se lee **solo** para derivar `key_id` y el MAC del manifiesto
(§7.4); nunca se imprime, se registra ni se envía. Las credenciales nunca pasan por
argumentos ni por el registro. El archivo se rechaza si sus permisos superan 0600.

### Comportamiento (referencias al contrato)

0. Límite de tamaño (contrato 1.2.0 §8.2 paso 0; DEC-0059, DEC-0061, DEC-0063), **antes de
   cualquier operación S3**: para cada respaldo de la ventana de 24 h se comprueba el
   `.sha256`, se construye el manifiesto exacto que se subiría y, si `objeto + manifiesto`
   supera 1 GiB (1 073 741 824 B, inclusivo) ⇒ `status=FAIL error=E-SIZE-LIMIT
   action=size-rejected attempts=0`, aviso inmediato (`status=ALERT`, evento JSON en
   `${MAINSPOT_BACKUP_DIR}/remote-alerts.jsonl` 0600 y, si está configurado, el adaptador
   `MAINSPOT_REMOTE_ALERT_COMMAND` con el JSON por stdin, entorno mínimo, 30 s) y marca en
   `${MAINSPOT_BACKUP_DIR}/.remote-size-rejected/<backup_id>.json` (tamaño, mtime, límite).
   Las ejecuciones siguientes registran `SKIPPED error=E-SIZE-LIMIT` sin releer ni avisar
   mientras el archivo no cambie; el respaldo local y su `.sha256` nunca se tocan; los
   demás respaldos se procesan y §10.1 sigue avisando (`E-FRESHNESS`). Un respaldo subido
   por encima del 80 % del máximo genera un aviso `SIZE-OVER-80PCT` (revalidar S-13).
   `MAINSPOT_REMOTE_LAB_MAX_BACKUP_BYTES` (entorno) solo baja el límite para laboratorio;
   inválido o > 1 GiB ⇒ `E-CONFIG` sin contactar con S3. El canal externo es el bot de
   Telegram exclusivo de DEC-0064, con el adaptador de la sección «Avisos por Telegram».
1. `HeadBucket` y medición del reloj con la cabecera `Date` de la primera respuesta:
   > 300 s ⇒ `E-AUTH-SKEW` y se detiene (§6.5).
2. Por cada `mainspot-db-*.dump.enc` local con `.sha256`, del más nuevo al más antiguo
   (§8.2): `.sha256` ≠ archivo ⇒ `E-LOCAL-INTEGRITY`; `GetObject` del manifiesto:
   existe y es válido frente al archivo local (§5.3 reglas 1–5, MAC con la clave,
   `HeadObject` con `x-amz-checksum-mode`) ⇒ completo (`OK action=already-complete`
   dentro de la ventana; sin línea fuera de ella), no se toca; difiere o falta el objeto
   ⇒ `E-REMOTE-CONFLICT`, no se toca nada (también fuera de la ventana de 24 h, mientras
   el respaldo siga en local). Sin manifiesto remoto: dentro de la ventana de 24 h (edad
   desde `created_at` del `backup_id`) ⇒ subir; fuera ⇒ `SKIPPED error=E-UPLOAD-WINDOW`.
3. Subida (§8.4): `PutObject` con `Content-Type: application/octet-stream`,
   `Content-MD5`, `x-amz-checksum-sha256`, `x-amz-meta-sha256`, `x-amz-meta-backup-id`,
   cuerpo firmado (`x-amz-content-sha256`), sin trailers
   (`request_checksum_calculation = when_required`). Más de 256 MiB ⇒ multiparte con
   partes de 64 MiB y `Content-MD5` por parte; `AbortMultipartUpload` si falla (§8.5).
   `InvalidDigest`/`BadDigest`: un solo reintento tras releer y comprobar el archivo
   local; después `E-INTEGRITY-UPLOAD`.
4. Verificación (§8.3): `HeadObject` (`Content-Length` y `x-amz-checksum-sha256`) y
   `GetObject` completo con SHA-256. Si falla ⇒ `E-INTEGRITY-VERIFY` y **no** se escribe
   el manifiesto (el objeto incompleto se vuelve a subir en la siguiente ejecución).
5. Manifiesto (`manifest_tool.build_manifest`) con `Content-Type: application/json`,
   `Content-MD5`, `x-amz-checksum-sha256`, comprobado con `HeadObject`.
6. Comprobación diaria (§10.1) tras cada ejecución, línea `check=daily`. Un respaldo
   remoto cuenta como **completo** solo según §5.3 con la clave disponible: su manifiesto
   se lee de la clave derivada y valida las reglas 1, 2, 3 (`key_id` + MAC) y 5, y
   `HeadObject` del objeto coincide en tamaño (y `x-amz-checksum-sha256` si es de una
   parte); los defectos se listan en `invalid=<backup_id>:E-RESTORE-MAC|E-REMOTE-CONFLICT`
   y en `error=` (aviso de seguridad, nada se borra). Con ese conjunto: respaldo completo
   más reciente < 26 h (`E-FRESHNESS`; un par antiguo copiado a un `backup_id` nuevo no
   satisface la frescura: falla la regla 5), más antiguo bajo el prefijo ≤ 16 d desde
   `created_at` y ciclo de vida exactamente §9 (`E-RETENTION-VIOLATION`); avisos
   (`warnings=`) por 13–16 completos fuera de rango, objetos sin manifiesto > 24 h y
   claves inesperadas.
7. Reintentos (§12): 5 intentos por petición, espera aleatoria `U(0, min(60 s, 2 s·2ⁿ))`,
   conexión 10 s, lectura 120 s (subidas 600 s), plazo total 30 min (`E-DEADLINE`).
   Se reintentan red/tiempos/5xx/429/`SlowDown`/`RequestTimeout`; no se reintentan 403,
   400 de firma/región, 404 `NoSuchBucket`, 501, TLS ni reloj (§13). botocore no
   reintenta por su cuenta (`total_max_attempts = 1`).
8. Candado propio `${MAINSPOT_BACKUP_DIR}/.db-backup-remote.lock` (`flock`). Nunca
   `DeleteObject` ni cambios de bucket (§8.6). Código de salida: 0 (`OK`, `DISABLED`,
   `SKIPPED`), 1 (algún `FAIL`), 2 (uso / `boto3` ausente).

Registro (§16.3): una línea por respaldo en stdout y en
`${MAINSPOT_BACKUP_DIR}/backup-remote.log` (0600), sin secretos:
`<UTC> db-backup-remote status=OK|FAIL|SKIPPED backup_id=… object_key=… size_bytes=… sha256=… [manifest_bytes=… total_bytes=… limit_bytes=…] attempts=… duration_s=… [error=E-…] action=uploaded|already-complete|dry-run|outside-24h-window|size-rejected`
(`attempts` = peticiones de la operación lógica que más necesitó, incluido el reintento
tras `InvalidDigest`: un PUT rechazado y uno aceptado ⇒ `attempts=2`),
más la línea `check=daily` y, si la ejecución se detiene (reloj, credencial, bucket,
plazo), una línea `status=FAIL error=…` de ejecución. `error=E-CONFIG` es un código
local (configuración, permisos, clave o candado), no de §13.

### Avisos por Telegram (DEC-0064 / DEC-0065)

Adaptador `scripts/ops/backup/remote-alert-telegram.py` (solo biblioteca estándar). Bot **exclusivo** de los
avisos del productor, distinto del bot del KVM 4, del de CanonFlow/HDC y del comercial de MainSpot. Token e
identificador del chat solo en este equipo; nunca en Git, registros, documentación, issues ni respuestas de
agentes.

- **Entrega:** texto plano (sin `parse_mode`) por HTTPS, timeout de 8 s, 2 intentos como mucho (429 con
  espera ≤ 5 s se respeta), dentro de los 30 s que el productor concede al adaptador. Primera línea
  `ID: <event_id>`.
- **Recibo verificable (F-01, API-0005):** solo hay aceptación (`api_accepted`) si `sendMessage` responde
  `ok: true` con `result.chat.id` igual al chat configurado, `result.message_id` entero positivo y
  `result.date` plausible. La correlación `event_id ↔ message_id ↔ date` se persiste en el registro local
  (`~/.local/state/mainspot/alerts/`, 0700/0600, escritura atómica) y el adaptador imprime una línea
  `{"receipt": …}` sin secretos. Una respuesta perdida tras el envío o un recibo incompleto queda
  `api_acceptance_uncertain` y nunca se reenvía automáticamente. Un recibo de otro chat queda `misrouted`.
  `api_accepted` **no** es un acuse humano.
- **Códigos de salida:**
  - `0` aceptado con recibo persistido (o ya aceptado: sin reenvío);
  - `10` sin configurar;
  - `11` configuración o estado inseguro o inválido, o credenciales rechazadas;
  - `12` evento inválido;
  - `13` no disponible;
  - `14` mal dirigido;
  - `15` aceptación incierta;
  - `16` aceptado sin recibo persistido;
  - `17` consumidor concurrente o webhook;
  - `18` avisos que requieren atención.
- **Acuse humano (F-01, API-0006/API-0008):**
  - Los avisos de severidad `error` y `TEST-SYNTHETIC` llevan un botón «Confirmar recepción», cuyo `callback_data` es `a1:<event_id>:<HMAC-96>` firmado con la clave exclusiva `~/.config/mainspot/backup/telegram-ack.key` (0600, 64–128 hex; no es el token).
  - `--ack-poll [--max-seconds N]` es el único consumidor `getUpdates` (`flock`; se niega con webhook o 409). Valida actor, chat, mensaje y fecha contra el recibo, la firma y el estado; persiste el acuse antes de avanzar el cursor y responde con `answerCallbackQuery` (solo interfaz).
  - `--check-overdue` aplica `ACK_DEADLINE_SECONDS`, `ACK_REMINDER_INTERVAL_SECONDS` y `ACK_MAX_REMINDERS` (en `telegram-alert.env`; las tres o ninguna): `ack_overdue`, recordatorios acotados por el mismo bot (no son redundancia) y `needs_operator_attention`. Un acuse tardío queda `acknowledged_late`.
  - `--status` da el estado en JSON.
  - Sin clave o sin política, los avisos se envían sin botón y quedan `needs_operator_attention`.
  - Ninguna cadencia (servicio o temporizador) está instalada ni activada.
- **El productor** (`delivery=ok|failed-unavailable|failed-timeout|failed-config|failed-not-configured|failed-invalid|failed-integrity|failed-misrouted|failed-acceptance-uncertain|failed-receipt-untracked|not-configured`; con `delivery=ok` añade `message_id=` y `ack=`):
  - antes de cada ejecución del adaptador comprueba su sha256 (`MAINSPOT_REMOTE_ALERT_COMMAND_SHA256`), que no
    sea un enlace simbólico ni contenga `..`, y que el archivo y todos sus directorios superiores sean del
    usuario o de root y no escribibles por grupo ni otros; lo ejecuta sin shell ni argumentos, con
    `PATH`/`HOME` como único entorno;
  - los fallos reintentables quedan en `remote-alerts-pending/` (0600) y se reintentan al inicio de las
    ejecuciones siguientes (si uno falla por indisponibilidad, el resto espera); tras 24 intentos o 72 h pasan
    a `remote-alerts-failed/` con `delivery=abandoned`. `failed-misrouted`, `failed-acceptance-uncertain`,
    `failed-receipt-untracked` y `failed-timeout` no se reintentan (podrían duplicar el mensaje): pasan
    directamente a `remote-alerts-failed/` con `needs_operator_attention=yes`;
  - un mismo aviso de §13 no se repite antes de 24 h (`remote-alerts-state.json`); `E-UPLOAD-WINDOW` se avisa
    una vez por respaldo y `E-SIZE-LIMIT` una vez por archivo (marca de rechazo).
- **Instalación** (el checkout es escribible por el grupo, así que el adaptador no se ejecuta desde él):

  ```bash
  install -d -m 0700 ~/.local/libexec ~/.local/libexec/mainspot
  install -m 0700 scripts/ops/backup/remote-alert-telegram.py ~/.local/libexec/mainspot/remote-alert-telegram.py
  sha256sum ~/.local/libexec/mainspot/remote-alert-telegram.py   # valor para MAINSPOT_REMOTE_ALERT_COMMAND_SHA256
  ```

- **Aprovisionamiento por el propietario** (en este equipo, sin pegar valores en chats ni issues):

  ```bash
  install -d -m 0700 ~/.config/mainspot ~/.config/mainspot/backup
  ( umask 077; read -rsp 'Token del bot: ' T; echo; read -rp 'Chat id: ' C
    printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n' "$T" "$C" > ~/.config/mainspot/backup/telegram-alert.env )
  chmod 0600 ~/.config/mainspot/backup/telegram-alert.env
  ```

- **Prueba sintética de recepción** (no activa el productor ni toca S3):
  `~/.local/libexec/mainspot/remote-alert-telegram.py --synthetic-test` imprime el recibo y el `id` del
  evento `TEST-SYNTHETIC`. La recepción real solo se da por buena con el acuse del propietario por el botón
  (`--ack-poll` → `human_acknowledged`) y su confirmación en el issue. Procedimiento preparado, pendiente de
  autorización: `docs/contracts/backup-object-storage/f01-ack-mini-bootstrap.md`.
- La conexión con el productor (`MAINSPOT_REMOTE_ALERT_COMMAND` y `MAINSPOT_REMOTE_ALERT_COMMAND_SHA256` en
  `remote.env`) se hace en la activación, que exige su propia autorización en el HDC.

### Pruebas de laboratorio (`tests/ops/backup-remote/test_remote_producer.py`)

```bash
PYTHONPYCACHEPREFIX=/tmp/omp-pyc python3 -m pytest -p no:cacheprovider -v tests/ops/backup-remote
```

La suite levanta un Garage oficial (`dxflrs/garage:v2.4.1`, Docker, solo 127.0.0.1,
contenedor `msp-garage-lab-producer-<aleatorio>` sin volúmenes en el host, destruido al
terminar; sin Docker se omite), aplica el ciclo de vida de §9 y usa HOME, clave
(`openssl rand -base64 48`), configuración y respaldos **desechables**: texto en claro
sintético cifrado con el comando exacto de §4.2 (no necesita `pg_dump`). Un proxy HTTP
mínimo en la prueba inyecta 503 y desplaza la cabecera `Date`. 19 pruebas: desactivado
por defecto (sin archivo y con `ENABLED=0`); subida completa con cabeceras, metadatos,
manifiesto válido y cuerpo firmado sin trailers; idempotencia (ETag/LastModified
intactos); `E-REMOTE-CONFLICT` por contenido distinto y por manifiesto sin objeto;
ventana de 24 h (25 h ⇒ `SKIPPED`/`E-UPLOAD-WINDOW`, 23 h ⇒ sube); objeto sin
manifiesto se re-sube; `E-LOCAL-INTEGRITY`; 503×2 ⇒ `attempts=3` y OK; 503×5 ⇒
`E-SERVER attempts=5` sin manifiesto; un byte corrompido en tránsito una vez ⇒ PUT 400
`InvalidDigest` + PUT 200, `OK attempts=2` (D-02); 403 con clave de solo lectura ⇒
`E-AUTH-DENIED attempts=1` (un solo PUT); `Date` +600 s ⇒ `E-AUTH-SKEW` sin subir nada
(+200 s ⇒ OK); `--check-only` con prefijo vacío (`E-FRESHNESS`), ciclo de vida correcto,
con `Days=30` y con una regla extra (`E-RETENTION-VIOLATION`), objeto huérfano > 24 h
(aviso); D-01: par antiguo reubicado a un `backup_id` nuevo ⇒ `E-RESTORE-MAC` y
`E-FRESHNESS` (no cuenta como fresco), manifiesto reescrito sin la clave ⇒
`E-RESTORE-MAC`, objeto de > 24 h sustituido ⇒ `E-REMOTE-CONFLICT` en la línea del
respaldo local y en `check=daily` (también cuando el respaldo ya no está en local);
multiparte (umbral de laboratorio 1 MiB: 4 partes, ETag `-4`, sin subidas pendientes);
`--dry-run` sin escrituras; permisos de configuración y candado; y que ninguna salida
ni registro contiene la clave, el secreto ni el id de acceso. Salida completa:
`evidence/remediation/R3-remote-producer/01-tests.txt` (19 passed, versión inicial) y
`05-fixes-tests.txt` (tras corregir D-01/D-02 de `03-adversarial-validation.md`);
aceptación (DISABLED sin red, unidades verificadas y no instaladas, laboratorio limpio,
sin `__pycache__`): `02-acceptance.txt`.

## Operación / restauración real

Para restaurar en producción (procedimiento manual, fuera de estos scripts):

```bash
cd ~/.local/share/mainspot/backups && sha256sum --strict -c mainspot-db-<ts>.dump.enc.sha256
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
  -pass file:$HOME/.config/mainspot/backup/backup.key < mainspot-db-<ts>.dump.enc \
  | lxc exec mainspot-db -- sudo -u postgres pg_restore --clean --if-exists -d mainspot
# DEC-0027: inmediatamente después, re-aplicar bajas antes de reabrir tráfico (dentro de mainspot-app):
#   cd /opt/mainspot-platform && set -a && . /etc/mainspot/mainspot.env && set +a
#   node scripts/retention-run.ts --reapply-exits
# Si el respaldo NO es el más reciente, exportar antes el registro de la base más reciente
# (`node scripts/retention-run.ts --export-registry > registry.json`, o de una copia
# restaurada del último respaldo) y usar `--reapply-exits --registry=registry.json`.
# Un respaldo previo a la migración 0015 necesita `npm run migrate` antes de re-aplicar.
```

## Verificación ejecutada

Ejecutado el 2026-10-22 (UTC) en el host, desde la raíz del repo. Sin secretos en
ninguna salida (la clave y el password del contenedor desechable nunca se imprimen).

### 1. Respaldo real contra `mainspot-db` (pg_dump de solo lectura)

```text
$ scripts/ops/backup/db-backup.sh; echo "exit=$?"
2026-10-22T06:00:52Z db-backup status=OK file=/home/administrador/.local/share/mainspot/backups/mainspot-db-20261022T060051Z.dump.enc size_bytes=114768 sha256=275449dcd8f31b63813772cdabf9279cab6aae6ad4837bfd888338ccc1fd43d6 toc_entries=183 pruned=0 kept=1 retention_days=14 duration_s=1
exit=0

$ stat -c '%a %U %n' ~/.config/mainspot/backup ~/.config/mainspot/backup/backup.key ~/.local/share/mainspot/backups ~/.local/share/mainspot/backups/*
700 administrador /home/administrador/.config/mainspot/backup
600 administrador /home/administrador/.config/mainspot/backup/backup.key
700 administrador /home/administrador/.local/share/mainspot/backups
600 administrador /home/administrador/.local/share/mainspot/backups/backup.log
600 administrador /home/administrador/.local/share/mainspot/backups/mainspot-db-20261022T060051Z.dump.enc
600 administrador /home/administrador/.local/share/mainspot/backups/mainspot-db-20261022T060051Z.dump.enc.sha256

$ cat ~/.local/share/mainspot/backups/*.sha256
275449dcd8f31b63813772cdabf9279cab6aae6ad4837bfd888338ccc1fd43d6  mainspot-db-20261022T060051Z.dump.enc
$ file ~/.local/share/mainspot/backups/*.dump.enc
…/mainspot-db-20261022T060051Z.dump.enc: openssl enc'd data with salted password
```

### 2. Retención de 14 días y rechazo de clave con permisos amplios

En un directorio temporal `$T` con una clave **de prueba** (no la real), un
respaldo falso de hace 15 días y otro de hace 13:

```text
$ MAINSPOT_BACKUP_DIR=$T/backups MAINSPOT_BACKUP_KEY=$T/dummy.key scripts/ops/backup/db-backup.sh
2026-10-22T06:01:05Z db-backup status=OK file=$T/backups/mainspot-db-20261022T060104Z.dump.enc size_bytes=114768 sha256=1d9533feab03bd92fae3507fea0f92c2b1a787d8ca713128bacc6307236a374a toc_entries=183 pruned=1 kept=2 retention_days=14 duration_s=1
exit=0
$ ls $T/backups
backup.log
mainspot-db-20261009T000000Z.dump.enc          # 13 días: se conserva
mainspot-db-20261022T060104Z.dump.enc
mainspot-db-20261022T060104Z.dump.enc.sha256   # el de 15 días (y su .sha256) fue borrado

$ chmod 640 $T/dummy.key; MAINSPOT_BACKUP_DIR=$T/backups MAINSPOT_BACKUP_KEY=$T/dummy.key scripts/ops/backup/db-backup.sh
2026-10-22T06:01:05Z db-backup status=FAIL rc=1 reason="permisos de la clave demasiado amplios (640); se exige 0600 o más restrictivo" duration_s=0
exit=1
```

### 3. Prueba de restauración real del respaldo producido

```text
$ scripts/ops/backup/db-restore-test.sh; echo "exit=$?"
06:01:09Z == MainSpot — prueba de restauración (DEC-0026) run=20261022T060109Z host=administrador-Katana-15-HX-B14WGK ==
06:01:09Z respaldo: /home/administrador/.local/share/mainspot/backups/mainspot-db-20261022T060051Z.dump.enc (114768 bytes, mtime 2026-10-22T06:00:51Z)
06:01:09Z sha256 verificado: 275449dcd8f31b63813772cdabf9279cab6aae6ad4837bfd888338ccc1fd43d6
06:01:09Z contenedor: msp-restore-test-20261022t060109z (postgres:16, datos en tmpfs)
06:01:10Z PostgreSQL listo en 127.0.0.1:32768 (puerto aleatorio) — postgres (PostgreSQL) 16.15 (Debian 16.15-1.pgdg13+2)
06:01:11Z pg_restore OK en 0 s (--no-owner --no-privileges --exit-on-error)
06:01:11Z [restaurado] schema_migrations=14 (última: 0014_quota_reservation.sql; repo: 14 archivos) tablas_public=30
06:01:11Z [restaurado] filas por tabla: action_proposal=1 analytics_daily_summary=0 approval=0 audit_event=126 client=2 client_data=4 client_domain=1 client_website=2 conversation_request=5 demo_action=1 internal_user=6 jev_classification=4 jev_evaluation_run=3 permission=30 plan=3 plan_limit=14 preview_session=0 publication=0 quota_reservation=1 review=4 role=3 role_permission=51 scheduled_post=0 schema_migrations=14 session_context=23 social_post=1 subscription=2 tenant_context=2 user_role=6 website_content=0
06:01:11Z OMITIDO: scripts/retention-run.ts no existe todavía en el repo; no se verificó la re-aplicación de bajas (DEC-0027).
06:01:12Z contenedor eliminado: msp-restore-test-20261022t060109z
06:01:12Z RESULTADO: OK
informe: /home/administrador/.local/share/mainspot/backups/restore-tests/restore-test-20261022T060109Z.txt
exit=0

$ docker ps -a --filter label=mainspot.restore-test=1 --format '{{.Names}}' | wc -l
0
$ docker ps --filter name=msp-test-pg --format '{{.Names}} {{.Status}} {{.Ports}}'   # contenedor ajeno, intacto
msp-test-pg Up 22 minutes 127.0.0.1:55433->5432/tcp
```

El informe (`0600`) incluye además la línea de `sha256sum -c`
(`mainspot-db-20261022T060051Z.dump.enc: La suma coincide`).

> En estas dos corridas `scripts/retention-run.ts` aún no existía y el paso
> `--reapply-exits` quedó **OMITIDO**; la verificación con el paso activo está en §7.

### 4. Ruta de fallo: checksum alterado

```text
$ # copia del respaldo en $T con un .sha256 de ceros
$ MAINSPOT_BACKUP_DIR=$T scripts/ops/backup/db-restore-test.sh
06:01:24Z == MainSpot — prueba de restauración (DEC-0026) run=20261022T060124Z host=administrador-Katana-15-HX-B14WGK ==
06:01:24Z respaldo: $T/mainspot-db-20261022T060051Z.dump.enc (114768 bytes, mtime 2026-10-22T06:01:24Z)
06:01:24Z RESULTADO: FALLO (rc=1) verificación sha256 FALLIDA
informe: $T/restore-tests/restore-test-20261022T060124Z.txt
exit=1
```

### 5. Unidades systemd (escritas, no habilitadas)

```text
$ systemd-analyze --user verify scripts/ops/backup/systemd/*.service scripts/ops/backup/systemd/*.timer
(sin salida: sin errores)
$ systemctl --user list-unit-files 'mainspot-db-*' --no-legend | wc -l
0
```

### 6. Re-ejecución tras el último cambio de los scripts (ajuste de `--help`)

```text
$ bash -n scripts/ops/backup/db-backup.sh && bash -n scripts/ops/backup/db-restore-test.sh && echo syntax-ok
syntax-ok
$ scripts/ops/backup/db-restore-test.sh; echo "exit=$?"
06:03:11Z sha256 verificado: 275449dcd8f31b63813772cdabf9279cab6aae6ad4837bfd888338ccc1fd43d6
06:03:12Z PostgreSQL listo en 127.0.0.1:32769 (puerto aleatorio) — postgres (PostgreSQL) 16.15 (Debian 16.15-1.pgdg13+2)
06:03:13Z pg_restore OK en 0 s (--no-owner --no-privileges --exit-on-error)
06:03:13Z [restaurado] schema_migrations=14 (última: 0014_quota_reservation.sql; repo: 15 archivos) tablas_public=30
06:03:13Z OMITIDO: scripts/retention-run.ts no existe todavía en el repo; no se verificó la re-aplicación de bajas (DEC-0027).
06:03:13Z contenedor eliminado: msp-restore-test-20261022t060311z
06:03:13Z RESULTADO: OK
exit=0
$ scripts/ops/backup/db-backup.sh; echo "exit=$?"
2026-10-22T06:03:18Z db-backup status=OK file=/home/administrador/.local/share/mainspot/backups/mainspot-db-20261022T060318Z.dump.enc size_bytes=114768 sha256=c0c4c7b24ff0e7abc55fdcdd8584d6a1bfbf81aa931b9c25e420d5ed65c41b9d toc_entries=183 pruned=0 kept=2 retention_days=14 duration_s=0
exit=0
```

(«repo: 15 archivos»: entre ambas corridas apareció una migración nueva en el repo;
no figura en el respaldo restaurado, tomado a las 06:00:51Z.)

### 7. Re-aplicación de bajas activa (R2, retención QS-0006)

Con `scripts/retention-run.ts` y la migración 0015 desplegados (respaldo
`mainspot-db-20261022T061743Z.dump.enc`, 15 migraciones):

```text
$ scripts/ops/backup/db-restore-test.sh; echo "exit=$?"
06:17:46Z [restaurado] schema_migrations=15 (última: 0015_retention_policy.sql; repo: 15 archivos) tablas_public=33
06:17:46Z ejecutando: DATABASE_URL=<scratch> node scripts/retention-run.ts --reapply-exits
06:17:46Z re-aplicación de bajas OK
06:17:46Z [tras-reapply-exits] schema_migrations=15 (última: 0015_retention_policy.sql; repo: 15 archivos) tablas_public=33
06:17:46Z RESULTADO: OK
exit=0
```

Simulacro de no reintroducción sobre una copia restaurada del mismo respaldo
(BD scratch, producción intacta): un registro con el sha256 de `client_b`, como
si una fuente más nueva lo hubiera anonimizado, y `--reapply-exits --registry=…`
⇒ `reanonymized: 1`, 222 columnas de texto/JSON revisadas sin ningún
identificador del tenant, 12 eventos de auditoría conservados bajo el id anónimo y
`client_a` intacto. Salida completa en
`evidence/remediation/R2-retention/05-restore-drill.txt`.

### 8. Timers habilitados en este host (2026-10-22)

```text
$ systemctl --user enable --now mainspot-db-backup.timer mainspot-db-restore-test.timer
$ systemctl --user list-timers 'mainspot-db-*'
Thu 2026-10-22 03:15:00 EST  …  mainspot-db-backup.timer       mainspot-db-backup.service
Sun 2026-11-01 04:00:00 EST  …  mainspot-db-restore-test.timer mainspot-db-restore-test.service
$ systemctl --user start mainspot-db-backup.service mainspot-db-restore-test.service   # una corrida de cada unidad
Result=success ExecMainStatus=0 (ambas)
06:20:00Z re-aplicación de bajas OK
06:20:01Z RESULTADO: OK
```

Los respaldos y la clave siguen **solo en este host**: el destino fuera del host y
la custodia de la clave están pendientes de decisión humana.
