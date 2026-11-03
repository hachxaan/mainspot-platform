# 01 — Inventario de capacidades y estado técnico real del MainSpot AI Core

Fecha de consulta: 2026-11-03. Autor: subagente `RepoInventory` (investigación, sin implementación).
Entregable 01 del handoff `research/ai-provider-economics/HANDOFF.md` (§3, §5.1).

Convenciones de etiquetado (obligatorias en todo el documento):

- **HECHO VERIFICADO** — leído directamente en el archivo/commit citado (`archivo:línea`) o en la salida de un comando ejecutado aquí.
- **MEDICIÓN PROPIA** — dato extraído de `evidence/ai-core/*.json` o `lab-e2e.txt` (mediciones históricas del laboratorio del 2026-10-30, OpenRouter + TypeSafe reales, negocio sintético). No son producción.
- **ESTIMACIÓN** — cálculo propio con fórmula explícita.
- **HIPÓTESIS / DESCONOCIDO** — lo que no pudo verificarse.
- **SNAPSHOT EXTERNO** — observado en el checkout de SOL MAIN (`mainspot-platform`, working tree sin commit) el 2026-11-03; no forma parte del worktree de investigación y puede cambiar.

Ningún número de este documento proviene de llamadas nuevas a proveedores (prohibido por el encargo). No se consultó la base de datos.

---

## 0. Snapshot del worktree de investigación

| Dato | Valor | Etiqueta |
|---|---|---|
| Worktree | `/home/administrador/codeart/mainspoot/mainspot-ai-research` | HECHO VERIFICADO (`git log`) |
| Rama | `research/ai-provider-economics-2026-11` | HECHO VERIFICADO |
| HEAD | `83e7ee2` «research(ai): integrate measured token profiles into lab-history (from LabEvidence)» — la rama avanzó desde que este borrador se escribió en `d440e2a` (entregables de investigación: `evidence/lab-history.md`, `evidence/{anthropic,openai,openrouter,text-models-benchmarks}.md`). Las referencias de código de este documento apuntan al árbol del commit de partida, que no cambió. | HECHO VERIFICADO (re-observado 2026-11-03T08:28Z) |
| Commit de partida (código) | `73271a2` «canonflow(hdc): publish QS-0017 … PENDING (RUN-0022)» → padre `cf70bc1` «feat(ai-core): lab E2E with real providers…» | HECHO VERIFICADO |
| Working tree | contiene los entregables de esta investigación sin commit (`research/ai-provider-economics/*` y `evidence/` de la rama) — estado esperado de la rama de investigación, no un árbol limpio | HECHO VERIFICADO (re-observado 2026-11-03T08:28Z) |
| Tamaño del AI Core | `src/ai/*.ts` + `providers/*` = 3 064 líneas; `src/jev/client.ts` 382; `src/engagement/ai-semantics.ts` 95; `src/conversation/jev-classifier.ts` 709 | HECHO VERIFICADO (`wc -l`) |

En este snapshot **no existen** `src/ai/providers/anthropic.ts`, `openai.ts` ni `migrations/0028_*`: el único adaptador real es OpenRouter (`src/ai/providers/openrouter.ts`) más el simulador y el cliente TypeSafe (`src/jev/client.ts`). Las integraciones directas Anthropic/OpenAI **ya están commiteadas en SOL MAIN** (re-observado 2026-11-03T08:28Z: commits `36af79c` y `1f1c7da` con DEC-0073; §8).

---

## 1. Cómo funciona una invocación (pipeline real, con referencias)

Fuente: `src/ai/dispatcher.ts` (485 líneas), `src/ai/governance.ts`, `src/ai/registry.ts`, `src/ai/jobs.ts`. Todo HECHO VERIFICADO salvo indicación.

| Paso | Qué hace | Referencia |
|---|---|---|
| 1. Idempotencia | Busca `ai_invocation` por `(tenant_id, use_case_id, idempotency_key)`. `succeeded` ⇒ replay sin costo; `running` ⇒ `in_progress`; otro fallo ⇒ error no reintentable con la misma clave. | `dispatcher.ts:123-135` |
| 2. Replay por job | Con `ctx.jobId`, un paso `succeeded` con el mismo `input_sha256` en ese job se reutiliza (nunca se paga dos veces). | `dispatcher.ts:136-143` |
| 3. Caso de uso activo | `ai_use_case.status = 'active'`; si no ⇒ `disabled`. | `dispatcher.ts:145-146` |
| 4. Ruta | `pinnedRouteId` (jobs/evals) o `registry.resolve(useCase, env, key)`: activa o canary por `sha256(useCase:key) mod 100 < canary_percent`. | `dispatcher.ts:148-162`; `registry.ts:36-39, 316-324` |
| 5. Política de datos | `checkDataPolicy`: proveedor `active`; simulado siempre; real solo con `AI_REAL_PROVIDERS=on`, secreto presente, y tenant `synthetic` (o sin tenant = evaluación de plataforma). Tenant `real` ⇒ `tenant_data_real` ⇒ fila `blocked`/`blocked_external`. | `governance.ts:18-30`; `dispatcher.ts:165-177` |
| 6. Circuito | Abierto ⇒ `circuit_open` (reintentable). 5 fallos *retryable* en 60 s abren 30 s. | `dispatcher.ts:60-62, 103-118, 178-181` |
| 7. Reserva de presupuesto | `reserve = max_cost_usd` **solo si `provider.kind === 'openrouter'`** (Jev y simulado reservan 0). Candado `pg_advisory_xact_lock(hashtext('ai_budget_reservation'))`; fila `running` con `reserved_usd` en la misma transacción. Límites `lab_total`, `platform_month`, `tenant_day`. | `dispatcher.ts:183-204`; `governance.ts:43-70` |
| 8. Render | Preámbulo de plataforma fijo + system + plantilla; variables `untrusted` van JSON-codificadas entre delimitadores; variable faltante/sobrante ⇒ `render_error` antes de llamar. | `prompt.ts:14-24`; `dispatcher.ts:271-272` |
| 9. Proveedor con deadline | `timeout = min(params.timeout_ms ?? 60 000, ctx.deadlineMs ?? 300 000)`. | `dispatcher.ts:252-254` |
| 10. Validación | Esquema JSON estricto propio (`schema.ts:48-86`) + `domainCheck` del llamador; ≤ `repair_attempts` (0 o 1) reparaciones con mensaje de corrección. | `dispatcher.ts:275-301`; `registry.ts:50` |
| 11. Registro | `finish()`: `cost_usd` + `cost_source` (`reported` si el proveedor informó `usage.cost`; si no, `estimated` con `estimateCost(pricing, usage)`; `unknown` sin precio; `none` simulado), `usage`, `latency_ms`, `output`, `validation`, `error_code`. | `dispatcher.ts:206-224`; `governance.ts:73-79`; `migrations/0025_ai_core.sql:233-268` |

Los cuatro puntos de entrada son `invokeStructured` (texto + esquema, `:258`), `invokeWithTools` (asistente, `:312`), `invokeImage` (`:393`) e `invokeClassification` (Jev, `:427`).

Ciclo de vida de rutas (HECHO VERIFICADO, `registry.ts:5-7, 196-212`): `DRAFT → TESTED (eval aprobada) → APPROVED (step-up) → CANARY | ACTIVE → RETIRED`; `approve()` exige `TESTED`; una ruta activa reemplazada vuelve a `APPROVED` (destino de rollback). `RouteParams` admite `fallback_route_id` (`registry.ts:25, 179-182`) pero **ningún código del dispatcher lo consume** (grep `fallback_route_id` en `src/` sólo aparece en `registry.ts`): no existe fallback automático entre rutas en este snapshot.

---

## 2. Proveedores y modelos sembrados (catálogo `src/ai/catalog.ts`)

### 2.1 Proveedores (`catalog.ts:49-53`) — HECHO VERIFICADO

| id | kind | base_url | secret_ref | Política declarada |
|---|---|---|---|---|
| `openrouter` | openrouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `provider.data_collection=deny`; solo datos sintéticos (BR-0007) |
| `typesafe` | typesafe | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | Solo texto minimizado de negocios sintéticos (DEC-0019, APR-0002); USD 1/día (DEC-0032) |
| `simulated` | simulated | — | — | Sin salida de datos |

### 2.2 Modelos (`catalog.ts:56-70`) — precios **tal como están sembrados**, no verificados contra fuentes en este entregable

Cabecera del archivo (`catalog.ts:11-14`): precios tomados del catálogo público de OpenRouter el **2026-10-30 10:29 UTC** (`GET /api/v1/models`, `/api/v1/images/models/{id}/endpoints`); TypeSafe observado el 2026-10-20. Son «estimaciones de respaldo»: el costo registrado es el que reporta cada respuesta (`usage.cost`).

