# Revisión independiente y adversarial — DEC-0077 (SEC-CONSENT-01, SEC-TG-APPROVAL-01) y e4af950

Revisor: GovAdversarialReview (anthropic/claude-opus-5-5, esfuerzo máximo). Fecha: 2026-11-05 (hora local).
Objeto: `git diff b809510 5549935` (canon `8940101` + implementación `5549935`), fixups de canon `f6f1346` y `3543a9a`, y
el commit `e4af950` (sección aparte, §6). No se editó el worktree de integración ni se hizo commit/push.

## Método y entorno

- Worktrees propios: `../mainspot-platform-gov-review` (HEAD `5549935`) y `../mainspot-platform-gov-review-e4af950` (HEAD `e4af950`).
- PostgreSQL 16 desechable `127.0.0.1:55498`; BD propias: `mainspot_test_review` (suite en 5549935), `mainspot_test_review_e4`
  (suite en e4af950) y `mainspot_test_review_probe` (sondas). `APP_ENV=test`. Proveedores simulados (canal Telegram simulado,
  replier simulado, semántica stub o AI Core con Anthropic falso de la propia suite). Sin red, sin navegador, sin puerto 3100.
- Lectura completa del diff (servicio, Telegram, rutas, panel, migración, reversión, retención, purga de Google, pruebas) y del canon.
- Sondas adversariales: `tests/probes/gov-review.test.ts` (solo en mis worktrees, sin seguimiento). Cada prueba AFIRMA el
  comportamiento defectuoso: pasar = hallazgo reproducido. Reproducir (desde cualquiera de los dos worktrees):
  `APP_ENV=test DATABASE_URL=postgres://mainspot:gov-local-only@127.0.0.1:55498/mainspot TEST_DATABASE_URL=postgres://mainspot:gov-local-only@127.0.0.1:55498/mainspot_test_review_probe node --test --test-concurrency=1 tests/probes/gov-review.test.ts`
  (la BD se prepara antes con `node scripts/test-prep.ts` y la misma `TEST_DATABASE_URL`).
  Resultado: **11/11 reproducidas en `5549935` y 11/11 en `e4af950`**.

## Veredicto global

- **SEC-TG-APPROVAL-01 — núcleo del servidor correcto.** Ningún camino del servidor publica por `/aprobar <código> N` un texto
  distinto de la opción N de la instantánea: candado del caso y luego del aviso, comparación de revisión y de texto, y CAS en la
  misma sentencia (`service.ts:808-841`); reentregas, repeticiones, chats re-vinculados, otra persona y otro negocio se comportan
  como dice el contrato, sin oráculo. Los defectos están **alrededor** del núcleo: el formato del aviso no es inyectivo y el chat
  simulado del panel interpreta texto libre (su confirmación puede mostrar A y publicar B — F-02), la API del panel con
  `draft_number` publica la opción vigente y no la vista (F-03), y dos huecos de disponibilidad del re-aviso (F-06, F-07).
- **SEC-CONSENT-01 — puerta principal correcta** (sin versión vigente no hay IA ni reserva ni unidad; aceptación versionada con
  409, idempotente, concurrente, RBAC, aislada; política append-only en BD). Fallan los bordes de la rama `needsHuman`: unidad y
  propuesta de IA no pedidas dentro de las 3 numeradas, contra R2 confirmada y declarada «Implementado» (F-01), y la revocación
  durante la redacción no impide confirmar la unidad en esa rama (F-04).
- **Migración 0037 y reversión:** correctas, idempotentes y bien bloqueadas; un NIT de bloqueo y un hueco del guard de purga (F-10).
- **Canon DEC-0077:** fiel a SRC-0017/SRC-0016/OWNER-RESOLUTION, sin cifras ni aprobaciones inventadas; validadores sin errores
  nuevos. Sobredeclara R2 (F-01), afirma un «mensaje genérico» que el código no da (F-12) y remite a un documento inexistente (F-09).
