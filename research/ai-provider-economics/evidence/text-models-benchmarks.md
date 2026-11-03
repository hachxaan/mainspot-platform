# Benchmarks públicos de modelos de texto y proveedores alternativos — MainSpot AI Core

Fecha de consulta de todas las fuentes: **2026-11-03**. Moneda: USD salvo indicación. Unidad: por 1M de tokens (MTok) salvo indicación.
Rama: `research/ai-provider-economics-2026-11`. Documento de evidencia; **no es una decisión** (DEC-0069/0071/0068 siguen vigentes; cualquier cambio requiere propuesta trazable).

Etiquetas: **HECHO VERIFICADO** (leído con `read` en la URL oficial o en la página primaria del benchmark), **SNIPPET** (solo visto en resultado de búsqueda), **ESTIMACIÓN** (cálculo propio con fórmula), **HIPÓTESIS**, **DESCONOCIDO**, **LAB** (resultado de laboratorio MainSpot resumido en el encargo, no recalculado), **NO MEDIDO**.

---

## 0. Resumen ejecutivo

1. **Nombres y disponibilidad API confirmados (HECHO VERIFICADO):** `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` (Anthropic); `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-5.4-mini`, `gpt-5.4-nano` (OpenAI; **no existen** "GPT-6 mini/nano": los mini/nano vigentes son de la familia 5.4); `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` (Google; **Gemini 4 Carbon no está en la API pública**, HECHO VERIFICADO en el anuncio: acceso limitado a cyber defenders/Fairwind); `deepseek-flash` = DeepSeek-V4.1-Flash-1017 (DeepSeek).
2. **Precio de lista (HECHO VERIFICADO):** Haiku 5.5 y GPT-6 Luna cuestan exactamente lo mismo ($0.10 in / $0.50 out); Sonnet 5.5, GPT-6.1 Sol y Gemini 4 Argon (precio introductorio hasta 2026-11-30) también coinciden ($2 / $10); Opus 5.5 $4 / $20. Gemini 3.8 Flash $0.75 / $3.75 hasta 2026-12-31 (sube a $1.50 / $7.50); Argon sube a $4 / $20 desde 2026-12-01. DeepSeek V4.1 Flash $0.15–0.30 / $0.60–1.20 según hora (valle/pico en UTC).
3. **Inteligencia general (AA Intelligence Index v5, HECHO VERIFICADO):** Opus 5.5 max 58 · GPT-6.1 Sol max 55 · Sonnet 5.5 max 54 · Gemini 4 Argon high 50 · Haiku 5.5 max 36 · DeepSeek V4.1 Flash max 32 · Gemini 3.8 Flash high 31 · GPT-6 Luna max 28 · Gemini 3.5 Flash-Lite 12. **A igual precio, Haiku 5.5 (36) > GPT-6 Luna (28)** en este índice; pero el índice mide trabajo agéntico/código/ciencia, no redacción en español.
4. **Español (LMArena Text: Spanish, tablero oficial arena.ai leído 2026-11-03, snapshot 2026-10-27, 185,275 votos, 303 modelos, HECHO VERIFICADO):** top general Fable 5 (High) 1499 ±16; entre candidatos: Gemini 4 Argon (High) 1496 ±27, Opus 5.5 (High) 1488 ±30, Gemini 3.8 Flash (High) 1480 ±16, GPT-6.1 Sol (Max) 1475 ±32, DeepSeek-V4.1-Flash-20260910 1463 ±27, Gemini 3.5 Flash-Lite 1456 ±20, Sonnet 5.5 (xHigh) 1448 ±30, **GPT-6 Luna (Max) 1442 ±12 (3,311 votos)**, **Haiku 5.5 (High) 1404 ±34 (306 votos)**. Los modelos baratos quedan ~54–92 Elo por debajo de Argon y ~95 del top general; Luna supera a Haiku 5.5 en español (1442 vs 1404).
5. **Tool use (τ²-Bench Airline vía OpenRouter, HECHO VERIFICADO en la página, no es el leaderboard oficial de Sierra):** Sonnet 5.5 78.8% ($0.16/tarea, 71 s, el más rápido del tablero); Gemini 4 Argon 78.7%; Gemini 3.5 Flash-Lite 78.3% ($0.074); Opus 5.5 75.3%; DeepSeek V4.1 Flash 75.1%; **Haiku 5.5 72.8% ($0.012) > GPT-6.1 Sol 70.0% > GPT-6 Luna 67.3% ($0.009)**. El leaderboard oficial de τ²-bench no incluye ningún modelo 5.5/6.x (HECHO VERIFICADO en el manifest). BFCL V4 no se actualiza desde 2026-04-12 (HECHO VERIFICADO) → no sirve para estos modelos.
6. **Salida estructurada:** límites de esquema verificados: Anthropic 16 parámetros con unión / 24 opcionales / 20 tools strict por petición (HECHO VERIFICADO; explica el fallo LAB con 17 uniones); OpenAI hasta 5,000 propiedades, 10 niveles, 1,000 valores enum (HECHO VERIFICADO); Gemini rechaza con `400 INVALID_ARGUMENT` por límites no numéricos de estados/ramas/profundidad y **no aplica** `minLength/maxLength/minProperties/...` (HECHO VERIFICADO). No hay benchmark público fechado de fiabilidad JSON que incluya los modelos 5.5/6.x (DESCONOCIDO).
7. **Latencia (AA, p50, 10k tokens de entrada, HECHO VERIFICADO):** los TTFT de AA **incluyen el tiempo de razonamiento** del nivel de esfuerzo medido. Configuraciones aptas para MainSpot: GPT-6 Luna non-reasoning 0.80 s / 109 tok/s; GPT-6.1 Terra non-reasoning 0.94 s / 91 tok/s; Sonnet 5.5 low 1.15 s / 104 tok/s; DeepSeek V4.1 Flash non-reasoning 1.40 s / 183 tok/s; Haiku 5.5 low 8.96 s / 165 tok/s (AA no publica Haiku 5.5 sin razonamiento; el 8.96 s refleja pensamiento en "low"). Respuesta de 200 tokens p50: 2.6–3.1 s (Luna/Terra/Sonnet low); 7,000 tokens p50: 40–70 s en los modelos rápidos (ESTIMACIÓN, §4).
8. **Datos y jurisdicción:** Gemini API **gratuita** usa prompts para mejorar productos y puede haber revisión humana; **de pago no** y aplica DPA de Google como encargado, con logs limitados para abuso (HECHO VERIFICADO). OpenAI API: no entrena con datos, logs de abuso 30 días, residencia regional con +10% (HECHO VERIFICADO). DeepSeek: controlador Hangzhou DeepSeek (China), **recoge, procesa y almacena los datos en la RPC** (HECHO VERIFICADO); los ToS del Open Platform trasladan al desarrollador toda la responsabilidad frente a usuarios finales; no se localizó DPA ni política de entrenamiento específica para la API (DESCONOCIDO). Para datos de clientes mexicanos, DeepSeek directo es **riesgo alto** y no está cubierto por DEC-0067/0071.

---

## 1. Catálogo de modelos candidatos y precios verificados

### 1.1 Anthropic (Claude API directa) — HECHO VERIFICADO
Fuente: platform.claude.com/docs/en/about-claude/pricing (leída 2026-11-03).

| Modelo (ID) | Entrada | Salida | Cache read | Cache write 5m / 1h | Batch (in/out) | Notas |
|---|---:|---:|---:|---:|---:|---|
| Claude Opus 5.5 (`claude-opus-5-5`) | $4.00 | $20.00 | $0.20 (0.05×) | $5 / $8 | $2 / $10 | Fast mode $8/$40. Lanzado 2026-09-22. |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2.00 | $10.00 | $0.10 (0.05×) | $2.50 / $4 | $1 / $5 | Lanzado 2026-09-28. Cache read bajó de $0.20 a $0.10 el 2026-10-07. |
| Claude Haiku 5.5 (`claude-haiku-5-5`), prompt ≤100k | $0.10 | $0.50 | $0.01 | $0.125 / $0.20 | $0.05 / $0.25 | Lanzado 2026-10-07. |
| Claude Haiku 5.5, prompt >100k | $0.50 | $2.50 | $0.05 | $0.625 / $1 | $0.25 / $1.25 | Precio por petición según longitud total del prompt (incluye cache reads/writes). |

Restricciones verificadas: contexto 1M a precio estándar para Opus/Sonnet 5.5; `inference_geo: "us"` ×1.1 en todas las categorías; los modelos ≥4.7 usan tokenizador nuevo que produce **~30% más tokens** por el mismo texto (afecta comparaciones de costo por tarea con otros proveedores); tool use añade 286 tokens de system prompt (Haiku/Sonnet/Opus 5.5). Anthropic indica que Haiku 5.5 está "diseñado para tareas de alto volumen y sensibles al costo… resúmenes, clasificación, soporte en vivo" y que Sonnet/Opus 5.5 "siguen siendo mejores para tareas agénticas complejas".

### 1.2 OpenAI (API directa) — HECHO VERIFICADO
Fuente: developers.openai.com/api/docs/pricing y páginas de modelo (leídas 2026-11-03). Contexto corto ≤272K; largo >272K (2× entrada, 1.5× salida).

| Modelo (ID) | Entrada | Salida | Cache read | Cache write 30m / 12h | Batch/Flex (in/out) | Notas |
|---|---:|---:|---:|---:|---:|---|
| GPT-6 Astra (`gpt-6-astra`) | $10.00 | $50.00 | $1.00 | $12.50 / $25 | $5 / $25 | Fuera de rango para MainSpot. |
| GPT-6.1 Sol (`gpt-6.1-sol`) | $2.00 | $10.00 | $0.10 (5%) | $2.50 / $5 | $1 / $5 | Contexto 1.05M, salida máx. 128k, corte abr-2026. **Tool calling solo Responses API.** Fast 2×, Ultrafast 6×. |
| GPT-6.1 Terra (`gpt-6.1-terra`) | $1.00 | $5.00 | $0.05 | $1.25 / $2.50 | $0.50 / $2.50 | Nivel intermedio no mencionado en el encargo; relevante por precio/latencia. |
| GPT-6 Luna (`gpt-6-luna`) | $0.10 | $0.50 | $0.01 (10%) | $0.125 / $0.25 | $0.05 / $0.25 | Contexto 1.05M, salida máx. 128k, corte 2026-05-18; `reasoning.effort` none…max; **Chat Completions solo soporta function calling con effort `none`**; Responses API para tools. Residencia EU disponible. |
| GPT-5.4 Mini (`gpt-5.4-mini`) | $0.75 | $4.50 | $0.075 | — | $0.375 / $2.25 | Más caro que Luna; sin ventaja aparente. |
| GPT-5.4 Nano (`gpt-5.4-nano`) | $0.20 | $1.25 | $0.02 | — | $0.10 / $0.625 | Más caro que Luna. |

