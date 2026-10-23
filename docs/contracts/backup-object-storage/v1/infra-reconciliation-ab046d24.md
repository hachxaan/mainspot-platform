# Reconciliación del contrato v1 con la infraestructura `hachxaan/mainspot-s3-backups` @ `ab046d24`

> Versión publicable; la versión íntegra con detalles de la infraestructura queda
> fuera del repositorio público. Esta versión omite direcciones privadas, nombres de
> contenedores, rutas de sistema, usuarios y la transcripción del clon; conserva los
> hallazgos H-01…H-14 y las secciones §5, §6, §7, §9, §10 y §11 que cita `CONTRACT.md`.

| Campo | Valor |
|---|---|
| Tipo | Informe de reconciliación (no normativo; no modifica `CONTRACT.md` v1.0.0) |
| Fecha | 2026-10-22 |
| Contrato comparado | `docs/contracts/backup-object-storage/v1/CONTRACT.md` v1.0.0 y `VERIFICATION.md` |
| Infraestructura comparada | `https://github.com/hachxaan/mainspot-s3-backups.git`, commit `ab046d2447bb2a60a0f0e2166a64151ef811aca8` (el «commit revisado» que cita ANS-0011) |
| Decisiones aplicadas | ANS-0011 (2026-10-22T09:16:37Z): `Q-S3-RETENTION-ENFORCEMENT = ciclo_vida_servicio`, `Q-S3-DELETE-RISK = copia_protegida_antes`, `Q-S3-SINGLE-NODE = nodo_unico`, `Q-S3-DESTINATION = garage_kvm4`, más las notas literales de `Q-NOTES` |
| Alcance | Lectura del repositorio del servicio, lectura del contrato, comprobaciones de red sin credenciales desde fuera del KVM 4. No se ejecutó la conformidad de §14 (no hay credenciales en este equipo) y no se tocó el KVM 4 |

Convenciones: **observado** = salida de un comando o contenido de un archivo leído en
este trabajo; **[INFERENCE]** = deducido del código o de la documentación, sin
ejecutarlo contra el servicio real. Severidades: **ALTA** (bloquea la activación o
contradice una decisión aprobada), **MEDIA** (impide la conformidad de §14 o una
obligación S-xx), **BAJA** (desviación sin efecto sobre la activación), **INFO**.

## 1. Resumen

1. El commit `ab046d24` implementa un Garage v2.4.1 de un nodo detrás de Nginx con
   certificado Let's Encrypt válido; la exposición de red coincide con lo que exige el
   contrato (§4 de este informe: TLS válido, redirección 80→443, puertos 3900–3903
   filtrados). El §6.1 y el riesgo R4 del contrato, que describían un certificado
   autofirmado, han quedado desactualizados.
2. **La retención no coincide ni con el contrato ni con la decisión del propietario**
   (`ciclo_vida_servicio`: «regla de ciclo de vida de 14 días en el bucket; MainSpot no
   borra»). El KVM 4 no instala ninguna regla `Expiration`: borra con un proceso propio
   (`mainspot-s3-retention`, cada hora, por `LastModified`) y, además, **sobrescribe
   cada hora cualquier ciclo de vida distinto del suyo**. Con el contrato v1.0.0 tal
   cual, C-15 fallaría siempre y el productor emitiría E-RETENTION-VIOLATION a diario.
   No es una duplicidad: los dos mecanismos son mutuamente excluyentes tal como están
   escritos (§5).
3. La salvaguarda `halted` del proceso de retención **retiene sin límite de tiempo**
   cuando no hay objetos recientes. Contradice la cota de 16 días de §9 y, si dura más
   de 30 días, DEC-0027 (§5.3 de este informe).
4. **No existe copia protegida** en `ab046d24`; el propio repositorio la lista como
   «mitigación pendiente». La decisión `copia_protegida_antes` exige construirla y
   probarla antes de activar. §7 contiene una PROPUESTA con tres opciones técnicas.
5. Nombres y formato de credenciales difieren del contrato (`mainspot-backup-reader`
   frente a `mainspot-backup-restore`; `mainspot-s3-retention` frente a
   `mainspot-backup-operator`; variables `S3_*` frente a `AWS_*`), de modo que la
   conformidad de §14 no arranca con los archivos del repositorio tal cual.

## 2. Método y evidencia

### 2.1 Clon de solo lectura

Clon de solo lectura del commit `ab046d2447bb2a60a0f0e2166a64151ef811aca8` (repositorio
privado; `git rev-parse HEAD` confirmado), borrado al terminar. No se imprimió ningún
token. 50 archivos, 3 288 líneas (sin `.git`).

### 2.2 Archivos del servicio leídos íntegramente

`config/garage/garage.toml`, `config/nginx/s3.mainspot.canonflow.dev.conf`,
`config/nginx/s3-mainspot-allow.conf`, la regla nftables de `config/nftables/`,
`scripts/container/mainspot-s3-retention.py`, `scripts/container/garage-init.py`,
`scripts/container/garage-health.py`, `scripts/host/install-ops.sh`,
`scripts/tests/retention-test.sh`, `systemd/mainspot-s3-retention.service`,
`docs/01`, `02`, `03`, `05`, `06`, `07`, `08`, `09`, `11`, `12`, `runbook.md`, `README.md`,
`evidence/00`, `01`, `02`, `03`, `06`, `07`, `09`, `.gitignore`. De `scripts/lib/s3sig.py`
solo las firmas de `list_objects`/`delete` y el análisis de `LastModified`.

### 2.3 Archivos de MainSpot leídos

`CONTRACT.md` completo, `VERIFICATION.md` completo,
`conformance/check_s3_backup_contract.py` (carga de credenciales, `LIFECYCLE_V1`,
`INTERNAL_PORTS`, C-14/C-15), `reference/manifest_tool.py` (opciones de `verify`),
`.canonflow/decision-sessions/answered/QS-0011.answers.json` (solo lectura) y las
definiciones de `Q-S3-RETENTION-ENFORCEMENT` y `Q-S3-DELETE-RISK` en
`.canonflow/decision-sessions/pending/QS-0011.questions.json`.

## 3. Inventario de lo que implementa `ab046d24`

### 3.1 Garage

| Elemento | Valor en el repositorio | Fuente |
|---|---|---|
| Versión | v2.4.1, binario musl estático oficial, SHA-256 `ae49f8de…d0a2b6` contrastado con la imagen `dxflrs/garage:v2.4.1` | `docs/02`, `evidence/00`, `evidence/01` línea 54 |
| `replication_factor` | `1` | `garage.toml` |
| `consistency_mode` | `"consistent"` | `garage.toml` |
| `db_engine` / fsync | `lmdb`, `metadata_fsync = true`, `data_fsync = true` | `garage.toml` |
| `metadata_auto_snapshot_interval` | `"6h"` (snapshots de metadatos en el volumen de metadatos) | `garage.toml` |
| `s3_region` | `"garage"` | `garage.toml`; también observado desde fuera en `<Region>garage</Region>` (§4.2) |
| `compression_level` / `block_size` | `"none"` / `"1MiB"` | `garage.toml` |
| Escuchas | S3 solo accesible desde el proxy (el cortafuegos limita el origen); RPC y admin en loopback; sin `[s3_web]` (3902 no existe); sin `root_domain` (solo path-style) | `garage.toml`, regla nftables, `evidence/02` T26 |
| Scrub | No se configura ni se desactiva: el `runbook.md` lo declara «automático (worker de Garage)» | `runbook.md` |
| Layout | zona `kvm4`, capacidad declarada 100 GB, un nodo, versión 1 | `garage-init.py`, `evidence/01` líneas 101–110 |
| Aislamiento | Contenedor no privilegiado (sin nesting, sin acceso al demonio del host, sin sshd/snapd), con volúmenes separados para metadatos y datos | `evidence/01` líneas 1–45 |

