# Cambios del contrato `mainspot-backup-object-storage` (v1)

Versión semántica según `CONTRACT.md` §18. Cada versión se cita por commit (ver
`../README.md`). El manifiesto (`manifest.schema.json`, `reference/manifest_tool.py`,
`examples/manifest.example.json`) no ha cambiado entre `1.0.0` y `1.1.0`.

## 1.1.0 — 2026-10-22

Versión MENOR: incorpora las decisiones del propietario (DEC-0045…DEC-0054, sesiones
QS-0010 y QS-0011) y la reconciliación con la infraestructura
`hachxaan/mainspot-s3-backups` @ `ab046d2447bb2a60a0f0e2166a64151ef811aca8`
(`infra-reconciliation-ab046d24.md`). Añade comprobaciones y obligaciones; no cambia
formatos, rutas ni cifrado. La transferencia remota sigue **no activada**.

Por sección de `CONTRACT.md`:

| Sección | Cambio |
|---|---|
| Cabecera | Versión `1.1.0`; estado «Aprobado con condiciones»; `CHANGELOG.md` e `infra-reconciliation-ab046d24.md` entre los archivos del contrato. |
| §1 | Resumen: la regla del bucket borra y el vigilante no borra ni retiene objetos de `mainspot-backups`; copia protegida antes de activar; restauración también desde la copia; obligaciones S-01…S-16 y comprobaciones C-01…C-22. |
| §2.1 | Desaparecen las marcas PROPIETARIO y PENDIENTE (no queda ningún elemento en ese estado); nueva marca **LECTURA** para las lecturas técnicas de decisiones aprobadas (P-1 retención, P-2 copia protegida) que el propietario puede objetar. |
| §2.2 | Cada elemento PROPIETARIO/PENDIENTE pasa a APROBADO con su `DEC-…`: destino (DEC-0045, DEC-0052, DEC-0054 §2), cifrado y clave fuera del KVM 4 (DEC-0045, DEC-0049 §1/§4, DEC-0054 §3), custodia de la clave (DEC-0053), expiración por el servicio (DEC-0046), copia protegida antes de activar (DEC-0047, DEC-0049 §3/§4), nodo único (DEC-0048, DEC-0049 §5), puerta de activación (DEC-0049 §7, DEC-0054 §4). Filas nuevas: lectura de DEC-0046, forma de la copia protegida, canal de aviso (P-3). |
| §2.3 | Puerta de activación = las siete condiciones literales de DEC-0049 §7, con la forma de acreditar cada una; condición adicional P-3 (canal de aviso fuera del KVM 4); el informe de conformidad debe citar el commit del servicio; una prueba de laboratorio no es conformidad productiva. El productor se implementa desactivado por defecto y sin temporizador. Condiciones 2 y 3: C-21 y C-22 en PASS o, cuando quedan en MANUAL (opción B; A sin A'; nada que comparar), acreditadas por la evidencia de §9.2.5. |
| §3 | Diagrama y tabla: el servicio mantiene la copia protegida y publica evidencia; nunca borra objetos de `mainspot-backups` con un proceso propio (con la opción A sí borra la copia expirada en el bucket guard, §9.2.4). |
| §4.2 | Custodia de la clave: APROBADA (DEC-0053). |
| §6.1 | Estado TLS observado el 2026-10-22: Let's Encrypt (`YE2`), válido del 2026-10-22 al 2027-01-20, TLS 1.2/1.3, puerto 80 → 301. El estado «autofirmado» de 1.0.0 queda superado. |
| §6.4 | Claves por papel lógico (**writer**, **restore**, **operator**, **guard**) con sus nombres reales en el KVM 4 (`mainspot-backup-writer`, `mainspot-backup-reader`, `mainspot-s3-retention`, `mainspot-backup-guard` propuesto); permisos de cada una respecto a la copia protegida; formato de credenciales `AWS_*` y, aceptado por la conformidad, `S3_*`; ninguna clave con `owner` ni `createBucket`; rotación incluye C-21/C-22. |
| §7.3 | `mainspot-backups` solo admite `v1/` y `_conformance/`; las suites del servicio usan otro bucket (H-06). |
| §8.1 | La consecuencia de la matriz de permisos remite a DEC-0047 y §9.2. |
| §9 | Renombrado «Retención, expiración y copia protegida». **§9.1**: cita literal de DEC-0046 y DEC-0049 §2; «qué mecanismo elimina efectivamente» = la regla de ciclo de vida del bucket (misma configuración que 1.0.0); el servicio DEBE ejecutar un vigilante (S-08) con las reglas 1–6 (restaura la configuración exacta, audita por objeto, avisa; NO borra; NO retiene más de 16 días; NO instala otra configuración); en `ab046d24` puede ser `mainspot-s3-retention` reconvertido, que se declara no conforme hasta entonces (H-01, H-02). **§9.2 nuevo «Copia protegida»**: decisión DEC-0047 y motivo literal; los nueve requisitos literales de DEC-0049 §4; opciones B (preferencia del propietario; C-21 y C-22 en MANUAL, acreditadas por evidencia) y A/A'; no admitidos; invariantes; qué se copia (solo respaldos completos) y cuándo (cada hora, ≤ 1 h de exposición); expiración a 14 días desde `created_at` (≤ 16), sin retención indefinida, regla de referencia del bucket guard; evidencia por objeto (`audit.jsonl`); prueba sintética obligatoria de siete pasos (la regla de 1 día del paso 3 lleva `Filter.Prefix` del `deployment_id` sintético); límites literales de DEC-0049 §5. |
| §10.1 | El servicio comprueba el ciclo de vida cada hora y el inventario (edad desde `created_at`) cada día; los avisos deben salir del KVM 4 por un canal autorizado por el propietario (P-3). |
| §10.2 | La prueba mensual incluye una restauración desde la copia protegida con los originales ausentes; la primera, con la prueba sintética. |
| §11.2 | Credencial **restore** (`mainspot-backup-reader`); si el respaldo más reciente falta o no valida, se pasa a §11.4. |
| §11.4 nuevo | Restauración desde la copia protegida con originales ausentes, para A' (con **restore**) y para A sin A' / B (entrega por el operador, validación por el propietario con `manifest_tool.py verify`). |
| §13 | E-RETENTION-VIOLATION remite a §9.1. |
| §14 | Nuevas comprobaciones **C-21** (la writer no tiene ruta a la copia: 403 en el bucket guard con `HeadBucket`, `ListObjectsV2`, `PutObject`, `DeleteObject` y `PutBucketLifecycleConfiguration`, o `DeleteBucketLifecycle` si el bucket guard no tiene ciclo de vida; `HeadBucket` 404 → **MANUAL**, porque desde fuera la opción B no se distingue de un nombre erróneo) y **C-22** (correspondencia copia↔original con **restore**: inventario `v1/`, tamaño y `x-amz-checksum-sha256`, o SHA-256 del cuerpo si no se devuelve o es un valor compuesto de multiparte; los originales con más de 14 días desde `created_at` no se exigen en la copia, §9.2.4; 403/404 o nada comparado → MANUAL). Estado MANUAL y campo `"manual"` del informe; opciones `--guard-bucket` y `--guard-copy-grace`; archivos `AWS_*` o `S3_*`; el informe cita el commit del servicio y `contract_version`. Salvaguarda simétrica a C-14 para el bucket guard (incluido el caso sin ciclo de vida y el aviso «probe object left in guard bucket»). C-20 comprueba también el puerto 3900 (coherente con S-05). |
| §15 | S-02 (procesos del KVM 4 pueden usar `http://127.0.0.1:3900` en el contenedor), S-05 (incluye 3900), S-06 (solo `v1/` y `_conformance/`; suites en otro bucket), S-07 (nombres reales, sin `createBucket`, writer sin acceso a la copia), S-08 (cada hora el ciclo de vida, cada día el inventario, aviso fuera del KVM 4, el vigilante no borra ni retiene), S-11 (R2 aceptado), S-13 (capacidad de la copia), S-14 (incluye credenciales y copia protegida), S-15 (commit del servicio; primer informe tras corregir H-01 y H-05; declaración sobre S-16), **S-16 nueva** (copia protegida). |
| §16.3 | Registro del productor: campo `action=` por respaldo, línea `check=daily …` por ejecución (§10.1), línea `status=FAIL error=E-…` al detenerse, código local `E-CONFIG` fuera de §13; el productor desactiva los reintentos del SDK (`total_max_attempts: 1`) y aplica §12 por sí mismo. |
| §17 | R1 mitigado por S-16 cuando exista la copia (DEC-0047); R2 aceptado (DEC-0048) con la nota literal de DEC-0049 §5; R4 cerrado; R7 aprobado (DEC-0053); R8 nuevo (vigilante de `ab046d24` no conforme). |
| §18 | Historial de versiones con commit; PARCHE cubre también nombres reales de claves; el README lista versiones y commits. |
| §19, §20 | Referencia a la verificación v1.1 y al informe de reconciliación; decisiones DEC-0045…DEC-0054 y commit del servicio. |

Archivos:

- `conformance/check_s3_backup_contract.py`: `CONTRACT_VERSION = "1.1.0"`; C-21 y C-22;
  `--guard-bucket` (por defecto `mainspot-backups-guard`) y `--guard-copy-grace`
  (por defecto 7200 s); `load_credentials` acepta `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`
  y rechaza valores vacíos (código 2); estado MANUAL (acepta la conformidad; listado en
  `"manual"`); `guard_bucket` en el informe; `INTERNAL_PORTS` incluye 3900. Cliente sin
  reintentos del SDK (`retries={"total_max_attempts": 1}`: en botocore `max_attempts`
  cuenta reintentos, de modo que la forma de 1.0.0 hacía dos peticiones HTTP por
  operación). Tras la revisión independiente de 1.1.0: C-21 devuelve MANUAL con
  `HeadBucket` 404, usa `DeleteBucketLifecycle` como sonda cuando el bucket guard no
  tiene ciclo de vida y registra el objeto de prueba que no pudo borrar; C-22 excluye
  los originales con más de 14 días desde `created_at`, devuelve MANUAL si no comparó
  nada, recalcula el SHA-256 del cuerpo ante un checksum compuesto (`…-N`) y sugiere
  validar el manifiesto cuando falta una copia.
- `VERIFICATION.md`: sección §10 «v1.1» con las pruebas de C-21/C-22 en laboratorio
  (Garage v2.4.1, dos buckets), los casos negativos, la prueba sintética de §9.2.6 y
  la repetición tras las correcciones de la revisión (§10.5).
- `CHANGELOG.md`: este archivo.
- `infra-reconciliation-ab046d24.md`: informe de reconciliación (no normativo), en
  versión publicable: la versión íntegra con los detalles de la infraestructura queda
  fuera del repositorio público.
- Sin cambios: `manifest.schema.json`, `examples/manifest.example.json`,
  `reference/manifest_tool.py`.

## 1.0.0 — 2026-10-22

Publicación inicial (rama `contract/backup-object-storage-v1`, commit
`21537dee08bd439df823f350c87d17d754da17a6`). Aprobación parcial: destino, custodia de
la clave, mecanismo de expiración, riesgo de la credencial de escritura y nodo único
pendientes del HDC (QS-0010, QS-0011). Comprobaciones C-01…C-20 y obligaciones
S-01…S-15.
