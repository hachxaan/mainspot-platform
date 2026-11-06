# FB AI POLICY 2026-11-06 — revisión adversarial independiente, pasada 2 (5e8edd7)

Worktree `mainspot-platform-fbp-review-2` en 5e8edd7 (detached; `git status`: solo `?? tests/probes/`). Rango 122e74d..5e8edd7,
con foco en d573cdf..5e8edd7 (f7a4d12 F-01, be81f60 F-03, 6e68646 F-04, 5e8edd7 F-05) y en el código ajeno de ab6ff40/017f58d
más allá de laboratorio/presupuesto. BD: solo el contenedor desechable 127.0.0.1:55506 (`mainspot_review2` /
`mainspot_test_review2`, APP_ENV=test). Sin red: TypeSafe y Anthropic interceptados en `fetch`; sin E2E de navegador; sin
proveedores reales; ningún archivo versionado modificado.

## Veredicto (nivel de código local)

**GO a nivel de código local, con reservas.** No queda ningún hallazgo HIGH ni MEDIUM abierto en el código de 5e8edd7:
F-01 (HIGH) y F-03 (MEDIUM) están cerrados y verificados con sondas propias; F-05 cerrado (resto NIT); F-04 parcialmente
cerrado (la corrección introdujo una regresión LOW, G-01). Reservas antes de proponer el PR:

1. **F-02 sigue abierto** (divulgación + decisión del propietario; la documentación no está en este snapshot). Además, f7a4d12
   volvió a tocar `jev-classifier.ts`: el hash del código de decisión es ahora `5a115a0d…` (d573cdf: `8fcfcc76…`; evidencia
   del gate: `05f7ada8…`). Cualquier divulgación debe citar el hash final del PR.
2. **Recomendado corregir G-01 (LOW) antes del PR**: contradice el texto literal aceptado en
   `ai_suggestions.facebook_comment.v1` («no se preparan para comentarios … con enlaces») y es una regresión respecto de d573cdf.
3. Producción: NO-GO sin cambios (fuera del alcance de esta revisión).

## Hallazgos de la pasada 2