### 3.2 Proxy (Nginx)

| Directiva | Valor | Relación con el contrato |
|---|---|---|
| `server_name` / escucha | `s3.mainspot.canonflow.dev`, `443 ssl` (IPv4 e IPv6) | §6.1 |
| `proxy_pass` al upstream de Garage sin URI | la ruta firmada no se reescribe | S-04 |
| `proxy_set_header Host $http_host` | conserva el `Host` firmado | S-04 |
| `client_max_body_size 5g` | cuerpos hasta 5 GiB | S-04 (≥ 300 MiB) |
| `client_body_timeout`, `send_timeout`, `proxy_send_timeout`, `proxy_read_timeout` | 900 s; `proxy_connect_timeout 10s` | S-04 (≥ 600 s) |
| `proxy_request_buffering off`, `proxy_buffering off`, `proxy_max_temp_file_size 0` | sin copia temporal en disco | S-04 |
| `gzip off` | cuerpo intacto | §8.4 |
| `log_format s3_mainspot_noqs` | registra `$uri` sin cadena de consulta | S-12 |
| `server_tokens off`, HSTS `max-age=31536000` | solo en el bloque 443 (ver H-09) | — |
| `include snippets/s3-mainspot-allow.conf` | lista de IP de origen, vacía (sin restricción) | — |
| Bloque `listen 80` | `return 301 https://$host$request_uri` | §6.1, C-18 |

### 3.3 TLS (Certbot)

Certificado ECDSA de Let's Encrypt (emisor `YE2`) obtenido con `certbot certonly --nginx … --deploy-hook 'systemctl reload nginx'`; renovación por `snap.certbot.renew.timer`; `certbot renew --dry-run` con éxito (`evidence/09`). Lo observado desde fuera está en §4.1.

### 3.4 Bucket, cuotas, claves y permisos (`garage-init.py`, aplicado por `install-ops.sh`)

| Bucket | Cuota | Uso |
|---|---|---|
| `mainspot-backups` | 50 GiB, sin límite de objetos, `websiteAccess` desactivado | respaldos |
| `garage-healthcheck` | 64 MiB, 100 objetos | canario del monitor |

| Clave (nombre en Garage) | Bucket | Permisos | Equivalente en el contrato §6.4 |
|---|---|---|---|
| `mainspot-backup-writer` | `mainspot-backups` | read + write, sin owner, `createBucket` denegado | `mainspot-backup-writer` (igual) |
| `mainspot-backup-reader` | `mainspot-backups` | read | `mainspot-backup-restore` (**otro nombre**) |
| `mainspot-s3-retention` | `mainspot-backups` | read + write | `mainspot-backup-operator` (**otro nombre**; mismo papel) |
| `garage-healthcheck` | `garage-healthcheck` | read + write | — (no está en el contrato) |
| Token admin `garage-monitor` | — | `GetClusterHealth`, `GetClusterStatus`, `GetBucketInfo`, `ListBlockErrors` | — |

Todas las credenciales viven solo en el KVM 4 (archivos `0600`, usuario de sistema
dedicado por proceso); la writer y la reader están pendientes de entrega (`docs/07`:
custodia de la reader fuera del servidor de MainSpot). La writer y la reader usan el
endpoint público; el proceso de retención y el monitor usan el puerto S3 local del
contenedor y la administración en loopback.

`garage-init` reaplica en cada ejecución los permisos exactos: concede los declarados
y deniega read/write/owner en cualquier otro bucket que la clave tuviera asociado.
Ninguna clave tiene `owner` ni `createBucket` (`evidence/01` líneas 120–133; T17, T18).

Formato de archivo de credenciales del servicio: `S3_ENDPOINT`, `S3_REGION`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. El contrato (§6.4) y
`check_s3_backup_contract.py` (`load_credentials`, líneas 76–91) exigen
`AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY`.

### 3.5 `mainspot-s3-retention` (`scripts/container/mainspot-s3-retention.py` + unidad systemd)

| Aspecto | Qué hace (observado en el código) |
|---|---|
| Forma de ejecución | Servicio systemd `mainspot-s3-retention.service`, bucle continuo, `RETENTION_INTERVAL_S=3600`; tras un error de acceso o un borrado parcial reintenta a los 60 s. Usuario de sistema dedicado, unidad endurecida. Modos manuales: `--once`, `--dry-run`, `--now ISO8601` (solo con `--once`; marca `simulated_now` en la auditoría), `--ensure-lifecycle [--initial]`, `--ack-drift MOTIVO` |
| Credencial | Archivo de credenciales propio (0600): clave `mainspot-s3-retention`, read + write solo sobre `mainspot-backups`, por el puerto S3 local del contenedor (`S3_ENDPOINT` se fija en el código) |
| Bucket | Constante `BUCKET = "mainspot-backups"`; no configurable |
| Reloj | `datetime.now(timezone.utc)` del contenedor (mismo núcleo que el host; el preflight declara el host en UTC con NTP sincronizado). `--now` solo en pruebas |
| Medida de la edad | `ListObjectsV2` de **todo el bucket, sin prefijo**; `expired = LastModified < now − RETENTION_DAYS`. Es decir, se borra cuando `ahora − LastModified` supera estrictamente 14 días (R4: 14 d − 1 s se conserva). `LastModified` es la fecha de subida en Garage, **no** el `created_at` del `backup_id` |
| Qué borra | `DeleteObject` de cada clave vencida, de la más antigua a la más nueva, máximo `RETENTION_MAX_DELETE_PER_RUN=100` por ejecución. Cualquier clave: objetos `.dump.enc`, manifiestos, `_conformance/`, prefijos de prueba |
| Salvaguarda `halted` | Si hay objetos vencidos **y ninguno** más reciente que 14 días, **no borra nada**, registra `halt`, deja `status.json` con `halted: true` y espera el intervalo normal. Se reanuda sola cuando aparece un objeto reciente |
| `RETENTION_DAYS < 14` | el proceso se niega a arrancar |
| Ciclo de vida nativo | En **cada** ejecución (`ensure_lifecycle`, `fix=True` salvo `--dry-run`/`--now`) lee `GetBucketLifecycle` y lo compara con exactamente una regla: `ID=abort-incomplete-multipart-1d`, `Status=Enabled`, `Prefix=""`, **sin `Expiration`**, `AbortIncompleteMultipartUpload.DaysAfterInitiation=1`. Si difiere en cualquier cosa, **la sobrescribe** con `PutBucketLifecycle` y audita `lifecycle_drift` (`restored: true`); `install-ops.sh` la aplica inicialmente con `--ensure-lifecycle --initial` |
| Auditoría | `audit.jsonl` propio (una línea JSON por evento: `run_start`, `lifecycle_drift`, `lifecycle_applied`, `would_delete`, `delete`, `delete_error`, `limit`, `halt`, `run_end`, `run_error`, `lifecycle_drift_ack`; con clave, tamaño, ETag, `LastModified`, `age_days`, `run_id`; sin credenciales) y el journal con prefijo de prioridad syslog (`<3>` error, `<5>` borrado, `<6>` info) |
| Qué avisa y a quién | Solo escribe `status.json`; `garage-health` lo lee cada 60 s y emite al **journal del contenedor** `<2>ALERT` si `halted`, `<4>WARN` si no hay ejecución correcta en 26 h o si hay deriva de ciclo de vida sin reconocer. `docs/05`: «No hay canal de notificación externo configurado (Telegram, correo)» |
| Pruebas del repositorio | `retention-test.sh` con reloj simulado: 13 PASS (`evidence/06`); se niega a ejecutarse si el bucket contiene objetos que no sean sintéticos. T20/T20b–d (`evidence/02`): la clave writer borró el ciclo de vida (HTTP 204) y, según el mensaje del commit `ab046d24` y `docs/05`, también instaló una regla `Expiration` de 1 día (HTTP 200); el proceso la restauró y auditó |

