# TypeSafe AI / Jev — evidencia para clasificación semántica (producción)

Fecha de consulta de todas las fuentes públicas: **2026-11-03**. Moneda: USD salvo indicación. Sin llamadas pagadas; sin lectura de secretos; sin consultas a la base de datos.

Snapshot del repositorio: worktree `mainspot-ai-research`, rama `research/ai-provider-economics-2026-11` (HEAD d440e2a; commit de partida 73271a2). DEC-0067 leído en SOL MAIN `d297e8a` (solo lectura).

Etiquetas: **HECHO VERIFICADO** (leído con `read` en la URL oficial o en el código del repo), **SNIPPET** (visto solo en resultado de búsqueda), **MEDICIÓN PROPIA** (cálculo offline sobre el repo, sin red), **ESTIMACIÓN** (fórmula mostrada), **HIPÓTESIS**, **DESCONOCIDO**, **[INFERENCE]** (deducción no observada directamente).

**Auditoría 2026-11-03 (subagente `TypeSafeAudit`):** spot-check de las afirmaciones críticas contra las fuentes oficiales — precio, facturación, retención/ZDR, DPA, límites, OpenRouter y status — sin discrepancias salvo las anotadas. SNIPPETs verificados: tope de 10 niveles en `score` (§3.2), términos del sitio (§3.5) y panorama de otros modelos de decisión (§3.8, con slugs corregidos). Tokens medidos de `lab-traces.md` incorporados a §5/§6; implicación de DEC-0073 añadida en §4.3. Lecturas de verificación: 9 URLs oficiales.

---

## 0. Resumen ejecutivo

| Tema | Resultado | Etiqueta |
|---|---|---|
| Precio público de Jev | **USD 0.042 / MTok de entrada; salida gratis**; un solo plan para todas las cuentas; sin cuota mínima, sin cargo por petición ni por petición fallida; sin créditos gratuitos | HECHO VERIFICADO (blog, docs/models, help center) |
| `input_per_mtok: 0.042 / output 0` del catálogo (`ts:jev-1.14.0`, fuente `typesafe_public_pricing`, 2026-10-20) | **Confirmado** vigente el 2026-11-03 para `jev-1.14.0` y `jev-1.13.0` | HECHO VERIFICADO |
| Forma de cobro | Créditos prepagados (consola → Settings → Billing), auto-recarga opcional, factura bajo petición; saldo 0 ⇒ HTTP 402; créditos comprados caducan a los 12 meses (MCA §8.2a) | HECHO VERIFICADO |
| Costo que reporta la API | La respuesta oficial trae **solo `usage.input_tokens` y `usage.output_tokens`; no hay campo `cost`** (OpenAPI `Usage`). El costo persistido en MainSpot es por tanto **estimado** (tokens × 0.042/MTok), no informado por el proveedor | HECHO VERIFICADO (openapi.json) + [INFERENCE] sobre el repo |
| Costo por evento observado en laboratorio (`evidence/ai-core/*`) | intención del dueño **USD 0.000034**; comentario FB / reseña Google **USD 0.000046** (run3, n=20); rango 0.000025–0.000049 según corrida | HECHO VERIFICADO (archivos de evidencia) |
| Tokens por llamada | **MEDIDO** (`lab-traces.md`): **804** tokens in (intención) y **1,158** (comentario/reseña); la deducción previa por redondeo (≈ 810 / ≈ 1,095) subestimaba ≈ 5 % la de comentarios (§5.1). Bloque de preguntas: 1,802 B (owner, 3 preguntas) y 3,245 B (comment/review, 8 preguntas) | MEDICIÓN PROPIA + ESTIMACIÓN |
| Jev vía OpenRouter | Existe: `typesafe/jev-1.14`, `~typesafe/jev-latest`, endpoint `POST /api/alpha/decisions` (alfa), **mismo precio 0.042/0**, un solo proveedor (TypeSafe), sin enrutamiento EU; OpenRouter cobra 5.5 % sobre compra de créditos (Standard). Fuera de política (DEC-0069) | HECHO VERIFICADO |
| Datos | No entrena con entradas/salidas (MCA §4.1, Privacy, help). Retención: **sin periodo fijo publicado**; **ZDR disponible para toda organización, gratis, bajo solicitud**. Procesamiento en EE. UU. DPA pública con SCC UE/UK; México no se menciona | HECHO VERIFICADO |
| SLA | **No hay SLA público**: MCA §9.3 «as is / as available»; solo garantía de conformidad con la documentación (§9.1) con remedio = corrección o reembolso de lo prepagado. Status page: 99.858 % (30 d) en `api.typesafe.ai`; incidente «System overload» 2026-10-30 (1 h 15 min) | HECHO VERIFICADO |
| Límites | 100k tokens/s y 80 req/s por organización por defecto; contexto 64k por petición / 32k por pregunta; hasta **255 opciones** por `choice`; cuerpo ≤ 32 MiB | HECHO VERIFICADO |
| Versionado | `jev-latest` → `jev-1.14.0` (desde 2026-10-14, alias movido una semana después); aviso de deprecación prometido: 60 días para 1.13.0, 30 días para 1.14.0; **política formal de deprecación aún no publicada** | HECHO VERIFICADO |
| Fiabilidad en laboratorio | 95/160 invocaciones Jev exitosas (65 fallidas: intención 10/30, comentario FB 41/70, reseña Google 34/60); las fallidas **no consumen tokens** (USD total/éxitos = USD prom./éxito en las tres filas) | MEDICIÓN PROPIA (`lab-traces.md`, histórica) |
| DEC-0073 (2026-11-03) | TypeSafe/Jev **no afectado**: DEC-0073 cambia solo el proveedor generativo de desarrollo a OpenAI; «TypeSafe/Jev conserva clasificación semántica primaria» | HECHO VERIFICADO (registro DEC-0073; §4.3) |
| Comparación en papel vs generativo barato | Haiku 5.5 / GPT-6 Luna sin caché ≈ **USD 0.00018** por comentario (≈ 3.7× Jev medido 0.000049); con caché de prefijo ≈ **0.00009** (≈ 1.8×); con caché + batch ≈ 0.000045 (≈ 0.9×, pero no en tiempo real); Decisions API de OpenAI (`gpt-6-luna`, salida gratis) ≈ 0.000116 (≈ 2.4×). Jev sigue siendo el más barato en tiempo real y el único con probabilidades calibradas y sin errores de tipo | ESTIMACIÓN |

---

## 1. Mecánica en el repositorio (solo lectura)

### 1.1 Cliente `src/jev/client.ts` — HECHO VERIFICADO

| Aspecto | Valor en código | Referencia |
|---|---|---|
| Proveedores | `mock` \| `openrouter` \| `typesafe`; elegido una vez por instancia, **sin fallback en tiempo de ejecución** | l. 25, 57, 135–165 |
| Endpoints | typesafe `https://api.typesafe.ai/v1/systemone`; openrouter `https://openrouter.ai/api/alpha/decisions` | l. 27–30 |
| Modelo por defecto | `jev-latest` (typesafe) / `~typesafe/jev-latest` (openrouter); `model` permite fijar versión | l. 32–35, 168–171 |
| Petición | `{ model, state, questions }`; se valida antes y después de serializar (`validateRequest`); `Authorization: Bearer`, `redirect: "error"` | l. 189–234 |
| Timeout | `timeoutMs` por defecto 30,000 ms, **presupuesto total incluyendo reintentos y lectura de cuerpo** | l. 43, 65, 220–224 |
| Reintentos | `maxAttempts` por defecto 3; solo en HTTP **429, 502, 503, 529**; backoff `500 ms × 2^(n−1)` + jitter ≤ 20 %, respeta `Retry-After`, tope 8,000 ms; otros códigos fallan de inmediato (`JevHttpError` con status; 401 → «check key», 402 → «check credits») | l. 42, 236–248 |
| Validación de respuesta | contrato estricto (`validateResponse`) por tipo de pregunta; campos desconocidos se conservan | l. 257, 341–382 |
| Costo | `resultCost`: `usage.cost` finito ≥ 0 ⇒ `reported`; si no, con `pricing` ⇒ `estimated = input_tokens/1e6 × inputPerMillion + output_tokens/1e6 × outputPerMillion`; si no ⇒ `unknown` (`amount: null`) | l. 46–54, 270–279 |
| Retención de crudo | `raw.request/requestText/response/responseText` sin cabeceras; `meta.resolvedModel = response.model` | l. 75–96, 281–302 |

### 1.2 Clasificador de intención `src/conversation/jev-classifier.ts` — HECHO VERIFICADO

