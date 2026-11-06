# Informe — cotas técnicas de los caminos de IA excluidos de `ai_review_replies` (Facebook y laboratorio)

- Redactado por: anthropic/claude-opus-5-5 (subagente `CostBoundsFbLab`), 2026-11-05.
- Base: `b809510`. Worktree propio `/home/administrador/codeart/mainspoot/mainspot-platform-gov-costbounds`, rama `wip/gov-cost-bounds-20261105`, sin commits. `src/` sin cambios (`git status`: solo `?? tests/integration/ai-cost-bounds.test.ts`).
- Prueba: `tests/integration/ai-cost-bounds.test.ts` (588 líneas, sha256 `c6b8410f57675c6f76321619335053dec27ae69c784441f890aa0af9ce568603`).
- BD desechable propia `mainspot_test_costbounds` (contenedor `mainspot-governance-pg-20261105`, `127.0.0.1:55498`).
- **Todo es SIMULADO.** TypeSafe/Jev = MockJev; Anthropic = respuesta en memoria (fetch interceptado en todo el archivo; `api.anthropic.com` responde un JSON fijo y cualquier otro destino externo lanza error y se registra; el `after` exige cero salidas). Clave `ANTHROPIC_API_KEY` ficticia solo durante el archivo. Ningún proveedor real, ningún cobro, ninguna red. Los costos son estimados con el precio sembrado (`an:claude-haiku-5-5`: 0.1/0.5 USD por MTok, `src/ai/catalog.ts:86`), no facturas.
- AC citados, verificados en solo lectura en el canon del worktree de integración (commits 8940101 + f6f1346 según el principal): FR-0016 AC-16011 (`.canonflow/canon/functional/items/FR-0016.md:84`), NFR-0006 AC-6004/AC-6005 (`NFR-0006.md:49-50`), FR-0019 AC-19005 (`FR-0019.md:63`). No edité nada en ese worktree.

## Resultados ejecutados

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | exit 0, sin diagnósticos |
| `node scripts/test-prep.ts && node --test --test-concurrency=1 tests/integration/ai-cost-bounds.test.ts` | tests 7 · pass 7 · fail 0 (1.11 s) |
| Mismo archivo re-ejecutado sin `test-prep` (BD ya usada) | tests 7 · pass 7 · fail 0 (re-ejecutable) |
| `npm run test:integration` (suite completa, worktree) | tests 277 · pass 277 · fail 0 (121 s; línea base 270 + 7 nuevas) |

Estado compartido tras cada ejecución (consultado por `psql`): `bud_lab_total` 25 y `bud_tenant_day_default` 1 intactos (fuente y autor originales), 0 rollouts fuera de `test`, 0 filas de fixture TypeSafe, 0 invocaciones `running`, las rutas creadas por la prueba quedan `RETIRED`.

**No tautológicas (mutantes en una copia desechable `/tmp/cb-mut`, ya borrada; el `src/` del worktree no se tocó):**

| Mutante | Cambio | Pruebas que fallan |
|---|---|---|
| M1 | `dispatcher.ts:261` reserva = 0 (sin presupuesto) | (b) tenant_day, (c), (d) grant válido, (d) techos globales |
| M2 | `service.ts:349` Facebook pasa por `meteredReply` (cuota) | (a), (b) tenant_day, (c) |
| M3 | `classifier.ts:100` sin límite por hora | (c) |
| M4 | `lab.ts:190` laboratorio habilitado en todo entorno | (d) rechazos (el 403 persiste por `grant_environment`; falla el motivo auditado esperado `lab_disabled`) |
| M5 | `dispatcher.ts:555` sin tope diario TypeSafe | (b) TypeSafe, (d) techos globales |
| M6 | `lab.ts:217` revocación no revalidada | (d) rechazos, (d) grant válido |

## Cómo se acota hoy cada camino (código leído)

