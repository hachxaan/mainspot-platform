# Dossier de preautorización: condición 7 (activación de respaldos remotos MainSpot → Garage S3)

No normativo, sin secretos.

- **Preparado por:** SOL MAIN, bajo el mandato de [mainspot-platform#2](https://github.com/hachxaan/mainspot-platform/issues/2).
- **Contrato:** 1.2.0 `c4f87c4aa2e875e7ad01861f5f2a809e025d638c`.
- **Base MainSpot:** `f70d655876cf88834ed8ff4d02045c54998256db`.
- **Servicio:** `hachxaan/mainspot-s3-backups@6945a6329f8e36f11a56c380ce6696ef6fae4260`.
- **Estado de las condiciones 1–6 y de E1–E5:** `integration-status.md`.

Este dossier **no solicita** la decisión HDC ni activa nada. Prepara el paquete para que el propietario lo revise
y, si procede, se publique después una sesión HDC propia. El borrador de esa sesión está en
`gate7-qs-activation-draft.questions.json` (no publicado). Toda configuración productiva futura exige un
`DEC-…` explícito del propietario (§2.3, DEC-0049 §7, DEC-0054 §4, DEC-0058 §4). Recibir un mensaje de
Telegram no equivale a autorizar la producción.

## 1. Dictamen

| Pregunta | Dictamen |
|---|---|
| ¿Se puede **solicitar** ya la condición 7? | **NO-GO**, mientras falten **E4 independiente** (operador KVM 4) y **E5** del servicio. Sin ellos no están acreditadas documentalmente S-13 (condición 2) ni las condiciones 5 y 6 (`e2e-drill-handoff.md`, fase E) |
| ¿Qué falta para pasar a GO? | (a) Comentario y commit del operador con E4 contraverificado según `docs/15` §E4 y `docs/14` §5. (b) Informe E5 del servicio que cite 1.2.0 `c4f87c4`, con S-13 tras el simulacro, S-15 vigente, §9.2.6 1–7 y matriz PASS/OPEN. (c) Revisión de este dossier por el propietario. Con (a) y (b) consistentes con lo aquí descrito, el dictamen pasa a **GO para solicitar**, no para activar |
| ¿Se puede **activar** la producción? | **No.** Solo tras un `DEC-…` de autorización en una sesión HDC propia, y siguiendo el §8 de este dossier |
| ¿La mejora F-01 (botón de acuse) entra en la activación? | **No.** Está aislada en `feat/f01-telegram-acknowledged-alerts`, sin fusionar ni desplegar, con AUD-01/02/03 pendientes. La activación usa el adaptador `d42fe40b`, el que superó el simulacro |

Fuera de E4/E5 no se ha encontrado ningún bloqueo de la puerta. Los riesgos del §5 los decide el propietario en la
sesión HDC; no son condiciones de §2.3.

## 2. Premisas

1. **Qué se autorizaría.** Copiar cada día el mismo `.dump.enc` que ya produce `db-backup.sh` (cifrado en MainSpot) a `https://s3.mainspot.canonflow.dev/mainspot-backups`, según el §8 del contrato, con la credencial **writer**. El respaldo local, su retención de 14 días y la prueba local mensual no cambian.
2. **Qué no se autorizaría.**
   - transmitir la clave de descifrado;
   - debilitar TLS;
   - ampliar el máximo de 1 GiB o la cuota de 50 GiB (DEC-0063);
   - cambiar la retención;
   - borrar objetos desde MainSpot;
   - usar la mejora F-01;
   - cualquier canal de aviso distinto de los aprobados (DEC-0055, DEC-0064).
3. **El código que se activaría es el mismo que pasó el simulacro.**
   - Productor `b714c783…bae7c`, adaptador `d42fe40b…f442b1` (instalado) y `manifest_tool.py` `b330ddfa…397c3`.
   - No hay cambios en `scripts/ops/backup` ni en `v1/` entre `92c3faa` y `f70d655`.
4. **Los datos reales tienen hoy un tamaño mínimo.** Los respaldos locales rondan los 121 KB (el 0,011 % de 1 GiB) y la base solo contiene negocios sintéticos (§16.2).

## 3. Hechos probados con datos sintéticos frente a garantías aún no probadas con datos productivos

| Ámbito | Probado (sintético o sin datos) | No probado con datos productivos |
|---|---|---|
| Transporte | TLS de confianza pública, SigV4, conformidad externa `conformant=true` (20 PASS + 2 MANUAL) | — |
| Subida y verificación (§8) | B2: 2 subidas con `attempts=1`, `HeadObject`/`GetObject` §8.3, `check=daily` `complete=2` | Subidas diarias sostenidas, cadencia horaria durante días, objetos cifrados con la **clave real** (`key_id` real) |
| Límite de tamaño (§8.2 paso 0) | B3: rechazo antes de S3, `attempts=0`, respaldo local intacto; 69 pruebas de laboratorio | Aviso del 80 % con datos reales (lejos del umbral) |
| Avisos | Productor: TEST-SYNTHETIC y E-SIZE-LIMIT E2E recibidos. KVM: `VIGIL-RETENTION-WARN` FIRING y RESOLVED recibidos | E-FRESHNESS y E-RETENTION-VIOLATION reales |
| Restauración | 6a desde el bucket y 6b desde la copia con originales ausentes: `verify` `valid:true`, `pg_restore` rc=0, 33 tablas iguales, bajas reaplicadas | Restauración con la **clave real** desde la **copia de custodia del propietario** (DEC-0053) y con el volumen real |
| Copia protegida (§9.2) | D1 copia ≤ 1 h con sha256 = manifiesto; D4a/D4b: la writer no alcanza la copia; D6 restauración; E2 expiración local con `--now` | Expiración real a 14 días con el reloj real |
| Retención (§9.1) | Alteración del ciclo de vida (T0) detectada y restaurada por el vigilante en 14 min, sin intervención | Borrado efectivo por el ciclo de vida de Garage a los 14 días (R5: la configuración se comprueba; la edad depende del código de Garage) |
| Capacidad (S-13) | Capacidad para R = 1 GiB medida (evidence/43); máximo observado 94 453 B | Crecimiento real de la base |

## 4. Tabla de garantías

| Garantía (contrato / DEC) | Mecanismo | Evidencia | Estado |
|---|---|---|---|
| La clave de descifrado nunca sale del equipo de MainSpot (§16.1, DEC-0045/0053) | Cifrado local previo; el productor lee la clave solo para `key_id` y MAC | Código y laboratorio; simulacro con clave sintética | Probado (sintético) |
| Integridad y autenticidad (§5.3, R3) | MAC del manifiesto + SHA-256 antes de descifrar | `verify` `valid:true` en 6a y 6b; pruebas adversariales | Probado (sintético) |
| El respaldo grande no se sube (DEC-0059/0061) | Paso 0 antes de S3 | B3 | Probado |
| Expiración a 14 días; nada supera 16 días (§9.1, DEC-0046/0057) | Ciclo de vida exacto + vigilante horario + inventario diario + `check=daily` del productor | E2, D7, conformidad C-15 | Configuración probada; borrado efectivo con reloj real no observado |
| Recuperable aunque la writer borre (R1, DEC-0047/0056) | Copia protegida opción B ≤ 1 h; la writer no tiene ruta | D1–D6, E2; S-16 PASS | Probado (sintético). Residual: ventana ≤ 1 h |
| Recuperación sin el equipo de MainSpot (DEC-0054 §3) | Custodia del propietario: clave + credencial restore; §11.2/§11.4 | 6a/6b ejecutadas desde el equipo de MainSpot con clave sintética | **No probado con la copia de custodia**: §5 R-KEY |
| Avisos fuera del KVM 4 (S-08, DEC-0055/0058 §1) | Bot del vigilante | evidence/37; avisos del simulacro | Probado |
| Avisos del productor (DEC-0064/0065) | Adaptador `d42fe40b`, cola acotada, sin éxito falso | TEST-SYNTHETIC; E-SIZE-LIMIT E2E recibido | Probado |
| Sin secretos en registros (§16.3, S-12) | Formato de línea; pruebas `no_secrets` | Laboratorio; log S3 revisado (evidence/48) | Probado |

## 5. Riesgos residuales (para decisión informada del propietario)

| Id | Riesgo | Situación | Tratamiento propuesto |
|---|---|---|---|
| R2 | **Nodo único.** Perder el KVM 4 pierde a la vez la copia remota y la protegida (mismo VPS y mismo sistema de archivos) | Aceptado por DEC-0048 / DEC-0049 §5 | Mantenerlo registrado. Sigue habiendo dos equipos independientes (MainSpot con 14 días locales + KVM 4). Reevaluar al crecer los datos reales |
| R1 | **La writer puede borrar o sobrescribir y quitar el ciclo de vida** | Mitigado por S-16; ventana ≤ 1 h | Vigilancia horaria; ante sospecha, `garage key deny` inmediato (§9) |
| R-KEY | **Custodia de la clave (R7, DEC-0053).** No hay evidencia de que la copia de custodia del propietario exista y descifre. Ni los agentes pueden ni deben verificarla | Sin acreditar | El propietario la declara en la sesión HDC. Se propone como control previo una prueba de descifrado de un respaldo local con la copia de custodia, en un equipo propio y sin publicar nada. Sin esa copia, perder el equipo de MainSpot deja todo ilegible |
| R-SWAP | **Swap sin cifrar.** El equipo de MainSpot tiene `/swap.img` de 8 GiB sin cifrar y ningún volumen `crypt`. En el simulacro las credenciales estuvieron en tmpfs ≈ 1 h 25 min; no hay evidencia de paginación. En producción, `remote.env` (writer) y `backup.key` estarán **en disco en claro, con 0600**, y podrían paginarse | Observado | Opción A: aceptar el riesgo; el disco ya guarda `backup.key` en claro, así que el swap no añade una exposición cualitativa. Opción B: mitigar antes de activar (swap cifrado o `MemorySwapMax=0` en la unidad remota, más revisar el cifrado del disco). Lo decide el propietario |
| R-CRED | **Credenciales usadas en el simulacro.** Las claves reales writer/reader viajaron cifradas por el buzón temporal y estuvieron en tmpfs en el equipo de MainSpot | El operador concluyó que la rotación no es obligatoria: log S3 sin desviaciones (evidence/48) | Opción A: no rotar. Opción B: rotar writer y reader antes de activar (`docs/07` «Rotación (sin corte)»), con C-03/C-04/C-21/C-22 posteriores. Lo decide el propietario |
| R-CODE | **Origen del código en producción.** La unidad remota escrita ejecuta el productor desde el checkout de desarrollo. Ese checkout cambia de rama (incluida la rama F-01), así que producción quedaría acoplada a lo que esté desprotegido en cada momento | Detectado en esta revisión | Ejecutar desde una copia fijada por commit y sha256 (§7). Requiere cambiar la unidad dentro del cambio de activación |
| R-OBS | **Sin «hombre muerto».** E-FRESHNESS lo calcula el propio productor al ejecutarse. Si el temporizador o el equipo dejan de correr, ni MainSpot ni el inventario del KVM 4 avisan (según S-08, ese inventario vigila la cota de 16 días y los huérfanos de 24 h, no la frescura) de que falta el respaldo de hoy | Brecha observada | Verificación diaria del propietario durante la primera semana (§8). Decidir aparte (fuera de la condición 7) un aviso de frescura independiente, p. ej. del vigilante del KVM 4. Requiere un cambio de servicio y posiblemente de contrato |
| R-ALERT | **Canal de avisos.** Mismo bot = sin redundancia. Recepción del productor acreditada con el adaptador original. F-01 (acuse) no se despliega | Aceptado por DEC-0064/0065 | Sin cambios. F-01 sigue su propio camino de auditoría y gates |
| R9 | Si la base supera 1 GiB, deja de haber copia remota (E-SIZE-LIMIT) | Lejos del umbral (≈ 121 KB) | Aviso del 80 % y E-FRESHNESS; ampliar exige DEC (DEC-0063) |
| R-RET | **Retención y copias.** Bucket, copia protegida y local tienen 14 días cada uno. Ninguna copia supera 16 días. No hay copia de más largo plazo | Decidido (DEC-0026/0046/0057) | Sin cambios |
| O-1…O-3 | Observaciones bajas o informativas del productor (`03-adversarial-validation.md`): ruido E-LOCAL-INTEGRITY fuera de ventana, `check=daily` ausente si una petición agota los reintentos, manifiesto sin objeto pasa a FAIL | Abiertas, sin riesgo para la integridad | Vigilarlas en la operación; ninguna bloquea |
| S-11 | `scrub` de Garage programado para el 2026-11-23, aún no completado | Declarado por el operador | Verificar tras esa fecha |
| R-REST | **La prueba mensual remota (§10.2) es manual.** `db-restore-test.sh` solo prueba el respaldo local; la restauración desde el servicio con **restore** no tiene temporizador | Brecha operativa | Primera prueba remota en los 7 días siguientes a activar y luego mensual, siguiendo los pasos C del simulacro y §10.2 (§8) |

## 6. Responsabilidades

| Parte | Antes de la activación | Tras la activación |
|---|---|---|
| Propietario | Revisar el dossier; declarar la custodia de la clave y de restore; decidir R-SWAP y R-CRED; responder la sesión HDC; provisionar `remote.env` sin pegar valores en chats | Recibir y atender los avisos; custodiar; autorizar cambios (DEC) |
| SOL MAIN (ejecutor MainSpot) | Este dossier; instalación fijada (§7) **solo tras el DEC** | Verificación inicial (§8), operación del productor, prueba mensual remota con el propietario, informes sin secretos |
| OMP KVM 4 (operador) | E4 y E5; S-15 vigente | Ciclo de vida, vigilante, copia protegida, salud, S-08; notificar antes de cambios (S-14); S-15 tras cambios |

## 7. Parámetros exactos de activación propuestos (para el DEC)

**`~/.config/mainspot/backup/remote.env`** (0600, directorio 0700). La credencial la escribe el propietario en el
equipo, sin pasarla por chats ni issues:

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

- `DEPLOYMENT_ID=mainspot-pilot` y la región `garage` están en estado PROPUESTO en el contrato (§2.2). El DEC debe confirmarlos.
- **Prohibido en producción:** cualquier `MAINSPOT_REMOTE_LAB_*` y `--lab-allow-http`.
- Sin cambios: `MAINSPOT_BACKUP_DIR` y `MAINSPOT_BACKUP_KEY` mantienen sus valores por defecto (`~/.local/share/mainspot/backups`, `~/.config/mainspot/backup/backup.key`).

**Código fijado (R-CODE):**
1. Extraer el commit autorizado con `git archive <commit> scripts/ops/backup/db-backup-remote.py docs/contracts/backup-object-storage/v1/reference/manifest_tool.py`.
2. Colocarlo en `~/.local/libexec/mainspot/backup-remote/<commit>/` (0700), conservando la estructura relativa que usa `REPO_ROOT`.
3. Verificar sha256 `b714c783…bae7c` y `b330ddfa…397c3`.

**Unidades systemd** de usuario (`scripts/ops/backup/systemd/mainspot-db-backup-remote.{service,timer}`):
- `WorkingDirectory` y `ExecStart` apuntan a la copia fijada, no al checkout.
- Si se decide R-SWAP B, añadir `MemorySwapMax=0`.
- Temporizador `OnCalendar=*-*-* *:20:00`, `Persistent=true`: cada hora, y la primera pasada útil a las 03:20, 5 min después del respaldo local de las 03:15 (America/Cancun).
- `TimeoutStartSec=35min`, `UMask=0077`.

**Entorno de ejecución:** Python 3.12.3, boto3/botocore 1.43.85 en el site-packages del usuario, NTP sincronizado. El
productor detiene la ejecución con E-AUTH-SKEW si la diferencia de reloj supera 300 s.

## 8. Procedimiento de verificación inicial (solo tras el DEC)

1. **T−0.** Verificar sha256 de la copia fijada y del adaptador. `--dry-run` → `OK action=dry-run` del último respaldo, sin escrituras.
2. Habilitar el temporizador y lanzar una ejecución manual: se espera `OK action=uploaded attempts=1`, verificación §8.3 y `check=daily` con `lifecycle=ok`. El aviso de cantidad fuera de 13–16 es esperado los primeros días.
3. **Antes de 1 h**, el operador confirma que el respaldo está en la copia protegida (`copied`, `verify ok`), salud 9/9 y ciclo de vida exacto.
4. **Días 1–7.** El propietario revisa a diario el registro y los avisos (mitigación de R-OBS): un `OK action=uploaded` por respaldo local y `newest_age_h < 26`.
5. **Antes del día 7.** Primera restauración remota §10.2 con **restore**, aportada temporalmente por el propietario y destruida al terminar: `verify` → `pg_restore` desechable → conteo → `--reapply-exits` → informe sin secretos.
6. Informe de activación publicado con los SHA de ambos repositorios.

**Criterios de parada** (aplicar la desactivación del §9):
- cualquier `FAIL` con E-TLS, E-AUTH-*, E-INTEGRITY-*, E-REMOTE-CONFLICT, E-RETENTION-VIOLATION o E-LOCAL-INTEGRITY en un respaldo de la ventana;
- `lifecycle` distinto de `ok`;
- un aviso del vigilante que no se explique;
- cualquier secreto en un registro.

## 9. Desactivación y rollback

| Situación | Acción | Verificación |
|---|---|---|
| Parada ordinaria | `systemctl --user disable --now mainspot-db-backup-remote.timer`; `MAINSPOT_REMOTE_BACKUP_ENABLED=0`, o retirar `remote.env` con `shred -u` | `db-backup-remote.py` → `status=DISABLED`; `list-timers` sin la unidad remota |
| Sospecha de compromiso de la writer | Operador, con autorización del propietario: `garage key deny --read --write mainspot-backups --key mainspot-backup-writer` (corte inmediato, `docs/07`); después, parada ordinaria y rotación | Log S3 e inventario frente a los manifiestos de MainSpot; copia protegida intacta |
| Objetos ya subidos | MainSpot no borra nada. Caducan a los 14 días por el ciclo de vida, y la copia por su expiración propia. Borrarlos antes exige una decisión aparte | Inventario del vigilante |
| Respaldo local | No se ve afectado en ningún caso | `mainspot-db-backup.timer` sigue activo |

## 10. Recuperación disponible

- **Procedimientos:**
  - §11.2 desde `mainspot-backups`, con **restore** y la clave de custodia;
  - §11.4 opción B: el operador entrega los archivos de la copia y el propietario valida y restaura;
  - §11.3 para reaplicar las bajas antes de abrir el tráfico.
- **Demostrado con datos sintéticos:** 6a (≈ 19 s de restauración) y 6b. El tamaño real actual (≈ 121 KB) es del mismo orden que el sintético.
- **Objetivos derivados del diseño, no medidos en producción:**
  - pérdida máxima de datos ≈ 24 h (un respaldo diario);
  - copia remota pocos minutos después del local (ejecución :20), con reintento horario si falla;
  - copia protegida ≤ 1 h después.
- **Prerrequisito no acreditado:** la copia de custodia de la clave y de restore (R-KEY).

## 11. Paquete para la revisión

| Pieza | Ubicación |
|---|---|
| Estado conciliado 1–6 y E1–E5 | `integration-status.md` |
| Informe del simulacro (rectificado) | `e2e-drill-report-2026-10-25.md` @ `c925e12` |
| Borrador de la sesión HDC (no publicado; validado offline con el perfil v2) | `gate7-qs-activation-draft.questions.json` |
| Contrato | `v1/CONTRACT.md` @ `c4f87c4` |
| Evidencia del operador | `mainspot-s3-backups` evidence/43, 44, 45, 47, 48 |
