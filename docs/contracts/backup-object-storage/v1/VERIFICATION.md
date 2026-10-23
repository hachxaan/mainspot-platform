# Verificación del contrato v1 (2026-10-22)

Lo que se comprobó al redactar `CONTRACT.md` v1.0.0 (§1–§9) y v1.1.0 (§10), con el
resultado observado. Todas las pruebas usaron claves y datos desechables. No se usó
ningún secreto real y no se subió ningún respaldo real a ningún servicio.

## 1. Formato de cifrado (§4.2)

- Con OpenSSL 3.0.13 se generó una clave como la del productor (`openssl rand -base64 48`,
  65 bytes con el fin de línea) y se cifró un archivo con el comando exacto de §4.2.
- El archivo empieza por `53 61 6c 74 65 64 5f 5f` (`Salted__`) seguido de 8 bytes de sal.
- Se descifró **sin OpenSSL**, con Python `cryptography`:
  PBKDF2-HMAC-SHA256(primera línea de la clave, sal, 600000, 48 bytes) → clave AES (32) + IV (16),
  AES-256-CBC y quitar el relleno PKCS#7.
  - Resultado: `independent_decrypt_equal True`, contraseña de 64 bytes.
- `-pass file:` conserva un `\r` final: un archivo cifrado con la línea `abc\r\n` no
  se descifra con la contraseña `abc` y sí con `abc\r`.
- En el respaldo real más reciente del equipo de MainSpot (120 912 bytes) solo se
  descifró la cabecera, en memoria. El volcado empieza por `50 47 44 4d 50 01 0f 00`:
  `PGDMP` y versión de archivo 1.15.0, con `pg_dump` 16.15. No se imprimió la clave.

## 2. `key_id`, MAC y vector de prueba (§7.4, §7.5)

- La función HKDF de `reference/manifest_tool.py` da el resultado esperado en el caso
  de prueba 1 de RFC 5869. Para `info=key-id` y `info=manifest-mac` coincide con
  `cryptography` (`HKDF(SHA256)`).
- El vector de §7.5 se recalculó con un script independiente, que construye a mano
  las nueve líneas del MAC y usa `cryptography` para la HKDF:
  - `msbk1-4bf859a355f2abcf`
  - `dd6e517b7a3714c5801655fd0f458c6feae92eb16bf84763bf74a15d4f3e065a`
  - Son los mismos valores que da la herramienta.
- `python3 reference/manifest_tool.py selftest` termina con código 0. Comprobaciones:
  - `key_id` y `mac` coinciden con el vector;
  - la estructura es válida;
  - el manifiesto se valida con la clave y su clave de almacenamiento;
  - un SHA-256 sustituido (estructura válida) lo rechaza **el MAC**;
  - otra clave se rechaza por `key_id`;
  - un manifiesto válido leído desde otra clave lo rechaza la regla 5 de §5.3;
  - un `deployment_id` con salto de línea se rechaza.
- Los mismos resultados se obtienen sin `jsonschema` instalado (validación
  estructural propia).
- Códigos de salida de `verify`:
  - manifiesto truncado o de tipo incorrecto: 1 (`malformed manifest`);
  - archivo inexistente o clave con permisos `0644`: 2;
  - un archivo de clave con `\r\n` da otro `key_id` que el mismo con `\n`, igual que OpenSSL.

## 3. Esquema y ejemplo (§5)

- `manifest.schema.json` es un JSON Schema 2020-12 válido (`check_schema`, jsonschema 4.26.0).
- `examples/manifest.example.json` (vector de prueba, con campos `source` informativos):
  - no tiene errores de esquema;
  - `manifest_tool.py verify --key <clave del vector> --manifest-key <su clave>` es válido.

## 4. Conformidad contra Garage en laboratorio (§14)

Garage oficial en Docker (`dxflrs/garage:v1.2.0` y `dxflrs/garage:v2.4.1`):

- un nodo, `replication_factor = 1`, `db_engine = "sqlite"`, `s3_region = "garage"`;
- API S3 solo en `127.0.0.1`, por HTTP y sin proxy TLS;
- bucket `mainspot-backups`;
- claves `backup-writer` (read+write) y `backup-restore` (read);
- ciclo de vida de §9 aplicado con una clave read+write.

