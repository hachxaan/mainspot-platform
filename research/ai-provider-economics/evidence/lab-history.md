# Historial del laboratorio AI Core — evidencia existente (2026-10-30)

Fecha de análisis: 2026-11-03. Rama: `research/ai-provider-economics-2026-11` (HEAD d440e2a). Fuente: `evidence/ai-core/` del worktree (commits 878f7de y cf70bc1, ambos del 2026-10-30). Este documento **solo reinterpreta evidencia ya registrada**; no se ejecutó ninguna llamada a proveedores ni consulta a la base de datos. Dataset tabular: `lab-history.csv` (55 filas: 45 filas de suites de evaluación + 10 filas del recorrido E2E).

> **Actualización 2026-11-03 (integrador):** los tokens, intentos de reparación y fallos con costo **sí** constan en `ai_invocation` y se extrajeron con una consulta de solo lectura: ver `lab-traces.md` y `lab-invocations.csv`. Esos datos sustituyen la derivación de tokens con hipótesis 4:1 de §4 y aclaran que «DeepSeek 0/5» fue `circuit_open` (sin petición), no un fallo de calidad.

Etiquetas: **HECHO VERIFICADO** = leído en el archivo de evidencia o en el código fuente del worktree; **ESTIMACIÓN** = cálculo propio con fórmula explícita; **HIPÓTESIS** = supuesto no observado; **DESCONOCIDO** = no consta en la evidencia.

## 1. Qué contiene la evidencia y qué significa cada campo

| Archivo | `generated_at` (UTC) | Contenido | Proveedores reales |
|---|---|---|---|
| `evals-lab-run1.json` | 2026-10-30T20:35:08Z | 33 filas suite×ruta: 16 casos de uso, 7 modelos | `real_providers: true` |
| `evals-lab-run2-*.json` (6 archivos) | 20:40:36Z – 20:43:31Z | 9 filas: repetición de Jev (3 suites) y de compose/creatives/insights (2 modelos cada una) | sí |
| `evals-lab-run3-*.json` (3 archivos) | 20:45:50Z – 20:46:59Z | 3 filas: tercera repetición de las 3 suites Jev | sí |
| `lab-e2e.txt` | 2026-10-30T22:15:31Z | Recorrido E2E con negocio sintético «Café Brisa Lab»; tabla E15 por caso de uso×modelo leída de `ai_invocation` (`status = 'succeeded'`) | sí |
| `screens/` | — | 22 PNG (capturas UI y sitios: `site-v1-{360,768,1440}`, `site-v2-1440`, `eval-diseno-{cafe,taller,estetica}-1440`, `own-01..09`, `adm-01/02/02a`, `eng-03`) | solo inspección visual, sin métricas |

Semántica de los campos (**HECHO VERIFICADO** en `src/ai/evals.ts:259-388` y `src/ai/dispatcher.ts:206-301`):