- `JEV_POLICY_VERSION = 'intent-classifier-v3'`; **un solo intento**, `JEV_TIMEOUT_MS = 10_000`; `JEV_MAX_MESSAGE_BYTES = 8_192`; `JEV_MAX_IN_FLIGHT = 16` por proceso (exceso ⇒ `unavailable/saturated`); `JEV_MIN_PROBABILITY = 0.7` (l. 53–61).
- `JEV_PRICING = { inputPerMillion: 0.042, outputPerMillion: 0 }` «precio público de TypeSafe observado el 2026-10-20; solo estima el coste cuando el proveedor no lo informa» (l. 103–107).
- Dos preguntas `choice` en una llamada: `intent` (9 opciones: 8 intents + `other`) y `capability_target` (5 opciones) (l. 190–207). Tamaño del JSON de preguntas: **3,990 bytes / 532 palabras** (MEDICIÓN PROPIA, `JSON.stringify(JEV_QUESTIONS)`).
- Gate de primary (DEC-0031/0033): ≥ 200 casos, ≥ 90 % de acierto de intent, 0 riesgos omitidos; ligado al sha256 del conjunto de evaluación y del código decisor; el modelo **resuelto** (`meta.resolvedModel`) debe estar en los evaluados, si no ⇒ `model_not_evaluated` (l. 63–101, 524–529).
- Presupuesto D5 (DEC-0032): `JevBudget` por proceso y día UTC, sembrado desde BD; agotado ⇒ Jev «no disponible» (l. 328–366). `createJevClient`: provider explícito, `maxAttempts: 1`, 10 s, `pricing: JEV_PRICING` (l. 673–683). Solo `provider: 'typesafe'` se acepta (l. 484–486; `src/shared/config.ts` l. 25 `JEV_PROVIDERS = ['typesafe']`, l. 67 `JEV_MAX_DAILY_BUDGET_USD = 1`).

### 1.3 AI Core `src/ai/dispatcher.ts` (`invokeClassification`, l. 421–471) — HECHO VERIFICADO

- Preguntas tipadas se leen del `task_template` de la revisión de prompt (JSON versionable en Prompt Studio); el `state` enviado es solo el texto minimizado (`{ message, rating_stars? }` desde `src/engagement/ai-semantics.ts` l. 74–77).
- Cliente por invocación: `provider: 'typesafe'`, `model: s.bundle.model.provider_model` (= `jev-1.14.0` en la ruta activa), `timeoutMs` de la ruta (`timeout_ms: 15_000` en `catalog.ts` l. 282), **`maxAttempts: 3`**, `pricing.inputPerMillion = pricing['input_per_mtok'] ?? 0.042`, salida 0.
- `costUsd = res.meta.cost.amount`; `inputTokens/outputTokens` de `res.usage`. 401/403 ⇒ `provider_auth` (no reintentable); 429 ⇒ `rate_limited`; ≥500 ⇒ `unavailable`; otros ⇒ `bad_request`. 429/5xx ya reintentados por el cliente.
- `jevBudgetAllows()` (l. 462–471): suma `ai_invocation.cost_usd` del proveedor `typesafe` + `jev_classification` + `jev_evaluation_run` del día UTC y compara con `config.jev.dailyBudgetUsd` (1 si `disabled`). **Es un tope global por despliegue, no por negocio.**
- Preguntas del catálogo (`catalog.ts` l. 161–211): `comment`/`review` = 8 preguntas (4 `choice`: sentiment, category, info_topic, urgency; 4 `noul`: risk_safety, risk_legal, personal_data, abusive); `owner` = 3 `choice` (sentiment, edit_scope, urgency). Tamaño JSON: **comment/review 3,245 B / 334 palabras; owner 1,802 B / 208 palabras** (MEDICIÓN PROPIA).
- `src/engagement/ai-semantics.ts`: `RISK_THRESHOLD = 0.5` sobre los `noul`; sin ruta activa ⇒ `not_configured` (política determinista); fallo ⇒ `unavailable` ⇒ revisión humana, nunca palabras clave para publicar (l. 1–11, 19, 71–80).

### 1.4 Evidencia de laboratorio ya existente — HECHO VERIFICADO (archivos), NO reejecutado

| Corrida (archivo) | Caso de uso | n | Costo total | Costo/caso | p50 / p95 ms | Calidad |
|---|---|---|---|---|---|---|
| `evals-lab-run2-conversation.intent.classify.json` | intención | 8 | 0.000202 | 0.000025 | — / 866 | — |
| `evals-lab-run3-conversation.intent.classify.json` | intención | 8 | 0.000269 | **0.000034** | — / 920 | 8/8 (`docs/architecture/ai-core.md` l. 85) |
| `evals-lab-run2-engagement.facebook.comment.classify.json` | comentario FB | 20 | 0.000583 | 0.000029 | — / 950 | sentimiento 83.3 %, 0 riesgos omitidos |
| `evals-lab-run3-engagement.facebook.comment.classify.json` (2026-10-30T20:46Z) | comentario FB | 20 | 0.000923 | **0.000046** | 750 / 919 | 16/20, sentimiento 89.5 %, 0 riesgos; 1 `provider_unavailable: TimeoutError` |
| `evals-lab-run2-engagement.google.review.classify.json` | reseña Google | 20 | 0.000730 | 0.000036 | — / 966 | sentimiento 86.7 % |
| `evals-lab-run3-engagement.google.review.classify.json` | reseña Google | 20 | 0.000924 | **0.000046** | — / **10,021** | sentimiento 89.5 %, 0 riesgos |
| `lab-e2e.txt` E15 | intención / comentario FB | 1 / 2 | 0.000034 / 0.000098 | 0.000034 / 0.000049 | 308 / 213–356 | — |

[INFERENCE] El p95 de 10,021 ms (= timeout de 10 s) y el `TimeoutError` de la corrida 3 (generada 2026-10-30 20:46 UTC) coinciden con el incidente «System overload» de la página de estado de TypeSafe, degradado 1 h 15 min y resuelto 2026-10-30 21:15 UTC (§3.6). No se verificó causalidad.

[INFERENCE] `lab-e2e.txt` rotula los costos como «procedencia: respuesta del proveedor». Para TypeSafe, dado que la respuesta documentada no incluye `cost` (§3.2), el valor almacenado procede de `meta.cost.source = 'estimated'` salvo que la API live devuelva un campo `cost` no documentado. Verificable sin costo leyendo `raw.responseText` de una fila `jev_classification` existente (consulta a BD **no realizada** por prohibición de esta tarea).

---

## 2. Skill local `hyper-jev` (lectura de `SKILL.md`, `cookbook/04-client-operations.md`, `cookbook/05-production.md`) — HECHO VERIFICADO

- Proveedores: selección **una sola vez** por instancia (explícito → `TYPESAFE_API_KEY` → `OPENROUTER_API_KEY`); «fallback» significa selección por clave al arrancar, **nunca** reintentar en otro proveedor; 401/402/429/outage/timeout en TypeSafe jamás produce una petición a OpenRouter. El cliente de MainSpot mantiene esta regla y elimina la lectura de `process.env` (`client.ts` l. 1–14).
- Contabilidad: `meta.cost = { amount, source }` con `reported` / `estimated` / `unknown` / `mock`; «no hay precio de Jev codificado en el cliente»; «la usage final no incluye necesariamente los intentos anteriores; no multiplicar por intentos y llamarlo costo medido»; `UsageLedger` separa reportado / estimado / desconocido / fallos; `client.calls` no es contador facturable.
- Reintentos: 429/502/503/529, máx. 3 intentos, backoff con tope 8 s; `ContractError` y fallos de red no se reintentan.
- Límites: «prune or traverse a taxonomy rather than exceeding **255 choices**» (SKILL.md, ejemplo de alta cardinalidad).
- Producción (05-production.md): checklist de credenciales, selección de proveedor, contrato, política de entrada (minimización, límites de tamaño, política de datos aprobada), deadline total y concurrencia acotada, contabilidad separada, auditoría de crudos en almacén restringido con retención, calidad con datos etiquetados y versión de modelo/rúbrica, fallos visibles sin cambio de proveedor. «Direct TypeSafe is supplied as a transport path, not a newly verified deployment. Validate endpoint, account access, limits, and model availability with an authorized smoke test.»

---

## 3. Fuentes públicas de TypeSafe AI

### 3.1 Precio y facturación — HECHO VERIFICADO

| Dato | Valor | Unidad | Fuente |
|---|---|---|---|
| Precio de entrada | **0.042** | USD / millón de tokens de entrada (= USD 42 / Btok) | docs/models (tabla Jev 1.14 y 1.13); blog «Introducing System One Models & Jev» (2026-09-15); help «How much does Jev cost?» |
| Precio de salida | **0 (gratis)** | — | ídem; OpenAPI `Usage.output_tokens`: «Output tokens are currently free of charge» |
| Qué se cobra | `state` + instrucciones y criterios de todas las preguntas, por petición; contexto largo «cuesta lo mismo por token» | tokens | docs/models |
| Planes | «One plan for everyone»: un plan estándar, mismo precio para todas las cuentas; sin tier enterprise separado; **sin cuota por petición, sin cargo por petición fallida, sin mínimo** | — | help «How much does Jev cost?» |
| Pago | Créditos prepagados en consola; auto-recarga opcional; facturación por invoice bajo petición «para cualquier cliente»; saldo agotado ⇒ **HTTP 402** | — | help ídem; MCA §8.2 |
| Caducidad de créditos | Créditos comprados expiran a los **12 meses** o al fin del Term; no reembolsables ni transferibles | — | MCA §8.2(a) |
| Créditos gratuitos | **No** se ofrecen créditos gratuitos ni de prueba | — | help ídem |
| Impuestos | Fees sin impuestos; cliente paga sales/VAT/withholding salvo income tax de TypeSafe | — | MCA §8.4 |
| Sostenibilidad del precio | «We can’t prove it isn’t subsidized; we’ll need the long-term to prove the sustainability of our pricing (which we expect to go down, not up)» | — | blog 2026-09-15 |