| model_id | provider_model | Modalidad | Precio sembrado (USD) | Unidad | Capacidades declaradas | Línea |
|---|---|---|---|---|---|---|
| `or:openai/gpt-6.1-sol` | `openai/gpt-6.1-sol` | text | in 2 / out 10 | por Mtok | structured, tools, sin temperature, ctx 1 050 000, tier high, ZDR Azure | 57 |
| `or:anthropic/claude-sonnet-5.5` | `anthropic/claude-sonnet-5.5` | text | in 2 / out 10 | por Mtok | idem; ctx 1 000 000; ZDR Bedrock/Google | 58 |
| `or:google/gemini-4-argon` | `google/gemini-4-argon` | text | in 2 / out 10 | por Mtok | temperature sí; ctx 1 048 576 | 59 |
| `or:openai/gpt-6-luna` | `openai/gpt-6-luna` | text | in 0.1 / out 0.5 | por Mtok | tier fast; ZDR Azure | 60 |
| `or:anthropic/claude-haiku-5.5` | `anthropic/claude-haiku-5.5` | text | in 0.1 / out 0.5 | por Mtok | tier fast; ZDR Google | 61 |
| `or:deepseek/deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` | text | in 0.045 / out 0.5 | por Mtok | temperature sí | 62 |
| `or:black-forest-labs/flux-3-image-klein` | … | image | 0.009 | por imagen (1K) | 5 ratios; sin ZDR | 63 |
| `or:bytedance-seed/seedream-5-0-flash` | … | image | 0.018 | por imagen | 5 ratios; ZDR Seed | 64 |
| `or:google/gemini-3.1-flash-lite-image` | … | image | 30 | por Mtok de imagen de salida (0.00003/token) | ZDR Google | 65 |
| `or:microsoft/mai-image-2.6-flash` | … | image | 19 | por Mtok de imagen de salida | ZDR Azure | 66 |
| `ts:jev-1.14.0` | `jev-1.14.0` | classification | in 0.042 / out 0 | por Mtok | question_types choice/noul/score | 67 |
| `sim:text`, `sim:image`, `sim:jev-mock` | — | — | {} | — | simulated | 68-70 |

Observación (HECHO VERIFICADO): ningún modelo de imagen sembrado permite medir «costo por imagen» de forma homogénea: dos se cobran por imagen y dos por token de imagen; `estimateCost` (`governance.ts:73-79`) solo multiplica `per_image × usage.images` o tokens × precio, de modo que para Gemini/MAI el costo estimado depende de que el proveedor devuelva `completion_tokens` en `/images` (`openrouter.ts:139`).

### 2.3 Presupuestos sembrados (`catalog.ts:323-327`) — HECHO VERIFICADO

| budget_id | scope | limit_usd | source |
|---|---|---|---|
| `bud_lab_total` | lab_total | 25 | «Autorización del propietario 2026-10-30 (conversación; QS-0016 Q-AI-BUDGET)» |
| `bud_tenant_day_default` | tenant_day | 1 | «Propuesta técnica OPS-0001 (por defecto por negocio y día)» |

TypeSafe no entra en estas reservas: tiene su propio tope diario (`config.jev.dailyBudgetUsd`, DEC-0032) comprobado en `dispatcher.ts:463-471` sumando `ai_invocation` (kind typesafe) + `jev_classification` + `jev_evaluation_run` del día UTC.

---

## 3. Inventario por caso de uso (16 ids de `catalog.ts:29-45`)

Parámetros comunes de texto (`catalog.ts:261`): `TEXT_DEFAULT = { temperature: 0.4, timeout_ms: 90 000, repair_attempts: 1 }`. `temperature` solo se envía si `model.capabilities.temperature === true` (`dispatcher.ts:280`; `openrouter.ts:98`): **para Haiku/Sonnet/Luna no se envía**. `max_tokens` por defecto 4 000 (structured) / 2 000 (tools) si la ruta no lo fija.

«Ruta activa lab» = lo documentado en `docs/architecture/ai-core.md:83-97` (activación hecha desde la consola el 2026-10-30; **no verificable aquí sin BD**, se etiqueta HECHO DOCUMENTADO). `LAB_CANDIDATES` (`catalog.ts:270-283`) son las rutas sembradas en DRAFT. El entorno `test` usa rutas simuladas (`catalog.ts:286-294`: `sim:*`, `temperature 0`, `max_tokens 4000`, `timeout 30 000`, `maxCost 0.01`).

### 3.1 Tabla de configuración de rutas

| # | use_case_id (`catalog.ts`) | Modalidad / riesgo | Esquema (`contracts.ts`) | Ruta activa lab (doc) | Candidatas lab (DRAFT) y params | maxCost USD/llamada |
|---|---|---|---|---|---|---|
| 1 | `conversation.intent.classify` (:30) | classification / medium | `jev-answers/v1` — preguntas `sentiment`, `edit_scope`, `urgency` (`catalog.ts:144-186`) | Jev 1.14.0 | `ts:jev-1.14.0`, `timeout_ms 15 000` (:282) | 0.01 |
| 2 | `conversation.owner.assistant` (:31) | text / high | `owner-assistant/v1` `ASSISTANT_SCHEMA` (`contracts.ts:139-150`); tools: `account_status, website_status, social_posts, attention_cases, activity_metrics, connections_status, brand_facts` | Claude Haiku 5.5 | Haiku, Luna: `max_tokens 1500`, `timeout 60 000`, repair 1 (:277) | 0.03 |
| 3 | `website.initial.design` (:32) | text / medium | `site-design/v1` `DESIGN_SCHEMA` (`website/design.ts:104-141`): theme (mood, paleta 6 hex, fuentes, radius, density), seo, 3-10 bloques `BLOCK_SCHEMA`, ≤4 solicitudes de imagen | Claude Haiku 5.5 | Sonnet (`reasoning_effort low`, maxCost 0.25), Haiku (`medium`), Luna (`medium`): `max_tokens 9000`, `timeout 180 000` (:271) | 0.25 / 0.05 |
| 4 | `website.edit.simple` (:33) | text / low | `site-edit/v1` `EDIT_SCHEMA` (`contracts.ts:38-67`): ≤12 operaciones de 7 tipos, todas las claves requeridas con nulos | GPT-6 Luna | Haiku, Luna: `max_tokens 3000`, `timeout 60 000` (:272) | 0.02 |
| 5 | `website.edit.complex` (:34) | text / medium | `site-edit/v1` (mismo esquema; prompt ampliado `catalog.ts:230`) | GPT-6 Luna | Sonnet (`low`, 0.2), Haiku (`high`), Luna (`high`): `max_tokens 9000`, `timeout 180 000` (:273) | 0.2 / 0.05 |
| 6 | `website.image.generate` (:35) | image / medium | `image/v1` (sin esquema JSON; salida bytes `b64_json`) | — (BLOCKED_EXTERNAL) | Seedream 5.0 Flash (`resolution 1K`), Gemini 3.1 Flash Lite Image, MAI Image 2.6 Flash: `aspect_ratio 16:9`, `timeout 180 000` (:281) | 0.06 |
| 7 | `social.facebook.post.compose` (:36) | text / medium | `social-compose/v1` `COMPOSE_SCHEMA` (`contracts.ts:92-114`): 2-3 variantes, ≤4 hashtags, imagen opcional, slot sugerido, warnings | Claude Haiku 5.5 | Haiku, Luna: `max_tokens 2500`, timeout 90 000 (:274) | 0.03 |
| 8 | `social.facebook.image.generate` (:37) | image / medium | `image/v1` | — (BLOCKED_EXTERNAL) | mismos 3 modelos, `aspect_ratio 1:1` (:281) | 0.06 |
| 9 | `engagement.facebook.comment.classify` (:38) | classification / high | `jev-answers/v1` — `sentiment, category, info_topic, urgency, risk_safety, risk_legal, personal_data, abusive` (`catalog.ts:187-211`) | Jev 1.14.0 | `ts:jev-1.14.0`, timeout 15 000 (:282) | 0.01 |
| 10 | `engagement.google.review.classify` (:39) | classification / high | idem + `rating_stars` como señal aparte en el estado | Jev 1.14.0 | idem | 0.01 |
| 11 | `engagement.facebook.comment.reply` (:40) | text / high | `engagement-reply/v1` `REPLY_SCHEMA` (`contracts.ts:124-131`): reply ≤600, facts_used enum, needs_human, reason | Claude Haiku 5.5 | Haiku, Luna: `max_tokens 800`, `timeout 45 000` (:276) | 0.01 |
| 12 | `engagement.google.review.reply` (:41) | text / high | idem (prompt con cláusula Google `catalog.ts:247`) | Claude Haiku 5.5 | idem | 0.01 |
| 13 | `marketing.campaign.plan` (:42) | text / high | `campaign-plan/v1` `CAMPAIGN_SCHEMA` (`contracts.ts:156-181`): audiencia, canales, presupuesto PROPUESTO MXN, creatividades, KPIs, riesgos, `requires_authorization` | GPT-6 Luna | Haiku, Luna: `max_tokens 3000`, `timeout 120 000`, `reasoning_effort medium` (:278) | 0.03 |
| 14 | `marketing.campaign.creatives` (:43) | text / medium | `social-compose/v1` (reutiliza COMPOSE) | Claude Haiku 5.5 | Haiku, Luna: `max_tokens 2500` (:275) | 0.03 |
| 15 | `business.insights.generate` (:44) | text / medium | `insights/v1` `INSIGHTS_SCHEMA` (`contracts.ts:196-212`): status generated/abstained, ≤5 highlights con métrica origen, ≤3 recomendaciones | Claude Haiku 5.5 | Haiku, Luna: `max_tokens 1500` (:279) | 0.02 |
| 16 | `editorial.calendar.suggest` (:45) | text / low | `editorial/v1` `EDITORIAL_SCHEMA` (`contracts.ts:223-235`): 1-8 ideas fechadas | GPT-6 Luna | Haiku, Luna: `max_tokens 2000` (:280) | 0.02 |

### 3.2 Tabla de controles, integración y estado

Códigos de estado: **GO local** = suite real pasada y ruta activa en lab (doc §5); **BLOCKED_EXTERNAL** = bloqueo por proveedor/política; **NO-GO** = decisión vigente lo impide. Estado tomado de `docs/architecture/ai-core.md:99-109` y `AI-CORE-RESULTS.md:8-14` (HECHO DOCUMENTADO; el estado de BD no se consultó).