- `cases` / `passed` / `pass_rate`: casos de la suite y casos con `pass=true`. `status` compara `pass_rate` con `min_pass_rate` de la suite (y `min_sentiment_accuracy`, `max_risk_misses` en las suites Jev de sentimiento).
- `latency_p50_ms` / `latency_p95_ms`: percentil *nearest-rank* (`ceil(p·n)-1`) **solo sobre las invocaciones con `res.ok`** (`evals.ts:259-263, 359-361`). Los casos con fallo de proveedor no aportan latencia.
- `cost_usd`: suma de `res.costUsd` **solo de invocaciones `ok`**; `cost_per_case_usd = cost_usd / cases` (divide entre todos los casos, incluidos los que fallaron sin costo). Un caso `ok` que luego falla la rúbrica (p. ej. «contiene «30%»») sí cuenta costo. Un caso `invalid_output` (schema no cumplido tras la reparación) **no** cuenta su costo aunque sí lo gastó.
- Procedencia del costo: el dispatcher usa `usage.costUsd` del proveedor cuando existe (`cost_source='reported'`) y solo si falta estima con `MODEL_SEEDS.pricing` (`dispatcher.ts:208-217`). El adaptador OpenRouter mapea `usage.cost` de la respuesta (`providers/openrouter.ts:122`); el cliente Jev usa `usage.cost` de TypeSafe (`src/jev/client.ts:271-277`). Los JSON de evaluación **no incluyen `cost_source` por caso** (el array `results` no se exportó) → en el CSV se marca `REPORTED_INFERRED`. `lab-e2e.txt` declara explícitamente «procedencia: respuesta del proveedor» → `REPORTED_PROVIDER`.
- Reparaciones: `invokeStructured` admite `repair_attempts` (por defecto 1) y acumula el `usage` de todos los intentos en una sola invocación (`dispatcher.ts:275-300`); el número de intentos se guarda en `ai_invocation.validation.attempts`, **no** en los archivos de evidencia → columna `repairs = NA` (**DESCONOCIDO**; se verificaría consultando `ai_invocation` en la BD del laboratorio).
- Tokens: el `usage` (inputTokens/outputTokens) se guarda en `ai_invocation.usage`, pero **ningún archivo de evidencia lo exporta** → los tokens de este informe son ESTIMACIÓN (§4).
- Códigos de fallo en `failures[].notes`: `código: razón` cuando la invocación no fue `ok` (`provider_auth`, `provider_unavailable: JevHttpError|TimeoutError|rate_limited|bad_request`, `blocked_external: provider_account_policy`, `invalid_output: …`); texto libre cuando fue `ok` pero falló la rúbrica (`contiene «…»`, `cifra sin fuente: …`, `sentimiento X ≠ Y`, `categoría X ≠ Y`).
- En `lab-e2e.txt`, `r4/p1` = `route_version 4 / prompt_version 1` (`scripts/ai-core-lab-e2e.ts:201`), no «4 reintentos».

## 2. Taxonomía de fallos observados

| Categoría (CSV `fail_reasons`) | Nota literal | Significado | Dónde apareció |
|---|---|---|---|
| `provider_auth` | `provider_auth: auth` | Credencial TypeSafe rechazada; 0 llamadas útiles, costo 0 | run1: las 3 suites Jev (48 casos) |
| `provider_unavailable:JevHttpError` | `provider_unavailable: JevHttpError` | HTTP no-2xx de TypeSafe tras agotar `maxAttempts` | run2: intent 2/8, comment 8/20, review 5/20 |
| `timeout` | `provider_unavailable: TimeoutError` | Deadline del cliente Jev | run2 review (mixed1); run3 comment y review (mixed1) |
| `rate_limited` | `provider_unavailable: rate_limited` | 429 vía OpenRouter | run1 compose Haiku (2/3 casos) |
| `bad_request` | `provider_unavailable: bad_request` | 4xx del proveedor final. `docs/architecture/ai-core.md:93` lo atribuye al esquema de parche con 17 uniones frente al límite de 16 de Anthropic | run1 edit.simple Haiku 5/5, edit.complex Haiku 2/2 |
| `guardrail:provider_account_policy` | `blocked_external: provider_account_policy` | Guardrail del workspace OpenRouter: bloqueo **antes** de llamar (costo 0, `wall_ms` < 2 s) | run1: Sonnet 5.5 (design 3, edit.complex 2) y los 3 modelos de imagen (6 casos) |
| `schema:invalid_output` | `invalid_output: la salida no es JSON` / `$.budget.rationale: longer than 300` | JSON no válido o viola el schema tras la reparación; **costo gastado pero no contabilizado** | run1 calendar Haiku 1/1; run1 campaign.plan Haiku 1/2 |
| `domain_rule` | `contiene «30%»`, `contiene «2x1»`, `cifra sin fuente: 7` | Regla de dominio de la rúbrica (promoción no confirmada, cifra sin fuente) sobre una salida válida | run1: creatives (Luna y Haiku), compose Luna, insights (Luna y Haiku) |
| `label_mismatch` | `sentimiento mixed ≠ negative`, `categoría basic_info ≠ question_other` | Etiqueta Jev distinta de la esperada (exactitud de clasificación) | run2/run3 comment y review: `sugg1`, `inject1`, `pii1` |