### 3.2 API y contrato de respuesta — HECHO VERIFICADO

- `POST https://api.typesafe.ai/v1/systemone`; `GET /v1/models` lista alias (`jev-latest`, `jev-preview`); los IDs versionados (`jev-1.14.0`) se aceptan aunque no aparezcan en la lista (docs/models «Listing models»).
- OpenAPI (`https://api.typesafe.ai/openapi.json`, versión 0.2.0): `SystemOneResponse = { model, answers, usage }`; `Usage = { input_tokens (billable), output_tokens }` — **no existe campo `cost`**. `model` «may differ from the alias supplied in the request».
- Tipos: `noul` (probabilidad 0–1), `choice` (`choice`, `probabilities`, `confidence`; **hasta 255 opciones**), `score` (niveles ordenados; esperanza ponderada; **tope de 10 niveles** — HECHO VERIFICADO en docs `primitives/score` 2026-11-03: «the API accepts up to 10» y «Use as many levels as you can describe distinctly, up to 10»; mínimo 2; el score es la media ponderada de los números de nivel y la confianza se deriva de la dispersión de `probabilities`), `box` (solo 1.14, imágenes; «danger zone»).
- Reglas: cuerpo ≤ 32 MiB; UTF-8 sin BOM; ≤ 64 niveles de anidación; gzip/zstd opcional. Errores: 400, 401, 413, 415, 422, **429** (rate limit), **529** (overloaded); recomendación: backoff exponencial y `retry-after` (docs/api/errors; help «429 vs 529»). El cliente de MainSpot cubre 429/529 y además 502/503.

### 3.3 Límites, contexto, rate limits — HECHO VERIFICADO

| Límite | Valor | Fuente |
|---|---|---|
| Contexto por petición | 64k tokens (state + todas las preguntas) | docs/models |
| Contexto por pregunta | 32k tokens (state + una pregunta) | docs/models |
| Contexto largo (opt-in) | 262k ambos, con cabecera `TypeSafe-Danger-Zone-Long-Context: true`; «más lento y menos preciso» | docs/models; blog Jev 1.14 |
| Número de preguntas por petición | sin límite separado | docs/models |
| Rate limits por organización (defecto) | **100,000 tokens/s y 80 req/s**; medidos en TPS y RPS; superiores con «small credit prepayment» o formulario | help «How much does Jev cost?»; help «rate limits»; docs/models |
| Idioma | «English is the primary training language … Other languages … handled but not equally well; test on your own content»; 1.14: «largest gain in multi-lingual support» | docs/models; blog Jev 1.14 |

Para MainSpot (≈ 1,100 tokens/llamada, §5): 80 req/s ≈ 88k tokens/s, por debajo del tope de TPS; el límite real de concurrencia es el propio `JEV_MAX_IN_FLIGHT = 16` por proceso (ESTIMACIÓN).

### 3.4 Versiones, alias, deprecación — HECHO VERIFICADO

- Modelos actuales: `jev-1.14.0` (desde 2026-10-14) y `jev-1.13.0`, mismo precio y límites (docs/models; changelog: 1.14 «better multilingual support», Box, imágenes, long context).
- Alias: `jev-latest` → `jev-1.14.0`; `jev-preview` → `jev-1.14.0` (sin preview disponible ahora). «An alias moves when a new release ships, so its answers can change without any change to your code… If you have tuned confidence thresholds against one version, send that version's ID.» MainSpot ya fija `jev-1.14.0` en la ruta y liga el gate al modelo resuelto (§1.2).
- Deprecación: «We intend to give 60 days warning before `jev-1.13.0` is formally deprecated, and 30 days for `jev-1.14.0`. We’ll release a deprecation policy prior to this» (blog 2026-10-14). **No hay política formal publicada** a 2026-11-03 (buscado en docs index `llms.txt`: no existe página de deprecación).
- MCA §2.5: TypeSafe puede actualizar el servicio y «such changes may result in the API’s becoming incompatible»; solo «commercially reasonable efforts» de aviso previo.
- No hay fine-tuning ni LoRA por cliente; mismos pesos para todas las cuentas (docs/models «Customizing Jev»).

### 3.5 Términos contractuales (Master Customer Agreement, actualizado 2026-09-23) — HECHO VERIFICADO

| Cláusula | Contenido relevante para MainSpot |
|---|---|
| §2.2 Customer Applications | Licencia incluye integrar la API en aplicaciones propias para usuarios finales: **cubre el uso SaaS de MainSpot** |
| §2.3(b) | Prohibido usar el servicio u Output para **destilación o entrenar un modelo que imite la salida**, o desarrollar un producto competidor. Riesgo si MainSpot entrenara su clasificador propio con etiquetas de Jev (ver §8) |
| §4.1 Uso de datos | Licencia a TypeSafe solo para prestar el servicio, calcular Fees, generar Telemetry, fraude/abuso y ley; **«will not include Customer Data in a dataset used to train… without Customer's prior consent»** |
| §4.2 | Cliente es dueño de Input y Output |
| §4.3 Telemetry | «technical logs, hashes, summary statistics **and classifications**, metrics, and learnings»; procesable sin restricción. El help center afirma que la telemetría «doesn't include the content of your inputs or outputs». La palabra «classifications» es ambigua respecto a las respuestas de Jev → punto a aclarar en la verificación única |
| §4.4 | DPA incorporada por referencia |
| §6 Suspensión | Inmediata por impago ≥ 30 días, incumplimientos, cambios legales o riesgo para el servicio |
| §8.2 | Créditos, caducidad 12 meses, auto-recarga, 402 |
| §9.1–9.3 | Garantía: el servicio funcionará «materially as described in its Documentation»; remedio exclusivo: corrección en 30 días o terminación con reembolso de lo prepagado no usado. **Resto «AS IS / AS AVAILABLE»; no garantiza servicio ininterrumpido; no responsable por delays/outages** |
| §10.3 | Sin obligación de retener Customer Data; puede borrarlo a discreción |
| §12.2 Tope de responsabilidad | Mayor de (a) fees pagados en 12 meses, (b) **USD 50** |
| §15 | Arbitraje individual JAMS, San Francisco; sin acciones colectivas |
| §16.2 | Ley de California |
| §16.4 Publicidad | TypeSafe puede listar al cliente como referencia salvo petición escrita (hay artículo de help para pedirlo) |
| §16.7 | TypeSafe puede modificar el MCA con ≥ 60 días de aviso |

Términos de uso del sitio (`typesafe.ai/legal/terms`, actualizados 2026-09-19) — HECHO VERIFICADO (leído íntegro 2026-11-03): aplican **solo al sitio web** («The Site provides information about TypeSafe…»); ley de Delaware (§13(b)); arbitraje individual JAMS con reglas de consumidor y opt-out de 30 días (§12); tope de responsabilidad del sitio USD 100 (§11(b)). Punto clave para MainSpot: «If you enter into a separate agreement with TypeSafe for the use of any TypeSafe products or services… the terms of that separate agreement will govern your access» → confirma que la API está gobernada por el MCA, no por estos términos. Sin impacto económico.

### 3.6 Estado, incidentes, SLA — HECHO VERIFICADO

- `status.typesafe.ai` (2026-11-03 05:55 UTC): todos los servicios operativos. `api.typesafe.ai` uptime **99.858 % (30 d) / 99.839 % (60 d) / 99.881 % (90 d)**. Regiones: `api.us.typesafe.ai` 99.991 %; `us-east-1` 100 %; `us-east-2` 100 %; `us-west-2` 99.982 %.
- Incidentes recientes del API: 2026-09-21 (2 min), 2026-09-23 latencia (12 min), 2026-09-28 (11 min), 2026-10-14 `us-east-1` latencia (45 min), **2026-10-30 «System overload» degradado 1 h 15 min, resuelto 21:15 UTC**.
- SLA: **no existe compromiso público de uptime ni créditos de servicio** (MCA §9.3; página enterprise solo ofrece «higher limits, data requirements»; OpenRouter indica «Contractual SLAs» solo en su plan Enterprise, y eso sería SLA de OpenRouter, no de TypeSafe).
- Help: «A higher rate limit is not a guaranteed fix for overload» (429 vs 529).

### 3.7 Datos, privacidad, DPA — HECHO VERIFICADO

