# Revisión adversarial F3 — DEC-0076 (SRC-0014 C01/C04–C06): cuota `ai_review_replies`

Revisor: QuotaReview (Claude Opus 5.5, esfuerzo max). Fecha: 2026-11-05.
Objeto: cambio SIN commit en `mainspot-platform-commercial` (rama `feat/commercial-quota-semantics-20261105`, base `83619f0`):
`git diff 83619f0 -- src migrations scripts tests` (20 archivos, +459/−127) y los archivos nuevos `migrations/0036_commercial_quota_semantics.sql`,
`scripts/commercial-quota-rollback.sql`, `tests/integration/commercial-quota*.test.ts`, `tests/e2e/commercial-quota-ui.test.ts`.
No se leyeron ni tocaron `.canonflow/` (salvo lectura de SRC-0014, DEC-0076.md y FR-0016 para contrastar), `docs/` ni `evidence/`.

## Método y entorno

- Lectura completa del diff y del código afectado (servicio de atención, worker, Telegram, libro de cuotas, dispatcher, política/ciclo,
  registro, catálogo/asignación, panel y consola).
- Ejecución SOLO contra el contenedor desechable `127.0.0.1:55497`, en una BD PRIVADA `mainspot_qr_test` (para no reiniciar
  `mainspot_test`, que usa Main: `test-prep` hace `DROP DATABASE … WITH (FORCE)`). Sin E2E de navegador, sin BD de desarrollo,
  sin proveedores reales (AI Core simulado del entorno `test`), sin cambios en el repositorio.
- Sondas adversariales desechables en `/tmp/qr_probes/probes.test.mts` (fuera del repo). Todas pasan = el defecto se reproduce.

## Resumen priorizado

