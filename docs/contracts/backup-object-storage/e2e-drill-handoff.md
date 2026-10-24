# Plan del simulacro E2E contra Garage S3 real (revisado; preparado, NO ejecutado)

No normativo. Plan único reconciliado con el contrato **1.2.0** (`c4f87c4aa2e875e7ad01861f5f2a809e025d638c`):
§2.3 condiciones 5 y 6, §8.2, §8.6, §9.1, §9.2.5, §9.2.6, §10.2, §11.2–§11.4, §15 S-13.

**Estado:** solo planificación. Para ejecutarlo hacen falta:

- un mandato explícito del propietario;
- la confirmación del operador del KVM 4 (fase D);
- una entrega temporal y cifrada de las credenciales **writer** y **restore**.

Ningún paso activa el productor, instala temporizadores, usa `~/.config/mainspot/backup/remote.env` ni toca
respaldos o datos reales.

## Referencias

| Elemento | Valor |
|---|---|
| Contrato | 1.2.0 `c4f87c4a…` (pin README `2bb52905…`) |
| Productor y adaptador | `mainspot-platform@92c3faaeab794670d7d529bd3ad9153d2ed625cd`; adaptador instalado `~/.local/libexec/mainspot/remote-alert-telegram.py` sha256 `d42fe40b…f442b1` (recepción sintética real acreditada: `producer-alert-channel-evidence.md`) |
| Servicio | `hachxaan/mainspot-s3-backups@9c880469dca65420f57cad2c6193c2982433a608`: S-15 1.2.0 (evidence/43), copiador y vigilante (docs/13 §5, `mainspot-guard --once|--verify|--expire-only`, `mainspot-s3-retention --once|--ensure-lifecycle|--ack-drift`), buzón `scripts/host/handoff-drop.sh`, handoff `docs/14-handoff-conformidad.md` |
| Decisiones | DEC-0049 §7, DEC-0056, DEC-0057, DEC-0058 §4, DEC-0059…DEC-0065 |

## Papeles

| Papel | Quién | Qué hace |
|---|---|---|
| Ejecutor MainSpot | SOL MAIN en el equipo físico de MainSpot | Fases A, B, C, operaciones con **writer** de D3, verificación con **restore**, restauraciones, limpieza local, informe |
| Operador KVM 4 | OMP KVM 4 + propietario con sudo | Entrega de credenciales, buzón, salud, copia protegida, evidencia §9.2.5, vigilante, entrega de la copia (§11.4 opción B), limpieza de la copia, teardown |
| Propietario | Carlos Pinacho | Mandato, confirmación del `event_id` en Telegram, avisos esperados del KVM 4, decisión de parar |

## Matriz de cobertura

| Objetivo | Requisito normativo | Fase / paso | Evidencia esperada | Responsable |
|---|---|---|---|---|
| **S-13** | §15 S-13 1.2.0; DEC-0063 (simulacro E2E) | B2, B3, E3 | Línea `OK action=uploaded` con `total_bytes` ≤ 1 GiB; `FAIL E-SIZE-LIMIT attempts=0` y 0 escrituras S3 para el respaldo grande; máximo observado en `mainspot-backups` durante el simulacro; S-15 1.2.0 del operador (evidence/43) | Ejecutor MainSpot; operador para el máximo observado |
| **Condición 5** | §2.3 c.5 «productor probado con datos sintéticos contra un Garage de laboratorio y contra el servicio real (datos de prueba, borrados al terminar)» | B1–B4, E1 | Salidas `--dry-run`, ejecución real y `--check-only` (§8.2, §8.3, §10.1); objetos sintéticos borrados al terminar (ListObjectsV2 vacío) | Ejecutor MainSpot |
| **Condición 6a** | §2.3 c.6, §10.2 desde `mainspot-backups`, §11.2 | C1–C4 | `manifest_tool.py verify` → `"valid": true`; `pg_restore` en una base desechable; migraciones y conteo de filas por tabla iguales al origen; bajas re-aplicadas (§11.3); informe fechado sin secretos | Ejecutor MainSpot |
| **Condición 6b** | §2.3 c.6, §10.2 copia, §11.4 opción B, §9.2.6 paso 5 | D5–D6 | Archivos de la copia entregados por el operador con sus SHA-256; `verify` → `valid: true` con `--manifest-key` relativa; descifrado **fuera del KVM 4** y `pg_restore` con los mismos controles que 6a; originales ausentes comprobados con **restore** | Operador (entrega), ejecutor MainSpot (restauración) |
| §9.2.6 completo | pasos 1–7 | D1–D7, E1–E2 | ≥ 2 pares; líneas `copy` con SHA-256 = manifiesto; originales borrados; ciclo de vida alterado y restaurado exactamente; copia intacta (`sha256sum -c`); sin ruta de la writer (opción B); restauración; limpieza; evidencia con commit del servicio y contrato 1.2.0 | Conjunto |
| Aviso E2E del productor | DEC-0065 | B3 | `status=ALERT error=E-SIZE-LIMIT delivery=ok` en la misma ejecución; `event_id` confirmado por el propietario en el chat del bot exclusivo | Ejecutor MainSpot; propietario |
| Condición 3 (repetición) | S-16; §9.2.6 «se repite tras cualquier cambio» | D | Repite de extremo a extremo, con pares generados por el productor, la prueba del operador (evidence/29) | Operador |