| Tema | Hecho | Fuente |
|---|---|---|
| Entrenamiento | «Jev is not trained on customer inputs or outputs. There's nothing to opt out of.»; Privacy: «will not train or fine tune any … models on Input»; MCA §4.1 | help «How is submitted data used or retained?»; Privacy Policy (2025-11-19); MCA |
| Retención | «We don't publish a fixed retention period for standard usage. Data is kept only as long as reasonably necessary… deletion is available on request.»; DPA Schedule I §8: «as long as necessary… including laws on the statute of limitations» | help ídem; DPA |
| ZDR | «Zero Data Retention (ZDR) is available to all organizations… **free for every organization**»; se activa por formulario de soporte con el ID de organización; visible en Settings → Organization. (La página enterprise y docs/legal dicen «for enterprise customers»: redacción inconsistente; el help center es más reciente — «Last updated 1 hour ago» el 2026-11-03) | help «Do you offer ZDR?»; typesafe.ai/enterprise; docs/legal |
| Telemetría | Logs técnicos, hashes, estadísticas, clasificaciones, métricas; «doesn't include the content of your inputs or outputs» | help; MCA §4.3 |
| Ubicación | «Processing currently happens in the United States» | help; Privacy «International Visitors» |
| Subencargados | Lista en `https://trust.typesafe.ai/subprocessors` (DPA §3.1); la página **no renderiza sin JavaScript / requiere acceso** (lectura devolvió solo el título del Trust Center) → **DESCONOCIDO** quiénes son | DPA; lectura fallida |
| DPA | Pública (2026-04-24); roles controller/processor; solo instrucciones documentadas; no «sell/share» (CCPA); aviso previo de nuevos subencargados con 15 días para objetar; notificación de incidentes ≤ 72 h; auditoría anual a costa del cliente; **SCC UE (Módulos 2 y 3) y UK Addendum**; autoridad competente Irlanda/UK/Suiza. **No hay cláusula específica para México** | DPA |
| BAA/HIPAA | No aplica a MainSpot; TypeSafe trabaja en Bedrock/Azure/Vertex sin fecha | help DPA/BAA |
| Disclosure | Privacy: puede divulgar a afiliadas, proveedores, por ley, y en fusión/venta de activos | Privacy Policy |
| SOC 2 | Página enterprise anuncia **SOC 2 Type II** (informe bajo solicitud en Trust Center) — no verificado el informe | typesafe.ai/enterprise |

### 3.8 Jev vía OpenRouter — HECHO VERIFICADO (comparación en papel; DEC-0069 lo excluye de nuevas ejecuciones)

| Dato | Valor | Fuente |
|---|---|---|
| Modelos | `typesafe/jev-1.13`, `typesafe/jev-1.14` (listado 2026-10-14), `typesafe/jev-router`, `~typesafe/jev-latest` | openrouter.ai/typesafe |
| Endpoint | `POST https://openrouter.ai/api/alpha/decisions` (**alfa**), no compatible con chat completions | openrouter.ai/typesafe/jev-1.14; blog «What is Jev?» |
| Precio | **USD 0.042 / M entrada; USD 0 salida**; «OpenRouter does not mark up provider pricing» | model page; openrouter.ai/pricing |
| Comisión de plataforma | **5.5 %** sobre compra de créditos (Standard), 8 % (Business); no por petición; intentos fallidos no se cobran | openrouter.ai/pricing |
| Costo reportado | La respuesta de OpenRouter **sí** incluye `usage.cost` (ej. real 2026-10-16: 357 tokens → `1.4994e-05` = 357 × 0.042 / 1e6 exacto; 287 → 1.2054e-05; 354 → 1.4868e-05) | blog «What is Jev?» |
| Proveedor | Un solo proveedor (TypeSafe); «Not currently available through EU in-region routing»; contexto listado 262K (el largo, no el de 64k por defecto) | model page |
| Modelo resuelto | `typesafe/jev-1.14-20261014` (distinto de `jev-1.14.0` directo) → el gate de MainSpot (`evaluatedModels` por `resolvedModel`) no reconocería la variante sin nueva evaluación | blog; `jev-classifier.ts` l. 528 |
| Métricas publicadas (3 d) | Latencia p50 0.10 s; uptime 99.99 %; availability 99.43 % | model page |

Re-verificación 2026-11-03 (auditoría): la página de `jev-1.14` muestra hoy **latencia p50 0.14 s** (ventana móvil de 1 semana; ligera deriva vs 0.10 s del blog, sin discrepancia material), uptime 99.99 % y availability 99.43 % en 3 d — sin cambios. Novedades del listado de TypeSafe en OpenRouter: `typesafe/jev-router` (enrutador sobre Jev, contexto 1M) y `~typesafe/jev-latest`; la FAQ de la página confirma entrada de **texto e imágenes** y endpoint de Decisions (no compatible con chat completions).