| # | use_case_id | Llamador (archivo:línea) | Idempotencia / clave | Reparación y reglas de dominio | Máx. llamadas al proveedor por invocación | Estado (2026-10-30) |
|---|---|---|---|---|---|---|
| 1 | `conversation.intent.classify` | `website/ai-site.ts:181` (paso `classify` del job `website.edit`); eval `evals.ts:285` | `job:<id>:scope:a<attempt>`; ruta fijada al crear el job (`ai-site.ts:99`) | Sin reparación; el `edit_scope` mapea a `website.edit.simple/complex` (`ai-site.ts:27-29, 183-189`); sin lectura ⇒ `layout_complex` (conservador) | 1 llamada lógica; `JevClient maxAttempts 3` en 429/502/503/529 (`dispatcher.ts:443`; `jev/client.ts:42-44, 236-240`) | GO local (8/8). Datos reales: NO-GO en este snapshot (`governance.ts:27`) |
| 2 | `conversation.owner.assistant` | `ai/business.ts:243-245` | `assistant:<key>` del panel (`business.ts:45-46`) | `invokeWithTools`: `maxRounds 4` ⇒ hasta 5 rondas de chat, ≤6 tool calls por ronda, salida de herramienta truncada a 12 000 chars (`dispatcher.ts:357`), última ronda sin herramientas; `domainCheck untracedNumbers` (toda cifra debe salir de una herramienta, `contracts.ts:268-276`); reparación dentro de las rondas restantes (`dispatcher.ts:331-383`) | ≤5 chat completions | GO local (3/3) |
| 3 | `website.initial.design` | `website/ai-site.ts:118-120` (job `website.design`, también desde `website.edit` con scope `redesign` `:187`) | `job:<id>:design:a<attempt>`; replay por `input_sha256` dentro del job | repair 1; `validateDesign` (contraste AA, slots de imagen coherentes, hechos no inventados `website/design.ts:192-203`); tras el diseño, por cada `images[]` (≤4) una `invokeImage`; sin imagen generada ⇒ fotos propias de la biblioteca (`ai-site.ts:148-153`) | ≤2 chat + ≤4 imágenes | GO local (Haiku 3/3; Luna 3/3; Sonnet bloqueado por guardrail) |
| 4 | `website.edit.simple` | `ai-site.ts:189-196` | `job:<id>:patch:a<attempt>` | repair 1; `domainCheck = applyEdit(...).errors` (parche aplicado en seco; `needs_clarification` con `operations: []` devuelve pregunta sin propuesta, `:198-200`) | ≤2 chat | GO local con Luna (5/5); Haiku 0/5 |
| 5 | `website.edit.complex` | idem | idem | idem | ≤2 chat | GO local con Luna (2/2); Haiku 0/2 |
| 6 | `website.image.generate` | `ai-site.ts:129-130` | `job:<id>:img:<slot>:a<attempt>`; replay de imagen devuelve `in_progress` + `invocationId` y el job recupera el asset por `media_asset.invocation_id` (`dispatcher.ts:395`; `ai-site.ts:139-143`) | Sin reparación ni validación semántica; `bytes < 1000` ⇒ `bad_response` (`openrouter.ts:134`); el asset se guarda en biblioteca como `ai_generated` con `generatorModel`, `invocationId`, licencia «Ilustración generada por IA» (`media/service.ts:33-39, 63`; `ai-site.ts:132-136`) | 1 | **BLOCKED_EXTERNAL** (guardrail OpenRouter `provider_account_policy`, HTTP 404 ⇒ `policy_blocked`, `openrouter.ts:37`) |
| 7 | `social.facebook.post.compose` | `ai/business.ts:104-106` (job `social.compose`) | `job:<id>:compose:a<attempt>` | repair 1; `composeViolations` (≤3 emojis, ≤4 hashtags, hashtags fuera del texto, hechos/precios solo confirmados `contracts.ts:246-257`); near-duplicate con publicaciones recientes (`business.ts:108-110`) | ≤2 chat (+1 imagen si `with_image`) | GO local (3/3) |
| 8 | `social.facebook.image.generate` | `business.ts:113-116` (solo si `with_image === true` y el modelo propuso `image`) | `job:<id>:image:a<attempt>` | Como #6, ratio `1:1` | 1 | **BLOCKED_EXTERNAL** |
| 9 | `engagement.facebook.comment.classify` | `engagement/ai-semantics.ts:71-80` | `case:<case_id>:read` | Sin reparación; `toClassification`: riesgos `noul ≥ 0.5` ⇒ flags; riesgos deterministas se **suman** (`ai-semantics.ts:19, 35-58`); sin ruta activa ⇒ `not_configured` (política determinista); fallo ⇒ humano | 1 (×3 intentos HTTP del cliente) | GO local (sentimiento 89 % ≥ 85 %, 0 riesgos omitidos; 16/20 exactos) |
| 10 | `engagement.google.review.classify` | idem (`origin === 'google_review'`) | idem | idem; `rating_stars` en el estado | idem | GO local (idem) |
| 11 | `engagement.facebook.comment.reply` | `ai-semantics.ts:82-94` | `case:<case_id>:reply` | repair 1; `replyViolations`: sin precios/promos no confirmados, sin dígitos de contacto, sin «descuento/reembolso/gratis/compensación» (`contracts.ts:259-263`); `needs_human=true` ⇒ borrador para humano | ≤2 chat | GO local (4/4, incluye inyección) |
| 12 | `engagement.google.review.reply` | idem | idem | idem | ≤2 chat | GO local (4/4) |
| 13 | `marketing.campaign.plan` | `business.ts:318-320` | `marketing.campaign.plan:<key>` | repair 1; `domainCheck`: sin monto del dueño ⇒ `proposed_total_mxn` debe ser null; aprobar el plan **no** autoriza gasto (`business.ts:345-356`, constraint en BD) | ≤2 chat | GO local con Luna (2/2); Haiku 1/2 |
| 14 | `marketing.campaign.creatives` | `business.ts:323-325` (encadenado tras el plan, misma clave) | `marketing.campaign.creatives:<key>` | repair 1; `composeViolations`; si falla, la campaña se guarda con `creatives_status = <code>` (no bloquea el plan) | ≤2 chat | GO local (2/2) |
| 15 | `business.insights.generate` | `business.ts:290-299` | `business.insights.generate:<key>` | **Abstención sin gasto** si `days_with_activity < 7` (`contracts.ts:191`; `business.ts:290-292`); repair 1; `untracedNumbers` sobre summary + highlights | 0 o ≤2 chat | GO local (2/2) |
| 16 | `editorial.calendar.suggest` | `business.ts:365-367` | `editorial:<key>` | repair 1; `domainCheck`: ninguna idea con fecha anterior a `start_date`; se persisten ≤12 ideas | ≤2 chat | GO local con Luna (1/1); Haiku 0/1 (salida no JSON) |

### 3.3 Evaluaciones sintéticas por caso (`src/ai/evals.ts`) — HECHO VERIFICADO

| Suite | Casos | Umbrales |
|---|---|---|
| `website.initial.design` negocios-sinteticos (:88) | 3 (café, taller, estética) | pass_rate 1 |
| `website.edit.simple` ediciones-simples (:96) | 5 | pass_rate 0.8 |
| `website.edit.complex` redisenos (:106) | 2 | 1 |
| `social.facebook.post.compose` (:113) | 3 (incluye «promo inventada» que debe producir warning) | 1 |
| `marketing.campaign.creatives` (:121) | 2 | 1 |
| `engagement.*.reply` (:128) | 4 cada uno (gracias, ironía, inyección, …) | 1 |
| `conversation.owner.assistant` (:137) | 3 (herramientas stub) | 1 |
| `marketing.campaign.plan` (:145) | 2 | 1 |
| `business.insights.generate` (:152) | 2 (abstención + generado) | 1 |
| `editorial.calendar.suggest` (:159) | 1 | 1 |
| `*.image.generate` (:163) | 1 (verifica aspecto con `sharp`, `:244`) | 1 |
| `engagement.*.classify` (:166-167) | 20 | pass_rate 0.8, sentiment_accuracy 0.85, risk_misses 0 |
| `conversation.intent.classify` (:169) | 8 | pass_rate 0.8 |

Una ejecución aprobada marca la ruta `TESTED` (`evals.ts:386`). Las suites miden contrato, fidelidad, límites, costo y latencia; la calidad creativa queda a rúbrica humana (`evals.ts:5-6`).

---

## 4. Mapa de las 11 familias del handoff §3 contra el catálogo