Fuera de esta matriz: la condición 7 (autorización de activación en el HDC) se pide después, con todas
las anteriores acreditadas.

## Restricciones comunes

- `deployment_id = synthetic-drill`. Antes de empezar, `v1/synthetic-drill/` debe estar vacío en
  `mainspot-backups` y en la copia, y **no puede haber ningún objeto bajo `v1/`** (el productor nunca se
  activó). Si no se cumple, se para.
- Datos 100 % sintéticos: una base PostgreSQL 16 desechable (`postgres:16`, solo 127.0.0.1) con el esquema
  de MainSpot (`npm run migrate`) y la semilla sintética (`npm run seed`). Nunca `db-backup.sh` (vuelca la
  base real) ni `mainspot-db`.
- Clave de cifrado sintética generada en el equipo de MainSpot (`openssl rand -base64 48`, archivo 0600 en
  tmpfs). Nunca sale de ese equipo; la clave real no se usa.
- Credenciales y configuración solo en tmpfs (`$XDG_RUNTIME_DIR`, 0700, `MemorySwapMax=0`); el productor
  se invoca a mano con `MAINSPOT_REMOTE_CONFIG=<tmpfs>/remote.env`.
- El productor nunca borra ni cambia el ciclo de vida (§8.6). Las operaciones destructivas de D3 y E1 son
  llamadas S3 explícitas con **writer**, limitadas a claves y prefijos `v1/synthetic-drill/`.
- Sin `--force`, sin tocar cuotas, configuración del servicio ni otros buckets.

## Fase A — Preflight, identidades, aislamiento y credenciales

| Paso | Operación | Evidencia | Parar si |
|---|---|---|---|
| A1 | Mandato del propietario registrado; ventana acordada con el operador (≈ 3 h); el propietario avisado de los avisos esperados del KVM 4 (deriva del ciclo de vida, desapariciones, copias huérfanas) | Comentario en el issue del servicio | Falta el mandato o la confirmación del operador |
| A2 | Preflight MainSpot: equipo físico y salida distinta del KVM 4; checkout limpio del commit citado; sha256 del productor = repo y del adaptador = `d42fe40b…`; `status=DISABLED` sin configuración; 0 unidades `mainspot-db-backup-remote*`; Docker y `postgres:16` disponibles | Salida del helper de preflight | Cualquier discrepancia |
| A3 | Preflight KVM 4: `garage-health --once` en `ok`; ciclo de vida exacto §9.1; `v1/` y `_conformance/` vacíos; copia sin `synthetic-drill`; guard y vigilante activos; claves writer `RW` y reader `R` | Extracto del operador | `crit`, deriva previa u objetos inesperados |
| A4 | Handoff de credenciales (docs/14): clave GPG efímera de 2 días; buzón SFTP temporal; paquete con solo `writer.env` y `reader.env`; sha256 del paquete; descifrado en tmpfs | sha256 del paquete y confirmación de recepción en el issue | Huella o sha256 no coinciden |
| A5 | Base sintética de origen: contenedor `postgres:16` desechable, `npm run migrate` y `npm run seed`; inventario de tablas y filas guardado como referencia | Conteo por tabla (sin datos) | La semilla toca algo que no sea la base desechable |

## Fase B — Productor contra Garage real

| Paso | Operación | Evidencia esperada |
|---|---|---|
| B1 | Generar dos respaldos sintéticos **A1** y **A2** (separados por más de 1 s) con `pg_dump -Fc` de la base desechable, cifrados con los argumentos de §4.2 y la clave sintética, más su `.sha256` | Tamaños; sha256 |
| B2 | Productor con la configuración temporal (`ENABLED=1` solo en ese archivo; adaptador y su sha256 configurados): `--dry-run`, ejecución real y `--check-only` | `OK action=dry-run` → `OK action=uploaded` para A1 y A2 con `manifest_bytes`/`total_bytes`/`limit_bytes`; `HeadObject` y `GetObject` (§8.3); `check=daily` con `complete=2`; sin `FAIL` |
| B3 | Generar el respaldo **B** (sintético) y ejecutar el productor una vez con `MAINSPOT_REMOTE_LAB_MAX_BACKUP_BYTES` por debajo de su total (solo en esa ejecución) | `FAIL E-SIZE-LIMIT action=size-rejected attempts=0`; ninguna clave de B en S3 (ListObjectsV2); `status=ALERT error=E-SIZE-LIMIT delivery=ok`; el propietario confirma el `event_id` en el chat del bot exclusivo; los archivos locales de B intactos |
| B4 | Registrar el máximo observado de `objeto + manifiesto` en `mainspot-backups` | Valor en bytes (S-13) |

