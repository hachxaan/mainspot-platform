# Evidencia — OpenAI (API directa): gpt-image-2, modelos de texto GPT-6, límites, datos y economía unitaria

Fecha de consulta de todas las fuentes: **2026-11-03**. Moneda: **USD** salvo indicación. Unidad de facturación: tokens (1M = 1 000 000) salvo indicación.
Alcance: investigación, sin llamadas pagadas (ninguna petición a `api.openai.com` fue ejecutada). Todo dato marcado **HECHO VERIFICADO** se leyó con `read` en la URL oficial indicada en `## Fuentes`; **SNIPPET** = visto solo en resultado de búsqueda; **ESTIMACIÓN** = cálculo propio con fórmula; **HIPÓTESIS** = supuesto razonado; **DESCONOCIDO** = no verificable con fuentes públicas.

Contexto de política (no se modifica): DEC-0069 (OpenAI directo `gpt-image-2` para imágenes; texto OpenAI solo como alternativa evaluada), DEC-0071/DEC-0067 (datos reales con términos verificados), DEC-0068 (techo laboratorio USD 25). **Actualización 2026‑11‑03:** DEC-0073/SRC-0011 (commit SOL MAIN `1f1c7da`) establece OpenAI directo para **toda la generación de desarrollo** (texto e imágenes), con Anthropic deshabilitado como proveedor y TypeSafe/Jev primario; sigue sin decidir producción. Implicaciones económicas en §7.3.

---

## 0. Resumen ejecutivo (veredictos)