| ID | Sev | Dónde | Qué pasa | Evidencia / sonda | Corrección sugerida |
|---|---|---|---|---|---|
| G-01 | LOW | `src/engagement/suggestions.ts:79,89`; `src/engagement/consent.ts:52-53`; `src/engagement/service.ts:583-594` | Regresión de 6e68646 (F-04): un enlace sin esquema con TLD fuera de la lista fija ya no se detecta, aunque lleve ruta (`youtu.be/…`, `linktr.ee/…`, `amzn.to/…`, `forms.gle/…`, `shorturl.at/…`, `lnkd.in/…`); d573cdf sí los detectaba (regla genérica `dominio.tld/ruta`). Tampoco se detectan dominios en mayúsculas o mixtos (`GANAFACIL.COM`, `Ganafacil.Com`) ni TLD como `.lat`/`.tk`. Con `auto_suggest`, ese comentario se redacta con IA y consume 1 unidad del medidor, contra el texto de consentimiento aceptado | `q04` Q04b (6 casos: hoy `null`, d573cdf `link`), Q04c; `q06`: «Miren mi canal youtu.be/abc123» ⇒ redactada con IA, 1 unidad `committed`; el mismo con `https://` ⇒ `not_relevant:link`, sin unidad | Mantener `BARE_DOMAIN` y añadir de nuevo una regla genérica con ruta (`etiqueta(.etiqueta)*.tld/…`, TLD de 2+ letras) y comparar la lista de TLD sin distinguir mayúsculas, con los mismos límites; casos unitarios en ambos sentidos. Alternativa: reformular el término (nueva versión, reconsentimiento) |
| G-02 | NIT | `src/engagement/suggestions.ts:79` | Falsos positivos residuales de F-04: punto sin espacio seguido de una palabra española en minúscula que coincide con un TLD de la lista (`es`, `me`): «Muy rico todo.me encantó», «Excelente lugar.es el mejor», «Sí.me gustó mucho», «número 1.es delicioso» ⇒ `link`. Efecto fail-closed: sin sugerencia automática ni redacción con IA para publicar (sale el texto seguro o queda para revisión; la persona puede pedirla a mano) | `q04` Q04a (5 casos ⇒ `link`) | Para TLD ambiguos (`es`, `me`, `co`, `us`…) exigir `/`, fin de texto o un signo no alfabético a continuación |
| G-03 | LOW | `src/engagement/service.ts:735-756` (`meteredReply`), `:690`, `:87`; `src/subscriptions/quota.ts:292-293` | Si `semantics.reply()` **lanza** (no devuelve `ok:false`), la unidad reservada no se libera: queda `reserved` hasta `AI_REPLY_RESERVATION_TTL_MS` (15 min). El reintento del worker dentro de ese plazo recibe `request_in_progress` y clasifica el caso sin IA (la sugerencia automática se pierde) y «Sugerir con IA» responde 409 hasta que vence. No es regresión de F-05: existe desde 122e74d (Google) y este ciclo lo extiende a `auto_suggest` de Facebook | `q05` Q05d: excepción ⇒ cuota `reserved`; reintento ⇒ `needs_human`, `reply_invocation_id` null; `git show 122e74d:src/engagement/service.ts` (mismo `meteredReply` sin try/finally) | `try { … } catch { release(…, 'ai_reply_failed'); throw }` alrededor de `reply()` en `meteredReply`; prueba de regresión |
| G-04 | NIT | `src/conversation/jev-classifier.ts:544` (f7a4d12); `src/engagement/telegram.ts:251-270` | La clave opaca elimina el freno del libro al cobro repetido de TypeSafe cuando Telegram reentrega un update cuyo procesamiento falló después de la llamada a Jev (o cuya concesión venció): el mismo `update_id` se paga dos veces. En d573cdf la clave `pipeline:tg_<update_id>` daba `replay` ⇒ `duplicate_request` sin llamada (`typesafe-ledger.ts:147-153`, `jev-classifier.ts:343-346`). HTTP no cambia (el request id es por petición, `boundary/middleware.ts:33-34`). Acotado por el tope DEC-0032 (reserva USD 0.01 por llamada) y equivalente a 122e74d; se pierde además la trazabilidad libro↔solicitud | `q01` Q01c: entregas 500 → 200 `conversation:answered` → 200 `duplicate`; 2 llamadas TypeSafe, 2 filas `committed` | Aceptarlo y documentarlo en TS-1, o derivar la clave con un HMAC del request id con secreto de servidor (seudónimo: decisión del propietario sobre DEC-0027) |
| G-05 | NIT | `src/engagement/service.ts:854` | Resto de F-05: la liberación de una denegación por presupuesto sigue auditada como `…:ai_draft_not_saved`, sin el motivo; el ámbito solo queda en la fila `blocked` de `ai_invocation` (plataforma) | `q05` Q05a: auditoría `ai_review_replies:1:ai_draft_not_saved`; `p05`: `ai_facebook_suggestions:1:ai_draft_not_saved` | Motivo de liberación `ai_budget_exhausted:<ámbito>` |
| G-06 | NIT | `src/ai/governance.ts:11-12`; `docs/architecture/ai-core.md:157-160` (en este snapshot) | Comentario de cabecera y documento siguen describiendo el laboratorio como «con grant» / `manual_lab` bajo grant; desde be81f60 el propósito `lab` incluye las evaluaciones de rutas (`governance.ts:59-61,98-99`) | Lectura | Actualizar el comentario (el documento puede estar en el lote de docs sin commit) |
| G-07 | NIT | `src/conversation/pipeline.ts:351-389` (código ajeno ab6ff40) | La edición con IA desde el chat guarda la solicitud y consume la unidad de `conversations` en una transacción (`:358-366`) y crea el job después (`:369-371`). Si el proceso cae entre ambos pasos, la solicitud queda `classified` con «Estoy preparando el cambio con IA…» y sin job; un reintento o reentrega con la misma clave devuelve el replay (`:105`, `:117-129`) sin job. No hay gasto ni publicación; no existe barrido que la cierre [INFERENCE: ventana de caída no simulada] | Lectura; grep sin barrido de `ai_job_id IS NULL` | Crear el job en la misma transacción o barrer solicitudes `classified` sin `ai_job_id` tras N minutos y responderlas |