**HECHO VERIFICADO**: ninguna suite registró `risk_misses > 0` (riesgos omitidos = 0 en todas las corridas Jev con datos).

## 3. Resumen por caso de uso — mejor evidencia (última corrida) por modelo

Convenciones: `éxitos/casos` de la última corrida de esa combinación; **USD/éxito = cost_usd / passed** (ESTIMACIÓN a partir de totales reportados); `USD/llamada ok = cost_usd / llamadas ok` (llamadas ok = casos − fallos de proveedor/schema). p50/p95 en ms sobre llamadas ok. Proveedor: OR = OpenRouter (no es proveedor directo), TS = TypeSafe directo.

### 3.1 Clasificación (TypeSafe/Jev directo)

| Caso de uso | Modelo | Corrida | Éxitos/casos | USD/éxito | USD/llamada ok | p50 / p95 ms | Extra |
|---|---|---|---|---|---|---|---|
| conversation.intent.classify | ts:jev-1.14.0 | run3 | 8/8 | 0.000034 | 0.000034 | 773 / 920 | E2E n=1: 0.000034, 308 ms |
| engagement.facebook.comment.classify | ts:jev-1.14.0 | run3 | 16/20 | 0.000058 | 0.000049 (19 ok) | 750 / 919 | sentiment_accuracy 0.895 (umbral 0.85); risk_misses 0; E2E n=2: 0.000049/llamada, p95 356 ms |
| engagement.google.review.classify | ts:jev-1.14.0 | run3 | 16/20 | 0.000058 | 0.000049 (19 ok) | 752 / 10021 | sentiment_accuracy 0.895; risk_misses 0; p95 de 10 s = una llamada ok lenta (reintentos del cliente Jev, **HIPÓTESIS**) |

Evolución Jev: run1 0/48 (`provider_auth`, credencial), run2 28/48 (15 `JevHttpError` + 1 timeout + 4 etiquetas), run3 40/48 (2 timeouts + 6 etiquetas). Los fallos persistentes en run3 son los mismos 3 ids en ambas suites (`sugg1` sentimiento, `pii1` categoría, `inject1` sentimiento) más `mixed1` por timeout: es decir, 3 de 20 etiquetas esperadas no coinciden de forma reproducible y 1 caso no llegó a clasificarse.

### 3.2 Texto (vía OpenRouter)