Justificación declarada por el servicio (`docs/01`, `docs/09`, cabecera del script):
Garage no tiene Object Lock, la regla nativa «solo registra contadores» (sin auditoría
por objeto) y el proceso propio aporta la salvaguarda `halted`. La semántica «borrar
después de 14 días cumplidos» y el comportamiento de `halted` se dejan explícitamente
como «pendiente de confirmar en el contrato» (`docs/09`, `docs/12` punto 5).

### 3.6 Monitor `garage-health`

Cada 60 s: `/health` y `GetClusterHealth`, espacio libre de meta/data (aviso < 20 %,
crítico < 10 % o < 10 GiB), uso de la cuota del bucket (aviso ≥ 80 %, crítico ≥ 95 %),
`ListBlockErrors` (crítico si > 0), canario PUT/GET/DELETE con SHA-256 en
`garage-healthcheck`, y estado de la retención (ver 3.5). Salida al journal y a un
`status.json` propio. Sin canal externo.

### 3.7 Estado declarado por el servicio

`README.md` y `docs/12`: **`INFRA_READY_INTEGRATION_BLOCKED`**; sin respaldo
productivo; ninguna credencial entregada; el servicio espera «el contrato del
consumidor publicado con SHA completo». Su tabla «contrato preliminar vs.
implementación» se escribió contra una convención de objetos distinta de §7.3
(`<entorno>/<AAAA>/<MM>/<DD>/<marca-utc>-<uuid>.dump.<ext>` con `x-amz-meta-sha256`), es
decir, antes de leer el contrato v1.0.0.

## 4. Comprobaciones de red desde fuera del KVM 4 (sin credenciales)

Ejecutadas el 2026-10-22 a las 11:35 UTC desde el equipo de trabajo de MainSpot.

### 4.1 TLS del endpoint (C-01, S-02)

```text
$ getent ahosts s3.mainspot.canonflow.dev
(resuelve a una única dirección IPv4)
$ echo | openssl s_client -connect s3.mainspot.canonflow.dev:443 -servername s3.mainspot.canonflow.dev -verify_return_error
depth=3 C = US, O = Internet Security Research Group, CN = ISRG Root X2
depth=2 C = US, O = ISRG, CN = Root YE
depth=1 C = US, O = Let's Encrypt, CN = YE2
depth=0 CN = s3.mainspot.canonflow.dev
Verification: OK
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Verify return code: 0 (ok)
$ … | openssl x509 -noout -subject -issuer -dates -ext subjectAltName -fingerprint -sha256
subject=CN = s3.mainspot.canonflow.dev
issuer=C = US, O = Let's Encrypt, CN = YE2
notBefore=Oct 22 08:00:22 2026 GMT
notAfter=Jan 20 08:00:21 2027 GMT
X509v3 Subject Alternative Name: DNS:s3.mainspot.canonflow.dev
sha256 Fingerprint=CB:8C:F9:FC:EB:36:30:F6:17:BC:0F:A8:55:AA:FA:29:DC:8E:8A:AF:10:DA:91:B4:E9:AC:83:A7:52:05:C9:7C
$ … -tls1_2 → Protocol: TLSv1.2, Cipher ECDHE-ECDSA-AES256-GCM-SHA384
$ … -tls1_1 → error local «no protocols available» (el OpenSSL de este equipo no ofrece TLS 1.1: no observable desde aquí; el repositorio lo cubre con T03)
```

Resultado: certificado de confianza pública válido para el nombre, TLS 1.2 y 1.3.
**C-01 pasaría.** El certificado en vivo (`notBefore` 08:00:22) no es el que recoge
`evidence/01` (`notBefore` 07:00:51): hubo dos emisiones el mismo día (H-10).

### 4.2 Puerto 80, cabeceras y acceso anónimo (C-17, C-18, S-12)

```text
$ curl -sS -o /dev/null -D - http://s3.mainspot.canonflow.dev/mainspot-backups/
HTTP/1.1 301 Moved Permanently
Server: nginx/1.24.0 (Ubuntu)
Date: Thu, 22 Oct 2026 11:35:54 GMT
Location: https://s3.mainspot.canonflow.dev/mainspot-backups/

$ curl -sS -D - https://s3.mainspot.canonflow.dev/mainspot-backups/
HTTP/1.1 403 Forbidden
Server: nginx
Date: Thu, 22 Oct 2026 11:35:54 GMT
Content-Type: application/xml
access-control-allow-origin: *
Strict-Transport-Security: max-age=31536000
<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Forbidden: Garage does not support anonymous access yet</Message><Resource>/mainspot-backups/</Resource><Region>garage</Region></Error>

$ curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://s3.mainspot.canonflow.dev/
403 0
$ date -u   →  Thu 22 Oct 2026 11:35:55 UTC   (diferencia con la cabecera Date ≤ 1 s)
```

Resultado: el puerto 80 redirige sin procesar la petición (**C-18 pasaría**); el
acceso anónimo se deniega (**C-17 pasaría**); la región declarada por el servicio es
`garage` (§6.2 confirmado); la diferencia de reloj observada es ≤ 1 s (**C-02 pasaría**).
La cabecera `Server` revela la versión de Nginx solo en el bloque del puerto 80 (H-09).

### 4.3 Puertos internos de Garage (C-20, S-05)