## Fase C — Restauración desde `mainspot-backups` (condición 6a)

| Paso | Operación (credencial **restore**) | Evidencia esperada |
|---|---|---|
| C1 | Elegir el respaldo completo más reciente (§11.1) y descargar el manifiesto y el objeto | Claves y sha256 |
| C2 | `manifest_tool.py verify --manifest M --manifest-key <clave> --object O --key <clave sintética>` | `"valid": true` (reglas 1–5) |
| C3 | Descifrado en streaming hacia `pg_restore` en una segunda base `postgres:16` desechable; migraciones y conteo de filas por tabla frente a A5 | Tablas y filas iguales |
| C4 | §11.3: baja sintética de un negocio en el origen posterior al respaldo (`tenant-exit`), exportar el registro y aplicar `retention-run.ts --reapply-exits --registry=…` sobre la base restaurada | El negocio dado de baja queda anonimizado en la restaurada |

## Fase D — §9.2.6 coordinado con el KVM 4 (originales ausentes y ciclo de vida)

### Precondiciones (todas)

1. B2 completo con A1 y A2 (dos pares válidos generados por el productor según §8.2: §9.2.6 paso 1).
2. Bajo `v1/` solo existen los cuatro objetos sintéticos de A1 y A2. `_conformance/` está vacío, no hay
   subidas multiparte pendientes y no hay ningún respaldo real.
3. El operador está presente durante toda la fase, con acceso a `garage-health`, al `audit.jsonl` del guard
   y del vigilante, y a `mainspot-s3-retention`.
4. El propietario ha sido avisado de los avisos de Telegram del KVM 4 que se esperan.

### Operaciones

| Paso §9.2.6 | Paso | Quién | Operación exacta | Evidencia |
|---|---|---|---|---|
| 2 | D1 | Operador | Esperar la copia (≤ 1 h) o `runuser -u mainspot-guard -- mainspot-guard --once` | Dos líneas `copy` en `audit.jsonl` con `copy_sha256_object == object.sha256` del manifiesto; `sha256sum -c` OK |
| — | D2 | Ejecutor | Con **restore**: `ListObjectsV2 v1/` = exactamente las 4 claves de A1 y A2 | Listado |
| 3 | D3a | Ejecutor | Con **writer**: `DeleteObject` de esas 4 claves exactas (nunca por prefijo amplio) | 4 respuestas 204; `ListObjectsV2 v1/synthetic-drill/` vacío |
| 3 | D3b | Ejecutor | Con **writer**: `DeleteBucketLifecycle(Bucket=mainspot-backups)` | 204 |
| 3 | D3c | Ejecutor | Con **writer**: `PutBucketLifecycleConfiguration` con `{"Rules":[{"ID":"synthetic-drill-1d","Status":"Enabled","Filter":{"Prefix":"v1/synthetic-drill/"},"Expiration":{"Days":1}}]}` | 200; `GetBucketLifecycleConfiguration` con **restore** muestra solo esa regla (instante anotado) |
| 4 | D4a | Operador | `mainspot-guard --verify`: copia de A1 y A2 intacta (mismo sha256 y tamaño), `copies_orphaned = 2`, sin `expire` | Extracto `audit.jsonl`/`status.json` |
| 4 | D4b | Ejecutor | Con **writer**: `HeadBucket mainspot-backups-guard` → 404 y `ListBuckets` = solo `mainspot-backups` (opción B: sin ruta) | Respuestas |
| 5 | D5 | Operador | §11.4 opción B: copiar del guard a un temporal 0700 los dos archivos de A2 (o A1); sha256 cotejados con `audit.jsonl`; dejarlos en `/download` del buzón y publicar solo los sha256 y la clave relativa | sha256 en el issue |
| 5 | D6 | Ejecutor | Descargar por SFTP y verificar los sha256; `verify … --manifest-key <clave relativa>` → `valid: true`; descifrado **en el equipo de MainSpot** hacia `pg_restore` en una base desechable; controles de C3 | Informe 6b |
| 6 | D7 | Operador y ejecutor | El vigilante (≤ 1 h) o, si no, `mainspot-s3-retention --once --ensure-lifecycle` restaura la configuración exacta de §9.1; con **restore**, `GetBucketLifecycleConfiguration` = las 2 reglas de §9.1 (mismos `ID`, `Status`, `Filter.Prefix`, `Expiration.Days`, `DaysAfterInitiation`) | Comparación exacta; deriva auditada por el vigilante (instante encontrado y restaurado) |

