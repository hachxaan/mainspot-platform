# G-MIG / G-SEC — Endurecimiento del PR #13 (PR #14)

- Base: PR #13 (`feat/plan-policy-catalog-impl-20261104`, b1cd3df). Rama: `fix/plan-catalog-gates-hardening-20261104`.
- Primera versión (6e1eff8, 2026-11-04): propuesta sin ejecutar. Revisión, correcciones y pruebas: 2026-11-05. Evidencia en `evidence/plan-catalog/gates-pr14/`.
- Estado: **verificado en desarrollo y en BD desechables**. No hay despliegue ni aprobación humana, y no se tocó ninguna base real. **NO-GO producción**: faltan las decisiones del propietario (§4) y la Fase B en el destino.

## 1. Cambios

### G-SEC: límites de login y step-up (migración 0035, `src/platform/auth.ts`)

- Contador compartido en `platform_auth_attempt_gate`: 5 intentos por clave en una ventana móvil de 15 min, entre todos los procesos. La clave es una huella HMAC-SHA256 con una clave derivada de `JWT_SECRET` solo para este uso (`attemptKeyHash`); no guarda login, IP ni TOTP. Todos los procesos deben compartir `JWT_SECRET`, y rotarlo reinicia los contadores.
- La reserva se hace con un upsert que siempre bloquea la fila de la clave, así que una purga concurrente no provoca un 500.
- Esperas acotadas: `lock_timeout` 500 ms (55P03), `statement_timeout` 10 s e `idle_in_transaction_session_timeout` 15 s. Una reserva normal retiene la fila unos milisegundos, así que las ráfagas sobre una clave se siguen serializando. Un bloqueo retenido falla cerrado en 0,5 s; cada intento en espera ocupa una conexión del pool, y una espera larga paralizaría el proceso entero.
- Una clave llena se deniega con una sola lectura, sin escritura. La purga se hace solo tras una reserva permitida, con `SKIP LOCKED`.
- Conectividad (`src/db/pool.ts`): cada cliente del pool recibe un oyente `'error'` desde que conecta. Así queda cubierto inactivo y también fuera del pool con `pool.connect()` directo (`auditedOperation`, workers, Telegram, retención). `runTransaction`, que también usa `runAtomic`, destruye al devolverlo un cliente cuya conexión o cuyo `ROLLBACK` falló. Una conexión perdida o terminada falla la petición, nunca el proceso.
- Auditoría de login fallido:
  - el actor es el `platform_user_id` del operador o `login:unknown`; el texto tecleado nunca se guarda;
  - un login inexistente paga la misma comparación bcrypt, así el tiempo de respuesta no revela qué logins existen.
- Esa comparación cuesta unos 40 ms de CPU de PostgreSQL, así que hay dos límites por proceso:
  - una admisión síncrona de 2 + 32 logins: sin hueco, 429 antes de tocar la BD y sin gastar intentos;
  - 2 huecos de ejecución que solo cubren la comprobación bcrypt.

  Una ráfaga de logins inventados no deja sin servicio al resto de la aplicación, y una clave con su fila bloqueada no hace esperar a las demás.

### G-SEC: datos de negocios en auditorías (DEC-0027)

- `assertPlatformReason` rechaza correos e ids `client_…` en todo motivo de plataforma: estado, clasificación, soporte, presupuestos, rollout y catálogo. Lo mismo vale para los motivos de concesión y revocación de grants del laboratorio y las notas de su revisión manual.
- El límite del id es el mismo que usa la verificación de la anonimización (`[A-Za-z0-9_-]`), sin `\b` ni el flag `u`, con el que `ſclient_x` pasaba.
- Puede haber falsos positivos, como «client_secret» o el correo de soporte de MainSpot; es la opción conservadora.
- La auditoría de un grant de laboratorio ya no guarda el `user_id` del negocio en `result`.
- `support-view` de un id que no es un negocio responde 404 y no lo audita.
- **Ensayo de anonimización** (`scripts/anonymization-dry-run.ts`). Ejecuta la anonimización real de cada negocio, incluida su verificación sobre todas las columnas de texto, y siempre revierte. Es la comprobación definitiva de que ninguna auditoría ni tabla impide anonimizar; los preflights SQL solo la aproximan. Se usa sobre una copia restaurada y solo emite recuentos y `tabla.columna`.