- **Despacho único** `src/ai/dispatcher.ts:169-282` (`begin`): grant de laboratorio revalidado antes de replay o gasto (176-185); replay aislado por grant/usuario (164-167, 187-197); ruta (213-237; un pin DRAFT no ejecuta, 234-237); política de datos (241-255); circuito (256-259); **reserva** `reserve = paid ? route.max_cost_usd : 0` (261) bajo `reserveBudget` en la MISMA transacción que la fila `running` (262-276); si no cabe ⇒ fila `blocked` con `error_code='budget_exhausted'` y `validation.detail=<ámbito>` y retorno sin proveedor (242-251, 277-280). Sin respuesta final de un proveedor de pago el costo queda `NULL` y la reserva sigue contando (294-297).
- **Presupuestos** `src/ai/governance.ts:52-79`: candado consultivo global (53); ámbitos `lab_total` (acumulado, todas las invocaciones de pago de cualquier entorno: 62-66 + `SPENT_SQL` 44-46), `platform_month` (67-71; **sin fila sembrada**), `tenant_day` (72-76; prefiere la fila propia del negocio sobre la por defecto, 58-61); `spent + reserva > límite` ⇒ denegado (77-78). Solo cuentan `anthropic|openai|openrouter` (24). Semilla `bud_lab_total`=25 y `bud_tenant_day_default`=1 en `src/ai/catalog.ts:359-363` (solo vía `scripts/db-setup.ts:46` / `scripts/test-prep.ts:43`). Edición: `PUT /api/platform/ai/budgets/:scope` solo `platform_admin` con step-up, `lab_total ≤ 25` (`src/api/platform-routes.ts:46,258-270`).
- **TypeSafe/Jev DEC-0032** `src/ai/dispatcher.ts:516-526,551-556`: antes de clasificar, `spentOn(día UTC) < límite` (en pruebas límite 1 por `jev.mode='disabled'`, 553); `spentOn` suma clasificaciones, evaluaciones y `ai_invocation` TypeSafe del día (`src/conversation/jev-repository.ts:222-234`). Comprobación sin reserva.
- **Facebook** `src/engagement/service.ts:313-414` (`classifyCase`): lectura Jev (318-328, clave `case:<id>:read`, `src/engagement/ai-semantics.ts:85-94`); sin lectura ⇒ revisión humana `semantic_*` (336-338); `aiEligible` = lectura Jev y no teléfono (343); **comentario de Facebook ⇒ `semantics.reply` directo, sin cuota** (346-349; clave fija `case:<id>:reply`, `ai-semantics.ts:100-111`); reseña de Google ⇒ `meteredReply` con `ai_review_replies` (350-357, 419-468). Fallo/bloqueo de la IA ⇒ texto seguro `autoReplyText` o borradores `humanDrafts` (363, 374-375; `src/engagement/classifier.ts:105-145`). «Redactar con IA» a pedido no existe para Facebook: 409 (`service.ts:492-494`). Ni `src/ai/*`, ni `src/api/ai-routes.ts`, ni `ai-semantics.ts` usan `QuotaLedger` (grep: solo el helper `resolveIdempotencyKey`, `ai-routes.ts:14`).
- **Límite por hora** `max_auto_replies_per_hour` 1–60, 10 por defecto (`service.ts:237-241`; CHECK en `migrations/0017_engagement_agent.sql:17`); conteo de `auto_reply` del origen en la última hora (`service.ts:332-335`) ⇒ `rate_limited` (`classifier.ts:100`). El worker clasifica en serie bajo candado consultivo por negocio (`src/engagement/worker.ts:88-95,242-250`).
- **Laboratorio** `src/ai/lab.ts`: `enabled = environment === 'lab'` (190); emisión solo `platform_admin|ai_engineer` (29, 272-274) con step-up (`platform-routes.ts:417`; `src/platform/auth.ts:26,505-508`), negocio activo, usuario con membresía y permisos vigentes (305-325), allowlist texto Anthropic / imagen OpenAI no retirada (28, 144-151, 314-317), una ruta por caso de uso (318-322), 5–120 min (24, 302-303), motivo 10–500 sin datos de otros negocios (299-301); `check` en cada uso: entorno, revocación, caducidad, negocio, usuario, estado, membresía, permisos, emisor, caso de uso y ruta (210-236). Inmutabilidad del grant salvo revocación única y allowlist inmutable (`migrations/0031_ai_manual_lab.sql:8-61`). `/ai/lab/replies` (`src/api/ai-routes.ts:169-194`): `requireLab` con auditoría `ai.lab.invoke` deny (85-92), clasificación por ruta normal y generación `manual_lab` con el grant en el contexto (93-96, 180-187), `budget_exhausted` ⇒ 429 `limit_exceeded` (97-104); nada se publica (`published:false`). Jobs revalidan el grant antes de cada intento (`src/ai/jobs.ts:85-87,153-162`). Las invocaciones `manual_lab` pasan por la MISMA reserva (`dispatcher.ts:261-280` no distingue `assignment`).

## Matriz camino → control → evidencia → veredicto