### Impacto

- Entre D3b y D7 el bucket real no tiene la regla de 14 días de `v1/` ni la de `_conformance/`.
- Como no hay respaldos reales, conformidades ni subidas en curso, el impacto se limita a los objetos
  sintéticos, ya borrados. Ventana máxima prevista: 75 min.
- El KVM 4 enviará avisos reales de deriva y de desaparición: son esperados y se anotan.

### Supervisión

El operador vigila `garage-health`, los dos `audit.jsonl` y los avisos durante toda la fase. El ejecutor
consulta el ciclo de vida con **restore** cada 15 min desde D3c hasta D7.

### Vuelta atrás

Si el vigilante no ha restaurado la configuración exacta 75 min después de D3c:

1. El operador ejecuta `mainspot-s3-retention --once --ensure-lifecycle`.
2. Si sigue sin coincidir, restaura con la clave **operator** la configuración exacta de §9.1.
3. El ejecutor la verifica con **restore**.
4. Si aun así falla: incidente, se para el simulacro y se avisa al propietario.

En cualquier caso el estado final verificado es el ciclo de vida exacto de §9.1.

### Criterios de parada (antes del paso que se iba a dar)

| Condición | Acción |
|---|---|
| Hay en `v1/` cualquier clave que no sea de A1/A2, o el bucket tiene objetos inesperados | No ejecutar D3 |
| Falta la copia de A1 o de A2 (o un sha256 no coincide) 75 min después de B2 | No borrar originales; investigar |
| La writer obtiene en D4b algo distinto de 404/denegación sobre la copia | Incidente de seguridad; parar |
| `garage-health` en `crit`, el guard con anomalías no esperadas, o disco/cuota en aviso | Parar; restaurar ciclo de vida (vuelta atrás) |
| `verify` ≠ `valid: true` o la restauración falla | Parar; conservar evidencia; no limpiar la copia de ese par hasta analizarlo |
| El ciclo de vida no vuelve a §9.1 tras la vuelta atrás | Incidente; parar; avisar al propietario |

## Fase E — Limpieza, auditoría y cierre

La limpieza **borra** lo sintético. No se deja expirar: §2.3 c.5 dice «borrados al terminar» y §9.2.6
paso 7 «limpiar los objetos sintéticos».

| Paso | Quién | Operación | Evidencia |
|---|---|---|---|
| E1 | Ejecutor | Con **writer**: `DeleteObject` de cualquier clave sintética restante bajo `v1/synthetic-drill/`, listadas una a una (tras D3 deberían quedar 0); B nunca se subió; con **restore**, `ListObjectsV2 v1/` vacío | Listado vacío |
| E2 | Operador | Borrar las copias sintéticas `v1/synthetic-drill/` del volumen del guard (mismo procedimiento que G-11 de `guard-drill.sh`) y registrar la deriva con `mainspot-s3-retention --ack-drift 'E2E synthetic drill'`; `garage-health --once` en `ok`, `objects` igual que en A3, copia sin `synthetic-drill`; ciclo de vida exacto §9.1 | Extracto sin secretos; commit del servicio |
| E3 | Ejecutor | Bases y contenedores `postgres` desechables eliminados; directorio de respaldos temporal, configuración, marcas, `remote-alerts*` y la clave sintética destruidos (`shred` en tmpfs); credenciales y clave GPG efímera destruidas con la limpieza garantizada por `trap`; verificar 0 restos; productor `DISABLED` sin `remote.env`; 0 unidades remotas | Salida de verificación |
| E4 | Operador | Teardown del buzón y cierre de docs/14 §5 (revisión del uso de las claves en la ventana; rotación si hubo cualquier desviación) | Evidencia del operador |
| E5 | Ambos | Informes publicados sin secretos, con el commit de MainSpot, el commit del servicio y contrato 1.2.0 `c4f87c4a`: S-13 (máximo observado y rechazo), condición 5, 6a, 6b, §9.2.6 pasos 1–7 y aviso E2E | Commits verificados en ambos repositorios |

Solo con E1–E5 completos se dan por acreditadas S-13 (DEC-0063), las condiciones 5 y 6 y el aviso E2E
del productor. La condición 7 se pide después, en una sesión HDC propia.

## Riesgos residuales del simulacro

- La writer usada en D3 es la credencial real: un error de clave o de prefijo podría borrar otra cosa. Se
  mitiga con el bucket vacío fuera de A1/A2 (precondición 2), claves exactas y el listado previo de D2.
- Durante ≤ 75 min el bucket real tiene un ciclo de vida distinto de §9.1. No hay respaldos reales; el
  vigilante y la vuelta atrás lo restauran.
- Los archivos de la copia viajan cifrados por el buzón SFTP: son sintéticos y la clave sintética nunca
  sale del equipo de MainSpot.