### R1: reparación excepcional de la auditoría heredada

- `scripts/plan-catalog-legacy-audit-repair.sql` se reescribió: la versión de 6e1eff8 no era SQL válido. La reparación:
  - impone `ON_ERROR_STOP`;
  - exige `APPLY=1` exacto, `TARGET_DB` igual a la BD de la sesión y `EXPECTED_ROWS` entero;
  - reescribe solo `resource` a `/api/platform/tenants/:id…`, también en variantes de mayúsculas o con barra final;
  - comprueba con huellas md5 que las demás columnas no cambian;
  - verifica que el trigger vuelve a rechazar un UPDATE;
  - se niega mientras quede un identificador fuerte de un negocio vivo que la anonimización no pueda quitar, no solo `client_…`:
    - en filas sin negocio existente, cualquier columna;
    - en filas de un negocio, `actor_id` y `result`, que se conservan, y en las demás columnas los identificadores de OTROS negocios;
  - aplica `strpos` antes de cada regex;
  - fija `READ COMMITTED`;
  - si encuentra un `client_…` que no es de ningún negocio vivo, solo avisa.
- Redactar logins heredados en claro requiere `REDACT_LEGACY_LOGIN_ACTORS=1` y `EXPECTED_LOGIN_ROWS`, y es una decisión del propietario.
- `scripts/plan-catalog-legacy-audit-preflight.sql` usa los mismos predicados y da, sin emitir identificadores:
  - recuentos por tipo de fila fuera de contrato;
  - `client_…` sin negocio vivo;
  - bloqueos de anonimización por almacén, con la misma regla: auditoría de plataforma y de negocio (`audit_event.result` se conserva; `actor_id`, `resource`, `request_id` y `evidence_ref` se limpian), revisiones manuales, presupuestos y catálogo.

### G-MIG

- Reversión de 0034 (`scripts/plan-catalog-rollback.sql`), con `READ COMMITTED` explícito:
  - tras comprobar que 0034 está aplicada y que no existe otra relación `plan_limit`, bloquea en `ACCESS EXCLUSIVE` el catálogo, las suscripciones y el libro de cuotas;
  - aborta (55000, sin cambios) si alguna suscripción no está fijada a la revisión PUBLICADA de su propio plan, o si hay migraciones posteriores registradas;
  - un valor `backfill_absent_deny` distinto de 0 vuelve como fila, no como ausencia.
- Reversión de 0035: `scripts/plan-catalog-hardening-rollback.sql`.
- Preflights de solo lectura:
  - `plan-catalog-gmig-preflight.sql` (antes de 0034) bloquea las mismas condiciones que harían abortar 0034. También bloquea ante un libro de cuotas que se desvió del registro y ante cualquier objeto con un nombre de 0034 (los 37 nombres de tablas, columnas, restricciones, índices, funciones y triggers, además de `plan_revision`), que 0034 adoptaría en silencio;
  - `plan-catalog-rollback-preflight.sql` evalúa las condiciones de aborto de la reversión.
  - Los dos salen con código distinto de 0 cuando la operación abortaría.
- Todos los scripts imponen `ON_ERROR_STOP`. `scripts/migrate.ts` fija `lock_timeout` 10 s tras el candado consultivo.

## 2. Procedimiento

Todos los scripts se ejecutan con `psql -X`; cada uno impone `ON_ERROR_STOP` y cualquier rechazo sale con código distinto de 0.

**Fase A — desarrollo y BD desechables. Hecha:** `evidence/plan-catalog/gates-pr14/README.md`.

**Fase B — diagnóstico en el destino, sin cambios.** Probar la restauración del respaldo y ejecutar:

```sh
psql "$DATABASE_URL" -X -f scripts/plan-catalog-legacy-audit-preflight.sql
psql "$DATABASE_URL" -X -f scripts/plan-catalog-gmig-preflight.sql   # antes de 0034; código ≠ 0 ⇒ detener
# sobre la COPIA RESTAURADA (nunca la BD de producción), con escritores detenidos:
DATABASE_URL=<copia restaurada> node scripts/anonymization-dry-run.ts --database=<nombre de la copia>   # código 1 ⇒ algún negocio no se podría anonimizar
```

Detener el cambio si:
- aparecen filas fuera de contrato;
- la tabla de bloqueos de anonimización muestra negocios afectados;
- el ensayo de anonimización bloquea algún negocio;
- el preflight G-MIG bloquea.

La limpieza no amplía expresiones por conjetura.

**Fase C — reparación R1, solo con autorización explícita.** Pasos:
1. Parar escritores.
2. Respaldar.
3. Repetir el preflight y anotar `N` (y `M`).
4. Ejecutar con el rol propietario de la tabla:

```sh
psql "$DATABASE_URL" -X -v APPLY=1 -v TARGET_DB=<bd> -v EXPECTED_ROWS=<N> -f scripts/plan-catalog-legacy-audit-repair.sql
# solo con decisión del propietario sobre los logins heredados en claro:
#   … -v REDACT_LEGACY_LOGIN_ACTORS=1 -v EXPECTED_LOGIN_ROWS=<M> …
```

5. Repetir el preflight.
6. Repetir el ensayo de anonimización sobre una copia restaurada después de la reparación; debe salir con código 0.

**Fase D — despliegue, aún bloqueado.** Pasos:
1. Con escritores detenidos: `node scripts/migrate.ts` (0034 y 0035). 0034 no bloquea `plan_limit` mientras hace el backfill, así que ningún proceso ni persona debe escribir en ella. Con `lock_timeout` 10 s, si algo retiene una tabla el runner falla rápido, sin registrar nada.
2. Desplegar el código de este PR. Todas las instancias comparten `JWT_SECRET`.
3. Resolver la decisión de IP de confianza (§4, GSEC-04).

Para revertir, con escritores detenidos y el servicio con el código nuevo **deshabilitado**, no solo detenido: al arrancar ejecuta `migrate.ts` y volvería a aplicar 0034/0035. Por ejemplo, `mainspot-local.service` con `Restart=on-failure`, el contenedor de `docker-compose.yml` o el despliegue LXD. Si aún quedara algún escritor, la reversión puede terminar con 40P01 o 55P03, sin cambios a medias.

```sh
# 1. Con 0035 aplicada, la única condición esperada es blocked_later_migrations=t (sale con 3).
#    Cualquier otra condición en t (en particular blocked_non_current_pins) ⇒ detener: decisión del propietario.
psql "$DATABASE_URL" -X -f scripts/plan-catalog-rollback-preflight.sql
# 2. 0035; luego desplegar el código de PR #13 (o seguir al paso 3 si se revierte todo).
psql "$DATABASE_URL" -X -f scripts/plan-catalog-hardening-rollback.sql
# 3. El preflight debe salir ahora con 0; si no, detener.
psql "$DATABASE_URL" -X -f scripts/plan-catalog-rollback-preflight.sql
# 4. 0034; luego desplegar el código base 95f9436.
psql "$DATABASE_URL" -X -f scripts/plan-catalog-rollback.sql
```

0034 solo se aplica con `scripts/migrate.ts` (o `psql -1`): con `psql -f` sin `-1` no es atómica y el historial de backfill quedaría mal etiquetado (GMIG-11). Las restauraciones deben ser completas (`pg_restore` de esquema y datos). Una carga solo de datos necesita `--disable-triggers`, porque las funciones de 0034 no fijan `search_path` (GMIG-10). El SQL directo sobre `subscription` solo se ejecuta en `READ COMMITTED`: en REPEATABLE READ o SERIALIZABLE, la guarda de asignación puede fijar una revisión que una publicación concurrente acaba de reemplazar (GMIG-09).

## 3. Hallazgos y estado