| Pregunta | Veredicto | Etiqueta |
| --- | --- | --- |
| ¿`gpt-image-2` existe como modelo de la API pública? | **SÍ.** ID exacto `gpt-image-2`, snapshot `gpt-image-2-2026-04-21`, lanzado 2026-04-21. Endpoints: `v1/images/generations`, `v1/images/edits`, `v1/batch`. En Responses API solo como `model` de la herramienta `image_generation` (el `model` de nivel superior de Responses NO puede ser `gpt-image-2`). Estado: GA (sin «preview» en el nombre); fondo transparente «en preview». | HECHO VERIFICADO |
| ¿Es el modelo de imagen vigente de OpenAI? | **Parcial.** Ya existe la generación siguiente `gpt-image-2.5-sunburst` y `gpt-image-2.5-flare` (2026-09-08), mismas tarifas por token, calidades extra `xhigh`/`max`. La guía oficial dice «For new integrations, use one of the GPT Image 2.5 models». `gpt-image-2` **no** está deprecado a 2026-11-03. | HECHO VERIFICADO |
| `openai-codex/gpt-image-2` en OMP ≠ API | El prefijo `openai-codex/` identifica acceso por **suscripción ChatGPT/Codex (OAuth)**; el backend productivo requiere **API key de plataforma** bajo el Services Agreement. Las Terms of Use de consumidor prohíben extraer salida «automatically or programmatically» y «modify, copy, lease, sell or distribute any of our Services»; los planes Plus/Pro **no** tienen compromiso de no‑entrenamiento por defecto. Veredicto: **no usar la suscripción Codex en el backend de MainSpot.** | HECHO VERIFICADO |
| Precio de referencia por imagen (`gpt-image-2`, estándar, solo tokens de salida) | 1024×1024: low $0.006 / medium $0.053 / high $0.211. 1536×1024 y 1024×1536: low $0.005 / medium $0.041 / high $0.165. Batch (ventana 24 h): −50 %. | HECHO VERIFICADO |
| Texto: familia vigente | GPT‑6 **Astra / Sol / Terra / Luna** (+ `gpt-6.1-sol`, `gpt-6.1-terra`). **No existe «mini/nano» en GPT‑6**; `gpt-5.4-mini`/`gpt-5.4-nano` son generación anterior (nano deprecado, apagado 2027‑04‑01). | HECHO VERIFICADO |
| Precios texto clave (estándar, ≤272K) | `gpt-6-luna` $0.10 in / $0.01 cached / $0.50 out · `gpt-6.1-terra` $1 / $0.05 / $5 · `gpt-6.1-sol` $2 / $0.10 / $10 · `gpt-6-astra` $10 / $1 / $50. Batch y Flex = 50 %; Fast (ex‑Priority) = 2×; Ultrafast (Sol/Astra) = 6×; residencia regional +10 %. | HECHO VERIFICADO |
| Caché GPT‑6 | Mínimo cacheable **1 024 tokens**; lecturas 0.1× (Luna/Astra) o 0.05× (6.1 Sol/Terra); **escrituras se cobran**: 1.25× (30 min) / 2.5× (12 h). Un perfil de 800 tokens de entrada **no** puede cachearse. | HECHO VERIFICADO |
| Structured Outputs | Tipos: string/number/boolean/integer/object/array/enum/**anyOf**; raíz debe ser objeto (no anyOf); todo `required`; `additionalProperties:false`; ≤5 000 propiedades; ≤10 niveles; ≤1 000 valores enum; 120 000 caracteres de nombres. **No hay límite publicado al número de variantes `anyOf`** (vs. 16 uniones en Anthropic). | HECHO VERIFICADO (límite 17 uniones: NO MEDIDO) |
| Datos | API: no entrenamiento por defecto; logs de abuso 30 días; `/v1/images/*` sin estado de aplicación y **ZDR‑elegible con `gpt-image-2`**; ZDR/MAM requieren aprobación de ventas; residencia: sin región México (US/EU con procesamiento regional; +10 %). DPA pública (efectiva 2026‑01‑01), lista de subencargados (2026‑10‑14), SOC 2 Type 2 + ISO 27001/27017/27018/27701/42001. | HECHO VERIFICADO |
| Uptime API (4 ago–2 nov 2026) | APIs 99.97 % (2 días outage parcial); **Images 99.990 %** (1 día outage parcial, 7 degradados); Batch 100 %; Codex 99.94 % (1 día outage total). | HECHO VERIFICADO |
| Facturación | Créditos API **solo en USD**; precios sin impuestos (§6.3 Services Agreement, gross‑up si hay retención); cambios de precio efectivos 14 días tras publicarse; tiers Build/Launch/Grow por créditos acumulados ($5 / $100 / $500) con límite mensual $500 / $5 000 / $200 000. | HECHO VERIFICADO |
| ¿Qué implica DEC‑0073 (OpenAI para toda la generación en desarrollo)? | Sol = Sonnet 5.5 y Luna = Haiku 5.5 **tarifa por token idéntica** a Anthropic directo: la comparación la deciden los tokens por tarea (medidos solo vía OpenRouter, §7.4); el esquema de 17 uniones es plausible (sin límite publicado de `anyOf`) **pero la raíz no puede ser `anyOf`**; Sol no admite `none`; dependencia de un solo proveedor mitigada conservando el adaptador Anthropic sin fallback. No decide producción. | HECHO VERIFICADO (hechos) + ESTIMACIÓN (económico) |

---

## 1. `gpt-image-2` y la familia GPT Image

### 1.1 Identidad, estado y endpoints — HECHO VERIFICADO

| Dato | Valor | Fuente |
| --- | --- | --- |
| Model ID / snapshot | `gpt-image-2` → `gpt-image-2-2026-04-21` (único snapshot) | [F2] |
| Fecha de lanzamiento | 2026‑04‑21 («Released GPT Image 2 … flexible image sizes, high‑fidelity image inputs, token‑based image pricing, and Batch API support with a 50 % discount») | [F6] changelog Apr 21 |
| Modalidades | Entrada: texto, imagen. Salida: imagen | [F2] |
| Endpoints soportados | `v1/images/generations` ✔, `v1/images/edits` ✔, `v1/batch` ✔. `v1/responses` **Not supported** como modelo principal; `v1/chat/completions` ✘ | [F2] |
| Uso en Responses API | Como `model` dentro de la herramienta `{type:"image_generation", model:"gpt-image-2"}` con un modelo principal GPT‑5+ (p. ej. `gpt-6-luna`). La guía de la herramienta lista `gpt-image-2` como soportado. | [F11] |
| Features | `inpainting` (edición con máscara) | [F2] |
| Estado | GA. Sin sufijo `preview`. Fondo transparente «available in preview» desde 2026‑08‑20 | [F2][F6] |
| Deprecación | No anunciada a 2026‑11‑03. Modelos GA: aviso mínimo 6 meses | [F7] |
| Verificación de organización | La guía: «you may need to complete the API Organization Verification … before using GPT Image models». La verificación puede ser de negocio (nombre legal, dirección, RFC/registro, documentos) y/o identidad (ID gubernamental físico, selfie; 1 persona = 1 organización). | [F3][F12] |

**Veredicto gpt-image-2 en API pública: SÍ (completo en Images API y Batch; parcial en Responses: solo vía herramienta).**

### 1.2 Generación siguiente y deprecaciones — HECHO VERIFICADO

| Modelo | Estado 2026‑11‑03 | Nota |
| --- | --- | --- |
| `gpt-image-2.5-sunburst` (`-2026-09-08`) | Vigente, recomendado para «editing precision» | Mismas tarifas por token que gpt‑image‑2; calidades `low…max`; `markup` (overlay PNG) solo 2.5 |
| `gpt-image-2.5-flare` (`-2026-09-08`) | Vigente, «fastest … everyday image generation» | Mismas tarifas; la calculadora de gpt‑image‑2 **no** estima su consumo de tokens |
| `gpt-image-2` | Vigente; la guía lo agrupa en «Earlier GPT Image models» | Único con tabla pública de costo por imagen |
| `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest` | **Deprecados**, apagado **2026‑12‑01** | Reemplazo: 2.5 sunburst/flare |
| `gpt-image-1` | **Apagado 2026‑10‑23** | — |
| `dall-e-2`, `dall-e-3` | **Eliminados 2026‑05‑12** | — |

Fuentes: [F7] deprecations, [F6] changelog, [F3] guía, [F9][F10] páginas de modelo.

### 1.3 Precios por token (Images API y herramienta) — HECHO VERIFICADO [F1]

| Modelo | Tier | Texto in | Texto in cached | Imagen in | Imagen in cached | Imagen out |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gpt-image-2` | Standard | $5.00 | $1.25 | $8.00 | $2.00 | **$30.00** |
| `gpt-image-2` | Batch | $2.50 | $0.625 | $4.00 | $1.00 | $15.00 |
| `gpt-image-2.5-sunburst` / `-flare` | Standard | $5.00 | $1.25 | $8.00 | $2.00 | $30.00 |
| `gpt-image-2.5-*` | Batch | $2.50 | $0.625 | $4.00 | $1.00 | $15.00 |
| `gpt-image-1.5` (deprec.) | Standard | $5.00 | $1.25 | $8.00 | $2.00 | $32.00 (+ texto out $10) |
| `gpt-image-1-mini` (deprec.) | Standard | $2.00 | $0.20 | $2.50 | $0.25 | $8.00 |
| `gpt-image-1-mini` (deprec.) | Batch | $1.00 | $0.10 | $1.25 | $0.13 | $4.00 |

Nota oficial: «Cached input rates for GPT Image 2 and GPT Image 2.5 only apply to images generated with the Responses API. It doesn't apply to direct Images API requests, including `/v1/images/edits`.» [F3]
⚠ El resultado de búsqueda inicial mostraba $4/$15 como «standard»: era la columna **Batch**. Corregido con la página oficial.

### 1.4 Costo por imagen (solo tokens de salida, Standard) — HECHO VERIFICADO [F3 §Calculating costs]

| Modelo | Calidad | 1024×1024 | 1024×1536 | 1536×1024 |
| --- | --- | ---: | ---: | ---: |
| **GPT Image 2** | low | $0.006 | $0.005 | $0.005 |
|  | medium | **$0.053** | **$0.041** | **$0.041** |
|  | high | $0.211 | $0.165 | $0.165 |
| GPT Image 1.5 (deprec.) | low / medium / high | $0.009 / $0.034 / $0.133 | $0.013 / $0.05 / $0.2 | $0.013 / $0.05 / $0.2 |
| GPT Image 1 (apagado) | low / medium / high | $0.011 / $0.042 / $0.167 | $0.016 / $0.063 / $0.25 | $0.016 / $0.063 / $0.25 |
| GPT Image 1 Mini (deprec.) | low / medium / high | $0.005 / $0.011 / $0.036 | $0.006 / $0.015 / $0.052 | $0.006 / $0.015 / $0.052 |

Observación oficial: «A larger non‑square resolution can sometimes produce fewer output tokens than a smaller or square resolution at the same quality setting» (por eso 1536×1024 medium < 1024² medium). Para 2K/4K no hay tabla pública; la guía remite a la calculadora interactiva (componente JS no legible en texto). → **DESCONOCIDO** costo 2K/4K.

**Cruce con `evidence/image-providers.md` §8 (2026‑11‑03):** tarifas por token ($5 texto / $8 imagen in / $30 imagen out; Batch $2.50/$4/$15), costos por imagen ($0.006/$0.053/$0.211 y $0.005/$0.041/$0.165), 16 imágenes de entrada, ZDR elegible e IPM — **coinciden sin discrepancia**. Ese documento cita a este archivo como fuente; la verificación de hoy (2026‑11‑03) contra la página oficial de precios y la guía de image generation confirma ambas cifras. Nota: la tabla de tokens por imagen (272/1056/4160 en 1024²) que aparece en la guía corresponde a los modelos previos (GPT Image 1, apagado 2026‑10‑23), no a `gpt-image-2`; los tokens de salida de `gpt-image-2` solo se obtienen de la calculadora o de `usage` real.

**ESTIMACIÓN** de tokens de salida implícitos (costo ÷ $30/M): 1024² low ≈ 200, medium ≈ 1 767, high ≈ 7 033; 1536×1024 low ≈ 167, medium ≈ 1 367, high ≈ 5 500.
`gpt-image-2.5-*`: «Equal token rates don't mean equal cost per image: token consumption can differ by model and quality setting» → costo por imagen **DESCONOCIDO** sin medición.

### 1.5 Parámetros y capacidades (Images API) — HECHO VERIFICADO [F13][F14][F3]

| Capacidad | gpt-image-2 | Detalle |
| --- | --- | --- |
| Tamaños | Arbitrarios `WIDTHxHEIGHT`: múltiplos de 16; ratio entre 1:3 y 3:1; lado ≤ 3 840 px; píxeles totales 655 360–8 294 400 (4K). Populares: 1024², 1536×1024, 1024×1536, 2048², 2048×1152, 3840×2160, 2160×3840, `auto`. >2560×1440 «experimental». | [F3][F13] |
| Calidad | `low`, `medium`, `high`, `auto` (default). `xhigh`/`max` solo 2.5 | [F13] |
| Formatos | `png` (default), `jpeg`, `webp`; `output_compression` 0–100 para jpeg/webp; «jpeg is faster than png» | [F3][F13] |
| Transparencia | `background: transparent` (png/webp) — **preview** para gpt‑image‑2; GA en 2.5 | [F13][F6] |
| `n` | 1–10 imágenes por llamada (generations y edits) | [F13][F14] |
| `moderation` | `auto` (default) o `low` | [F13][F3] |
| Edición | `images[]` hasta **16** imágenes de entrada (file_id o data URL ≤ 20 MB); `mask` (misma dimensión/formato, con canal alfa, <50 MB); `markup` solo 2.5 | [F14][F3] |
| `input_fidelity` | «For `gpt-image-2`, omit this parameter; the API doesn't allow changing it because the model processes every image input at high fidelity automatically.» ⇒ tokens de entrada «can be higher for edit requests» | [F3][F14] |
| Streaming | `stream:true`, `partial_images` 0–3; cada parcial +100 tokens de salida | [F13][F3] |
| `safety_identifier` | Recomendado (hash de usuario, ≤128 chars); `user` deprecado | [F13] |
| Respuesta | Siempre `b64_json`; `url` no soportado; `revised_prompt` no devuelto por GPT Image (solo vía herramienta Responses) | [F13] |
| Prompt | ≤ 32 000 caracteres | [F13] |
| Errores | `image_generation_user_error` / `moderation_blocked` con `moderation_details{moderation_stage: input|output|unknown, categories[]}`; no reintentar automáticamente | [F3] |
| Latencia | «Complex prompts may take up to 2 minutes» | [F3] |
| Limitaciones | Texto renderizado, consistencia de marca/personajes y control de composición siguen siendo puntos débiles declarados | [F3] |
| Provenance | Imágenes generadas por «ChatGPT, Codex, or the OpenAI API» incluyen **C2PA Content Credentials + marca de agua SynthID** (excepto modelos por deprecar: gpt‑image‑1, 1.5). Verificable con `POST /v1/content_provenance_checks` (gratis con límites). Se pierde con capturas/conversiones; SynthID resiste ediciones ligeras. | [F15] |

### 1.6 Rate limits de imagen por tier — HECHO VERIFICADO [F2][F9][F10]

| Tier | TPM | IPM (imágenes/min) |
| --- | ---: | ---: |
| Build | 250 000 | 20 |
| Launch | 3 000 000 | 150 |
| Grow | 8 000 000 | 250 |

Igual para `gpt-image-2`, `gpt-image-2.5-*` y `gpt-image-1-mini`.

### 1.7 Batch para imágenes — HECHO VERIFICADO
`gpt-image-2` soporta `v1/batch` [F2]; Batch = 50 % de descuento, ventana única `24h`, hasta 50 000 peticiones/lote, 200 MB, 2 000 lotes/hora, pool de límites separado; lotes expirados cobran solo lo completado [F16]. Flex **no** aplica a imágenes (solo Responses/Chat Completions) [F17].

---

## 2. OMP `openai-codex/gpt-image-2` vs. API de plataforma

### 2.1 Qué es cada vía — HECHO VERIFICADO

| Aspecto | Suscripción ChatGPT/Codex (OAuth, lo que OMP expone como `openai-codex/*`) | API key de plataforma (`api.openai.com`) |
| --- | --- | --- |
| Contrato | Terms of Use de consumidor (Plus/Pro, efectivas 2026‑01‑01) [F18] o plan Business/Enterprise | **OpenAI Services Agreement** (efectivo 2026‑01‑01) + DPA + Usage Policies [F19][F20][F21] |
| Derecho a integrar en producto | **No previsto.** ToU: «You may not … Modify, copy, lease, sell or distribute any of our Services»; «Automatically or programmatically extract data or Output». ToU señala: «Our Business Terms govern use of … our APIs … for businesses and developers». | §2.2: «the right to use OpenAI's API to integrate the Services into Customer Applications and to make Customer Applications available to End Users» |
| Codex docs | «For general OpenAI API calls, continue to use Platform API keys.» «API keys are still the recommended default for automation.» Tokens de acceso Codex para automatización: **solo Enterprise**. Con API key en Codex «API pricing applies to image generation instead of included ChatGPT usage limits». [F22][F23] | — |
| Entrenamiento con datos | ToU: «We may use Content to provide, maintain, develop, and improve our Services» → **opt‑out manual**; tabla de Codex: «No training on API or business data by default»: Plus **—**, Pro **—**, Business ✔, Enterprise ✔, API Key ✔ [F23] | No entrenamiento por defecto (§4.2 Services Agreement; Your data) |
| DPA/subencargados/ZDR | No disponibles para planes de consumidor (DPA solo «ChatGPT Business, ChatGPT Enterprise, and the API») [F24] | DPA pública ejecutable; ZDR/MAM con aprobación |
| Facturación de imágenes | Consume el límite de uso del plan («image generations use included limits ~3‑5x faster»); después, créditos. Rate card Codex: **GPT‑Image‑2 (image) 200 / 50 / 750 créditos por 1M tokens (in / cached / out); (text) 125 / 31.25 / 250**. Valor en USD del crédito: depende del plan → **DESCONOCIDO**. Límites de mensajes por ventana de 5 h (Plus/Business). [F23] | Tokens a precios públicos de §1.3 |
| Residencia/retención | Según plan ChatGPT (Enterprise controla) | Controles por organización/proyecto (§4) |

### 2.2 Veredicto
El nombre `openai-codex/gpt-image-2` **confirma** que el modelo subyacente de la generación de imágenes en Codex es GPT‑Image‑2 (aparece literal en la rate card de Codex), pero la vía de acceso por suscripción **no es apta ni está contractualmente permitida** para un backend multi‑cliente: (a) las ToU de consumidor prohíben extracción programática y redistribución del servicio; (b) sin DPA ni compromiso de no‑entrenamiento en Plus/Pro; (c) límites por ventanas de 5 h no gobernables; (d) OpenAI indica explícitamente usar API keys para automatización. La única integración productiva válida es **API key bajo Services Agreement**, con verificación de organización si se requiere. Esto coincide con BR‑0007/ARC‑0001/OPS‑0001 del repositorio (la disponibilidad de un modelo en OMP no es credencial de backend). **[INFERENCIA jurídica, no asesoría legal]**: Business/Enterprise con «Codex access tokens» tampoco está documentado para «general OpenAI API calls».

---

## 3. Modelos de texto vigentes (GPT‑6 / GPT‑6.1)

### 3.1 Identidad y capacidades — HECHO VERIFICADO [F25][F26][F27]

| Dato | `gpt-6-luna` | `gpt-6.1-terra` | `gpt-6.1-sol` |
| --- | --- | --- | --- |
| Descripción oficial | «most efficient model for focused, high‑volume tasks» | «fast, efficient … visual reasoning, precise computer use, and clear, natural writing» | «Near‑Astra performance for complex work at a lower cost» |
| Contexto | 1 050 000 tokens; máx. entrada 922 000; máx. salida 128 000 | igual | igual |
| Corte de conocimiento | 2026‑05‑18 | 2026‑06‑01 | 2026‑04‑30 |
| `reasoning.effort` | `none`, low, medium (default), high, xhigh, max | `none`, low, medium (default), high, xhigh, max | low, medium (default), high, xhigh, max (**sin `none`**) |
| Endpoints | Chat Completions ✔ (function calling **solo** con `reasoning_effort:none`), Responses ✔, Batch ✔ | Chat Completions ✔, Responses ✔, Batch ✔; «Tool calling requires the Responses API» | igual que Terra |
| Features | streaming, structured_outputs, function_calling, file_search, image_input, web_search, prompt_caching | igual | igual (sin fine_tuning ni predicted_outputs) |
| Herramientas Responses | web_search, file_search, image_generation, code_interpreter, hosted_shell, apply_patch, skills, computer_use, mcp, tool_search | igual | igual |
| Residencia EU | Standard, Fast, Flex, Batch | igual | igual; Ultrafast US/EU |
| Snapshots | solo alias `gpt-6-luna` | solo alias | solo alias |

Otros modelos de la familia (pricing page): `gpt-6-astra` (flagship), `gpt-6-sol`, `gpt-5.6-sol/terra/luna`, `gpt-5.5`, `gpt-5.4(-mini/-nano)`. **No hay `gpt-6-mini` ni `gpt-6-nano`.** `gpt-5.4-nano` deprecado (apagado 2027‑04‑01 → reemplazo `gpt-6-luna`); `gpt-5-mini/nano` apagados 2026‑12‑11. [F1][F7]

### 3.2 Precios por 1M tokens — HECHO VERIFICADO [F1]

Contexto corto (≤272K tokens de entrada); contexto largo (>272K): 2× entrada/caché y 1.5× salida en toda la petición.

| Modelo | Tier | Input | Output | Cached in | Cache write 30m | Cache write 12h |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gpt-6-astra` | Standard | 10.00 | 50.00 | 1.00 | 12.50 | 25.00 |
| `gpt-6.1-sol` | Standard | 2.00 | 10.00 | 0.10 | 2.50 | 5.00 |
| `gpt-6.1-terra` | Standard | 1.00 | 5.00 | 0.05 | 1.25 | 2.50 |
| `gpt-6-luna` | Standard | **0.10** | **0.50** | **0.01** | 0.125 | 0.25 |
| `gpt-6-sol` | Standard | 2.00 | 10.00 | 0.20 | 2.50 | 5.00 |
| `gpt-5.6-luna` | Standard | 0.20 | 1.20 | 0.02 | 0.25 | 0.50 |
| `gpt-5.4-mini` | Standard | 0.75 | 4.50 | 0.075 | — | — |
| `gpt-5.4-nano` (deprec.) | Standard | 0.20 | 1.25 | 0.02 | — | — |
| `gpt-6-luna` | Batch / Flex | 0.05 | 0.25 | 0.005 | 0.0625 | 0.125 |
| `gpt-6.1-terra` | Batch / Flex | 0.50 | 2.50 | 0.025 | 0.625 | 1.25 |
| `gpt-6.1-sol` | Batch / Flex | 1.00 | 5.00 | 0.05 | 1.25 | 2.50 |
| `gpt-6-luna` | Fast (ex‑Priority) | 0.20 | 1.00 | 0.02 | 0.25 | 0.50 |
| `gpt-6.1-sol` | Fast | 4.00 | 20.00 | 0.20 | 5.00 | 10.00 |
| `gpt-6.1-sol` | Ultrafast | 12.00 | 60.00 | 0.60 | 15.00 | 30.00 |

Notas oficiales: «Priority processing was renamed Fast mode on July 30, 2026»; «Regional processing (data residency) endpoints are charged a 10 % uplift for models released on or after March 5, 2026»; «Starting Nov 1, 2026, FedRAMP endpoints are also charged a 10 % uplift»; promoción `gpt-5.6-sol` hasta 2026‑11‑21 al menos; «Price changes on the Pricing Page will be effective fourteen days after they are posted» (§6.6 [F19]). Contexto largo confirmado en página: input/caché 2× y output 1.5× en toda la petición.

### 3.3 Batch, Flex, Fast — HECHO VERIFICADO
- **Batch** [F16]: 50 %; ventana `24h` única; pool de límites separado (no consume TPM estándar); cola de tokens por modelo (Luna: Build 20M / Launch 1B / Grow 15B; Terra: 3M / 200M / 15B).
- **Flex** [F17]: «priced at Batch API rates»; `service_tier:"flex"` en Responses/Chat; «slower response times and occasional resource unavailability»; `429 Resource Unavailable` sin cargo; timeout SDK por defecto 10 min; beta. Reintento posible con `service_tier:"auto"`.
- **Fast**: 2× Standard; Ultrafast 6× (solo 6.1 Sol y Astra).

### 3.4 Caché de prompt (GPT‑5.6+) — HECHO VERIFICADO [F28]
- Mínimo cacheable: **1 024 tokens visibles** (los tokens de sistema ocultos no cuentan).
- Escrituras: 1.25× (30 min, default) / 2.5× (12 h, solo Responses) — «total write rates, not surcharges».
- Lecturas: 0.1× (Luna, Astra, etc.) / **0.05× (6.1 Sol y 6.1 Terra)**.
- Breakpoints implícitos (fin del último mensaje elegible) o explícitos (`prompt_cache_options.mode:"explicit"`, hasta 4 escrituras por petición). Contenido tras el último breakpoint explícito **no** paga escritura.
- Cambios de `tools`, `text.format`, `reasoning.effort`, `text.verbosity` o compactación rompen el prefijo; en GPT‑6 se puede cambiar effort con `configuration_update` sin romperlo.
- Enrutamiento automático en GPT‑5.6+; >15 RPM por máquina puede provocar overflow. Caché no compartida entre regiones.
- Ejemplo oficial: 1 escritura + 1 lectura completa = 1.35× el costo normal (vs 2×); 1 escritura + 9 lecturas = 2.15× (vs 10×).

### 3.5 Structured Outputs y function calling — HECHO VERIFICADO [F29]
- Disponible vía `text.format: json_schema` (strict) y vía `strict:true` en funciones.
- **Tipos**: String, Number, Boolean, Integer, Object, Array, Enum, **anyOf**. `$ref`/`$defs` y recursión soportadas.
- **Restricciones**: raíz debe ser `object` (no `anyOf` en raíz — p. ej. `z.discriminatedUnion` de Zod en raíz falla); todos los campos `required` (opcional ⇒ unión con `null`); `additionalProperties:false` obligatorio en todo objeto; `anyOf` anidados deben ser válidos en el subconjunto.
- **Límites numéricos**: ≤ **5 000** propiedades de objeto en total; ≤ **10** niveles de anidamiento; ≤ **1 000** valores enum en total; para un enum >250 valores, ≤15 000 chars; nombres+enum+const ≤ **120 000** caracteres.
- `string` admite `pattern` y `format` (date‑time, date, email, uuid…); `number` admite min/max/multipleOf; `array` admite minItems/maxItems.
- **No se publica un máximo de variantes por `anyOf`**. ⇒ El esquema de parche web con 17 uniones de MainSpot (que superó el límite de 16 de Anthropic) **es plausible en OpenAI** [INFERENCIA]; verificación: enviar el esquema en una petición con `max_output_tokens` mínimo y comprobar que no devuelve `400 invalid_request_error` por esquema — **NO MEDIDO** (coste esperado < USD 0.001 con Luna; si el esquema es inválido se rechaza antes de generar [HIPÓTESIS]).
- Refusals detectables (`refusal` en salida); respuestas `incomplete` por `max_output_tokens` posibles.
- Nota de residencia: «Structured Outputs (excluding schema)» — el esquema se trata como *system data* y puede procesarse fuera de la región [F30].

### 3.6 Razonamiento y facturación — HECHO VERIFICADO [F31]
- «While reasoning tokens are not visible via the API, they still occupy space in the model's context window and are **billed as output tokens**.»
- Effort por defecto `medium` en GPT‑6.1 Sol, GPT‑6 Sol y Luna. `none` solo en Luna y Terra (no en 6.1 Sol). Guía: `none` para «classification», `low` para «customer support / chat assistant», `medium` para planificación.
- `max_output_tokens` limita razonamiento+salida; si se agota, `status:"incomplete"` y se cobra lo generado sin salida visible. OpenAI sugiere reservar 25 000 tokens al experimentar.
- Modo `pro` (`reasoning.mode`) agrega trabajo y se cobra a tarifa estándar del modelo.

### 3.7 Decisions API (candidato de clasificación, solo comparación) — HECHO VERIFICADO [F32]
- `POST /v1/decisions` con `gpt-6-luna` (único modelo), beta desde 2026‑10‑06; devuelve respuestas tipadas (`choice`, `score`, probabilidad) «about 10× faster than the Responses API»; hasta 400 preguntas por petición; entrada texto/imagen/JSON/conversación.
- **Precio**: input no cacheado **$0.10/1M**; **output no se cobra**; lecturas/escrituras de caché a tarifas de Luna; +10 % regional; ZDR y HIPAA elegibles.
- ESTIMACIÓN perfil clasificación (800 tokens in): $0.00008 por evento (sin caché). Relevante como alternativa de estudio frente a Jev (DEC‑0069 mantiene Jev; esto no autoriza nada).

---

## 4. Límites de tasa, tiers, cuotas y facturación

### 4.1 Tiers — HECHO VERIFICADO [F33][F6 Oct 6]
Simplificados de 5 a 3 el 2026‑10‑06. Ascenso automático por **compras de crédito acumuladas**.

| Tier | Requisito | Límite de uso mensual |
| --- | --- | --- |
| Free | geografía permitida | $100 / mes |
| **Build** | $5 en compras de crédito | $500 / mes |
| **Launch** | $100 | $5 000 / mes |
| **Grow** | $500 | $200 000 / mes |

Rate limits estándar texto: Build Astra/Sol/Terra 5 000 RPM · 1M TPM, Luna 5 000 RPM · 2M TPM; Launch 10 000 RPM · 4M / 10M; Grow 15 000 RPM · 40M / Luna 30 000 RPM · 180M. Límites separados para contexto largo y para Batch; límites compartidos entre familias según consola. Ramp‑rate: `429 slow_down` si el tráfico crece rápido (regla: >1M TPM, subir ≤50 % cada 15 min); `503 server_is_overloaded`; cabeceras `x-ratelimit-*` y `Retry-After`. Spend limits (alerta / hard limit → 429) configurables por organización/proyecto.

### 4.2 Facturación e impuestos — HECHO VERIFICADO
- Créditos API **solo en USD** («Purchases for API credits are currently limited to USD») [F34]. Suscripciones ChatGPT sí admiten MXN, pero no aplica a la API.
- Services Agreement §6: tarifas no reembolsables; §6.3 «Fees are exclusive of taxes… If any such deduction or withholding is required by law, Customer shall increase the payment» (gross‑up); §6.6 precios efectivos 14 días tras publicarse; §6.5 créditos prepagados sujetos a Service Credit Terms; §16.11‑16.12 restricciones comerciales/países; **México está en la lista de países soportados** [F19][F35].
- Tax ID/VAT ID editable en «organization's billing preferences» (`platform.openai.com/settings/organization/billing/preferences`); «If the Tax ID you provide is found to be invalid, it may be removed from system records at any time and applicable taxes may be charged»; «Updating your billing details or Tax ID only affects future invoices» (no corrige facturas emitidas; reissue solo vía Support y no garantizado) — **HECHO VERIFICADO** [F40]. IVA mexicano sobre servicios digitales importados: **DESCONOCIDO** en fuentes de OpenAI; verificar con contador.
- Contratante: OpenAI OpCo, LLC (fuera de EEE/Suiza); ley de California; arbitraje NAM [F19].

---

## 5. Datos, privacidad y cumplimiento

### 5.1 Controles de datos de la API — HECHO VERIFICADO [F30]
| Punto | Hecho |
| --- | --- |
| Entrenamiento | «As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in)». Services Agreement §4.2 lo contractualiza. |
| Retención por abuso | Logs de abuso (pueden contener prompts/salidas y metadatos de clasificadores) **hasta 30 días** por defecto, salvo obligación legal. |
| `/v1/images/generations` y `/v1/images/edits` | Training: No · Abuse monitoring: 30 días · **Application state: None** · **ZDR eligible: Yes** (lista explícita incluye `gpt-image-2`, 2.5 sunburst/flare, 1.5, 1‑mini) · Private Retention/PSP: No |
| `/v1/responses` | Estado de aplicación 30 días por defecto o con `store:true` → usar **`store:false`**; con ZDR `store` siempre false; background mode ~10 min en disco. |
| `/v1/chat/completions` | Sin estado (salvo audio 1 h); caché KV cifrada en GPU ≤24 h. |
| `/v1/batches`, `/v1/files` | Estado «Until deleted»; **no ZDR‑elegibles**. Archivos con `expires_after`. |
| `/v1/decisions` | 30 días abuso; ZDR, PSP y Safety Retention elegibles. |
| Imágenes/archivos de entrada | Escaneo CSAM al subir; si se detecta, se retiene para revisión humana aunque haya ZDR. |
| ZDR / Modified Abuse Monitoring | «subject to prior approval by OpenAI and acceptance of additional requirements» → contactar ventas; se configura por organización y proyecto. ZDR con Private Safety Processing exige almacenamiento controlado por el cliente. OpenAI se reserva «Safety Retention» para clientes específicos con aviso. |
| Acceso humano | Empleados autorizados + «specialized third‑party contractors … solely to review for abuse and misuse» [F24]. |

### 5.2 Residencia de datos — HECHO VERIFICADO [F30]
- Regiones: US (`us.api.openai.com`, almacenamiento + procesamiento, **sin requisito ZDR/MAM**), EU (`eu.api.openai.com`, almacenamiento + procesamiento, requiere ZDR/MAM/PSP/Safety Retention), AU/CA/JP/IN/SG/KR/GB (solo almacenamiento, requieren MAM/ZDR), AE. **No existe región México/LatAm.**
- Imágenes en regiones no‑US/EU requieren «enhanced ZDR/MAM».
- Sobreprecio **+10 %** para modelos lanzados ≥ 2026‑03‑05 (incluye `gpt-image-2`, GPT‑6). Caché no se comparte entre regiones.
- Subencargado Microsoft lista «Mexico» como ubicación de infraestructura cloud [F36] — no equivale a residencia contractual.

### 5.3 Contratos y auditorías — HECHO VERIFICADO
- **Services Agreement** (efectivo 2026‑01‑01) [F19]: cliente retiene Input y posee Output (§4.1); OpenAI usa Customer Content solo para prestar/legal/abuso (§4.2); indemnización por IP de OpenAI (§13.1, excluye Customer Content y Customer Applications); liability cap = 12 meses de pago (§14.2); borrado de contenido ≤30 días tras terminación (§11.3); «Customer may not resell or lease access to its Account» (§3.1); no comprar/vender/transferir API keys (§3.3 g); permiso de uso de Output para clasificadores internos («Permitted Exception»).
- **DPA** (efectivo 2026‑01‑01) [F20]: OpenAI = encargado; SCC/UK Addendum; notificación de brecha «without undue delay»; **objeción a nuevos subencargados en 30 días**; auditoría ≤1/año; devolución/borrado al terminar; cláusulas CCPA. Se ejecuta en línea (formulario Ironclad).
- **Subencargados** (2026‑10‑14) [F36]: Cloudflare (CDN), Microsoft, CoreWeave, Oracle, Google Cloud, AWS, Cerebras (infra), Snowflake, Fivetran (datos, excepto ZDR), TaskUs/Accenture/Cinder (moderación y soporte — moderación solo sobre contenido marcado), Salesforce/Pylon (soporte). Entidades OpenAI: OpCo (US), Ireland, UK, Japan.
- **Certificaciones** [F24][F37]: SOC 2 Type 2 (API Platform auditada), SOC 3, ISO/IEC 27001:2022, 27017, 27018, 27701, **42001:2023**, CSA STAR, PCI DSS v4.0.1, FedRAMP 20x; cifrado AES‑256 en reposo, TLS 1.2+; BAA disponible.

### 5.4 Políticas de uso relevantes para imágenes de pymes — HECHO VERIFICADO [F21][F18]
Usage Policies (efectivas 2026‑11‑20; versión previa 2025‑10‑29):
- Prohibido: «use of someone's likeness, including their photorealistic image or voice, without their consent in ways that could confuse authenticity» → **no generar/editar rostros de personas reales (clientes, empleados, famosos) sin consentimiento**.
- Prohibido: «attempts to infringe on intellectual property rights of others» → **logos/marcas de terceros**: riesgo; marca propia del negocio: responsabilidad del cliente (§4.3 Services Agreement: «Customer … has all rights, licenses, and permissions required to provide Input»).
- Prohibido: «deceit, fraud, scams, spam, or impersonation»; ToU de consumidor además: «Represent that Output was human‑generated when it was not». Recomendación operativa ya recogida en el repo (`docs/architecture/ai-providers-data-terms.md`): revisión humana y etiqueta «imagen generada con IA».
- No hay cláusula pública específica sobre marcas/logos en generación de imágenes más allá de IP → **DESCONOCIDO** el comportamiento del filtro ante logos conocidos (NO MEDIDO).
- Automatización de «high‑stakes actions … without human review» en áreas sensibles: no aplica al marketing de pymes, pero sí a cualquier función que afecte crédito/empleo/salud.
- «Providing access to our models»: plataformas intermediarias requieren aprobación; **no aplica** «solely because an application integrates OpenAI models to power its features».

---

## 6. Estado del servicio (4 ago → 2 nov 2026) — HECHO VERIFICADO [F38]

| Componente | Uptime | Incidencias |
| --- | ---: | --- |
| APIs (14 componentes) | 99.97 % | 2 días outage parcial, 16 días degradados |
| Images | **99.990 %** | 1 día outage parcial, 7 días degradados |
| Responses | 100 % | 13 días degradados |
| Chat Completions | 100 % | 7 días degradados |
| Batch | 100 % | 4 días degradados |
| Login (API) | 99.98 % | 1 día outage parcial |
| ChatGPT (16 comp.) | 99.70 % | 9 días outage parcial, 37 degradados |
| Codex (4 comp.) | 99.94 % | **1 día outage total**, 1 parcial |

Nota del proveedor: «Availability metrics are reported at an aggregate level across all tiers, models and error types.» No se publica SLA contractual para pago por uso (Scale/Reserved Tier aparte).

---

## 7. ESTIMACIONES de costo unitario

Convenciones: Standard salvo indicación; fórmula general `costo = (in_no_cache × P_in + in_cache × P_cached + (out + razonamiento) × P_out) / 1e6 × factor_tier`. Sin tipo de cambio (se deja a `04-unit-economics`). No incluyen reintentos ni tokens de sistema ocultos.

### 7.1 Imágenes — `gpt-image-2` (y alternativa más barata)

Supuestos: prompt de texto 150 tokens ($5/M → $0.00075, Batch $0.000375). Tokens de salida por calidad/tamaño = tabla oficial §1.4.

| Caso | Fórmula | Standard | Batch (24 h) | Etiqueta |
| --- | --- | ---: | ---: | --- |
| Imagen web 1536×1024 **medium** | 0.041 + 0.00075 | **$0.0418** | $0.0209 | ESTIMACIÓN sobre HECHO |
| Imagen web 1536×1024 **high** | 0.165 + 0.00075 | **$0.1658** | $0.0829 | ESTIMACIÓN |
| Imagen social 1024×1024 **medium** | 0.053 + 0.00075 | **$0.0538** | $0.0269 | ESTIMACIÓN |
| Imagen social 1024×1024 **high** | 0.211 + 0.00075 | **$0.2118** | $0.1059 | ESTIMACIÓN |
| Borrador/preview 1024² **low** | 0.006 + 0.00075 | $0.0068 | $0.0034 | ESTIMACIÓN |
| Edición: 1 imagen 1024² de entrada + máscara, salida 1024² medium | in_img 4 354 tok × $8/M = $0.0348 (proxy); si la máscara se tokeniza como 2.ª imagen: $0.0697; + texto $0.00075 + out $0.053 | **$0.089 – $0.124** | $0.044 – $0.062 | **HIPÓTESIS** (ver nota) |
| Variante de canal (re‑encuadre 1536×1024 → 1024² medium) vía `/images/edits` con la imagen original | $0.0348 (in) + $0.00075 + $0.053 | **≈ $0.089** | ≈ $0.044 | HIPÓTESIS |
| Variante de canal por **regeneración** desde el mismo prompt (sin imagen de entrada) | igual a generación | $0.0538 | $0.0269 | ESTIMACIÓN (pierde consistencia) |

**Nota sobre tokens de imagen de entrada**: OpenAI **no publica** la fórmula de tokens de entrada para `gpt-image-2` («The vision calculator does not estimate their input or output costs»); solo dice que procesa «every image input at high fidelity» y que las ediciones «can use more input tokens». El proxy usado es la regla histórica de `gpt-image-1` con `input_fidelity:high`: 65 base + 129 × 1 tile (512² tras reducción) + 4 160 (cuadrada) = **4 354 tokens** [F39]. Para 1536×1024 el extra sería 6 240 → 6 434 tokens ≈ $0.051. Si la máscara cuenta como imagen: ×2. **NO MEDIDO**; plan: una llamada real a `/v1/images/edits` con 1 imagen 1024² + máscara y leer `usage.input_tokens_details.image_tokens` (coste esperado ≈ $0.09–0.13, dentro del techo DEC‑0068).

**Alternativa más barata de OpenAI**:
- Entre modelos **no deprecados**: el propio `gpt-image-2` en `low` ($0.005–0.006) o en **Batch** (−50 %). `gpt-image-2.5-flare` tiene la misma tarifa por token pero consumo desconocido (NO MEDIDO).
- `gpt-image-1-mini` es más barata nominalmente (1536×1024 medium $0.015, high $0.052; imagen de entrada $2.5/M; proxy edición low‑fidelity ≈ $0.0005 de entrada) **pero se apaga el 2026‑12‑01** → no apta para producción.

Sensibilidad: 100 imágenes web medium = $4.18 (Batch $2.09); 100 imágenes social medium = $5.38; 100 ediciones ≈ $8.9–12.4. Con `n>1` para elegir entre variantes, multiplicar por `n`.

### 7.2 Texto — perfiles de MainSpot (mismos que el agente de Anthropic)

Supuestos: `reasoning.effort:"none"` (Luna/Terra) ⇒ 0 tokens de razonamiento; **Sol no admite `none`** ⇒ añadir sensibilidad. «70 % cached» = 70 % de la entrada a tarifa cached (lectura estable); la escritura inicial se amortiza aparte. **Perfil clasificación (800 tokens) no alcanza el mínimo cacheable de 1 024 ⇒ sin caché.** Batch = 50 % sobre todas las tarifas.

| Perfil | in / out | Luna std | Luna 70 % cache | Luna Batch | Luna Batch+cache | Terra std | Terra 70 % cache | Terra Batch | Terra Batch+cache | 6.1 Sol std | Sol 70 % cache | Sol Batch | Sol Batch+cache |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| clasificación | 800 / 60 | $0.00011 | n/a (<1 024) | $0.00006 | n/a | $0.00110 | n/a | $0.00055 | n/a | $0.00220 | n/a | $0.00110 | n/a |
| respuesta | 1 500 / 200 | $0.00025 | $0.00016 | $0.00013 | $0.00008 | $0.00250 | $0.00150 | $0.00125 | $0.00075 | $0.00500 | $0.00300 | $0.00250 | $0.00150 |
| post | 2 500 / 900 | $0.00070 | $0.00054 | $0.00035 | $0.00027 | $0.00700 | $0.00534 | $0.00350 | $0.00267 | $0.01400 | $0.01068 | $0.00700 | $0.00534 |
| diseño web | 6 000 / 7 000 | $0.00410 | $0.00372 | $0.00205 | $0.00186 | $0.04100 | $0.03701 | $0.02050 | $0.01851 | $0.08200 | $0.07402 | $0.04100 | $0.03701 |
| edición simple | 5 000 / 600 | $0.00080 | $0.00049 | $0.00040 | $0.00024 | $0.00800 | $0.00468 | $0.00400 | $0.00234 | $0.01600 | $0.00935 | $0.00800 | $0.00468 |
| edición compleja | 7 000 / 3 500 | $0.00245 | $0.00201 | $0.00122 | $0.00100 | $0.02450 | $0.01985 | $0.01225 | $0.00992 | $0.04900 | $0.03969 | $0.02450 | $0.01985 |
| asistente | 8 000 / 500 | $0.00105 | $0.00055 | $0.00052 | $0.00027 | $0.01050 | $0.00518 | $0.00525 | $0.00259 | $0.02100 | $0.01036 | $0.01050 | $0.00518 |
| insight | 6 000 / 1 200 | $0.00120 | $0.00082 | $0.00060 | $0.00041 | $0.01200 | $0.00801 | $0.00600 | $0.00400 | $0.02400 | $0.01602 | $0.01200 | $0.00801 |

Ejemplo de fórmula (asistente, Luna, 70 % caché): (8 000×0.3×0.10 + 8 000×0.7×0.01 + 500×0.50)/1e6 = $0.00055.

**Costo de escritura de caché (una vez por prefijo cada 30 min)**: prefijo = 70 % de la entrada × tarifa write. Asistente (5 600 tok): Luna $0.0007, Terra $0.0070, Sol $0.0140; amortizado entre 10 reutilizaciones: $0.00007 / $0.0007 / $0.0014. Diseño web (4 200 tok): Luna $0.0005, Terra $0.0053, Sol $0.0105. Con pocas reutilizaciones por ventana de 30 min la caché puede **encarecer** (write 1.25× > 1×). Para instrucciones estables reutilizadas todo el día conviene `ttl:"12h"` (2.5×) solo si hay >~3 lecturas.

**Sensibilidad a razonamiento** (cobrado como salida): cada +500 tokens de razonamiento suma Luna $0.00025, Terra $0.0025, **Sol $0.005** (Standard). Con `medium` por defecto en tareas de diseño/edición compleja, el consumo real puede ser de «a few hundred to tens of thousands» de tokens [F31] → NO MEDIDO; en Sol no se puede desactivar.

**Decisions API** (clasificación, Luna, solo entrada): 800 tok × $0.10/M = **$0.00008**/evento; salida gratuita.