| Caso de uso | Modelo (OR) | Corrida | Éxitos/casos | USD/éxito | p50 / p95 ms | Observaciones |
|---|---|---|---|---|---|---|
| website.initial.design | claude-haiku-5.5 | run1 | 3/3 | 0.001847 | 17736 / 23250 | 3 firmas de diseño distintas; E2E n=1: 0.002224, 16474 ms |
| website.initial.design | gpt-6-luna | run1 | 3/3 | 0.001113 | 13415 / 15266 | — |
| website.initial.design | claude-sonnet-5.5 | run1 | 0/3 | — | — | guardrail OpenRouter, sin llamada |
| website.edit.simple | gpt-6-luna | run1 | 5/5 | 0.000217 | 2857 / 14119 | — |
| website.edit.simple | claude-haiku-5.5 | run1 | 0/5 | — | — | `bad_request` ×5 (límite de uniones del schema) |
| website.edit.complex | gpt-6-luna | run1 | 2/2 | 0.001043 | 5157 / 18979 | E2E n=1: 0.000542, 8588 ms |
| website.edit.complex | claude-haiku-5.5 | run1 | 0/2 | — | — | `bad_request` ×2 |
| website.edit.complex | claude-sonnet-5.5 | run1 | 0/2 | — | — | guardrail |
| conversation.owner.assistant | claude-haiku-5.5 | run1 | 3/3 | 0.000773 | 9888 / 12204 | E2E n=2: 0.000629/llamada, p95 11954 ms |
| conversation.owner.assistant | gpt-6-luna | run1 | 3/3 | 0.000356 | 3310 / 13186 | — |
| social.facebook.post.compose | claude-haiku-5.5 | run2 | 3/3 | 0.001642 | 13129 / 14604 | run1: 1/3 (2 `rate_limited`); E2E n=1: 0.001111, 10122 ms |
| social.facebook.post.compose | gpt-6-luna | run2 | 3/3 | 0.000457 | 4584 / 7354 | run1: 2/3 (`contiene «2x1»`) |
| engagement.facebook.comment.reply | claude-haiku-5.5 | run1 | 4/4 | 0.000221 | 1713 / 3198 | E2E n=2: 0.000267/llamada, p95 2816 ms |
| engagement.facebook.comment.reply | gpt-6-luna | run1 | 4/4 | 0.000157 | 2483 / 3782 | — |
| engagement.google.review.reply | claude-haiku-5.5 | run1 | 4/4 | 0.000233 | 1228 / 3543 | — |
| engagement.google.review.reply | gpt-6-luna | run1 | 4/4 | 0.000155 | 1974 / 3992 | — |
| marketing.campaign.plan | gpt-6-luna | run1 | 2/2 | 0.000779 | 6652 / 9648 | E2E n=1: 0.000684, 8467 ms |
| marketing.campaign.plan | claude-haiku-5.5 | run1 | 1/2 | 0.001980 | 15160 / 15160 | `invalid_output` (rationale > 300 chars); costo del caso fallido no contabilizado |
| marketing.campaign.creatives | claude-haiku-5.5 | run2 | 2/2 | 0.001149 | 4998 / 12777 | run1: 1/2 (`contiene «30%»`); E2E n=1: 0.002106, 19199 ms |
| marketing.campaign.creatives | gpt-6-luna | run2 | 2/2 | 0.000580 | 5804 / 8620 | run1: 1/2 (`contiene «30%»`) |
| business.insights.generate | claude-haiku-5.5 | run2 | 2/2 | 0.000520 | 1563 / 6454 | run1: 1/2 (`cifra sin fuente: 7`) |
| business.insights.generate | gpt-6-luna | run2 | 2/2 | 0.000336 | 3679 / 7922 | run1: 1/2 (misma nota) |
| editorial.calendar.suggest | gpt-6-luna | run1 | 1/1 | 0.001124 | 14939 / 14939 | E2E n=1: 0.000497, 7135 ms |
| editorial.calendar.suggest | claude-haiku-5.5 | run1 | 0/1 | — | — | `invalid_output: la salida no es JSON` |

Lecturas transversales (**HECHO VERIFICADO** sobre estas cifras):

- En todas las suites de texto donde ambos pasaron, GPT-6 Luna costó entre 0.28× y 0.71× lo que Haiku 5.5 por éxito (compose 0.000457 vs 0.001642 = 0.28×; assistant 0.46×; creatives 0.50×; insights 0.65×; comment.reply 0.71×; review.reply 0.67×). Con el mismo precio de catálogo (0.1/0.5 USD/Mtok para ambos en `MODEL_SEEDS`), la diferencia solo puede venir de más tokens generados/consumidos por Haiku o de un precio real distinto al del catálogo (**DESCONOCIDO**: sin `usage` exportado no se puede separar).
- Haiku 5.5 vía OpenRouter solo obtuvo llamadas ok en 8 de los 11 casos de uso de texto del catálogo: edición web (simple y compleja) y calendario fallaron por `bad_request`/`invalid_output`, no por calidad de contenido.
- Latencias p95 de 12–23 s en diseño, compose, assistant y creatives con Haiku; Luna entre 7 y 19 s. Ninguna medición es directa a Anthropic/OpenAI: incluye el enrutamiento de OpenRouter.
- Las fallas `domain_rule` de run1 (promoción inventada «30%»/«2x1», cifra sin fuente) desaparecieron en run2 para los mismos modelos; entre run1 y run2 pudo cambiar prompt o ruta (`route_version` 2→3 en Haiku) — la evidencia no documenta qué cambió (**DESCONOCIDO**).