## Estado de los hallazgos de la pasada 1

| ID | Estado | Evidencia |
|---|---|---|
| F-01 (HIGH) | **Cerrado** | Clave `pipeline:${randomUUID()}` (`jev-classifier.ts:544`). Prueba nueva `typesafe-anonymization.test.ts` (ensayo). Sonda `q01` Q01a: Telegram real (webhook con `update_id`) + Jev ⇒ clave `pipeline:<uuid>` sin `tg_<update_id>`, anonimización **real** correcta, fila y gasto del libro conservados; Q01b: clasificación TypeSafe del AI Core de un negocio (`ai_invocation:inv_<uuid>`) ⇒ `reapplyExits` anonimiza y la invocación queda re-etiquetada (`retention/service.ts:382-386`). Las claves `ai_invocation:` (`dispatcher.ts:246,551`), `evaluation:<uuid>:<índice>` (`jev-evaluation.ts:131,161`) y `legacy:<día>` (`0040:64`) no contienen identificadores de negocio; los motivos guardados son códigos (`dispatcher.ts:540-545`, `jev-classifier.ts:351-352`). La sonda `p01` de la pasada 1 ya no reproduce (anonimización OK). Idempotencia: replay con la misma clave tras éxito y duplicados concurrentes siguen frenados por la cuota y `telegram_update` antes de Jev (`pipeline.ts:98-107`, `quota.ts:292-293`, `telegram.ts:255-286`); reintentos dentro de una llamada: pipeline con `maxAttempts: 1` (`jev-classifier.ts:674`), AI Core medido por `attempts` (regla `GREATEST`); caída/reconciliación por vencimiento y `dispatched_at`, sin usar la clave. Único efecto: G-04 |
| F-02 (MEDIUM) | **Abierto** (documental + decisión del propietario; fuera del snapshot) | `p02` sigue pasando: evidencia `05f7ada8…` = 122e74d; 5e8edd7 = `5a115a0d6e6b…` (`sha256` de `classifier.ts`+`jev-classifier.ts` por commit); con la ejecución de la evidencia el gate queda cerrado en HEAD |
| F-03 (MEDIUM) | **Cerrado** | `budgetPurpose(ctx)` y `LAB_PURPOSE_SQL`/`OPERATIONAL_PURPOSE_SQL` incluyen `eval_run_id` (`governance.ts:59-61,98-99`; `dispatcher.ts:270`); `evalRunId` solo lo pone `runEvalSuite` con ruta fijada y se verifica contra `ai_eval_run` en curso (`evals.ts:283`, `dispatcher.ts:224-228`). Sonda `q03`: sin `lab_experiment` la evaluación de pago queda `blocked/budget_exhausted/lab_experiment` sin llamar al proveedor y la simulada (reserva 0) corre; con `tenant_day` por defecto = 0 y `lab_experiment` con margen, la evaluación termina (`tenant_id` null, `assignment=eval`), suma n×costo a `lab_experiment`, a `/health` (`spend.by_purpose.lab`), a `/ai/spend` y a `/ai/costs` (propósito `lab`) y nada a operación ni a `tenant_day`. Ninguna ruta clasifica solo por `lab_grant_id` (usos: `governance.ts:105-106,252`, `platform-routes.ts:421`; `tenantLabBudget` usa el mismo filtro). Etiquetas de consola coherentes (`console.js:146-149,205,675`). `p03` ya no reproduce. Resto: G-06 |
| F-04 (LOW) | **Parcial** | Casos reportados resueltos (`p04` ya no reproduce; `q04` Q04d), sin ReDoS (Q04e: 10 entradas adversarias de ~200 000 caracteres en ≤4 ms), etiquetas Unicode correctas (`café.com.mx`). Quedan G-01 (regresión, LOW) y G-02 (NIT) |
| F-05 (LOW) | **Cerrado** (resto NIT G-05) | `reply()` devuelve `ReplyOutcome` (`ai-semantics.ts:108-119`); llamadores `service.ts:750,817`; implementaciones de prueba actualizadas (`commercial-quota.test.ts:370`, `engagement-consent.test.ts:88`, `facebook-ai-suggestions.test.ts:58`, `ai-cost-bounds.test.ts:308`; `tsconfig.json` incluye `tests/**`). Sonda `q05` por HTTP con el despachador real: Google con `tenant_day`=0 ⇒ 429 `limit_exceeded` «Tu negocio alcanzó su presupuesto diario de IA…», 0 llamadas, unidad `released`; Facebook sin `lab_total` ⇒ 429 «MainSpot alcanzó su presupuesto de IA por ahora…»; proveedor HTTP 500 ⇒ 502 genérico, unidad `released`. Panel: `api.js:80-88` conserva el mensaje del servidor en 429 (sin `Retry-After` no añade sufijo) y `main.js:476-487` lo muestra; sin reintento automático. Camino automático: libera con `ok:false` (`service.ts:751-753`) pero no si lanza (G-03, previo). `p05` ya no reproduce (429) |
| F-06 (LOW) | Corregido fuera del snapshot | 5354283 (rama `integrate/telegram-channels-notice-binding-20261106`) cambia `telegram-webhook-starlink.md:6`; **no** es ancestro de 5e8edd7 (`git merge-base --is-ancestor` ⇒ no). Asegurar que llegue al PR |
| F-07, F-08, F-09 (NIT) | No verificables aquí (docs sin commit) | En 5e8edd7 siguen igual: `0038:16` cita `scripts/facebook-ai-policy-rollback.sql` (no existe); `ai-core.md:167` sin cambio |