Otros «modelos de decisión» en OpenRouter — HECHO VERIFICADO vía la página oficial de rankings de decisión (`openrouter.ai/rankings/decisions`, datos hasta 2026-11-02, semana del 2026-10-26): TypeSafe lidera con **75.1 %** de las peticiones de decisión (Jev 1.13 #1 con 1.02B peticiones/semana; Jev 1.14 #2 con 472M). Alternativas verificadas en el top 10: `perplexity/pplx-decider-v1.2` («Decider V1.2», 159M), `inception/mercury-decide` («Mercury Decide», 64.4M), `openai/gpt-6-luna-decisions` (47.4M), `nace-ai/drex-v1.5` y `nace-ai/drex-max`, `cloudflare/clef-flash` (25.9M), `liquid/d1` y `liquid/d1-ultra`. **Corrección respecto al borrador anterior:** los slugs `upstage/solar-decide`, `cloudflare/clef`, `~perplexity/pplx-decider-flash-latest` y `liquid/d1.1` de la búsqueda inicial no coinciden con el listado real (`clef-flash`, `pplx-decider-v1.2`, `d1`/`d1-ultra`; Upstage no aparece en el top 10). La existencia de una categoría de decisión activa con 8+ autores reduce el riesgo de que el formato desaparezca, pero ningún sustituto ha sido evaluado para MainSpot (ver §8 y Huecos). Relevante para el riesgo de concentración (§8).

---

## 4. Condiciones de datos: DEC-0019 → DEC-0067 y presupuesto DEC-0032

### 4.1 Registros — HECHO VERIFICADO (archivos `.canonflow/decision-records/`)

- **DEC-0019** (2026-10-21): rechazó enviar mensajes reales de clientes a TypeSafe en modo sombra; el comentario literal pedía resolver «políticas de datos personales, minimización, retención y límites de consumo» antes de habilitar datos reales y gestionar esa autorización por separado.
- **DEC-0032** (2026-10-22): presupuesto diario de TypeSafe **USD 1** «en desarrollo y pruebas» (opciones rechazadas: 0.25 y 5). El handoff E2E (`docs/handoffs/mainspot-ai-core-2026-10-30/MAINSPOT-AI-CORE-E2E-HANDOFF.md` l. 24) aclara que **no cubre el runtime productivo**.
- **DEC-0067** (2026-11-03, SOL MAIN d297e8a): autoriza TypeSafe/Jev con datos reales «en desarrollo y después en producción»; **se verifica UNA vez** que el acuerdo vigente cubre el procesamiento previsto, sus condiciones de tratamiento y responsabilidades; tras verificarlo se habilita sin aprobaciones por mensaje; se mantienen aislamiento por negocio, acceso autorizado, minimización razonable, protección de credenciales, trazabilidad y gestión de retención; incompatibilidades se documentan como excepción limitada al tratamiento afectado. Sustituye DEC-0019 y la cláusula de APR-0002. Opciones rechazadas: dossier de privacidad; piloto minimizado con consentimiento.

### 4.2 Qué falta para la «verificación única de términos/DPA» — lista propuesta (no es decisión)

| # | Verificar | Estado hoy | Cómo cerrarlo (sin costo) |
|---|---|---|---|
| 1 | Bajo qué acuerdo está la cuenta/organización TypeSafe de MainSpot (MCA por click-through en consola vs. Order/«Separate Agreement») y quién lo aceptó con autoridad (MCA preámbulo) | DESCONOCIDO (cuenta privada; la clave vigente está en `~/.config/mainspot/ai-core.env`, no inspeccionable) | Revisar en consola Settings → Organization / Billing; conservar captura fechada |
| 2 | DPA aplicable a datos de México: la DPA pública cubre UE/UK/Suiza vía SCC y define processor «under applicable Data Protection Law» en general; **no menciona la LFPDPPP mexicana** ni transferencias desde México | HECHO VERIFICADO (ausencia) | Opinión legal propia (fuera del alcance técnico) sobre si el contrato de encargado + aviso de privacidad de MainSpot bastan para transferencia internacional a EE. UU. |
| 3 | Retención: sin periodo fijo; **activar ZDR** (gratis, por formulario) y confirmar por email + consola | HECHO VERIFICADO (disponible); activación DESCONOCIDA | Solicitud de soporte con ID de organización; verificar en Settings → Organization |
| 4 | Lista de subencargados y notificación de cambios (DPA §3.2, 15 días para objetar) | DESCONOCIDO (Trust Center requiere acceso) | Solicitar acceso en `trust.typesafe.ai`; archivar lista fechada |
| 5 | Alcance de «classifications» en Telemetry (MCA §4.3) frente a «no content of outputs» (help) | AMBIGUO | Pregunta escrita a support@typesafe.ai |
| 6 | Entrenamiento: no, sin consentimiento previo (MCA §4.1; Privacy; help) | HECHO VERIFICADO | Ninguna acción; registrar cita y fecha |
| 7 | Minimización en el código: `state` = `{ message, rating_stars? }` sin IDs de tenant/autor (AI Core); 8 KiB tope (conversación). Comentarios con PII (teléfonos, correos) **salen** al proveedor, y la pregunta `personal_data` existe precisamente para detectarlos | HECHO VERIFICADO (código) | Decidir si se enmascaran patrones (teléfono/correo) antes de enviar; impacto en la pregunta `personal_data` |
| 8 | Retención local de crudos (`raw.responseText` en `jev_classification`, `ai_invocation`): política de borrado de MainSpot (DEC-0067 «gestión de retención») | DESCONOCIDO (no consultado) | Revisar migraciones/retención con SOL MAIN |
| 9 | Prohibición de destilación (MCA §2.3b) vs. uso de etiquetas de Jev para entrenar un clasificador propio | HECHO VERIFICADO (cláusula) | Decisión explícita: no usar Output de Jev para entrenar modelos sustitutos |
| 10 | Publicidad (MCA §16.4): solicitar por escrito no ser listado si se desea | HECHO VERIFICADO | Email según artículo de help |
| 11 | Presupuesto productivo: DEC-0032 (USD 1/día, desarrollo) y `JEV_MAX_DAILY_BUDGET_USD = 1` + `jevBudgetAllows` global ⇒ a 0.000046/llamada el tope global se agota en ≈ **21,700 clasificaciones/día** (ESTIMACIÓN: 1 / 0.000046) | HECHO VERIFICADO (código) | Nueva decisión del propietario para el runtime productivo (tope global + tope por negocio/día); fuera de esta investigación |

### 4.3 Implicación de DEC-0073 (2026-11-03) — HECHO VERIFICADO (registro leído en SOL MAIN `1f1c7da`)

DEC-0073 («OpenAI para generación de desarrollo; TypeSafe/Jev primario», decidido 2026-11-03T08:06Z, fuente SRC-0011, instrucción explícita del propietario) sustituye, para la configuración actual de desarrollo, la preferencia generativa Anthropic de DEC-0069 por **OpenAI directo en todas las capacidades generativas de texto e imágenes**. Anthropic queda deshabilitado como proveedor (migración `0029`: adaptador conservado, sin rutas activas/canary ni fallback automático); OpenRouter sigue deshabilitado.

**TypeSafe NO se ve afectado.** El registro declara literalmente que «TypeSafe/Jev conserva clasificación semántica primaria» (base DEC-0066/0067) y que «presupuestos, privacidad y gates vigentes no cambian». Consecuencias para esta evidencia:

1. Jev sigue siendo el único clasificador activo; la mecánica de §1 y los términos de §3 conservan vigencia sin cambios.
2. [INFERENCE] Con OpenAI ya contratado e integrado en desarrollo (DEC-0073), el costo incremental de añadir una ruta de clasificación generativa al benchmark §6.1 es cercano a cero en desarrollo (los créditos OpenAI ya existen); el costo real está en calidad/riesgo, no en tokens.
3. DEC-0073 es explícitamente «configuración de desarrollo, no selección comercial irreversible»: no prejuzga ni el proveedor de clasificación ni el generativo para producción; la comparación de §6 sigue siendo insumo para esa decisión futura, no una decisión.

---

## 5. Costo por evento: observado vs. estimado

### 5.1 Tokens por llamada deducidos de los costos observados — ESTIMACIÓN

Fórmula: `tokens = costo_por_caso × 1,000,000 / 0.042`. Los costos de los reportes están redondeados a 6 decimales, por lo que se da el intervalo compatible.

| Caso de uso | Costo/caso observado | Tokens deducidos (central) | Intervalo por redondeo | Bytes JSON de preguntas (MEDICIÓN PROPIA) |
|---|---|---|---|---|
| conversation.intent.classify (run2) | 0.000025 | ≈ 595 | 583–607 | 1,802 B (3 preguntas) |
| conversation.intent.classify (run3, lab-e2e) | 0.000034 | ≈ **810** | 798–821 | 1,802 B |
| engagement.facebook.comment.classify (run2) | 0.000029 | ≈ 690 | 679–702 | 3,245 B (8 preguntas) |
| engagement.facebook.comment.classify (run3) | 0.000046 | ≈ **1,095** | 1,083–1,107 | 3,245 B |
| engagement.google.review.classify (run3) | 0.000046 | ≈ 1,095 | 1,083–1,107 | 3,245 B |
| lab-e2e E15 comentario FB (n=2, 0.000098 total) | 0.000049 | ≈ 1,167 | 1,155–1,178 | 3,245 B |

[INFERENCE] Las diferencias entre corridas del mismo caso (p. ej. 690 vs 1,095 tokens) se explican por la longitud de los comentarios sintéticos de cada suite y, posiblemente, por cambios de la revisión de prompt entre corridas (`route_version: 2` en todas; la versión de prompt no consta en el reporte). Ratio implícito ≈ 3 bytes/token para el bloque de preguntas si el comentario aporta 100–250 tokens: compatible con JSON denso en inglés.

Nota de método: en el repo el costo es `estimated` (tokens reportados × 0.042), por lo que «observado» aquí significa **tokens observados × precio verificado**, no factura del proveedor. Conciliar con la consola de TypeSafe (saldo de créditos) cerraría el hueco sin gasto adicional.

**Actualización con tokens medidos (`evidence/lab-traces.md`, MEDICIÓN PROPIA histórica, incorporada en la auditoría 2026-11-03):** la tabla `ai_invocation` trae los tokens exactos por invocación exitosa del 2026-10-30, que sustituyen la deducción por redondeo de arriba:

| Caso de uso | Tokens in prom. (éxitos) | Tokens out | USD prom./éxito | p50 / p95 ms | Éxitos / invocaciones |
|---|---|---|---|---|---|
| conversation.intent.classify (jev-1.14.0, TS) | **804** | 140 | 0.000034 | 729 / 866 | 20 / 30 |
| engagement.facebook.comment.classify (jev-1.14.0, TS) | **1,158** | 265 | 0.000049 | 750 / 919 | 41 / 70 |
| engagement.google.review.classify (jev-1.14.0, TS) | **1,158** | 265 | 0.000049 | 763 / 966 | 34 / 60 |

La deducción de la tabla anterior (1,095 tokens para comentario) subestimaba ≈ 5 % el valor medido (1,158) por el redondeo de los reportes a 6 decimales; la fila `lab-e2e` E15 (1,167 deducidos) sí cae dentro del rango medido. **Para todo cálculo económico usar los tokens medidos (804 / 1,158), no los deducidos.**

**Fiabilidad:** 95/160 invocaciones Jev del laboratorio fueron exitosas (65 fallidas). El costo por caso de los reportes solo cuenta éxitos: en las tres filas «USD total (incl. fallos con costo) / éxitos» = «USD prom./éxito», es decir, las invocaciones fallidas **no consumieron tokens facturables** (HECHO VERIFICADO sobre la tabla de lab-traces). El motivo de los fallos (credencial/HTTP del entorno de laboratorio, no del proveedor) procede del contexto del handoff — SNIPPET, no verificado fila a fila en esta auditoría.

### 5.2 Costo por evento y por cliente/mes — ESTIMACIÓN

Supuestos: 0.042 USD/MTok; comentario/reseña ≈ 1,100 tokens/llamada; mensaje del dueño ≈ 810 tokens/llamada; factor de reintento 1.0 (TypeSafe no cobra peticiones fallidas; los reintentos exitosos sí consumen tokens pero el cliente solo reintenta en 429/5xx, raros fuera de incidentes).

| Escenario mensual por cliente | Comentarios + reseñas | Mensajes del dueño | Costo Jev / mes (USD) | Fórmula |
|---|---|---|---|---|
| BAJO | 20 | 50 | **0.0026** | 20×0.000046 + 50×0.000034 |
| MEDIO | 150 | 300 | **0.0171** | 150×0.000046 + 300×0.000034 |
| ALTO | 1,000 | 1,500 | **0.097** | 1,000×0.000046 + 1,500×0.000034 |
| EXTREMO / abuso | 10,000 | 10,000 | **0.80** | 10,000×0.000046 + 10,000×0.000034 |

Incluso el caso extremo es < USD 1/mes por cliente. Con los tokens medidos de `lab-traces.md` (comentario 1,158 in ⇒ 0.000049, intención 804 ⇒ 0.000034) los importes suben ≈ 6 % en las filas con comentarios; el orden de magnitud no cambia. Para 1,000 clientes en escenario MEDIO: ≈ USD 17/mes (ESTIMACIÓN). La clasificación **no es** un factor relevante del margen; lo son la redacción (generativo) y las imágenes. Si se añade una segunda llamada por evento (p. ej. re-chequeo de confianza o «guardrail» sobre la respuesta generada), duplicar.

Tope DEC-0032 (USD 1/día global) ⇒ ≈ 21,700 clasificaciones/día a 0.000046; equivale a ≈ 650k/mes. Suficiente para laboratorio; inadecuado como control productivo porque es global y no por negocio (§4.2 #11).

---

## 6. Comparación en papel: Jev vs. clasificador generativo con salidas estructuradas — ESTIMACIÓN (NO MEDIDO)

Precios oficiales leídos el 2026-11-03 (HECHO VERIFICADO):

| Modelo | Entrada USD/MTok | Salida USD/MTok | Caché de prefijo (lectura) | Batch (entrada/salida) | Fuente |
|---|---|---|---|---|---|
| Claude Haiku 5.5 (≤100k tokens de prompt) | 0.10 | 0.50 | 0.01 (0.1×); escritura 5 min 0.125 | 0.05 / 0.25 | platform.claude.com/docs/en/about-claude/pricing |
| GPT-6 Luna (`gpt-6-luna`, contexto corto) | 0.10 | 0.50 | 0.01 | 0.05 / 0.25 (Batch y Flex) | developers.openai.com/api/docs/pricing |
| GPT-6 Luna vía **Decisions API** (`gpt-6-luna-decisions`, beta 2026-10-06) | 0.10 | **0 (no se cobra)** | tarifas de caché de Luna | — | developers.openai.com/api/docs/guides/decisions (verificado en `evidence/openai.md` §3.7) |
| ~~GPT-5-nano~~ (CORREGIDO en auditoría) | — | — | — | — | **No es candidata**: `gpt-5-nano` original apagado el 2026-12-11 y `gpt-5.4-nano` deprecado (0.20/1.25, apagado 2027-04-01) según `evidence/openai.md` §F7/§3.1; el borrador citaba 0.05/0.40, precio del nano ya apagado |
| Jev 1.14.0 | 0.042 | 0 | n/a (no hay caché) | n/a | docs.typesafe.ai/models |

Nota (corregida en auditoría): no existe en la página de OpenAI un modelo llamado «GPT-6 nano»; el más barato de la familia 6 es `gpt-6-luna`. El «nano» de la generación anterior ya no es utilizable (`gpt-5-mini`/`gpt-5-nano` apagados 2026-12-11; `gpt-5.4-nano` deprecado a 0.20/1.25) — `evidence/openai.md` [F1][F7]. El sustituto estructural de Jev dentro de OpenAI es la **Decisions API**, no un modelo chat más barato.

Perfil de tokens de una clasificación equivalente (HIPÓTESIS razonada, no medida): instrucciones + criterios equivalentes a las 8 preguntas de Jev ≈ 700–900 tokens; esquema JSON de salida (8 campos, enumeraciones) ≈ 250–350 tokens; comentario 60–300 tokens; salida JSON ≈ 100–150 tokens. Se usa **entrada 1,200 / salida 120** como punto medio; prefijo cacheable ≈ 1,000 tokens.

| Opción | Costo por comentario (USD) | Fórmula | Múltiplo vs Jev |
|---|---|---|---|
| **Jev 1.14.0 (MEDIDO, lab-traces: 1,158 tok in)** | **0.000049** | 1,158 × 0.042/1e6 | 1.0× |
| **Jev, mensaje del dueño (MEDIDO: 804 tok in)** | **0.000034** | 804 × 0.042/1e6 | — |
| Haiku 5.5 / GPT-6 Luna, sin caché, tiempo real | **0.000180** | 1,200×0.10/1e6 + 120×0.50/1e6 = 0.00012 + 0.00006 | **3.7×** |
| Haiku 5.5 / GPT-6 Luna, con caché de prefijo (1,000 tok) | **0.000090** | 1,000×0.01/1e6 + 200×0.10/1e6 + 120×0.50/1e6 = 0.00001+0.00002+0.00006 | **1.8×** |
| Haiku 5.5 / GPT-6 Luna, Batch (50 %), sin caché | 0.000090 | 1,200×0.05/1e6 + 120×0.25/1e6 | 1.8× (no tiempo real) |
| Haiku 5.5 / GPT-6 Luna, Batch + caché | ≈ 0.000045 | 1,000×0.005/1e6 + 200×0.05/1e6 + 120×0.25/1e6 | ≈ 0.9× (no tiempo real; caché 5 min difícil de sostener en batch) |
| **OpenAI Decisions API (`gpt-6-luna-decisions`), sin caché** | **0.000120** | 1,200 × 0.10/1e6 (salida no se cobra) | **2.4×** |

Nota sobre la Decisions API de OpenAI (HECHO VERIFICADO en `evidence/openai.md` §3.7 [F32]): `POST /v1/decisions` con `gpt-6-luna` (único modelo), beta desde 2026-10-06, respuestas tipadas (`choice`, `score`, probabilidad), hasta 400 preguntas por petición, ~10× más rápido que Responses según OpenAI, ZDR/HIPAA elegibles. Es el reemplazo estructural más cercano a Jev dentro de un proveedor que DEC-0073 ya tiene contratado e integrado en desarrollo; con el perfil medido de Jev (1,158 tok) costaría 0.000116/evento ≈ 2.4×. **NO MEDIDO** en calidad para MainSpot; las cachés de Luna (mínimo 1,024 tokens) apenas aplican a este perfil.

Factores no capturados por el precio (cualitativos, con evidencia):

| Factor | Jev | Generativo barato | Evidencia |
|---|---|---|---|
| Garantía de tipo | «No type errors… mathematically impossible» (blog); `validateResponse` nunca falló en las corridas leídas | Structured outputs reducen pero no eliminan JSON inválido; el repo ya contempla `repair_attempts` para texto (`catalog.ts` l. 290); MainSpot observó el límite de 16 uniones en Anthropic para esquemas grandes (contexto de la tarea) | HECHO VERIFICADO / contexto |
| Probabilidades calibradas por opción + `confidence` | Sí, nativo; MainSpot ya umbraliza (`JEV_MIN_PROBABILITY 0.7`, `RISK_THRESHOLD 0.5`) | Hay que pedir una «confianza» en el JSON; TypeSafe afirma que los LLM tienden a ser sobreconfiados (blog; afirmación del proveedor) | HECHO VERIFICADO (código) / afirmación de parte |
| Latencia | Lab: p50 213–750 ms, p95 356–966 ms fuera de incidente; proveedor: 70–500 ms | Lab (tareas de redacción, no clasificación): Haiku 5.5 p50 1.7–3.2 s | HECHO VERIFICADO (evidence) |
| Calidad en español | Lab: sentimiento 89.5 % (umbral 85 % superado), 16/20 exactos, 0 riesgos omitidos (n=20); fallos: 3 etiquetas reproduciblemente erróneas de 20 (sarcasmo/mixto, `sugg1`, `pii1`); TypeSafe advierte menor precisión fuera del inglés | NO MEDIDO con el mismo conjunto | HECHO VERIFICADO (evidence) |
| Inyección de instrucciones | docs: «State is data, and Jev does not treat it as hostile by default… can move the answer»; lab `inject1` falló en sentimiento (mixed ≠ negative) | También vulnerable; mitigable con system prompt | HECHO VERIFICADO |
| Orden de opciones | docs: puede sesgar hacia la primera opción; MainSpot ordena intents con prioridad explícita en `notes` | Menos documentado | HECHO VERIFICADO |
| Un proveedor extra | Con DEC-0073 los proveedores activos son OpenAI (generación) + TypeSafe (clasificación); Anthropic quedó deshabilitado. Jev añade un segundo contrato/DPA que verificar (§4.2) | Clasificar con Luna/Luna-Decisions reduciría el stack a un solo proveedor y un solo DPA; a cambio se perderían probabilidades calibradas nativas y la garantía de tipo | Análisis |

Lectura: en costo puro de tiempo real, Jev es ≈ 1.8–3.7× más barato que el generativo más barato y ≈ 2.4× más barato que la Decisions API de OpenAI (con salida gratis, el sustituto estructural más cercano), pero la diferencia absoluta (≈ USD 0.00004–0.00013 por evento) es irrelevante frente al margen por cliente (§5.2). Con DEC-0073, OpenAI ya está contratado e integrado en desarrollo, así que el argumento «un proveedor extra» pesa ahora a favor de probar `gpt-6-luna-decisions` y en contra de mantener TypeSafe — sin que ninguna decisión vigente (DEC-0066/0067/0073) autorice cambiar el clasificador. La decisión debe basarse en **calidad medida sobre el mismo conjunto etiquetado en español (B-CLS, §6.1), calibración de umbrales, latencia p95 y el costo de operar o retirar un proveedor adicional**, no en el precio por token.

### 6.1 Plan de medición (NO MEDIDO; requiere autorización de gasto) — propuesta de benchmark **B-CLS** para el entregable `03-quality-benchmarks.md`

Propuesta formal: registrar este plan como benchmark **B-CLS** (clasificación) en `03-quality-benchmarks.md`, junto a B-TXT (texto) y los demás benchmarks de ese entregable. Con DEC-0073, las rutas OpenAI (`gpt-6-luna` chat con structured outputs y/o `gpt-6-luna-decisions`) pueden ejecutarse con la integración directa ya existente en desarrollo; Anthropic directo está deshabilitado (migración `0029`), por lo que la ruta Haiku requeriría reactivación temporal de evaluación o esperar la decisión comercial.

1. Mismo conjunto sintético etiquetado de 200 casos (gate DEC-0031) en español mexicano: comentarios FB, reseñas Google (con estrellas), mensajes del dueño; incluir ironía, negación, mixto, PII, inyección.
2. Rutas a comparar: `ts:jev-1.14.0` (vigente); `gpt-6-luna` con structured outputs (esquema 8 campos + confianza 0–1); `gpt-6-luna` vía Decisions API (respuestas tipadas nativas); opcional Haiku 5.5 con structured outputs (requiere adaptador Anthropic reactivado para evals). Temperatura 0, `max_tokens` 300, 1 reparación.
3. Métricas: exactitud por campo, F1 por clase, falsos negativos de riesgo (`risk_misses` = 0 obligatorio), calibración (ECE sobre `confidence`), p50/p95, tasa de salida inválida, tokens y costo por caso (`reported` vs `estimated`), costo por caso **correcto**.
4. Presupuesto estimado: 200 casos × 4 rutas × ≤ 0.0002 ≈ **USD 0.16** (ESTIMACIÓN), dentro del techo DEC-0068; aun así requiere orden explícita porque el handoff prohíbe gasto en esta investigación.

---

## 7. Recomendaciones técnicas derivadas (propuestas, no decisiones)

1. Mantener `jev-1.14.0` fijado; suscribirse al blog/changelog y a la futura política de deprecación; preparar reevaluación del gate (200 casos) antes de cualquier cambio de versión (el gate ya lo exige por `resolvedModel`).
2. Tratar `meta.cost.source` como `estimated` para TypeSafe y conciliar mensualmente con el saldo de créditos de la consola; etiquetar así en Administration (hoy se presenta como «respuesta del proveedor»).
3. Solicitar **ZDR** antes de datos reales; archivar confirmación. Pedir lista de subencargados.
4. Definir presupuesto productivo por negocio/día además del global (DEC-0032 no aplica a producción).
5. Vigilar 529/timeout: el incidente del 2026-10-30 produjo un timeout y p95 de 10 s en laboratorio; la política «sin Jev ⇒ revisión humana» ya es segura, pero conviene alertar cuando la tasa de `unavailable` supere un umbral.
6. No usar Output de Jev para entrenar modelos propios (MCA §2.3b) sin consentimiento escrito.

---

## 8. Riesgos

| Riesgo | Evidencia | Severidad / mitigación |
|---|---|---|
| **Proveedor pequeño en «early access»** | Blog 2026-09-15: «available today in early access», «we’re still in Jev’s early days»; un solo modelo público (Jev 1.13/1.14); fundador ex-OpenAI; sede SF. Señal de adopción (auditoría 2026-11-03): #1 y #2 en los rankings de decisión de OpenRouter (1.02B + 472M peticiones/semana, 75.1 % de share de la categoría) — la adopción externa es real, pero no sustituye contrato ni SLA | Media. Mitigación: la arquitectura ya degrada a determinista/revisión humana (`decidePrimary`, `ai-semantics.ts`); mantener la ruta generativa como alternativa evaluada (B-CLS, §6.1) |
| **Sin SLA, responsabilidad limitada a USD 50** | MCA §9.3, §12.2 | Alta en papel, baja en impacto: clasificación no bloquea publicar (va a humano). Documentar en el registro de riesgos |
| **Fiabilidad observada del camino Jev en el lab** | 65/160 invocaciones fallidas (credencial/HTTP del entorno de lab, no atribuibles al proveedor; los fallos no consumen tokens — §5.1); incidente de sobrecarga del 2026-10-30 aparte | Media. Antes de primary: medir la tasa de fallo por causa en producción (B-CLS/evals continuos); el fallo de credencial en lab sugiere fragilidad de aprovisionamiento de la clave, no del proveedor |
| **Concentración / lock-in del formato** | API propietaria (`noul/choice/score`); OpenRouter sirve el mismo modelo del mismo proveedor (no es redundancia real). Panorama verificado (§3.8): categoría de decisión activa con 8+ autores alternativos (Perplexity, Inception, OpenAI, Nace.AI, Cloudflare, Liquid), pero ninguno evaluado para MainSpot | Media. El contrato `Questions` de MainSpot es pequeño; adaptadores viables a structured outputs (§6) o a la Decisions API de OpenAI (HECHO VERIFICADO en `evidence/openai.md` §3.7) |
| **Versionado / alias móvil** | Alias cambia sin cambio de código; deprecación 30–60 días anunciada, política formal pendiente; MCA §2.5 permite incompatibilidades | Media. Ya mitigado por pin + gate por modelo resuelto |
| **Precio posiblemente subsidiado** | Blog: «We can’t prove it isn’t subsidized» | Baja en impacto: a 10× el precio seguiría < USD 1/cliente/mes en ALTO (§5.2) |
| **Incidentes de sobrecarga** | 5 incidentes en 90 días; 1 h 15 min el 2026-10-30; «higher rate limit is not a guaranteed fix for overload» | Media. Backoff ya implementado; alertas por tasa de `unavailable` |
| **Datos**: retención sin plazo fijo; procesamiento en EE. UU.; DPA sin cláusula México; subencargados no visibles; telemetría incluye «classifications» | §3.7 | Media. ZDR gratis + verificación única DEC-0067 (§4.2) |
| **Idioma**: inglés primario; español «not equally well» | docs/models; lab 89.5 % sentimiento con n=20 | Media. Gate de 200 casos antes de primary; medir vs generativo |
| **Inyección / contenido adversarial** | docs/model-jaggedness; caso `inject1` falló | Media. Criterios explícitos; umbrales; riesgos deterministas se suman |
| **Cláusula anti-destilación** | MCA §2.3(b) | Baja si se respeta; decisión explícita |
| **Créditos caducan a 12 meses / 402 sin aviso** | MCA §8.2; help | Baja. Auto-recarga + alerta de saldo |
| **Cuenta/organización**: si la cuenta se creó como individuo y no como entidad MainSpot, el MCA liga a quien aceptó | MCA preámbulo | DESCONOCIDO; verificar (§4.2 #1) |

---

## Fuentes

1. TypeSafe AI — «Introducing System One Models & Jev» (blog, 2026-09-15) — https://typesafe.ai/blog/introducing-system-one-models-and-jev — consultado 2026-11-03 — precio 0.042/MTok, salida gratis, latencia 70–500 ms, early access, cardinalidad 255, «can't prove it isn't subsidized».
2. TypeSafe AI — «Jev: For the builders AND dreamers» (blog, 2026-10-14) — https://typesafe.ai/blog/jev-1-14 — 2026-11-03 — jev-1.14.0, alias movido en una semana, avisos de deprecación 60/30 días, danger-zone (imágenes, long context), opt-in de depuración sin entrenamiento.
3. TypeSafe Docs — Models — https://docs.typesafe.ai/models (leído como `models.md`) — 2026-11-03 — tabla de modelos y precios, contexto 64k/32k, long context 262k, rate limits por organización, aliases, sin fine-tuning por cliente, idioma, listado de modelos.
4. TypeSafe Docs — Request rules and errors — https://docs.typesafe.ai/api/errors.md — 2026-11-03 — límites de petición, códigos 400/401/413/415/422/429/529, backoff.
5. TypeSafe Docs — Choice — https://docs.typesafe.ai/primitives/choice.md — 2026-11-03 — «A Choice question accepts up to 255 options», estructura de respuesta, ejemplos de `usage`.
6. TypeSafe Docs — Model changelog — https://docs.typesafe.ai/changelog.md — 2026-11-03 — cambios de Jev 1.14.
7. TypeSafe Docs — Model jaggedness — https://docs.typesafe.ai/model-jaggedness.md — 2026-11-03 — lectura literal, adversarial content, orden de opciones, contexto grande.
8. TypeSafe Docs — Legal — https://docs.typesafe.ai/legal.md — 2026-11-03 — enlaces a DPA/MCA/Privacy; ZDR «for enterprise customers».
9. TypeSafe Docs — índice — https://docs.typesafe.ai/llms.txt — 2026-11-03 — inventario de páginas (sin página de política de deprecación).
10. TypeSafe API — OpenAPI 0.2.0 — https://api.typesafe.ai/openapi.json — 2026-11-03 (descargado con curl, sin autenticación) — esquemas `Usage` (sin `cost`), `SystemOneResponse`.
11. TypeSafe Help — «How much does Jev cost?» — https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost — 2026-11-03 — un plan, créditos prepagados, 402, 100k TPS / 80 RPS, sin créditos gratis, sin cargos por fallo ni mínimos.
12. TypeSafe Help — «What are the rate limits…» — https://help.typesafe.ai/articles/8221043485-what-are-the-rate-limits-and-can-i-get-higher-ones — 2026-11-03 — TPS/RPS, 429.
13. TypeSafe Help — «What is the difference between 429 and 529?» — https://help.typesafe.ai/articles/2769560962-what-is-the-difference-between-429-and-529 — 2026-11-03 — backoff, retry-after, «higher rate limit is not a guaranteed fix for overload».
14. TypeSafe Help — «How is submitted data used or retained?» — https://help.typesafe.ai/articles/5974925716-how-is-submitted-data-used-or-retained — 2026-11-03 — no entrenamiento, propiedad de datos, telemetría, sin retención fija, ZDR gratis, procesamiento en EE. UU.
15. TypeSafe Help — «Do you offer ZDR?» — https://help.typesafe.ai/articles/9520184411-do-you-offer-zdr — 2026-11-03 — ZDR para todas las organizaciones, procedimiento.
16. TypeSafe Help — «Do you offer a DPA/BAA/SCC…» — https://help.typesafe.ai/articles/9159694888-do-you-offer-a-dpa-baa-scc-and-specific-data-residency-options — 2026-11-03 — DPA con SCC UE y UK Addendum; Bedrock/Azure/Vertex sin fecha.
17. TypeSafe — Master Customer Agreement (2026-09-23) — https://typesafe.ai/legal/mca — 2026-11-03 — licencia, restricciones (§2.3), datos (§4), créditos (§8), garantías (§9), terminación (§10), responsabilidad (§12), arbitraje (§15), publicidad/modificaciones (§16).
18. TypeSafe — Data Processing Addendum (2026-04-24) — https://typesafe.ai/legal/data-processing — 2026-11-03 — roles, subencargados, incidentes 72 h, auditoría, SCC UE/UK, Schedule I.
19. TypeSafe — Privacy Policy (2025-11-19) — https://typesafe.ai/legal/privacy-policy — 2026-11-03 — no entrenamiento con Input, retención «as long as reasonably necessary», divulgaciones, hosting en EE. UU.
20. TypeSafe — Enterprise — https://typesafe.ai/enterprise — 2026-11-03 — SOC 2 Type II (bajo solicitud), ZDR «for enterprise customers», no entrenamiento, límites superiores.
21. TypeSafe — Status — https://status.typesafe.ai/ — 2026-11-03 05:55 UTC — uptime 30/60/90 d por servicio y región; incidentes 2026-09-21, 09-23, 09-28, 10-14, 10-30.
22. TypeSafe — Trust Center subprocessors — https://trust.typesafe.ai/subprocessors — 2026-11-03 — **no renderizó contenido** (solo título); lista no obtenida.
23. OpenRouter — TypeSafe models — https://openrouter.ai/typesafe — 2026-11-03 — lista de modelos Jev.
24. OpenRouter — Jev 1.14 model page — https://openrouter.ai/typesafe/jev-1.14 — 2026-11-03 — 0.042/0, 262K, un proveedor, sin EU routing, métricas de latencia/uptime.
25. OpenRouter — Pricing — https://openrouter.ai/pricing (leído como `pricing.md`) — 2026-11-03 — comisión 5.5 %/8 % sobre créditos, sin markup, intentos fallidos no cobrados, SLA solo Enterprise.
26. OpenRouter — «What Is Jev?» (blog, 2026-09-21, actualizado 2026-10-16) — https://openrouter.ai/blog/insights/what-is-jev/ — 2026-11-03 — respuestas reales con `usage.cost`, modelo resuelto `typesafe/jev-1.14-20261014`, tope de 10 niveles en score.
27. Anthropic — Pricing — https://platform.claude.com/docs/en/about-claude/pricing (redirigido desde docs.anthropic.com) — 2026-11-03 — Haiku 5.5 0.10/0.50, caché 0.01, batch 0.05/0.25.
28. OpenAI — API Pricing — https://developers.openai.com/api/docs/pricing (redirigido desde platform.openai.com/docs/pricing) — 2026-11-03 — gpt-6-luna 0.10/0.50, caché 0.01, batch/flex 0.05/0.25; gpt-5-nano 0.05/0.40. **Corrección de auditoría:** la cifra «gpt-5-nano 0.05/0.40» de la lectura original del borrador **no coincide** con `evidence/openai.md` [F1][F7] (gpt-5.4-nano deprecado a 0.20/1.25; gpt-5-nano original apagado 2026-12-11); se asume error de lectura del borrador y la fila GPT-5-nano de §6 fue retirada.
29. Skill local hyper-jev — `/home/administrador/.agents/skills/hyper-jev/SKILL.md`, `cookbook/04-client-operations.md`, `cookbook/05-production.md` — 2026-11-03 — selección de proveedor, reintentos, contabilidad, 255 choices, checklist de producción.
30. Repositorio (worktree research, d440e2a) — `src/jev/client.ts`, `src/conversation/jev-classifier.ts`, `src/engagement/ai-semantics.ts`, `src/ai/dispatcher.ts` l. 421–471, `src/ai/catalog.ts` l. 11–15, 48–71, 161–218, 282, `src/shared/config.ts` l. 23–67, `docs/architecture/ai-core.md` l. 68–86, `evidence/ai-core/evals-lab-run{1,2,3}-*.json`, `evidence/ai-core/lab-e2e.txt`, `.canonflow/decision-records/DEC-0019.md`, `DEC-0032.md` — 2026-11-03.
31. SOL MAIN (solo lectura) — `git --no-optional-locks show d297e8a:.canonflow/decision-records/DEC-0067.md` — 2026-11-03.
32. TypeSafe Docs — Score primitive — https://docs.typesafe.ai/primitives/score — 2026-11-03 (auditoría) — «the API accepts up to 10» niveles (mínimo 2), score = media ponderada de niveles, confianza derivada de la dispersión, niveles descriptivos no numéricos.
33. TypeSafe — Terms of Use del sitio — https://typesafe.ai/legal/terms (2026-09-19) — 2026-11-03 (auditoría, íntegro) — gobierna solo el sitio; Delaware; JAMS consumidor con opt-out 30 días; tope USD 100; los productos/servicios rigen por acuerdo separado (MCA).
34. OpenRouter — Decision Model Rankings — https://openrouter.ai/rankings/decisions — 2026-11-03 (auditoría) — Jev 1.13 #1 (1.02B req.), Jev 1.14 #2 (472M), TypeSafe 75.1 % de share; alternativas `pplx-decider-v1.2`, `mercury-decide`, `gpt-6-luna-decisions`, `drex-v1.5`/`drex-max`, `clef-flash`, `d1`/`d1-ultra`.
35. Re-verificación de auditoría (2026-11-03, subagente `TypeSafeAudit`) de las fuentes 3, 11, 14, 18, 21, 24 y 26: precio 0.042/0 («$42 / $0.042» en docs/models; «$0.042 per million input tokens» en help), facturación con créditos/402/sin créditos gratis, retención sin plazo fijo + ZDR gratis para toda organización, DPA (SCC UE Módulos 2 y 3 + UK Addendum + Suiza, 72 h, 15 días de objeción, auditoría anual, sin México), límites 100k TPS / 80 RPS por organización, uptime 99.858 % (30 d) e incidente «System overload» del 2026-10-30 (1 h 15 min, resuelto 21:15 UTC), OpenRouter $0.042/$0 con un proveedor y sin EU routing — **sin discrepancias** con lo registrado arriba, salvo la deriva de latencia p50 de OpenRouter (0.10 → 0.14 s, ventana móvil) anotada en §3.8.
36. `evidence/lab-traces.md` (2026-11-03) — tokens medidos 804/1,158, USD 0.000034/0.000049 por éxito, p50 729–763 ms, p95 866–966 ms, 95/160 éxitos Jev (MEDICIÓN PROPIA histórica).
37. SOL MAIN (solo lectura) — `git --no-optional-locks show 1f1c7da:.canonflow/decision-records/DEC-0073.md` — 2026-11-03 (auditoría) — OpenAI generativo de desarrollo; «TypeSafe/Jev conserva clasificación semántica primaria»; Anthropic deshabilitado (migración 0029); OpenRouter deshabilitado; «configuración de desarrollo, no selección comercial irreversible».

## Huecos

1. **Campo `cost` en la respuesta live de TypeSafe**: la OpenAPI no lo define; no se pudo confirmar si la API lo añade (prohibido consultar BD / hacer llamadas). Verificación sin costo: leer `raw.responseText` de una fila existente de `jev_classification` o `ai_invocation` (SOL MAIN) y comprobar `meta.cost.source`.
2. **Lista de subencargados** (`trust.typesafe.ai/subprocessors`): requiere acceso/JS. Verificación: solicitar acceso al Trust Center o pedirla a support@typesafe.ai.
3. **Acuerdo aplicable a la cuenta de MainSpot** (MCA click-through vs. Order; aceptante; organización): información privada de la consola; verificación por el propietario.
4. **Cobertura legal en México** (LFPDPPP, transferencia internacional): la DPA no la menciona; requiere opinión legal, fuera del alcance técnico.
5. **ZDR activada o no** en la organización de MainSpot: verificar en Settings → Organization tras solicitarla.
6. **Significado de «classifications» en Telemetry** (MCA §4.3): pregunta escrita al proveedor.
7. **Política formal de deprecación**: anunciada, no publicada; revisar docs/blog periódicamente.
8. **Factura real vs. estimación**: conciliar tokens × 0.042 con el consumo de créditos en la consola (sin costo adicional).
9. **~~Tokens exactos por llamada~~ CERRADO 2026-11-03 (auditoría)**: `lab-traces.md` extrajo `usage` de `ai_invocation`: **804** tokens in (intención) y **1,158** (comentario/reseña) por invocación exitosa (§5.1). Queda solo la conciliación con la consola (hueco 8).
10. **Calidad comparativa Jev vs Haiku 5.5 / GPT-6 Luna (chat y Decisions API) en español**: NO MEDIDO; plan formalizado como benchmark **B-CLS** en §6.1 para `03-quality-benchmarks.md` (≈ USD 0.16, requiere autorización; las rutas OpenAI ya están disponibles por DEC-0073).
11. **~~Otros modelos de decisión en OpenRouter~~ CERRADO 2026-11-03 (parcial)**: rankings oficiales leídos (fuente 34); slugs del borrador corregidos (`pplx-decider-v1.2`, `clef-flash`, `d1`/`d1-ultra`; `upstage/solar-decide` no está en el top 10). Precios y calidad de cada alternativa: sin leer (páginas por modelo) — solo necesarios si se decide evaluar la reducción de concentración.
12. **SOC 2 Type II**: anunciado; informe no revisado (bajo solicitud).
13. **~~Términos de uso del sitio~~ CERRADO 2026-11-03 (auditoría)**: leídos íntegros (fuente 33); gobiernan solo el sitio — la API sigue gobernada por el MCA («separate agreement», §13). Sin impacto para MainSpot.
14. **Motivo exacto de las 65 invocaciones Jev fallidas del lab** (§5.1): el conteo está verificado en `lab-traces.md`; la atribución a credencial/HTTP procede del contexto del handoff y no se verificó fila a fila (los registros de error estarían en `ai_invocation.error`/lab-history). Verificación sin costo: agrupar `ai_invocation` de 2026-10-30 por `status_code`/error para los 3 casos Jev.