| # | Sev. | Hallazgo | Evidencia |
|---|---|---|---|
| F1 | **HIGH** | «Redactar con IA» antepone la propuesta y desplaza la numeración: `/aprobar <caso> N` del aviso de Telegram publica un texto que el aviso nunca mostró (y la opción 3 desaparece) | Sonda P1 reproducida |
| F2 | MEDIUM | Modelo de borradores por índice + inserción al frente: una edición concurrente/obsoleta borra la propuesta de IA ya cobrada (irrecuperable, etiqueta falsa) y la inserción descarta en silencio la opción 3 aunque sea una propuesta humana guardada | Sondas P2 y P5 reproducidas |
| F3 | MEDIUM | Vista previa de migración de la consola marca `reviews_managed` (ya sin enforcement) como «por encima del límite… solo se bloquean nuevas creaciones» y lo cuenta en auditoría | Lectura de código |
| F4 | MEDIUM | (diseño, G-SEM #2) La respuesta automática consume la misma cuota mensual sin control del dueño ni aviso: agota las unidades de «Redactar con IA»; el consentimiento no menciona el consumo | Lectura de código + DEC-0076 |
| F5 | MEDIUM | (gobierno) Comentarios de Facebook con propuesta de IA automática y sin medir frente al literal de C01 «cada respuesta generada con IA gasta una unidad»; DEC-0076 marca C01 «Implementado» con G-SEM #4 pendiente | Lectura de código + SRC-0014 |
| F6 | LOW | TTL fijo de la reserva (120 s) no acoplado al timeout de la ruta; si vence, `classifyCase` LANZA (no cae al texto seguro) y el tick del worker se corta para los negocios siguientes | Sonda P3 reproducida |
| F7 | LOW | Log de nivel ERROR `quota.parameter_missing` en cada intento sobre una revisión previa a 0036 (estado ESPERADO tras el despliegue) | Observado en log de prueba |
| F8 | LOW | Panel: el saldo `aiReplies` no entra en el sondeo de 5 s (estado obsoleto); el botón aparece en casos `basic_info/phone` que el servidor rechaza | Lectura de código |
| F9 | LOW | Rama `replay` de `meteredReply` invoca la IA y usa el texto sin medir (fail-open, hoy inalcanzable) — incoherente con el fail-closed de `requestAiDraft` | Lectura de código |
| F10 | LOW | Pruebas no deterministas: «dos clasificaciones simultáneas…» depende del tiempo (≈3 % de fallo con el stub de la suite); el archivo no es re-ejecutable sobre la misma BD | Sonda P4 + re-ejecución observada |
| F11 | NIT | Detalles de consola/panel/mensajes (ver lista) | Lectura de código |

Ninguna doble contabilidad ni sub-contabilidad de unidades encontrada en los caminos medidos (ver «Verificado como correcto»).
F1 lo recomiendo como bloqueante de merge (publicación pública no vista por quien aprueba).

---

## Hallazgos

### F1 — HIGH — Numeración obsoleta en Telegram tras «Redactar con IA» publica un texto no visto

- Código:
  - `src/engagement/service.ts:510-516`: la propuesta de IA se ANTEPONE: `drafts = jsonb_path_query_array(jsonb_build_array($2::text) || drafts, '$[0 to 2]')` (la antigua 1 pasa a 2, la 2 a 3 y la 3 se pierde).
  - `src/engagement/service.ts:776-791` (`notificationText`): el aviso enumera `1) … 2) … 3) …` y dice `/aprobar <caso> 1 (o 2, 3)`.
  - `src/engagement/telegram.ts:201-202`: `/aprobar <caso> N` → `approve(..., { draft_index: N-1 })`.
  - `src/engagement/service.ts:589-591`: el índice se resuelve contra `found.drafts` ACTUAL en el momento de aprobar.
  - `requestAiDraft` (`service.ts:469-533`) no toca `notify_status` ni re-notifica; el panel invita a decidir desde Telegram
    (`views-channels.js:400` «Puedes decidir desde ahí»).
- Escenario: el dueño recibe el aviso con 3 propuestas sin IA; en el panel pulsa «Redactar con IA» (o lo hace otra persona con
  `engagement.respond`+`ai.generate`, p. ej. Operación); después responde en Telegram `/aprobar <caso> 1` pensando en la disculpa que leyó →
  se publica en Google el texto de IA que nunca vio. `/aprobar <caso> 3` publica la antigua 2; la antigua 3 ya no es elegible.
  Agravantes: el texto aprobado así no lleva `AI_REPLY_DISCLOSURE` (solo se añade en automáticas, `service.ts:357`) y contradice el
  invariante «no se publica nada sin preview/aprobación» (`src/reputation/engine.ts:16`) y la «decisión humana» de FR-0016.
- Evidencia (sonda P1, IA simulada):
  `telegram_option_1` = «Hola Ana P., gracias por contarnos tu experiencia. Lamentamos lo ocurrido…»;
  tras `/aprobar <caso> 1`: `state = responded`, `response_text` = «¡Muchas gracias, Ana P.! Nos alegra que te haya gustado. Te esperamos pronto.»
  (= `drafts[0]` de IA); `drafts_after_ai` ya no contiene la opción 3 del aviso; un solo aviso enviado (sin re-notificación).
- Dirección de corrección (no decide nada comercial): índices estables (la IA en su propio campo/slot o añadida al final, no al frente),
  o versión de borradores que el comando de Telegram lleve y que `approve` exija (rechazo si cambió), y/o re-notificar.
  Falta además una prueba que fije este contrato.

### F2 — MEDIUM — Borradores por índice + inserción al frente: propuesta de IA cobrada borrable y propuesta humana descartada

- Código: `editDraft` hace lectura-modificación-escritura del arreglo completo sin comparación (`service.ts:556-567`,
  `SET drafts = $2 … WHERE … state IN (…)`); el panel de Operación guarda por índice (`main.js:573-575`, `saveDraft(id, draft.pick, text)`)
  con selección por defecto 0 (`views-channels.js:390`); la etiqueta «Redactada con IA» depende solo de `reply_invocation_id`
  (`agent.js:98`, `views-channels.js:396`); `requestAiDraft` devuelve `already` para siempre si hay `reply_invocation_id` (`service.ts:472`).
- Escenarios:
  1. (carrera, P2) `editDraft` lee antes del commit de la IA y escribe después: el arreglo viejo pisa la propuesta de IA. Quedan
     `reply_invocation_id` puesto, 1 unidad confirmada, la etiqueta «Redactada con IA» sobre un texto que no es de IA, y no hay forma de
     regenerar («ya tenía su propuesta»).
  2. (sin carrera, [INFERENCE] mismo mecanismo) Operación abrió el caso antes de la redacción con IA; con `pick: 0` guarda su propuesta
     después → sobrescribe el slot 0, que ya es la IA.
  3. (P5) La inserción conserva solo dos borradores (`'$[0 to 2]'`): si la opción 3 era una propuesta escrita y guardada por Operación
     para que Administración apruebe, desaparece sin rastro (el comentario de `service.ts:511` dice que «se conservan… también las editadas»).
- Evidencia: P2 → `drafts_final` sin el texto de IA, `ledger {committed: 1}`, reintento `[200, true]`.
  P5 → `drafts_before[2]` = «Propuesta escrita por Operación…»; `drafts_after` sin ella; auditoría solo
  `engagement.case.classified, engagement.draft.edited, engagement.ai_draft.generated` (nada registra la pérdida).
- Dirección: compare-and-set (versión o `WHERE drafts = $esperado`), slot propio para la IA, o añadir sin desplazar; etiqueta basada en
  la posición/huella del texto de IA, no solo en `reply_invocation_id`.

### F3 — MEDIUM — Consola: la migración marca «Reseñas gestionadas» por encima del límite aunque ya no se aplica

- Código: `src/plans/assignment.ts:141-145` añade a `over_limit` toda capacidad no periódica con `usage > next`, sin filtrar
  `enforcement.state`; `console.js:563` lo pinta como alerta con «solo se bloquean nuevas creaciones»; el resultado de auditoría lleva
  `:over_limit` (`assignment.ts:175`) y el recuento `over_limit:N` (`assignment.ts:190`). `reconcile` sí filtra enforced (`quota.ts:372`).
- Escenario: con C01 la sincronización ya no limita; cualquier negocio con más reseñas que el valor de su revisión
  (`plan_piloto_1` = 20) aparece «Por encima del límite» en cada vista previa de migración, contradiciendo C01 y lo que ve el negocio
  («Sin límite», `views-app.js:259`), y ensucia la auditoría de plataforma. (Preexistente para `agents`; DEC-0076 lo vuelve sistemático.)
- Dirección: filtrar parámetros `enforced` en `previewMigration` (como `reconcile`).

### F4 — MEDIUM — (diseño a confirmar) La respuesta automática gasta la cuota mensual sin control ni aviso

- Código: `service.ts:342-348` reserva y redacta con IA en cada respuesta automática autorizada; sin unidades cae al texto seguro con
  solo un evento de auditoría deny (`service.ts:416-422`). `CONSENT_TEXT` (`service.ts:82-86`) no cambió.
- Riesgos: (i) las respuestas automáticas (agradecimientos, alto volumen) pueden agotar el ciclo y dejar sin «Redactar con IA» las
  reseñas negativas que más lo necesitan; no hay opción «automáticas con texto seguro»; (ii) los consentimientos dados antes de DEC-0076
  empiezan a consumir cuota en cuanto se publique una revisión con valor > 0, sin que el texto del consentimiento lo diga; (iii) el paso a
  texto seguro es silencioso (C05 pide «avisar»). DEC-0076 lo lista como interpretación de ingeniería pendiente (G-SEM #2); no lo re-decido,
  pero el efecto debe presentarse al propietario y, como mínimo, divulgarse en la UI de reglas/consentimiento.

### F5 — MEDIUM — (gobierno) Facebook queda fuera de la cuota con C01 marcada «Implementado»

- Código: `service.ts:339-341` redacta con IA cada comentario de Facebook al recibirlo (fuera de la cuota); `registry.ts:124` lo declara.
- SRC-0014 C01: «Cada respuesta generada con IA gasta una unidad de cuota mensual». La exclusión es la interpretación G-SEM #4 aún sin
  confirmar, pero la tabla de DEC-0076 marca C01 «Implementado (local)». Exposición de costo acotada solo por `ai_budget tenant_day`
  (semilla 1.00 USD/día, consultado en `mainspot_qr_test`). Recomendación: C01 «Parcial» hasta la confirmación, o medir Facebook.

### F6 — LOW — Reserva vencida a mitad de la redacción: excepción en vez de caída al texto seguro; corta el tick

- Código: `QUOTA_RESERVATION_TTL_MS = 120_000` (`quota.ts:55`) es fijo; el timeout por intento es `route.params.timeout_ms`
  (`dispatcher.ts:342`) por `repair_attempts + 1` intentos (`dispatcher.ts:364-367`), editable hasta 300 s (`ai/registry.ts:42`).
  `commitInTx` falla con 409 `quota_reservation_expired` y `classifyCase` lo propaga (`service.ts:383`, sin captura); `tick()` no aísla
  negocios (`worker.ts:73-77`) ni `classifyReceived` aísla casos (`worker.ts:242-247`).
- Evidencia (P3, TTL 1 ms para simular >120 s): `classifyCase` rechaza con `quota_reservation_expired`, caso sigue `received`, reserva
  `released`; `worker.tick()` rechaza y el caso de `client_qrp3z…` (posterior en orden) queda `received`.
- Impacto: con la configuración actual (30–45 s ×2) es improbable; se autocorrige en el tick siguiente (la clave fija del dispatcher
  reproduce la salida). En «Redactar con IA» se pierde la redacción pagada (409) y el reintento paga otra. Sube a MEDIUM si alguien alarga
  el timeout de las rutas de respuesta. Dirección: capturar el vencimiento y caer al texto seguro, o derivar el TTL del timeout de la ruta.

### F7 — LOW — ERROR operativo para un estado esperado

- `quota.ts:221` emite `log.error('quota.parameter_missing')` cuando la revisión fijada no define el parámetro. Tras desplegar 0036, TODAS
  las revisiones publicadas están así (por diseño fail-closed), y cada respuesta automática elegible o cada clic en «Redactar con IA» produce
  un ERROR (observado una vez en `commercial-quota.test.ts`, prueba «Fail-closed»). Riesgo de fatiga de alertas. Dirección: nivel warn/info
  para parámetros añadidos después de la revisión (p. ej. `registry_version` de la revisión < versión del parámetro).

### F8 — LOW — Estado obsoleto del saldo en el panel

- `store.js:518`: el sondeo de 5 s no incluye `aiReplies` (solo carga completa y tras `AG.aiDraft`). Consumos de respuestas automáticas, de
  otra persona, un cambio de plan o la renovación del ciclo no se reflejan: el aviso «Ya usaste… Se renuevan el …» y la ausencia de botón
  persisten hasta recargar. Además el botón se ofrece en casos `basic_info`+`phone` (`views-channels.js:345`) que el servidor rechaza con 409
  (`service.ts:480-481`; sin reserva ni cobro).

### F9 — LOW — Rama `replay` de la redacción automática sin medir

- `service.ts:444-445`: con `claim.kind === 'replay'` se invoca la IA y se usa su texto sin reserva. Hoy es inalcanzable (la unidad se
  confirma en la misma transacción que saca el caso de `received`), pero es fail-open e incoherente con `requestAiDraft`
  (`service.ts:494-500`, «no se redacta otra sin medir»). Dirección: devolver `generated: null` en replay.

### F10 — LOW — Determinismo de pruebas

- `commercial-quota.test.ts:358-373` exige exactamente 1 unidad confirmada con 3 clasificaciones simultáneas; el resultado depende del
  orden de llegada de los UPDATE. P4: con stub de latencia 0 (como la suite) la IA gana 29/30 (`safe: 1`, ⇒ ≈3 % de fallo);
  con ≥1 ms gana 7/30. (En producción el candado por negocio de `tickTenant` serializa, así que el impacto es solo de CI.)
- `commercial-quota.test.ts:24` usa `update_id` fijos: re-ejecutar el archivo sin `test-prep` falla
  (`'duplicate' !== 'linked'` en la línea 187; observado en mi primera ejecución repetida).

### F11 — NIT

- `console.js:128`: el mapa `SHORT` no tiene `ai_review_replies` → el selector de planes muestra `quota.ai_review_replies.max 5`.
- `views-channels.js:351/353`: «Ya usaste las 1 respuestas», «te quedan 1 de 1»; con uso > límite tras bajar el plan dice «las 1» aunque se usaron más.
- `service.ts:508`: HTTP 502 con código `validation_error`; `service.ts:477`: mensaje «ya no admite cambios» también para casos `received`.
- `main.js:441-452`: el resultado (también `already`) sustituye sin aviso lo que la persona tenía escrito en «Tu respuesta».
- `service.ts:523`: rama `'replay:0'` muerta (replay retorna antes).
- Un borrador creado con registro 1 puede publicarse con registro 2 conservando `registry_version = 1` (solo informativo).

---

## Verificado como correcto (con evidencia)

1. **C01 recepción sin cuota**: `ReputationEngine.sync` ya no usa el libro (`engine.ts:244-262`); worker y backoffice sin consumo
   (AC01 pasa); el lote sigue atómico con su auditoría (NFR-0001 pasa) y serializado por `review_sync:<tenant>`; dedupe
   `ON CONFLICT (tenant_id, source_review_id)` (`engine.ts:118`). La puerta de suscripción activa solo aplica con reseñas nuevas, igual que antes.
2. **Una unidad por respuesta con IA, como máximo una por caso**: clave `ai_reply:<case_id>` única por (tenant, capacidad, clave);
   reserva antes de invocar (`service.ts:488`, `:437`), commit en la MISMA transacción que guarda el texto y su auditoría
   (`service.ts:510-527`, `:380-390`), liberación en `finally` ante cualquier fallo (`:530-532`, `:395-397`). Replay ⇒ 200 `already` sin
   consumo; concurrencia mismo caso ⇒ 1 unidad (AC03); 8 casos/límite 3 ⇒ exactamente 3. Reutilizar una fila vencida conserva el mismo
   `reservation_id` (`quota.ts:404-407`, el `ON CONFLICT … DO UPDATE` no reescribe la clave primaria), así que dos peticiones solapadas confirman a lo sumo una vez [análisis].
3. **Sin sub-contabilidad**: toda unidad confirmada corresponde a un texto de IA guardado (automática, `needsHuman` → borrador 1, o a
   pedido); fallo de IA (502) o caso cambiado (409) ⇒ liberada; P4 confirma `committed == casos con IA` en 60 iteraciones.
4. **Fail-closed**: revisión sin el parámetro ⇒ 403 `limit_exceeded` («no define»), sin reserva ni invocación; suscripción inactiva ⇒
   `subscription_required`; registro v2 desplegado sin 0036 ⇒ deny (la revisión no tiene valor) y escrituras del catálogo 503.
5. **C04/C06 ciclo**: `monthlyCycle` anclado a `subscription.started_at` en UTC con día acotado sin deriva (`policy.ts:146-169`); el uso
   periódico cuenta unidades confirmadas por `settled_at` en la ventana + reservas vivas (`quota.ts:190-208`); ningún código reescribe
   `started_at` (asignación y reactivación conservan ancla y uso, `assignment.ts:104-110`); sin acumulación (AC04).
6. **C05**: agotada solo bloquea la IA; responder a mano (panel y Telegram) no consume; facturar sigue 403 (AC02/AC05).
7. **Aislamiento y anti-oráculo**: `getCase` filtra tenant, UPDATE con `tenant_id`, 404 idéntico para ajeno/inexistente, permisos antes de
   la búsqueda; claves del libro por tenant.
8. **Permisos**: POST exige `engagement.respond` + `ai.generate`; GET `engagement.read` — todos los roles con `engagement.read` tienen
   también `subscription.read` (`rbac/matrix.ts:93-125`): sin ampliación de lectura del plan. `request_id` lo genera el servidor (`context.ts:30`).
9. **Auditoría**: éxito con `engagement.ai_draft.generated` + `quota.reserved/consumed` en la transacción; denegación `engagement.ai_reply`
   (best-effort, mismo patrón que `denyAndRespond`); liberaciones `quota.released` con motivo.
10. **XSS**: `aiDraftBox` escapa el cuerpo; `UI.btn` escapa `arg`; `UI.toast` escapa; «Mi plan» escapa nota, ciclo y textos.
11. **Migración 0036**: aditiva, idempotente, atómica (consulta simple multi-sentencia del runner), comprobación de forma; espejo igual al
    registro en las 12 columnas comparadas + descripción; etiqueta, categoría, unidad, techo y orden coinciden (comparación manual); no toca
    revisiones, valores, suscripciones ni libro; FK `quota_reservation.capability` → definición (0034) admite la capacidad nueva.
12. **Reversión**: se niega sin 0036, con migraciones posteriores o con cualquier valor/reserva de la capacidad; candados correctos; restaura
    la descripción de 0034 byte a byte; orden 0036 → 0035 → 0034 impuesto por los scripts de 0035/0034.
13. **Registro v2/catálogo**: `reviews_managed` `not_enforced` con nota; `reconcile` excluye no aplicados y periódicos; borradores nuevos
    traen la cuota sugerida 0 sin confirmar (`catalog.ts:329-333`); publicar exige los 7 confirmados (trigger 0034); volver a una revisión
    previa a 0036 se niega con mensaje claro (`catalog.ts:538-540`).
14. **Sin regresiones observadas** en los flujos cubiertos por la suite (FR-0016, INC-004, cuotas, catálogo, aislamiento): ver pruebas.

## Riesgos residuales y límites

- Al desplegar, ninguna revisión publicada define la cuota: todas las reseñas de Google pierden la propuesta de IA y las automáticas pasan
  al texto seguro hasta publicar revisiones con valor > 0 (fail-closed correcto, requiere comunicación).
- Fallos de IA a pedido no consumen unidades pero sí USD; acotado por `ai_budget tenant_day` (1.00 USD/día semilla), que es compartido con
  las demás funciones de IA del negocio.
- El laboratorio (`/ai/lab/replies`) permite respuestas de IA a reseñas sin medir para quien tenga grant (por diseño, DEC-0074).
- La reversión de 0036 es de un solo sentido en cuanto exista cualquier borrador o reserva con la capacidad (documentado en el script).
- C07: bajar el límite a mitad de ciclo bloquea de inmediato (AC04 lo fija como esperado); SRC-0014 C07 dice «bajar: al siguiente ciclo»
  (DEC-0076 lo marca Parcial).
- `reviews_managed` sigue exigiendo confirmar un valor sin efecto en cada revisión nueva (fricción en el editor).
- La sincronización ya no tiene tope por lote: depende de la paginación del proveedor.
- Operación (`ai.generate`) puede consumir la cuota del negocio.
- No verificado por mí: E2E de navegador (no permitido aquí), consistencia de `docs/`/`.canonflow/` (fuera de alcance), proveedores reales.

## Pruebas ejecutadas (BD privada `mainspot_qr_test`, contenedor 127.0.0.1:55497)

Entorno: `DATABASE_URL=postgres://mainspot:…@127.0.0.1:55497/mainspot TEST_DATABASE_URL=…/mainspot_qr_test APP_ENV=test`, `node scripts/test-prep.ts`.

| Prueba | Resultado |
|---|---|
| `tests/integration/commercial-quota.test.ts` (BD recién preparada) | 12/12 |
| mismo archivo re-ejecutado sin `test-prep` | 11/12 (`'duplicate' !== 'linked'`, línea 187) → F10 |
| `tests/integration/commercial-quota-migration.test.ts` | 4/4 |
| engagement-agent, reputation-inc004, quota-semantics, quota-toctou, nfr-0001-atomicity, plan-catalog, subscriptions-inc006, ai-core, isolation | 100/100 |
| Sondas `/tmp/qr_probes/probes.test.mts` (P1, P2, P3, P4×2, P5) | 6/6 (cada una reproduce su hallazgo) |

Reproducir las sondas: mismo entorno, `node scripts/test-prep.ts && node --test --test-concurrency=1 /tmp/qr_probes/probes.test.mts`
(desde el worktree). Logs: `/tmp/qr_probes/run2.log`, `/tmp/qr_probes/regress.log`, `/tmp/qr_probes/mig.log`, `/tmp/qr_cq_run1.log`.

---

## Re-verificación (correcciones de Main, mismo worktree, sin commit)

Las correcciones se verificaron con sondas nuevas y las pruebas del repositorio, en el mismo contenedor desechable y en BD privadas
(`mainspot_qr_test` y, para la reversión, `mainspot_qr_mig`, ya borrada). No se tocó `mainspot_test`.
Sondas: `/tmp/qr_probes/reverify.test.mts` (9/9; cada prueba afirma el comportamiento CORREGIDO). Log: `/tmp/qr_probes/reverify.log`.

| # | Veredicto | Evidencia |
|---|---|---|
| F1 | **PASS** | `requestAiDraft` escribe `ai_draft` + `reply_invocation_id` y no toca `drafts` (`service.ts:532-535`). La sonda (Telegram vinculado, aviso enviado, «Redactar con IA» y luego `/aprobar <caso> 1` y `/aprobar <caso> 3`) publica exactamente las opciones 1 y 3 del aviso, no la IA. Las numeradas quedan iguales tras la redacción. Nueva prueba del repositorio «La propuesta con IA va aparte…» pasa. |
| F2 | **PASS** | La misma interleaving que reprodujo P2 (candado de fila, IA y edición en espera, commit) deja `ai_draft` intacto, la edición aplicada a la opción 2 y `ledger {committed:1}` (F2a). La opción 3 guardada por una persona sobrevive (F2c). La restricción de 0036 rechaza `ai_draft` sin `reply_invocation_id` (SQLSTATE 23514). Panel: opción aparte «Propuesta con IA» (`views-channels.js:360-368`). La etiqueta «Redactada con IA» queda solo para IA en la opción 1 (`aiInDrafts`). |
| F3 | **PASS** | `assignment.ts:30,147` (`ENFORCED_KEYS`). La regresión de `plan-catalog.test.ts` (25 reseñas > 20 sin aviso; `over_limit` solo `social_posts`) pasa. |
| F4 | **PASS** (divulgación) | `CONSENT_TEXT` (`service.ts:90`) y `#pol-ai-quota` (`views-channels.js:443`) explican el consumo y el texto seguro. La decisión de fondo sigue en G-SEM #2. |
| F5 | **PASS** (docs) | `DEC-0076.md:22` ya marca C01 «parcial» para Facebook y el laboratorio (G-SEM 4); también en la línea 45. |
| F6 | **PASS** | Con reserva vencida, `classifyCase` devuelve `classified/auto_reply` con el texto seguro, `reply_invocation_id = null`, sin «generada con IA» y la reserva `released`, sin lanzar. `worker.tick()` termina: el negocio posterior (`client_qrv3z…`) se procesó (`needs_human`) y el segundo caso del primero quedó `responded`. La app usa un ledger con TTL de 15 min (`server.ts:231`, comprobado en tiempo de ejecución). |
| F7 | **PASS** | `quota.ts:222` usa `log.warn`. En el log de la sonda: 1 evento `quota.parameter_missing`, `"level":"warn"`. |
| F8 | **PASS** (código, sin navegador) | `aiReplies` entra en el sondeo (`store.js:518`). `aiEligible` excluye `basic_info` + teléfono y los casos que ya tienen IA (`agent.js:101-102`). |
| F9 | **PASS** | Con una unidad confirmada previa para el caso en `received`: 0 invocaciones de IA, texto seguro, `ledger {committed:1}` sin filas nuevas (`service.ts:461`). |
| F10 | **PASS** | `commercial-quota.test.ts` pasa 13/13 dos veces seguidas sobre la misma BD, sin `test-prep`. La prueba de clasificaciones simultáneas acepta cualquier ganador y conserva el invariante. Sonda: 30 iteraciones triples con latencia ≥1 ms dan `committed == casos con IA` (4 == 4) y 0 reservas vivas. |
| F11 | **PASS parcial** | Hechos: `SHORT` con `ai_review_replies` (`console.js:128`), singular/plural y uso real en el aviso de agotada (`views-channels.js:351-353`), «Tu respuesta» solo se sustituye si no se tocó (`main.js:443-458`; `captureInputs` conserva lo escrito), mensaje para `received` y rama `'replay:0'` eliminada. Pendiente (NIT): el 502 sigue con código `validation_error` (`service.ts:529`). |

Reversión con propuestas de IA, verificada a mano con psql sobre `mainspot_qr_mig`:
- Con un caso con `ai_draft`: `commercial-quota-rollback.sql` sale con código 3 y «BLOCKED: 0 plan revision value(s), 0 quota ledger row(s) and 1 AI draft(s)…». No cambia nada: la columna, la definición y el registro de 0036 siguen.
- Sin `ai_draft`: sale con código 0 y desaparecen la columna, la restricción, la definición y el registro.
- Reaplicar 0036 (`scripts/migrate.ts`) restaura la columna y la restricción.
- La prueba de migración del repositorio no cubre este bloqueo por `ai_draft`: solo valores y reservas (LOW, cobertura).

Suite tras las correcciones (BD privada recién preparada): commercial-quota-migration, plan-catalog, engagement-agent, reputation-inc004,
quota-semantics, quota-toctou, nfr-0001-atomicity, subscriptions-inc006, ai-core, isolation y commercial-quota: **117/117**.

### Riesgos nuevos o residuales tras las correcciones

- **LOW (nuevo por F6):** con TTL de 15 min, una reserva huérfana (proceso caído entre la reserva y el commit o la liberación) bloquea ese caso con 409 `request_in_progress` y ocupa la capacidad hasta vencer. `reconcile()` no la libera antes. Sonda «TTL», límite 1: mismo caso → 409, otro caso → 403 `limit_exceeded`, vence en 15 min, `reconcile` libera 0. En la clasificación automática el efecto es solo usar el texto seguro.
- **Residual (preexistente):** editar una opción numerada después del aviso cambia lo que publica `/aprobar N`, sin re-notificar. Ahora incluye «Operación guarda desde la propuesta con IA → opción 1» (`main.js:582-583`). Es la semántica previa de `editDraft`, no el desplazamiento de F1. Si se quiere cerrar del todo: versión de borradores en el comando de Telegram.
- **Residual (F4):** los consentimientos guardados antes de DEC-0076 conservan su texto anterior (`engagement_policy.consent_text`, append-only). Quien ya había activado respuestas automáticas no ve el nuevo consumo salvo en la pantalla de reglas.
- **NIT (0036):** `ADD CONSTRAINT … CHECK` valida la tabla con candado exclusivo. Es inmediato con tablas pequeñas; con muchas filas convendría `NOT VALID` + `VALIDATE`.