## Verificado como correcto (pasada adversarial nueva)

- Render del sitio editado con IA: todo texto y atributo pasa por `esc` (`website/design.ts:329-381`); paleta/variantes validadas; `factViolations` (`design.ts:179-191`) y la exención `ownerTexts` solo cubre textos ya publicados por el dueño (`design.ts:501-531`), que igualmente se escapan al renderizar.
- `set_image` de biblioteca: `ASSET_ID` + `media.get` anti-oráculo por negocio (`media/service.ts:113-116`); fotos a Meta solo de la biblioteca del negocio (`media/service.ts:143-152`, `tenantScope`).
- Edición con IA desde el chat: enlace de la propuesta a la solicitud acotado al negocio (`site-proposals.ts:127-128`, UPDATE con `tenant_id`), vistas de jobs por negocio (`conversation-routes.ts:61-64` `aiJobViews`), cabecera `X-AI-Lab-Grant` validada y grant revalidado sin caer al rollout (`conversation-routes.ts:129-130`, `jobs.ts:99-111`), avisos de jobs por negocio (`telegram.ts:797-800`). Todos los roles con `conversation.send` tienen `ai.generate` (`rbac/matrix.ts:93-124`): el chat no escala permisos (acoplamiento implícito).
- Telegram (código ajeno): publicar/programar una publicación exige `social.approve`+`conversation.confirm`+`operation.approve` (+`social.schedule`) y la referencia mostrada (`telegram.ts:921-928,951`); el texto de un borrador no se edita después de crearse (sin `UPDATE … text`); cambios web solo propios (`telegram.ts:451-455,1027-1031`); HTML escapado y enlaces solo construidos por el servidor (`telegram-ui.ts:179,381-384`); chat simulado solo fuera de producción y ligado a la persona en sesión (`engagement-routes.ts:298-345`).
- FB-2 duplicados acotados a negocio y publicación, solo comentarios anteriores (`service.ts:470-480`); la ingesta solo guarda comentarios de publicaciones de MainSpot (`engagement/worker.ts:181-188`).
- SEC-CONSENT-01 de `auto_suggest`: consentimiento explícito con versión vigente, medidor requerido (`service.ts:431-446`), trigger de huella y append-only (`0038:66-80`), vigencia recalculada al leer (`service.ts:411`).
- Migraciones: reversiones 0038/0039/0040 bloquean con datos propios (configuraciones/valores/reservas; `lab_experiment`; reservas no `legacy`) y sus pruebas G-MIG pasan. 0032/0033 (numeradas por debajo de 0034–0037 ya aplicadas) se aplican después en BD existentes porque el runner aplica todo archivo no registrado en orden (`scripts/migrate.ts:34-44`); son aditivas.