### 3.3 Imágenes — SIN MEDICIÓN

| Caso de uso | Modelos probados (OR) | Resultado |
|---|---|---|
| website.image.generate | bytedance-seed/seedream-5-0-flash, google/gemini-3.1-flash-lite-image, microsoft/mai-image-2.6-flash | 0/1 cada uno: `blocked_external: provider_account_policy` (guardrail), costo 0, sin llamada |
| social.facebook.image.generate | los mismos 3 | 0/1 cada uno, idéntico |
| E2E | — | `imágenes 1 · bloqueadas ["hero:no_active_route","about:no_active_route"]`: la página se publicó con 1 foto propia de la biblioteca; las 2 imágenes IA solicitadas por el diseño no tenían ruta activa |

Conclusión: **no existe ninguna medición de costo, latencia, resolución ni calidad de imágenes generadas**. `gpt-image-2` (DEC-0069) nunca fue invocado en este laboratorio (no aparece en `MODEL_SEEDS` ni en la evidencia).

### 3.4 Capacidades sin ninguna evidencia

| Capacidad | Estado en evidencia |
|---|---|
| Generación de imágenes (web y Facebook) | NO MEDIDO (guardrail) |
| Edición/adaptación de imágenes existentes | NO EXISTE como caso de uso en `USE_CASE_SEEDS`; sin medición |
| Orquestación/enrutamiento explícito, fallbacks entre proveedores | No hay caso de uso; el único enrutamiento medido es Jev `edit_scope` → ruta simple/compleja (E2E E06, 1 evento) |
| Conversaciones multi-turno del asistente | Suite de 3 preguntas de 1 turno con herramientas stub; E2E 2 llamadas. Sin medición de turnos acumulados |
| Claude Sonnet 5.5, Gemini 4 Argon, GPT-6.1 Sol, DeepSeek V4.1 Flash | Sonnet: bloqueado por guardrail (0 llamadas). Argon, Sol: sin filas. DeepSeek: `docs/architecture/ai-core.md:93` cita «DeepSeek 0/5» en edit.simple pero **no hay fila en los JSON** (discrepancia documentación↔evidencia) |
| Anthropic directo / OpenAI directo | 0 mediciones: toda la evidencia de texto es vía OpenRouter |
| Reparaciones por invocación, tokens por llamada, costo máximo/mediano por llamada | No exportados (están en `ai_invocation` de la BD del laboratorio) |

## 4. Derivación de tokens (ESTIMACIÓN) y fórmulas

Ningún archivo de evidencia incluye tokens. Precios del catálogo `src/ai/catalog.ts` `MODEL_SEEDS` (observados por SOL MAIN el 2026-10-30 en el catálogo público de OpenRouter; TypeSafe 2026-10-20; el propio código los llama «estimaciones de respaldo»):

| model_id | input USD/Mtok | output USD/Mtok |
|---|---|---|
| or:openai/gpt-6-luna | 0.1 | 0.5 |
| or:anthropic/claude-haiku-5.5 | 0.1 | 0.5 |
| or:anthropic/claude-sonnet-5.5 | 2 | 10 |
| ts:jev-1.14.0 | 0.042 | 0 |

Fórmulas:

- Costo por llamada ok: `c = cost_usd / llamadas_ok`.
- Texto: `c = (T_in·p_in + T_out·p_out)/10⁶`. Una sola cifra de costo no identifica dos incógnitas; se adopta la **HIPÓTESIS** `T_in = R·T_out` con `R = 4` (prompts de sistema largos + hechos de marca frente a salidas JSON). Entonces `T_out = c·10⁶ / (R·p_in + p_out) = c·10⁶/0.9` y `T_in = 4·T_out`. Cotas: `c·10⁶/p_in` (todo entrada) … `c·10⁶/p_out` (todo salida); el CSV las incluye en `notes`.
- Jev: `p_out = 0` ⇒ `T_in = c·10⁶/0.042`; `T_out` no identificable (NA).

