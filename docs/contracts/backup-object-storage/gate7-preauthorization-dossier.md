# Dossier de preautorización: condición 7 (activación de respaldos remotos MainSpot → Garage S3)

No normativo, sin secretos. **Revisión 2**, del 2026-10-27, que atiende G7-REV-01…05 ([mainspot-platform#2, comentario
6402562530](https://github.com/hachxaan/mainspot-platform/issues/2#issuecomment-6402562530)) y sustituye a la revisión 1
(`334a1f7`).

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
| ¿Se puede **publicar** la sesión HDC? | **GO técnico para publicar**, por decisión del propietario: (a) condiciones 1–6 y E1–E5 acreditadas documentalmente; (b) borrador válido con el perfil HDC v2; (c) ninguna combinación de respuestas activa la producción sin los requisitos obligatorios (§7, comprobado en §14.2). Publicar no es activar |
| ¿Se puede **activar** la producción? | **NO-GO.** Solo con un `DEC-…` de autorización condicionada y con todos los requisitos obligatorios del §5 en PASS en un registro de preflight publicado (§11). Hoy faltan, como mínimo, P-01, P-02 y P-10 (propietario), P-05 (operador, salvo la excepción D-1) y la instalación real de P-03 (SOL MAIN, solo tras el DEC) |
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
   Sin cambios en `scripts/ops/backup` ni en `v1/` desde `92c3faa`.
4. **Los datos reales tienen hoy un tamaño mínimo.** Los respaldos locales rondan los 121 KB (el 0,011 % de 1 GiB) y la base solo contiene negocios sintéticos (§16.2).

## 3. Hechos probados con datos sintéticos frente a garantías aún no probadas con datos productivos

| Ámbito | Probado (sintético o sin datos) | No probado con datos productivos |
|---|---|---|
| Transporte | TLS de confianza pública, SigV4, conformidad externa `conformant=true` (20 PASS + 2 MANUAL) | — |
| Subida y verificación (§8) | B2: 2 subidas con `attempts=1`, `HeadObject`/`GetObject` §8.3, `check=daily` `complete=2` | Subidas diarias sostenidas, cadencia horaria durante días, objetos con la **clave real** (`key_id` real) |
| Límite de tamaño (§8.2 paso 0) | B3: rechazo antes de S3, `attempts=0`, respaldo local intacto; pruebas de laboratorio | Aviso del 80 % con datos reales (lejos del umbral) |
| Avisos | Productor: TEST-SYNTHETIC y E-SIZE-LIMIT E2E recibidos. KVM: `VIGIL-RETENTION-WARN` FIRING y RESOLVED recibidos | E-FRESHNESS y E-RETENTION-VIOLATION reales; **ningún aviso si el productor o el equipo dejan de ejecutarse** (P-05) |
| Restauración | 6a desde el bucket y 6b desde la copia con originales ausentes: `verify` `valid:true`, `pg_restore` rc=0, 33 tablas iguales, bajas reaplicadas | Descifrado con la **copia de custodia** de la clave (P-01); acceso con el **restore de custodia** (P-02); restauración con el volumen real |
| Copia protegida (§9.2) | D1 copia ≤ 1 h con sha256 = manifiesto; D4a/D4b: la writer no alcanza la copia; D6 restauración; E2 expiración con `--now` | Expiración real a 14 días con el reloj real |
| Retención (§9.1) | Alteración del ciclo de vida detectada y restaurada por el vigilante en 14 min, sin intervención | Borrado efectivo por el ciclo de vida de Garage a los 14 días (R5) |
| Capacidad (S-13) | PASS para R = 1 GiB (evidence/43 y 49); máximo observado 94 453 B | Crecimiento real de la base |
| Ejecución fijada | Ensayo offline del §14.1: copia de solo lectura, entorno con hashes, unidad verificada | La instalación real en `~/.local/libexec` (P-03, en el preflight) |

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
| Detección de que el productor dejó de correr | — | — | **No existe: requisito P-05 o excepción temporal (§6, D-1)** |
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
| **P-05** | **Vigilancia de frescura independiente** (G7-REV-03), **salvo excepción temporal aceptada en el HDC** (§6, D-1) | Un proceso que **no** corre en el equipo de MainSpot comprueba al menos cada hora que el respaldo completo más reciente en `v1/mainspot-pilot/postgres/mainspot/` tiene menos de 26 h (por manifiesto o `created_at`), y avisa por un canal fuera del equipo de MainSpot (bot del KVM 4, DEC-0055). El operador publica, con commit del servicio, una prueba sintética: aviso FIRING con el bucket sin respaldo reciente y RESOLVED al volver a haberlo | Operador KVM 4 (implementa); propietario (confirma la recepción) | Sin activación, salvo D-1 aceptada |
| **P-06** | **Estado sin cambios respecto a la sesión** | Contrato `c4f87c4`. Servicio en `2af25580`, o posterior con declaración del operador de que el comportamiento no cambia. Salud 9/9, ciclo de vida §9.1 exacto y `v1/mainspot-pilot/` vacío el día de la activación. Hashes del §2.3 sin cambios | Operador; SOL MAIN | Sin activación; si cambió algo normativo, nueva sesión |
| **P-07** | **Rotación**, solo si D-2 = `rotar_antes` | `docs/07` «Rotación (sin corte)» aplicado; C-03, C-04, C-21 y C-22 en PASS con las claves nuevas; claves anteriores revocadas | Operador; propietario | Sin activación |
| **P-08** | **Mitigación de la paginación**, solo si D-3 = `mitigar_paginacion` | (a) Tras un reinicio, swap cifrado con clave efímera o sin swap: `swapon --show` y `lsblk -o NAME,TYPE` muestran el dispositivo de swap como `crypt`, o ninguno. (b) `MemorySwapMax=0` en `mainspot-db-backup-remote.service` (variante B, §10), `mainspot-db-backup.service` y `mainspot-db-restore-test.service`, comprobado con `systemctl --user show -p MemorySwapMax` = 0. El controlador de memoria está delegado en este equipo y el efecto se comprobó el 2026-10-27 (`memory.swap.max` = 0) | SOL MAIN; propietario (reinicio) | Sin activación |
| **P-09** | **Vigencia de la autorización** | Todos los requisitos aplicables en PASS dentro de los **30 días** siguientes al DEC | — | La autorización caduca; hace falta una sesión nueva |
| **P-10** | **`remote.env` provisto por el propietario en el equipo** | Archivo 0600 en un directorio 0700, con las claves del §10 y sin `MAINSPOT_REMOTE_LAB_*`; secretos nunca transmitidos por chats ni issues | Propietario; SOL MAIN comprueba permisos y claves (no valores) | Sin activación |

**Comprobaciones de P-03:**
- **Origen.** `git archive` de un commit cuyo productor y `manifest_tool.py` tienen los sha256 del §2.3, en `~/.local/libexec/mainspot/backup-remote/b714c783/`. Se conserva la ruta relativa que usa `REPO_ROOT`.
- **Permisos.** Archivos 0400, directorios 0500, `venv` sin escritura; nada escribible por grupo u otros.
- **Entorno Python propio.** `venv` instalado **solo** con `pip install --no-deps --only-binary=:all: --require-hashes -r gate7-producer-requirements.lock` (mismas versiones que el simulacro) y ejecutado con `python -I`, que ignora el site-packages del usuario y las variables `PYTHON*`. Se registran `pip freeze` y el sha256 del árbol del `venv`.
- **Unidad.** La variante A o B del §10, con sha256 exacto; `systemd-analyze --user verify` sin errores; ninguna referencia a `codeart/`.
- **Calendario.** `systemd-analyze calendar '*-*-* *:20:00'` en America/Cancun (UTC−5).
- **Ensayo.** `--dry-run` con la configuración real **antes** de habilitar el temporizador: `OK action=dry-run` y cero escrituras.
- **Suite de laboratorio.** `tests/ops/backup-remote` en PASS con el intérprete del `venv` fijado.

## 6. Decisiones de aceptación de riesgo (sesión HDC)

Son las únicas elecciones del propietario. Cada opción es válida, pero ninguna exime de los requisitos del §5. Algunas
**añaden** requisitos.

| Id | Pregunta HDC | Opciones | Efecto sobre la ejecución |
|---|---|---|---|
| **D-0** | `Q-ACTIVATION-CONDITIONAL` (aprobación ligada al sha256 de este dossier) | `approve` / `reject` (con comentario) / `defer` | `approve` = **autorización condicionada**: la activación solo se ejecuta según la regla del §7. `reject` y `defer`: sin activación. **No existe una opción de autorización incondicional** |
| **D-1** | `Q-WATCHDOG-EXCEPTION` (aceptación de riesgo con caducidad) | aceptar (fecha de caducidad + justificación) / no aceptar | **No aceptar:** P-05 es obligatorio antes de activar. **Aceptar:** se permite activar sin P-05 como **piloto temporal**, con estas condiciones: (1) vigencia hasta la fecha de caducidad indicada, con un máximo de 30 días desde la activación; (2) revisión humana diaria registrada (una línea por día en el issue de seguimiento: `OK action=uploaded` del día y `newest_age_h`); (3) **control de salida**: si al vencer la excepción P-05 no está en PASS, o si faltan dos revisiones diarias seguidas, SOL MAIN aplica la parada ordinaria del §12. El respaldo local no se ve afectado. Esta excepción no es adecuada si el propietario prevé ausencias |
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
3. **P-05** está en PASS, **o** D-1 = aceptada y su caducidad no ha pasado.
4. Si D-2 = `rotar_antes`, **P-07** está en PASS.
5. Si D-3 = `mitigar_paginacion`, **P-08** está en PASS.
6. Ninguna nota de `Q-NOTES` contradice la regla.

En cualquier otro caso no se activa. Sin DEC, con una pregunta obligatoria sin responder, con `reject` o `defer`, o con
algún requisito pendiente, el productor sigue `DISABLED` y sin temporizador. Esto incluye la combinación «custodia sin
probar + `approve`»: P-01 no está en PASS, así que no hay activación (G7-REV-01).

| D-0 | D-1 | D-2 | D-3 | Requisitos para activar |
|---|---|---|---|---|
| `reject` / `defer` / sin DEC | cualquiera | cualquiera | cualquiera | **Nunca** |
| `approve` | no aceptada | `no_rotar` | `aceptar_riesgo` | P-01…P-06, P-09, P-10 |
| `approve` | no aceptada | `rotar_antes` | `aceptar_riesgo` | lo anterior + P-07 |
| `approve` | no aceptada | cualquiera | `mitigar_paginacion` | lo anterior + P-08 |
| `approve` | aceptada (vigente) | cualquiera | cualquiera | igual que arriba, sin P-05, más las condiciones de la excepción (revisión diaria y control de salida) |
| `approve` | aceptada (caducada) | cualquiera | cualquiera | P-05 obligatorio |

## 8. Riesgos residuales

| Id | Riesgo | Situación | Tratamiento |
|---|---|---|---|
| R2 | **Nodo único.** Perder el KVM 4 pierde a la vez la copia remota y la protegida | Aceptado por DEC-0048 / DEC-0049 §5 | Registrado. Sigue habiendo dos equipos independientes |
| R1 | **La writer puede borrar o sobrescribir y quitar el ciclo de vida** | Mitigado por S-16; ventana ≤ 1 h | Vigilancia horaria; ante sospecha, `garage key deny` (§12) |
| R-KEY | Custodia de la clave (R7) | **Requisito obligatorio P-01** | Prueba de descifrado con la copia de custodia antes de activar |
| R-RESTORE | Credencial restore en custodia | **Requisito obligatorio P-02** | Comprobación de solo lectura desde un equipo del propietario |
| R-CODE | Origen del código | **Requisito obligatorio P-03** | Copia fijada por contenido, `venv` con hashes, `python -I`, unidad con sha256 |
| R-OBS | Sin aviso si el productor o el equipo dejan de ejecutarse; S-08 no cubre la frescura | **Requisito obligatorio P-05**, o excepción temporal D-1 | Vigilancia independiente, o piloto acotado con revisión diaria y control de salida |
| R-SWAP | Swap de 8 GiB sin cifrar y ningún volumen `crypt`. `backup.key`, `remote.env` y `telegram-alert.env` en disco en claro (0600) | Decisión D-3 | `mitigar_paginacion` reduce la paginación (P-08), **no** la exposición en disco. Ninguna opción deja el riesgo en cero |
| R-CRED | Credenciales reales usadas en el simulacro | Rotación no obligatoria según el operador (evidence/49); decisión D-2 | `rotar_antes` añade P-07 |
| R-DEPS | El simulacro usó boto3/botocore 1.43.85 del site-packages del usuario, con urllib3, six y python-dateutil empaquetados por Ubuntu. El `venv` fijado usa los wheels de PyPI de **las mismas versiones**, sin los parches que Ubuntu pudiera haber aplicado | Ensayo de laboratorio con el `venv` fijado: §14.1 | Actualizar versiones exige repetir la suite y el ensayo |
| R-ALERT | Mismo bot = sin redundancia. F-01 no se despliega | Aceptado por DEC-0064/0065 | Sin cambios |
| R9 | Si la base supera 1 GiB, deja de haber copia remota | ≈ 121 KB | Aviso del 80 % y E-FRESHNESS; ampliar exige DEC (DEC-0063) |
| R-RET | Bucket, copia protegida y local tienen 14 días cada uno. Ninguna supera 16 días | Decidido (DEC-0026/0046/0057) | Sin cambios |
| R-REST | La prueba mensual remota (§10.2) es manual | Brecha operativa | Primera restauración remota antes del día 7 y luego mensual, con evidencia (§11) |
| O-1…O-3 | Observaciones bajas o informativas del productor | Abiertas, sin riesgo para la integridad | Vigilarlas en la operación |
| S-11 | Primer `scrub` de Garage programado para el 2026-11-23 | Declarado (evidence/49) | Verificar tras esa fecha |

## 9. Responsabilidades

| Parte | Antes de la activación | Tras la activación |
|---|---|---|
| Propietario | Revisar el dossier; decidir si se publica la sesión; responder D-0…D-3; P-01, P-02 y P-10; reinicio de P-08 si procede; confirmar la recepción de la prueba de P-05 | Avisos; revisión diaria si D-1; custodia; autorizar cambios (DEC) |
| SOL MAIN | Este dossier; paso 1 de P-01; P-03, P-04, P-06 (lado MainSpot) y P-08; registro de preflight; **nunca habilitar el temporizador sin todos los requisitos en PASS** | Verificación inicial (§11), control de salida de D-1, restauración remota con el propietario, informes sin secretos |
| OMP KVM 4 | P-05 (vigilancia de frescura); P-06 (lado servicio); P-07 si procede | Ciclo de vida, vigilante, copia protegida, salud, S-08 y vigilancia de frescura; S-14 y S-15 |

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
- `venv/` instalado desde `gate7-producer-requirements.lock` (sha256 del lock `9e092b50430251eddbac6566a5a96bcbfe83c98f069fb61be5646eef2d545804`).
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
4. **Antes de 1 h**, el operador confirma la copia protegida (`copied`, `verify ok`), salud 9/9, ciclo de vida exacto y, si existe P-05, que la vigilancia de frescura ve el respaldo.
5. **Días 1–7.** Revisión diaria; registrada si D-1 está aceptada.
6. **Antes del día 7.** Primera restauración remota §10.2 con el **restore de custodia**: `verify` → `pg_restore` desechable → conteo → `--reapply-exits` → informe sin secretos. Después, mensual con evidencia.
7. Informe de activación con los SHA de ambos repositorios y el registro de preflight.

**Criterios de parada** (aplicar la desactivación del §12):
- un `FAIL` con E-TLS, E-AUTH-*, E-INTEGRITY-*, E-REMOTE-CONFLICT, E-RETENTION-VIOLATION o E-LOCAL-INTEGRITY en un respaldo de la ventana;
- `lifecycle` distinto de `ok`;
- un aviso del vigilante que no se explique;
- cualquier secreto en un registro;
- un sha256 de P-03 o P-04 distinto del esperado;
- el control de salida de D-1.

## 12. Desactivación y rollback

| Situación | Acción | Verificación |
|---|---|---|
| Parada ordinaria (incluido el control de salida de D-1) | `systemctl --user disable --now mainspot-db-backup-remote.timer`; `MAINSPOT_REMOTE_BACKUP_ENABLED=0`, o retirar `remote.env` con `shred -u` | El productor fijado → `status=DISABLED`; `list-timers` sin la unidad remota |
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

### 14.1 Ensayo de P-03 (en `/tmp`, sin instalar nada en `~/.local`, sin red hacia servicios reales ni secretos)

| Comprobación | Resultado |
|---|---|
| `git archive` del productor y `manifest_tool.py` | sha256 `b714c783…` y `b330ddfa…` (= §2.3) |
| Permisos | archivos 0400, directorios 0500, `venv` sin escritura; ningún `__pycache__` en el código fijado |
| `venv` con `--require-hashes` desde el lock | boto3/botocore 1.43.85, urllib3 2.0.7; `python -I` → `sys.flags.isolated=1`, boto3 cargado del `venv` |
| `REPO_ROOT` y `manifest_tool` desde la copia fijada | resueltos dentro de la copia; `load_manifest_tool()` OK |
| `--dry-run` con configuración, clave y respaldo sintéticos contra un puerto local cerrado | lee configuración y clave, carga `manifest_tool` y boto3, y termina en `E-NETWORK attempts=5` (32 s), sin escrituras remotas |
| Unidades A y B | `systemd-analyze --user verify` sin errores (variante con las rutas del ensayo); sin referencias a `codeart/` |
| Calendario | `*-*-* *:20:00` → 05:20 EST = 10:20Z (America/Cancun, UTC−5) |
| `MemorySwapMax=0` en unidades de usuario | controlador `memory` delegado; `memory.swap.max` = 0 observado |
| Suite `tests/ops/backup-remote` con el intérprete del `venv` fijado | **98 passed** en 589,95 s, 0 fallos (laboratorio Garage local y Telegram simulado). El productor se lanzó con un `venv` instalado desde el mismo lock (más pytest, solo para la prueba) |

### 14.2 Combinaciones de respuestas

Se enumeraron todas las combinaciones de respuestas del borrador:
- D-0: `approve` / `reject` / `defer` / sin responder;
- D-1: aceptada vigente / aceptada caducada / no aceptada / sin responder;
- D-2 y D-3: sus dos opciones o sin responder.

Se cruzaron con todos los estados posibles (PASS/FAIL) de P-01…P-10 y se aplicó la regla del §7. En ningún caso hay
activación con un requisito obligatorio o condicional pendiente. Además se comprobó la estructura del borrador:
- la única pregunta que puede llevar a la activación es la aprobación ligada al sha256 de este dossier;
- no hay opciones preseleccionadas ni recomendadas;
- ninguna opción de las demás preguntas tiene un efecto de activación;
- la explicación de la aprobación cita todos los requisitos P-01…P-10.

Resultado: **294 912 combinaciones, 36 activaciones, 0 indebidas**, y 0 errores de estructura. Para comprobar que la verificación no es vacía, se mutó la regla: quitar P-01 produce 36 activaciones indebidas y aceptar una excepción caducada produce 9. El script de comprobación es desechable y no se versiona.

Con el validador de respuestas del HDC (`validate_and_normalize`, sin escribir en el proyecto) se comprobó lo siguiente:
- los 24 conjuntos completos de respuestas son válidos;
- un envío sin `Q-ACTIVATION-CONDITIONAL` o sin `Q-WATCHDOG-EXCEPTION` se rechaza con `REQUIRED_MISSING`;
- aceptar la excepción con caducidad el mismo día se rechaza.

La comprobación del sha256 del dossier al aprobar la hace el HDC en el envío real (`APPROVAL_BINDING_CHANGED`) y no se
ejercitó, porque no se publicó la sesión.

## 15. Paquete para la revisión

| Pieza | Ubicación |
|---|---|
| Estado conciliado 1–6 y E1–E5 | `integration-status.md` |
| Informe del simulacro (rectificado) | `e2e-drill-report-2026-10-25.md` @ `c925e12` |
| Borrador de la sesión HDC (no publicado; perfil v2) | `gate7-qs-activation-draft.questions.json` |
| Entorno Python fijado | `gate7-producer-requirements.lock` |
| Contrato | `v1/CONTRACT.md` @ `c4f87c4` |
| Evidencia del operador | `mainspot-s3-backups` evidence/43, 44, 45, 47, 48 y, en `2af25580`, 49 y 50 |