Resultado de `conformance/check_s3_backup_contract.py --lab-allow-http` (código de salida 0 en ambas):

| Comprobación | v1.2.0 | v2.4.1 |
|---|---|---|
| C-01 TLS, C-18 HTTP en claro, C-20 puertos internos | SKIP (laboratorio) | SKIP |
| C-02 reloj | PASS | PASS |
| C-03, C-04 SigV4 + path-style + región, ambas claves | PASS | PASS |
| C-05 `PutObject` con `Content-MD5` | PASS | PASS |
| C-06 `Content-MD5` incorrecto → `400 InvalidDigest`, `HEAD` 404 | PASS | PASS |
| C-19 `x-amz-checksum-sha256` verificado y devuelto por `HeadObject` | PASS | PASS |
| C-07, C-08 metadatos y bytes con la clave de restauración | PASS | PASS |
| C-09 listado paginado | PASS | PASS |
| C-10, C-11 multiparte y aborto | PASS | PASS |
| C-12, C-13, C-14 la clave de restauración no sube, no borra, no cambia el ciclo de vida | PASS | PASS |
| C-15 ciclo de vida exactamente igual a §9 | PASS | PASS |
| C-16 limpieza, C-17 acceso anónimo denegado | PASS | PASS |

En laboratorio el informe dice `"conformant": false`, porque C-01, C-18 y C-20 no se
ejecutan. La conformidad real exige el endpoint público.

Pruebas negativas:

- un ciclo de vida con una regla adicional (`v1/mainspot-pilot/`, 1 día) da **C-15 FAIL**;
- endpoint `http://` sin `--lab-allow-http`: código 2;
- archivo de credenciales sin `AWS_ACCESS_KEY_ID`: código 2;
- archivo de credenciales inexistente o con permisos `0644`: código 2;
- clave de restauración con escritura indebida y un ciclo de vida previo distinto (`v1/`, 2 días):
  - **C-15 FAIL** muestra la configuración previa, porque se ejecuta antes que C-14;
  - C-12, C-13 y C-14 dan FAIL;
  - al terminar, el bucket queda con las reglas de §9.

## 5. Comportamientos de Garage observados (§8.1, §17)

Prueba aparte con claves read+write, read y solo owner, igual en v1.2.0 y v2.4.1
(salvo el código de error de un ciclo de vida inexistente: `404 NoSuchLifecycleConfiguration` en v2.4.1, `404` en v1.2.0):

| Comportamiento | Resultado |
|---|---|
| `Get/Put/DeleteBucketLifecycle` con read+write | permitido |
| `PutBucketLifecycle` y `DeleteBucketLifecycle` con read | `403 AccessDenied` |
| Ciclo de vida con una clave solo owner | `403 AccessDenied` (owner no implica read ni write) |
| CORS y sitio web | solo owner |
| `PutBucketVersioning`, `PutObjectLockConfiguration` | `501 NotImplemented` |
| `DeleteObject`, `DeleteObjects`, sobrescritura con read+write | permitidos |
| `PutObject` con `If-None-Match: *` sobre un objeto existente | **aceptado y sobrescrito** (la condición se ignora) |
| `x-amz-checksum-sha256` incorrecto | `400 InvalidDigest` |
| `HeadObject` con `x-amz-checksum-mode: ENABLED` | devuelve el SHA-256 guardado |
| `ETag` de una parte | MD5 en hex (el contrato no depende de ello) |
| `ETag` multiparte | `"<hex>-<número de partes>"` |
| Cliente boto3 con checksums flexibles por defecto (`when_supported`) | subida aceptada; el contrato fija `when_required` igualmente (§6.3) |
| `GetObject` con `Range` | funciona (no se usa) |

## 6. Flujo completo en laboratorio (§8.2, §8.3, §11)

Contra Garage v2.4.1, con:

- un volcado `pg_dump -Fc` real de una base desechable (PostgreSQL 16, una tabla de 500 filas, 3 entradas de índice);
- cifrado con el comando de §4.2 y una clave desechable (3 520 bytes).