| # | Camino | Control | Evidencia (código y prueba) | Veredicto |
|---|---|---|---|---|
| 1 | Facebook: relación con `ai_review_replies` | Ruta de Facebook sin libro de cuotas | `service.ts:346-349`; prueba (a) `ai-cost-bounds.test.ts:328-356`: cuota 0 y revisión sin parámetro (`plan_piloto_1`) ⇒ el comentario trae propuesta de IA, `quota_reservation`=0 filas, 0 eventos `quota.*`, única decisión `engagement.ai_reply` es la de la reseña de Google (403 `limit_exceeded`) | ACOTADO (fuera de la cuota, R4) |
| 2 | Facebook: redacción con IA (pago) | Reserva `ai_budget` antes de invocar; `tenant_day`/`lab_total`; bloqueo trazado | `dispatcher.ts:261-280`, `governance.ts:52-79`; prueba (b) `:358-404`: con `tenant_day`=costo máximo, 1.ª redacción reserva 0.01 y gasta su costo estimado; 2.ª y 3.ª ⇒ filas `blocked budget_exhausted tenant_day` con su clave de caso, 0 llamadas nuevas, borradores sin IA y respuesta automática con el texto seguro (sin aviso de IA) publicada; «Redactar con IA» a pedido 409 | ACOTADO en costo (ver HUECO-FB-1/FB-2/FB-3) |
| 3 | Facebook: lectura Jev | Tope diario TypeSafe DEC-0032 | `dispatcher.ts:523-526,552-556`; prueba (b) TypeSafe `:406-419`: con el día en el tope ⇒ lectura `failed budget_exhausted`, caso `human_review semantic_unavailable`, 0 redacciones, 0 llamadas | ACOTADO (con HUECO-TS-1 por concurrencia) |
| 4 | Facebook: publicación automática | `max_auto_replies_per_hour`, ventana móvil | `service.ts:332-339`, `classifier.ts:100`; prueba (c) `:421-462`: límite 2 ⇒ 2 `auto_reply` publicadas con aviso de IA y 2 `rate_limited` sin publicar; 0 y 61 ⇒ 400; con la hora vencida vuelve a salir sola | ACOTADO (publicación). Conforme a AC-16011: «ese máximo limita la publicación, no la redacción ni el gasto»; el gasto lo acota el presupuesto (fila 2) |
| 5 | Laboratorio: emisión | Roles, step-up, allowlist, membresía, caducidad, motivo, entorno | `lab.ts:294-337`, `platform-routes.ts:417-427`; prueba (d) `:464-514`: ruta simulada ⇒ 400; sesión sin step-up vigente ⇒ 403 `step_up_required` y 0 grants; (cobertura previa: `tests/integration/ai-manual-lab.test.ts:109-196`) | ACOTADO |
| 6 | Laboratorio: uso del grant | Revalidación en servidor en cada uso, auditada | `lab.ts:210-236`, `ai-routes.ts:85-92`, `dispatcher.ts:176-185`; prueba (d) `:464-514`: sin cabecera, id inexistente, caducado, revocado, otro entorno, otro negocio, otro usuario, caso de uso fuera de la allowlist y API con `AI_ENVIRONMENT=test` ⇒ 403; motivos auditados exactos; 0 invocaciones, 0 llamadas, 0 cuotas | ACOTADO |
| 7 | Laboratorio: presupuesto del negocio | Misma reserva `tenant_day` | prueba (d) `:516-556`: grant válido ⇒ 200 `manual_lab` con grant, reserva 0.01, gasto del día = su costo; siguiente ⇒ 429 y fila `blocked budget_exhausted tenant_day manual_lab`; revocar ⇒ 403 sin nuevas invocaciones | ACOTADO |
| 8 | Laboratorio: techos globales | `lab_total` (DEC-0068) y TypeSafe | prueba (d) `:558-588`: `PUT /ai/budgets/lab_total` (platform_admin, step-up) al gasto acumulado ⇒ 429 `blocked lab_total` con el negocio sin gasto; tope TypeSafe ⇒ 429 en la clasificación, sin generación; 0 llamadas | ACOTADO |
| 9 | Laboratorio: libro de cuotas | Sin `QuotaLedger` en `/ai/lab/replies` | `ai-routes.ts:169-194`; pruebas (d): con `ai_review_replies`=0 el laboratorio redacta una respuesta a reseña y el libro queda en 0 filas/0 eventos; `/engagement/ai-replies` usage 0 | ACOTADO |
| 10 | Laboratorio: solo entorno `lab` | `enabled = environment === 'lab'` | `lab.ts:190,211`; prueba (d): el mismo grant válido en la API `test` ⇒ 403 `lab_disabled` | ACOTADO en sentido literal; HUECO-LAB-1 para habilitación pública |
| 11 | Global: existencia de los techos | Filas `ai_budget` | `governance.ts:57-78` (sin fila no hay límite); semilla fuera de migraciones (`catalog.ts:359-363`, `scripts/db-setup.ts:46`) | HUECO-GLOBAL-1 |
| 12 | Global: tope TypeSafe concurrente | Comprobación previa sin reserva | `dispatcher.ts:552-556`; documentado como V2-GAP-07 (`docs/research/plan-parameters-inventory.md:511`) | HUECO-TS-1 (no reproducido) |

