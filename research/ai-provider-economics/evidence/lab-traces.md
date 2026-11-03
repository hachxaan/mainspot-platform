# Trazas del laboratorio (`ai_invocation`) — tokens, reparaciones, costo y latencia reales

Fecha de extracción: 2026-11-03. Fuente: tabla `ai_invocation` de la base `mainspot_dev` (contenedor `mainspot-platform-postgres-1`), 310 invocaciones entre 2026-10-30T14:51Z y 2026-10-30T22:17Z (todas de negocios sintéticos del laboratorio; ninguna posterior: la integración directa Anthropic/OpenAI de SOL MAIN no había generado invocaciones en esta base).

Método (reproducible, sin efectos): `docker exec … psql` dentro de `BEGIN TRANSACTION READ ONLY … ROLLBACK`, solo columnas numéricas y de clasificación (`use_case_id`, `provider_*`, `status`, `cost_usd`, `reserved_usd`, `cost_source`, `usage`, `latency_ms`, `validation.attempts`, `error_code`). **No se leyó contenido** (`output`, prompts, `input_sha256`), ni `tenant_id`/actores, ni secretos. Dataset exportado: `lab-invocations.csv` (310 filas, sha256 `4b35bab9bb9915d98691f60fb5f387d1574b1442aff4dc13e262f0aea2805848`).

Etiqueta de todo lo que sigue: **MEDICIÓN PROPIA (histórica)** — mediciones del laboratorio del 2026-10-30 vía OpenRouter (texto) y TypeSafe directo (Jev); n pequeño, datos sintéticos.

## Hallazgos que corrigen supuestos previos

1. **Los tokens sí existen**: `usage` = `inputTokens`, `outputTokens`, `reasoningTokens`, `images`, `costUsd` (sin `cachedTokens`: el dispatcher no usa caché de prompts). `lab-history.md` §4 derivaba tokens con una hipótesis 4:1; esta tabla la sustituye.
2. **Precio aplicado = precio de catálogo**: p. ej. diseño Haiku 5,091 in / 2,665 out → USD 0.0018416 = 5,091×0.1e-6 + 2,665×0.5e-6. OpenRouter cobró Haiku 5.5 y GPT-6 Luna a 0.10/0.50 USD por MTok (sin sobreprecio visible en `usage.cost`; la comisión de compra de créditos no aparece en la traza).
3. **El mismo prompt consume ~2–2.5× más tokens de entrada en Claude Haiku 5.5 que en GPT-6 Luna** (diseño 4,029 vs 1,608; asistente 4,729 vs 2,096; respuesta 1,287 vs 621). Con idéntico precio por token, Haiku resulta 1.4–3× más caro por tarea. Causas probables (HIPÓTESIS): tokenizador distinto en español y la forma en que OpenRouter traduce `response_format` JSON Schema a Anthropic (esquema inyectado como herramienta/prompt). Consecuencia: **comparar USD/MTok sin tokens por tarea es engañoso**; el modelo económico usa tokens por tarea y por modelo.
4. **Las reparaciones son frecuentes y pagan la conversación completa dos veces**: `invokeStructured` (`src/ai/dispatcher.ts:277-299`) reenvía sistema + usuario + salida previa + corrección. Tasa de éxitos que necesitaron 2 intentos: compose 80 % Haiku / 67 % Luna; creatividades 75 % / 50 %; calendario Luna 80 %; insights 50 % / 25 %. Los errores del primer intento **no se registran** (`validation.errors` queda vacío si el segundo intento pasa): no se puede saber si fallan esquema o reglas de dominio. Las cifras de tokens/costo de esta tabla ya incluyen las reparaciones.
5. **«DeepSeek 0/5» en `docs/architecture/ai-core.md:93` no es un resultado de calidad**: sus 5 invocaciones son `blocked` con `circuit_open` (el circuito del proveedor OpenRouter estaba abierto tras los `bad_request` de Haiku); DeepSeek nunca recibió una petición. Lo mismo explica 5 `provider_unavailable` de Luna en `website.edit.simple`.
6. **Fallos con costo no contados en las suites**: `invalid_output` de Haiku en calendario (USD 0.002383) y plan de campaña (USD 0.002) sí costaron; en `ai_invocation` constan, en `evals-*.json` no.
7. **Gasto acumulado real** en la base: OpenRouter USD 0.096726; TypeSafe USD 0.004333 (160 invocaciones, de ellas 65 fallidas sin costo por credencial revocada o HTTP de TypeSafe).