Comparación de magnitud (NO es recomendación): Luna es 10× más barata que Terra y 20× que 6.1 Sol en entrada; la calidad relativa para español mexicano y para el DSL de MainSpot está **NO MEDIDA**.

### 7.3 Implicación DEC-0073 (OpenAI como proveedor de toda la generación en desarrollo)

Estado: **HECHO VERIFICADO** sobre `.canonflow/decision-records/DEC-0073.md` (registrada 2026‑11‑03T08:06Z, fuente SRC‑0011), canon 0.4.0 (`BR-0007`, `ARC-0001`, `OPS-0001`), `01-inventory.md` §8.0/§8.4 (commit SOL MAIN `1f1c7da`, 2026‑11‑03 03:25) y `migrations/0029_ai_openai_development.sql`. Lo económico derivado abajo es **ESTIMACIÓN** sobre esos hechos y §3.2/§7.2.

**Hechos de DEC‑0073:**
- **OpenAI directo para toda la generación de texto e imágenes en DESARROLLO** (sustituye la preferencia Anthropic de DEC‑0069 solo para desarrollo); TypeSafe/Jev conserva la clasificación semántica primaria; Anthropic queda **deshabilitado como proveedor** (migración `0029`: `status='disabled'`, adaptador conservado, sin rutas activas/canary ni fallback automático); OpenRouter deshabilitado. La decisión es explícitamente «configuración de desarrollo, no selección comercial irreversible»: no decide producción (discrepancia D12 del inventario).
- Candidatas de desarrollo vía OpenAI: diseño → `oa:gpt-6.1-sol` (0.25) y `oa:gpt-6-luna` (0.05); edición simple → Luna (0.02); edición compleja → Sol (0.2) + Luna (0.05); compose → Luna (0.03); creatives → Luna (0.03); todo `reasoning_effort:'medium'`, «selección explícita, no fallback» (`catalog.ts:290+`).
- Transporte: texto/razonamiento por **Responses con `store:false`** e imágenes por **Images API** (`ARC-0001`/`OPS-0001` 0.4.0). `store:false` es coherente con §5.1 (evita los 30 días de estado de aplicación de `/v1/responses`).