```text
$ for p in 3900 3901 3902 3903; do timeout 6 bash -c "exec 3<>/dev/tcp/s3.mainspot.canonflow.dev/$p"; echo "$p rc=$?"; done
3900 rc=124 (tiempo agotado, 6.0 s)
3901 rc=124 (tiempo agotado, 6.0 s)
3902 rc=124 (tiempo agotado, 6.0 s)
3903 rc=124 (tiempo agotado, 6.0 s)
$ timeout 6 bash -c "exec 3<>/dev/tcp/s3.mainspot.canonflow.dev/443" && echo "443 OPEN"
443 OPEN
```

Resultado: 3900–3903 filtrados (sin respuesta), 443 abierto. **C-20 pasaría.** Coincide
con `evidence/03` (check-host.net desde varios países).

## 5. Reconciliación de la retención

### 5.1 Lo que decide el propietario (ANS-0011, literal)

- Valor elegido: `ciclo_vida_servicio`, etiqueta «El servicio: regla de ciclo de vida
  de 14 días en el bucket; MainSpot no borra».
- `Q-NOTES` §2: «Se confirma que el servicio del KVM 4 será responsable de aplicar la
  expiración remota. MainSpot no eliminará objetos del destino S3. […] Se identifica una
  diferencia técnica entre el contrato v1.0.0, que describe el ciclo de vida nativo de
  Garage, y la infraestructura desplegada, que utiliza `mainspot-s3-retention` con
  ejecución horaria. Los agentes deberán reconciliar estos mecanismos, verificar la
  configuración de lifecycle del bucket y documentar cuál aplica efectivamente la
  eliminación, sin duplicaciones peligrosas ni cambios silenciosos de política.»

Lo que queda fijado y no se discute: la expiración la aplica el servicio del KVM 4 y
MainSpot no borra (§9 del contrato ya lo dice). Lo que el propietario pide reconciliar
es **cuál de los dos mecanismos del servicio** es la fuente de verdad.

### 5.2 Comparación punto por punto

| Punto | Contrato v1.0.0 (§9, §10.1, §14, §15) | `ab046d24` | Estado |
|---|---|---|---|
| Mecanismo que borra | Regla de ciclo de vida del bucket (`Expiration: 14` sobre `v1/`), ejecutada por el worker diario de Garage | Proceso `mainspot-s3-retention` cada hora con `DeleteObject`. **No hay regla `Expiration`** | **Conflicto (H-01)** |
| Configuración de ciclo de vida | Exactamente dos reglas: `mainspot-backups-v1-retention-14d` (`v1/`, 14 d, abort 1 d) y `mainspot-backups-conformance-1d` (`_conformance/`, 1 d, abort 1 d); C-15 y §10.1 exigen igualdad exacta | Una regla `abort-incomplete-multipart-1d` (prefijo vacío, solo abort 1 d). `ensure_lifecycle` **restaura esta regla cada hora** si encuentra otra cosa | **Conflicto (H-01)**: C-15 FAIL determinista; si alguien instala las reglas de §9 con `mainspot-backup-operator`, desaparecen en ≤ 1 h y el servicio lo audita como «deriva» |
| Duplicidad / doble borrado | — | Imposible tal como está: el proceso elimina la regla nativa antes de que Garage la ejecute. Si se modificara el proceso para aceptar las reglas de §9, los dos convivirían y el proceso borraría siempre primero (14 d + ≤ 1 h frente a 14–15 d) | No hay duplicidad peligrosa hoy; hay exclusión |
| Borrado antes de 14 días | No ocurre (cota inferior 14 d desde la subida) | No ocurre: `LastModified < now − 14 d` estricto; R4 lo prueba (14 d − 1 s se conserva) | Compatible |
| Base de la edad | `created_at` del `backup_id` (en la clave). Cota: ningún respaldo > 16 d desde `created_at` | `LastModified` (subida). Con la ventana de subida de 24 h (§8.2): `LastModified ∈ [created_at, created_at + 24 h]`, borrado en `(LastModified + 14 d, + 14 d + 1 h]` ⇒ vida máxima desde `created_at` = 15 d 1 h ≤ 16 d | Compatible en la cota; distinta definición (H-07). El manifiesto se sube después del objeto, así que puede sobrevivirle hasta 1 h |
| Manifiestos y objetos incompletos | Expiran igual que el objeto (misma regla por prefijo) | Expiran igual (sin filtro) | Compatible |
| Multiparte abandonada | abort a 1 d (en ambas reglas) | abort a 1 d (prefijo vacío) | Compatible |
| Prefijo `_conformance/` | Expira a 1 día | Expira a 14 días (sin filtro por prefijo) | Desviación menor (H-06) |
| Cota de 16 días cuando el productor se detiene | Garage sigue expirando; §10.1 avisa E-FRESHNESS y, si algo supera 16 d, E-RETENTION-VIOLATION | `halted`: **no borra nada** mientras no haya objetos de menos de 14 d. Los objetos se conservan sin límite hasta que llegue un objeto nuevo o alguien intervenga | **Conflicto (H-02)**: supera los 16 d de §9 a los dos días de parada y los 30 d de DEC-0027 a los 16 |
| Reloj | §6.5: NTP en ambos equipos; el productor mide la diferencia | Reloj del KVM 4 (NTP según preflight). Una desviación parcial adelantaría borrados sin disparar `halted` (que solo salta si *todo* está vencido). El worker nativo de Garage tiene la misma exposición | Equivalente (H-13) |
| Auditoría por objeto | No la exige; S-08 exige comprobar la configuración y el inventario cada día y avisar | `audit.jsonl` por objeto borrado; comprobación de la configuración cada hora. **No comprueba** la cota de 16 días desde `created_at` ni el inventario (número de respaldos completos, objetos sin manifiesto) | Parcial |
| Aviso al propietario (S-08) | «aviso al propietario si difiere» | journal del contenedor únicamente; sin canal externo | **No cumple (H-04)** |
| Credencial que aplica la retención | `mainspot-backup-operator`, read + write, solo en el KVM 4 | `mainspot-s3-retention`, read + write, solo en el contenedor (usuario dedicado, 0600) | Mismo papel, otro nombre (H-05) |
| MainSpot no borra | §8.6, §9 | El servicio no lo impide (Garage), pero no lo necesita | Compatible |
| Deriva del ciclo de vida provocada por la clave writer | §10.1 y S-08 la detectan a diario; §17 R1 | Detección y restauración en ≤ 1 h; alerta hasta `--ack-drift`; T20/T20b–d | El servicio es más fuerte aquí; ambos coinciden en que la writer puede alterarlo |

### 5.3 La salvaguarda `halted` frente a DEC-0027

DEC-0027 (APROBADO) exige que los respaldos expiren y no reintroduzcan negocios dados
de baja; MainSpot conserva la huella de las bajas 30 días, por lo que §9 fija 16 días
como cota absoluta. `halted` invierte la prioridad: ante una anomalía prefiere retener
indefinidamente (el repositorio lo declara intencionado y «requiere decisión humana»,
`docs/09`). Sin canal de aviso externo (H-04), esa decisión humana puede no llegar a
tiempo. Esta salvaguarda **no es compatible** con el contrato aprobado salvo que se
acote: por ejemplo, retener como máximo hasta `created_at + 16 d` y, a partir de ahí,
expirar igualmente (la regla nativa de Garage lo haría por sí sola si existiera).