## Huecos (ninguna corrección aplicada; decide el agente principal / el propietario)

### HUECO-LAB-1 — el laboratorio queda habilitado por omisión y es el único entorno con IA real · ALTA para habilitación pública (latente: producción NO-GO)
- Evidencia: `AI_ENVIRONMENTS = ['lab','test']` y omisión `'lab'` (`src/shared/config.ts:27,310`); sin guarda ligada a `APP_ENV`; `AiLab.enabled = environment === 'lab'` (`src/ai/lab.ts:190`); `test` solo tiene rutas simuladas (`src/ai/catalog.ts:315-324,376-386`), así que cualquier despliegue con IA real corre con el laboratorio activo. Ya inventariado como «no existe entorno de producción» (`docs/research/plan-parameters-inventory.csv:95`).
- Reproducción (sin BD ni red): `env -u AI_ENVIRONMENT APP_ENV=production node --input-type=module -e "…loadConfig({}, {requireJwtSecret:false}) … new AiLab({…environment}).enabled"` ⇒ `{"appEnv":"production","aiEnvironment":"lab","aiRealProviders":false,"labEnabled":true}`.
- Mitigación vigente: emitir exige plataforma con step-up y cada uso revalida (filas 5-6); sigue acotado por presupuestos (filas 7-8).
- Propuesta de bloqueo: (1) `src/shared/config.ts` `loadConfig` (junto a la línea 310): con `appEnv === 'production'`, exigir `AI_ENVIRONMENT` explícito y rechazar `lab` al arrancar (fail-closed); (2) defensa en profundidad en `src/ai/lab.ts` constructor de `AiLab` (190): `enabled = environment === LAB_ENVIRONMENT && appEnv !== 'production'`, pasando `appEnv` desde `src/api/server.ts:222` y `src/ai/dispatcher.ts:102`. Un entorno de IA de producción distinto de `lab` es decisión aparte del propietario.

### HUECO-GLOBAL-1 — sin filas `ai_budget` la reserva no limita (fail-open) · MEDIA (bloqueante para habilitación pública)
- Evidencia: `reserveBudget` solo añade límites que encuentra (`src/ai/governance.ts:57-78`); los techos se siembran en `ensureAiCatalog` (`src/ai/catalog.ts:359-363`), que ejecutan `scripts/db-setup.ts:46` y `scripts/test-prep.ts:43`, no las migraciones ni el arranque del servidor. Ya inventariado (V4-INC-21, `docs/research/plan-parameters-inventory.md:421`).
- Reproducción (transacción con ROLLBACK sobre `mainspot_test_costbounds`): `reserveBudget(client, tenant, 2)` con las filas ⇒ `{"allowed":false,"exceeded":"tenant_day"}`; tras `DELETE FROM ai_budget` en la misma transacción ⇒ `{"allowed":true,"limits":[]}`; después del ROLLBACK quedan las 2 filas.
- Propuesta de bloqueo: `src/ai/governance.ts` `reserveBudget`: si falta `lab_total`, o la invocación es de un negocio y no resuelve ninguna fila `tenant_day`, devolver `{ allowed:false, exceeded: <ámbito ausente> }` (sin valores nuevos); opcionalmente verificar al arrancar (`createApp`) que existen `bud_lab_total` y `bud_tenant_day_default`.