**Comparación de precios Sol/Luna vs Anthropic directo** (USD/MTok, contexto corto, Standard; fuentes [F1] y `evidence/anthropic.md` §2.1):

| Par de trabajo equivalente | OpenAI | Anthropic directo | Comentario |
| --- | --- | --- | --- |
| Trabajo de volumen (candidata: edición simple, compose, creatives) | `gpt-6-luna` $0.10 / $0.50 | `claude-haiku-5-5` $0.10 / $0.50 (≤100K) | **Tarifas idénticas.** Batch 50 % en ambos. |
| Trabajo complejo (candidata: diseño, edición compleja) | `gpt-6.1-sol` $2.00 / $10.00 | `claude-sonnet-5-5` $2.00 / $10.00 | **Tarifas idénticas.** |
| Punto intermedio | `gpt-6.1-terra` $1.00 / $5.00 | sin equivalente (salto Haiku→Sonnet) | OpenAI ofrece un escalón que Anthropic no tiene |
| Lectura de caché | Luna $0.01 (0.1×); Sol $0.10 (0.05×); **mínimo cacheable 1 024 tokens** | Haiku $0.01 (0.1×); Sonnet $0.10 (0.05×); **mínimo 512 tokens** | El perfil clasificación (800 in) es cacheable en Anthropic y **no** en OpenAI |
| Escritura de caché | 1.25× (30 min) / 2.5× (12 h) | 1.25× (5 min) / 2× (1 h) | TTL y penalización distintos; ver §7.2 |
| Razonamiento | Sol **no admite `none`** (mínimo `low`); se factura como salida | Sonnet 5.5 no acepta `disabled` (mínimo `between_tools`); Haiku sí acepta `disabled` | Los perfiles de §7.2 con 0 razonamiento no aplican a Sol |