Ejemplos (ESTIMACIÓN): diseño inicial Haiku (run1) c=0.001847 → T_out≈2052, T_in≈8209 (cotas 18 470 … 3 694 tokens totales); Jev intent c=0.000034 → ≈810 tokens de entrada por mensaje clasificado; Jev comment/review ≈1 160 tokens de entrada por evento. Si los precios reales difieren del catálogo (p. ej. descuentos, cache, precio directo de Anthropic/OpenAI), estas cifras cambian proporcionalmente.

### 4.1 Perfiles de tokens MEDIDOS (añadido 2026-11-03; sustituyen a la hipótesis 4:1)

El integrador exportó `ai_invocation.usage` de la base del laboratorio (`lab-traces.md`, 310 invocaciones, solo columnas numéricas). Esos valores son **MEDICIÓN PROPIA (histórica)** e incluyen los tokens de las reparaciones. Las columnas `tokens_*` del CSV se conservan como ESTIMACIÓN original para trazabilidad; para cálculos usar esta tabla.

| Caso de uso | Haiku 5.5 in / out (OR) | GPT-6 Luna in / out (OR) | Estimación §4 (Haiku, R=4) |
|---|---|---|---|
| website.initial.design | 4,029 / 3,396 | 1,608 / 2,033 | 8,209 / 2,052 |
| website.edit.simple | — (bad_request) | 1,735 / 202 | — |
| website.edit.complex | — (bad_request) | 2,202 / 958 | — |
| social.facebook.post.compose | 4,424 / 2,550 | 1,776 / 745 | 7,298 / 1,824 |
| engagement.facebook.comment.reply | 1,287 / 249 | 621 / 189 | 982 / 246 |
| conversation.owner.assistant | 4,729 / 427 | 2,096 / 293 | 3,436 / 859 |
| business.insights.generate | 2,135 / 677 | 712 / 404 | 2,311 / 578 |
| conversation.intent.classify (Jev) | 804 in | — | 810 in |
| engagement.*.classify (Jev) | 1,158 in | — | ≈1,160 in |

Lecturas: (1) la hipótesis 4:1 sobreestimó la entrada y subestimó la salida en diseño y compose (ratio real Haiku ≈1.2–1.7:1), y acertó en Jev (precio de salida 0 ⇒ identificable). (2) `lab-traces.md` confirma que OpenRouter aplicó el precio de catálogo 0.10/0.50 USD/MTok a ambos modelos; la diferencia de costo por éxito (§3.2) se explica porque **el mismo prompt consume ~2–2.5× más tokens de entrada en Haiku 5.5 que en Luna** (hallazgo del integrador; causa HIPÓTESIS: tokenizador y traducción del JSON Schema por OpenRouter). (3) Las reparaciones sí ocurrieron y se pagaron (compose 80 %/67 % de éxitos con 2 intentos según `lab-traces.md`), por lo que el `repairs = NA` del CSV queda resuelto en esa fuente, no aquí.

## 5. Gasto acumulado según evidencia

| Partida | USD | Etiqueta |
|---|---|---|
| Suites de evaluación, OpenRouter (suma de `cost_usd` de run1+run2+run3, solo llamadas ok) | 0.044637 | ESTIMACIÓN (suma de valores reportados) |
| Suites de evaluación, TypeSafe/Jev (run2+run3; run1 = 0) | 0.003631 | ESTIMACIÓN (suma) |
| Recorrido E2E, OpenRouter («OpenRouter este recorrido») | 0.008954 | HECHO VERIFICADO (`lab-e2e.txt:73`) |
| Recorrido E2E, TypeSafe (3 llamadas Jev) | 0.000132 | ESTIMACIÓN (suma de la tabla E15) |
| **Acumulado de laboratorio en OpenRouter** (`SUM(COALESCE(cost_usd, reserved_usd))` sobre `ai_invocation` de proveedor openrouter, todas las sesiones hasta 2026-10-30T22:15Z) | **0.096726 de 25** | HECHO VERIFICADO (`lab-e2e.txt:73`; consulta en `scripts/ai-core-lab-e2e.ts:397`) |