Revisiones independientes con `anthropic/claude-opus-5-5`, esfuerzo `max`:
- sobre 6e1eff8: `GSecReview` y `GMigReview`;
- revisión final sobre 7928838: `FinalGSec` y `FinalGMig`; sus hallazgos llevan el prefijo F o NEW y se corrigieron después;
- verificaciones del delta de esas correcciones, con los mismos revisores:
  - 2060725: G-MIG cerrado; NEW-07 y NEW-08 hallados;
  - ca37e01: NEW-07 y NEW-08 cerrados; NEW-09 hallado;
  - 704aea4: NEW-09 parcial; NEW-10 y NEW-11 hallados, ambos LOW;
  - b3b0447: NEW-10 mitigado (residual LOW); NEW-11 cerrado; sin regresiones. No queda ningún BLOCKER, HIGH ni MEDIUM corregible sin decisión del propietario.

| ID | Sev. | Hallazgo | Estado |
|---|---|---|---|
| GSEC-01 | BLOCKER | La reparación R1 no parseaba; sus bloqueos dependían del `ON_ERROR_STOP` del operador; `APPLY` laxo | Cerrado: reescrita; prueba con 14 rechazos sin cambios |
| GSEC-02 | BLOCKER | El preflight y la reparación solo buscaban `client_`; logins y correos heredados seguían bloqueando la anonimización | Cerrado. La revisión final lo dejó PARCIAL (filas de un negocio con identificadores de otro, almacenes incompletos); ahora la regla tiene en cuenta el negocio de cada fila y el ensayo de anonimización es la comprobación definitiva |
| GSEC-03 | HIGH | Motivos de plataforma (presupuestos, rollout, notas) y `ai_budget.source` sin filtro de datos de negocios; support-view auditaba ids inexistentes | Cerrado para correos e ids, también en motivos de grants (PARCIAL en la revisión final); slugs y nombres siguen abiertos (R4) |
| GSEC-04 | HIGH | Bloqueo de operadores: sin `trust proxy`, la clave IP+login es por login; con él, sin límite por cuenta | **Abierto: decisión del propietario** |
| GSEC-05 | HIGH | El grant de laboratorio guardaba el `user_id` en `result` (preexistente) | Cerrado para filas nuevas; las heredadas las cuenta el preflight (decisión) |
| GSEC-06 | MEDIUM | Sin timeouts en la transacción del límite | Cerrado; prueba de bloqueo retenido |
| GSEC-07 | MEDIUM | El proceso caía al perder una conexión (preexistente en el pool) | Cerrado para todo cliente del pool, también con `pool.connect()` directo (PARCIAL en la revisión final); pruebas de conexión terminada inactiva, en la transacción del límite y en un `pool.connect()` directo |
| GSEC-08 | MEDIUM | 6 sentencias por cada 429 | Cerrado: una lectura |
| GSEC-09 | MEDIUM | Rociado ilimitado con logins distintos (preexistente) | **Abierto** (ligado a GSEC-04) |
| GSEC-10 | MEDIUM | Seudónimo HMAC del login reversible y persistente | Cerrado: `platform_user_id` o `login:unknown`; clave derivada |
| GSEC-11 | LOW | Carrera entre purga y reserva ⇒ 500 | Cerrado; prueba |
| GSEC-12 | LOW | Un acierto reinicia el contador del atacante | Abierto, aceptado como bajo |
| GSEC-13 | LOW | El 429 de login no se audita | Abierto: auditarlo permitiría escrituras permanentes ilimitadas sin autenticar |
| GSEC-14 | LOW | El tiempo revelaba logins existentes (preexistente) | Cerrado: 44,6 frente a 44,9 ms (antes 45,8 frente a 4,1) |
| GSEC-15 | LOW | La ventana de step-up compara el reloj de la app con el de la BD | Abierto, bajo (NTP) |
| GSEC-16 / GMIG-02 | MEDIUM | Scripts sin `ON_ERROR_STOP` propio: aborto con código 0 | Cerrado en los 6 scripts |
| GMIG-01 | HIGH | Una publicación en curso hacía que la reversión regenerara `plan_limit` con una revisión no fijada | Cerrado: `LOCK` previo; la prueba falla con el script anterior |
| GMIG-03 | MEDIUM | `migrate.ts` esperaba bloqueos sin límite | Cerrado: `lock_timeout` 10 s |
| GMIG-04 | MEDIUM | Sin pruebas de 0035, preflights ni orden de reversión | Cerrado: 8 pruebas nuevas |
| GMIG-05 | LOW | El preflight de reversión siempre salía con 0 | Cerrado |
| GMIG-06 | LOW | El preflight G-MIG fallaba tras 0034; no detectaba la deriva del libro ni objetos sobrantes | Cerrado |
| GMIG-07 | LOW | La fijación a una revisión de otro plan o inexistente no bloqueaba la reversión | Cerrado |
| GMIG-08 | LOW | R5: 40P01 entre SQL directo y publicación ⇒ 500, sin pérdida | Abierto (disponibilidad) |
| GMIG-09 | LOW | La guarda de asignación bajo REPEATABLE READ/SERIALIZABLE fija una revisión ya reemplazada (solo SQL directo) | Abierto, documentado |
| GMIG-10 / GMIG-11 | LOW | Funciones sin `search_path`; 0034 con `psql -f` sin `-1` | Abierto, documentado en §2 |
| GMIG-12 | LOW | Textos obsoletos (NOTICE, `PLATFORM_JWT_SECRET`, comentario de prueba) | Cerrado |
| GMIG-13 | LOW | La regla de fijación también bloquea cancelados o valores iguales | **Decisión del propietario** |
| Lead-1 | MEDIUM | El preflight G-MIG consultaba `plan_limit` antes de comprobar el estado | Cerrado (= GMIG-06a) |
| FGMIG-01 | LOW | La reversión heredaba el aislamiento de la sesión: con REPEATABLE READ comprobaba datos anteriores a su bloqueo | Cerrado: `BEGIN ISOLATION LEVEL READ COMMITTED` (también en la reparación R1 y en la reversión de 0035); prueba |
| FGMIG-02 | LOW | Objetos con nombres de 0034 en otra forma o tabla pasaban el preflight y 0034 los adoptaba | Cerrado: el preflight comprueba los 37 nombres; 3 pruebas (19 casos verificados en la revisión del delta) |
| FGMIG-03 | LOW | Una relación `plan_limit` existente: preflight en 0, reversión con un mensaje engañoso | Cerrado; prueba |
| FGMIG-04 | INFO | Con escritores activos, la reversión o la publicación pueden terminar con 40P01 o 55P03 | Documentado (§2): ambos resultados son seguros |
| FGMIG-05 | INFO | El servicio con el código nuevo reaplica 0034/0035 al arrancar | Documentado (§2): deshabilitarlo durante la reversión |
| NEW-01 | MEDIUM | El bcrypt ficticio costaba unos 40 ms de CPU de la BD por cada login inventado | Cerrado: 2 a la vez por proceso con 32 en cola; el resto 429 sin tocar la BD ni gastar intentos. Ráfaga de 300: 876 ms con 266 × 429, frente a 3.169 ms; consulta ajena, peor caso 47 ms frente a 2.925 ms (revisión del delta) |
| NEW-02 | MEDIUM | El preflight y la reparación escalaban con filas × identificadores; la reparación, además, con un bloqueo exclusivo | Cerrado: `strpos` antes de la regex. Con 102 negocios y 20.050 filas: 7,0 s y 7,0 s, frente a más de 30 min sin terminar |
| NEW-03 | LOW | Un `client_…` de ningún negocio vivo bloqueaba la reparación para siempre | Cerrado: solo avisa y lo cuenta el preflight; prueba |
| NEW-04 | LOW | `\b` con `/iu` dejaba pasar `ſclient_x` | Cerrado; prueba unitaria |
| NEW-05 | LOW | Falsos positivos («client_secret», el correo de soporte) | Aceptado: opción conservadora |
| NEW-06 | LOW | Documento desactualizado | Cerrado |
| NEW-07 | MEDIUM | El 429 por saturación llegaba después de reservar el intento: una ráfaga ajena bloqueaba 15 min a un operador que reintentaba (introducido por NEW-01, hallado en la verificación del delta) | Cerrado: la admisión se toma antes de reservar; la prueba falla en 2060725 |
| NEW-08 | LOW | El ensayo registraba `audit.written … tenant.anonymized` aunque revierte | Cerrado: acción propia `tenant.anonymization_dry_run` |
| NEW-09 | LOW | Con la corrección de NEW-07, la reserva ocupaba uno de los 2 huecos: una clave con su fila bloqueada hacía esperar hasta 5 s a logins de otras claves | Cerrado: admisión síncrona (2 + 32, 429 antes de reservar) separada de los 2 huecos de ejecución, que solo cubren el bcrypt; la prueba falla en ca37e01 |
| NEW-10 | LOW | Con 5 o más intentos esperando sobre una fila retenida, todo el pool del proceso esperaba hasta 5–10 s (residual de NEW-09) | **Mitigado**: `lock_timeout` del límite 500 ms. Fila retenida 8 s, pool de 5: consulta ajena 304 ms con 5 intentos (antes 4.804), 811 ms con 10 (antes 7.811) y 3.824 ms con la admisión llena (34). Residual LOW: quitarlo del todo exige un solo intento en espera por clave y proceso; queda para después, sin decisión del propietario |
| NEW-11 | LOW | La prueba de clave bloqueada era inestable: el segundo en espera podía terminar en 57014 | Cerrado: con 500 ms el resultado es 55P03 determinista (20/20 en la verificación); la purga concurrente sondea el bloqueo en lugar de esperar un tiempo fijo |