Consecuencia central: **a tarifas por token idénticas, la comparación económica OpenAI vs Anthropic directo se decide en tokens por tarea y tasa de reparaciones, no en USD/MTok**. Los únicos tokens comparables disponibles son los medidos vía OpenRouter (§7.4); los de la API OpenAI directa (sin capa de traducción) y los de Anthropic directo son **NO MEDIDOS**.

**Qué significa operar todo el texto con OpenAI (HECHO VERIFICADO lo documental; ESTIMACIÓN/HIPÓTESIS lo operativo):**
- **Esquema de 17 uniones:** OpenAI soporta `anyOf` anidado **sin límite publicado de variantes** (§3.5) — supera la restricción de Anthropic (16 uniones) solo en eso. **Advertencia crítica:** la **raíz no puede ser `anyOf`**; si el esquema de parches web de MainSpot es una unión discriminada en la raíz, OpenAI también lo rechazaría y habría que envolverlo en un objeto raíz (p. ej. `{kind, patch}`). Validación NO MEDIDA (hueco §Huecos; costo de prueba < USD 0.001 con Luna).
- **Dependencia de un solo proveedor:** con DEC‑0073, texto, imágenes, latencia y cuota de tier dependen de la misma organización y del mismo estado de servicio (§6: Images 99.99 %, pero el ecosistema OpenAI registró 1 outage total en Codex y 2 parciales en APIs en 3 meses). Mitigación ya prevista: el adaptador Anthropic se conserva como alternativa técnica sin fallback automático; reactivarlo exigiría decisión nueva.
- **Cobertura de casos:** todos los casos generativos del catálogo (§3 del handoff) tienen modelo OpenAI candidata; clasificación sigue en TypeSafe/Jev (DEC‑0073 no la toca); la Decisions API ($0.10/M, salida gratis, §3.7) queda solo como candidato de estudio.
- **Cumplimiento simplificado:** un solo contrato (Services Agreement + DPA), una sola configuración de retención (`store:false`, ZDR elegible en imágenes) para texto e imágenes; frente al escenario Anthropic+OpenAI no hay que reconciliar dos DPAs.
- **Costo esperado de desarrollo:** con los tokens medidos de §7.4, el costo por tarea en Luna (edición $0.0002–0.0006, diseño $0.0011, post $0.0006) está órdenes de magnitud bajo el techo DEC‑0068; el riesgo económico del enfoque no es el precio por token sino la calidad de salida y las reparaciones (NO MEDIDO en OpenAI directo).

