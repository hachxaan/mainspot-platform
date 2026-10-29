# Dossier de preautorización: condición 7 (activación de respaldos remotos MainSpot → Garage S3)

No normativo, sin secretos. **Revisión 5**, del 2026-10-29. Sustituye a la revisión 4 (`d07724f`) y solo corrige
**G7-REV4-01** ([comentario 6490320763](https://github.com/hachxaan/mainspot-platform/issues/2#issuecomment-6490320763)):
el lugar de ejecución de la conformidad §14 dentro de P-06(c).

**Cambios respecto a la revisión 4:**
- P-06(c), §5.1 (rama A y P05-E5) y §9 alineados con el contrato 1.2.0 §14: la conformidad «se ejecuta **desde fuera del KVM 4**». La ejecuta un **ejecutor externo** contra el endpoint real, con el procedimiento existente (`check_s3_backup_contract.py`, igual que en la condición 2). El operador del KVM 4 coordina y publica el S-15, pero no ejecuta §14 desde el host.
- La nueva ejecución de §14 se exige cuando P-05 esté incorporado y antes de dar P-06 en PASS; no ahora.
- Sin cambios en código, lock, unidades, contrato, regla de activación ni en las preguntas y opciones de la sesión (§14.5).

**Cambios de la revisión 4 respecto a la revisión 3** (G7-REV3-01, [comentario 6441378247](https://github.com/hachxaan/mainspot-platform/issues/2#issuecomment-6441378247)):
- Nuevo §5.1: límite funcional y técnico del monitor de frescura P-05 y su clasificación contractual. Dentro de ese límite, P-05 **no cambia el comportamiento contractual** del servicio: no hace falta versión nueva del contrato, ni aviso S-14 obligatorio, ni ninguna decisión aprobada se modifica. Sí activa **S-15**, porque es un cambio de configuración del servicio.
- P-05 y P-06 se reescriben para encajar con ese límite: P-06 deja de aceptar la declaración genérica «el comportamiento no cambia» y pasa a exigir un alcance verificable del diff y el informe S-15. No se relaja ninguna garantía.
- Las comprobaciones de salud dejan de exigir el literal «9/9».
- Sin cambios en código, lock, unidades, contrato ni en las preguntas y opciones de la sesión. Las pruebas de la revisión 3 siguen siendo válidas y no se repiten (§14.4).

**Cambios de la revisión 3 respecto a la revisión 2** (atienden G7-REV2-01…03, [comentario
6438826575](https://github.com/hachxaan/mainspot-platform/issues/2#issuecomment-6438826575); la revisión 2 atendió
G7-REV-01…05, comentario 6402562530):
- **G7-REV2-01.** El entorno Python fijado deja de usar `urllib3` 2.0.7, una versión de PyPI sin los parches que Ubuntu aplica en USN-8926-1. Ahora usa `urllib3` 2.8.0 y las dependencias transitivas vigentes, con hashes nuevos y `pip-audit` limpio. Las pruebas se repitieron con el entorno definitivo: suite de laboratorio y E2E sintético por TLS + SigV4 (§14).
- **G7-REV2-02.** Se elimina la excepción temporal D-1, por preferencia del propietario. **P-05 es obligatorio siempre**, sin alternativa. El dossier ya no promete un control de salida automático.
- **G7-REV2-03.** Desaparece con D-1: ya no hay ninguna aceptación de riesgo con justificación en la sesión.

- **Preparado por:** SOL MAIN, bajo el mandato de [mainspot-platform#2](https://github.com/hachxaan/mainspot-platform/issues/2).
- **Contrato:** 1.2.0 `c4f87c4aa2e875e7ad01861f5f2a809e025d638c`.
- **Servicio:** `hachxaan/mainspot-s3-backups@2af25580b1a071269a44e73ff8970c2cc85fb3bd` (cierre E4/E5: evidence/49 y evidence/50).
- **Estado de las condiciones 1–6 y de E1–E5:** `integration-status.md`.

Este dossier **no solicita** la decisión HDC ni activa nada. El borrador de la sesión es
`gate7-qs-activation-draft.questions.json`, no publicado. Su pregunta de autorización está ligada al sha256 de **este
archivo**, de modo que cualquier cambio del dossier invalida la aprobación (verificación del HDC al enviar).

Toda configuración productiva exige un `DEC-…` explícito del propietario (§2.3, DEC-0049 §7, DEC-0054 §4, DEC-0058 §4).
Recibir un mensaje de Telegram no equivale a esa autorización.

## 1. Dictamen

| Pregunta | Dictamen |
|---|---|
| ¿Se puede **publicar** la sesión HDC? | **GO técnico para publicar, condicionado a la nueva revisión independiente** que pidió el comentario 6438826575. Se cumple que: (a) las condiciones 1–6 y E1–E5 están acreditadas documentalmente; (b) el borrador es válido con el perfil HDC v2 y está ligado al sha256 de esta revisión; (c) ninguna combinación de respuestas activa la producción sin los requisitos obligatorios (§7, comprobado en §14.2); (d) el entorno fijado no tiene vulnerabilidades conocidas (§14.3). Publicar no es activar, y la publicación la decide el propietario |
| ¿Se puede **activar** la producción? | **NO-GO.** Solo con un `DEC-…` de autorización condicionada y con todos los requisitos obligatorios del §5 en PASS en un registro de preflight publicado (§11). Hoy faltan, como mínimo, P-01, P-02 y P-10 (propietario), **P-05** (operador; sin excepción posible) y la instalación real de P-03 (SOL MAIN, solo tras el DEC) |
| ¿La mejora F-01 (botón de acuse) entra en la activación? | **No.** Está aislada en `feat/f01-telegram-acknowledged-alerts`, sin fusionar ni desplegar, con AUD-01/02/03 abiertos. La activación usa **exactamente** el adaptador `d42fe40b`, el del simulacro (P-04) |

**Garantía histórica frente a aptitud operativa.** Las condiciones 1–6 PASS acreditan lo probado en el simulacro con datos
sintéticos. No acreditan la aptitud operativa futura. Esa aptitud depende de los requisitos del §5: custodia probada,
código fijado y vigilancia de frescura independiente. Esos requisitos no son condiciones literales de §2.3, pero el
dossier los exige como precondiciones de ejecución.

## 2. Premisas

1. **Qué se autorizaría.** Copiar cada día el mismo `.dump.enc` que ya produce `db-backup.sh` (cifrado en MainSpot) a `https://s3.mainspot.canonflow.dev/mainspot-backups`, según el §8 del contrato, con la credencial **writer**. El respaldo local, su retención de 14 días y la prueba local mensual no cambian.
2. **Qué no se autorizaría.**
   - transmitir la clave de descifrado;
   - debilitar TLS;
   - ampliar el máximo de 1 GiB o la cuota de 50 GiB (DEC-0063);
   - cambiar la retención;
   - borrar objetos desde MainSpot;
   - usar la mejora F-01;
   - cualquier canal de aviso distinto de los aprobados (DEC-0055, DEC-0064);
   - ejecutar código desde el checkout de desarrollo.
3. **El código que se activaría es el mismo que pasó el simulacro**, fijado por contenido:
   - productor `b714c78300841f111317241d398cb08974c2220b226ecf4cdc91e467512bae7c`;
   - `manifest_tool.py` `b330ddfa02809d71d761febc7c38fc88b318085f6021d8e135dd7720eac397c3`;
   - adaptador `d42fe40b86c527c94c29f298af1c54c1fff94ef54db88e69b4f74eafedf442b1`.
   Sin cambios en `scripts/ops/backup` ni en `v1/` desde `92c3faa`. Las bibliotecas sí cambian respecto al simulacro (§8 R-DEPS): boto3/botocore siguen en 1.43.85, pero `urllib3` pasa a 2.8.0 y se actualizan las demás dependencias transitivas. Las pruebas se repitieron con ese entorno (§14).
4. **Los datos reales tienen hoy un tamaño mínimo.** Los respaldos locales rondan los 121 KB (el 0,011 % de 1 GiB) y la base solo contiene negocios sintéticos (§16.2).

## 3. Hechos probados con datos sintéticos frente a garantías aún no probadas con datos productivos

| Ámbito | Probado (sintético o sin datos) | No probado con datos productivos |
|---|---|---|
| Transporte | TLS de confianza pública, SigV4, conformidad externa `conformant=true` (20 PASS + 2 MANUAL) | — |
| Subida y verificación (§8) | B2: 2 subidas con `attempts=1`, `HeadObject`/`GetObject` §8.3, `check=daily` `complete=2` | Subidas diarias sostenidas, cadencia horaria durante días, objetos con la **clave real** (`key_id` real) |
| Límite de tamaño (§8.2 paso 0) | B3: rechazo antes de S3, `attempts=0`, respaldo local intacto; pruebas de laboratorio | Aviso del 80 % con datos reales (lejos del umbral) |
| Avisos | Productor: TEST-SYNTHETIC y E-SIZE-LIMIT E2E recibidos. KVM: `VIGIL-RETENTION-WARN` FIRING y RESOLVED recibidos | E-FRESHNESS y E-RETENTION-VIOLATION reales; vigilancia de frescura independiente (P-05, por implementar) |
| Restauración | 6a desde el bucket y 6b desde la copia con originales ausentes: `verify` `valid:true`, `pg_restore` rc=0, 33 tablas iguales, bajas reaplicadas | Descifrado con la **copia de custodia** de la clave (P-01); acceso con el **restore de custodia** (P-02); restauración con el volumen real |
| Copia protegida (§9.2) | D1 copia ≤ 1 h con sha256 = manifiesto; D4a/D4b: la writer no alcanza la copia; D6 restauración; E2 expiración con `--now` | Expiración real a 14 días con el reloj real |
| Retención (§9.1) | Alteración del ciclo de vida detectada y restaurada por el vigilante en 14 min, sin intervención | Borrado efectivo por el ciclo de vida de Garage a los 14 días (R5) |
| Capacidad (S-13) | PASS para R = 1 GiB (evidence/43 y 49); máximo observado 94 453 B | Crecimiento real de la base |
| Ejecución fijada | Ensayo offline del §14.1 con el entorno definitivo: copia de solo lectura, `venv` sin pip con hashes, unidad verificada, suite de laboratorio y E2E por TLS + SigV4 | La instalación real en `~/.local/libexec` (P-03, en el preflight) |

## 4. Tabla de garantías

| Garantía (contrato / DEC) | Mecanismo | Evidencia | Estado |
|---|---|---|---|
| La clave de descifrado nunca sale del equipo de MainSpot (§16.1, DEC-0045/0053) | Cifrado local previo; el productor lee la clave solo para `key_id` y MAC | Código y laboratorio; simulacro con clave sintética | Probado (sintético) |
| Integridad y autenticidad (§5.3, R3) | MAC del manifiesto + SHA-256 antes de descifrar | `verify` `valid:true` en 6a y 6b; pruebas adversariales | Probado (sintético) |
| El respaldo grande no se sube (DEC-0059/0061) | Paso 0 antes de S3 | B3 | Probado |
| Expiración a 14 días; nada supera 16 días (§9.1, DEC-0046/0057) | Ciclo de vida exacto + vigilante horario + inventario diario + `check=daily` | E2, D7, conformidad C-15 | Configuración probada; borrado efectivo con reloj real no observado |
| Recuperable aunque la writer borre (R1, DEC-0047/0056) | Copia protegida opción B ≤ 1 h; la writer no tiene ruta | D1–D6, E2; S-16 PASS | Probado (sintético). Residual: ventana ≤ 1 h |
| Recuperación sin el equipo de MainSpot (DEC-0054 §3) | Custodia del propietario: clave + restore; §11.2/§11.4 | 6a/6b desde el equipo de MainSpot con clave sintética | **Sin acreditar: requisitos obligatorios P-01 y P-02** |
| Avisos fuera del KVM 4 (S-08, DEC-0055/0058 §1) | Bot del vigilante | evidence/37; avisos del simulacro | Probado. **No cubre la frescura** |
| Avisos del productor (DEC-0064/0065) | Adaptador `d42fe40b`, cola acotada, sin éxito falso | TEST-SYNTHETIC; E-SIZE-LIMIT E2E recibido | Probado mientras el productor se ejecute |
| Detección de que el productor dejó de correr | Vigilancia de frescura independiente | — | **No existe todavía: requisito obligatorio P-05, sin excepción** |
| Sin secretos en registros (§16.3, S-12) | Formato de línea; pruebas `no_secrets` | Laboratorio; log S3 revisado (evidence/48) | Probado |

## 5. Requisitos obligatorios (no se deciden en el HDC)

Ninguna respuesta de la sesión HDC puede sustituirlos ni darlos por cumplidos. Se acreditan con evidencia no secreta
en un **registro de preflight** publicado (§11). Si uno falla, no hay activación.

| Id | Requisito | Evidencia medible (sin secretos) | Quién | Si no se cumple |
|---|---|---|---|---|
| **P-01** | **Custodia recuperable de la clave de descifrado** (DEC-0053, DEC-0054 §3; G7-REV-01). La copia de custodia descifra un respaldo real, fuera del equipo de MainSpot y del KVM 4 | 1. SOL MAIN publica, para un respaldo local B: `backup_id`, el sha256 del cifrado (= `.sha256`) y el sha256 del claro, calculado en el equipo con la clave del equipo (`openssl enc -d … \| sha256sum`). 2. El propietario descifra B en un equipo propio con la copia de custodia; el archivo de clave temporal se borra al terminar. 3. El propietario registra: fecha, `backup_id`, sha256 del claro y si coincide. **PASS solo si coincide** | Propietario; SOL MAIN (paso 1) | Sin activación. Una copia «existente pero no probada» **no** cumple |
| **P-02** | **Credencial restore en custodia y operativa** fuera del equipo de MainSpot (DEC-0054 §3, §6.4) | Desde un equipo del propietario distinto del de MainSpot y con la credencial de custodia, comprobación de solo lectura: `HeadBucket mainspot-backups` → 200 y `ListObjectsV2` con prefijo `v1/` → 200. Se registran fecha y códigos, nunca la clave ni su id | Propietario | Sin activación |
| **P-03** | **Ejecución fijada e inmutable** (G7-REV-02): nunca desde el checkout de desarrollo | Ver la lista de comprobaciones bajo la tabla. Ensayo offline hecho en §14.1; la instalación real se repite en el preflight | SOL MAIN | Sin activación |
| **P-04** | **Adaptador original del simulacro** | `sha256(~/.local/libexec/mainspot/remote-alert-telegram.py)` = `d42fe40b…f442b1` = `MAINSPOT_REMOTE_ALERT_COMMAND_SHA256`; ningún artefacto de la rama F-01 instalado | SOL MAIN | Sin activación |
| **P-05** | **Vigilancia de frescura independiente** (G7-REV-03, G7-REV2-02), **obligatoria sin excepción**. Debe cumplir el límite del §5.1 | Las evidencias P05-E1…E6 del §5.1, publicadas por el operador con commit del servicio, incluida la prueba sintética FIRING/RESOLVED con la recepción confirmada por el propietario. Todo **antes** de habilitar el productor | Operador KVM 4 (implementa y publica); propietario (autoriza la ventana de la prueba y confirma la recepción) | Sin activación |
| **P-06** | **Estado sin cambios respecto a la sesión, salvo la incorporación de P-05 dentro de su límite** (G7-REV3-01) | (a) Contrato `c4f87c4`, sin versión nueva. (b) Servicio en el commit que publica P-05, o posterior. `git diff 2af25580..<commit>` solo toca los archivos del componente P-05 (código, pruebas y unidad o configuración propia) más `evidence/` y `docs/`. Ningún cambio en los elementos de S-14 (endpoint, región, bucket, nombres o permisos de credenciales, ciclo de vida, copia protegida) ni en Garage, el proxy, la firma S3 o las reglas 1–6 del vigilante de §9.1. (c) Conformidad **§14 ejecutada desde un equipo externo al KVM 4, contra el endpoint real** (`https://s3.mainspot.canonflow.dev`), conforme al contrato 1.2.0 §14 y con el procedimiento existente: `conformance/check_s3_backup_contract.py` (runner sha256 `ae28a41a…fc85`), igual que en la condición 2. Resultado: `"conformant": true`, al menos con la referencia de la condición 2 (20 PASS; C-21 y C-22 MANUAL acreditadas por §9.2.5). El informe se publica sin secretos y cita el commit del servicio que incorpora P-05. El operador del KVM 4 publica en ese commit la evidencia **S-15**: el informe externo más la declaración S-04, S-06, S-11, S-13 y S-16 sin cambios. **Un informe ejecutado solo dentro del KVM 4 no cumple (c).** Se ejecuta una vez incorporado P-05 y antes de dar P-06 en PASS. (d) El día de la activación: todas las comprobaciones de salud en `ok` (las previas, ninguna retirada, más las que añada P-05), ciclo de vida §9.1 exacto, `v1/mainspot-pilot/` vacío y P-05 en estado `unarmed` sin avisos. (e) Hashes del §2.3 sin cambios | Operador (b, d; coordina y publica S-15 en c); ejecutor externo al KVM 4 (§14 en c); SOL MAIN comprueba el diff, el informe y los hashes | Sin activación. Si P-05 no cabe en el §5.1 o el diff lo excede: §5.1 rama B (contrato nuevo y nuevo ciclo de Gate 7) |
| **P-07** | **Rotación**, solo si D-2 = `rotar_antes` | `docs/07` «Rotación (sin corte)» aplicado; C-03, C-04, C-21 y C-22 en PASS con las claves nuevas; claves anteriores revocadas | Operador; propietario | Sin activación |
| **P-08** | **Mitigación de la paginación**, solo si D-3 = `mitigar_paginacion` | (a) Tras un reinicio, swap cifrado con clave efímera o sin swap: `swapon --show` y `lsblk -o NAME,TYPE` muestran el dispositivo de swap como `crypt`, o ninguno. (b) `MemorySwapMax=0` en `mainspot-db-backup-remote.service` (variante B, §10), `mainspot-db-backup.service` y `mainspot-db-restore-test.service`, comprobado con `systemctl --user show -p MemorySwapMax` = 0. El controlador de memoria está delegado en este equipo y el efecto se comprobó el 2026-10-27 (`memory.swap.max` = 0) | SOL MAIN; propietario (reinicio) | Sin activación |
| **P-09** | **Vigencia de la autorización** | Todos los requisitos aplicables en PASS dentro de los **30 días** siguientes al DEC | — | La autorización caduca; hace falta una sesión nueva |
| **P-10** | **`remote.env` provisto por el propietario en el equipo** | Archivo 0600 en un directorio 0700, con las claves del §10 y sin `MAINSPOT_REMOTE_LAB_*`; secretos nunca transmitidos por chats ni issues | Propietario; SOL MAIN comprueba permisos y claves (no valores) | Sin activación |

### 5.1 Límite de P-05 y clasificación contractual (G7-REV3-01)

**Base contractual (1.2.0 `c4f87c4`, sin cambios):**
- §1: el servicio «PUEDE vigilar y auditar», pero ningún proceso del servicio borra objetos ni los retiene más de 16 días.
- §3: el servicio opera el «monitoreo (§15)».
- S-02: los procesos propios del KVM 4 («vigilante…, copiador…, monitor») PUEDEN usar el puerto interno.
- §9.1, reglas 1–6 del vigilante: lista `v1/`, mide la edad desde `created_at` y avisa; NO DEBE borrar, retener ni instalar otro ciclo de vida.
- §10.1: los avisos del servicio salen del KVM 4 por el canal autorizado.
- S-08 obliga a vigilar el ciclo de vida y el inventario, pero no la frescura. El contrato **no obliga ni prohíbe** una comprobación de frescura del servicio.

**Límite funcional y técnico.** P-05 debe cumplir **todo** lo siguiente:

| Id | Límite |
|---|---|
| L1 | Se ejecuta en el KVM 4, sin ningún componente en el equipo de MainSpot, y avisa por el bot del KVM 4 (DEC-0055), con las condiciones de DEC-0058 §1: sin secretos, con control de duplicados, reintentos limitados y aviso si falla la entrega. Es un aviso operativo sobre el contenido de `mainspot-backups`, dentro del uso «alertas operativas de Garage S3» de DEC-0058 §1 |
| L2 | **Sin credenciales, claves ni permisos nuevos.** Usa la identidad de un proceso existente del KVM 4 y solo operaciones de lectura sobre `mainspot-backups` (`ListObjectsV2`; `HeadObject`/`GetObject` de manifiestos si hiciera falta). Recomendación: implementarlo como una regla adicional del vigilante `mainspot-s3-retention`, que ya lista `v1/` cada hora con la clave **operator**. Así no hay operaciones nuevas sobre el bucket |
| L3 | **Aditivo y pasivo.** No escribe ni borra objetos, no retiene (§9.1 regla 5: una parada del productor no es motivo para retener), no toca el ciclo de vida, la copia protegida, el guard ni Garage. No modifica las reglas 1–6 del vigilante ni sus avisos actuales |
| L4 | **Alcance.** Prefijo `v1/mainspot-pilot/postgres/mainspot/`. Respaldo completo = par objeto + manifiesto con clave §7.3. Edad del más reciente desde su `created_at`. Umbral **26 h**, el de E-FRESHNESS en §10.1. Evaluación al menos cada hora |
| L5 | **Estados.** `unarmed`: nunca se ha visto un respaldo completo; no avisa, pero lo informa en su estado. `ok`. `stale`: un aviso FIRING al entrar y RESOLVED al salir. El armado es automático y persistente con el primer respaldo completo, sin cambio de configuración al activar. Desarmarlo solo es posible con una acción auditada del operador, avisada antes al propietario |
| L6 | **Falla ruidosa.** Si no puede evaluar durante 3 ciclos seguidos (listado fallido), avisa. Si el proceso muere, lo detecta la salud existente (comprobación `retention` de `garage-health`, si va dentro del vigilante) o una comprobación nueva |
| L7 | Configuración y estado sin secretos. Los avisos PUEDEN contener claves de objeto (§10.1) |

**Clasificación.**

**Rama A, dentro del límite L1–L7: no es un cambio de comportamiento contractual.**
- No modifica ninguna obligación del contrato: §5–§14 y S-01…S-16 siguen iguales.
- No cambia ningún elemento de la lista de S-14 (endpoint, región, bucket, credenciales, ciclo de vida, copia protegida), así que **no hay versión nueva del contrato** ni aviso previo obligatorio por S-14.
- No toca ninguna decisión aprobada: DEC-0046/0057 (solo detecta y avisa, no borra ni retiene), DEC-0055/0058 §1 (mismo canal y condiciones), DEC-0047/0056 (no toca la copia).
- Sí es un **cambio de configuración del servicio**, así que se aplica **S-15**: informe de §14 ejecutado **desde fuera del KVM 4** contra el nuevo commit, más la declaración del operador (P-06 c).
- Por buena fe, el operador anuncia el despliegue en el issue antes de aplicarlo. No es una exigencia de S-14, y hacerlo no relaja nada.

**Rama B, si la implementación excede el límite** (por ejemplo, una clave nueva o un permiso nuevo, otro canal, escrituras, cambios en el ciclo de vida o en el guard, o cambios en las reglas 1–6): **sí es un cambio contractual.**
- Aviso previo S-14.
- Versión nueva del contrato publicada por MainSpot: como mínimo PARCHE si solo cambia un nombre real; MENOR si cambia una obligación o se añade un papel en §6.4/S-07.
- Reconciliación por commit de ambas partes (condición 4) y S-15 con la versión nueva.
- Si afecta a una decisión aprobada (por ejemplo, otro canal distinto de DEC-0055), sesión HDC propia.
- En esta rama P-06 falla y Gate 7 vuelve a empezar: dossier nuevo con el nuevo pin y sesión nueva. Ningún agente puede declararlo «sin cambio».

**Evidencias que debe publicar OMP KVM 4 (rama A):**

| Id | Evidencia |
|---|---|
| P05-E1 | Commit del servicio con P-05 y el diff respecto a `2af25580` limitado al componente (P-06 b) |
| P05-E2 | Pruebas del componente: `unarmed` sin aviso; `stale` → FIRING una sola vez; vuelta a `ok` → RESOLVED; falla ruidosa tras 3 listados fallidos; **lista blanca de operaciones observadas** (solo lecturas; ningún PUT, DELETE ni subrecurso de ciclo de vida); sin secretos |
| P05-E3 | Prueba sintética real en una ventana autorizada por el propietario, sin datos reales: bucket de laboratorio o simulación del tiempo, nunca objetos en `mainspot-backups`. Avisos FIRING y RESOLVED por el bot del KVM 4, con la recepción confirmada por el propietario en el issue |
| P05-E4 | Declaración del operador sobre L1–L7, con conclusión explícita «rama A» y referencia a las pruebas |
| P05-E5 | Evidencia S-15 publicada por el operador en el commit de P05-E1, con el informe §14 de un **ejecutor externo al KVM 4** contra el endpoint real (P-06 c) |
| P05-E6 | Salud y estado tras el despliegue: todas las comprobaciones en `ok`, ciclo de vida exacto, P-05 `unarmed` |

**Fuera de esta tarea:** implementar o desplegar P-05. Esta revisión solo fija el límite y las evidencias. P-05 se
implementa **antes** de habilitar el productor.

**Riesgo residual.** P-05 corre en el KVM 4: si ese equipo cae, no avisa. En ese caso el productor de MainSpot falla
con errores de red y avisa por su propio bot (DEC-0064), salvo que caigan los dos equipos a la vez (riesgo análogo a R2).

**Comprobaciones de P-03:**
- **Origen.** `git archive` de un commit cuyo productor y `manifest_tool.py` tienen los sha256 del §2.3, en `~/.local/libexec/mainspot/backup-remote/b714c783/`. Se conserva la ruta relativa que usa `REPO_ROOT`.
- **Permisos.** Archivos 0400, directorios 0500, `venv` sin escritura; nada escribible por grupo u otros.
- **Entorno Python propio.** `python3 -m venv --without-pip`; se instala **solo** con `pip --python <venv>/bin/python install --no-deps --only-binary=:all: --require-hashes -r gate7-producer-requirements.lock` (lock de la revisión 3). Se ejecuta con `python -I`, que ignora el site-packages del usuario y las variables `PYTHON*`. Sin pip dentro del entorno de producción. Se registran la lista de paquetes instalados y el sha256 del árbol del `venv`.
- **Vulnerabilidades.** `pip-audit` (bases PyPI y OSV) sobre el site-packages instalado, **el día del preflight**: 0 vulnerabilidades. Cualquier hallazgo nuevo para la activación hasta clasificarlo por uso real y, si procede, sacar un lock nuevo con su propia revisión del dossier.
- **Unidad.** La variante A o B del §10, con sha256 exacto; `systemd-analyze --user verify` sin errores; ninguna referencia a `codeart/`.
- **Calendario.** `systemd-analyze calendar '*-*-* *:20:00'` en America/Cancun (UTC−5).
- **Ensayo.** `--dry-run` con la configuración real **antes** de habilitar el temporizador: `OK action=dry-run` y cero escrituras.
- **Suite de laboratorio y E2E.** `tests/ops/backup-remote` en PASS con un intérprete instalado desde el mismo lock, y el E2E sintético offline por TLS + SigV4 del §14.1 en PASS con la copia fijada.

## 6. Decisiones de aceptación de riesgo (sesión HDC)

Son las únicas elecciones del propietario. Cada opción es válida, pero ninguna exime de los requisitos del §5. Algunas
**añaden** requisitos.

**Excepción temporal retirada.** La revisión 2 ofrecía la decisión D-1, un piloto sin P-05. Se retira por preferencia del
propietario y por G7-REV2-02: ofrecía una parada automática que no estaba respaldada por ningún control instalado. P-05
es obligatorio siempre. Con D-1 desaparece también G7-REV2-03: ya no queda ninguna aceptación de riesgo con justificación.

**Límite del HDC.** El HDC registra decisiones, pero no puede imponerlas al productor: no existe ningún control en
ejecución que lea el DEC. Lo que impide activar sin los requisitos es el procedimiento del §7 y el §11, que cumple el
ejecutor y se registra en el preflight publicado. Este dossier no afirma ninguna barrera automática.

| Id | Pregunta HDC | Opciones | Efecto sobre la ejecución |
|---|---|---|---|
| **D-0** | `Q-ACTIVATION-CONDITIONAL` (aprobación ligada al sha256 de este dossier) | `approve` / `reject` (con comentario) / `defer` | `approve` = **autorización condicionada**: la activación solo se ejecuta según la regla del §7. `reject` y `defer`: sin activación. **No existe una opción de autorización incondicional** |
| **D-2** | `Q-CREDENTIAL-ROTATION` | `rotar_antes` / `no_rotar` | `rotar_antes` añade **P-07**. `no_rotar` acepta la exposición acotada del simulacro; el operador no vio desviaciones y concluyó que la rotación no es obligatoria (evidence/48 y 49) |
| **D-3** | `Q-SWAP-RISK` | `aceptar_riesgo` / `mitigar_paginacion` | `mitigar_paginacion` añade **P-08** y usa la unidad B. Reduce la paginación, **pero no** la exposición en disco persistente: `backup.key`, `remote.env` y `telegram-alert.env` siguen en claro (0600). El cifrado del disco quedaría para otra decisión. `aceptar_riesgo` no cambia el equipo |
| — | `Q-NOTES` | texto libre | Las notas **no** pueden relajar requisitos. Si una nota contradice la regla del §7, no hay activación hasta aclararlo en una sesión nueva |

`DEPLOYMENT_ID=mainspot-pilot` y la región `garage` (PROPUESTOS en el contrato, §2.2) quedan confirmados por `approve` de
D-0, porque forman parte de este dossier.

## 7. Regla de activación (hard stops)

El HDC registra respuestas, pero **no aplica reglas entre preguntas**. La garantía la da esta regla de ejecución, que
cumple el ejecutor y que queda en el registro de preflight. **La activación (habilitar el temporizador) ocurre si y solo
si se cumplen todas las condiciones siguientes:**

1. Existe un `DEC-…` ingerido de la sesión con **D-0 = `approve`**, ligado al sha256 de esta revisión del dossier.
2. **P-01, P-02, P-03, P-04, P-06, P-09 y P-10** están en PASS.
3. **P-05** está en PASS. No hay excepción.
4. Si D-2 = `rotar_antes`, **P-07** está en PASS.
5. Si D-3 = `mitigar_paginacion`, **P-08** está en PASS.
6. Ninguna nota de `Q-NOTES` contradice la regla.

En cualquier otro caso no se activa. Sin DEC, con una pregunta obligatoria sin responder, con `reject` o `defer`, o con
algún requisito pendiente, el productor sigue `DISABLED` y sin temporizador. Esto incluye la combinación «custodia sin
probar + `approve`»: P-01 no está en PASS, así que no hay activación (G7-REV-01).

| D-0 | D-2 | D-3 | Requisitos para activar |
|---|---|---|---|
| `reject` / `defer` / sin DEC | cualquiera | cualquiera | **Nunca** |
| `approve` | `no_rotar` | `aceptar_riesgo` | P-01…P-06, P-09, P-10 |
| `approve` | `rotar_antes` | `aceptar_riesgo` | lo anterior + P-07 |
| `approve` | `no_rotar` | `mitigar_paginacion` | P-01…P-06, P-09, P-10 + P-08 |
| `approve` | `rotar_antes` | `mitigar_paginacion` | P-01…P-10 |

## 8. Riesgos residuales

| Id | Riesgo | Situación | Tratamiento |
|---|---|---|---|
| R2 | **Nodo único.** Perder el KVM 4 pierde a la vez la copia remota y la protegida | Aceptado por DEC-0048 / DEC-0049 §5 | Registrado. Sigue habiendo dos equipos independientes |
| R1 | **La writer puede borrar o sobrescribir y quitar el ciclo de vida** | Mitigado por S-16; ventana ≤ 1 h | Vigilancia horaria; ante sospecha, `garage key deny` (§12) |
| R-KEY | Custodia de la clave (R7) | **Requisito obligatorio P-01** | Prueba de descifrado con la copia de custodia antes de activar |
| R-RESTORE | Credencial restore en custodia | **Requisito obligatorio P-02** | Comprobación de solo lectura desde un equipo del propietario |
| R-CODE | Origen del código | **Requisito obligatorio P-03** | Copia fijada por contenido, `venv` con hashes, `python -I`, unidad con sha256 |
| R-OBS | Sin aviso si el productor o el equipo dejan de ejecutarse; S-08 no cubre la frescura | **Requisito obligatorio P-05, sin excepción** | Vigilancia independiente implementada y probada por el operador antes de activar |
| R-SWAP | Swap de 8 GiB sin cifrar y ningún volumen `crypt`. `backup.key`, `remote.env` y `telegram-alert.env` en disco en claro (0600) | Decisión D-3 | `mitigar_paginacion` reduce la paginación (P-08), **no** la exposición en disco. Ninguna opción deja el riesgo en cero |
| R-CRED | Credenciales reales usadas en el simulacro | Rotación no obligatoria según el operador (evidence/49); decisión D-2 | `rotar_antes` añade P-07 |
| R-DEPS | Las bibliotecas difieren de las del simulacro. Allí corrieron boto3/botocore 1.43.85 con urllib3 2.0.7, six 1.16.0 y python-dateutil 2.8.2 de Ubuntu, más s3transfer 0.19.2. El lock de la revisión 2 fijaba los wheels de PyPI de esas versiones y reintroducía ocho avisos de `urllib3` que Ubuntu sí parchea (G7-REV2-01) | Lock de la revisión 3: boto3/botocore 1.43.85 sin cambios; urllib3 2.8.0, s3transfer 0.19.3, six 1.17.0 y python-dateutil 2.9.0.post0, todos compatibles con los rangos de botocore 1.43.85; `pip-audit` 0 en PyPI y OSV (§14.3). Pruebas repetidas con este entorno: suite y E2E por TLS + SigV4 (§14.1) | `pip-audit` en cada preflight; un aviso nuevo para la activación hasta clasificarlo por uso real. Cambiar versiones exige un lock nuevo, repetir las pruebas y una revisión nueva del dossier |
| R-ALERT | Mismo bot = sin redundancia. F-01 no se despliega | Aceptado por DEC-0064/0065 | Sin cambios |
| R9 | Si la base supera 1 GiB, deja de haber copia remota | ≈ 121 KB | Aviso del 80 % y E-FRESHNESS; ampliar exige DEC (DEC-0063) |
| R-RET | Bucket, copia protegida y local tienen 14 días cada uno. Ninguna supera 16 días | Decidido (DEC-0026/0046/0057) | Sin cambios |
| R-REST | La prueba mensual remota (§10.2) es manual | Brecha operativa | Primera restauración remota antes del día 7 y luego mensual, con evidencia (§11) |
| O-1…O-3 | Observaciones bajas o informativas del productor | Abiertas, sin riesgo para la integridad | Vigilarlas en la operación |
| S-11 | Primer `scrub` de Garage programado para el 2026-11-23 | Declarado (evidence/49) | Verificar tras esa fecha |

## 9. Responsabilidades

| Parte | Antes de la activación | Tras la activación |
|---|---|---|
| Propietario | Revisar el dossier; decidir si se publica la sesión; responder D-0, D-2 y D-3; P-01, P-02 y P-10; reinicio de P-08 si procede; confirmar la recepción de la prueba de P-05 | Avisos; custodia; autorizar cambios (DEC) |
| SOL MAIN | Este dossier; paso 1 de P-01; P-03 (con `pip-audit`), P-04, P-06 (lado MainSpot) y P-08; registro de preflight; **nunca habilitar el temporizador sin todos los requisitos en PASS** | Verificación inicial (§11), restauración remota con el propietario, informes sin secretos |
| OMP KVM 4 | P-05 dentro del límite del §5.1 y sus evidencias P05-E1…E6; coordinar la conformidad §14 con un ejecutor externo y publicar la evidencia S-15; P-06 (lado servicio); P-07 si procede | Ciclo de vida, vigilante, copia protegida, salud, S-08 y vigilancia de frescura; S-14 y S-15; cualquier cambio de P-05 fuera del §5.1 sigue la rama B |

## 10. Parámetros exactos de activación

**`~/.config/mainspot/backup/remote.env`** (0600, directorio 0700; P-10). La credencial la escribe el propietario en el
equipo:

```text
MAINSPOT_REMOTE_BACKUP_ENABLED=1
S3_ENDPOINT=https://s3.mainspot.canonflow.dev
S3_REGION=garage
S3_BUCKET=mainspot-backups
DEPLOYMENT_ID=mainspot-pilot
DATABASE=mainspot
AWS_ACCESS_KEY_ID=<writer: mainspot-backup-writer>
AWS_SECRET_ACCESS_KEY=<writer>
MAINSPOT_REMOTE_ALERT_COMMAND=/home/administrador/.local/libexec/mainspot/remote-alert-telegram.py
MAINSPOT_REMOTE_ALERT_COMMAND_SHA256=d42fe40b86c527c94c29f298af1c54c1fff94ef54db88e69b4f74eafedf442b1
```

- **Prohibido en producción:** cualquier `MAINSPOT_REMOTE_LAB_*` y `--lab-allow-http`.
- `MAINSPOT_BACKUP_DIR` y `MAINSPOT_BACKUP_KEY` mantienen sus valores por defecto.

**Código y entorno fijados (P-03):**
- `~/.local/libexec/mainspot/backup-remote/b714c783/` con `scripts/ops/backup/db-backup-remote.py` (`b714c783…bae7c`) y `docs/contracts/backup-object-storage/v1/reference/manifest_tool.py` (`b330ddfa…397c3`).
- `venv/` sin pip, instalado desde `gate7-producer-requirements.lock` de la revisión 3 (sha256 del lock `c674115d130f67903b6f6e8318a434eef37266da4928e3150b59973db55eed6b`).
- **La unidad versionada `scripts/ops/backup/systemd/mainspot-db-backup-remote.service` no se instala**: apunta al checkout de desarrollo.

**Unidad `~/.config/systemd/user/mainspot-db-backup-remote.service`**, variante A (sha256
`e25080691af1ad2494b3451f88cce3381468b0a95a463f8d2bf6d90731c892ea`):

```ini
[Unit]
Description=MainSpot — copia remota del respaldo cifrado a Garage S3 (código fijado b714c783, gate 7)
After=mainspot-db-backup.service

[Service]
Type=oneshot
WorkingDirectory=%h/.local/libexec/mainspot/backup-remote/b714c783
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/libexec/mainspot/backup-remote/b714c783/venv/bin/python -I %h/.local/libexec/mainspot/backup-remote/b714c783/scripts/ops/backup/db-backup-remote.py
UMask=0077
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=35min
```

La variante B (D-3 = `mitigar_paginacion`) es idéntica con una línea final `MemorySwapMax=0` (sha256
`04290a70e3d7ee8a98b9e803a42403c19c8e2dc862007e6a5bc8804aa32577a8`).

**Temporizador:** `scripts/ops/backup/systemd/mainspot-db-backup-remote.timer` sin cambios (sha256
`4acadf51828142edfff55cd33455b2af5407d85104bc9933d3da92149d8702b5`): `OnCalendar=*-*-* *:20:00`, `Persistent=true`.
La primera pasada útil del día es a las 03:20 America/Cancun (08:20Z), 5 min después del respaldo local.

## 11. Preflight y verificación inicial (solo tras el DEC)

1. **Registro de preflight**, publicado sin secretos en el issue de seguimiento y en Git. Una fila por requisito aplicable: id, resultado, evidencia y fecha. Si falta una fila o alguna está en FAIL, se para aquí.
2. `--dry-run` con la configuración real y la unidad fijada → `OK action=dry-run`, sin escrituras.
3. Habilitar el temporizador y lanzar una ejecución manual: se espera `OK action=uploaded attempts=1`, verificación §8.3 y `check=daily` con `lifecycle=ok`.
4. **Antes de 1 h**, el operador confirma la copia protegida (`copied`, `verify ok`), todas las comprobaciones de salud en `ok`, ciclo de vida exacto y que P-05 ha pasado de `unarmed` a `ok` con el primer respaldo.
5. **Días 1–7.** Revisión diaria del registro y de los avisos, además de la vigilancia P-05.
6. **Antes del día 7.** Primera restauración remota §10.2 con el **restore de custodia**: `verify` → `pg_restore` desechable → conteo → `--reapply-exits` → informe sin secretos. Después, mensual con evidencia.
7. Informe de activación con los SHA de ambos repositorios y el registro de preflight.

**Criterios de parada** (aplicar la desactivación del §12):
- un `FAIL` con E-TLS, E-AUTH-*, E-INTEGRITY-*, E-REMOTE-CONFLICT, E-RETENTION-VIOLATION o E-LOCAL-INTEGRITY en un respaldo de la ventana;
- `lifecycle` distinto de `ok`;
- un aviso del vigilante que no se explique;
- cualquier secreto en un registro;
- un sha256 de P-03 o P-04 distinto del esperado;
- un aviso de vulnerabilidad nuevo en el entorno fijado (P-03);
- un aviso de frescura de P-05 que no se explique.

## 12. Desactivación y rollback

| Situación | Acción | Verificación |
|---|---|---|
| Parada ordinaria | `systemctl --user disable --now mainspot-db-backup-remote.timer`; `MAINSPOT_REMOTE_BACKUP_ENABLED=0`, o retirar `remote.env` con `shred -u` | El productor fijado → `status=DISABLED`; `list-timers` sin la unidad remota |
| Sospecha de compromiso de la writer | Operador, con autorización del propietario: `garage key deny --read --write mainspot-backups --key mainspot-backup-writer` (`docs/07`); parada ordinaria y rotación | Log S3 e inventario frente a los manifiestos; copia protegida intacta |
| Objetos ya subidos | MainSpot no borra nada; caducan a los 14 días. Borrarlos antes exige una decisión aparte | Inventario del vigilante |
| Respaldo local | No se ve afectado en ningún caso | `mainspot-db-backup.timer` sigue activo |

## 13. Recuperación disponible

- **Procedimientos:**
  - §11.2 desde `mainspot-backups`, con restore y la clave de custodia;
  - §11.4 opción B, desde la copia;
  - §11.3 para reaplicar las bajas antes de abrir el tráfico.
- **Demostrado con datos sintéticos:** 6a (≈ 19 s de restauración) y 6b.
- **Objetivos de diseño, no medidos en producción:**
  - pérdida máxima ≈ 24 h;
  - copia remota pocos minutos después del local;
  - copia protegida ≤ 1 h después.
- **Prerrequisitos de la recuperación sin el equipo de MainSpot:** P-01 y P-02.

## 14. Verificaciones offline de esta revisión (2026-10-27)

Todo se hizo en `/tmp`, con el entorno definitivo del lock de la revisión 3. No se instaló nada en `~/.local` ni en
systemd, no hubo red hacia servicios reales y no se usaron secretos reales. Los scripts de comprobación son desechables
y no se versionan.

### 14.1 Ensayo de P-03 con el entorno definitivo

| Comprobación | Resultado |
|---|---|
| `git archive` del productor y `manifest_tool.py` | sha256 `b714c783…` y `b330ddfa…` (= §2.3) |
| Permisos | archivos 0400, directorios 0500, `venv` sin escritura; ningún `__pycache__` en el código fijado |
| `venv --without-pip` + `--require-hashes` desde el lock de la revisión 3 | boto3/botocore 1.43.85, urllib3 2.8.0, s3transfer 0.19.3, six 1.17.0, python-dateutil 2.9.0.post0, jmespath 1.1.0; sin pip; `python -I` → `sys.flags.isolated=1`; sha256 del árbol del `venv` `a93a4f1d…` (referencia del ensayo; se vuelve a medir en el preflight) |
| Unidades A y B | sha256 sin cambios (`e2508069…`, `04290a70…`); `systemd-analyze --user verify` sin errores (variante con las rutas del ensayo) |
| Suite `tests/ops/backup-remote` con un intérprete instalado desde el mismo lock (más pytest, solo para la prueba) | **98 passed** en 543,74 s, 0 fallos: `test_remote_producer.py` 40, `test_adversarial.py` 29 y `test_alert_telegram.py` 29. Laboratorio Garage local con firma SigV4 real (por HTTP) y Telegram simulado |
| **E2E sintético offline por TLS + SigV4** con la copia fijada (`venv/bin/python -I`), sin `--lab-allow-http`, contra Garage v2.4.1 de laboratorio detrás de un terminador TLS local con certificado propio | **10/10 PASS**: certificado no confiable → `E-TLS` y 0 objetos; secreto incorrecto (firma SigV4 rechazada) → `E-AUTH-DENIED` y 0 objetos; `--dry-run` → `action=dry-run` y 0 objetos (`E-FRESHNESS` esperado sin objetos); ejecución real → `OK action=uploaded attempts=1`, `check=daily` `lifecycle=ok` `complete=1`; `--check-only` OK; segunda ejecución → `already-complete`; restauración con reader por TLS → `manifest_tool verify` `valid:true` y descifrado = claro original; sin secretos en salida ni registro |

Las dos primeras ejecuciones del E2E fallaron por defectos del propio script de prueba, no del productor. La primera
(9/10) esperaba `rc=0` en `--dry-run`, cuando con el bucket vacío el productor termina con 1 por `E-FRESHNESS`. La
segunda (6/10) reutilizó el directorio de trabajo con un respaldo de la ejecución anterior. Ambos se corrigieron y la
ejecución con directorio limpio dio 10/10.

### 14.2 Combinaciones de respuestas

Se enumeraron todas las combinaciones de respuestas del borrador:
- D-0: `approve` / `reject` / `defer` / sin responder;
- D-2 y D-3: sus dos opciones o sin responder;
- notas que contradicen o no la regla.

Se cruzaron con todos los estados posibles (PASS/FAIL) de P-01…P-10 y se aplicó la regla del §7. Además se comprobó la
estructura del borrador:
- la única pregunta que puede llevar a la activación es la aprobación, y su `artifact_binding.sha256` es igual al sha256 de este archivo;
- no hay opciones preseleccionadas ni recomendadas;
- ninguna opción tiene un efecto de activación;
- la aprobación cita P-01…P-10;
- **no queda ninguna pregunta de excepción a P-05**.

Resultado: **73 728 combinaciones, 9 activaciones, 0 indebidas**, y 0 errores de estructura. Para comprobar que la verificación no es vacía, se mutó la regla: quitar P-05 o quitar P-01 produce, en cada caso, 9 activaciones indebidas.

Con el validador de respuestas del HDC (`validate_and_normalize`, sin escribir en el proyecto):
- los 12 conjuntos completos de respuestas son válidos;
- falta cualquiera de las tres preguntas obligatorias → rechazado (`required questions left unanswered`);
- una respuesta a la pregunta de excepción retirada → rechazada (`answers structure invalid`);
- `reject` sin comentario → rechazado. La
comprobación del sha256 del dossier al aprobar la hace el HDC en el envío real (`APPROVAL_BINDING_CHANGED`) y no se
ejercitó, porque no se publicó la sesión.

### 14.3 Vulnerabilidades de dependencias (G7-REV2-01)

`pip-audit` 2.10.1, bases PyPI y OSV:

| Entorno | Resultado |
|---|---|
| Lock de la revisión 2 (urllib3 2.0.7, s3transfer 0.19.2, six 1.16.0, python-dateutil 2.8.2) | **8 avisos distintos de `urllib3`**: PYSEC-2026-141, -1994, -1995, -1996, -1998, -1999, -4175 y -4177; corregidos en 2.2.2, 2.5.0, 2.6.0, 2.6.3, 2.7.0 y 2.8.0. Coincide con G7-REV2-01 |
| Lock de la revisión 3 (requisitos) | **0 vulnerabilidades** en ambas bases |
| `venv` instalado (`--path` sobre el site-packages) | **0 vulnerabilidades** en ambas bases |

No hace falta ninguna excepción. No se analizó si esos avisos eran explotables en el uso concreto de boto3 hacia el
endpoint del contrato. La actualización elimina la regresión sin depender de ese análisis.

### 14.4 Revisión 4 (G7-REV3-01)

Solo cambia el texto de la puerta: §5 P-05 y P-06, §5.1, §9 y §11. No cambian el código, el lock, las unidades, el
contrato ni las preguntas y opciones de la sesión. Por eso **no se repiten** la suite de laboratorio, el E2E por TLS +
SigV4 ni `pip-audit` (§14.1 y §14.3 siguen siendo válidos). Sí se repiten, porque el sha256 del dossier cambia:

- **Esquema HDC v2:** 0 errores de esquema y 0 de reglas cruzadas (validador idéntico al del pin `5e3dc307`).
- **Validador de respuestas:** los 12 conjuntos completos son válidos; se rechazan una pregunta obligatoria sin responder, una respuesta a la pregunta retirada y `reject` sin comentario.
- **Regla del §7:** 73 728 combinaciones, 9 activaciones, **0 indebidas**. Quitar P-05 o P-06 de la regla produce, en cada caso, 9 activaciones indebidas.
- **Coherencia G7-REV3-01:**
  - P-06 del dossier y del borrador ya no contiene «9/9» ni la declaración genérica «el comportamiento no cambia»;
  - P-06 cita S-14, S-15, §5.1 y `2af25580`;
  - el §5.1 contiene L1–L7, P05-E1…E6 y las ramas A y B;
  - P-05 del borrador remite al §5.1;
  - `v1/` (contrato) no cambia respecto a `d3eb3d2`.

  Para comprobar que el chequeo detecta regresiones, se reintrodujo «9/9» en P-06 del borrador y se detectó.

### 14.5 Revisión 5 (G7-REV4-01)

Solo cambia el texto de P-06(c), §5.1 (rama A y P05-E5) y §9. No cambian el código, el lock, las unidades, el contrato,
la regla del §7 ni las preguntas y opciones de la sesión. No se repiten la suite, el E2E, `pip-audit` ni el simulacro.
Sí se repiten, porque cambia el sha256 del dossier:

- **Esquema HDC v2:** 0 errores de esquema y 0 de reglas cruzadas (validador idéntico al del pin `5e3dc307`).
- **Validador de respuestas:** los 12 conjuntos completos son válidos; se rechazan una pregunta obligatoria sin responder, una respuesta a la pregunta retirada y `reject` sin comentario.
- **Regla del §7 (sin cambios):** 73 728 combinaciones, 9 activaciones, **0 indebidas**.
- **Comprobación documental G7-REV4-01:**
  - ni el dossier ni el borrador admiten que la conformidad se ejecute dentro del host del servicio (solo se admite «fuera del KVM 4» o «externo al KVM 4»);
  - P-06 del dossier exige «externo al KVM 4», «endpoint real», `check_s3_backup_contract.py` y S-15, y P-06 del borrador exige «externo al KVM 4», «endpoint real» y S-15;
  - P05-E5 exige el ejecutor externo;
  - el binding es igual al sha256 del dossier;
  - no cambian `v1/`, `scripts/`, `tests/` ni el lock respecto a `d07724f`.

  El chequeo detecta regresiones: aplicado a los bytes de la revisión 4 da 7 errores, y a la revisión 5 con P-06(c) revertido da 3.

## 15. Paquete para la revisión

| Pieza | Ubicación |
|---|---|
| Estado conciliado 1–6 y E1–E5 | `integration-status.md` |
| Informe del simulacro (rectificado) | `e2e-drill-report-2026-10-25.md` @ `c925e12` |
| Borrador de la sesión HDC (no publicado; perfil v2) | `gate7-qs-activation-draft.questions.json` |
| Entorno Python fijado (revisión 3) | `gate7-producer-requirements.lock` |
| Contrato | `v1/CONTRACT.md` @ `c4f87c4` |
| Evidencia del operador | `mainspot-s3-backups` evidence/43, 44, 45, 47, 48 y, en `2af25580`, 49 y 50 |