Diferencia 0.096726 − (0.044637 + 0.008954) = 0.043135 USD corresponde a invocaciones OpenRouter **no exportadas** en los archivos (otras sesiones E2E, intentos fallidos con reserva, casos `invalid_output` que sí gastaron). El acumulado TypeSafe total es **DESCONOCIDO** (el techo diario es USD 1, DEC-0032; la evidencia solo muestra 0.003763 USD). Frente al techo de laboratorio de DEC-0068 (USD 25) el consumo documentado es < 0.4 %.

## 6. Límites estadísticos y de validez

1. **n muy pequeño**: 1–5 casos por suite de texto (calendario n=1; edit.complex, creatives, insights, campaign.plan n=2). Una diferencia de 1 caso cambia el pass rate 20–50 puntos. Las suites Jev tienen n=8 y n=20, pero las 3 etiquetas fallidas son siempre los mismos ids: no se mide varianza entre corridas con entradas distintas.
2. **Datos sintéticos**: todos los casos son negocios ficticios (`Café Brisa Sol/Lab`, taller, estética); no hay comentarios ni reseñas reales, ni distribución real de clases.
3. **OpenRouter no es proveedor directo**: el costo (`usage.cost`) es el que OpenRouter factura, con su margen y el proveedor final que haya elegido (`zdr_providers`); latencia incluye su enrutamiento. El costo directo en Anthropic/OpenAI puede ser distinto (**DESCONOCIDO** hasta medir directo).
4. **Contabilidad sesgada a favor**: `cost_usd` omite el gasto de invocaciones que terminaron `invalid_output` o con error del proveedor tras consumir tokens, y p50/p95 omiten esas llamadas. El «costo por éxito» real es ≥ el aquí calculado.
5. **Sin tokens ni reparaciones**: imposible distinguir «modelo más verboso» de «precio distinto», ni cuántos éxitos requirieron un segundo intento de reparación (cada reparación duplica aproximadamente el costo de la llamada).
6. **Precios de catálogo iguales para Luna y Haiku** (0.1/0.5): las estimaciones de tokens dependen de que ese precio sea el aplicado realmente; no verificado en fuentes oficiales dentro de este documento (lo cubren `02-provider-comparison.md` y los estudios de proveedores).
7. **Deriva entre corridas**: run1→run2 cambió `route_version` de Haiku (2→3) en varias suites; las mejoras de pass rate no son atribuibles solo al modelo.
8. **Jev p95 de 10 s** (review run3) con p50 de 752 ms indica cola larga por reintentos/latencia de TypeSafe; con n=19 un solo valor define el p95.
9. **Rúbricas automáticas, no humanas**: `passed` significa schema + reglas de dominio + subcadenas; la calidad visual/redaccional solo tiene la rúbrica cualitativa E19 (`AI-CORE-RESULTS.md`) y capturas, sin puntuación.

## 7. Qué permite y qué no permite esta evidencia para la economía unitaria

Permite: órdenes de magnitud de costo por éxito vía OpenRouter (texto: 0.00016–0.0019 USD; clasificación Jev: 0.000034–0.000058 USD por evento) y latencias p95 de 1–23 s. No permite: costo de imágenes, costo directo Anthropic/OpenAI, costo de conversaciones largas, tasa de reparación, ni intervalos de confianza. Cualquier modelo de costo por cliente/mes construido sobre estas cifras debe llevar factor de incertidumbre explícito y marcar imágenes como NO MEDIDO.

## Fuentes