### 7.4 Coherencia de los perfiles de §7.2 con tokens medidos (`lab-traces.md`)

Comparación de los perfiles supuestos de §7.2 (ESTIMACIÓN) con los tokens **medidos** del laboratorio de 2026‑10‑30 (**MEDICIÓN PROPIA**, Luna vía OpenRouter; promedios por invocación exitosa **incluyendo reparaciones**):

| Perfil | in/out supuesto | Luna medido in/out (caso) | Factor supuesto/medido (in × out) | Costo Luna std: perfil vs medido |
| --- | --- | --- | --- | --- |
| diseño web | 6 000 / 7 000 | 1 608 / 2 033 (`website.initial.design`) | 3.7× / 3.4× | $0.00410 vs ≈$0.00118 |
| edición simple | 5 000 / 600 | 1 735 / 202 (`website.edit.simple`) | 2.9× / 3.0× | $0.00080 vs ≈$0.00027 |
| edición compleja | 7 000 / 3 500 | 2 202 / 958 (`website.edit.complex`) | 3.2× / 3.7× | $0.00245 vs ≈$0.00068 |
| post | 2 500 / 900 | 1 776 / 745 (`social.facebook.post.compose`) | 1.4× / 1.2× | $0.00070 vs ≈$0.00055 |
| respuesta | 1 500 / 200 | 621 / 189 (fb) y 645 / 182 (Google) | 2.4× / 1.1× | $0.00025 vs ≈$0.00016 |
| asistente | 8 000 / 500 | 2 096 / 293 (`conversation.owner.assistant`) | 3.8× / 1.7× | $0.00105 vs ≈$0.00036 |
| insight | 6 000 / 1 200 | 712 / 404 (`business.insights.generate`) | **8.4×** / 3.0× | $0.00120 vs ≈$0.00027 |
| clasificación | 800 / 60 | Jev (TypeSafe) 804 / 140; **Luna sin medición** | n/a | — |

