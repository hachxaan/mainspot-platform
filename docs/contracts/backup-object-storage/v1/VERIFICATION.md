# Verificación del contrato v1 (2026-10-22)

Lo que se comprobó al redactar `CONTRACT.md` v1.0.0, con el resultado observado.
Todas las pruebas usaron claves y datos desechables. No se usó ningún secreto real y
no se subió ningún respaldo real a ningún servicio.

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