## 4. Riesgos y decisiones del propietario

- **GSEC-04 / GSEC-09.** Política de bloqueo y red. Opciones a decidir:
  - `trust proxy` con las direcciones exactas del proxy;
  - límite por cuenta solo tras contraseña correcta (respondiendo 401);
  - límite por IP antes de escribir;
  - lista blanca de red para `/api/platform`;
  - desbloqueo de emergencia auditado;
  - handle opaco del operador en la auditoría del negocio.

  Hoy, sin `trust proxy`, quien conozca el login de un operador puede bloquearlo 15 min. Con el contador compartido, ese bloqueo vale para todas las instancias y sobrevive a reinicios.

  El tope de comprobaciones de contraseña (NEW-01) protege la BD. Durante una ráfaga, también un operador legítimo puede recibir 429 hasta que pase.

  Si un proceso o la BD se detienen reteniendo la fila de una clave, los intentos sobre esa clave fallan cerrados en 0,5–1 s. Mientras tanto ocupan conexiones del pool: el resto del proceso puede esperar unos (intentos ÷ tamaño del pool) × 0,5 s, como mucho ~3,8 s con la admisión llena (NEW-10).
- **Filas heredadas de un negocio con identificadores de otro** (motivos o `evidence_ref` antiguos). Bloquean la anonimización del otro negocio mientras exista el primero. El preflight y el ensayo de anonimización las detectan; la reparación R1 no las reescribe.
- **Redacción de logins heredados en claro** (`REDACT_LEGACY_LOGIN_ACTORS`). Contradice «el actor se conserva», pero ese «actor» es solo un login reclamado sin autenticar.
- **Filas heredadas con identificadores en columnas que la anonimización conserva** (`audit_event.result` de los grants de laboratorio, motivos o notas antiguos). El preflight las cuenta; la reparación R1 no las cubre.
- **R4.** Slugs, subdominios, nombres y user ids en texto libre no se detectan por patrón.
- **GMIG-13.** Regla de fijación estricta frente a permitir valores iguales o cancelados.
- **Retención de `platform_audit_event`** (hoy sin retención y append-only). `reapplyExits` se detiene en el primer negocio que falla.
- **Append-only frente al rol de la app.** El rol de la app es dueño de las tablas y `mainspot.anonymizing_tenant` se puede fijar desde cualquier sesión.
- **`schema_migrations` sin hash de contenido.** Un entorno que aplicó un borrador de 0034/0035 no recibe ediciones posteriores.
- **Ventana de mantenimiento.** El FK y el índice de 0034 se construyen con bloqueos exclusivos.

**G-MIG y G-SEC: verificados técnicamente en desarrollo. Producción: NO-GO** hasta las decisiones de §4, la Fase B en el destino y la firma humana.