Lecturas (ESTIMACIÓN sobre MEDICIÓN PROPIA):
1. Los perfiles de §7.2 **sobrestiman** los tokens reales de Luna por 1.2×–8.4×: son **cota superior conservadora** para dimensionar presupuesto, no costo esperado. El modelo económico (`04-unit-economics.py`) ya usa tokens por tarea medidos y precios directos; los perfiles quedan como escenario de techo.
2. Los medidos ya **incluyen reparaciones** (hallazgo 4 de `lab-traces.md`); el costo por éxito amortiza el reintento. Un régimen sin reparaciones sería aún más barato.
3. **Los tokens medidos pasaron por OpenRouter; el directo puede diferir y está NO MEDIDO.** En el tramo Luna el paso por OpenRouter es el más «nativo» (el esquema JSON va a la API de OpenAI sin traducirse), mientras que la traducción a Anthropic infló los inputs de Haiku 2–2.5× (hallazgo 3). Aun así, diferencias de tokenizador, `store:false`, esfuerzo de razonamiento (`medium` en las candidatas DEC‑0073, no `none`) y contexto real pueden mover las cifras; medir con la integración directa de SOL MAIN (benchmark B‑TXT) antes de fijar costos de producción.
4. **`insight` es el caso más sobrestimado (8.4× en entrada):** el perfil asumía contexto de negocio amplio; las 4 invocaciones medidas usaron entradas cortas (n pequeño). Revisar el perfil si producción alimenta el contexto completo del negocio — el costo real podría acercarse al perfil, no alejarse.
5. El razonamiento medido en Luna (`reasoningTokens`) fue 105–829 tokens por invocación incluso con esfuerzo por defecto; las candidatas DEC‑0073 usan `medium`, así que la sensibilidad de §7.2 (+$0.00025 por 500 tokens de razonamiento en Luna; +$0.005 en Sol) es el ajuste correcto a aplicar sobre los tokens medidos.

---

## 8. Observaciones sobre el snapshot del repositorio (solo lectura, SOL MAIN `mainspot-platform`; el trabajo observado sin commit fue luego commiteado en `36af79c`/`1f1c7da` — ver `01-inventory.md` §8.0/§8.4)
- `src/ai/catalog.ts` modela `oa:gpt-image-2` con `input_per_mtok: 5, output_per_mtok: 30` y la nota «calidad media 1536×1024 ≈ USD 0.041» → **coincide** con la página oficial de hoy. Declara `requires_org_verification: true` (coherente con la guía). Texto OpenAI `oa:gpt-6-luna` 0.1/0.5 → coincide.
- `src/ai/providers/openai.ts` usa `/images/generations` y Responses `/responses` con `store:false`; cita la restricción de Chat Completions (function calling solo con `reasoning_effort:none`) → coherente con [F25].
- `docs/architecture/ai-providers-data-terms.md` §3 ya registra Services Agreement/DPA/your‑data con las mismas conclusiones (ZDR‑elegible, 30 días, `store:false`).
- Divergencias a señalar al integrador: (1) el catálogo no refleja que la guía ya recomienda `gpt-image-2.5-*` para integraciones nuevas ni que `gpt-image-1-mini/1.5` se apagan el 2026‑12‑01; (2) el catálogo fija precios **Standard**; Batch (−50 %) no está modelado; (3) `input_fidelity` no debe enviarse a `gpt-image-2`; (4) no hay `gpt-6-mini/nano`, la alternativa económica intermedia es `gpt-6.1-terra`.

---

## Fuentes

Todas consultadas el 2026‑11‑03 con `read`. Re‑verificación adicional del 2026‑11‑03 (auditoría posterior, misma fecha): [F1] (tabla completa de precios Standard/Batch/Flex/Fast/Ultrafast y de imagen), [F3] (guía image generation: tabla de costos por imagen, caché solo en Responses, input fidelity, calculadora JS), [F23] (rate card Codex: GPT‑Image‑2 image 200/50/750 y text 125/31.25/250 créditos; planes y límites por 5 h), [F29] (anyOf soportado, raíz no anyOf, 5 000 propiedades / 10 niveles / 1 000 enum / 120 000 caracteres), [F30] (tabla por endpoint: imágenes ZDR‑elegibles, 30 días de abuso, regiones) — **todas confirmadas sin discrepancia**; único ajuste: se añadió la nota de sobreprecio FedRAMP (+10 % desde 2026‑11‑01).