## Decisiones del propietario implicadas (no son defectos)

- Desde be81f60 toda evaluación de una ruta de pago necesita `lab_experiment` (sin valor sembrado; monto OPEN en DEC-0078): hasta que se fije no hay evaluaciones con proveedor real (consola o `scripts/ai-eval.ts`) ni, por tanto, PASS real para aprobar rutas fuera del laboratorio.
- G-04 (HMAC del request id) y la redacción del término de `auto_suggest` (G-01) dependen del propietario.

## Comandos ejecutados (worktree review-2, `DATABASE_URL=…/mainspot_review2`, `TEST_DATABASE_URL=…/mainspot_test_review2`, `APP_ENV=test`)

| Comando | Resultado |
|---|---|
| `node scripts/test-prep.ts` | BD de prueba recreada (varias veces) |
| `npx tsc --noEmit -p .` | exit 0 |
| `node --test --test-concurrency=1 tests/unit/*.test.ts` | 208/208 |
| `node --test --test-concurrency=1 tests/integration/*.test.ts` (dos ejecuciones, cada una tras test-prep) | 364/364 (164 s) y 364/364 (158 s) |
| `node --test --test-concurrency=1 tests/smoke/*.test.ts` | 5/5 |
| Sondas pasada 2 `tests/probes/q0{1,3,4,5}*.probe.test.ts` (BD recién preparada) | 14/14 |
| Sonda `tests/probes/q06-link-comment-spend.probe.test.ts` | 1/1 |
| Sondas de la pasada 1 copiadas (`tests/probes/p0*.probe.test.ts`) | 3 pasan (P01 control, P02 ×2: F-02 sigue); 5 fallan como se espera porque los defectos F-01, F-03, F-04, F-05 ya no se reproducen |
| `git show <commit>:…` + `sha256sum` (122e74d / d573cdf / 5e8edd7) | `05f7ada8…` / `8fcfcc76…` / `5a115a0d…` |

Sondas (sin commit): `q01` anonimización y clave del libro (Telegram, AI Core, reentrega), `q03` evaluaciones e informes,
`q04` heurística de enlaces y ReDoS, `q05` 429/502 y fallo lanzado en el camino automático, `q06` gasto por un comentario con
enlace en `auto_suggest`; `p01`–`p05` de la pasada 1 re-ejecutadas.

## Límites

- Sin E2E de navegador ni proveedores reales (TypeSafe/Anthropic interceptados); nada aquí acredita facturación real.
- F-02, F-07…F-09 son documentales y no están en el snapshot; F-06 está en otra rama.
- G-07 por lectura de código (no se simuló la caída). La política de reintentos de Telegram (cuántas reentregas) no se verificó [INFERENCE]; el costo de G-04 queda acotado por el tope diario.
- El diff ajeno (~9 600 líneas) se revisó por rutas de seguridad (render, aislamiento, RBAC, Telegram, Meta, chat→IA), no línea a línea.
- Si producción activa Jev o qué valor tendrá `lab_experiment` es desconocido [INFERENCE].