1. `evidence/ai-core/evals-lab-run1.json` — worktree, commit 878f7de (2026-10-30). Consultado 2026-11-03. 33 filas suite×ruta, fallos, costos, latencias.
2. `evidence/ai-core/evals-lab-run2-{business.insights.generate,conversation.intent.classify,engagement.facebook.comment.classify,engagement.google.review.classify,marketing.campaign.creatives,social.facebook.post.compose}.json` — mismo commit. Consultado 2026-11-03. 9 filas.
3. `evidence/ai-core/evals-lab-run3-{conversation.intent.classify,engagement.facebook.comment.classify,engagement.google.review.classify}.json` — mismo commit. 3 filas.
4. `evidence/ai-core/lab-e2e.txt` — commit cf70bc1 (2026-10-30T22:15Z). Tabla E15 (10 filas), acumulado OpenRouter 0.096726/25, bloqueo de imágenes.
5. `evidence/ai-core/screens/` — 22 PNG, solo listado.
6. `src/ai/evals.ts` (líneas 158-388) — semántica de métricas, percentiles, suma de costo solo en `ok`, umbrales.
7. `src/ai/dispatcher.ts` (líneas 206-301) — procedencia del costo (`reported`/`estimated`), bucle de reparación y acumulación de `usage`.
8. `src/ai/providers/openrouter.ts` (líneas 117-139), `src/jev/client.ts` (líneas 271-277) — mapeo de `usage.cost`.
9. `src/ai/catalog.ts` (líneas 11-14, 56-71) — `MODEL_SEEDS` y precios de catálogo usados en las estimaciones.
10. `scripts/ai-core-lab-e2e.ts` (líneas 117, 201, 397-403) — consultas SQL que generaron las cifras del E2E y significado de `r4/p1`.
11. `docs/architecture/ai-core.md` (líneas 83-97) y `docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-RESULTS.md` (líneas 45-61) — tablas publicadas por SOL MAIN, contrastadas con los JSON (coinciden salvo la mención «DeepSeek 0/5» sin fila en evidencia).
12. `research/ai-provider-economics/evidence/lab-traces.md` (integrador, 2026-11-03; líneas 11-16 y 26-58) — tokens reales `usage` por caso de uso×modelo exportados de `ai_invocation`; usados en §4.1. Aclara además que «DeepSeek 0/5» fue `circuit_open` (sin petición) y que los `invalid_output` de Haiku sí costaron (USD 0.002383 calendario, 0.002 plan).

## Huecos

| Hueco | Cómo se verificaría (sin costo) |
|---|---|
| Tokens de entrada/salida reales por invocación | Exportar `usage`, `cost_source`, `validation.attempts` de `ai_invocation` de la BD del laboratorio (consulta de solo lectura, fuera del alcance de esta tarea) |
| Costo máximo/mediana por llamada y reparaciones | Misma exportación; o `ai_eval_run.results` (array por caso) |
| Costo del 0.043135 USD no explicado del acumulado OpenRouter | `SELECT use_case_id, status, SUM(cost_usd), SUM(reserved_usd) FROM ai_invocation …` en la BD del laboratorio |
| Acumulado TypeSafe total | Suma de `ai_invocation` (typesafe) + `jev_classification` + `jev_evaluation_run` |
| Qué cambió entre run1 y run2 (prompt/ruta) | `ai_route` / `ai_prompt_revision` por `route_id` y versión; historial de la Engineering Console |
| Fila «DeepSeek 0/5» mencionada en docs | Buscar `evr_` de DeepSeek en `ai_eval_run`; si no existe, corregir la documentación |
| Precio realmente aplicado por OpenRouter a Luna/Haiku | Comparar `usage.cost` con tokens reales exportados; contrastar con el catálogo público (lo cubren los estudios de proveedores de esta investigación) |
| Cualquier métrica de imágenes, costo directo Anthropic/OpenAI, conversaciones multi-turno | Requiere nuevas ejecuciones con gasto: plan de benchmark controlado, NO MEDIDO |