Nota del encargo: no hay "GPT-6 mini/nano". El equivalente barato vigente es GPT-6 Luna; los mini/nano 5.4 siguen listados pero con peor precio. Recargo +10% por residencia regional para modelos posteriores a 2026-03-05.

### 1.3 Google (Gemini Developer API y Vertex/Agent Platform) — HECHO VERIFICADO
Fuentes: aistudio.google.com/docs/pricing (destino de ai.google.dev/gemini-api/docs/pricing), aistudio.google.com/docs/models, cloud.google.com/model-garden/pricing (destino de cloud.google.com/vertex-ai/generative-ai/pricing).

| Modelo (ID) | Entrada | Salida (incl. thinking) | Cache | Batch/Flex (in/out) | Free tier | Notas |
|---|---:|---:|---:|---:|---|---|
| Gemini 4 Argon (`gemini-4-argon`) | $2.00 hasta 2026-11-30; **$4.00 desde 2026-12-01** | $10.00 → **$20.00** | $0.10 → $0.20, solo implícito | $1 / $5 → $2 / $10 | **No** | Contexto 1,048,576 (unificado in+out); salida 65k (1M con long decode); thinking low/medium/high; sin caché explícita. Vertex: Global $2/$10; Non-global +10% ($2.20/$11); Priority $3.60/$18. |
| Gemini 3.8 Flash (`gemini-3.8-flash`) | $0.75 hasta 2026-12-31; **$1.50 desde 2027-01-01** | $3.75 → **$7.50** | $0.075 → $0.15 (+ almacenamiento $0.50→$1.00 /M tok/h) | $0.375 / $1.875 → $0.75 / $3.75 | Sí | Salida 64k. Vertex Non-global $0.825/$4.125. |
| Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`) | $0.30 | $2.50 | $0.03 | — (ver página) | Sí | "Alto volumen, traducción, procesamiento simple". `gemini-2.5-flash` se redirige aquí desde 2026-12-01. |
| Gemini 3.1 Flash-Lite (`gemini-3.1-flash-lite`) | $0.25 (texto) / $0.50 audio | $1.50 | $0.025 | — | Sí | El más barato de Google. |

Hechos adicionales verificados: Gemini 4 Argon "no está disponible en Free tier; cada token procesado se factura, incluidos thinking y declaraciones de función con grounding". Vertex: desde 2026-11-13 Argon cobra tokens recuperables aunque la petición falle por timeout cuando la salida supera 32K. Grounding con Google Search: 5,000 peticiones/mes gratis, luego $14/1,000 (tope 1,500/día). Google Cloud SKU en moneda local aplica si se paga en MXN (precio de referencia USD).

**Gemini 4 Carbon (HECHO VERIFICADO, blog.google 2026-10-28, leído 2026-11-03):** anuncio oficial: "our strongest model", #1 en Artificial Analysis Intelligence Index v5.0 con 59 (cifra citada por el propio blog). Acceso: "a subset of cyber defenders" y acceso gradual a socios vía programa Fairwind; "eager to see… bringing Carbon to developers, businesses, and consumers soon" — **sin ID de API pública ni fecha**. Precio anunciado: mismo precio introductorio que Argon, $2/$10 por MTok (entrada/salida), tokens cacheados a 95% de descuento sobre entrada; tras el período introductorio $4/$20. **No es contratable hoy**; si llega a la API, competiría con Opus 5.5/Sol en el nivel superior.

### 1.4 DeepSeek (API directa) — HECHO VERIFICADO
Fuente: api-docs.deepseek.com/quick_start/pricing (leída 2026-11-03). Horas pico: 01:00–04:00 y 06:00–10:00 UTC, L–V, excluyendo festivos chinos; resto valle (50%).

| Modelo (ID) | Entrada cache hit | Entrada cache miss | Salida | Concurrencia | Notas |
|---|---:|---:|---:|---:|---|
| `deepseek-flash` = DeepSeek-V4.1-Flash-1017 | $0.003 valle / $0.006 pico | $0.15 / $0.30 | $0.60 / $1.20 | 2,500 | Contexto 1M, salida máx. 384K, thinking por defecto (conmutable), JSON output, tool calls, Responses API, API compatible Anthropic, visión. Pesos abiertos (HF). |
| `deepseek-v4-pro` = DeepSeek-V4-Pro-0813 | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 | 500 | Sin visión. |

Para México (UTC-6), las horas pico UTC corresponden a 19:00–22:00 y 00:00–04:00 hora CDMX: el tráfico diurno mexicano cae en tarifa valle (ESTIMACIÓN de huso; MainSpot debería confirmar su mezcla horaria real).

### 1.5 Otros (solo contexto, no candidatos primarios)
- **Mistral Small 4 / Medium 3.5 / Large 4:** AA Intelligence Index 4 (Small 4), 26 (Large 4 high); τ² Airline Mistral Small 4 46.0% (HECHO VERIFICADO en OpenRouter). Descartable para tool use y JSON complejo; no se verificaron precios oficiales (DESCONOCIDO).
- **Qwen3.8 Max:** AA 34, $10.02/tarea, 38 tok/s; LMArena Spanish oficial 1474 ±19 (1,026 votos; HECHO VERIFICADO, arena.ai, snapshot 2026-10-27). Alibaba Cloud: misma consideración jurisdiccional que DeepSeek. No se verificaron precios.
- **xAI Grok 4.7:** AA 35 (high/xhigh) con $6–8/tarea; LMArena Spanish oficial 1445 ±24 (608 votos, variante xHigh; HECHO VERIFICADO, arena.ai, snapshot 2026-10-27). Peor relación costo/calidad que Sonnet 5.5 o GPT-6.1 Sol. No se verificaron precios.

---

## 2. Benchmarks públicos fechados

### 2.1 Artificial Analysis — Intelligence Index v5, costo por tarea, velocidad y TTFT (HECHO VERIFICADO)
Fuente: artificialanalysis.ai/leaderboards/models, leído 2026-11-03. Índice v5 = AA-Briefcase v1.1, AutomationBench-AA, Terminal-Bench 4.0, FrontierCode 2.0, AA-Omniscience v1.1, GDP.pdf, HLE-Diamond, CritPt v2, Terminal-Bench-Science 0.1 (sesgo: agentes/código/ciencia; **no mide redacción en español**). Velocidad/TTFT: mediana 72 h, carga de 10k tokens de entrada, API de primera parte; **TTFT incluye el tiempo de "thinking"** del nivel de esfuerzo.

| Modelo (esfuerzo) | Índice | $/tarea | tok/s | TTFT (s) | Total 500 tok (s) |
|---|---:|---:|---:|---:|---:|
| Gemini 4 Carbon (high) — *no API pública* | 59 | 7.76 | 92 | 156.31 | 161.74 |
| Claude Opus 5.5 (max, fallback) | 58 | 10.04 | 95 | 640.87 | 646.15 |
| Claude Opus 5.5 (xhigh) | 57 | 6.05 | 80 | 121.37 | 127.59 |
| GPT-6 Astra (max) | 57 | 6.24 | 72 | 367.00 | 373.99 |
| GPT-6.1 Sol (max) | 55 | 1.27 | 91 | 307.83 | 313.31 |
| Claude Sonnet 5.5 (max, fallback) | 54 | 10.02 | 139 | 456.04 | 459.65 |
| GPT-6.1 Sol (xhigh) | 52 | 0.76 | 77 | 153.30 | 159.80 |
| Claude Opus 5.5 (high) | 52 | 3.46 | 79 | 43.54 | 49.84 |
| GPT-6.1 Terra (max) | 51 | 0.96 | 110 | 274.21 | 278.74 |
| Gemini 4 Argon (high) | 50 | 7.68 | 82 | 44.08 | 50.14 |
| GPT-6.1 Sol (high) | 50 | 0.59 | 68 | 69.58 | 76.91 |
| Claude Sonnet 5.5 (xhigh) | 50 | 4.09 | 106 | 36.85 | 41.55 |
| Claude Opus 5.5 (medium) | 48 | 2.45 | 79 | 22.38 | 28.67 |
| GPT-6.1 Sol (medium) | 46 | 0.36 | 63 | 8.90 | 16.90 |
| GPT-6.1 Terra (xhigh) | 45 | 0.40 | 100 | 68.83 | 73.82 |
| GPT-6.1 Terra (high) | 42 | 0.26 | 95 | 20.70 | 25.99 |
| Claude Sonnet 5.5 (high) | 41 | 1.64 | 106 | 13.94 | 18.67 |
| GPT-6.1 Terra (medium) | 38 | 0.17 | 91 | 4.24 | 9.74 |
| **Claude Haiku 5.5 (max)** | **36** | 0.41 | 234 | 343.44 | 345.57 |
| Grok 4.7 (high) | 35 | 6.18 | 75 | 66.05 | 72.71 |
| GPT-6.1 Sol (low) | 35 | 0.16 | 61 | 2.51 | 10.70 |
| Claude Opus 5.5 (low) | 35 | 0.98 | 79 | 11.35 | 17.70 |
| Claude Haiku 5.5 (xhigh) | 34 | 0.25 | 190 | 67.81 | 70.44 |
| Qwen3.8 Max (0902) | 34 | 10.02 | 38 | 2.94 | 68.67 |
| **DeepSeek V4.1 Flash 1017 (max)** | **32** | 0.60 | 170 | 1.23 | 15.90 |
| **Gemini 3.8 Flash (high)** | **31** | 7.77 | 131 | 26.19 | 30.00 |
| GPT-6.1 Terra (non-reasoning) | 30 | 0.23 | 91 | 0.94 | 6.44 |
| Claude Sonnet 5.5 (medium) | 30 | 0.78 | 100 | 1.23 | 6.24 |
| Gemini 3.8 Flash (medium) | 30 | 6.26 | — | — | — |
| Claude Haiku 5.5 (high) | 30 | 0.16 | 181 | 31.95 | 34.71 |
| GPT-6.1 Terra (low) | 29 | 0.07 | 91 | 1.52 | 7.02 |
| DeepSeek V4.1 Flash 1017 (high) | 29 | — | 184 | 0.89 | 14.46 |
| **GPT-6 Luna (max)** | **28** | 0.15 | 117 | 120.87 | 125.13 |
| Mistral Large 4 (high) | 26 | 2.06 | — | — | — |
| Claude Sonnet 5.5 (low) | 25 | 0.51 | 104 | 1.15 | 5.97 |
| Claude Haiku 5.5 (medium) | 25 | 0.09 | 169 | 13.81 | 16.77 |
| GPT-6 Luna (xhigh) | 23 | 0.10 | 127 | 35.69 | 39.61 |
| DeepSeek V4 Pro 0813 (max) | 23 | 1.77 | 90 | 1.79 | 29.59 |
| Gemini 3.8 Flash (low) | 22 | — | — | — | — |
| GPT-6 Luna (high) | 21 | 0.07 | 121 | 26.61 | 30.74 |
| Claude Haiku 5.5 (low) | 19 | 0.04 | 165 | 8.96 | 11.99 |
| DeepSeek V4.1 Flash 1017 (non-reasoning) | 19 | 0.43 | 183 | 1.40 | 4.13 |
| GPT-6 Luna (medium) | 18 | 0.04 | — | — | — |
| Gemini 3.5 Flash-Lite | 12 | 0.69 | 442 | 6.82 | 7.95 |
| GPT-6 Luna (low) | 10 | 0.01 | 115 | 2.91 | 7.26 |
| GPT-6 Luna (non-reasoning) | 9 | 0.07 | 109 | 0.80 | 5.37 |
| Mistral Small 4 | 4 | 0.04 | 170 | 0.76 | 15.49 |
| Mistral Small 4 (non-reasoning) | — | — | 163 | 0.85 | 3.91 |
| Mistral Medium 3.5 | — | — | 178 | 2.45 | 16.53 |

Lecturas relevantes para MainSpot:
- **Mismo precio, distinta inteligencia:** Haiku 5.5 y GPT-6 Luna cuestan lo mismo, pero Haiku puntúa 36 vs 28 (max) y 30 vs 21 (high). En cambio Luna gasta menos por tarea en el índice ($0.15 vs $0.41 a max) porque genera menos tokens; AA califica a Haiku 5.5 como "muy verboso" (300M tokens en el índice vs mediana 81M) (HECHO VERIFICADO en la página del modelo).
- **Gemini 3.8 Flash (high)** empata con Haiku en índice (31) pero cuesta **19× más por tarea** ($7.77 vs $0.41): su salida con thinking es muy larga. Flash-Lite (12) queda muy por debajo.
- **DeepSeek V4.1 Flash max (32)** es competitivo en índice y barato ($0.60/tarea) pero el modo non-reasoning cae a 19; su resultado LAB 0/5 en edición simple no lo contradice.
- Nivel medio: **GPT-6.1 Sol medium (46, $0.36/tarea, TTFT 8.9 s)** y **Opus 5.5 medium (48, $2.45, 22 s)** / **Sonnet 5.5 xhigh (50, $4.09, 37 s)**. GPT-6.1 Terra (medium 38, $0.17) es un intermedio no considerado en el encargo.

**AA-Omniscience v1.1 (alucinación, HECHO VERIFICADO en artificialanalysis.ai/evaluations/omniscience):** mejores Net Score: Gemini 4 Carbon high 54, **Opus 5.5 max 48**, Carbon medium 47; menor tasa de alucinación: Carbon medium 4%, **Gemini 4 Argon high 4%**, Carbon high 11%. Valores individuales de Haiku/Luna/Sonnet no renderizados (gráfico JS) → DESCONOCIDO; la página sí muestra deltas v1→v1.1 (Luna max −9.0, Gemini 3.8 Flash high −6.3, DeepSeek V4.1 Flash −3.8, Haiku +1.6, Sonnet −1.8, Opus +1.7) que solo indican sensibilidad al cambio de dataset. Relevante para `business.insights.generate` (prohibición de cifras inventadas): la mitigación principal debe ser **grounding por herramientas y validación numérica en código**, no el modelo.

### 2.2 Tablas publicadas por los fabricantes (HECHO VERIFICADO; autoevaluaciones, no independientes)

**Anthropic — Haiku 5.5 (2026-10-07):**

| Benchmark | Haiku 5.5 | Haiku 4.5 | GPT-6 Luna | Sonnet 5.5 |
|---|---:|---:|---:|---:|
| GDPval-AA v2.1 (Elo, trabajo profesional) | 1620 | 735 | 1437 | 1840 |
| AA-Briefcase v1.1 (Elo) | 1578 | 614 | 1336 | 1824 |
| OSWorld 2.1 (offline) | 72.4% | 15.7% | 48.9% | 83.9% |
| HLE sin herramientas | 45.9% | 10.2% | — | 56.9% |
| Terminal-Bench 4.0 | 39.2% | 0.0% | 16.4% | 70.6% |
| FrontierCode 1.1 | 46.4% | — | 42.4% | 52.1% |
| Chartography sin herramientas | 46.4% | 6.4% | 29.1% | 61.6% |

Clientes citados por Anthropic: HubSpot 92.8% en suite CRM (mejor modelo pequeño probado), AlphaSense 0.84 vs 0.76, Zendesk (Sonnet 5.5) "menos decisiones erróneas en soporte, 20% más rápido". Son testimonios, no benchmarks reproducibles.

**Anthropic — Sonnet 5.5 (2026-09-28):** Terminal-Bench 4.0 70.6% (Opus 5.5 66.4%); GDPval-AA 1844 vs Opus 1846 vs GPT-6 Sol 1487; OSWorld 2.1 80.1%; "30%+ más rápido que Sonnet 5"; "fewest failed tool calls" (Base44, testimonio).

**Anthropic — Opus 5.5 (2026-09-22):** GDPval-AA 1846; AutomationBench 40.0% (Zapier, sin fallback); Terminal-Bench 4.0 66.4%. Dato clave para análisis sin inventar: en un test interno de informes financieros con verificación automática de cada cifra, **16/18 informes de Opus 5.5 pasaron el umbral "cualquier cifra inventada = fallo"**, frente a 0 de Fable 5.1 y Opus 5 (autoevaluación).

**Google — Gemini 4 Argon (model card, 2026-10-13):** Vals Index 68.9% (Opus 5.5 67.0%); AutomationBench 51.3% (Opus 5.5 42.5%, GPT-6 Astra 41.4%); Terminal-bench 4.0 57.4% (Opus 5.5 66.4%); GraphWalks 256k–1M 84.2%; corte de conocimiento marzo 2026. **Gemini 3.8 Flash (model card, 2026-09-02):** GDPval-AA v2 1545 (Opus 5 1824, Sonnet 5 1584); Terminal-bench 4.0 19.1%; "safety performance across non-English languages regressed slightly (+5.4 pp) vs 3.7 Flash".

**OpenAI — GPT-6 Sol y Luna (anuncio, actualizado 2026-09-29):** Luna max DeepSWE v1.1 66.6% ("93% más barato que Opus 5 por tarea"); AutomationBench Luna high +5.4 pp vs 5.6 Luna a 58% menos costo; factualidad interna: Luna a esfuerzo alto iguala a GPT-5.6 Sol "a ~1/100 del costo". Benchmarks de GPT-6.1 Sol: la página de modelo no publica tabla (solo "near-Astra performance"); el anuncio de 6.1 Sol no fue leído (HUECO).

**DeepSeek — V4.1 Flash 1017 (2026-10-17):** la tabla de benchmarks es una imagen (`v4.1_261017_benchmark_table_en.png`) no legible por texto → DESCONOCIDO; el texto afirma "mejor rendimiento, finalización más rápida y salidas más cortas" (autoevaluación sin cifras extraíbles).

### 2.3 Preferencia humana en español — LMArena Text: Spanish (HECHO VERIFICADO en arena.ai)
Fuente oficial: https://arena.ai/leaderboard/chat/text/spanish, leída 2026-11-03 con navegador real (la URL principal `arena.ai/leaderboard/text` devolvía HTTP 403 al lector estático; en Chromium cargó y la categoría Spanish se abrió desde el filtro "📍 Language" → URL `/leaderboard/chat/text/spanish`). Snapshot del tablero: **2026-10-27, 185,275 votos, 303 modelos**, vista por defecto con Style Control activado.

| Puesto (aprox.) | Modelo (variante) | Elo | Votos | ±IC95 |
|---:|---|---:|---:|---:|
| 1 | Claude Fable 5 (High) | 1499 | 1,433 | 16 |
| 2 | Claude Opus 4.7 (High) | 1498 | 2,049 | 14 |
| 4 | Claude Fable 5.1 (Max) | 1498 | 568 | 24 |
| 5 | **Gemini 4 Argon (High)** | 1496 | 493 | 27 |
| 8 | Claude Opus 5 (Max) | 1488 | 1,064 | 19 |
| 9 | **Claude Opus 5.5 (High)** | 1488 | 403 | 30 |
| 14 | **Gemini 3.8 Flash (High)** (Preliminary) | 1480 | 1,649 | 16 |
| 18 | **GPT-6.1 Sol (Max)** | 1475 | 326 | 32 |
| 24 | Qwen3.8-Max | 1474 | 1,026 | 19 |
| 28 | **DeepSeek-V4.1-Flash-20260910 (Max)** | 1463 | 476 | 27 |
| 50 | **Gemini 3.5 Flash-Lite** | 1456 | 958 | 20 |
| 76 | **Claude Sonnet 5.5 (xHigh)** | 1448 | 359 | 30 |
| 78 | Grok 4.7 (xHigh) | 1445 | 608 | 24 |
| 83 | **GPT-6 Luna (Max)** | 1442 | 3,311 | 12 |
| 96 | Gemini 3.1 Flash-Lite Preview | 1435 | 2,019 | 14 |
| 97 | GPT-5.4 mini (High) | 1434 | 1,914 | 15 |
| 145 | **Claude Haiku 5.5 (High)** | 1404 | 306 | 34 |
| 159 | GPT-5.4 nano (High) | 1393 | 1,913 | 15 |

Discrepancia con el replicador: llmbenchmark.ai (leído el mismo día) publicaba para los mismos modelos y **los mismos conteos de votos** Elo que difieren entre −51 y +16 (p. ej. Luna 1391 vs 1442 oficial, Sol 1442 vs 1475 oficial, Argon 1505 vs 1496 oficial). Votos idénticos + Elo distinto indica una versión/ajuste diferente de la misma corrida (la vista oficial por defecto activa Style Control). **Se usan los valores oficiales de arena.ai**; la réplica queda como cruce de consistencia de los conteos de votos, no como fuente de Elo.

Lecturas: (a) entre los candidatos, los modelos baratos (Luna 1442, Haiku 5.5 1404) quedan 54–92 Elo por debajo de Argon 1496 y ~95 del top general (1499); (b) Luna supera a Haiku 5.5 en español (1442 vs 1404, brecha 38 Elo, mayor que los intervalos parciales aunque el IC de Haiku es ±34 con solo 306 votos); (c) Gemini 3.8 Flash (1480) y 3.5 Flash-Lite (1456) puntúan alto en español para su precio; (d) Sonnet 5.5 (359 votos) y GPT-6.1 Sol (326) tienen intervalos ±30–32: sus posiciones son provisionales; (e) en el tablero **Overall** del mismo snapshot (texto general), Luna (Max) 1441 ±4 con 86,478 votos y Haiku 5.5 (High) 1425 ±7 con 7,890 — Luna también supera a Haiku en inglés, y ambos quedan muy por debajo de Argon 1520/Opus 5.5 1509; (f) LMArena mide preferencia conversacional, **no** fidelidad a instrucciones de marca ni veracidad de datos del negocio. Relevante para `social.facebook.post.compose`, `engagement.*.reply`, `marketing.campaign.creatives`.

### 2.4 Tool use / agentes
**τ²-Bench Airline en OpenRouter (HECHO VERIFICADO en la página; última corrida 2026-11-03 04:31 UTC; mide modelo + proveedor; se leyó la página pública, no se ejecutó ninguna llamada):**

| Modelo | Exactitud | σ | $/tarea | Tiempo/tarea | Tokens salida/tarea |
|---|---:|---:|---:|---:|---:|
| Claude Sonnet 5.5 | 78.8% | ±2.2 pp | $0.16 | 71 s | 6.25k |
| Gemini 4 Argon | 78.7% | — | $0.50 | 5.8 min | 22k |
| Gemini 3.5 Flash-Lite | 78.3% | ±1.0 pp | $0.074 | 1.6 min | 21.5k |
| Claude Opus 5.5 | 75.3% | ±1.7 pp | $0.34 | 1.9 min | 7.04k |
| DeepSeek V4.1 Flash | 75.1% | ±2.8 pp | $0.033 | 3.7 min | 35.2k |
| Claude Haiku 5.5 | 72.8% | ±4.1 pp | $0.012 | 86 s | 10.7k |
| DeepSeek V4.1 Flash 1017 | 72.3% | ±1.0 pp | $0.029 | 3.0 min | 35k |
| Gemini 3.8 Flash | 71.3% | — | $0.21 | 4.4 min | 27.6k |
| GPT-6.1 Sol | 70.0% | — | $0.10 | 2.4 min | 3.64k |
| GPT-6.1 Terra | 68.7% | — | $0.068 | 79 s | 4.78k |
| GPT-6 Luna | 67.3% | — | $0.009 | 2.0 min | 8.9k |
| Mistral Small 4 | 46.0% | — | $0.011 | 87 s | 9.09k |

Líder del tablero: GPT-5.1 80.0% (modelo anterior). OpenRouter advierte que el benchmark "tiene un piso alto, así que sirve para evaluar varianza de proveedor, no capacidad de modelo". Comparabilidad: los modelos OpenAI 6.x tienen "—" en σ (una sola corrida) y usan muy pocos tokens de salida; los Gemini/DeepSeek gastan 3–5× más tokens por tarea.

**τ²-bench oficial (Sierra) — HECHO VERIFICADO en el manifest de submissions:** últimas entradas de texto fechadas 2026-08-04 (Claude Opus 5, Fable 5, GPT-5.6 Sol, Qwen3.8 Max, GLM 5.2, Kimi K3, Grok 4.5, Inkling). **Ningún modelo 5.5/6.x** tiene submission oficial.

**BFCL V4 (HECHO VERIFICADO en gorilla.cs.berkeley.edu/leaderboard):** "Last Updated 2026-04-12"; la tabla se renderiza por JS y no se extrajo. SNIPPET del ranking: Claude Opus 4.5 FC 77.47%, Sonnet 4.5 FC 73.24%, Gemini 3 Pro Preview (prompt) 72.51%, GPT-5.2 FC 55.87%. **No cubre ningún candidato actual** → solo indica que la familia Claude lideraba la llamada nativa de funciones en abril 2026.

**AutomationBench (Zapier, 47 herramientas, flujos de negocio; citado por fabricantes):** Gemini 4 Argon 51.3% (model card Google) · Opus 5.5 42.5% (Google) / 40.0% (Anthropic, sin fallback) · GPT-6 Astra 41.4% · GPT-6 Sol xhigh 33.2% a $0.27/tarea (OpenAI) · Luna high "+5.4 pp vs 5.6 Luna" sin cifra absoluta. Relevante para `conversation.owner.assistant` (tools de solo lectura) y la capacidad propuesta de orquestación.

### 2.5 Instruction following (IFEval/IFBench)
- IFBench en AA (HECHO VERIFICADO en artificialanalysis.ai/evaluations/ifbench; reintentado 2026-11-03 con Chromium real): el resumen textual dice "Grok 4.3 (Medium) 83.3%, Grok 4.20 0309 82.9%, MiniMax-M3 82.9%" como máximos (top-10 renderizado en texto); los valores de los candidatos 5.5/6.x existen solo como datos de gráfico cargados por el cliente (no aparecen en el DOM ni en el HTML inicial, y no hay endpoint JSON visible en las peticiones de red) → DESCONOCIDO. Vía restante: tooltips del gráfico, API de datos de AA (requiere clave) o corrida propia.
- SNIPPET (benchmarklist.com): Haiku 5.5 54.6% IFBench "importado, no canónico"; otro tracker indica que no está publicado. **No usar como cifra.**
- Anthropic no publica IFEval/IFBench en las páginas de lanzamiento 5.5; Google tampoco en los model cards leídos; OpenAI tampoco en el anuncio de Luna. → **HUECO principal** para "edición precisa sin cambios colaterales". Mitigación: medirlo en laboratorio con constraints verificables propias (ver Huecos).

### 2.6 Fiabilidad de salida estructurada (JSON/DSL)
Límites de esquema (todos HECHO VERIFICADO en docs oficiales, 2026-11-03):

| Proveedor | Mecanismo | Límites explícitos | Comportamiento ante exceso |
|---|---|---|---|
| Anthropic (`output_config.format` json_schema / `strict: true`) | Decodificación restringida por gramática compilada | **16 parámetros con `anyOf` o type-array** en total por petición; 24 parámetros opcionales; 20 tools strict; timeout de compilación 180 s; `allOf` con `$ref` no soportado; límites internos adicionales de tamaño de gramática | `400 "Schema is too complex for compilation"`. Compatible con Batch (−50%). ZDR: solo se cachea el esquema ≤24 h. |
| OpenAI (`text.format` json_schema strict / function strict) | Decodificación restringida | Hasta **5,000 propiedades**, **10 niveles** de anidación, 120,000 caracteres de nombres/enum/const, 1,000 valores enum | Documenta refusals detectables y truncado por max_tokens. |
| Google (`response_format` schema) | Máquina de estados compilada | Sin cifras publicadas; límites de "estados totales, ramas y profundidad"; **no aplica** `minLength/maxLength/minProperties/maxProperties/uniqueItems/contains` (los elimina silenciosamente); `minItems/maxItems` sí; las uniones `anyOf`, enums y opcionales "multiplican las ramas" | `400 INVALID_ARGUMENT`. Recomienda aplanar, acortar nombres de propiedades y mover reglas a descripciones. |
| DeepSeek | JSON Output (modo JSON) + tool calls | Documentación de "Json Output" existe; no se verificó si impone esquema estricto (DESCONOCIDO) | — |

Consecuencia directa para `website.edit.*` (parche tipado con 17 uniones): el fallo LAB de Haiku 5.5 es **un límite de API, no del modelo**; el mismo esquema debería fallar en Sonnet/Opus 5.5 (HIPÓTESIS: el límite es por petición y es el mismo para todos los modelos soportados). GPT-6 Luna pasó en LAB porque OpenAI admite esquemas mucho mayores. Gemini es incierto: sus límites no están cuantificados y las 17 uniones "multiplican ramas"; habría que probar el esquema exacto (NO MEDIDO).

Benchmarks públicos de fiabilidad JSON (abstracts HECHO VERIFICADO en arxiv.org; ninguno incluye modelos 5.5/6.x): **Structured Output Benchmark (SOB)** (arXiv 2604.25359, publicado 2026-04-28): 21 modelos, esquema + respuesta de referencia por registro; hallazgo del abstract: "models achieve near-perfect schema compliance, yet the best Value Accuracy, measured by exact leaf-value match, reaches only 83.0% on text, 67.2% on images, and 23.7% on audio". **JSONSchemaBench** (arXiv 2501.10868, publicado 2025-01-18): 10,000 esquemas JSON reales, evalúa decodificación restringida (Guidance, Outlines, LlamaCpp, XGrammar, OpenAI, Gemini) en eficiencia/cobertura/calidad. Conclusión aplicable (ahora respaldada por fuente primaria): **JSON válido ≠ valor correcto ni parche correcto**; la métrica útil para MainSpot es "tasa de parche aplicado sin cambios colaterales", que solo existe en LAB.

### 2.7 Multilingüe / español además de LMArena
- AA lista Global-MMLU-Lite como evaluación disponible (HECHO VERIFICADO que existe en /evaluations), pero no se obtuvieron valores por modelo (JS) → DESCONOCIDO.
- Gemini 3.8 Flash model card: regresión +5.4 pp en "Multilingual Safety" vs 3.7 Flash (HECHO VERIFICADO); Gemini 4 Argon: mejora −3.16 pp (HECHO VERIFICADO). Son métricas de seguridad, no de calidad lingüística.
- No existe benchmark público fechado de redacción comercial en español mexicano; la evidencia útil es LAB + LMArena Spanish.

---

## 3. Matriz por caso de uso (IDs reales de `src/ai/catalog.ts`)

Niveles: **barato** = Haiku 5.5 / GPT-6 Luna / Gemini 3.x Flash-Lite / DeepSeek Flash ($0.10–0.30 in); **medio** = GPT-6.1 Terra / Gemini 3.8 Flash ($0.75–1.00 in); **superior** = Sonnet 5.5 / GPT-6.1 Sol / Gemini 4 Argon ($2 in) y Opus 5.5 ($4 in).
Costo por llamada (ESTIMACIÓN: precio de lista × forma típica; sin caché, sin reintentos, sin thinking):

| Modelo | A: respuesta corta (2,500 in / 250 out) | B: diseño web (8,000 in / 7,000 out) | C: edición (12,000 in / 1,500 out) |
|---|---:|---:|---:|
| Claude Haiku 5.5 (≤100k) | $0.0004 | $0.0043 | $0.0019 |
| GPT-6 Luna | $0.0004 | $0.0043 | $0.0019 |
| DeepSeek V4.1 Flash (valle/pico) | $0.0005 / $0.0010 | $0.0054 / $0.0108 | $0.0027 / $0.0054 |
| Gemini 3.1 Flash-Lite | $0.0010 | $0.0125 | $0.0053 |
| Gemini 3.5 Flash-Lite | $0.0014 | $0.0199 | $0.0073 |
| GPT-6.1 Terra | $0.0037 | $0.0430 | $0.0195 |
| Gemini 3.8 Flash (intro → 2027) | $0.0028 → $0.0056 | $0.0323 → $0.0645 | $0.0146 → $0.0293 |
| Claude Sonnet 5.5 / GPT-6.1 Sol / Gemini 4 Argon (intro) | $0.0075 | $0.0860 | $0.0390 |
| Claude Opus 5.5 / Gemini 4 Argon (desde dic-2026) | $0.0150 | $0.1720 | $0.0780 |

Fórmula: costo = (tokens_in × precio_in + tokens_out × precio_out) / 10⁶. Los tokens Claude ≥4.7 son ~30% más por el mismo texto (HECHO VERIFICADO) → el costo real de Claude para el mismo texto sube ~30% respecto a la tabla si el recuento base es de otro tokenizador.

| Caso de uso | Qué exige | Benchmark(s) pertinente(s) | Evidencia LAB (resumen del encargo) | Nivel que parece suficiente | Alternativa / observación |
|---|---|---|---|---|---|
| `conversation.intent.classify`, `engagement.facebook.comment.classify`, `engagement.google.review.classify` | Precisión por clase, recall, p95, costo/evento | — (Jev/TypeSafe por DEC-0069; fuera del alcance de este archivo) | — | Jev | Si algún día se evaluara un LLM como respaldo: barato (Haiku/Luna/Flash-Lite) con enum estricto; Gemini Flash-Lite es el más rápido (442 tok/s, TTFT 6.8 s con thinking). |
| `engagement.facebook.comment.reply`, `engagement.google.review.reply` | Tono natural en español, seguridad, no inventar políticas | LMArena Spanish; τ² (seguir política) | Haiku 5.5 pasó respuestas (p50 2.1–2.5 s); Luna pasó también, ~40% más barato por éxito | **Barato** (Haiku 5.5) con revisión humana para quejas | Oficial Spanish: Luna 1442 > Haiku 5.5 1404 (Elo), pero Haiku conserva mejor τ² (72.8% vs 67.3%); escalar a Sonnet 5.5 (78.8% τ², Spanish 1448) en reseñas negativas/riesgo. |
| `social.facebook.post.compose` | Redacción social en español, hechos reales del negocio, CTA | LMArena Spanish; GDPval-AA (calidad de entregable) | Haiku 5.5 pasó posts (p50 13.1 s, p95 18.8 s); Luna pasó a 5.9 s y ~3× menos costo | **Barato** (Haiku 5.5) | Gemini 3.8 Flash puntúa 76 Elo más en español (1480 vs 1404) por ~7× el precio; útil como A/B futuro si la calidad percibida del copy limita la conversión. |
| `website.initial.design` | DSL JSON estricto de bloques, originalidad, 7k tokens de salida | Límites de esquema (§2.6); AA-Briefcase/GDPval (entregables); AA tok/s para salida larga | Haiku 5.5 pasó diseño (9/9, p50 17.1 s, ~3.4k tok out); Luna pasó (3/3, p50 13.4 s, ~2.0k tok out) | **Barato** si el esquema entra en los límites de Anthropic; **medio/superior** (Sonnet 5.5 / GPT-6.1 Sol) para calidad visual | Sonnet 5.5 "sharp eye for design" (Anthropic, autoevaluación); 7k tokens a 165 tok/s ≈ 42 s de decodificación en Haiku low, 68 s en Sonnet low (ESTIMACIÓN §4; las salidas medidas fueron menores, §4.1). |
| `website.edit.simple` | Seguir exactamente la instrucción, sin cambios colaterales, parche válido | IFBench (sin datos para 5.5/6.x), límites de esquema | **Haiku falló por límite de 16 uniones; Luna pasó (5/10 éxitos, p50 2.9 s); DeepSeek V4.1 Flash 0 llamadas reales** (sus 5 invocaciones son `circuit_open`: el circuito de OpenRouter estaba abierto y DeepSeek nunca recibió la petición — **no es un resultado de calidad**) | **Barato: GPT-6 Luna** (único barato que pasó) o rediseñar el esquema (<16 uniones) para Haiku | HIPÓTESIS: el límite de 16 uniones afecta igual a Sonnet/Opus 5.5; romper el esquema por tipo de bloque o usar validación en código (no strict) son las vías para mantener Anthropic. NO MEDIDO. Calidad de DeepSeek en edición: DESCONOCIDO (nunca se midió con llamada real). |
| `website.edit.complex` | Cambios estructurales, varios bloques, no romper otros | Igual + Terminal-Bench/FrontierCode como proxy de "editar sin romper" | Luna pasó; Haiku bloqueado por esquema | **Medio/superior** (GPT-6.1 Terra/Sol o Sonnet 5.5 con esquema adaptado) | FrontierCode: Sonnet 5.5 46–52%, Opus 5.5 54%, Luna 42% (autoevaluaciones). Para cambios complejos conviene modelo medio con verificación de diff en código. |
| `website.image.generate`, `social.facebook.image.generate` | Imagen | Fuera de alcance (texto) | BLOCKED | — | Ver archivo de imágenes del integrador. Google Nano Banana 2.1/2/Lite existen en la API ($0.034–$0.15/imagen en Vertex según resolución; HECHO VERIFICADO en pricing Vertex) como alternativa a `gpt-image-2`. |
| `conversation.owner.assistant` | Tool calls de solo lectura, grounding, multi-turno, latencia | τ² Airline, AutomationBench, BFCL (obsoleto) | Haiku 5.5 pasó asistente | **Barato** (Haiku 5.5, 72.8% τ², 86 s/tarea, $0.012/tarea) con escalado a **Sonnet 5.5** (78.8%, 71 s, $0.16) cuando hay >N tools o fallo de llamada | Luna 67.3% y requiere Responses API para tools (Chat Completions solo con effort none). Opus 5.5 no mejora τ² (75.3%) y cuesta 2×. |
| `marketing.campaign.plan` | Plan estructurado, alternativas, sin gasto real | AA-Briefcase/GDPval-AA (trabajo de conocimiento largo) | **Haiku falló parcialmente el plan** (1/2 éxitos; el fallo `invalid_output` sí costó $0.002); Luna 6/6 con p50 7.7 s | **Medio/superior** (Sonnet 5.5 Briefcase 1824 vs Haiku 1578; GPT-6.1 Sol medium 46 AA a $0.36/tarea) | Frecuencia baja por cliente/mes → el sobrecosto es tolerable; usar Batch (−50%) si no es interactivo. |
| `marketing.campaign.creatives` | Copys y variantes en español | LMArena Spanish | Haiku 5.5 pasó creatividades | **Barato** | Igual que posts. |
| `business.insights.generate` | Cifras verificables, no inventar, contexto de datos | AA-Omniscience (alucinación), GDP.pdf, prueba interna Anthropic 16/18 | Haiku 5.5 pasó insights | **Barato** con **cálculo en código** y plantillas que solo permitan citar valores del contexto | Gemini 4 Argon tiene 4% alucinación (AA) y Opus 5.5 el mejor Net Score entre modelos API (48); para informes mensuales de baja frecuencia podría justificarse superior. Haiku/Luna: DESCONOCIDO en Omniscience (datos solo en gráfico client-side; reintento con Chromium 2026-11-03 sin éxito, ver Huecos). |
| `editorial.calendar.suggest` | Planificación con restricciones de fechas | IFBench (sin datos) | **Haiku 0/1 (`invalid_output`, con costo $0.0024); Luna 5/5 pero con 80% de reparaciones y p50 16.3 s** | **Medio** (GPT-6.1 Terra / Gemini 3.8 Flash) o Sonnet 5.5 low ($0.51/tarea AA) | Baja frecuencia (1/mes/cliente): el costo absoluto es pequeño; la alta tasa de reparación de Luna sugiere schema/reglas frágiles más que incapacidad del modelo. |
| Propuesta: edición/adaptación de imágenes | — | — | — | — | Fuera de alcance de texto. |
| Propuesta: orquestación/enrutamiento explícito | Clasificar intención y escoger modelo/skill; reparar salidas inválidas | Latencia TTFT (§4); costo por decisión | — | **Barato sin razonamiento** (Luna non-reasoning 0.80 s TTFT; Haiku con thinking off NO MEDIDO) | Un enrutador LLM añade ≥1–3 s y ~$0.0004/decisión (ESTIMACIÓN forma A); Jev ya cubre clasificación por DEC-0069. |

### 3.1 Implicación de DEC-0073 para esta matriz (hechos, sin decidir por el propietario)

Estado: DEC-0073 (commit SOL MAIN `1f1c7da`, 2026-11-03) establece **OpenAI directo para toda la generación en desarrollo**; Anthropic queda deshabilitado como proveedor (migración `0029`, adaptador conservado) y OpenRouter deshabilitado; es explícitamente «configuración de desarrollo, no selección comercial irreversible» (HECHO VERIFICADO, `01-inventory.md` §8.0/§8.4 y `evidence/openai.md` §7.3). El catálogo SOL MAIN ya define candidatas de desarrollo vía OpenAI (`catalog.ts:290+`): diseño → **GPT-6.1 Sol** (0.25) y **GPT-6 Luna** (0.05), `reasoning_effort medium`; edición simple → **Luna** (0.02); edición compleja → **Sol** (0.2) + Luna (0.05); compose y creatividades → **Luna** (0.03).

Lectura sobre esta matriz (HECHO VERIFICADO el mapeo; la ponderación es análisis):

| Caso de uso | Ruta en desarrollo con DEC-0073 | Nivel equivalente en la matriz | Alternativas que quedan como canary/eval (no decididas) |
|---|---|---|---|
| `website.initial.design` | Sol (candidata principal) + Luna | medio/superior + barato | Sonnet 5.5 / Haiku 5.5 (Anthropic deshabilitado: requieren reactivación para evaluar); Argon |
| `website.edit.simple` / `edit.complex` | Luna / Sol+Luna | barato / medio-superior | Haiku con esquema <16 uniones; DeepSeek (calidad DESCONOCIDO: 0 llamadas reales en LAB); Flash-Lite |
| `social.facebook.post.compose`, `marketing.campaign.creatives` | Luna | barato | Haiku 5.5; Gemini 3.8 Flash (76 Elo arriba en Spanish oficial) |
| `engagement.*.reply` | (sin candidata explícita en `catalog.ts:290+`; la afinidad natural es Luna) | barato | Haiku 5.5; Sonnet 5.5 para reseñas de riesgo |
| `marketing.campaign.plan`, `editorial.calendar.suggest` | (sin candidata explícita; Sol es la afín por nivel) | medio/superior | Sonnet 5.5; Terra |
| `conversation.owner.assistant` | (sin candidata explícita; Luna requiere Responses API para tools) | barato | Haiku 5.5 (72.8% τ²); Sonnet 5.5 para escalamiento |
| `business.insights.generate` | (sin candidata explícita) | barato + cálculo en código | Argon (4% alucinación) u Opus 5.5 para informes de baja frecuencia |
| `conversation.intent.classify`, `engagement.*.classify` | **sin cambio**: TypeSafe/Jev conserva la clasificación primaria (DEC-0073 no la toca) | Jev | Decisions API de OpenAI (`gpt-6-luna`) como evaluación futura (ver `evidence/typesafe-jev.md` §4.3) |

Consecuencias para la evidencia: mientras Anthropic esté deshabilitado, el contraste Luna-vs-Haiku por caso (celdas LAB) no puede ampliarse por la vía directa Anthropic, y el límite de 16 uniones deja de manifestarse en desarrollo (OpenAI admite 5,000 propiedades) — la presión para rediseñar el esquema de edición desaparece operativamente pero el dato antropológico (Anthropic como alternativa técnica) queda sin poder recalibrarse. Argon y DeepSeek solo tienen sentido como **eval comparativa** para la decisión de producción; ninguna activación de ruta corresponde a este documento.

Regla de lectura: "parece suficiente" = la evidencia pública no contradice el resultado LAB; no es aprobación. Cualquier cambio de nivel o proveedor es propuesta para el propietario.

---

## 4. Latencia: p50 publicada y p95 estimada

Datos p50 de AA (HECHO VERIFICADO, 2026-11-03, 10k tokens de entrada, mediana 72 h, API de primera parte; **TTFT incluye thinking del nivel de esfuerzo**). Para Haiku 5.5 AA confirma que "low" sigue siendo variante de razonamiento (página /models/claude-haiku-5-5-low/providers: 8.96 s, 165.4 tok/s, "a non-reasoning variant may also exist" pero no está medida → DESCONOCIDO).

Fórmulas (ESTIMACIÓN):
- p50 total(N) = TTFT_p50 + N / v_p50
- p95 total(N) ≈ 2 × TTFT_p50 + N / (0.7 × v_p50) — **HIPÓTESIS**: AA no publica p95; se asume TTFT p95 = 2× p50 y throughput p95 = 70% del p50, valores conservadores típicos de APIs compartidas. Deben sustituirse por mediciones propias (NO MEDIDO).

| Modelo (config AA) | TTFT p50 (s) | tok/s p50 | p50 200 tok (s) | p50 7,000 tok (s) | p95 est. 200 tok (s) | p95 est. 7,000 tok (s) |
|---|---:|---:|---:|---:|---:|---:|
| Claude Haiku 5.5 (low) | 8.96 | 165 | 10.2 | 51.4 | 19.7 | 78.5 |
| Claude Haiku 5.5 (medium) | 13.81 | 169 | 15.0 | 55.2 | 29.3 | 86.8 |
| Claude Haiku 5.5 (high) | 31.95 | 181 | 33.1 | 70.6 | 65.5 | 119.1 |
| Claude Sonnet 5.5 (low) | 1.15 | 104 | 3.1 | 68.5 | 5.0 | 98.5 |
| Claude Sonnet 5.5 (medium) | 1.23 | 100 | 3.2 | 71.2 | 5.3 | 102.5 |
| Claude Sonnet 5.5 (high) | 13.94 | 106 | 15.8 | 80.0 | 30.6 | 122.2 |
| Claude Opus 5.5 (low) | 11.35 | 79 | 13.9 | 100.0 | 26.3 | 149.3 |
| Claude Opus 5.5 (medium) | 22.38 | 79 | 24.9 | 111.0 | 48.4 | 171.3 |
| GPT-6 Luna (non-reasoning) | 0.80 | 109 | 2.6 | 65.0 | 4.2 | 93.3 |
| GPT-6 Luna (low) | 2.91 | 115 | 4.6 | 63.8 | 8.3 | 92.8 |
| GPT-6 Luna (high) | 26.61 | 121 | 28.3 | 84.5 | 55.6 | 135.9 |
| GPT-6.1 Sol (low) | 2.51 | 61 | 5.8 | 117.3 | 9.7 | 169.0 |
| GPT-6.1 Sol (medium) | 8.90 | 63 | 12.1 | 120.0 | 22.3 | 176.5 |
| GPT-6.1 Terra (non-reasoning) | 0.94 | 91 | 3.1 | 77.9 | 5.0 | 111.8 |
| GPT-6.1 Terra (low) | 1.52 | 91 | 3.7 | 78.4 | 6.2 | 112.9 |
| Gemini 4 Argon (high) | 44.08 | 82 | 46.5 | 129.4 | 91.6 | 210.1 |
| Gemini 3.8 Flash (high) | 26.19 | 131 | 27.7 | 79.6 | 54.6 | 128.7 |
| Gemini 3.5 Flash-Lite | 6.82 | 442 | 7.3 | 22.7 | 14.3 | 36.3 |
| DeepSeek V4.1 Flash (non-reasoning) | 1.40 | 183 | 2.5 | 39.7 | 4.4 | 57.4 |
| DeepSeek V4.1 Flash (high) | 0.89 | 184 | 2.0 | 38.9 | 3.3 | 56.1 |
| Mistral Small 4 (non-reasoning) | 0.85 | 163 | 2.1 | 43.8 | 3.5 | 63.0 |
| Mistral Medium 3.5 | 2.45 | 178 | 3.6 | 41.8 | 6.5 | 61.1 |

Lecturas:
- Para respuestas cortas interactivas (200 tok), las configuraciones sin razonamiento o "low" de Sonnet/Luna/Terra/DeepSeek dan **p50 ≈ 2.5–3.2 s** y p95 estimado 4–5 s. Haiku 5.5 "low" según AA tarda 9 s en el primer token: si MainSpot desactiva el thinking (parámetro de la API), el TTFT real debería ser mucho menor, pero **no hay medición pública** → prioridad de medición en laboratorio (sin costo relevante: ~$0.001 por prueba).
- Para 7,000 tokens de salida (diseño web), el tiempo está dominado por la decodificación: **Haiku 5.5 (165–234 tok/s) ≈ 30–45 s; Sonnet 5.5 (100–139 tok/s) ≈ 50–70 s; GPT-6.1 Sol (61–91 tok/s) ≈ 77–115 s; Gemini 3.5 Flash-Lite (442 tok/s) ≈ 16 s**. Esto favorece streaming con vista previa progresiva o generación asíncrona (Batch −50%) en diseño inicial.
- Anthropic afirma "Sonnet 5.5 30%+ más rápido que Sonnet 5" y "Opus 5.5 >30% más rápido que Opus 5" (HECHO VERIFICADO en anuncios); Fast mode de Opus 5.5 "hasta 2.5×" a $8/$40 (no aplica a los casos de MainSpot por costo).
- Proveedores: AA solo mide a Anthropic como proveedor de Haiku 5.5 (1 proveedor); OpenRouter lista Anthropic, Bedrock, Vertex, Azure y AWS Marketplace a $0.10/$0.50 (y $0.11/$0.55 en regionales EU) para Haiku 5.5 (HECHO VERIFICADO en llms.txt de OpenRouter; solo lectura, sin ejecutar). No hay datos p50 por proveedor alternativo para los modelos 5.5.

### 4.1 Contraste de las estimaciones contra latencias MEDIDAS en laboratorio

Fuente: `evidence/lab-traces.md` (MEDICIÓN PROPIA histórica, 2026-10-30, vía OpenRouter, n pequeño, negocios sintéticos; latencia total de la invocación, no TTFT separado). Comparación: p50 medido vs p50 estimado por la fórmula §4 con la configuración AA más afín (TTFT + tokens_out_medidos / tok/s AA).

| Caso (tokens out medidos) | p50 medido | p95 medido | Estimación AA (config) | Desviación p50 |
|---|---:|---:|---|---|
| reply Luna (189 out) | 2.5 s | 3.8 s | 2.5 s (non-reasoning: 0.80 + 189/109) | ≈ 0 — coincide con la config **non-reasoning** de Luna, no con "low" |
| reply Haiku 5.5 (249 out) | 2.1 s | 4.0 s | 10.5 s (low: 8.96 + 249/165) | **−80%**: coherente con thinking desactivado (TTFT implícito ≈ 0.6 s, HIPÓTESIS) |
| compose Luna (745 out) | 5.9 s | 8.8 s | 7.6 s (NR) / 9.4 s (low) | −22% a −37% |
| design Luna (2,033 out) | 13.4 s | 15.3 s | 19.5 s (NR) | −31% |
| design Haiku 5.5 (3,396 out) | 17.1 s | 23.3 s | 29.6 s (low: 8.96 + 3,396/165) | −42% |
| compose Haiku 5.5 (2,550 out) | 13.1 s | 18.8 s | 24.4 s (low) | −46% |
| assistant Haiku 5.5 (427 out) | 7.4 s | 12.2 s | 11.5 s (low) | −36% |
| calendar Luna (1,860 out) | 16.3 s | 18.9 s | 17.9 s (NR) | −9% |
| edit.simple Luna (202 out) | 2.9 s | **14.1 s** | 2.7 s (NR) | p50 coincide; p95 es cola pesada (reparaciones/fallos, no latencia pura) |

Conclusiones del contraste:
1. Las estimaciones AA son **conservadoras**: el p50 medido queda 0–46% por debajo en todos los casos. Causas plausibles (HIPÓTESIS): la mediana AA cubre una ventana de 72 h con picos de carga y, para Luna, el laboratorio efectivamente corrió sin razonamiento visible (los p50 coinciden con la config non-reasoning).
2. **El TTFT de Haiku 5.5 "low" de AA (8.96 s) no describe las llamadas del laboratorio**: con 249 tokens de salida y 2.1 s totales, el TTFT implícito es ≈ 0.5–1 s. Esto apoya la hipótesis del hueco (AA mide la variante con thinking; OpenRouter corrió sin él), pero no sustituye la medición directa con la API de Anthropic (NO MEDIDO; y hoy sin ruta: Anthropic deshabilitado por DEC-0073).
3. La fórmula p95 ≈ 2× p50 es razonable para casos estables (p95/p50 medido 1.1–1.6 en reply/design/compose) pero **subestima la cola de casos con reparaciones** (edit.simple Luna p95/p50 = 4.9; creatividades Haiku 1.9): el p95 real de un caso se domina por reintentos, no por la latencia del modelo. Para el modelo económico, modelar p95 por caso como p50 × (1 + tasa de reparación × costo de reintento en tiempo), no con un multiplicador fijo.
4. Para diseño web las salidas medidas fueron ~2.0–3.4k tokens, no los 7k del perfil teórico: el p50 medido (13–17 s) es el mejor predictor disponible hoy; los 40–70 s de §4 aplican solo si la salida realmente crece a 7k tokens.

---

## 5. Proveedores directos alternativos: términos, datos y región

### 5.1 Google Gemini API / Vertex (Gemini Enterprise Agent Platform)
- **Uso de datos (HECHO VERIFICADO, Términos adicionales efectivos 2026-03-23):** *Unpaid Services* (AI Studio y cuota gratuita): "Google uses the content you submit… to provide, improve, and develop Google products and services and machine learning technologies"; "human reviewers may read, annotate, and process your API input and output"; "Do not submit sensitive, confidential, or personal information". *Paid Services* (proyecto Cloud con facturación activa): "Google doesn't use your prompts… or responses to improve our products", procesa bajo el **DPA de Google como encargado**, conserva logs "por tiempo limitado" solo para detectar abuso y "may be stored transiently or cached in any country in which Google or its agents maintain facilities".
- Restricciones de uso verificadas: solo mayores de 18 y apps no dirigidas a menores; prohibido uso clínico; apps con safety settings menos restrictivos pueden requerir revisión de Google; en EEE/Suiza/UK solo servicios de pago.
- Región (HECHO VERIFICADO, docs.cloud.google.com, página de Gemini 3.8 Flash, leída 2026-11-03): ML processing y PayGo listan multi-región `us`, `eu` y `global`; Provisioned Throughput igual. **`northamerica-south1` (Querétaro) no aparece** → no hay inferencia en México; sin ventaja de residencia frente a Anthropic/OpenAI (ambos +10% por región US/EU). Vertex cobra **+10% en endpoints no globales**; la Gemini Developer API es global.
- Latencia 3.8 Flash (HECHO VERIFICADO, misma página): `thinking_level="MINIMAL"` **no está disponible** en 3.8 Flash (valores LOW/MEDIUM/HIGH; MINIMAL devuelve error de validación) → la TTFT baja de Flash requiere `LOW`, no un modo sin thinking.
- Capacidades verificadas: Argon sin caché explícita; Flash con caché explícita + costo de almacenamiento por hora; Batch/Flex −50%; Priority ×1.8; grounding de pago.
- **Justificación de estudio:** español fuerte a bajo precio (3.8 Flash 1480 Elo oficial, variante High), τ² Flash-Lite 78.3% a $0.074/tarea, y 4% de alucinación de Argon. **En contra:** precios introductorios con subidas programadas (×2 en Argon desde 2026-12-01 y en 3.8 Flash desde 2027-01-01), TTFT alto con thinking (26–44 s en high; sin dato público para low), límites de esquema no cuantificados, y que la cuota gratuita **nunca** debe recibir datos de clientes (DEC-0067).

### 5.2 DeepSeek directo
- **Controlador y ubicación (HECHO VERIFICADO, Privacy Policy 2026-02-10):** "Hangzhou DeepSeek Artificial Intelligence Co., Ltd., registered address in China"; "we directly collect, process and store your Personal Data in People's Republic of China". La política **excluye** el tratamiento de datos de usuarios finales de apps construidas sobre la Open Platform: el desarrollador es el responsable.
- **Open Platform ToS (HECHO VERIFICADO, efectivos 2026-04-29):** el desarrollador debe informar a sus usuarios, obtener consentimiento o base legal "para la delegación del tratamiento a nosotros", responder solicitudes de derechos, y asumir responsabilidad solidaria por incumplimientos de usuarios finales; DeepSeek puede suspender cuentas sin aviso previo; prepago con reembolso solo del saldo total. Se asignan al desarrollador los derechos sobre Outputs y se permite destilación.
- **No localizado (DESCONOCIDO):** DPA para la API, compromiso explícito de no entrenar con Inputs de API (la Privacy Policy sí declara uso de "User Input" para entrenar sus modelos para los Servicios y un derecho de opt-out, sin indicar si aplica a la API), lista de subencargados, retención concreta.
- **Justificación de estudio:** el precio más bajo del conjunto ($0.15–0.30 / $0.60–1.20), 1M de contexto, API compatible con Anthropic, buen τ² (75.1%) y Spanish Elo oficial 1463 (variante 20260910) > Luna 1442 > Haiku 5.5 1404. **En contra decisivo:** transferencia internacional a China de datos de negocios mexicanos sin DPA verificable → incompatible con DEC-0067/0071 salvo decisión explícita del propietario y análisis legal (LFPDPPP/transferencias); además **0 llamadas reales en LAB** (los 5 intentos de edición fueron `circuit_open`, sin calidad medida) y modo non-reasoning con índice 19.

### 5.3 OpenAI (contexto para GPT-6 Luna / 6.1 Sol; verificación comercial detallada queda en el archivo del integrador)
- HECHO VERIFICADO (developers.openai.com/api/docs/guides/your-data): datos de API no se usan para entrenar desde 2023-03-01; logs de abuso hasta 30 días; ZDR/Modified Abuse Monitoring bajo aprobación; Responses API almacena 30 días si `store=true`; residencia regional US/EU con +10%; **no hay región México**. Estructured Outputs: el esquema se trata como "system data" fuera de la residencia.
- Nota operativa verificada: GPT-6 Luna solo soporta function calling en Chat Completions con `reasoning_effort: none`; con tools conviene Responses API. GPT-6.1 Sol requiere Responses API para tools.

---

## 6. Advertencias de comparabilidad (leer antes de usar cualquier cifra)

1. **Niveles de esfuerzo:** AA publica un índice por nivel (low…max). Comparar "Haiku max 36" con "Luna max 28" es válido; comparar un modelo en max con otro en low no. Los TTFT de AA incluyen el razonamiento del nivel y el modo "thinking off" de Anthropic no está medido públicamente.
2. **Tokenizadores:** Claude ≥4.7 produce ~30% más tokens por el mismo texto (HECHO VERIFICADO). Igual precio por MTok ≠ igual costo por tarea. AA corrige con "$/tarea"; las tablas de precio por MTok no.
3. **Autoevaluaciones:** las tablas de Anthropic/Google/OpenAI usan sus propios harness y a veces fallbacks (Opus 5.5 "con fallback" a Opus 4.8/5 cuando intervienen salvaguardas); OpenAI toma los números de la competencia de informes públicos.
4. **Precios introductorios:** Gemini 4 Argon ×2 el 2026-12-01; Gemini 3.8/3.7/3.6 Flash ×2 el 2027-01-01; GPT-5.6 Sol promocional hasta 2026-11-21. Las comparaciones de "igual precio que Sonnet 5.5" caducan en semanas.
5. **Horas pico DeepSeek** cambian el precio ×2 según UTC.
6. **LMArena Spanish** ahora es el tablero oficial arena.ai (HECHO VERIFICADO con navegador, snapshot 2026-10-27, vista con Style Control); los candidatos nuevos siguen teniendo pocos votos (306–493) con intervalos ±24–34 Elo: diferencias <30 Elo no son significativas. La réplica de llmbenchmark.ai difiere −51…+16 Elo con los mismos votos: no usarla para rankings, solo para conteos.
7. **τ² en OpenRouter** mide modelo+proveedor enrutado; los modelos OpenAI 6.x tienen una sola corrida; el tablero oficial de Sierra no incluye candidatos actuales.
8. **BFCL** está congelado en abril 2026; **IFBench/IFEval** sin datos publicados para los candidatos; **fiabilidad JSON** sin benchmark que cubra 5.5/6.x.
9. **Latencia p95** de §4 es estimación con multiplicadores supuestos; AA solo publica medianas.
10. **Evidencia LAB** citada proviene del encargo (no recalculada aquí): Haiku 5.5 pasó diseño/post/respuestas/asistente/insights/creatividades; Luna pasó todo incl. ediciones con 17 uniones; Haiku falló ediciones (límite de 16 uniones de Anthropic) y parcialmente calendario/plan; DeepSeek V4.1 Flash 0/5 en edición simple. Tamaños de muestra pequeños.

---

## Fuentes

1. Artificial Analysis — LLM Leaderboard (Intelligence Index v5, $/tarea, tok/s, TTFT). https://artificialanalysis.ai/leaderboards/models — 2026-11-03 — tabla completa §2.1 y latencias §4.
2. Artificial Analysis — Claude Haiku 5.5 (max) página de modelo. https://artificialanalysis.ai/models/claude-haiku-5-5 — 2026-11-03 — índice 36, 234 tok/s, verbosidad 300M tokens, nota "a non-reasoning variant may also exist".
3. Artificial Analysis — Claude Haiku 5.5 (max) proveedores. https://artificialanalysis.ai/models/claude-haiku-5-5/providers — 2026-11-03 — 1 proveedor (Anthropic), 233.8 t/s, TTFT 343.44 s, metodología 10k input / mediana 72 h.
4. Artificial Analysis — Claude Haiku 5.5 (low) proveedores. https://artificialanalysis.ai/models/claude-haiku-5-5-low/providers — 2026-11-03 — 165.4 t/s, TTFT 8.96 s, $0.04/tarea.
5. Artificial Analysis — IFBench. https://artificialanalysis.ai/evaluations/ifbench — 2026-11-03 — descripción, líderes (Grok 4.3 83.3%), valores de candidatos no renderizados.
6. Artificial Analysis — AA-Omniscience v1.1. https://artificialanalysis.ai/evaluations/omniscience — 2026-11-03 — Net Score líderes (Carbon 54, Opus 5.5 48), alucinación (Argon 4%), deltas v1→v1.1.
7. Anthropic — Pricing (docs). https://platform.claude.com/docs/en/about-claude/pricing — 2026-11-03 — precios 5.5, caché, batch, long context Haiku, tokenizador +30%, tool use tokens, inference_geo 1.1×, fast mode.
8. Anthropic — Structured outputs (docs). https://platform.claude.com/docs/en/build-with-claude/structured-outputs — 2026-11-03 — límites 16 uniones / 24 opcionales / 20 tools, timeout 180 s, modelos soportados, ZDR.
9. Anthropic — Introducing Claude Haiku 5.5. https://www.anthropic.com/claude-haiku-5-5 — 2026-11-03 — fecha 2026-10-07, tabla de benchmarks vs Luna/Sonnet, precios, testimonios, Sonnet cache read $0.10.
10. Anthropic — Introducing Claude Sonnet 5.5. https://www.anthropic.com/claude-sonnet-5-5 — 2026-11-03 — fecha 2026-09-28, tabla vs Opus 5.5/GPT-6 Sol, velocidad +30%.
11. Anthropic — Introducing Claude Opus 5.5. https://www.anthropic.com/claude-opus-5-5 — 2026-11-03 — fecha 2026-09-22, tabla, prueba 16/18 informes sin cifras inventadas, fast mode.
12. OpenAI — Pricing. https://developers.openai.com/api/docs/pricing — 2026-11-03 — tablas Standard/Batch/Flex/Fast/Ultrafast, recargo regional 10%, promo GPT-5.6 Sol.
13. OpenAI — GPT-6 Luna model page. https://developers.openai.com/api/docs/models/gpt-6-luna — 2026-11-03 — ID, contexto, precios, effort none…max, limitación Chat Completions, rate limits.
14. OpenAI — GPT-6.1 Sol model page. https://developers.openai.com/api/docs/models/gpt-6.1-sol — 2026-11-03 — ID, precios, tools solo Responses, rate limits.
15. OpenAI — Introducing GPT-6 Sol and Luna. https://openai.com/index/introducing-gpt-6-sol-and-luna/ — 2026-11-03 — precios −50%, AutomationBench, DeepSWE, factualidad, disponibilidad.
16. OpenAI — Structured model outputs (docs). https://developers.openai.com/api/docs/guides/structured-outputs — 2026-11-03 — límites 5,000 propiedades / 10 niveles / 1,000 enum / 120k caracteres.
17. OpenAI — Data controls (your data). https://developers.openai.com/api/docs/guides/your-data — 2026-11-03 — no entrenamiento, logs 30 días, ZDR, residencia regional y +10%.
18. Google — Gemini Developer API pricing. https://ai.google.dev/gemini-api/docs/pricing (resuelve a https://aistudio.google.com/docs/pricing) — 2026-11-03 — precios Argon/3.8 Flash/3.5 Flash-Lite/3.1 Flash-Lite, subidas programadas, free tier, grounding, Batch/Flex/Priority.
19. Google — Gemini API Additional Terms of Service. https://ai.google.dev/gemini-api/terms (resuelve a https://aistudio.google.com/docs/terms) — 2026-11-03 — uso de datos Unpaid vs Paid, revisión humana, DPA, restricciones.
20. Google — Models list. https://ai.google.dev/gemini-api/docs/models (resuelve a https://aistudio.google.com/docs/models) — 2026-11-03 — IDs vigentes, deprecaciones 2.5 → 3.5 Flash-Lite / 3.8 Flash el 2026-12-01.
21. Google — Gemini 4 Argon model page. https://ai.google.dev/gemini-api/docs/models/gemini-4-argon — 2026-11-03 — contexto 1,048,576, salida 65k/1M, caché implícita, thinking low/medium/high.
22. Google — Structured outputs (docs). https://ai.google.dev/gemini-api/docs/structured-output — 2026-11-03 — constraints ignorados, límites de estados/ramas/profundidad, error 400, recomendaciones.
23. Google Cloud — Agent Platform / Model Garden pricing. https://cloud.google.com/vertex-ai/generative-ai/pricing (resuelve a https://cloud.google.com/model-garden/pricing) — 2026-11-03 — precios Global/Non-global, Priority, Flex/Batch, cobro por timeouts >32K desde 2026-11-13, precios de imagen Nano Banana.
24. Google DeepMind — Gemini 4 Argon model card. https://deepmind.google/models/model-cards/gemini-4-argon/ — 2026-11-03 — tabla de benchmarks vs Astra/Fable 5.1/Opus 5.5, corte marzo 2026, seguridad multilingüe.
25. Google DeepMind — Gemini 3.8 Flash model card. https://deepmind.google/models/model-cards/gemini-3-8-flash/ — 2026-11-03 — tabla vs Opus 5/Sonnet 5/GPT-5.6, regresión multilingüe +5.4 pp.
26. DeepSeek — Models & Pricing. https://api-docs.deepseek.com/quick_start/pricing/ — 2026-11-03 — `deepseek-flash` = V4.1-Flash-1017, precios pico/valle, concurrencia, capacidades.
27. DeepSeek — V4.1 Flash 1017 release note. https://api-docs.deepseek.com/news/news261017/ — 2026-11-03 — fecha, benchmarks en imagen, pesos abiertos, Search/Fetch $0.75/1k.
28. DeepSeek — Privacy Policy (2026-02-10). https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html — 2026-11-03 — controlador en China, almacenamiento en RPC, exclusión de usuarios finales de apps.
29. DeepSeek — Open Platform Terms of Service (efectivos 2026-04-29). https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html — 2026-11-03 — obligaciones del desarrollador, Inputs/Outputs, suspensión, reembolsos.
30. OpenRouter — τ²-Bench Airline leaderboard (solo lectura de página). https://openrouter.ai/benchmarks/tau2-bench-airline/ — 2026-11-03 — exactitud/costo/tiempo por modelo, última corrida 2026-11-03 04:31 UTC.
31. OpenRouter — Claude Haiku 5.5 llms.txt (solo lectura). https://openrouter.ai/anthropic/claude-haiku-5.5/llms.txt — 2026-11-03 — proveedores y precios por región.
32. Sierra — τ²-bench submissions manifest. https://raw.githubusercontent.com/sierra-research/tau2-bench/main/web/leaderboard/public/submissions/manifest.json — 2026-11-03 — lista de submissions oficiales (sin modelos 5.5/6.x).
33. UC Berkeley — BFCL V4 leaderboard. https://gorilla.cs.berkeley.edu/leaderboard — 2026-11-03 — "Last Updated 2026-04-12"; tabla no extraíble.
34. LMArena oficial — Text Arena, categoría **Spanish**. https://arena.ai/leaderboard/chat/text/spanish — 2026-11-03 (leída con Chromium real; la URL `arena.ai/leaderboard/text` devuelve HTTP 403 al lector estático) — snapshot 2026-10-27, 185,275 votos, 303 modelos, vista por defecto con Style Control; tabla de §2.3 y Overall (Luna 1441, Haiku 5.5 1425, Argon 1520, Opus 5.5 1509).
35. llmbenchmark.ai — LMArena Text: Spanish (replicador tercero, cruce de consistencia). https://llmbenchmark.ai/benchmarks/lmarena-text-spanish — 2026-11-03 — mismos conteos de votos que la oficial, Elo −51…+16 distintos (ajuste/versión diferente); NO usar para rankings.
36. Google blog — Introducing Gemini 4 Carbon (HECHO VERIFICADO). https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-carbon/ — 2026-11-03 — anuncio 2026-10-28, AA v5.0 #1 con 59, acceso solo cyber defenders/Fairwind, $2/$10 intro → $4/$20, caché 95% desc., sin API pública.
37. Google Cloud docs — Gemini 3.8 Flash (HECHO VERIFICADO). https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash — 2026-11-03 — multi-región us/eu + global (sin `northamerica-south1`), `thinking_level` sin MINIMAL, límites de contexto/salida.
38. arXiv 2604.25359 — Structured Output Benchmark (abstract HECHO VERIFICADO, publicado 2026-04-28); arXiv 2501.10868 — JSONSchemaBench (abstract HECHO VERIFICADO, publicado 2025-01-18) — 2026-11-03 — JSON válido ≠ valor correcto (Value Accuracy máx. 83.0% en texto).

## Huecos

| Hueco | Por qué importa | Cómo verificarlo |
|---|---|---|
| TTFT y tok/s de Haiku 5.5, Sonnet 5.5 y Gemini 3.8 Flash **con thinking desactivado/mínimo** | Es la configuración real de MainSpot para respuestas cortas; AA solo mide niveles con razonamiento (Haiku low 8.96 s). El contraste §4.1 apoya que el TTFT real de Haiku sin thinking es ≈ 0.5–1 s (p50 2.1 s con 249 tok out), pero es inferencia indirecta | Medición propia: 30 llamadas por modelo/config con 2.5k tokens de entrada y 200 de salida, p50/p95 de TTFT y total; costo ≈ <$0.05 total en Haiku/Luna, <$1 en Sonnet (dentro de DEC-0068). Nota: para Haiku/Sonnet requiere reactivar la ruta Anthropic (DEC-0073); para 3.8 Flash el mínimo es `LOW` (sin MINIMAL, HECHO VERIFICADO). NO MEDIDO. |
| p95 de latencia de cualquier proveedor | §4 usa multiplicadores supuestos (2× TTFT, 0.7× throughput); §4.1 muestra que el p95 medido se domina por reparaciones (p95/p50 hasta 4.9), no por el modelo | Misma medición anterior durante 3 franjas horarias (mañana/tarde/noche CDMX) por 3 días, registrando intentos de reparación por invocación. NO MEDIDO. |
| IFEval/IFBench y Global-MMLU-Lite por modelo (5.5/6.x) | "Edición precisa sin cambios colaterales" y español | Intentado 2026-11-03 con Chromium real: AA renderiza líderes en texto pero los valores por modelo viven solo en datos de gráfico client-side (no en DOM ni endpoint visible). Vía restante: tooltips del gráfico, API de datos de AA (clave) o correr IFBench (dataset abierto, allenai/IFBench_test) en laboratorio con Haiku/Luna/Flash-Lite (~$0.5–2). |
| Fiabilidad de salida estructurada con el esquema real de 17 uniones en Sonnet/Opus 5.5 y en Gemini 3.8 Flash | Determina si Anthropic puede cubrir `website.edit.*` sin cambiar proveedor (condición de la alternativa técnica tras DEC-0073) | Prueba de compilación de esquema (1 petición mínima por modelo; costo ≈ $0.01) y prueba de 20 parches sintéticos con validación de diff; requiere ruta Anthropic reactivada para eval (DEC-0073). NO MEDIDO. |
| ~~LMArena oficial (texto y categoría Spanish)~~ **CERRADO 2026-11-03 (auditoría)** | Verificar los Elo tomados de un replicador | Leído arena.ai con navegador: Spanish (Argon 1496, Opus 5.5 1488, Sol 1475, Luna 1442, Haiku 5.5 1404) y Overall; la réplica difiere −51…+16 Elo con los mismos votos (§2.3). |
| Benchmarks de DeepSeek V4.1 Flash 1017 (tabla en imagen) | Evaluar la calidad del modelo candidato barato; **aclaración: el "0/5 en edición" del LAB no es calidad** (fueron `circuit_open`, DeepSeek nunca recibió peticiones — §3), así que no hay medición de calidad real de DeepSeek en ningún caso | Leer la imagen `v4.1_261017_benchmark_table_en.png` con `read` de imagen o la model card en Hugging Face. Nota: en arena.ai solo aparece la variante V4.1-Flash-20260910 (Overall 1476, Spanish 1463), no la 1017. |
| Precios oficiales de Mistral, Qwen (Alibaba Cloud) y xAI | Se descartaron por calidad/costo en AA sin verificar precios | Leer mistral.ai/pricing, alibabacloud.com model-studio pricing, docs.x.ai pricing si el integrador los necesita. |
| DPA, política de entrenamiento y subencargados de la API de DeepSeek; retención | Condición de DEC-0067/0071 para datos reales | Buscar en platform.deepseek.com (requiere cuenta; no se accedió) y solicitar a legal; sin esto DeepSeek queda fuera. |
| ~~Regiones de Vertex para Gemini en México (`northamerica-south1`)~~ **CERRADO 2026-11-03 (auditoría, para 3.8 Flash)**: la página del modelo lista solo `us`/`eu` multi-región + `global`; no hay inferencia en México (§5.1) | Residencia de datos de clientes mexicanos | Pendiente la parte de subencargados de Google para Gemini API: business.safety.google/processorterms. |
| Anuncio oficial de GPT-6.1 Sol con tabla de benchmarks | Nivel "superior" de OpenAI sin autoevaluación leída | Leer https://openai.com/index/introducing-gpt-6-1-sol/. |
| Cifras de AA-Omniscience (alucinación) para Haiku 5.5, Luna, Sonnet 5.5, 3.8 Flash | `business.insights.generate` sin cifras inventadas | Igual que IFBench: el reintento 2026-11-03 con Chromium real no expone los valores (datos de gráfico client-side); vía restante: tooltips, API de datos de AA o medición propia. |
| Evolución de precios tras 2026-11-30 (Argon) y 2027-01-01 (Flash) y posible fin de precio Haiku/Luna | Sensibilidad del modelo económico | Reverificar las páginas de pricing en cada corte mensual del informe. |