1. [F1] «Pricing | OpenAI API» — https://developers.openai.com/api/docs/pricing — tablas Standard/Batch/Flex/Fast/Ultrafast de texto, imagen (gpt‑image‑2/2.5/1.5/1‑mini), notas de contexto largo, +10 % regional, renombrado Priority→Fast, promo 5.6 Sol.
2. [F2] «GPT‑Image‑2 Model» — https://developers.openai.com/api/docs/models/gpt-image-2 — ID, snapshot 2026‑04‑21, endpoints soportados, inpainting, rate limits Build/Launch/Grow.
3. [F3] «Image generation» guía — https://developers.openai.com/api/docs/guides/image-generation — verificación de organización, safety_identifier, tamaños/calidades/formatos, máscaras, moderación y errores, costos 2.5, caché solo Responses, tabla de costo por imagen (GPT Image 2/1.5/1/1‑mini), input fidelity, partial images, limitaciones.
4. [F6] «Changelog» — https://developers.openai.com/api/docs/changelog — Apr 21 (GPT Image 2), Aug 20 (transparencia preview), Sep 8 (GPT Image 2.5), Oct 6 (tiers Build/Launch/Grow; Decisions API), DALL·E removidos 2026‑05‑12.
5. [F7] «Deprecations» — https://developers.openai.com/api/docs/deprecations — periodos de aviso; gpt‑image‑1 apagado 2026‑10‑23; gpt‑image‑1‑mini/1.5/chatgpt‑image‑latest 2026‑12‑01; GPT‑4o/4.1 2027‑01‑14; gpt‑5.4‑nano/5.1/5.3‑codex 2027‑04‑01; gpt‑5/5‑mini/5‑nano 2026‑12‑11; DALL·E 2026‑05‑12.
6. [F9] «GPT‑Image‑2.5 Flare» — https://developers.openai.com/api/docs/models/gpt-image-2.5-flare — snapshot 2026‑09‑08, tarifas, endpoints, rate limits.
7. [F10] «GPT‑Image‑1 Mini» — https://developers.openai.com/api/docs/models/gpt-image-1-mini — Deprecated, precios por imagen y por token, rate limits.
8. [F11] «Image generation tool (Responses)» — https://developers.openai.com/api/docs/guides/tools-image-generation — modelos admitidos por la herramienta (incl. gpt‑image‑2), opciones, `action`, revised_prompt, multi‑turn.
9. [F12] «API Organization Verification» — https://help.openai.com/en/articles/10910291-api-organization-verification — requisitos de verificación de negocio/identidad.
10. [F13] API reference «Create image» — https://developers.openai.com/api/reference/resources/images/methods/generate — parámetros (model, background, moderation, n 1‑10, output_format/compression, partial_images, quality, size arbitrario, stream, safety_identifier), respuesta b64 y usage.
11. [F14] API reference «Create image edit» — https://developers.openai.com/api/reference/resources/images/methods/edit — images ≤16, mask, markup (2.5), input_fidelity (omitir en gpt‑image‑2), default model 2.5‑sunburst.
12. [F15] «Provenance signals in OpenAI‑generated content» — https://help.openai.com/en/articles/8912793-provenance-signals-in-openai-generated-content — C2PA + SynthID en imágenes de API; excepciones; Content Provenance API gratuita con límites.
13. [F16] «Batch API» guía — https://developers.openai.com/api/docs/guides/batch — 50 %, ventana 24h, límites por lote, expiración.
14. [F17] «Flex processing» — https://developers.openai.com/api/docs/guides/flex-processing — tarifas Batch, timeouts, 429 sin cargo, beta.
15. [F18] «Terms of Use» (RoW, efectivas 2026‑01‑01) — https://openai.com/policies/row-terms-of-use/ — prohibiciones de extracción programática y redistribución; uso de contenido para mejorar servicios con opt‑out; remisión a Business Terms para APIs. (La URL https://openai.com/policies/terms-of-use/ devolvió HTTP 403; la versión RoW es el documento publicado equivalente.)
16. [F19] «OpenAI Services Agreement» (efectivo 2026‑01‑01) — https://openai.com/policies/services-agreement/ (destino de /policies/business-terms/) — §2.2 integración en Customer Applications, §3 restricciones, §4 contenido, §5 DPA, §6 pagos/impuestos/cambios de precio, §11 borrado, §13 indemnización, §14 límites, §16 países.
17. [F20] «OpenAI Data Processing Addendum» (efectivo 2026‑01‑01) — https://openai.com/policies/data-processing-addendum/ — roles, subencargados (30 días de objeción), brechas, auditoría, SCC/UK, CCPA, Schedule 1.
18. [F21] «Usage policies» (efectivas 2026‑11‑20) — https://openai.com/policies/usage-policies/ — likeness sin consentimiento, IP, impersonation, alto riesgo, intermediarios.
19. [F22] Codex «Authentication» — https://developers.openai.com/codex/auth (sirve en learn.chatgpt.com/docs/auth) — ChatGPT vs API key, «API keys … recommended default for automation», tokens de acceso Enterprise.
20. [F23] Codex «Pricing» — https://developers.openai.com/codex/pricing (learn.chatgpt.com/docs/pricing) — rate card en créditos incl. GPT‑Image‑2, límites por 5 h, tabla de planes (entrenamiento por defecto Plus/Pro «—»), API key a precios API.
21. [F24] «Enterprise privacy at OpenAI» (2026‑01‑08) — https://openai.com/enterprise-privacy/ — no entrenamiento por defecto, 30 días, ZDR, SOC 2 Type 2, DPA para Business/Enterprise/API, acceso humano.
22. [F25] «GPT‑6 Luna» — https://developers.openai.com/api/docs/models/gpt-6-luna — contexto, cutoff, effort, precios, Chat Completions/tools, rate limits y cola batch.
23. [F26] «GPT‑6.1 Sol» — https://developers.openai.com/api/docs/models/gpt-6.1-sol — idem; sin `none`; Ultrafast 6×; caché 5 %.
24. [F27] «GPT‑6.1 Terra» — https://developers.openai.com/api/docs/models/gpt-6.1-terra — idem.
25. [F28] «Prompt caching» — https://developers.openai.com/api/docs/guides/prompt-caching — mínimo 1 024, write 1.25×/2.5×, read 0.1×/0.05×, breakpoints, TTL, enrutamiento.
26. [F29] «Structured model outputs» — https://developers.openai.com/api/docs/guides/structured-outputs — tipos soportados, raíz objeto, required, additionalProperties, límites 5 000/10/1 000/120 000.
27. [F30] «Data controls in the OpenAI platform» — https://developers.openai.com/api/docs/guides/your-data — tabla por endpoint, ZDR/MAM/PSP, imágenes ZDR‑compatibles, residencia y regiones, +10 %.
28. [F31] «Reasoning models» — https://developers.openai.com/api/docs/guides/reasoning — tokens de razonamiento cobrados como salida, efforts, defaults, max_output_tokens, modo pro.
29. [F32] «Decisions API» — https://developers.openai.com/api/docs/guides/decisions — gpt‑6‑luna único modelo, $0.10/M entrada, salida gratis, 400 preguntas, ZDR/HIPAA.
30. [F33] «Rate limits» — https://developers.openai.com/api/docs/guides/rate-limits — tiers Free/Build/Launch/Grow, límites por modelo, slow_down/overload, cabeceras, spend limits.
31. [F34] «Multi‑currency billing» — https://help.openai.com/en/articles/10421635-multicurrency-billing — «Purchases for API credits are currently limited to USD»; MXN solo suscripciones.
32. [F35] «Supported countries and territories» — https://developers.openai.com/api/docs/supported-countries — México incluido.
33. [F36] «OpenAI Sub‑processor list» (2026‑10‑14) — https://openai.com/policies/sub-processor-list/ — entidades, ubicaciones, propósitos.
34. [F37] «OpenAI Trust Portal» — https://trust.openai.com/ — SOC 2 Type 2, SOC 3, ISO 27001/27017/27018/27701/42001, PCI DSS, CSA STAR, FedRAMP 20x.
35. [F38] «OpenAI Status» — https://status.openai.com/ — uptime 2026‑08‑04 → 2026‑11‑02 por componente.
36. [F39] «Images and vision» — https://developers.openai.com/api/docs/guides/images-vision — tokenización por parches (modelos de visión), regla histórica de tokens de entrada gpt‑image‑1 (65 + 129/tile + 4 160/6 240 high fidelity), nota de que la calculadora no cubre GPT Image.
37. [F40] «Updating billing information, Tax ID, and VAT ID» — https://help.openai.com/en/articles/9038389-updating-billing-information-tax-id-and-vat-id — 2026‑11‑03 — Tax ID en billing preferences de la organización API; Tax ID inválido ⇒ puede cobrarse impuesto; cambios solo afectan facturas futuras. (Antes [S1], SNIPPET; verificado con `read`.)
38. DEC‑0073 y canon 0.4.0 — `.canonflow/decision-records/DEC-0073.md`, `.canonflow/canon/functional/items/BR-0007.md`, `.canonflow/canon/technical/items/ARC-0001.md`, `OPS-0001.md`, `migrations/0029_ai_openai_development.sql`, `src/ai/catalog.ts:59-97,290+` (checkout SOL MAIN `mainspot-platform`, HEAD `1f1c7da`; solo lectura) — 2026‑11‑03 — hechos de §7.3.
39. `evidence/lab-traces.md` y `lab-invocations.csv` (310 filas, sha256 `4b35bab9…`) — 2026‑11‑03 — tokens medidos de §7.4 (MEDICIÓN PROPIA).

Páginas que no cargaron o no aportaron texto: https://openai.com/policies/terms-of-use/ (HTTP 403 → sustituida por [F18]); https://platform.openai.com/subprocessors (render JS vacío → sustituida por [F36]); https://platform.openai.com/pricing/ (sustituida por [F1]).

## Huecos

| Hueco | Estado | Cómo verificarlo |
| --- | --- | --- |
| Tokens de imagen de **entrada** para `/v1/images/edits` con `gpt-image-2` (1 imagen + máscara) | DESCONOCIDO (proxy gpt‑image‑1) | 1 llamada real con imagen sintética 1024² + máscara y leer `usage.input_tokens_details.image_tokens` (≈ $0.09–0.13). NO MEDIDO. |
| Costo por imagen de `gpt-image-2.5-sunburst/flare` y de gpt‑image‑2 en 2K/4K | DESCONOCIDO (calculadora JS no legible) | Abrir la calculadora en navegador o 1 llamada por combinación leyendo `usage.output_tokens`. |
| Validación del esquema de 17 uniones `anyOf` en Structured Outputs | NO MEDIDO | Petición Responses con `text.format` json_schema estricto y `max_output_tokens` mínimo; observar 400 vs 200. |
| Tokens por perfil vía **OpenAI directo** (sin capa OpenRouter) | NO MEDIDO | Benchmark B‑TXT de `03-quality-benchmarks.md` contra la integración directa de SOL MAIN (DEC‑0073), leyendo `usage`; las cifras de §7.4 son vía OpenRouter y pueden diferir (ver §7.4.3). |
| Tokens de razonamiento reales por perfil (Luna/Terra `none` vs Sol `low`) | NO MEDIDO | Suite sintética leyendo `output_tokens_details.reasoning_tokens`. |
| Calidad en español (MX) de Luna/Terra/Sol para DSL web, posts y respuestas | NO MEDIDO | Benchmark controlado de 03‑quality‑benchmarks con rúbricas comunes. |
| Comportamiento del filtro ante logos/marcas registradas en prompts | DESCONOCIDO | Pruebas con marcas ficticias y reales (riesgo de bloqueo; no usar personas). |
| Si la verificación de organización será exigida a la organización concreta de MainSpot | DESCONOCIDO (depende de la cuenta) | Consola `platform.openai.com/settings/organization/general`; no requiere gasto. |
| Elegibilidad real de MainSpot para ZDR/Modified Abuse Monitoring y plazo | DESCONOCIDO (aprobación de ventas) | Solicitud a ventas; hasta entonces asumir 30 días de logs de abuso. |
| Valor en USD de los «créditos» Codex (para comparar con API) | DESCONOCIDO (depende del plan) | No relevante: vía descartada para backend. |
| Tratamiento de IVA/retenciones en México sobre facturas OpenAI (USD) | DESCONOCIDO en fuentes OpenAI | Contador/SAT; Services Agreement §6.3 impone gross‑up si hay retención. |
| SLA contractual para pago por uso | No publicado (solo uptime agregado) | Scale/Reserved Tier o contrato Enterprise. |
| Término de vida de `gpt-image-2` frente a 2.5 | Sin fecha de deprecación; aviso mínimo 6 meses | Vigilar deprecations y `GET /v1/models` (`shutdown_date`). |