| Paso | Resultado |
|---|---|
| `HEAD` del objeto | 404 (no existía) |
| `PutObject` con `Content-MD5`, `x-amz-checksum-sha256`, `x-amz-meta-sha256`, `x-amz-meta-backup-id` | aceptado |
| Verificación `HeadObject` (tamaño + SHA-256 guardado) | igual |
| Verificación `GetObject` (SHA-256) | igual |
| Manifiesto (`manifest_tool.py build`) | subido después del objeto |
| Restauración con la clave de solo lectura | lista, toma el manifiesto más reciente, descarga y `verify --manifest-key --object --key` → válido |
| Objeto alterado (un byte añadido) | rechazado: `size mismatch` |
| El mismo manifiesto válido copiado a una clave «más nueva» (aparece primero al listar) | rechazado: regla 5 (clave de almacenamiento) |
| Descifrado con OpenSSL | la cabecera del volcado es `PGDMP` |
| Limpieza | objetos borrados |

## 7. Endpoint real

El 2026-10-22 `s3.mainspot.canonflow.dev` resolvía. Solo se hicieron conexiones TCP
y una petición HTTP sin firma. No se envió ninguna petición S3 firmada: no había
credenciales y el servicio está en construcción.

| Prueba | Resultado | Comprobación |
|---|---|---|
| Puerto 443 | certificado autofirmado emitido para otro nombre; la validación TLS falla | C-01 fallaría |
| Puerto 80 | `301` a `https://s3.mainspot.canonflow.dev/mainspot-backups/` | C-18 pasaría |
| Puertos 3900, 3901, 3902 y 3903 | sin respuesta (filtrados) | C-20 pasaría |

Actualización v1.1 (misma fecha, 11:35 UTC, también sin credenciales): el puerto 443
presenta un certificado de Let's Encrypt válido para el nombre (del 2026-10-22 al
2027-01-20), `Verification: OK`, TLS 1.2 y 1.3; C-01 pasaría. Detalle y salidas en
`infra-reconciliation-ab046d24.md` §4; estado recogido en `CONTRACT.md` §6.1 y §17 R4.

## 8. Revisión independiente

Un revisor sin acceso a la redacción revisó los siete archivos contra los scripts
reales de MainSpot y el código de Garage v2.4.1. Encontró 4 problemas mayores y 13
menores; todos se corrigieron antes de publicar:

- ventana de subida de 24 h y edad medida desde `created_at` (§8.2, §9, §10.1);
- regla 5 de §5.3 (clave de almacenamiento del manifiesto);
- C-14 sin riesgo de alterar el ciclo de vida;
- C-15 exacto;
- códigos de error reales de Garage (§12, §13) y control del reloj en el productor (§6.5);
- C-20 (puertos internos);
- entropía mínima de la contraseña;
- `\r` en la clave;
- códigos de salida de las herramientas;
- `boto3` ≥ 1.36.

Una segunda revisión confirmó las 17 correcciones. Detectó cuatro problemas nuevos, que también se corrigieron:

- custodia de las credenciales para ejecutar la conformidad fuera del KVM 4 (§6.4);
- reintento horario y aviso E-UPLOAD-WINDOW dentro de la ventana de 24 h (§8.2, §13);
- 404 esperado excluido de E-REQUEST;
- C-15 ejecutada antes que C-14.

Las pruebas de los §2, §4 y §6 se repitieron después de las correcciones.

## 9. Límites de esta verificación

- No se probaron TLS ni el proxy inverso del servicio real con peticiones S3: en
  laboratorio C-01, C-18 y C-20 se omiten y el resto no pasó por HTTPS.
- No se observó la expiración real del ciclo de vida: necesita días. Solo se
  comprobó que la configuración se acepta y se lee igual. El cálculo de §9 sale del
  código fuente de Garage v2.4.1 (lo leyó el revisor) y la cota de 16 días se vigila
  en operación (§10.1).
- La página de compatibilidad S3 de Garage está fechada en 2022. Los comportamientos
  de §5 son los observados en v1.2.0 y v2.4.1. Otra versión debe repetir §14.
- El productor de §8 no está implementado en MainSpot. El flujo del §6 de este
  documento es una simulación de laboratorio.

## 10. v1.1 — copia protegida, C-21 y C-22 en laboratorio (2026-10-22)