### 5.4 Quién debe ser la fuente de verdad

Según la respuesta literal (`ciclo_vida_servicio` = «regla de ciclo de vida de 14 días
en el bucket»), la fuente de verdad es **la regla de ciclo de vida del bucket**, tal
como la describe §9, y `mainspot-s3-retention` debe dejar de borrar. Esta lectura:

- deja el contrato v1.0.0 (§9, §10.1, C-15, S-08) sin cambios de fondo;
- elimina la exclusión mutua y cualquier doble borrado;
- elimina el conflicto de `halted` con DEC-0027 (Garage expira aunque el productor se
  haya detenido, que es exactamente el motivo por el que el propietario eligió que
  borre el servicio y no MainSpot);
- conserva lo que el servicio aporta: `mainspot-s3-retention` se reconvierte en
  **vigilante** (no llama a `DeleteObject`): comprueba cada hora que la configuración
  es **exactamente** la de §9 y la restaura si difiere (es la función que §6.4 asigna
  a `mainspot-backup-operator`), lista el inventario, calcula la edad desde el
  `created_at` de la clave, avisa si algo supera 16 d o si hay `.dump.enc` sin
  manifiesto con más de 24 h, y registra en `audit.jsonl` los objetos que han
  desaparecido entre dos listados (auditoría por objeto derivada, con `LastModified`
  y edad), lo que cubre la objeción «Garage solo registra contadores».

La alternativa (mantener el proceso como ejecutor del borrado y describirlo en el
contrato v1.1) es técnicamente viable, pero cambia la etiqueta literal de la opción
elegida y obliga a cambiar §9, §10.1, C-15 y S-08; además exige acotar `halted` (5.3).
Por eso se eleva como pregunta P-1 (§11) en lugar de darla por decidida aquí.

La variante «ambos mecanismos del servicio» (reglas de §9 instaladas y el proceso
borrando una hora después de cumplir 14 d, con Garage como respaldo) no es peligrosa,
pero contradice «documentar cuál aplica efectivamente la eliminación»: en la práctica
borraría siempre el proceso y la regla quedaría sin ejercitar. Se desaconseja.

## 6. Obligaciones del servicio S-01…S-15

| Id | Obligación (resumen) | Estado | Base |
|---|---|---|---|
| S-01 | Garage ≥ v1.2.0 (recomendado v2.4.1); repetir §14 al cambiar | **Cumple** | v2.4.1 y SHA-256 del binario en `evidence/01` (observado en el repositorio; versión en vivo no observable desde fuera) |
| S-02 | Solo HTTPS en el endpoint, certificado público renovado automáticamente | **Cumple** (observado) | §4.1; redirección 80→443 (§4.2); `evidence/09` dry-run de renovación. Nota: los procesos internos del KVM 4 usan `http://127.0.0.1:3900`; S-02 debería decirlo explícitamente (§9 de este informe) |
| S-03 | Path-style, región `garage` | **Cumple** (observado) | `<Region>garage</Region>` en §4.2; sin `root_domain` |
| S-04 | Proxy conserva `Host`/ruta/consulta; cuerpos ≥ 300 MiB; sin acumular en disco; tiempos ≥ 600 s | **Cumple** [por lectura de configuración; no observable desde fuera] | §3.2; T13 (64 MiB) y T14 (codificación de claves) en `evidence/02` |
| S-05 | 3901/3902/3903 inaccesibles; token admin solo en el KVM 4 | **Cumple** (observado) | §4.3; admin en loopback; token solo en el KVM 4 |
| S-06 | Bucket exclusivo: sin sitio web, sin CORS, sin anónimo, sin alias adicionales | **Parcial** | Sitio web desactivado y sin alias (`evidence/01`); anónimo denegado (§4.2); CORS de bucket no observable. **Las suites del repositorio escriben prefijos `tests/`, `persist/`, `drill/`, `retention-test/` en `mainspot-backups`** (H-06) |
| S-07 | Claves limitadas al bucket, sin `owner`; secretos solo al propietario por canal privado | **Cumple en fondo; difiere en forma** | Permisos exactos (`garage-init`, T15–T18); procedimiento de entrega en `docs/07`. Nombres y formato distintos (H-05) |
| S-08 | Ciclo de vida de §9 aplicado y comprobado a diario, inventario (≤ 16 d desde `created_at`), aviso al propietario | **No cumple** | H-01 (otra configuración, sobrescribe §9), inventario sin cota de 16 d, aviso solo al journal (H-04) |
| S-09 | Nunca recibe ni pide la clave de descifrado | **Cumple** [INFERENCE] | `docs/01`, `docs/07`, `docs/09`; el simulacro `evidence/07` usa una clave sintética GPG en un contenedor efímero |
| S-10 | NTP | **Cumple** (observado indirectamente) | Preflight: host UTC con NTP; diferencia con `Date` ≤ 1 s (§4.2) |
| S-11 | `consistency_mode = consistent`; snapshots de metadatos; scrub; alerta de disco al 80 % | **Cumple** | `garage.toml`; alerta de disco con < 20 % libre y de cuota ≥ 80 % (`garage-health.py`); scrub automático según `runbook.md` [INFERENCE: no se desactiva en la configuración] |
| S-12 | Registros sin `Authorization`, firmas ni cuerpos | **Cumple** [por lectura] | `log_format s3_mainspot_noqs`; los registros de Garage no se han observado |
| S-13 | Capacidad ≥ 2 × 16 respaldos del tamaño máximo | **Cumple** | 2 × 16 × 120 KB ≈ 3,9 MB frente a cuota 50 GiB y 179,5 GiB disponibles (`evidence/01`) |
| S-14 | Avisar antes de cambiar endpoint, región, bucket, credenciales o ciclo de vida | **No observable** (proceso) | `docs/12` fija un procedimiento de reconciliación por SHA, pero el ciclo de vida se cambió respecto a §9 sin aviso previo (es anterior a que el servicio leyera el contrato) |
| S-15 | Informe de §14 publicado, con declaración del operador sobre S-04, S-06, S-11 y S-13 | **No cumple todavía** | No hay informe; con `ab046d24` el script saldría con código 2 por el formato de credenciales (H-05) y, corregido eso, C-15 daría FAIL (H-01) |

Comprobaciones de §14 que se pueden anticipar desde fuera: C-01, C-02, C-17, C-18 y
C-20 pasarían (§4). C-15 fallaría. El resto necesita credenciales.

## 7. Copia protegida (`Q-S3-DELETE-RISK = copia_protegida_antes`)

### 7.1 Estado en `ab046d24`

No existe. `docs/01` lo deja escrito: «Mitigación pendiente: segunda copia fuera de
alcance de esa clave»; `docs/12` punto 7 lo plantea como pregunta al contrato. No hay
segundo bucket, ni volumen, ni proceso, ni clave adicional (`garage-init.py` solo crea
los dos buckets y las cuatro claves de §3.4). La puerta 3 de ANS-0011 §7 («copia
protegida implementada, aislada y probada») está abierta.