### HUECO-FB-1 — la redacción con IA de comentarios de Facebook no está condicionada por permiso, consentimiento ni elegibilidad · MEDIA
- Evidencia: `aiEligible` no consulta la política (`src/engagement/service.ts:343`); todo comentario leído por Jev se redacta con IA (346-349) para cualquier negocio activo, también sin política (por defecto `review_required`, 199-205) y con riesgo detectado. Prueba (a): sin política, el comentario trae propuesta de IA. El único freno es técnico (`tenant_day` y `lab_total`), no un permiso ni una política por canal (R4: «controles técnicos de costo, permisos y futura política por canal»). Antecedente: `evidence/commercial-quota/f3-independent-review.md:106-108`.
- Propuesta de bloqueo (habilitación pública): `src/engagement/service.ts` `classifyCase`, rama `row.origin !== 'google_review'` (347-349): redactar con IA solo si `decision.decision === 'auto_reply'` (respuesta automática consentida y ya limitada por hora) hasta que exista la política por canal; los casos de revisión humana conservan los borradores sin IA. Cambia comportamiento fijado por `tests/integration/commercial-quota.test.ts:411-423` y por esta prueba ((a) y la aserción de 4 llamadas en (c)).

### HUECO-FB-2 — `max_auto_replies_per_hour` acota la publicación, no el gasto de IA · INFORMATIVO (conforme al canon)
- Evidencia: la decisión `rate_limited` (`classifier.ts:100`) no evita `semantics.reply` (`service.ts:346-349`). Prueba (c): 4 comentarios con límite 2 ⇒ 4 llamadas al proveedor y 4 reservas, 2 publicaciones; la aserción `provider.calls === calls0 + 4` fija el comportamiento actual.
- Estado: AC-16011 ya lo recoge (`FR-0016.md:84`: «ese máximo limita la publicación, no la redacción ni el gasto»), así que no es una desviación del canon; el gasto queda acotado por el presupuesto técnico (prueba (b)). Si el propietario quiere que el máximo por hora también limite la redacción, es una decisión nueva; el punto de cambio sería `service.ts:346-349` (omitir la redacción cuando `decision.reason === 'rate_limited'`), o la propuesta de FB-1, que lo cubre.

### HUECO-FB-3 — presupuesto diario compartido: un flujo de comentarios (o una sesión de laboratorio) puede agotar la IA del negocio ese día · BAJA (disponibilidad, no costo)
- Evidencia: `tenant_day` filtra por negocio, no por caso de uso (`governance.ts:72-76`); prueba (b): el gasto de Facebook agota el día; prueba (d): la invocación de laboratorio cuenta en el mismo `tenant_day`.
- Propuesta: si el propietario lo decide, un ámbito por caso de uso u origen (mecanismo en `governance.ts`); valores OPEN (no los fija este informe).

### HUECO-TS-1 — tope TypeSafe sin reserva (comprobar y luego gastar) · BAJA (conocido, no reproducido)
- Evidencia: `dispatcher.ts:552-556` (y el libro en memoria del pipeline); V2-GAP-07 (`docs/research/plan-parameters-inventory.md:511`). Varias clasificaciones concurrentes pueden rebasar el tope por la suma de lo que estaba en vuelo. No lo reproduje (requiere concurrencia con costo real).
- Propuesta: reserva bajo candado consultivo como `reserveBudget` (fila `running` con importe provisional) antes de llamar a TypeSafe.

### Observaciones (no huecos)
- `lab_total` aplica a toda invocación de pago de cualquier entorno (`governance.ts:62-66`): hoy es el techo global efectivo (25 USD acumulados); no hay fila `platform_month`.
- La reserva es el costo máximo de la ruta (0.01 en respuestas, `catalog.ts:306`) y el costo real la sustituye al terminar. [INFERENCE] Con Haiku y `max_tokens` 1600 el costo real por respuesta queda por debajo de la reserva; un costo real superior a la reserva podría rebasar un techo en esa diferencia (no observado).

## Límites y notas de integración
- Simulado de punta a punta (ver encabezado). No acredita entrega real de Meta, costos facturados ni calidad.
- Entorno de rollout propio `cb_<uuid>` para la ruta de pago de Facebook (cast a `AppConfig['aiEnvironment']` en `ai-cost-bounds.test.ts:228`): no toca los rollouts compartidos `lab`/`test`. En `lab` la prueba activa temporalmente una clasificación simulada de reseñas y la restaura/borra en `after` (`:138-166`).
- SEC-CONSENT-01: cuando `setPolicy` exija `consent_version`, ajustar el único punto `facebookAutoPolicy` (`ai-cost-bounds.test.ts:289-292`).
- Ventana diaria: `tenant_day` usa `date_trunc('day', now())`; una ejecución que cruce medianoche podría desalinear (igual que `ai-core.test.ts`).
- Fixtures que la API no emite, insertadas por SQL y retiradas: grant caducado y grant de otro entorno (`:301-309`), gasto TypeSafe del día (`:200-210`, borrado en `finally`), `tenant_day` propio de los negocios de prueba (`:191-194`).