Pruebas de los cambios de `1.1.0` (`CHANGELOG.md`): `conformance/check_s3_backup_contract.py`
con C-21, C-22, `--guard-bucket`, credenciales `S3_*` y estado MANUAL, y la prueba
sintética de §9.2.6 ejecutada a mano con `boto3` 1.43 y `reference/manifest_tool.py`.
Lo demás (C-01…C-20) no cambió y volvió a pasar en cada ejecución.

### 10.1 Laboratorio

Garage oficial en Docker (`dxflrs/garage:v2.4.1`), un nodo, `db_engine = "sqlite"`,
`replication_factor = 1`, `consistency_mode = "consistent"`, `s3_region = "garage"`,
API S3 solo en `127.0.0.1` por HTTP (sin proxy TLS), RPC y administración en loopback
del contenedor. Borrado al terminar.

| Elemento | Valor |
|---|---|
| Buckets | `mainspot-backups` (ciclo de vida exacto de §9.1) y `mainspot-backups-guard` (regla de referencia de §9.2.4) |
| Clave **writer** (`lab-writer`) | read + write en `mainspot-backups`; nada en el guard |
| Clave **restore** (`lab-restore`) | read en `mainspot-backups` y read en `mainspot-backups-guard` (opción A') |
| Clave **guard** (`lab-guard`) | read en `mainspot-backups`; read + write en `mainspot-backups-guard` |
| Archivos de credenciales | formato del servicio (`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) y formato `AWS_*`, ambos `0600` |
| Datos sintéticos | tres pares objeto + manifiesto bajo `v1/mainspot-pilot/postgres/mainspot/2026/10/{20,21,22}/`, objetos `Salted__` + 3 000 bytes aleatorios, manifiestos de `manifest_tool.py build` con la clave pública de §7.5; copias de los dos primeros pares en el guard con `CopyObject` (clave **guard**); el tercero sin copia (simula «pendiente») |

Comportamientos de Garage v2.4.1 observados con esta configuración (base de C-21/C-22):

| Operación | Resultado |
|---|---|
| `HeadBucket` de la writer sobre `mainspot-backups-guard` (existe, sin permiso) | `403` |
| `HeadBucket` de la writer sobre un bucket inexistente | `404` |
| `ListObjectsV2`, `PutObject`, `DeleteObject`, `PutBucketLifecycleConfiguration`, `GetBucketLifecycleConfiguration` de la writer sobre el guard | `403 AccessDenied` en todos; el ciclo de vida del guard no cambió |
| `HeadBucket` y `ListObjectsV2` de restore sobre el guard (A') | `200` |
| `CopyObject` con la clave guard (`mainspot-backups` → guard, misma clave) | `200`; `HeadObject` con `x-amz-checksum-mode: ENABLED` en la copia devuelve el **mismo** `x-amz-checksum-sha256`, el mismo tamaño y los mismos `x-amz-meta-*` que el original |

### 10.2 Ejecuciones del script (`--lab-allow-http`, Garage v2.4.1)

| Ejecución | Configuración | C-21 | C-22 | Código de salida |
|---|---|---|---|---|
| 1 | laboratorio de 10.1, credenciales `S3_*` | PASS: «writer key denied (403) on guard bucket: HeadBucket, ListObjectsV2, PutObject, DeleteObject, PutBucketLifecycleConfiguration» | PASS: «3 complete backups under v1/, 4 objects compared with 'mainspot-backups-guard' by size and SHA-256; 2 pending (< 7200 s), 0 copies without original» | 0 |
| 2 | igual, `--guard-copy-grace 0` (el tercer par ya no se tolera) | PASS | **FAIL**: «missing copies: [….../2026/10/22/mainspot-db-20261022T081500Z.dump.enc, ….manifest.json]» | 1 |
| 3 | `--guard-bucket mainspot-backups-guard-absent` (simula la opción B) | PASS en la primera redacción de 1.1.0: «no guard bucket … (HeadBucket 404:404) … (section 9.2, option B)». **Tras la revisión (§10.5) es MANUAL**: desde fuera no se distingue la opción B de un nombre erróneo | **MANUAL**: «copy/original correspondence must be shown by the published evidence of the service (section 9.2, option B)»; `"manual": ["C-22"]` (tras §10.5, `["C-21", "C-22"]`) | 0 |
| 4 | **caso negativo**: writer con read + write en el guard | **FAIL**: «writer key reaches the guard bucket: HeadBucket allowed; ListObjectsV2/PutObject/DeleteObject/PutBucketLifecycleConfiguration: operation succeeded but must be denied» | PASS | 1 |
| 5 | restore sin lectura del guard (opción A sin A') | PASS | **MANUAL**: «restore key cannot read the guard bucket (403:403): correspondence must be shown by published evidence (section 9.2, option A without A')» | 0 |
| 6 | una copia del guard sobrescrita con otro contenido del mismo tamaño | PASS | **FAIL**: «mismatches: ['….../2026/10/20/mainspot-db-20261020T081500Z.dump.enc (sha256 differs)']» | 1 |
| 7 | tras la prueba sintética de 10.3 (un par borrado del origen, copia intacta) | PASS | PASS: «2 complete backups …, 2 objects compared …, 2 copies without original (deleted originals are expected to survive in the guard)» | 0 |

Después de la ejecución 4 (writer indebidamente autorizada): el objeto de prueba que
la writer logró escribir en el guard se borró (0 objetos bajo `_conformance/` del
guard) y el ciclo de vida del guard quedó exactamente como antes
(`mainspot-backups-guard-v1-retention-14d`), porque C-21 envió la configuración que
restore había leído. Credenciales `AWS_*` (ejecución 2) y `S3_*` (las demás) dan el
mismo resultado. Todos los informes dicen `"contract_version": "1.1.0"`,
`"conformant": false` (laboratorio) e incluyen `"guard_bucket"` y `"manual"`; se
comprobó que ninguno contiene identificadores ni secretos de las claves.

Pruebas negativas de credenciales: archivo con `S3_ACCESS_KEY_ID` pero sin
`S3_SECRET_ACCESS_KEY` → código 2 («missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
(or S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY)»); el mismo archivo con permisos `0644` →
código 2 («permissions too open»).

### 10.3 Prueba sintética de §9.2.6 (opción A', a mano)

Sobre el par `2026/10/21/mainspot-db-20261021T081500Z` (copiado al guard en 10.1):

| Paso | Resultado observado |
|---|---|
| Con la writer: `DeleteObject` del objeto y del manifiesto en `mainspot-backups` | `HeadObject` de ambos → `404` |
| Con la writer: `PutBucketLifecycleConfiguration` en `mainspot-backups` con una sola regla `malicious-1d` (`Expiration: 1`, prefijo vacío) | aceptada; `GetBucketLifecycleConfiguration` devuelve solo `malicious-1d` |
| Con la writer: `DeleteObject` de la copia y `DeleteBucketLifecycle` del guard | `403 AccessDenied` en ambos |
| Copia en el guard | `x-amz-checksum-sha256` del objeto y del manifiesto idénticos a los de antes; ciclo de vida del guard intacto |
| Restauración desde la copia con restore (§11.4): `GetObject` de la copia del manifiesto y del objeto; `manifest_tool.py verify --manifest M --manifest-key <clave del guard> --object O --key <clave de §7.5>` | `{"valid": true, "backup_id": "mainspot-db-20261021T081500Z", "object_checked": true, "mac_checked": true, "storage_key_checked": true}`, código 0 |
| Configuración de §9.1 restaurada en `mainspot-backups` (en el laboratorio la reinstaló la prueba; en el KVM 4 lo hace el vigilante de §9.1) y ejecución 7 del script | C-21 PASS, C-22 PASS con «2 copies without original» |

El paso 6 de §9.2.6 (el vigilante restaura la configuración y audita la deriva) no se
puede observar en este laboratorio: no existe todavía el vigilante reconvertido
(`infra-reconciliation-ab046d24.md` H-01). Lo demás de la prueba quedó demostrado con
datos sintéticos.

### 10.4 Límites de esta verificación

- Solo se probó la opción A/A' (bucket guard en Garage). La opción B (volumen fuera
  de Garage) se verifica por evidencia del KVM 4; aquí solo se comprobó que el script
  la reconoce (ejecución 3 y §10.5 ejecución 3: C-21 y C-22 en MANUAL).
- La cadencia horaria y la expiración de la copia a 14 días desde `created_at` son
  obligaciones del proceso del KVM 4 (S-16), que no existe en `ab046d24`; no se
  observaron.
- La conservación de `x-amz-checksum-sha256` en `CopyObject` se observó en Garage
  v2.4.1 para objetos de una parte; para un original multiparte **no** se conserva
  (§10.5, ejecución 12) y C-22 recalcula el SHA-256 del cuerpo. El camino «el
  servicio no devuelve checksum» no se ejercitó.
- Como en §4, el laboratorio no pasa por HTTPS: C-01, C-18 y C-20 se omiten y el
  informe nunca es conforme. La conformidad real exige el endpoint público y, para la
  puerta de §2.3, el commit del servicio corregido (S-15).

### 10.5 Repetición tras la revisión independiente de 1.1.0 (2026-10-22, Garage v2.4.1)

Una revisión de solo lectura de `1.1.0` encontró 1 BLOCKER (publicar el informe de
reconciliación sin redactar), 3 MAJOR (C-22 fallaba de forma determinista con un
original de más de 14 días sin copia; C-22 daba PASS sin comparar nada; C-21 daba PASS
con un bucket guard inexistente, indistinguible de un nombre erróneo) y 14 MINOR.
Todas se corrigieron (`CHANGELOG.md`, «Tras la revisión independiente de 1.1.0») y el
laboratorio de §10.1 se reconstruyó desde cero (mismo Docker `dxflrs/garage:v2.4.1`,
`db_engine = "sqlite"`, dos buckets, tres claves, pares sintéticos construidos con
`manifest_tool.py build` y la clave pública de §7.5; borrado al terminar). Salidas
completas en `evidence/contracts/backup-object-storage-v1/07-lab-v1.1-review-fixes-*`
(fuera del contrato; sin identificadores ni secretos de las claves).

Comportamientos de Garage v2.4.1 observados además de los de §10.1:

| Operación | Resultado |
|---|---|
| `GetBucketLifecycleConfiguration` de restore sobre un bucket sin ciclo de vida | `404 NoSuchLifecycleConfiguration` |
| `DeleteBucketLifecycle` de la writer sobre el guard (sin permiso) | `403 AccessDenied` |
| `HeadObject` (`x-amz-checksum-mode: ENABLED`) de un objeto subido en multiparte con `x-amz-checksum-sha256` por parte | devuelve un valor **compuesto** (no es el SHA-256 del cuerpo) **sin** el sufijo `-N`; el `ETag` sí lleva `-2` |
| `CopyObject` (clave guard) de ese objeto multiparte | la copia queda como objeto de una parte: `ETag` sin sufijo y `x-amz-checksum-sha256` = SHA-256 del cuerpo; los bytes son idénticos. El checksum del original y el de la copia **difieren** aunque el contenido sea el mismo |

Por lo último, C-22 trata como compuesto cualquier checksum con `-` **o** cuyo `ETag`
termine en `-N`, y en ese caso recalcula el SHA-256 del cuerpo (la corrección M-8 de
la revisión, ampliada con el `ETag` porque Garage omite el sufijo).

| Ejecución | Configuración | C-21 | C-22 | Código de salida |
|---|---|---|---|---|
| 1 | laboratorio de 10.1 (tres pares de 2, 1 y 0 días: dos copiados, el tercero sin copia), credenciales `S3_*` | PASS: «… HeadBucket, ListObjectsV2, PutObject, DeleteObject, PutBucketLifecycleConfiguration» | PASS: «3 complete backups under v1/ …, 4 objects compared … 2 pending (< 7200 s), 0 originals past 14 d (copy expired as required), 0 copies without original …» | 0 |
| 2 | igual, `--guard-copy-grace 0`, credenciales `AWS_*` | PASS | **FAIL**: «missing copies: [….../mainspot-db-20261022T081500Z.dump.enc, ….manifest.json]; mismatches: []; a missing copy may also mean the copier rejected the manifest (section 9.2.3): validate it with manifest_tool.py verify» | 1 |
| 3 | `--guard-bucket mainspot-backups-guard-absent` (opción B o nombre erróneo) | **MANUAL**: «no guard bucket … (HeadBucket 404:404): either the protected copy is not an S3 bucket (section 9.2, option B) or the name is wrong; the absence of any path from the writer key must be shown by the published evidence of section 9.2.5» | **MANUAL** (opción B); `"manual": ["C-21", "C-22"]` | 0 |
| 4 | **caso negativo**: writer con read + write en el guard | **FAIL**: «HeadBucket allowed; ListObjectsV2/PutObject/DeleteObject/PutBucketLifecycleConfiguration: operation succeeded but must be denied». Después: 0 objetos bajo `_conformance/` del guard; ciclo de vida del guard = `mainspot-backups-guard-v1-retention-14d` (el que restore leyó) | PASS | 1 |
| 5 | restore sin lectura del guard (A sin A') | PASS | **MANUAL**: «restore key cannot read the guard bucket (403:403) …» | 0 |
| 6 | una copia sobrescrita con otro contenido del mismo tamaño | PASS | **FAIL**: «mismatches: ['….../mainspot-db-20261020T081500Z.dump.enc (sha256 differs)']» | 1 |
| 7 | **A-1**: se añade un original completo con `created_at` de hace 14 d 12 h **sin copia**; `--guard-copy-grace 0` | PASS | **FAIL solo por el tercer par** (0 días, sin copia): «4 complete backups …, 1 originals past 14 d (copy expired as required) …; missing copies: [….../mainspot-db-20261022T081500Z.dump.enc, ….manifest.json]». El original de 14 d 12 h **no** cuenta como `missing` | 1 |
| 7b | igual, con la gracia por defecto | PASS | PASS: «4 complete backups …, 4 objects compared …, 2 pending …, 1 originals past 14 d (copy expired as required) …» | 0 |
| 8 | **A-2**: bucket sin objetos bajo `v1/` | PASS | **MANUAL**: «0 complete backups …, 0 objects compared …; nothing compared: run with the synthetic pairs of section 9.2.6 present or rely on the evidence of section 9.2.5»; `"manual": ["C-22"]` | 0 |
| 8b | **A-2**: un solo par, aún pendiente de copia (< 2 h) | PASS | **MANUAL**: «1 complete backups …, 0 objects compared …, 2 pending …; nothing compared …» | 0 |
| 9 | **M-6**: archivo de credenciales con `AWS_ACCESS_KEY_ID=` y `AWS_SECRET_ACCESS_KEY=` vacíos | — | — | **2** («missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY)») |
| 10 | **M-7**: bucket guard **sin ciclo de vida** (`DeleteBucketLifecycle` con la clave guard) | PASS: «… HeadBucket, ListObjectsV2, PutObject, DeleteObject, **DeleteBucketLifecycle**» (la sonda cambia; nada se instala) | PASS | 0 |
| 10b | **M-7, caso negativo**: writer con read + write en el guard **y** guard sin ciclo de vida | **FAIL**: «… DeleteBucketLifecycle: operation succeeded but must be denied». Después: el guard **sigue sin ciclo de vida** (`404 NoSuchLifecycleConfiguration`; no se instaló la regla de referencia) y 0 objetos bajo `_conformance/` | PASS | 1 |
| 11 | tras la prueba sintética: un par borrado del origen, copia intacta | PASS | PASS: «2 complete backups …, 2 objects compared …, 2 copies without original …» | 0 |
| 12 | **M-8**: original de 5 MiB + 4 KiB subido en multiparte con `x-amz-checksum-sha256` por parte, copiado con `CopyObject` (checksums distintos entre original y copia, bytes idénticos) | PASS | PASS: «4 complete backups …, 6 objects compared …» (el SHA-256 del cuerpo se recalculó para ese objeto) | 0 |

En todas las ejecuciones las demás comprobaciones (C-02…C-17, C-19; C-01/C-18/C-20
omitidas por `--lab-allow-http`) quedaron en PASS, todos los informes dicen
`"contract_version": "1.1.0"` y `"conformant": false` (laboratorio), e incluyen
`"guard_bucket"` y `"manual"`; se comprobó programáticamente que ningún informe
contiene el identificador ni el secreto de ninguna clave del laboratorio.

No ejercitado aquí: la sonda `PutBucketLifecycleConfiguration` con la regla de
referencia de §9.2.4 (solo se usa cuando restore no puede leer el guard **y** este
tiene ciclo de vida; en la ejecución 5 la writer recibió 403 antes de que importara el
contenido), el camino «el servicio no devuelve `x-amz-checksum-sha256`» y C-20 con el
puerto 3900 añadido (omitida en laboratorio; contra el endpoint real, §7 ya observó
3900 filtrado).