### 7.2 Requisitos literales del propietario (ANS-0011 §4)

Copia de cada respaldo completo y su manifiesto, fuera del alcance de las credenciales
entregadas a MainSpot; proceso e identidad exclusivos del KVM 4; preferir almacenamiento
separado del espacio operativo de Garage con permisos de sistema; no basta un prefijo
del mismo bucket; verificar la integridad al copiar y conservar evidencia de
correspondencia; probar con datos sintéticos que la writer no puede borrar, modificar
ni alterar la retención de la copia; expiración controlada y auditable con los mismos
límites (14 días, sin copias indefinidas); probar la recuperación desde la copia con los
originales borrados; nunca la clave de descifrado en el KVM 4.

### 7.3 PROPUESTA — opciones técnicas en Garage / KVM 4

Elementos comunes a todas las opciones:

- **Qué se copia**: solo respaldos **completos** según §5.3: el copiador lee el
  manifiesto, lo valida con `reference/manifest_tool.py verify --manifest M
  --manifest-key <clave> --object O` (reglas 1, 2, 4 y 5; la regla 3 necesita la clave y
  **no se aplica** en el KVM 4), y comprueba `HeadObject` (`Content-Length`,
  `x-amz-checksum-sha256`). Objetos sin manifiesto no se copian.
- **Cuándo**: cada hora (misma cadencia que el reintento del productor, §8.2), de modo
  que la copia exista menos de 1 h después de completarse el respaldo; la ventana de
  exposición al borrado por la writer queda en ≤ 1 h.
- **Expiración**: 14 días desde `created_at` (parseado de la clave, §7.3 del contrato),
  nunca más de 16; auditada por objeto en un `audit.jsonl` propio. Prohibido retener
  indefinidamente (ANS-0011 §4).
- **Evidencia**: por cada copia, una línea con `backup_id`, `object.key`, `size_bytes`,
  `sha256` del manifiesto, `sha256` recalculado de la copia y resultado; sin secretos.
- **Lectura del origen**: con una clave **de solo lectura** sobre `mainspot-backups`
  (puede ser `mainspot-backup-reader`, que ya existe, o una `mainspot-backup-guard-read`
  propia). Nunca con la writer.
- **Prueba obligatoria (sintética)**: subir pares objeto+manifiesto de prueba con la
  writer, esperar la copia, borrar los originales y alterar/eliminar el ciclo de vida
  con la writer, comprobar que la copia sigue intacta y restaurarla con
  `manifest_tool.py verify`; probar también que la writer recibe `403` (opción A) o no
  tiene ruta alguna (opciones B y C) hacia la copia.