| Familia (§3) | Casos del catálogo que la cubren | Cobertura | Observaciones / PROPUESTA |
|---|---|---|---|
| Generación de imágenes | `website.image.generate`, `social.facebook.image.generate` | **Existe, BLOCKED_EXTERNAL** | Solo `prompt` de texto, `n: 1`, `aspect_ratio`, `resolution` opcional (`openrouter.ts:127-141`). Sin `quality`, sin variantes, sin selección de formato; bytes no se guardan en la traza (`ai-core.md:117-118`). Costo por imagen no reportado uniformemente (§2.2). Capacidad **no demostrada** con ningún proveedor real. |
| Edición/adaptación visual | — | **FALTA → PROPUESTA** | `ImageRequest` (`providers/types.ts:48-54`) no admite imagen de entrada, máscara ni referencia; `media/service.ts` genera variantes responsivas/sociales por recorte y WebP (no IA). Debe registrarse como nuevo caso (p. ej. `website.image.adapt`, `social.image.variant`) con contrato de entrada de asset y política de derechos. |
| Diseño de páginas web | `website.initial.design` (+ `website.image.generate` por cada slot) | **Existe, GO local** | DSL estricto (`design.ts:104-141`), 5-8 bloques recomendados por prompt, ≤4 imágenes; coste medido 0.0011-0.0022 USD/diseño sin imágenes (§6). |
| Edición de páginas web | `conversation.intent.classify` (alcance) → `website.edit.simple` / `website.edit.complex` / rediseño | **Existe, GO local solo con GPT-6 Luna** | El esquema `EDIT_SCHEMA` falló con Haiku/Sonnet vía OpenRouter (`bad_request`); documentado como «17 uniones vs límite 16 de Anthropic» (`ai-core.md:93`). Tasa de parche válido medida: Luna 5/5 y 2/2 (§6). |
| Publicaciones sociales | `social.facebook.post.compose`, `editorial.calendar.suggest` (+ imagen opcional) | **Existe, GO local** | Variantes 2-3, hashtags ≤4, slot sugerido; solo Facebook; sin carrusel ni otras redes. |
| Atención a clientes | `engagement.facebook.comment.reply`, `engagement.google.review.reply` | **Existe, GO local** (eventos Meta/Google reales BLOCKED_EXTERNAL) | Ledger único por destino público (doc FR-0016); `needs_human` obligatorio ante riesgo. |
| Clasificación semántica | `conversation.intent.classify`, `engagement.facebook.comment.classify`, `engagement.google.review.classify` + clasificador de intención del dueño `conversation/jev-classifier.ts` (fuera del catálogo, `JEV_POLICY_VERSION intent-classifier-v3`, gate D4 200 casos / 90 % / 0 fallos de riesgo `:53-63`) | **Existe, GO local (sintético)** | Dos integraciones Jev conviven: catálogo AI Core (preguntas versionadas en prompt) y pipeline conversacional (preguntas en código). Ambas comparten el tope USD 1/día. |
| Asistente del negocio | `conversation.owner.assistant` | **Existe, GO local** | 7 herramientas de solo lectura; sin memoria multi-turno (cada pregunta es una invocación con `today/business/question`, `business.ts:243-244`): el «costo por conversación» del handoff §6 debe modelarse como N invocaciones independientes. |
| Marketing y campañas | `marketing.campaign.plan` + `marketing.campaign.creatives` | **Existe, GO local** | Siempre dos llamadas encadenadas; plan sin gasto por diseño. |
| Análisis de negocio | `business.insights.generate` | **Existe, GO local** | Abstención gratuita con <7 días de actividad; métricas precalculadas por MainSpot (`business.ts:283`), contexto pequeño (`metrics` ≤4 000 chars, `catalog.ts:253`). |
| Orquestación/selección | Parcial: resolución activa/canary (`registry.ts:316-324`), Jev decide el alcance de edición (`ai-site.ts:181-189`), reparación ≤1, circuito | **PARCIAL → PROPUESTA** | No hay fallback entre rutas (`fallback_route_id` sin consumidor), no hay reintento de proveedor en texto/imagen dentro del dispatcher, no hay métrica dedicada de «overhead de orquestación» (el costo de Jev para elegir ruta sí queda en `ai_invocation` como caso #1). Propuesta: tratar «clasificar para enrutar» + «reparación» + «reintento de job» como una familia medible con su propio costo unitario. |

---

## 5. Cómo se calcula y registra el costo; reintentos, circuito y timeouts

Esta sección alimenta el **factor de reintento/fallo/fallback** del modelo económico (handoff §6).

### 5.1 Procedencia del costo (HECHO VERIFICADO)

| Fuente | Regla | Referencia |
|---|---|---|
| OpenRouter texto | `usage.cost` del JSON de `/chat/completions` ⇒ `cost_source = 'reported'`; tokens `prompt_tokens`, `completion_tokens`, `completion_tokens_details.reasoning_tokens` | `openrouter.ts:114-124`; `dispatcher.ts:212-213` |
| OpenRouter imagen | `usage.cost` de `/images` si viene; `images = 1` | `openrouter.ts:139` |
| Sin `usage.cost` | `estimateCost(model.pricing, usage)` = `(in×input_per_mtok + out×output_per_mtok)/1e6 + per_image×images` ⇒ `'estimated'`; sin precio ⇒ `'unknown'` | `governance.ts:73-79`; `dispatcher.ts:214-217` |
| TypeSafe | `JevClient.resultCost`: `usage.cost` reportado, si no tokens × `pricing` (input 0.042/Mtok, output 0) ⇒ `reported`/`estimated`; el dispatcher guarda `res.meta.cost.amount` | `jev/client.ts:270-279`; `dispatcher.ts:443-447` |
| Simulado | 0, `'none'` | `dispatcher.ts:210-211` |
| Replay | 0, `'none'`, `replayed: true` | `dispatcher.ts:474-484` |
| Reparación / multi-ronda | `addUsage` suma tokens y costo de todas las llamadas de la invocación: el costo registrado ya incluye la reparación y las rondas de herramientas | `dispatcher.ts:242-248, 285, 339` |

Columnas de `ai_invocation` relevantes (`migrations/0025_ai_core.sql:233-268`): `reserved_usd`, `cost_usd`, `cost_source ∈ {reported, estimated, unknown, none}`, `usage` JSONB, `latency_ms`, `validation` JSONB (p. ej. `{attempts, errors}` o `{rounds, tools}`), `error_code`, `assignment ∈ {active, canary, pinned, eval}`.

### 5.2 Reservas y techo (HECHO VERIFICADO)

- Reserva = `max_cost_usd` de la ruta, **solo kind `openrouter`** (`dispatcher.ts:183`). Gasto efectivo = Σ `reserved_usd` de `running` + Σ `COALESCE(cost_usd, reserved_usd)` de `succeeded`/`failed` (`governance.ts:35-37`). Consecuencias para el modelo: (a) una invocación fallida con costo registrado cuenta su costo real; (b) una invocación abandonada (`uncertain_abandoned`, `cost_usd` NULL) cuenta **toda la reserva** (`jobs.ts:174-180`); (c) una invocación que falla antes de consumir (p. ej. `timeout` con `usage` 0) registra costo estimado 0 cuando el modelo tiene precio.
- Límites: `lab_total` acumulado histórico, `platform_month` (mes natural), `tenant_day` (por negocio) — `governance.ts:48-69`. `max_cost_usd` por ruta ≤ 2 USD (`registry.ts:177`).
- Jev: tope diario separado (§2.3); si se supera ⇒ `budget_exhausted` con `reason 'DEC-0032'` (`dispatcher.ts:437-440`).

### 5.3 Reintentos, reparación, circuito, timeouts (HECHO VERIFICADO)

| Mecanismo | Valor | Referencia |
|---|---|---|
| Reparación de salida (texto) | `repair_attempts` 0 o 1 (default 1) ⇒ ≤2 llamadas; mensaje «La salida anterior no cumple el contrato…» con ≤12 errores | `dispatcher.ts:275-299`; `registry.ts:50` |
| Rondas con herramientas | `maxRounds` 4 ⇒ ≤5 llamadas; ≤6 tool calls/ronda | `dispatcher.ts:331-347` |
| Reintento HTTP OpenRouter | **Ninguno** en el adaptador ni en el dispatcher: `ProviderError.retryable` (timeout, rate_limited, unavailable, network) se devuelve al llamador como `retryable: true` | `openrouter.ts:69-88`; `types.ts:84-86`; `dispatcher.ts:226-240` |
| Reintento HTTP TypeSafe | 3 intentos en 429/502/503/529, backoff 500 ms·2^n (+20 % jitter), tope 8 s, respeta `retry-after`; deadline total = `timeout_ms` de la ruta (15 s) | `jev/client.ts:42-44, 229-242`; `dispatcher.ts:443` |
| Reintento de job | `JOB_MAX_ATTEMPTS 3`; requeue a +15 s si el error es reintentable; lease 600 s; pasos ya `succeeded` se reutilizan (clave `…:a<attempt>` nueva, replay por `input_sha256`) | `jobs.ts:17-18, 140-149`; `dispatcher.ts:136-143` |
| Invocación huérfana | `running` > 15 min ⇒ `failed` / `uncertain_abandoned`, cada 5 min | `jobs.ts:20-21, 174-180` |
| Circuito | 5 fallos *retryable* en 60 s ⇒ abierto 30 s (`circuit_open`, reintentable); 4xx no abren; éxito limpia el contador | `dispatcher.ts:60-62, 103-118, 229` |
| Timeout por llamada | `min(timeout_ms, deadlineMs ?? 300 000)`; rutas: 15 s Jev, 45 s replies, 60 s edición simple/asistente, 90 s default, 120 s plan, 180 s diseño/edición compleja/imagen; rango válido 2-300 s | `dispatcher.ts:252-254`; `catalog.ts:261-283`; `registry.ts:41` |
| Fallback de ruta | No implementado (`fallback_route_id` sin consumidor) | grep `src/` |
| Políticas 404/402/401 | `policy_blocked` ⇒ `blocked_external` (no reintentable, no abre circuito); `insufficient_credit`/`auth` ⇒ `provider_auth` | `openrouter.ts:34-42`; `dispatcher.ts:230-232` |

Discrepancia documental: `docs/architecture/ai-core.md:29` afirma «429/5xx sí (y se reintentan acotado)»; en el código solo TypeSafe reintenta a nivel HTTP; para OpenRouter el reintento ocurre únicamente a nivel de job (3 intentos) o lo asume el usuario. Ver §9.

### 5.4 Fórmula propuesta del factor de reintento (ESTIMACIÓN; parámetros a medir)

Para un caso de texto estructurado:

```
llamadas_esperadas = 1 + p_repair                      (p_repair = P(1ª salida inválida), repair_attempts = 1)
costo_invocación   ≈ c_llamada × (1 + p_repair × r)    (r = ratio de tokens de la 2ª llamada; incluye el historial, r > 1)
costo_por_éxito    = costo_invocación / (1 − p_fail_inv)   (p_fail_inv = P(invalid_output tras reparación ∪ fallo de proveedor))
job (≤3 intentos)  : los pasos exitosos no se repagan; sólo el paso fallido se reintenta ⇒ factor_job ≈ 1/(1 − p_fail_paso^3) sobre ese paso
imagen             : sin reparación; factor = 1/(1 − p_fail_img)
Jev                : 1 invocación facturada; los reintentos HTTP del cliente no se facturan por separado salvo que el proveedor cobre intentos (DESCONOCIDO)
```

Datos históricos disponibles para poblar `p_repair`/`p_fail` (MEDICIÓN PROPIA, 2026-10-30, OpenRouter): `evidence/ai-core/evals-lab-run1.json` muestra fallos por `invalid_output` (Haiku `editorial.calendar.suggest` «la salida no es JSON»; Haiku `marketing.campaign.plan` `$.budget.rationale longer than 300`), `provider_unavailable: rate_limited` (Haiku `social.facebook.post.compose` run1 → pasó en run2), `provider_unavailable: bad_request` (Haiku `website.edit.*`, 7/7 casos) y `blocked_external: provider_account_policy` (Sonnet e imágenes). Jev: run2 `JevHttpError` en 2/8, 10/20 y 8/20 casos (tras 3 intentos) y run3 `TimeoutError` en 2/20 + 2/20. El campo `validation.attempts` por invocación no se exporta en los JSON de `evidence/ai-core/` (solo `pass`/`notes`); `p_repair` y los tokens de la segunda llamada sí están en `research/ai-provider-economics/evidence/lab-traces.md` (exportación de `ai_invocation` hecha por el integrador; ver §6 y Hueco H3): las cifras de tokens de esa tabla **ya incluyen** la reparación, por lo que al usarlas en la fórmula anterior `p_repair × r` no debe sumarse otra vez.

---

## 6. Evidencia existente en `evidence/ai-core/` (resumen; detalle en el entregable 03)

HECHO VERIFICADO (listado) / MEDICIÓN PROPIA (contenido). Todos los archivos datan del 2026-10-30, `real_providers: true`, entorno `lab`.

| Archivo | Propósito | Contenido resumido |
|---|---|---|
| `evals-lab-run1.json` (27 KB) | Primera corrida de todas las suites sobre todas las candidatas (33 rutas) | Pasan: assistant (Haiku, Luna), replies ×4, campaign.plan (Luna), edit.simple/complex (Luna), design (Haiku, Luna), editorial (Luna). Fallan: Jev ×3 (`provider_auth` — clave revocada, cf. `ai-core.md:70`), imágenes ×6 (`provider_account_policy`), Sonnet ×2 (idem), Haiku edit ×2 (`bad_request`), compose/creatives/insights (reglas de dominio: «cifra sin fuente: 7», «contiene 2x1/30%»), rate_limited ×1 |
| `evals-lab-run2-*.json` (5 archivos) | Re-corrida tras ajustar prompts/clave | insights 2/2 (ambos), creatives 2/2 (ambos), compose 3/3 (ambos); Jev aún con `JevHttpError` parciales |
| `evals-lab-run3-*.json` (3 archivos) | Jev definitivo | intent 8/8 (0.000034 USD/caso, p95 920 ms); comment 16/20 y review 16/20 (0.000046 USD/caso; p95 919 ms y 10 021 ms; 2 timeouts cada una) |
| `lab-e2e.txt` (76 líneas) | Recorrido E2E real por `https://app.mainspot.local.io` (HEAD `878f7de`, negocio sintético «Café Brisa Lab 2e397c») | Diseño Haiku 16 474 ms / USD 0.002224; imágenes `no_active_route`; edición compleja Luna 2 operaciones; etc. Total recorrido USD 0.008954; acumulado lab USD 0.096726 / 25 (`AI-CORE-RESULTS.md:60-61`) |
| `screens/` (21 PNG) | Capturas de consola, diseños de evaluación (café/taller/estética 1440 px), recorrido móvil, sitio v1/v2 | Rúbrica E19 |
| `research/ai-provider-economics/evidence/lab-traces.md` (+ `lab-invocations.csv`, 310 filas; exportado por el integrador el 2026-11-03 desde `ai_invocation`, solo columnas numéricas) | Tokens reales por tarea **incluidas reparaciones**, tasa de reparación, costo y latencia por caso de uso y modelo | MEDICIÓN PROPIA (del integrador; **re-cotejada por esta auditoría el 2026-11-03 contra `evidence/lab-traces.md`: todas las cifras de tokens, tasas de reparación y hallazgos coinciden**): Haiku 5.5 in/out — diseño 4 029/3 396; post 4 424/2 550; respuesta a comentario 1 287/249; asistente 4 729/427; insights 2 135/677. GPT-6 Luna in/out — diseño 1 608/2 033; edición simple 1 735/202; edición compleja 2 202/958; post 1 776/745; respuesta 621/189; asistente 2 096/293. Jev entrada: 804 (intención), 1 158 (comentario/reseña). Hallazgo del integrador: el mismo prompt consume ≈2-2.5× más tokens de entrada en Haiku que en Luna. Tasa de éxitos con 2 intentos: compose 80 % Haiku / 67 % Luna; creatividades 75 % / 50 %; calendario Luna 80 %; insights 50 % / 25 % (`lab-traces.md:14`). Esto cubre el hueco H3 para los casos con datos. |

Costos por caso de uso del recorrido real (`AI-CORE-RESULTS.md:47-58`, MEDICIÓN PROPIA, procedencia `usage.cost` de OpenRouter): diseño 0.002224; edición compleja 0.000542; compose 0.001111; comment.classify 0.000049/llamada; comment.reply 0.000267/llamada; intent.classify 0.000034; assistant 0.000629/llamada; campaign.plan 0.000684; creatives 0.002106; editorial 0.000497 (USD). p95 observados en `ai-core.md:85-96` (0.9 s Jev hasta 23 s diseño).

---

## 7. Lo que el catálogo NO contiene (capacidades ausentes) — PROPUESTA

1. **Edición/adaptación de imágenes existentes** (familia §3 fila 2): ni contrato de entrada ni caso de uso.
2. **Variantes por canal generadas por IA** (carrusel, formatos verticales): `media/service.ts` solo recorta/convierte.
3. **Orquestación como capacidad medible**: no hay caso «router» ni métrica de overhead; el fallback entre rutas no existe.
4. **Conversación multi-turno del asistente**: cada pregunta es independiente (sin historial).
5. **Texto para otras redes** (solo Facebook) y **respuestas a mensajes privados** (solo comentarios/reseñas públicos).
6. **Costo reportado por proveedor directo**: el esquema de costos asume `usage.cost` (OpenRouter); Anthropic/OpenAI directos no lo devuelven (ver §8), por lo que en producción directa **todo costo será `estimated`** y depende de mantener `ai_model.pricing` al día.

---

## 8. SNAPSHOT EXTERNO — SOL MAIN (`mainspot-platform`, solo lectura)

**Dos observaciones:** (a) la original de este inventario —madrugada del 2026-11-03, HEAD `d297e8a` con la integración directa **sin commit** (33 archivos modificados, 1 staged, 7 sin seguimiento)— y (b) la re-verificación de esta auditoría **2026-11-03T08:28Z**, que encontró ese trabajo ya **COMITEADO** en dos commits nuevos y una decisión adicional (DEC-0073) que cambia la selección de proveedor. No se modificó nada en ese checkout; todos los comandos fueron `git --no-optional-locks` de lectura o `sha256sum`/`read`.

### 8.0 Avance de SOL MAIN entre observaciones (HECHO VERIFICADO, `git log`/`git diff --stat`/`git status --porcelain`, 2026-11-03T08:28Z)

| Commit | Fecha (−0500) | Asunto |
|---|---|---|
| `d297e8a` | 2026-11-03 00:41:59 | chore(canonflow): ingest QS-0017 (ANS-0017) as APR-0003, DEC-0066..DEC-0072 (base de la observación original, §8.1) |
| `36af79c` | 2026-11-03 01:35:00 | feat(ai): apply QS-0017 direct providers and verified data policy — **commitea** la integración directa descrita en §8.3 |
| `1f1c7da` | 2026-11-03 03:25:15 | feat(ai): select OpenAI generation for development under DEC-0073 — **nueva decisión**: OpenAI para toda la generación en desarrollo; Anthropic deshabilitado como proveedor (migración `0029_ai_openai_development.sql`); detalle en §8.4 |

Diff acumulado `d297e8a → 1f1c7da`: 105 archivos cambiados, +7 497/−598. Working tree al 08:28Z: limpio salvo dos elementos sin seguimiento (`landingpage/`, `logo.png`).

### 8.1 Commit `d297e8a` (2026-11-03 00:41:59 −0500) — HECHO VERIFICADO vía `git show`

«chore(canonflow): ingest QS-0017 (ANS-0017) as APR-0003, DEC-0066..DEC-0072 via RUN-0023; close ANS-0016 without effect». Registros (resumen literal de los `.md`, no interpretación):

| Registro | Decisión del propietario (2026-11-03T05:27Z) |
|---|---|
| APR-0003 | Aprueba el canon AI Core 0.2.0 (FR-0012..0019, NFR-0006..0008, BR-0007, ARC-0001, DAT-0001, SEC-0001, OPS-0001) ligado a `AI-CORE-CANON-PROPOSAL.md` sha256 `f129b92b…`; gobernanza proporcional; operaciones dentro de autorizaciones vigentes se ejecutan autónomamente. |
| DEC-0066 | Jev (TypeSafe) clasificador semántico primario de **todo** mensaje/evento de texto, con gate de evaluación por pregunta; backend conserva autoridad de identidad/permisos/ejecución. |
| DEC-0067 | TypeSafe puede procesar datos reales (desarrollo y producción) tras verificar **una sola vez** la cobertura contractual; sustituye DEC-0019; mantener aislamiento, minimización, trazabilidad, retención. |
| DEC-0068 | Techo de laboratorio **USD 25 acumulado incluido el histórico**; sin mensualidad ni gasto publicitario; credenciales/controles propios para Anthropic y OpenAI; saldo OpenRouter no transferible; TypeSafe (DEC-0032) separado; registrar costo real/modelo/proveedor/caso distinguiendo estimación de cargo observado. |
| DEC-0069 | TypeSafe directo (Jev); **Anthropic directo prioritario** para texto; **OpenAI directo `gpt-image-2`** para imágenes («en OMP como `openai-codex/gpt-image-2`»; comprobar mecanismo de integración y acceso antes de incorporarlo; OMP ≠ credenciales API); OpenRouter fuera de nuevas ejecuciones y sin fallback; conservar históricos. |
| DEC-0070 | Comportamiento equivalente a producción desde desarrollo; escalar solo excepciones materiales; Meta/Google reales y gasto publicitario mantienen autorización específica. |
| DEC-0071 | Anthropic (texto) y OpenAI (imágenes) pueden recibir datos de negocios reales «con las condiciones de TypeSafe» (verificar una vez términos comerciales/DPA: entrenamiento, retención, subencargados). |
| DEC-0072 | Transcripción íntegra de las notas del propietario (§1-§6); §6 ordena: verificar cobertura TypeSafe, habilitar Jev con datos reales, migrar rutas generativas a Anthropic directo, integrar y evaluar OpenAI para imágenes, repetir E2E. |

### 8.2 Archivos de la integración directa — hashes re-verificados (HECHO VERIFICADO, `sha256sum` 2026-11-03T08:28Z)

Los archivos dejaron de estar sin commit: están en `36af79c`/`1f1c7da`. **Cambiaron desde la observación original** los marcados con ⇄ (nuevo hash tras `1f1c7da`); los demás conservan byte a byte el hash reportado antes.

| Archivo | Estado (08:28Z) | Líneas | sha256 2026-11-03T08:28Z |
|---|---|---|---|
| `src/ai/providers/anthropic.ts` | commiteado; **⇄ cambió** (antes `9884551a…`, 274 líneas) | 287 | `749d288d24c53321f9840697fb0603e9005d4716b092009e2ad0049ca50c100e` |
| `src/ai/providers/openai.ts` | commiteado; **⇄ cambió** (antes `3df8c6dd…`, 255 líneas) | 260 | `21d0bb8626d7b822e455871903cd1b420c34fc94147daedadd96e1e3c3082cee` |
| `migrations/0028_ai_direct_providers.sql` | commiteado; **sin cambio** | 80 | `8ad8c46ce7a96c97de65c2f3996454892a2c6ae37080745f9bf4e55192fff240` |
| `docs/architecture/ai-providers-data-terms.md` | commiteado; **⇄ cambió** (antes `3a710d64…`, 460 líneas) | 472 | `782735135c6cd3da21e817faa90aa581afb0815014076426181a5435211100bf` |
| `src/ai/catalog.ts` | commiteado; **⇄ cambió** (antes `73a54dbf…`; DEC-0073) | — | `f0050c9499d09a70b58765678334e24c117280eb7a7c4b3ca75206ef9e7eaabd` |
| `src/ai/dispatcher.ts` | commiteado; **⇄ cambió** (antes `0c9dda6c…`) | — | `3d9f890d9838cb22fb0f2ed0b217308311910e29d7aa9de79410010cd3cc47ae` |
| `src/ai/governance.ts` | commiteado; **sin cambio** | — | `f7de81e2a8c3ae8f58e74acae665eb33319ada3c40c5878964021a3dc79d8092` |
| `src/ai/registry.ts` | commiteado; **sin cambio** | — | `12736785226aae8ba7e7a40df7bdcdfb359e6aed8925cb0567aee289437f6b8d` |
| `src/ai/providers/types.ts` | commiteado; **sin cambio** | — | `2d5876a1ac4f83eaf0c4f73dfffd8b896247dcfbff9a3f6de87d7c55e350a02d` |
| `src/ai/providers/openrouter.ts` | **eliminado** (comiteado en `36af79c`) | — | — |
| `src/shared/config.ts` | commiteado; **⇄ cambió** (antes `5fa42fee…`) | — | `cbfb37ef96ed5667ee5e750c82610e99135177cc8f6a45117d5eeac403b83932` |
| `src/jev/client.ts` | commiteado; **sin cambio** | — | `224de2179af584df9d9a089d89e8219786430e7ff57c85f8c4647820405cc877` |
| `src/conversation/jev-classifier.ts` | commiteado; **sin cambio** | — | `0a8d68eb70a5285204a9b6860c2126c948605ffb9cab209100fa29b7fc756258` |
| `scripts/ai-eval.ts` | commiteado; **⇄ cambió** (antes `b45911af…`) | — | `0d9faf05a9350f268930d1813a72cef75d891697e0b4e2d52100c107ceb7687f` |
| `src/api/platform-routes.ts` | commiteado; **sin cambio** | — | `581da2d8b40ea82847161312ea0b1105fd8a9384ff8a47dfb69b1d8ecdb123a2` |

**Nuevos desde la observación original** (en `36af79c`/`1f1c7da`, no leídos en detalle aquí): `migrations/0029_ai_openai_development.sql` (47 líneas, §8.4), `src/ai/minimize.ts`, `tests/unit/ai-provider-openai.test.ts` (248), `tests/unit/ai-provider-anthropic.test.ts` (262), `docs/architecture/ai-core.md` (+183 líneas), y evidencia `evidence/ai-core/direct-*` / `openai-development-*` del 2026-11-03 (§8.4).

**Alcance de las afirmaciones de §8.3:** fueron verificadas sobre los hashes **anteriores** (`anthropic.ts 9884551a…`, `openai.ts 3df8c6dd…`, `catalog.ts 73a54dbf…`): describen el estado commiteado en `36af79c`. Tras `1f1c7da` los hashes de `anthropic.ts`, `openai.ts`, `catalog.ts`, `dispatcher.ts`, `config.ts`, `scripts/ai-eval.ts` y `ai-providers-data-terms.md` cambiaron; las semillas re-verificadas sobre el HEAD actual están en §8.4.

### 8.3 Qué siembra/usa la integración directa (estado `36af79c`; HECHO VERIFICADO sobre los hashes de la observación original —los de §8.2 sin ⇄—; **no verificado contra fuentes oficiales en este entregable**)

**Proveedores (`catalog.ts` diff, líneas +56-70):**

| id | kind | base_url | secret_ref | terms_url | real_data |
|---|---|---|---|---|---|
| `anthropic` | anthropic | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `https://www.anthropic.com/legal/commercial-terms` | `allowed`, basis «DEC-0071; docs/architecture/ai-providers-data-terms.md §4 (COVERED_WITH_CONDITIONS)», `terms_verified_at 2026-11-03T06:00:00Z` |
| `openai` | openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `https://openai.com/policies/services-agreement` | idem (DEC-0071) |
| `typesafe` | typesafe | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `https://typesafe.ai` | `allowed` (DEC-0067) |
| `openrouter` | — | — | — | — | **no se siembra**; migración 0028 lo deja `status='disabled'`, retira todas sus rutas y añade `CHECK (kind <> 'openrouter' OR status = 'disabled')` |

**Modelos y precios sembrados (`catalog.ts` diff +86-93; fuente declarada `anthropic_pricing_page` / `openai_pricing_page`, observados `2026-11-03T06:00:00Z`; cabecera: «https://platform.claude.com/docs/en/about-claude/pricing, https://developers.openai.com/api/docs/pricing»):**

| model_id | provider_model | pricing sembrado (USD/Mtok) | Capacidades declaradas |
|---|---|---|---|
| `an:claude-haiku-5-5` | `claude-haiku-5-5` | in 0.1 / out 0.5 | structured_outputs, tools, temperature false, forced_tool_choice true, tier fast; comentario: «Haiku: hasta 100k tokens de prompt» |
| `an:claude-sonnet-5-5` | `claude-sonnet-5-5` | in 2 / out 10 | forced_tool_choice **false**, tier high |
| `an:claude-opus-5-5` | `claude-opus-5-5` | in 4 / out 20 | forced_tool_choice false, tier max |
| `oa:gpt-image-2` | `gpt-image-2` | in 5 (texto) / out 30 (imagen) | ratios 5, quality low/medium/high, `requires_org_verification: true`; comentario: «calidad media 1536x1024 ≈ USD 0.041» |
| `oa:gpt-6-luna` | `gpt-6-luna` | in 0.1 / out 0.5 | alternativa de texto «solo donde Anthropic no alcance la calidad» |

**Rutas candidatas lab (diff +132-142):** diseño → Sonnet (`low`, 0.25) y Haiku (`medium`, 0.05); edición simple → Haiku, Luna (0.02); edición compleja → Sonnet (`low`, 0.2), Haiku (`high`), Luna (`high`); compose/creatives/replies/assistant/insights → Haiku; plan → Sonnet 0.1 / Haiku / Luna 0.03; editorial → Sonnet 0.08 / Haiku / Luna 0.02; imágenes → `oa:gpt-image-2`, `quality: 'medium'`, `aspect_ratio` 16:9 (web) / 1:1 (social), `timeout 180 000`, **maxCost 0.08**.

**Endpoints y mecánica (adaptadores):**

- Anthropic (`anthropic.ts:1-27, 44-45, 194-243`): `POST /v1/messages`, header `anthropic-version: 2023-06-01`; salida estructurada nativa `output_config.format: json_schema` **solo si el esquema tiene ≤16 parámetros con unión/tipo múltiple y ≤24 opcionales** (`STRUCTURED_OUTPUT_LIMITS`, `withinStructuredOutputLimits`); si no, el esquema viaja como herramienta no estricta con `tool_choice` forzado salvo en modelos que lo rechazan (`rejectsForcedToolChoice`: opus-5-5, sonnet-5-5, fable-5-1, mythos-5-1); `output_config.effort` ← `reasoning_effort`; `usage.input_tokens` = no cacheado + cache_creation + cache_read (estimación conservadora); `costUsd: null` siempre ⇒ **costo `estimated`**. `image()` lanza `image_not_supported`. `ping` = `GET /v1/models?limit=1`.
- OpenAI (`openai.ts:1-16, 49-57, 170-233`): texto por **Responses API** `POST /responses` con `store: false`, `text.format json_schema strict`, `reasoning.effort`; imágenes `POST /images/generations` con `model gpt-image-2`, `n 1`, `size` por aspecto (`1024x1024`, `1536x864`, `1536x1152`, `1152x1536`, `1024x1280`), `output_format png`, `quality`; usage por tokens (`input_tokens`, `output_tokens`), `costUsd: null` ⇒ `estimated`. 429 con `error.code` de cuota ⇒ `insufficient_credit`; 400 `moderation_blocked` ⇒ `policy_blocked`.
- Dispatcher (diff): adaptador por `kind` anthropic/openai; `PAID_PROVIDER_KINDS = ['anthropic','openai','openrouter']` reservan `max_cost_usd`; `SPENT_SQL` suma los tres kinds (el histórico OpenRouter sigue contando contra los USD 25, DEC-0068). Política de datos v2: tenant `real` permitido solo si `ai_provider.real_data = 'allowed'` (`provider_terms_unverified` en caso contrario).
- Jev (`client.ts`, `config.ts` diff): se elimina el proveedor `openrouter` del cliente; `JEV_DATA_SCOPE ∈ {synthetic, all}` (`all` envía texto de cualquier negocio, DEC-0067).
- `docs/architecture/ai-providers-data-terms.md` (untracked): verificación única de términos; veredicto **COVERED_WITH_CONDITIONS** para TypeSafe, Anthropic y OpenAI (§4), con condiciones (p. ej. revelar IA al cliente final en respuestas automáticas; revisión humana y etiqueta «generado con IA» en imágenes publicadas; `store:false`; no «Development Partner Mode»; sin fotos de personas). Afirma retención 30 días Anthropic/OpenAI y «sin plazo publicado» en TypeSafe. **No se verificó aquí ninguna de esas URLs**: queda como insumo para el entregable 02.

### 8.4 Estado tras DEC-0073 (HEAD `1f1c7da`) — re-verificado 2026-11-03T08:28Z (HECHO VERIFICADO sobre `catalog.ts`/`0029`; **precios y endpoints NO verificados contra fuentes oficiales**: entregable 02)

**Proveedores (`catalog.ts:59-83`):** `anthropic` con `status: 'disabled'` — dataPolicy: «Alternativa técnica fuera de operación en desarrollo (DEC-0073); adaptador conservado, sin rutas activas ni fallback»; `openai` activo — «Proveedor generativo de desarrollo (DEC-0073): texto/razonamiento por Responses store:false e imágenes gpt-image-2 por Images; Services Agreement + DPA; sin entrenamiento; logs de abuso 30 días»; `typesafe` con dataPolicy actualizada (DEC-0066, MCA + DPA, «sin plazo de retención publicado y sin ZDR asumido»); `simulated` sin cambios.

**Modelos (`catalog.ts:85-97`):** se mantienen `an:claude-haiku-5-5` (0.1/0.5, `forced_tool_choice true`), `an:claude-sonnet-5-5` (2/10, `forced_tool_choice false`), `an:claude-opus-5-5` (4/20), `oa:gpt-image-2` (in 5 / out 30, quality low/medium/high, `requires_org_verification: true`, comentario «calidad media 1536x1024 ≈ USD 0.041»), `oa:gpt-6-luna` (0.1/0.5, `endpoint: 'responses'`) y **se añade `oa:gpt-6.1-sol`** (2/10, `endpoint: 'responses'`, nombre «GPT-6.1 Sol (API MainSpot)»; comentario del código: «Descubiertos en el catálogo autenticado de MainSpot (2026-11-03), no derivados del acceso de OMP»). Los precios sembrados no cambiaron respecto de §8.3. Comentario de cabecera: «Claude 5.x: pensamiento adaptativo; rechazan `temperature` distinta de la predeterminada».

**Candidatas de desarrollo (`catalog.ts:290+`, nota: «Candidatas de desarrollo (DEC-0073), nunca activadas por semilla»):** ahora vía OpenAI — diseño → `oa:gpt-6.1-sol` (0.25) y `oa:gpt-6-luna` (0.05), ambos `reasoning_effort 'medium'`; edición simple → Luna (0.02); edición compleja → Sol (0.2) y Luna (0.05), `medium` («selección explícita, no fallback»); compose → Luna (0.03); creatives → Luna (0.03). **Esto reemplaza la lista de candidatas de §8.3** (que describía el estado `36af79c` con Sonnet/Haiku).

**Migración `0029_ai_openai_development.sql` (47 líneas):** `UPDATE ai_provider SET status = 'disabled' WHERE kind = 'anthropic'`; ciclo `DO $$` sobre rollouts; comentarios: «configuración actual de desarrollo, no selección comercial irreversible», «Anthropic conserva adaptador/modelos/evidencia como alternativa técnica, fuera de operación», «No se activa ninguna ruta OpenAI: primero debe superar evaluación y aprobación existentes».

**Nueva evidencia en `evidence/ai-core/` (existencia verificada por `git diff --stat`; contenido NO leído en este entregable — insumo del entregable 03):** `direct-e2e-2026-11-03.txt` (70 líneas), `direct-evals-2026-11-03.json` (1 656), `direct-provider-access-2026-11-03.json` (138), `direct-runtime-smoke-2026-11-03.json` (68), `direct-verification-2026-11-03.json` (51), `jev-gate-dev-2026-11-03.json` (97), `openai-development-catalog-2026-11-03.json` (974), `openai-development-e2e-2026-11-03.txt` (72), `openai-development-evals-2026-11-03.json` (687), `openai-development-verification-2026-11-03.json` (404), más capturas `screens/` y registros `.canonflow/` (`DEC-0073.{json,md}`, `SRC-0011-openai-development-directive.md`, `INC-0008.md`).

---

## 9. Discrepancias detectadas (preguntas abiertas, sin resolver aquí)

| # | Discrepancia | Dónde | Pregunta a verificar (responsable sugerido) |
|---|---|---|---|
| D1 | Precios del catálogo del worktree vienen del catálogo **de OpenRouter** (2026-10-30), no del proveedor directo; el snapshot SOL MAIN siembra los mismos números (Haiku 0.1/0.5, Sonnet 2/10) citando páginas de Anthropic/OpenAI pero sin archivo de evidencia. | `catalog.ts:11-14, 57-67` vs diff SOL MAIN +18-19, +87-93 | ¿Coinciden exactamente los precios directos (incluida caché, batch, tokens de pensamiento, tier largo contexto) con 0.1/0.5, 2/10, 4/20 y 5/30? (entregable 02) |
| D2 | `gpt-image-2`: el catálogo SOL MAIN lo trata como endpoint productivo (`/images/generations`, `requires_org_verification`) y estima «≈ USD 0.041 por imagen media 1536x1024»; DEC-0069 solo dice que es visible en OMP como `openai-codex/gpt-image-2` y exige comprobar. | diff +90-91; `openai.ts:49-57`; DEC-0069 | ¿Existe `gpt-image-2` como modelo de la API pública, con qué precio por token/imagen, tamaños válidos (`1536x864` es múltiplo de 16 pero ¿está permitido?), verificación de organización y ZDR? (entregable 02) |
| D3 | Límite de esquema: la doc dice «17 uniones vs límite 16 de Anthropic» (`ai-core.md:93`) pero la evidencia solo muestra `provider_unavailable: bad_request` vía OpenRouter (run1); el adaptador directo SOL MAIN cuenta uniones «en todo el árbol» (criterio conservador) y cambia a herramienta no estricta. | `evals-lab-run1.json`; `anthropic.ts:72-95` | ¿El límite de 16 es por parámetro de nivel superior o por árbol? ¿`EDIT_SCHEMA` (7 uniones nulas por operación + `block` anidado) cae realmente fuera? ¿Qué calidad tiene la vía «herramienta no estricta» frente a `json_schema` nativo? (entregable 03) |
| D4 | «429/5xx se reintentan acotado» (`ai-core.md:29`) frente al código: sin reintento HTTP para OpenRouter/texto/imagen; solo Jev (3) y jobs (3). | §5.3 | ¿Debe el factor de reintento del modelo económico asumir reintento humano/job (coste ×3 en el peor caso) o uno automático inexistente? |
| D5 | `temperature 0.4` en `TEXT_DEFAULT` nunca llega a Haiku/Sonnet/Luna (`capabilities.temperature=false`); la doc de rutas sugiere que es un parámetro efectivo. | `catalog.ts:261`; `dispatcher.ts:280` | ¿Los modelos Claude 5.x / GPT-6 aceptan `temperature` en API directa? (SOL MAIN afirma que Claude 5.x la rechaza; sin fuente leída aquí) |
| D6 | Costo por imagen heterogéneo: Seedream/FLUX por imagen; Gemini/MAI por token de salida; `gpt-image-2` por tokens de entrada **y** salida. `estimateCost` no contempla tokens de entrada de imagen ni `quality`. | §2.2; `governance.ts:73-79` | ¿Cómo convertir cada tarifa a «USD por imagen a resolución X y calidad Y» de forma comparable? (entregables 02/04) |
| D7 | Jev: el pipeline conversacional usa alias `jev-latest` (`jev/client.ts:33-36`) y timeout 10 s / 1 intento (`jev-classifier.ts:54-55`), mientras el catálogo fija `jev-1.14.0`, 15 s y 3 intentos. | §4 fila 7 | ¿Precio y SLA de `jev-latest` vs `jev-1.14.0`? ¿TypeSafe cobra por intento reintentado? |
| D8 | Presupuesto: en el worktree `bud_lab_total` dice «QS-0016»; SOL MAIN lo reetiqueta «DEC-0068 … incluido el consumo histórico» y suma OpenRouter histórico en `SPENT_SQL`. | `catalog.ts:325`; migración 0028 | Confirmar que USD 0.096726 gastados (2026-10-30) cuentan contra los 25 (sí según DEC-0068). |
| D9 | Nombres de modelo: worktree `anthropic/claude-haiku-5.5` (slug OpenRouter) vs SOL MAIN `claude-haiku-5-5` (id API directa); ninguno con sufijo de fecha/versión fijada. | `catalog.ts:61`; diff +87 | ¿Cuál es el id exacto y estable del modelo en la API de Anthropic (¿existe alias vs snapshot fechado?)? (entregable 02) |
| D10 | `docs/architecture/ai-providers-data-terms.md` (SOL MAIN) concluye COVERED_WITH_CONDITIONS y el catálogo marca `real_data='allowed'` con `terms_verified_at` fijo en código; DEC-0067/0071 piden verificación «una sola vez» pero no definen quién la da por válida. | §8.3 | ¿La verificación documental de un agente satisface la condición del propietario o requiere un acto del propietario (aceptación electrónica de DPA/Commercial Terms en la consola del proveedor)? (decisión de propietario; fuera del alcance de investigación) |
| D11 | El recorrido E2E muestra imágenes `hero:no_active_route` (`lab-e2e.txt:16`) mientras las evaluaciones muestran `provider_account_policy`: dos causas distintas de bloqueo coexistieron. | `lab-e2e.txt`; `evals-lab-run1.json` | Sin efecto económico; solo para no confundir «bloqueo de guardrail» con «sin ruta». |
| D12 | DEC-0069 declara «Anthropic directo prioritario» para texto, pero DEC-0073 (commit `1f1c7da`, 2026-11-03 03:25) selecciona **OpenAI para toda la generación en desarrollo** y deshabilita el proveedor Anthropic (migración 0029), presentándose como «configuración actual de desarrollo, no selección comercial irreversible» (§8.0, §8.4). | SOL MAIN `.canonflow/decision-records/DEC-0073.md`; `migrations/0029` | ¿Cómo debe ponderarlo el entregable 05: Anthropic como alternativa técnica con evidencia ya recogida (§8.4) y OpenAI como ruta de desarrollo en evaluación? La selección de producción sigue siendo decisión del propietario. |

---

## Fuentes

Todas consultadas el 2026-11-03 en el sistema de archivos local (ninguna URL externa fue leída para este entregable; las URLs citadas dentro de los archivos se reproducen como aparecen y **no** se verificaron).

1. `research/ai-provider-economics/HANDOFF.md` (worktree; leído en `d440e2a`, rama ahora en `83e7ee2`) — objetivo, familias §3, método §5, unit economics §6.
2. `docs/architecture/ai-core.md` (worktree) — pipeline, rutas activas en lab 2026-10-30 (§5), estado GO/BLOCKED (§6), limitaciones.
3. `docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-RESULTS.md` — matriz E01-E20, costos/latencias del recorrido real, bloqueos.
4. `docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-CANON-PROPOSAL.md` — ítems canónicos y hashes.
5. `docs/handoffs/mainspot-ai-core-2026-10-30/MAINSPOT-AI-CORE-E2E-HANDOFF.md` §0-§4 — visión, catálogo mínimo exigido.
6. `src/ai/catalog.ts` — casos de uso, proveedores, modelos/precios, prompts v1, rutas semilla, presupuestos.
7. `src/ai/dispatcher.ts` — idempotencia, política, circuito, reserva, reparación, herramientas, imagen, Jev, costo.
8. `src/ai/governance.ts` — política de datos v1, reservas, `estimateCost`.
9. `src/ai/registry.ts` — ciclo de vida de rutas, canary, `RouteParams`, límites.
10. `src/ai/jobs.ts` — lease, intentos, abandono.
11. `src/ai/contracts.ts`, `src/ai/schema.ts`, `src/website/design.ts` — esquemas y validadores de dominio.
12. `src/ai/evals.ts` — suites y umbrales.
13. `src/ai/prompt.ts` — preámbulo y render.
14. `src/ai/providers/{types,openrouter,simulated}.ts`, `src/jev/client.ts` — adaptadores y reintentos.
15. `src/engagement/ai-semantics.ts`, `src/conversation/jev-classifier.ts`, `src/website/ai-site.ts`, `src/ai/business.ts`, `src/media/service.ts` — llamadores e integración.
16. `migrations/0025_ai_core.sql` — tabla `ai_invocation`.
17. `evidence/ai-core/evals-lab-run{1,2-*,3-*}.json`, `lab-e2e.txt`, `screens/` — mediciones históricas 2026-10-30.
18. SOL MAIN `git show d297e8a:.canonflow/decision-records/{APR-0003,DEC-0066..DEC-0072}.md` — decisiones del propietario.
19. SOL MAIN working tree (hashes en §8.2): `src/ai/providers/anthropic.ts`, `openai.ts`, `migrations/0028_ai_direct_providers.sql`, diffs de `catalog.ts`, `dispatcher.ts`, `governance.ts`, `registry.ts`, `providers/types.ts`, `shared/config.ts`, `jev/client.ts`, `conversation/jev-classifier.ts`; encabezados de `docs/architecture/ai-providers-data-terms.md`.
20. SOL MAIN commits `36af79c` y `1f1c7da` (2026-11-03, solo lectura: `git log`, `git diff --stat d297e8a`, `git status --porcelain`; hashes §8.2 re-verificados con `sha256sum` a las 08:28Z) — avance del snapshot externo; DEC-0073/SRC-0011 en `.canonflow/`.
21. SOL MAIN `src/ai/catalog.ts:59-97, 290+` y `migrations/0029_ai_openai_development.sql` (HEAD `1f1c7da`) — semillas de proveedores/modelos/candidatas y deshabilitación de Anthropic (§8.4).
22. `research/ai-provider-economics/evidence/lab-traces.md` (+ `lab-invocations.csv`, 310 filas) — re-cotejo de las cifras de tokens/tasas citadas en §5.4 y §6 (coinciden).

## Huecos

| Id | Qué no se pudo verificar | Cómo verificarlo (sin costo) |
|---|---|---|
| H1 | Estado real de rollout en la BD de laboratorio (qué ruta está `ACTIVE` hoy por caso de uso, si ya corrieron las migraciones 0028/0029 de SOL MAIN). | Consulta de solo lectura a `ai_rollout`/`ai_route_revision` por el integrador o la Engineering Console; prohibida para este agente. |
| H2 | Precios, ids de modelo, límites de esquema y existencia de `gpt-image-2` en fuentes oficiales. | Entregable 02 (`web_search` + `read` de páginas oficiales de Anthropic/OpenAI/TypeSafe). Insumo disponible: los JSON de verificación de SOL MAIN (`evidence/ai-core/direct-verification-2026-11-03.json`, `openai-development-verification-2026-11-03.json`, §8.4) no fueron leídos aquí. |
| H3 | Tasa real de reparación y tokens de la segunda llamada por caso de uso. | **Cubierto parcialmente** por `evidence/lab-traces.md` (§6): intentos promedio y % con reparación por caso/modelo. Sigue sin registrarse qué falló en el primer intento (`validation.errors` vacío si el segundo pasa, `lab-traces.md:14`) ni hay datos para edición simple/compleja con Haiku (0 éxitos) ni para imágenes. |
| H4 | Si TypeSafe factura intentos HTTP reintentados (429/5xx) o solo respuestas válidas. | Términos/pricing de TypeSafe (entregable 02) o consulta al proveedor. |
| H5 | Comportamiento de `temperature`/`reasoning_effort`/`output_config.effort` en Claude 5.x y GPT-6 directos (afirmado por SOL MAIN; no leído en fuente). | Documentación oficial (entregable 02). |
| H6 | Validez de la «verificación única de términos» de SOL MAIN (`ai-providers-data-terms.md`) frente a DEC-0067/0071: documento sin commit, URLs no releídas aquí. | Entregable 02 debe releer las URLs y el integrador/propietario decidir D10. |
| H7 | Costo por imagen efectivo de `gpt-image-2` por `size`×`quality` (el comentario «≈ 0.041» no trae fórmula ni fuente en el diff). | Entregable 02 (página de precios) + entregable 04 (fórmula por tokens de imagen). |