- **Sin regresiones:** tsc 0; unitarias 187/187; integración 291/291 (5549935) y 300/300 (e4af950).
- **Recomendación del revisor (no es firma de gate):** local — corregir F-01…F-04 antes de dar el incremento por cerrado (o que el
  propietario los acepte como riesgo explícito); producción — NO-GO mientras sigan F-01…F-05 abiertos y además por los gates
  humanos (G-MIG/G-SEC) y la entrega real de Telegram no verificada.

## 1. Tabla de hallazgos (ordenados por severidad)

Líneas sobre `5549935` salvo indicación; las de canon, sobre `e4af950` (incluye las fixups).

| ID | Sev. | Archivo:línea | Descripción | Sonda / razonamiento | Impacto | Corrección propuesta |
|---|---|---|---|---|---|---|
| F-01 | **HIGH** | `src/engagement/service.ts:451,474-490`; canon `DEC-0077.md:27`, `FR-0016.md:39-41`, `DEC-0077.json:6` (R2) | Respuesta automática autorizada (consentimiento vigente) cuya redacción con IA devuelve `needs_human`: el caso pasa a revisión con el texto de IA como **opción 1 numerada**, `reply_invocation_id` puesto y **1 unidad confirmada**, sin que nadie la pidiera ni se publicara una automática. «Redactar con IA» queda bloqueado (`already_drafted`). El aviso de Telegram lo muestra como `1) …` sin marca de IA y aprobarlo lo publica sin el aviso de IA. R2 (confirmada por el propietario, `OWNER-RESOLUTION.md:11`) dice lo contrario y DEC-0077 la declara «Implementado (local) desde 0.7.0». El texto v2 del consentimiento no menciona este gasto. Código preexistente (PR #16); la afirmación del canon es nueva | **P4** reproducida: `[needs_human, reply_needs_human, drafts[0]=IA, ai_draft=null]`, `committed=1`, `ai-draft → 200 already_drafted`, aviso `1) <IA>`, `/aprobar` publica el texto de IA | Gasto de la cuota compartida no pedido ni informado; incumple R2 (IA a pedido y aparte de las 3 numeradas); el canon afirma cumplimiento | Decide el propietario la semántica de la unidad. Opciones: (A) en la rama humana guardar `gen.text` en `ai_draft` (como `requestAiDraft`, `service.ts:640-642`) y no en `drafts`, mantener la unidad y decirlo en unos términos v3 (reconsentimiento); (B, lectura literal de R2, sin texto nuevo) descartar el texto y liberar la reserva (`quota.release(…, 'ai_reply_needs_human')`), dejando solo propuestas sin IA. Mientras tanto, corregir el canon: R2 «Parcial: excepción `needsHuman` (`service.ts:451,476,490`)» |
| F-02 | MEDIUM | `service.ts:1001,1008,1011` (`notificationText`); `src/web/panel/assets/js/assistant.js:266-277,288-289,304,309` | El formato del aviso no es inyectivo: el extracto de la reseña (texto de un tercero) y las opciones se escriben tal cual, con saltos de línea, y cualquiera de ellos puede contener líneas `N) …` o `/rechazar XXXXXX`. El chat simulado del panel analiza ese texto (`MS.tg.notice`) para crear botones y la confirmación «¿Publico esta respuesta?» muestra el texto analizado, no la instantánea; el servidor publica la opción N de la instantánea | **P1a**: Operación (sin `engagement.approve`) edita opción 1 = `«…\n2) <inocuo>»` y opción 2 = `<dañino>`; el primer botón «Usar opción 2» confirma `«Te llamamos hoy para resolverlo en privado.»` y publica `«Si borras tu reseña te damos un 50 % de descuento.»`. **P1b**: reseña con `\n1) …cupón FALSO50…` ⇒ botón «Usar opción 1» que confirma el texto del reseñante y publica la opción 1 real. **P1c**: reseña con `/rechazar ZZZ234` ⇒ el panel toma ese código y sus botones fallan (`approval_ref_invalid`) | Chat simulado (solo fuera de producción, `engagement-routes.ts:210-216,273-279`): la persona confirma A y se publica B. Telegram real: mensaje ambiguo (dos «2)», opciones falsas dentro del extracto) que una persona con `engagement.respond` o cualquier reseñante puede provocar | Servidor: aplanar el extracto (`body.replace(/\s+/g,' ')`) y neutralizar `^\d\) ` y `/aprobar`/`/rechazar` en él; sangrar las líneas de continuación de cada opción (`d.replace(/\n/g,'\n   ')`) para que solo las opciones reales empiecen por `N) `. Panel: no analizar texto: que `GET /dev/simulator/telegram` devuelva por mensaje `{code, options}` de `engagement_approval_offer` (chat simulado + código) y construir botones y confirmación con eso. Pruebas con opciones multilínea y reseñas hostiles |
| F-03 | MEDIUM | `src/api/engagement-routes.ts:116-118`; `service.ts:724-737` | `POST /engagement/cases/:id/approve` acepta `draft_number` (y sin cuerpo usa la opción 1): resuelve el índice contra las propuestas **vigentes** y no compara revisión ni texto. El panel envía el texto visible (`agent.js:122-123`), pero la API documentada (`DECISION-LOG.md:49`, `{draft_number\|text}`) sigue publicando lo que quien aprueba no vio | **P2**: GET del caso (opción 1 = X), Operación edita la opción 1 = Y, `approve {draft_number:1}` ⇒ publica Y; `approve {}` ⇒ publica la opción 1 vigente | Cliente de la API, script o pestaña antigua publica un texto no visto tras una edición concurrente | Exigir `text`, o `draft_number` + `drafts_revision` y comparar en el UPDATE (`AND drafts_revision = $rev AND drafts ->> $idx = $text`, 409 si no); quitar el valor por defecto; actualizar la documentación de la API |
| F-04 | MEDIUM | `service.ts:452-490` (re-comprobación solo en la rama automática, `454-463`; rama humana `474-486`; confirmación `490`) | La re-comprobación de política dentro de la transacción (candado + última `policy_id`, `PolicyChangedError`) solo protege la rama `auto_reply`. Si la IA devuelve `needs_human`, la rama humana confirma la unidad reservada **sin** comprobar que la regla siga vigente: una revocación durante la redacción no impide el gasto | **P9**: el stub revoca la regla (`PUT … review_required`, 200) mientras «redacta» y devuelve `needsHuman:true` ⇒ caso `needs_human`, política más reciente `review_required`, `committed=1` | Gasto de una automatización ya revocada (ventana = tiempo de redacción); contradice el comentario de `service.ts:455-456` y AC-16008/R8 | Ejecutar la misma re-comprobación (candado `engagement_policy:<tenant>:<origen>:<categoría>` + `policy_id` más reciente) siempre que haya `held` o `gen` de una política automática, en ambas ramas; añadir la prueba «Revocación durante la redacción» con `needsHuman: true` |
| F-05 | MEDIUM (preexistente) | `src/engagement/telegram.ts:175-178`; `src/retention/service.ts:393-395` | `dispatch()` resuelve el vínculo con `telegram_link` + `internal_user.status='active'`, sin mirar `client.status`: un negocio `suspended` o `exiting` (el panel ya no deja entrar) sigue aprobando y publicando por Telegram con un aviso vigente (`respondCase` se llama directamente). Además, en un negocio `exiting` la anonimización borra avisos y luego casos (orden aviso→caso) mientras `/aprobar` bloquea caso→aviso: interbloqueo posible (PostgreSQL aborta uno) | **P8**: para `suspended` y `exiting`: `login` denegado, `/aprobar` ⇒ `approved` y publicado. Base `b809510`: misma consulta (`telegram.ts@b809510:169-171`) | La suspensión administrativa (FR-0018) y la baja confirmada («acceso retirado», DEC-0024) no cortan la publicación por Telegram | Añadir `JOIN client c ON c.client_id = l.tenant_id AND c.status = 'active'` (respuesta genérica si no) y comprobar el estado del negocio dentro de la transacción de `approveFromNotice`/`approve` y en `respondCase`; en la anonimización, bloquear antes los casos (`SELECT … FOR UPDATE`) o borrar en orden caso→aviso dentro de la misma transacción |
| F-06 | LOW | `service.ts:1115-1118,1090-1093` | Carrera envío/edición: `deliverNotice` marca la fila `sent` con `WHERE … AND EXISTS (caso con la revisión enviada)`; si la edición confirma mientras el UPDATE espera el candado de la fila, la re-evaluación (EvalPlanQual) reutiliza el EXISTS de la instantánea vieja y marca `sent`; después `notify_status='sent'`. El aviso de la revisión nueva nunca se envía (contradice `service.ts:1048-1049`) | **P3**: canal y auditoría con compuertas; instantáneas `[{r2,superseded},{r3,superseded}]`, revisión vigente r4, fila `sent`, caso `sent`, siguiente ciclo `sent:0`. La integridad se mantiene: el código viejo da `approval_stale` y solo entonces llega el aviso nuevo | Tras editar, la persona puede no recibir el aviso actualizado (el panel dice «avisado») | Marcar enviado en una transacción que antes haga `SELECT drafts_revision FROM engagement_case WHERE case_id=$1 FOR SHARE` (espera a la edición y relee lo confirmado) y solo actualice si coincide; o añadir a la fila una condición propia que la edición cambie (`AND updated_at = $leído`), que EvalPlanQual sí re-evalúa; prueba con compuertas como P3 |
| F-07 | LOW | `service.ts:960-963,1081-1084`; `telegram.ts:239,244-246` | (a) Preexistente: cuando la publicación aprobada falla (`failed`), `notify_status='pending'` pero las filas de entrega siguen `sent`: los chats ya avisados nunca reciben «No pudimos publicar…» y el caso queda `sent` + `engagement.notified`; Telegram había prometido «te avisamos si falla». (b) Nuevo: repetir el código ya usado responde «Las propuestas de ese aviso cambiaron…» aunque no cambió nada | **P5**: `approved` con replier no reintentable ⇒ `failed`; `run` ⇒ 0 avisos nuevos y `notify_status='sent'`; repetir código ⇒ `approval_stale` con «cambiaron» y la misma revisión | Fallo de publicación silencioso para quien aprobó; mensaje engañoso | En la rama `failed` (y en `delivery_uncertain` de `worker.ts:225-228`) reprogramar las filas del caso (`status='pending', attempts=0, next_attempt_at=NULL`); en `approveFromNotice` distinguir aviso usado/caso fallido de revisión cambiada y responder en consecuencia |
| F-08 | LOW | `migrations/0037…sql:40-54`; `src/engagement/consent.ts:11-12,33-38` | La BD solo exige que la huella coincida con el texto guardado; no ata `consent_version` a su texto canónico y ninguna prueba fija la huella de cada versión. Cambiar el texto sin subir la versión pasaría inadvertido (las políticas «v2» seguirían cubriendo el gasto) y una fila «v2» con otro texto habilita el gasto | **P7**: INSERT directo con `consent_version` = v2, texto distinto y su huella ⇒ aceptado; la IA se invoca, `committed=1`, `reconsent_required=false` | La «aceptación verificable» depende solo de una convención del código | Tabla `engagement_consent_terms(version PK, origin, text, sha256 UNIQUE)` sembrada por la migración y FK `(consent_version, consent_sha256)`; prueba unitaria que fije la sha256 de cada versión de `consent.ts` |
| F-09 | LOW | `.canonflow/canon/functional/CHANGELOG.md:32-33`; `DEC-0077.json:41` | El canon remite a `docs/architecture/commercial-governance-safeguards.md` («su diseño se documenta en…»), que no existe en `5549935` ni en `e4af950`; tampoco `evidence/commercial-governance/` (declarada «al integrar») | `ls docs/architecture` y `ls evidence` en ambos worktrees | Referencia canónica rota; sin documento de diseño ni evidencia para la matriz requisito→código→prueba→gate | Crear ambos antes del PR o retirar la referencia |
| F-10 | LOW | `migrations/0037…sql:104-113` | El guard de `engagement_approval_offer` devuelve `NEW` en cuanto `status='purged'`, antes de comprobar `used_option`, `used_at` y `superseded_at`: la transición a `purged` permite reescribir qué opción se aprobó y cuándo | `psql` en transacción revertida: `used → purged` con `used_option` 2 → 1 y `used_at` −7 días ⇒ `UPDATE 1` | La prueba de «qué aprobó cada persona» se puede alterar por SQL pese a la inmutabilidad declarada (queda la auditoría `engagement.approved`) | Exigir en la rama `purged` `NEW.used_option IS NOT DISTINCT FROM OLD.used_option AND NEW.used_at IS NOT DISTINCT FROM OLD.used_at AND NEW.superseded_at IS NOT DISTINCT FROM OLD.superseded_at` |
| F-11 | NIT | `service.ts:1004,1030,1039` | El encabezado «Propuestas actualizadas (el aviso anterior ya no sirve para aprobar)» sale con cualquier aviso previo del mismo chat, también en reintentos tras un fallo ambiguo del canal o en reenvíos sin cambios, cuando el aviso anterior sigue vigente | **P6**: el canal entrega y devuelve error; el segundo aviso lleva ese encabezado y el primer código aprueba (`approved`, publica «uno») | Mensaje falso para la persona | Marcar `updated` solo si existe un aviso previo con revisión menor, o sustituir los avisos activos anteriores del mismo (caso, chat) al emitir uno nuevo |
| F-12 | NIT | `FR-0016.md:62-63`; `service.ts:813,821-835`; `telegram.ts:234-241` | El enunciado dice que un código «ya usado o sustituido se rechaza con un mensaje genérico»; el código responde «Ya habías aprobado…» o «Las propuestas… cambiaron» y reenvía el aviso. AC-16010 (solo otro chat/negocio) sí es correcto | Lectura de código + P5 | Canon que no describe lo implementado | «Un código de otro chat o de otro negocio se rechaza con un mensaje genérico; uno usado o sustituido no publica nada: se explica y se envía el aviso vigente» |
| F-13 | NIT | `migrations/0037…sql:58-63` | `ADD CONSTRAINT engagement_case_drafts_revision_check` validado: recorre `engagement_case` con ACCESS EXCLUSIVE dentro de la transacción de la migración | Razonamiento (semántica de `ALTER TABLE`) | Inmediato con tablas pequeñas; con muchas filas alarga el bloqueo | `… NOT VALID` y `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE) |
| F-14 | NIT | `FR-0020.md:51`; `FR-0021.md:26-28,35`; `FR-0016.md:77` | AC-20005 atribuye «nunca más de 16» a DEC-0026 (DEC-0026 fija 14 días; la cota de 16 es del contrato de respaldos, DEC-0046/DEC-0057). AC-21003 introduce una salvaguarda («no se habilita») marcada como derivada pero sin confirmación. AC-16004 «la propuesta de IA queda primera» frente a R2 «aparte» | Lectura cruzada con `DEC-0026.md:10-15`, `CONTRACT.md:36-39`, `OWNER-RESOLUTION.md:11,18` | Atribución y redacción | Citar el contrato y DEC-0046/DEC-0057; marcar AC-21003 «pendiente de confirmación del propietario»; «queda aparte de las tres numeradas» |

## 2. SEC-TG-APPROVAL-01 — caminos revisados

| Camino | Resultado | Evidencia |
|---|---|---|
| `/aprobar <código> N` (webhook real y chat simulado) | OK en servidor: publica `shown.trim()` de la instantánea; CAS con revisión y texto | `service.ts:802-852`; pruebas AC-16009 (opción 3 exacta) y carreras: `{"approval_stale":11,"approved":1}`, nunca el texto editado |
| Botones del chat simulado | **F-02** | P1a/P1b/P1c |
| `approveFromNotice` con opción vacía o inexistente | OK: 400 con aviso activo; obsoleto ⇒ sin publicar + reenvío | `service.ts:817-835`; `telegram.ts:224-228`; prueba AC-16010 (sin número, «4») |
| `respondCase` y estado `failed` | Sin publicación indebida; **F-07** (re-aviso y mensaje) | P5 |
| Escalada de automáticos (`respondCase` agotado, `recoverStale`) | OK: `drafts=[response_text]` sube la revisión y se avisa con instantánea nueva | `service.ts:954-959`; `worker.ts:224-228` |
| Purga de Google | OK: opciones vacías, `purged`, `ai_draft` nulo, huella conservada, `/aprobar` ⇒ 409; **F-10** (guard) | `google/retention.ts:91-104`; prueba «Purga de contenido de Google»; psql |
| `requestAiDraft` | OK: solo `ai_draft`; no cambia opciones ni revisión | `service.ts:638-653` |
| Carreras edición/aprobación/envío (`dispatchNotifications`, `deliverNotice`, `issueNotice`, `sendNoticeTo`) | Integridad OK (la aprobación compara bajo candado aunque un aviso viejo quede `active`); **F-06** (re-aviso perdido) | P3; `service.ts:1027-1044` |
| Interbloqueos caso→aviso frente a los triggers de 0037 | OK entre aprobación, edición, purga e `issueNotice` (el FK de la inserción toma KEY SHARE, sin ciclo); excepción anonymization (**F-05**) | `service.ts:808-811`; `0037…sql:135-143`; `retention/service.ts:393-395` |
| Reentregas (`telegram_update`) | OK: `duplicate`; ráfagas ⇒ una publicación | `telegram.ts:131-167`; prueba AC-16010 reentregas |
| Reuso y colisión de códigos | OK: 32 símbolos sin sesgo, `UNIQUE (chat_id, code)` histórico, 5 reintentos | `notice-offer.ts:11-18`; `0037…sql:86,95`; `service.ts:1031-1043` |
| Chats re-vinculados, otra persona, otro negocio | OK: búsqueda por (chat, código) + negocio + persona; mismo mensaje y misma auditoría (sin oráculo de respuesta ni de tiempo) | `service.ts:783-794`; prueba de aislamiento |
| Referencias heredadas `/aprobar <case_id>` | OK: nunca publica ni descarta; caso propio ⇒ reenvío; ajeno = inexistente | `telegram.ts:204-213`; `service.ts:357-361,1133-1148` |
| Fallo ambiguo del canal | Sin publicación indebida (ambos códigos muestran lo mismo); **F-11** (encabezado) | P6 |
| Panel `POST /approve` con `draft_number` | **F-03** | P2 |
| Negocio suspendido o en baja | **F-05** (preexistente) | P8 |

## 3. SEC-CONSENT-01 — caminos revisados

| Camino | Resultado | Evidencia |
|---|---|---|
| `classifyCase` Google, consentimiento sin versión u otra versión | OK: sin IA, sin reserva, texto seguro, deny `consent_outdated` | `service.ts:435-448`; AC-16007 (×2) |
| `classifyCase` Google, rama `needsHuman` | **F-01**, **F-04** | P4, P9 |
| `classifyCase` Facebook | Por diseño sin cuota (R4); el consentimiento previo sigue cubriendo; gasto acotado por presupuestos técnicos (ver §6) | prueba «Facebook: el consentimiento previo…»; `ai-cost-bounds` (c) |
| `meteredReply` | OK: reserva antes de invocar; replay ⇒ sin IA; fallo ⇒ liberación | `service.ts:554-575` |
| Re-comprobación en la transacción (`PolicyChangedError`) | OK en la rama automática (rollback + liberación + reintento); **F-04** en la humana | `service.ts:457-463,512-520`; prueba «Revocación durante la redacción» |
| `setPolicy`: versión mostrada, 400/409, otro origen | OK; texto, versión y huella son constantes del servidor | `service.ts:256-262,271-275,303-305`; AC-16008 |
| `reconsent`: idempotencia, concurrencia, RBAC, aislamiento | OK: candado por categoría, mismo modo y límite, auditoría en la transacción; 5 simultáneas ⇒ 2 filas; Operación 403; otro negocio intacto | `service.ts:323-341`; `engagement-routes.ts:160-167`; AC-16008 (×3) |
| CHECK NOT VALID y trigger de `engagement_policy` | OK: INSERT automático sin versión ⇒ 23514; cualquier UPDATE ⇒ rechazo; huella ≠ texto ⇒ rechazo; **F-08** (versión↔texto) | `0037…sql:26-54`; prueba «BD: la política es append-only…»; P7 |
| Texto de los términos | Informa cuota compartida, agotamiento y texto seguro (`consent.ts:35`); no menciona el gasto de la rama `needsHuman` (F-01) | lectura |
| Panel | Muestra el texto literal escapado y envía la versión mostrada | `main.js:483-499,510-531`; `agent.js:201-221`; E2E del repositorio (no ejecutado por mí) |

## 4. Migración 0037 y reversión

Sin hallazgos salvo F-10 y F-13. Verificado: aditiva y re-ejecutable (`IF NOT EXISTS`, restricciones con guarda, `CREATE OR REPLACE`);
no toca datos; prueba «0037: conserva políticas, casos y avisos…» pasa. Reversión: candado de migraciones, 55000 si 0037 no está,
si hay migraciones posteriores o si existe cualquier consentimiento versionado o aviso; `LOCK … ACCESS EXCLUSIVE` antes de las
comprobaciones, READ COMMITTED, `ON_ERROR_STOP` ⇒ salida ≠ 0; orden 0037→0036 impuesto (la de 0036 se niega con 0037). Retención:
`engagement_approval_offer` antes de `engagement_notification`/`engagement_case` e `internal_user` en `TENANT_TABLES`
(`retention/service.ts:84-86`), exportada, borrada en la anonimización; purga de Google coherente.

## 5. Canon DEC-0077 (8940101 + f6f1346 + 3543a9a)

- Huellas: SRC-0016 `113a6344…fed8c`, SRC-0017 `6acfea9d…c6352c`, OWNER-RESOLUTION `eabce6b3…f89d`, NEXT-LOCAL-ROUND `0889dd84…5b6c`:
  coinciden con el contrato (`sha256sum`).
- Fidelidad: R1–R9 citan o resumen fielmente SRC-0017:54-80 y OWNER-RESOLUTION:10-26; la lista «No decide» se conserva; las cifras
  (30/60 días, gracia de 7 días C09, 14 días de respaldos) vienen de decisiones previas; precedencias correctas (DEC-0018 no se
  sustituye; SUPERSEDES parciales documentados; R8 acumulativo con BR-0007). Desviaciones: F-01, F-09, F-12, F-14.
  `f6f1346` corrige R4/BR-0007/NFR-0006/AC-16011: el máximo por hora limita la publicación, no la redacción ni el gasto (coincide
  con el código y con `ai-cost-bounds` (c)).
- Validadores (`~/codeart/canonflow-keystone`): `validate_schemas_v2.py` VALID para DEC-0077.json, source-register.yaml,
  decision-state/index.json, links.yaml, functional-canon-state.yaml e implementation-state.yaml (5549935) y DEC-0077.json
  (e4af950). `validate_traceability.py`: `RESULT: FAIL — 5/106`, los mismos 5 enlaces preexistentes que en `b809510` (`5/101`:
  ANS-0012…0015 y QS-0017 SUPERSEDES QS-0016); los 5 enlaces nuevos de DEC-0077 pasan.

## 6. Commit e4af950 (sección aparte)

Cambios: `reserveBudget` deniega si falta `lab_total` o, con negocio, todo `tenant_day` (`src/ai/governance.ts:67-68,76-78`);
`AiLab.enabled` exige `appEnv !== 'production'` (`src/ai/lab.ts:194`); `AiJobs` exige el `AiLab` compartido (`src/ai/jobs.ts:62-66`);
`server.ts:222` y `dispatcher.ts:102` pasan `appEnv`; prueba nueva `tests/integration/ai-cost-bounds.test.ts` (9 pruebas).

Veredicto: **correcto; sin hallazgos que bloqueen.** Fail-closed real (ausencia de techo ≠ sin límite); las rutas de pago no pueden
eludir la reserva (`max_cost_usd > 0` por CHECK, `0025_ai_core.sql:149`; `dispatcher.ts:261-266`); el único writer de consola solo
modifica filas globales (`platform-routes.ts:265-266`). Las 9 pruebas cubren Facebook fuera de la cuota, presupuesto diario
agotado (sin llamada al proveedor, texto seguro o revisión humana), tope TypeSafe, ventana móvil del máximo por hora (y que la
redacción de los casos limitados también reserva), grants inválidos/válidos, techos globales, ausencia de techos y producción.

| ID | Sev. | Archivo:línea | Descripción | Corrección |
|---|---|---|---|---|
| E-01 | NIT | `src/web/panel/assets/js/views-ai.js:178`; `src/api/ai-routes.ts:124` | El panel muestra «Laboratorio de IA» si `status.environment === 'lab'` (valor por omisión), aunque en producción `lab.enabled` sea falso: baldosa visible que siempre termina en `lab_disabled` | Exponer `lab_enabled` en `/ai/status` y usarlo en la condición |
| E-02 | NIT (preexistente) | `src/ai/governance.ts:63-66` | `pick` prefiere una fila con `tenant_id` también para los ámbitos globales (`lab_total`, `platform_month`), que la consulta trae de cualquier negocio; hoy solo hay filas globales (semilla y consola), pero con e4af950 `lab_total` pasa a ser obligatorio | Filtrar `tenant_id IS NULL` para los ámbitos globales (o CHECK en `ai_budget`) |

Riesgos residuales de e4af950 (no defectos): `lab_total` es el techo acumulado de TODA la IA de pago, sin ventana ni entorno
(`governance.ts:44-46`), con tope de consola USD 25 (`platform-routes.ts:46,265`); al volverse obligatorio, la IA de pago de un
entorno productivo depende de una decisión explícita sobre ese techo. Un despliegue que no ejecute `ensureAiCatalog`
(`scripts/db-setup.ts:46`; filas `bud_lab_total`/`bud_tenant_day_default`, `catalog.ts:359-363`) deja toda la IA de pago denegada
(fail-closed correcto; debe constar en el procedimiento de despliegue).

## 7. Resultados de verificación (exactos)

| Comprobación | 5549935 (`mainspot_test_review`) | e4af950 (`mainspot_test_review_e4`) |
|---|---|---|
| `npx tsc --noEmit` | `TSC_EXIT=0` (antes de añadir las sondas) | `TSC_EXIT_CLEAN=0`; con las sondas `TSC_EXIT_WITH_PROBE=0` |
| `npm run test:unit` | `ℹ tests 187 · pass 187 · fail 0` (12,7 s) | `ℹ tests 187 · pass 187 · fail 0` |
| `npm run test:integration` | `ℹ tests 291 · pass 291 · fail 0 · cancelled 0` (147,4 s) | `ℹ tests 300 · pass 300 · fail 0 · cancelled 0` (133,5 s) |
| Sondas `tests/probes/gov-review.test.ts` (`mainspot_test_review_probe` / `_e4`) | 11/11 reproducen | 11/11 reproducen |

Las pruebas nuevas del repositorio pasan en ambos commits: engagement-consent 8/8, telegram-approval-binding 9/9,
consent-approval-migration 4/4 (incluidas reversión con psql y bloqueo 55000), ai-cost-bounds 9/9 (e4af950).

## 8. Límites

- No ejecutado: E2E de navegador (`tests/e2e/governance-safeguards-ui.test.ts`; prohibido aquí), smoke, Telegram/Google/Meta/IA
  reales. Todo lo observado es con proveedores simulados; nada acredita entrega real.
- P1 usa el analizador exacto de `assistant.js` (cargado del archivo) y envía lo que envía el botón; el prefijo de la confirmación
  («¿Publico esta respuesta en Google?») se aproxima, el texto entre comillas (`a.shown`) es exacto.
- F-06 depende del orden de llegada de la edición y del envío; la sonda lo fuerza con compuertas en el canal y en la auditoría.
- Artefactos que dejé: worktrees `../mainspot-platform-gov-review` y `../mainspot-platform-gov-review-e4af950` (solo
  `tests/probes/` sin seguimiento) y las BD `mainspot_test_review`, `mainspot_test_review_e4`, `mainspot_test_review_probe`
  en el contenedor desechable. No toqué `mainspot-platform-governance`, el checkout principal ni `canonflow-keystone`.