| | **A. Segundo bucket en Garage + `CopyObject`** | **B. Volumen propio fuera de Garage (recomendada)** | **C. Como B, con `rclone`** |
|---|---|---|---|
| Diseño | Bucket `mainspot-backups-guard` (cuota propia, sin sitio web). Clave `mainspot-backup-guard`: read en `mainspot-backups` + read/write en `-guard`; vive solo en el contenedor, usuario dedicado. Proceso horario: lista manifiestos, valida, `CopyObject` (`x-amz-copy-source`) del objeto y del manifiesto a la misma clave en `-guard`, luego `HeadObject` del destino y comparación de `x-amz-checksum-sha256`/tamaño. Regla de ciclo de vida de 14 d en `-guard` (solo la clave guard puede tocarla) | Volumen propio montado en un **contenedor aparte** (no en el de Garage) o, como mínimo, en una ruta propiedad de un usuario de sistema propio 0700. Proceso horario con la clave de solo lectura (su origen autorizado en el cortafuegos hacia el puerto S3 interno): descarga objeto + manifiesto a un temporal, valida (`manifest_tool.py verify`), escribe de forma atómica (`rename`) en `<volumen>/v1/<deployment_id>/postgres/<db>/<YYYY>/<MM>/<DD>/`, `0400`. Expiración por `created_at` del nombre. Nadie fuera de ese contenedor tiene ruta de escritura; la writer no tiene ninguna ruta | Igual que B, usando `rclone copy --immutable --checksum` desde el remoto S3 (clave de solo lectura) al volumen, y `rclone delete --min-age 14d` para expirar; verificación con `rclone check --download` |
| Ventajas | Sin nueva superficie de sistema de archivos; copia en el servidor (`CopyObject`) sin pasar por la red; Garage verifica los bloques; restauración con el mismo cliente S3 (§11.2 cambia solo el bucket); la cuota y el monitor existentes se reutilizan | Cumple la preferencia del propietario («almacenamiento separado del espacio operativo de Garage»); sobrevive a un fallo lógico de Garage, a una fuga del `admin_token` y a cualquier operación S3; archivos planos que se verifican con `sha256sum` y `manifest_tool.py`; la expiración es un `unlink` auditado; sin dependencias nuevas (Python 3 ya está) | Herramienta probada; `--immutable` impide sobrescrituras; checksums MD5 (`ETag` de una parte, verificado en `VERIFICATION.md` §5) |
| Límites | Sigue dentro de Garage: comparte `admin_token`, metadatos LMDB, errores de bloque y el `replication_factor = 1`; la clave guard es una segunda credencial capaz de borrar la copia (se mitiga manteniéndola solo en el contenedor, como hoy `mainspot-s3-retention`); si la writer compromete el ciclo de vida de `mainspot-backups` antes de la copia horaria, se pierde el objeto de esa hora; el propietario no puede comprobar la copia desde fuera salvo que `mainspot-backup-reader` reciba también lectura sobre `-guard` (variante A') | Mismo disco físico: no protege de la pérdida del VPS (aceptado en ANS-0011 §5); segunda ruta de restauración distinta de S3 (hay que documentarla en §11); capacidad adicional (14 × tamaño del respaldo, hoy < 2 MB); nuevo contenedor o usuario que mantener; en un contenedor no privilegiado no se puede usar `chattr +i` (sin `CAP_LINUX_IMMUTABLE`), la protección son permisos y el aislamiento del contenedor | Dependencia de terceros (el repositorio declara «sin dependencias de terceros fuera de Garage»); `rclone` no entiende el manifiesto de §5: la validación de §5.3 sigue necesitando `manifest_tool.py`; su expiración se basa en la fecha del archivo, no en `created_at` |
| Verificación desde fuera | Con la writer: `HeadBucket`/`ListObjectsV2`/`DeleteObject`/`PutBucketLifecycle` sobre `-guard` → `403` (nueva comprobación C-21). Con `mainspot-backup-reader` (variante A'): listar `-guard` y comparar inventario y `x-amz-checksum-sha256` con `mainspot-backups` (C-22) | No hay ruta S3: desde fuera se verifica que la writer no alcanza nada (no hay nada que alcanzar) y el resto por **evidencia publicada** del KVM 4: `audit.jsonl` del guardián, listado con `sha256sum -c` y simulacro mensual de restauración desde el volumen con los originales borrados (ANS-0011 §4 lo exige). El propietario, que tiene acceso al host, puede repetirlo dentro del contenedor del guardián | Igual que B |
| Descartada: **D. Snapshots de los volúmenes de Garage** | Los snapshots del almacenamiento usado son copias completas; un snapshot diario conservado 14 días contiene objetos de hasta 28 días (viola la cota de 16 d y DEC-0027 salvo retención ≤ 2 d, que ya no es una copia de 14 d); restaurar un solo objeto exige levantar un Garage desde el snapshot; la coherencia de LMDB con Garage en marcha no está garantizada. No cumple «expiración coherente con los límites» | | |

Recomendación técnica (PROPUESTA): **B**, con el guardián leyendo con una clave de
solo lectura dedicada y expirando por `created_at`. Si el operador del KVM 4 prefiere
no crear otro contenedor, **A** es aceptable con A' (lectura del bucket guard para
`mainspot-backup-reader`) para que la conformidad lo pueda comprobar desde fuera.
En ambos casos el contrato v1.1 añade las comprobaciones C-21/C-22 y la obligación
S-16 (§9 de este informe).

## 8. Hallazgos

| Id | Severidad | Hallazgo | Evidencia |
|---|---|---|---|
| H-01 | **ALTA** | El servicio no instala la regla `Expiration` de §9, borra con `mainspot-s3-retention` y **sobrescribe cada hora** cualquier ciclo de vida distinto de `abort-incomplete-multipart-1d`. Contradice `ciclo_vida_servicio` (etiqueta literal) y hace imposible C-15, §10.1 y S-08 con el contrato v1.0.0. No es duplicidad: es exclusión mutua | `mainspot-s3-retention.py` líneas 47–95 (`LIFECYCLE`, `ensure_lifecycle` con `fix=True`), `run_once`; `install-ops.sh` (`--ensure-lifecycle --initial`); `LIFECYCLE_V1` en `check_s3_backup_contract.py` líneas 60–64; §5.2 |
| H-02 | **ALTA** | `halted` retiene sin límite cuando no hay objetos de menos de 14 d: supera los 16 d de §9 y puede superar los 30 d de DEC-0027; sin canal de aviso externo la «decisión humana» que presupone puede no llegar | `mainspot-s3-retention.py` `run_once` (`if expired and recent == 0`), `docs/09`; §5.3 |
| H-03 | **ALTA** | No existe copia protegida; la puerta 3 de ANS-0011 §7 está abierta | `garage-init.py` (buckets y claves), `docs/01` («mitigación pendiente»), `docs/12` punto 7; §7.1 |
| H-04 | **MEDIA** | Los avisos (deriva, `halted`, retención sin éxito en 26 h, bloques con error, cuota, disco) solo llegan al journal del contenedor; S-08 y §13 exigen aviso al propietario | `garage-health.py` (`emit`), `docs/05` («No hay canal de notificación externo») |
| H-05 | **MEDIA** | Nombres de credenciales distintos (`mainspot-backup-reader` ≠ `mainspot-backup-restore`; `mainspot-s3-retention` ≠ `mainspot-backup-operator`) y formato de archivo `S3_*` en vez de `AWS_*`: `check_s3_backup_contract.py` sale con código 2 con los `.env` del servicio | `garage-init.py` `KEYS`/`write_creds`; `docs/07`; `load_credentials` líneas 76–91; `VERIFICATION.md` §4 |
| H-06 | **MEDIA** | Las suites del servicio escriben prefijos de prueba (`tests/`, `persist/`, `drill/`, `retention-test/`) en el bucket de producción; S-06 y §7.3 exigen bucket exclusivo (`v1/` y `_conformance/`). `retention-test.sh` se protege (R0) pero `run-s3-tests.sh`, `persistence-test.sh` y `restore-drill.sh` no. Además `_conformance/` expiraría a 14 d en vez de 1 d con el proceso actual | `evidence/02`, `evidence/06`, `evidence/07`; `retention-test.sh` R0; `mainspot-s3-retention.py` (sin filtro de prefijo) |
| H-07 | **BAJA** | Edad medida por `LastModified` y no por `created_at`. Compatible con la cota de 16 d (§5.2), pero el manifiesto puede sobrevivir al objeto ≤ 1 h y la definición difiere de §9 | `mainspot-s3-retention.py` `run_once`; `s3sig.py` línea 260 |
| H-08 | **BAJA** | `scripts/versions.env` lo referencian todos los scripts (`source scripts/versions.env`) y `docs/03`, `docs/11` (CP-A2), pero queda excluido por el patrón de ignorados del repositorio y **no está en el commit**: un clon limpio no puede ejecutar `install-*.sh`, `deploy-nginx.sh` ni las suites, y la fijación `GARAGE_SHA256` solo vive en `docs/02` y en evidencias | `git ls-files` no lo lista; el repositorio lo ignora |
| H-09 | **BAJA** | El bloque del puerto 80 devuelve `Server: nginx/1.24.0 (Ubuntu)` (`server_tokens off` solo está en el bloque 443) | §4.2 |
| H-10 | **INFO** | Dos emisiones del certificado el 2026-10-22 (`notBefore` 07:00:51 en `evidence/01`; 08:00:22 en vivo). Let's Encrypt limita a 5 certificados duplicados por semana | §4.1, `evidence/01` líneas 211–216 |
| H-11 | **INFO** | §6.1 («certificado autofirmado… No conforme») y §17 R4 del contrato están desactualizados: el certificado es válido | §4.1 |
| H-12 | **INFO** | Garage devuelve `access-control-allow-origin: *` en las respuestas de error. No es una configuración CORS del bucket (no hay `PutBucketCors`: solo `owner` podría); sin efecto sobre una API SigV4 | §4.2 |
| H-13 | **BAJA** | Una desviación parcial del reloj del KVM 4 adelantaría borrados (proceso y worker nativo por igual) sin disparar `halted`; la detección queda del lado de MainSpot (§10.1, número de respaldos entre 13 y 16) | `mainspot-s3-retention.py`; §6.5 |
| H-14 | **INFO** | El servicio describe en `docs/09` y `docs/12` una convención de claves y metadatos (`<entorno>/…-<uuid>.dump.<ext>`, `x-amz-meta-sha256`) anterior al contrato; debe sustituirla por §7.3 y §5 al reconciliar | `docs/09`, `docs/12` |

## 9. Qué debe cambiar en el contrato v1.1

1. **§2.2 y §2.3**: registrar ANS-0011 (DEC pendiente de ingestión) para `Q-S3-DESTINATION`,
   `Q-S3-RETENTION-ENFORCEMENT`, `Q-S3-DELETE-RISK`, `Q-S3-SINGLE-NODE`; añadir a la puerta
   de activación las siete condiciones de ANS-0011 §7 (incluida la copia protegida y la
   restauración demostrada desde ella).
2. **§6.1 y §17 R4**: sustituir el estado «autofirmado» por lo observado (§4.1 de este
   informe); R4 pasa a cerrado. S-02: aclarar que los procesos del propio KVM 4 pueden
   usar `http://127.0.0.1:3900` dentro del contenedor.
3. **§6.4 (credenciales)**: adoptar los nombres que ya existen en Garage —
   `mainspot-backup-reader` (en lugar de `mainspot-backup-restore`) y
   `mainspot-s3-retention` como clave del operador (en lugar de
   `mainspot-backup-operator`) — o exigir el renombrado en el KVM 4 (S-14: avisar
   antes). Admitir el formato `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` además de
   `AWS_*` en §6.4 y en `load_credentials` de la conformidad, o fijar uno solo y
   documentar la conversión.
4. **§9**: según la respuesta a P-1 (§11). Si se confirma la lectura literal (regla
   nativa): §9 no cambia de fondo; añadir que el servicio PUEDE ejecutar un vigilante
   que restaure la configuración y audite por objeto, pero NO DEBE borrar objetos ni
   retener más allá de 16 días por ninguna salvaguarda. Si el propietario eligiera el
   proceso como ejecutor: reescribir §9 (edad por `LastModified`, cadencia horaria,
   `halted` acotado a 16 d), §10.1 y C-15 (configuración esperada), S-08.
5. **§10.1 / S-08**: exigir un canal de aviso al propietario fuera del KVM 4 (H-04) y
   la comprobación del inventario con edad desde `created_at` también en el servicio.
6. **§7.3 / S-06**: declarar que el bucket `mainspot-backups` solo admite `v1/` y
   `_conformance/`; las suites del servicio DEBEN usar otro bucket (por ejemplo
   `mainspot-backups-lab`) una vez activada la transferencia (H-06).
7. **Copia protegida (nuevo §9.2 o §17 R1)**: obligación **S-16** con los requisitos de
   ANS-0011 §4 y la opción elegida en §7.3 de este informe; comprobaciones **C-21**
   (la writer no alcanza la copia) y **C-22** (correspondencia copia↔original, si la
   copia es un bucket legible por `mainspot-backup-reader`); §11 añade la restauración
   desde la copia protegida; §10.2 añade a la prueba mensual una restauración desde la
   copia protegida con los originales ausentes.
8. **§17**: R1 pasa de PENDIENTE a «mitigado por S-16» cuando exista la copia; R2 se
   registra como aceptado (`nodo_unico`) con la nota literal de ANS-0011 §5.
9. **§14 / S-15**: exigir que el informe de conformidad se ejecute contra
   `ab046d24` o posterior **después** de corregir H-01 y H-05, y que incluya el
   commit del servicio.

## 10. Qué debe cambiar en el KVM 4 (`hachxaan/mainspot-s3-backups`)

1. (H-01) Instalar exactamente las dos reglas de §9 con la clave del operador y hacer
   que `mainspot-s3-retention` las tome como configuración esperada (`ensure_lifecycle`
   comparando con §9, no con `abort-incomplete-multipart-1d`). Si se confirma P-1 en su
   lectura literal: eliminar la rama de borrado (`client.delete`) y convertir el
   proceso en vigilante (§5.4). Con la variante «proceso ejecutor», acotar `halted` a
   `created_at + 16 d` como máximo.
2. (H-02) En cualquier caso, ninguna salvaguarda puede retener más de 16 días.
3. (H-03) Implementar la copia protegida (§7.3, opción B o A/A'), con su clave de solo
   lectura, su proceso, su auditoría, su expiración y la prueba sintética exigida por
   ANS-0011 §4; publicar la evidencia.
4. (H-04) Añadir un canal de aviso al propietario (correo, Telegram u otro) para los
   eventos `crit`/`warn` del monitor; documentarlo en `docs/05` y `runbook.md`.
5. (H-05) Renombrar las claves a los nombres del contrato o acordar los nombres en v1.1
   (S-14); generar, solo para la conformidad, archivos con `AWS_ACCESS_KEY_ID=` y
   `AWS_SECRET_ACCESS_KEY=` (0600) a partir de los `.env`.
6. (H-06) Crear un bucket de laboratorio para las suites; prohibir en `lib.sh` que
   `run-s3-tests.sh`, `persistence-test.sh` y `restore-drill.sh` escriban en
   `mainspot-backups` cuando contenga objetos bajo `v1/`.
7. (H-08) Confirmar `scripts/versions.env` en el repositorio (no contiene secretos:
   versión, SHA-256 e imagen).
8. (H-09) Mover `server_tokens off` al bloque del puerto 80 o al contexto `http`.
9. (H-14) Sustituir en `docs/09` y `docs/12` la convención preliminar por §5 y §7.3 del
   contrato; añadir la tabla «contrato vs. implementado» con el SHA del contrato v1.1.
10. (S-15) Ejecutar `check_s3_backup_contract.py` desde fuera del KVM 4 contra el
    endpoint real y publicar el informe en `evidence/`.

## 11. Preguntas que solo el propietario puede decidir

| Id | Pregunta | Por qué no se decide aquí |
|---|---|---|
| P-1 | ¿Se mantiene la lectura literal de `ciclo_vida_servicio` (la **regla de ciclo de vida del bucket** borra; `mainspot-s3-retention` vigila y audita pero no borra), o se acepta que el **proceso del KVM 4** sea el ejecutor del borrado y el contrato v1.1 lo describa (edad por `LastModified`, cadencia horaria, `halted` acotado a 16 días)? | La etiqueta elegida nombra un mecanismo concreto y `Q-NOTES` §2 delega la reconciliación; cambiar el mecanismo es un cambio de política que ANS-0011 pide que no sea silencioso |
| P-2 | Para la copia protegida, ¿se prefiere la opción B (volumen propio fuera de Garage, verificable por evidencia del KVM 4) o la A/A' (segundo bucket en Garage, verificable desde fuera con `mainspot-backup-reader`)? | ANS-0011 §4 expresa preferencia por almacenamiento separado pero admite «mecanismos equivalentes»; las dos cumplen los requisitos con límites distintos (§7.3) |
| P-3 | ¿Qué canal de aviso al propietario se autoriza para el KVM 4 (H-04) y con qué datos (hoy los avisos no contienen secretos, pero sí claves de objeto)? | Implica un servicio externo o una cuenta del propietario |

## 12. Límites de este informe

- No se usaron credenciales ni se envió ninguna petición S3 firmada; la configuración
  **en vivo** del ciclo de vida del bucket, los permisos efectivos y la versión de
  Garage en ejecución se deducen del código y de las evidencias del repositorio
  (`evidence/01`, `evidence/02` del 2026-10-22 08:35–08:36 UTC), no se observaron.
- TLS 1.1 no se pudo probar desde este equipo (OpenSSL local sin TLS 1.1).
- El comportamiento del worker de ciclo de vida de Garage (edad 14–15 días, ejecución
  a las 00:00 UTC) se toma de §9 del contrato y de `VERIFICATION.md` §9; no se repitió
  la lectura del código fuente de Garage.
- No se modificó ningún archivo del contrato ni del HDC; este informe es el único
  archivo nuevo. El clon temporal se borró al terminar (§2.1).
- Esta es la versión publicable del informe; la versión íntegra, con los detalles de
  la infraestructura (direcciones, contenedores, rutas, usuarios), se conserva fuera
  del repositorio público.