## Tabla por caso de uso y modelo

Tokens y costo: promedio por invocación **exitosa**, incluyendo sus reparaciones. «USD total / éxitos» suma también los fallos que costaron. Latencia sobre éxitos, percentil nearest-rank. OR = OpenRouter; TS = TypeSafe directo. Jev factura solo entrada (0.042 USD/MTok, `src/ai/catalog.ts:67`).

| Caso de uso | Modelo (vía) | Éxitos / invocaciones | Tokens in prom. | Tokens out prom. (de ellos razonamiento) | Intentos prom. (éxitos) | % con reparación | USD prom./éxito | USD total (incl. fallos con costo) / éxitos | p50 / p95 ms (éxitos) |
|---|---|---|---|---|---|---|---|---|---|
| business.insights.generate | claude-haiku-5.5 (OR) | 4 / 4 | 2,135 | 677 (29) | 1.50 | 50% | 0.000552 | 0.000552 | 3,693 / 9,342 |
| business.insights.generate | gpt-6-luna (OR) | 4 / 4 | 712 | 404 (156) | 1.25 | 25% | 0.000273 | 0.000273 | 3,679 / 7,922 |
| conversation.intent.classify | jev-1.14.0 (TS) | 20 / 30 | 804 | 140 (0) | 1.00 | 0% | 0.000034 | 0.000034 | 729 / 866 |
| conversation.owner.assistant | claude-haiku-5.5 (OR) | 11 / 11 | 4,729 | 427 (120) | 1.00 | 0% | 0.000686 | 0.000686 | 7,383 / 12,204 |
| conversation.owner.assistant | gpt-6-luna (OR) | 3 / 3 | 2,096 | 293 (113) | 1.00 | 0% | 0.000356 | 0.000356 | 3,310 / 13,186 |
| editorial.calendar.suggest | anthropic/claude-haiku-5.5 | 0 / 1 | — | — | — | — | — | — | invalid_output |
| editorial.calendar.suggest | gpt-6-luna (OR) | 5 / 5 | 1,767 | 1,860 (829) | 1.80 | 80% | 0.001134 | 0.001134 | 16,307 / 18,864 |
| engagement.facebook.comment.classify | jev-1.14.0 (TS) | 41 / 70 | 1,158 | 265 (0) | 1.00 | 0% | 0.000049 | 0.000049 | 750 / 919 |
| engagement.facebook.comment.reply | claude-haiku-5.5 (OR) | 12 / 14 | 1,287 | 249 (127) | 1.00 | 0% | 0.000253 | 0.000253 | 2,122 / 3,999 |
| engagement.facebook.comment.reply | gpt-6-luna (OR) | 4 / 4 | 621 | 189 (124) | 1.25 | 25% | 0.000157 | 0.000157 | 2,483 / 3,782 |
| engagement.google.review.classify | jev-1.14.0 (TS) | 34 / 60 | 1,158 | 265 (0) | 1.00 | 0% | 0.000049 | 0.000049 | 763 / 966 |
| engagement.google.review.reply | claude-haiku-5.5 (OR) | 4 / 4 | 1,315 | 203 (74) | 1.00 | 0% | 0.000233 | 0.000233 | 1,228 / 3,543 |
| engagement.google.review.reply | gpt-6-luna (OR) | 4 / 4 | 645 | 182 (113) | 1.25 | 25% | 0.000155 | 0.000155 | 1,974 / 3,992 |
| marketing.campaign.creatives | claude-haiku-5.5 (OR) | 8 / 8 | 4,243 | 2,067 (666) | 1.75 | 75% | 0.001458 | 0.001458 | 10,207 / 19,199 |
| marketing.campaign.creatives | gpt-6-luna (OR) | 4 / 4 | 1,580 | 760 (230) | 1.50 | 50% | 0.000555 | 0.000555 | 5,804 / 8,620 |
| marketing.campaign.plan | claude-haiku-5.5 (OR) | 1 / 2 | 5,475 | 2,864 (291) | 2.00 | 100% | 0.001980 | 0.003980 | 15,160 / 15,160 |
| marketing.campaign.plan | gpt-6-luna (OR) | 6 / 6 | 1,105 | 1,072 (317) | 1.17 | 17% | 0.000653 | 0.000653 | 7,746 / 9,648 |
| social.facebook.image.generate | bytedance-seed/seedream-5-0-flash | 0 / 1 | — | — | — | — | — | — | blocked_external |
| social.facebook.image.generate | google/gemini-3.1-flash-lite-image | 0 / 1 | — | — | — | — | — | — | blocked_external |
| social.facebook.image.generate | microsoft/mai-image-2.6-flash | 0 / 1 | — | — | — | — | — | — | blocked_external |
| social.facebook.post.compose | claude-haiku-5.5 (OR) | 10 / 12 | 4,424 | 2,550 (1,089) | 1.80 | 80% | 0.001717 | 0.001794 | 13,129 / 18,761 |
| social.facebook.post.compose | gpt-6-luna (OR) | 6 / 6 | 1,776 | 745 (212) | 1.67 | 67% | 0.000572 | 0.000572 | 5,926 / 8,781 |
| website.edit.complex | anthropic/claude-haiku-5.5 | 0 / 2 | — | — | — | — | — | — | provider_unavailable |
| website.edit.complex | anthropic/claude-sonnet-5.5 | 0 / 2 | — | — | — | — | — | — | blocked_external |
| website.edit.complex | gpt-6-luna (OR) | 8 / 8 | 2,202 | 958 (566) | 1.12 | 12% | 0.000631 | 0.000631 | 6,091 / 18,979 |
| website.edit.simple | anthropic/claude-haiku-5.5 | 0 / 10 | — | — | — | — | — | — | circuit_open, provider_unavailable |
| website.edit.simple | deepseek/deepseek-v4.1-flash | 0 / 5 | — | — | — | — | — | — | circuit_open |
| website.edit.simple | gpt-6-luna (OR) | 5 / 10 | 1,735 | 202 (105) | 1.00 | 0% | 0.000217 | 0.000217 | 2,857 / 14,119 |
| website.image.generate | bytedance-seed/seedream-5-0-flash | 0 / 1 | — | — | — | — | — | — | blocked_external |
| website.image.generate | google/gemini-3.1-flash-lite-image | 0 / 1 | — | — | — | — | — | — | blocked_external |
| website.image.generate | microsoft/mai-image-2.6-flash | 0 / 1 | — | — | — | — | — | — | blocked_external |
| website.initial.design | claude-haiku-5.5 (OR) | 9 / 9 | 4,029 | 3,396 (1,857) | 1.00 | 0% | 0.002101 | 0.002101 | 17,105 / 23,250 |
| website.initial.design | anthropic/claude-sonnet-5.5 | 0 / 3 | — | — | — | — | — | — | blocked_external |
| website.initial.design | gpt-6-luna (OR) | 3 / 3 | 1,608 | 2,033 (736) | 1.00 | 0% | 0.001113 | 0.001113 | 13,415 / 15,266 |

## Uso en esta investigación

- `04-unit-economics.py` toma de aquí los tokens por tarea (in/out) y la tasa de reparación por caso de uso; los precios se sustituyen por las tarifas directas verificadas (`02-provider-comparison.md`).
- Faltan por completo: imágenes (0 llamadas: guardrail), Anthropic/OpenAI directos, Sonnet 5.5 (guardrail), conversaciones multiturno, edición de imágenes.

## Huecos

| Hueco | Cómo cerrarlo |
|---|---|
| Errores del primer intento antes de la reparación | Registrar `validation.first_errors` en `ai_invocation` (propuesta para SOL MAIN, no implementada aquí) |
| Tokens con Anthropic directo (sin traducción de OpenRouter) | Benchmark B-TXT de `03-quality-benchmarks.md` con la integración directa |
| Efecto de caché de prompts | El dispatcher no envía `cache_control`; medir tras habilitarlo |
