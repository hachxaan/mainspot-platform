# 02 — Comparación de proveedores, modelos y economía unitaria del MainSpot AI Core

Fecha: 2026-11-03. Moneda: USD salvo indicación (MXN al FIX 18.7962 del 30/10/2026, Banxico — `evidence/business-inputs.md` §1). MTok = 1,000,000 tokens.
Alcance: investigación, sin llamadas pagadas, sin cambios de política (DEC-0069/0071/0068/0073 se describen, no se modifican). Este documento **sintetiza y cruza** los archivos de evidencia ya auditados; no repite su contenido verbatim y toda cifra remite al archivo fuente.

Etiquetas heredadas y propias: **HECHO VERIFICADO** (leído en fuente oficial o en archivo del repo), **MEDICIÓN PROPIA** (laboratorio 2026-10-30, vía OpenRouter para texto y TypeSafe directo para Jev; no producción), **ESTIMACIÓN** (cálculo propio con fórmula), **HIPÓTESIS**, **DESCONOCIDO**, **NO MEDIDO**.

---

## 1. Tabla maestra por modelo

### 1.1 Modelos de texto (API directa, precios Standard a contexto corto, HECHO VERIFICADO 2026-11-03)

Fuentes: `evidence/anthropic.md` §1–§3, `evidence/openai.md` §3–§4, `evidence/text-models-benchmarks.md` §1.1–§1.3.

| Modelo (id API exacto) | Proveedor | Estado API | Contexto / salida máx. | Input | Output | Caché (lectura / escritura) | Batch (in/out) | Structured outputs / restricciones | Tools | Fuente |
|---|---|---|---|---:|---:|---|---|---|---|---|
| `claude-haiku-5-5` | Anthropic | GA (7 oct 2026); retiro no antes del 7 oct 2027 | 1M / 128K (300K en Batch) | $0.10 (≤100K prompt); $0.50 (>100K) | $0.50 / $2.50 | read $0.01 (0.1×) / write 5m $0.125 · 1h $0.20; mínimo cacheable **512 tok** | $0.05 / $0.25 | Nativo (`output_config.format`); **máx. 16 parámetros con unión (`anyOf`/type-array) y 24 opcionales por petición**; timeout de compilación 180 s; el fallo LAB de `website.edit.*` (17 uniones) es consistente con este límite | Nativo; +286 tokens de system prompt; thinking adaptativo **desactivable** (`disabled`) a effort ≤ high; effort default `medium` | anthropic.md §1.1, §2.1, §2.7 |
| `claude-sonnet-5-5` | Anthropic | GA (28 sep 2026) | 1M / 128K (300K) | $2.00 | $10.00 | read $0.10 (0.05×, rebajado 7 oct 2026) / write 5m $2.50 · 1h $4 | $1 / $5 | Mismo marco; **no acepta `thinking: disabled`** (mínimo `between_tools`); effort default `high` | Nativo; rejectsForcedToolChoice en adaptador SOL MAIN | anthropic.md §1.1, §2.1, §2.6 |
| `claude-opus-5-5` | Anthropic | GA (22 sep 2026) | 1M / 128K | $4.00 | $20.00 | read $0.20 / write $5 · $8 | $2 / $10 | Mismo marco; thinking **siempre activo** (`disabled` → 400); effort default `medium` | Fast mode $8/$40 (2×) | anthropic.md §1.1, §2.9 |
| `gpt-6-luna` | OpenAI | GA; sin snapshot fechado (solo alias) | 1.05M (entrada máx. 922K) / 128K | $0.10 (≤272K); $0.20 (>272K) | $0.50 / $0.75 | read $0.01 (0.1×) / write 30m $0.125 · 12h $0.25; mínimo cacheable **1,024 tok** | $0.05 / $0.25 (Batch y Flex) | `text.format json_schema` strict: **`anyOf` soportado sin límite publicado de variantes**; raíz debe ser `object` (no `anyOf`); todo `required`; ≤5,000 propiedades, ≤10 niveles, ≤1,000 valores enum | `reasoning.effort` **`none`…max**; function calling en Chat Completions **solo con effort `none`**; tools vía Responses | openai.md §3.1–§3.5 |
| `gpt-6.1-terra` | OpenAI | GA | 1.05M / 128K | $1.00 | $5.00 | read $0.05 (0.05×) / write $1.25 · $2.50 | $0.50 / $2.50 | Ídem Luna; effort `none`…max | Tools **solo Responses API** | openai.md §3.1–§3.2 |
| `gpt-6.1-sol` | OpenAI | GA | 1.05M / 128K | $2.00 (≤272K); $4/$15 >272K | $10.00 / $15 | read $0.10 (0.05×) / write $2.50 · $5 | $1 / $5 | Ídem | **Sin effort `none`** (mínimo `low`); tools solo Responses; Ultrafast 6× | openai.md §3.1–§3.2 |
| `gemini-4-argon` | Google | GA; **precio introductorio $2/$10 solo hasta 2026-11-30 → $4/$20 desde 2026-12-01** | 1,048,576 unificado / 65K (1M long decode) | $2 → $4 | $10 → $20 | implícita ($0.10 → $0.20) | $1/$5 → $2/$10 | Sin cifras publicadas de límites de esquema; **no aplica** `minLength/maxLength/minProperties` (los elimina en silencio); uniones/enums multiplican ramas → `400 INVALID_ARGUMENT` | thinking low/medium/high (sin `none`); Priority ×1.8 en Vertex | text-models-benchmarks.md §1.3, §2.6 |
| `deepseek-flash` (V4.1-Flash-1017) | DeepSeek | GA; pico/valle UTC (pico 01–04 y 06–10 UTC L–V) | 1M / 384K | $0.30 pico / $0.15 valle | $1.20 / $0.60 | cache hit $0.006/$0.003 | — | JSON output + tool calls; esquema estricto DESCONOCIDO | Thinking por defecto (conmutable); API compatible Anthropic | text-models-benchmarks.md §1.4 |

Notas transversales (HECHO VERIFICADO en las fuentes citadas):
- **Tokenizadores no comparables**: Claude ≥4.7 genera ~30 % más tokens para el mismo texto; en el laboratorio el mismo prompt consumió **~2–2.5× más tokens de entrada en Haiku 5.5 que en GPT-6 Luna** vía OpenRouter (`lab-traces.md`, hallazgo 3). Comparar USD/MTok sin tokens por tarea es engañoso.
- **Razonamiento se factura como salida** en ambos proveedores y cuenta contra `max_tokens` (anthropic.md §2.6; openai.md §3.6). Sol no admite `none`; Sonnet 5.5 no acepta `disabled`.
- **Escalones**: OpenAI tiene un punto intermedio ($1/$5 Terra) que Anthropic no tiene (salto directo Haiku $0.10 → Sonnet $2).
- Recargo regional (+10 %) aplicable en ambos para modelos recientes (§2); Anthropic `inference_geo: us`, OpenAI residencia regional para modelos ≥ 2026-03-05.

### 1.2 Clasificación semántica

| Modelo | Proveedor | Precio | Contrato de respuesta | Límites | Datos | Fuente |
|---|---|---|---|---|---|---|
| `jev-1.14.0` (fijado; alias `jev-latest`) | TypeSafe (directo) | **$0.042/MTok de entrada; salida $0**; un solo plan, sin cargo por petición fallida ni mínimos; créditos prepagados (402 al agotarse), caducan a 12 meses | Tipado nativo: `choice` (hasta 255 opciones, probabilidades + `confidence`), `noul` (probabilidad 0–1), `score` (≤10 niveles); **no hay campo `cost` en la OpenAPI** → costo MainSpot siempre `estimated` | Contexto 64k/petición y 32k/pregunta (262k opt-in "danger zone"); 100,000 tok/s y 80 req/s por organización; cuerpo ≤32 MiB | No entrenamiento (MCA §4.1); retención **sin plazo publicado**; ZDR gratis a solicitud; procesamiento en EE. UU. | typesafe-jev.md §3.1–§3.4, §3.7 |
| `gpt-6-luna` vía **Decisions API** (`POST /v1/decisions`) | OpenAI | $0.10/MTok entrada; **salida no se cobra**; beta desde 2026-10-06 | Respuestas tipadas (`choice`, `score`, probabilidad); hasta 400 preguntas/petición; "~10× más rápido" que Responses (claim del proveedor) | Solo `gpt-6-luna`; beta | No entrenamiento; 30 días logs de abuso; ZDR elegible | openai.md §3.7 |

### 1.3 Modelos de imagen

Fuentes: `evidence/openai.md` §1, `evidence/image-providers.md` §1–§8. Detalle completo y rankings en §6 de este documento y en image-providers.md.

| Modelo (id API) | Proveedor | Estado | Unidad de facturación | Precio imagen 1K / web 16:9 | Edición | Datos | Fuente |
|---|---|---|---|---|---|---|---|
| `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`) | OpenAI | GA; `v1/images/generations`, `v1/images/edits`, `v1/batch`; **requiere verificación de organización** | Tokens: texto in $5, imagen in $8, **imagen out $30** (Batch $2.50/$4/$15) | 1024²: low $0.006 / medium $0.053 / high $0.211; 1536×1024: $0.005 / **$0.041** / $0.165 (tabla oficial por imagen) | Hasta **16 imágenes de entrada** + máscara de inpainting; `input_fidelity` alto automático (no configurable); n 1–10; tamaños arbitrarios múltiplos de 16, ratio 1:3–3:1, lado ≤3,840 px | Imágenes sin estado de aplicación, **ZDR elegible**, no entrenamiento, abuso 30 días; C2PA + SynthID en salida | openai.md §1.1–§1.7 |
| `gpt-image-2.5-sunburst` / `-flare` (2026-09-08) | OpenAI | GA; **la guía recomienda 2.5 para integraciones nuevas**; gpt-image-2 no deprecado (aviso mínimo 6 meses) | Mismas tarifas por token; calidades extra `xhigh`/`max`; `markup` solo 2.5 | Costo por imagen **DESCONOCIDO** (consumo de tokens no documentado; calculadora JS) | Ídem gpt-image-2 | Ídem | openai.md §1.2, §1.4 |
| `gemini-nano-banana-2.1` (Nano Banana 2.1, oct 2026) | Google (Gemini API pagada) | GA | Tokens: entrada $1.50/M; imagen salida $30/M; **1K = 1,120 tokens fijos por imagen independiente del ratio** | **$0.0336** (1K) / $0.0504 (2K) / $0.113 (4K); Batch −50 % | Hasta **14 imágenes de referencia** (10 objetos + 4 personajes), edición conversacional; sin máscara explícita documentada | Pagado: Google no usa prompts/respuestas para mejorar productos, DPA como encargado; **SynthID en todas**; México en lista de regiones | image-providers.md §2 |
| `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite) | Google | GA | $0.25/M in · $30/M out | **$0.0336** por 1K | Hasta 14 refs (`input_references`) | Ídem | openrouter.md §2.2, image-providers.md §2.1 |
| `dola-seedream-5-0-flash-260915` / `dola-seedream-5-0-pro-260628` | ByteDance (BytePlus ModelArk) | GA | **Por imagen**: flash $0.018; pro $0.045 (≤2.61 Mpx; 1536×1024 = 1.57 Mpx → $0.045) / $0.09 (>2.61 Mpx); **entradas gratis**; imágenes bloqueadas por moderación no se cobran | $0.018 / $0.045 | Edición interactiva (marcas, `<bbox>`, `<point>`), 2–10/14 referencias, **descomposición en capas** (base + ≤16 capas PNG alfa) | Términos de datos de BytePlus **NO leídos** (bloqueante DEC-0067); región documentada `ap-southeast-1`; disponibilidad México DESCONOCIDO | image-providers.md §4 |
| FLUX 3 Image / FLUX 3 Image Klein | Black Forest Labs (`api.bfl.ai`) | GA | Por imagen por tier: Klein 768 $0.008 · 1K **$0.009** · 1.5K $0.011 · 2K $0.014 · 4K $0.036; FLUX 3 Image 1K $0.048 · 1.5K $0.070 · 4K $0.607 | $0.009 (Klein) / $0.048 | Edición y T2I mismo endpoint, 1–10 imágenes, bounding boxes que preservan regiones "exactamente sin cambios" | **Trampa contractual: los FLUX API Service Terms §2b otorgan a BFL licencia perpetua e irrevocable sobre Entradas y Salidas para entrenar sus modelos** — riesgo directo para fotos de clientes; no ZDR | image-providers.md §3; openrouter.md §2.2 |
| MAI-Image-2.6 / 2.6-Flash / 2.5 | Microsoft (Azure AI Foundry) | **Todos Preview (sin SLA)** salvo MAI-Image-2 (GA, $5/M texto + $33/M imagen out) | Por token (2.6: 1.75/2.50/19.00 por M según OpenRouter; **precio oficial Azure DESCONOCIDO**) | DESCONOCIDO (referencia secundaria AA ≈ $0.0195/imagen para 2.6-Flash) | Hasta 5 referencias (multipart); máx 2.36 Mpx (2.6) | Términos Microsoft no leídos; **sin región Mexico Central**; Preview = no producción | image-providers.md §5 |

---

## 2. Por cuenta/proveedor

### 2.1 Anthropic directo (Claude API)

| Dimensión | Hecho | Etiqueta/Fuente |
|---|---|---|
| Modelo de facturación | USD; prepago de créditos con tarjeta (caducan a **1 año**, no reembolsables) o facturación mensual en arrears vía ventas (Stripe); solo se cobran llamadas exitosas (una petición en curso al desconectarse el cliente **sí** se cobra); "plus applicable taxes" | HECHO VERIFICADO (anthropic.md §2.11) |
| Tiers y subida | Spend caps: Evaluation (auto) → **Start $500/mes** → Build $1,000 → Scale $200,000; al llegar al tope: 429 `enforced_spend_limit_reached` sin `retry-after`, pausa hasta el día 1 del mes siguiente. **No hay depósito que suba de tier**: asignación automática por historial; solicitud de aumento al usar ≥50 % de límites | HECHO VERIFICADO (anthropic.md §3.1, §3.3) |
| Rate limits (5.5) | Start 4,000 RPM / 2M ITPM / 400k OTPM por modelo (cada 5.5 tiene bucket propio); ITPM no cuenta lecturas de caché; Batch con límites propios (Start 1,000 req/cola) | HECHO VERIFICADO (anthropic.md §3.2, §2.4) |
| SLA / estado | Sin SLA contractual en self-service. **31 incidentes tocaron "Claude API (api.anthropic.com)" entre 5 ago y 28 oct 2026** (≈2,933 min acumulados, incluye no-modelos); en la ventana 20 oct–3 nov hubo 7 incidentes de "elevated errors", Sonnet 5.5 acumuló ≈4.3 h; uptime 90 días DESCONOCIDO (la página no lo expone sin render) | HECHO VERIFICADO (anthropic.md §6.2) |
| Respaldo de capacidad | **Priority Tier legacy: ya no se vende** y no soporta modelos 5.5; la resiliencia debe venir de reintentos/Batch (Batch: 50 % dto., <1 h típico, expira a 24 h, **no elegible ZDR**) | HECHO VERIFICADO (anthropic.md §2.8, §2.4) |
| Impuestos / México | Todo en USD; Commercial Terms H.2: tarifas **sin impuestos**, cliente responsable de retenciones (withholding) con obligación de evidencia; México en la lista de países soportados; **no hay documentación pública de IVA/CFDI para México** | HECHO VERIFICADO / DESCONOCIDO (anthropic.md §2.11; hueco 5) |
| DPA y subencargados | DPA (24 feb 2025) **incorporado automáticamente** al aceptar Commercial Terms; brecha ≤48 h; objeción a subencargados 15 días; borrado ≤30 días tras terminación; SCC Módulos 2/3 incorporados; **22 subencargados públicos** (Google Cloud, AWS, Azure, Cloudflare, Stripe…, actualizado 14 oct 2026); SOC 2 Type 2, ISO 27001/42001, HIPAA, NIST 800-171 | HECHO VERIFICADO (anthropic.md §4) |
| Datos | Sin entrenamiento por defecto (Commercial Terms §B); retención 30 días; **ZDR por organización a solicitud de ventas**, excluye Batch (29 días), Files API, code execution, CORS; estructured outputs "qualified" (esquema cacheado 24 h) | HECHO VERIFICADO (anthropic.md §4) |
| Residencia | `inference_geo: global` (default) o `us` (**+10 %** en todo); reposo solo en workspace `us`; **no existe geo MX/LATAM** | HECHO VERIFICADO (anthropic.md §2.10) |
| Marketplace | Claude Platform on AWS y Foundry: mismas tarifas por token convertidas a CCU ($0.01/CCU), facturación e impuestos gestinados por el marketplace; Bedrock/Vertex a igual precio global o +10 % regional, **Batch N/A en Bedrock para 5.5** | HECHO VERIFICADO (anthropic.md §2.12, §5.2) |

### 2.2 OpenAI directo (API de plataforma)

| Dimensión | Hecho | Etiqueta/Fuente |
|---|---|---|
| Modelo de facturación | Créditos API **solo en USD** (MXN solo en suscripciones ChatGPT); no reembolsables; precios sin impuestos (§6.3 Services Agreement: **gross-up** si hay retención legal); **cambios de precio efectivos 14 días tras publicarse** | HECHO VERIFICADO (openai.md §4.2) |
| Tiers y subida | Simplificados a 3 el 2026-10-06; ascenso automático por **compras de crédito acumuladas**: Build ($5 comprados) → límite $500/mes; Launch ($100) → $5,000; Grow ($500) → $200,000; Free $100. Spend limits configurables por organización/proyecto | HECHO VERIFICADO (openai.md §4.1) |
| Rate limits | Build: Luna 5,000 RPM / 2M TPM; Sol/Terra 5,000 RPM / 1M TPM; Launch 10,000 RPM / 4M–10M; imagen: IPM 20 (Build) / 150 (Launch) / 250 (Grow). Ramp-rate: 429 `slow_down` si crece >50 %/15 min sobre 1M TPM; 503 `server_is_overloaded` con `Retry-After` | HECHO VERIFICADO (openai.md §4.1, §1.6) |
| SLA / estado | Sin SLA contractual por uso; uptime agregado 4 ago–2 nov 2026: **APIs 99.97 %** (2 días outage parcial), **Images 99.990 %**, Responses 100 %, Batch 100 %; Codex 99.94 % (1 outage total) — Codex es la vía de suscripción, no la API | HECHO VERIFICADO (openai.md §6) |
| Impuestos / México | México en lista de países soportados; Tax ID/VAT editable en billing preferences de la organización (Tax ID inválido ⇒ pueden cobrarse impuestos; cambios solo afectan facturas futuras); IVA mexicano sobre servicios digitales importados: **DESCONOCIDO** en fuentes OpenAI (ver §2.5) | HECHO VERIFICADO / DESCONOCIDO (openai.md §4.2) |
| DPA y subencargados | Services Agreement (2026-01-01) + **DPA pública ejecutable en línea** (Ironclad); objeción a subencargados **30 días**; auditoría ≤1/año; lista de subencargados fechada 2026-10-14 (Microsoft, CoreWeave, Oracle, Google Cloud, AWS, Cerebras, Snowflake, TaskUs/Accenture/Cinder…); SOC 2 Type 2, ISO 27001/27017/27018/27701/**42001**, PCI DSS | HECHO VERIFICADO (openai.md §5.3) |
| Datos | No entrenamiento por defecto (§4.2 SA); logs de abuso ≤30 días; `/v1/images/*` **sin estado de aplicación y ZDR-elegible** (incl. `gpt-image-2`); `/v1/responses` guarda 30 días salvo `store:false` (lo que SOL MAIN ya usa); ZDR/MAM requieren aprobación de ventas | HECHO VERIFICADO (openai.md §5.1) |
| Residencia | Regiones US (`us.api.openai.com`, sin requisito ZDR) y EU (requiere ZDR/MAM), + AU/CA/JP/IN/SG/KR/GB/AE (solo almacenamiento); **no existe región México/LatAm**; sobreprecio **+10 %** para modelos ≥ 2026-03-05; el esquema de Structured Outputs se procesa como "system data" fuera de la región | HECHO VERIFICADO (openai.md §5.2) |
| Suscripción Codex ≠ API | `openai-codex/*` es acceso OAuth por suscripción de consumidor: ToU prohíbe extracción programática y redistribución; Plus/Pro sin compromiso de no-entrenamiento por defecto; sin DPA. **No apta para backend de MainSpot**; la vía válida es API key bajo Services Agreement | HECHO VERIFICADO (openai.md §2) |

### 2.3 TypeSafe directo (Jev)

| Dimensión | Hecho | Etiqueta/Fuente |
|---|---|---|
| Facturación | Créditos prepagados en consola (auto-recarga opcional; invoice bajo petición); saldo 0 ⇒ HTTP 402; créditos caducan a 12 meses; impuestos excluidos (cliente paga sales/VAT/withholding) | HECHO VERIFICADO (typesafe-jev.md §3.1, §3.5) |
| Límites | 100,000 tokens/s y 80 req/s por organización (default); superiores con prepago pequeño o formulario. Para MainSpot (≈1,100 tok/llamada) el límite efectivo es el propio `JEV_MAX_IN_FLIGHT = 16`/proceso | HECHO VERIFICADO + ESTIMACIÓN (typesafe-jev.md §3.3, §1.2) |
| SLA / estado | **No hay SLA público** (MCA §9.3 "as is/as available"; remedio de garantía = corrección o reembolso); uptime 30 d `api.typesafe.ai` **99.858 %**; incidente "System overload" 2026-10-30 (1 h 15 min) — coincide con el p95 de 10 s y timeouts del run3 del lab [INFERENCE de causalidad] | HECHO VERIFICADO (typesafe-jev.md §3.6) |
| Contrato | MCA: tope de responsabilidad **USD 50**; arbitraje JAMS San Francisco; ley de California; suspensión inmediata por impago ≥30 días; **prohibida la destilación** (usar Output de Jev para entrenar clasificadores propios); puede listar a MainSpot como referencia salvo petición escrita; cambios del MCA con ≥60 días de aviso; §2.5 permite cambios del servicio que "puedan hacer la API incompatible" | HECHO VERIFICADO (typesafe-jev.md §3.5) |
| DPA / datos | DPA pública (SCC UE Módulos 2/3, UK Addendum; aviso de subencargados 15 días; incidentes ≤72 h; auditoría anual a costa del cliente); **sin cláusula para México** (LFPDPPP); retención sin plazo fijo; **ZDR gratis para toda organización, por solicitud** (activación en MainSpot: DESCONOCIDO); Trust Center de subencargados no accesible sin JS/acceso; SOC 2 Type II anunciado, informe no revisado | HECHO VERIFICADO / DESCONOCIDO (typesafe-jev.md §3.7, §4.2) |
| Presupuesto vigente | DEC-0032: USD 1/día **global por despliegue** (no por negocio); a $0.000046/llamada se agota en ≈21,700 clasificaciones/día — suficiente para lab, inadecuado como control productivo | HECHO VERIFICADO + ESTIMACIÓN (typesafe-jev.md §4.2, §5.2) |
| DEC-0073 | TypeSafe **no afectado**: «TypeSafe/Jev conserva clasificación semántica primaria» | HECHO VERIFICADO (typesafe-jev.md §4.3) |

### 2.4 OpenRouter como estudio (no autorizado para ejecuciones: DEC-0069)

| Dimensión | Hecho | Etiqueta/Fuente |
|---|---|---|
| Precio | Pass-through del precio de lista (10/10 modelos cruzados **sin discrepancia** contra directo); la evidencia histórica del lab confirma precio de catálogo aplicado sin sobreprecio en `usage.cost` | HECHO VERIFICADO (openrouter.md §1, §2, §5; lab-traces.md hallazgo 2) |
| Sobrecosto real | **5.5 %** (Standard) / **8 %** (Business) sobre la compra de créditos; BYOK: 0 % hasta $25,000/mes de lista, luego 5 %; mínimo de compra $5; créditos caducan a 365 días; reembolso solo 24 h | HECHO VERIFICADO (openrouter.md §1) |
| Qué pierde vs directo | **Batch −50 % no existe vía OpenRouter para ningún modelo de imagen**; `tool_choice` forzado no disponible en endpoints Claude; límites de esquema del proveedor subyacente se mantienen (16 uniones Anthropic); `usage.cost` sí viene homogéneo | HECHO VERIFICADO (openrouter.md §4) |
| Datos | OpenRouter encargado + cada proveedor de modelos como subencargado sin aviso de 30 días (flow-down obligatorio de Model Terms); CSAM screening in-flight desde 2026-10-27; bajo ZDR del lab, `gpt-image-2` tenía 0 endpoints (bloqueo 404 del lab explicado) y el pool de Claude se reduce a Vertex (3 regiones) | HECHO VERIFICADO (openrouter.md §3) |
| Fiabilidad | Sin SLA salvo Enterprise; uptime por endpoint observado 100 % salvo excepciones (AI Studio de Gemini image 84–97 %, flex de Luna 67.85 % un día) | HECHO VERIFICADO (openrouter.md §2.3) |
| Uso como estudio | Valor real para **evaluar multi-modelo con una sola clave** (Argon, DeepSeek, Seedream, FLUX) con sobrecosto ≈5.5 % del gasto de evaluación; **reactivar aunque sea para evaluación requiere decisión del propietario** | HECHO VERIFICADO + propuesta (openrouter.md §6) |

### 2.5 Impuestos y facturación para México (cruce con `evidence/business-inputs.md`)

- Régimen de plataformas digitales extranjeras (art. 18-J LIVA): su catálogo es taxativo y **no incluye APIs de IA, storage ni SaaS B2B** ⇒ HIPÓTESIS operativa: Anthropic/OpenAI/Google **no cobran IVA mexicano** a MainSpot (confirmar con contador). Lo que sí aplica es la **autoliquidación del IVA de importación de servicios (16 %)** por MainSpot, acreditable si su actividad está gravada (efecto de flujo de caja, neutro en P&L). Retenciones de ISR: DESCONOCIDO (fuera de alcance). (business-inputs.md §2)
- Tipo de cambio base: **FIX 18.7962 MXN/USD (30/10/2026)**; banda de sensibilidad 18.0–19.5. Planes MXN 500/1,000/2,000 = USD 26.60/53.20/106.41 (hipotéticos, no aprobados). (business-inputs.md §1)
- **Ninguno de los tres proveedores directos (ni Google en sus regiones listadas para Gemini) ofrece región o facturación específica de México**; los sobreprecios regionales (+10 % Anthropic/OpenAI) no otorgan beneficio regulatorio mexicano documentado. Google: multi-región `us`/`eu`/`global`; `northamerica-south1` (Querétaro) no aparece para los modelos relevantes. (anthropic.md §2.10; openai.md §5.2; text-models-benchmarks.md §5.1)

---

## 3. Comparación de costos por tarea real de MainSpot

### 3.1 Método

Tokens **MEDIDOS** del laboratorio (`evidence/lab-traces.md`, 310 invocaciones del 2026-10-30, MEDICIÓN PROPIA; incluyen reparaciones) aplicados a las **tarifas directas verificadas** de §1. Fórmula: `costo = (in × P_in + out × P_out) / 1e6`. Limitaciones declaradas:
1. Los tokens de Haiku/Sonnet fueron medidos **vía OpenRouter**, que traduce el JSON Schema a Anthropic (infla entrada ~2–2.5×). Con Anthropic deshabilitado (DEC-0073) no hay medición de la vía directa ⇒ toda celda Haiku/Sonnet directa es **ESTIMACIÓN con sesgo alcista**.
2. Los tokens de Luna vía OpenRouter son los más "nativos" (el esquema viaja sin traducir a la API de OpenAI), pero difieren de los de OpenAI directo (tokenizador, `store:false`, effort). **NO MEDIDO** en directo.
3. Aplicar tokens de Luna a Sol/Terra **no mide** el efecto del razonamiento: Sol no admite `none` y las candidatas DEC-0073 usan `medium` ⇒ cota inferior; sensibilidad +$0.005 por cada +500 tokens de razonamiento en Sol.
4. Los costos "medidos" de lab-traces coinciden con la tarifa directa aplicada a los tokens medidos dentro del ruido de promediar por invocación (desviaciones ≤10 % p. ej. edit.simple Luna 0.000217 medido vs 0.000274 calculado): OpenRouter **no aplicó sobreprecio por token** (hallazgo 2 de lab-traces).

### 3.2 Texto — costo por llamada y por éxito

"Medido" = USD prom./éxito de `lab-traces.md` (incluye reparaciones; n=3–12 por celda, salvo indicación). "Directa (tokens medidos)" = tokens medidos × tarifa directa de §1. **ESTIMACIÓN** donde el perfil del modelo no fue medido (Haiku directo, Sol/Terra/Sonnet sobre tokens ajenos).

| Caso de uso | Haiku 5.5 directa (tokens vía OR) | Luna directa (= medido) | Sonnet 5.5 (tokens Haiku × tarifa 2/10) | Sol 6.1 (tokens Luna × tarifa 2/10) | Terra (tokens Luna × 1/5) |
|---|---|---|---|---|---|
| `website.initial.design` (4,029/3,396 H · 1,608/2,033 L) | **$0.00210** (medido) | **$0.00118** calc ($0.001113 medido) | $0.0420 | $0.0235 + razonamiento | $0.0118 |
| `website.edit.simple` (1,735/202 L) | sin medición (0/10: límite 16 uniones) | **$0.00027** calc ($0.000217 medido) | — (mismo esquema fallaría: HIPÓTESIS) | $0.0055 + razonamiento | $0.0027 |
| `website.edit.complex` (2,202/958 L) | sin medición (0/2) | **$0.00070** calc ($0.000631 medido) | — | $0.0140 + razonamiento | $0.0070 |
| `social.facebook.post.compose` (4,424/2,550 H · 1,776/745 L) | **$0.00172** (medido; $0.001794 con fallos con costo) | **$0.00055** ($0.000572) | $0.0343 | $0.0110 + razonamiento | $0.0055 |
| `engagement.facebook.comment.reply` (1,287/249 H · 621/189 L) | **$0.000253** | **$0.000157** | $0.0051 | $0.0031 | $0.0016 |
| `engagement.google.review.reply` (1,315/203 H · 645/182 L) | **$0.000233** | **$0.000155** | $0.0047 | $0.0031 | $0.0016 |
| `conversation.owner.assistant` (1 invocación; 4,729/427 H · 2,096/293 L) | **$0.000686** | **$0.000356** | $0.0137 | $0.0071 | $0.0036 |
| `business.insights.generate` (2,135/677 H · 712/404 L) | **$0.000552** | **$0.000273** | $0.0110 | $0.0055 | $0.0027 |
| `marketing.campaign.plan` (1,105/1,072 L) | $0.00198/éxito con fallos ($0.00398; 1/2: `invalid_output` pagado) | **$0.00065** ($0.000653) | — | $0.0129 + razonamiento | $0.0065 |
| `marketing.campaign.creatives` (1,580/760 L) | **$0.00146** | **$0.00054** ($0.000555) | $0.0292 | $0.0108 | $0.0054 |
| `editorial.calendar.suggest` (1,767/1,860 L) | 0/1 (`invalid_output`, $0.002383 pagados) | **$0.00111** ($0.001134) | — | $0.0221 | $0.0111 |

Lecturas (ESTIMACIÓN sobre MEDICIÓN PROPIA):
- **Luna es 1.4–3× más barata que Haiku por tarea a tarifa idéntica** (diseño 1.8×, compose 3.1×, insights 2×, asistente 1.9×), por los tokens de entrada. Es el factor dominante, no la tarifa.
- **La calidad de salida medida fue equivalente o mejor en Luna** en ediciones (único barato que pasó el esquema de 17 uniones), calendario y plan; Haiku pasó diseño/compose/replies/asistente/insights/creatives (`lab-history.md` §3.2). n pequeño.
- Sonnet/Sol (nivel medio-superior) cuestan **20× la celda barata** en dólares; solo justificables donde la calidad barata falle (la decisión de nivel por caso es materia de `05-recommendation.md`).
- Per-succes vs per-call: la columna "con fallos con costo" importa en plan Haiku ($0.00398 vs $0.00198) y compose Haiku ($0.001794 vs $0.001717).

### 3.3 Clasificación — Jev vs alternativas (por evento)

| Opción | Tokens (perfil) | Costo por evento | Múltiplo vs Jev | Etiqueta |
|---|---|---:|---:|---|
| **Jev 1.14.0** — comentario/reseña | 1,158 in (medido) | **$0.000049** | 1.0× | MEDICIÓN PROPIA |
| **Jev 1.14.0** — mensaje del dueño | 804 in (medido) | **$0.000034** | — | MEDICIÓN PROPIA |
| Haiku 5.5 / Luna, tiempo real, sin caché | 1,200/120 (HIPÓTESIS de perfil) | $0.000180 | 3.7× | ESTIMACIÓN |
| Haiku/Luna con caché de prefijo (~1,000 tok) | ídem | $0.000090 | 1.8× | ESTIMACIÓN (nota: el perfil de 800 tokens del dueño **no** alcanza el mínimo cacheable de OpenAI, 1,024; el de Anthropic, 512, sí) |
| Haiku/Luna Batch + caché | ídem | ≈$0.000045 | ≈0.9× | ESTIMACIÓN (no tiempo real; inaplicable a atención de comentarios) |
| **OpenAI Decisions API** (`gpt-6-luna`) | 1,158 in | $0.000116 | **2.4×** | ESTIMACIÓN sobre HECHO (tarifa verificada) |

Jev es el más barato en tiempo real y el único con probabilidades calibradas nativas y garantía de tipo; la diferencia absoluta ($0.00004–0.00013/evento) es marginal frente al margen por cliente: **la decisión Jev vs generativo debe basarse en calidad medida (B-CLS), no en costo**. A volumen MEDIO (150 comentarios + 300 mensajes del dueño/mes) Jev cuesta **$0.017/cliente/mes**; incluso el escenario extremo (20k eventos) < $1/mes. (typesafe-jev.md §5.2, §6)

### 3.4 Imágenes — costo por imagen generada y entregada

Base: precios por imagen verificados (§1.3). "Entregada ×1.3" = factor de reintento (t_rechazo ≈ 23 % ⇒ k≈1.30; rango 1.15–1.6); "×2.6" = 2 variantes generadas, 1 elegida, con reintento. Fuente: image-providers.md §10 (ESTIMACIÓN con fórmula explícita).

| Modelo | Web 16:9 (1K) generada | Web entregada (×1.3 / ×2.6) | Social 1:1 entregada (×2.6) | Nota de calidad (AA T2I Elo) |
|---|---:|---:|---:|---|
| `gpt-image-2` medium 1536×1024 (+ prompt 150 tok) | $0.0418 (Batch $0.0209) | $0.053 / $0.107 | $0.138 (1024² medium) | #3 (1189, en high) |
| `gpt-image-2` **low** 1536×1024 | $0.0068 (Batch $0.0034) | $0.007 / $0.013 | $0.018 (1024² low) | NO MEDIDO para MainSpot |
| `gemini-nano-banana-2.1` 1K (+ prompt) | $0.0338 | $0.044 / $0.087 | $0.087 | #4 (1176) |
| Seedream 5.0 flash | $0.018 | $0.023 / $0.047 | $0.047 | (5.0 Pro #16; flash sin fila AA) |
| Seedream 5.0 pro (≤2.61 Mpx) | $0.045 | $0.059 / $0.117 | $0.117 | #16 (1101) |
| FLUX 3 Klein 1K | $0.009 | $0.012 / $0.023 | $0.023 | #22 (1043) |
| FLUX 3 Image 1K | $0.048 | $0.062 / $0.125 | $0.125 | #11 (1119) |
| MAI-Image-2.6(-Flash) | DESCONOCIDO (AA ≈$0.039) | ≈$0.051 / ≈$0.101 | ≈$0.101 | #6 (1167) |

Nota de base: la columna "generada" incluye el prompt (~150 tokens); las columnas "entregada" reproducen los factores de image-providers.md §10 sobre el precio base **sin prompt** (el prompt añade <$0.001, que no altera las cifras a 3 decimales del fuente salvo gpt-image-2 low: $0.009/$0.018 con prompt incluido).

Lecturas:
- A calidad comparable media, `gpt-image-2` medium ($0.0418) vs Nano Banana 2.1 ($0.0338): **NB 2.1 ≈ 80 % del costo** y AA #4 vs #3-4; en entregada ×2.6, $0.087 vs $0.107. `gpt-image-2` en `low` es la opción más barata de OpenAI ($0.013 entregada) pero su calidad para piezas de marca es NO MEDIDA.
- **Edición/adaptación** (capacidad ausente del catálogo): `gpt-image-2` ≈$0.089–0.124 por edición (HIPÓTESIS, tokens de entrada no publicados); Nano Banana 2.1 ≈$0.045 entregada; Seedream pro $0.059 (entradas gratis); FLUX 3 Image $0.062. (openai.md §7.1; image-providers.md §10.4)
- **Ninguna imagen fue medida en el lab** (0 llamadas: guardrail OpenRouter) ⇒ costos de reintento, moderación y calidad para los casos MainSpot: NO MEDIDO.
- Presupuesto: maxCost sembrado SOL MAIN para imágenes = **$0.08/llamada** (calidad medium) — cubre gpt-image-2 medium web ($0.0418) y social ($0.0538), pero un `high` web ($0.1658) lo excedería.

---

## 4. Ventajas/desventajas por dimensión

Calidad = benchmarks públicos fechados (text-models-benchmarks.md §2: AA Intelligence v5; LMArena Spanish oficial 2026-10-27; τ² Airline) + evidencia LAB. Todo lo demás de §1–§3.

| Dimensión | Anthropic directo | OpenAI directo | TypeSafe directo | OpenRouter (estudio) |
|---|---|---|---|---|
| Calidad potencial (texto) | Haiku 5.5 índice AA 36 (max) / Spanish Elo 1404; Sonnet 5.5 AA 41–54, Spanish 1448, τ² 78.8 % (el mejor de los candidatos); Opus 5.5 AA 52–58, Spanish 1488 | Luna AA 28 / Spanish **1442** (supera a Haiku); Sol AA 46–55, Spanish 1475; Terra AA 38–51; Terra/Sol en Responses | Jev: especialista; sentimiento 89.5 % (n=20, umbral 85 %), 0 riesgos omitidos; 3 etiquetas reproduciblemente erróneas de 20; español "no equally well" (aviso del proveedor) | Pass-through: misma calidad del modelo elegido; rankings de decisión: TypeSafe 75.1 % del share |
| Costo por tarea (medido) | Haiku: $0.00025–0.0021 por tarea medida; Sonnet 20× Haiku | Luna **0.28–0.71× de Haiku por éxito** en todas las suites donde ambos pasaron; Sol = 20× Luna; Terra = 10× | $0.000034–0.000049/evento; < $1/mes incluso en abuso | Tarifa igual + 5.5–8 %; sin Batch de imagen |
| Latencia | Sonnet low p50 ≈3 s (200 tok); Haiku TTFT AA 9–34 s con thinking, medido en lab 2.1–17 s p50 (coherente con thinking off; NO MEDIDO directo); diseño 17 s p50 | Luna non-reasoning TTFT 0.8 s; p50 medido 2.9–16 s según caso; Sol 5.8–120 s | p50 729–763 ms; p95 866–966 ms (10 s en incidente) | Salto adicional de enrutamiento; cifras públicas DESCONOCIDAS |
| Fiabilidad/uptime | 31 incidentes de API en ~3 meses; Sonnet 5.5 ≈4.3 h afectado en 2 semanas; sin Priority Tier comprable; Batch sin ZDR | APIs 99.97 %, **Images 99.990 %** (3 meses); 503/429 con Retry-After; ramp-rate | 99.858 % (30 d); 5 incidentes/90 d; sin SLA; tope de responsabilidad USD 50 | 100 % en endpoints con dato; sin SLA salvo Enterprise; dependencia adicional |
| Structured outputs | Gramática estricta nativa; **límite duro 16 uniones / 24 opcionales** (rompió `website.edit.*`); sin límite interno publicado → error 400 posible aun cumpliendo límites | `anyOf` sin límite publicado de variantes, pero **raíz no-anyOf**; 5,000 propiedades/10 niveles; esquema viaja como "system data" (residencia) | Tipado nativo garantizado (`choice/noul/score`), sin errores de tipo; 255 opciones; sin caché | Enforcement "varies by provider"; límites del subyacente se mantienen |
| Tools / asistente | Nativo (`tool_choice any/tool`, +286 tok system); Haiku τ² 72.8 % a $0.012/tarea; Sonnet 78.8 % | Tools **solo Responses** en Sol/Terra; Luna Chat Completions solo con effort `none`; τ² Luna 67.3 %, Sol 70.0 % | No aplica (clasificador, no agente) | `tool_choice` forzado no disponible en endpoints Claude |
| Imágenes | **No tiene** (`image()` → `image_not_supported`) | `gpt-image-2`/2.5: edición con 16 refs + máscara, tamaños arbitrarios, ZDR elegible, C2PA+SynthID; verificación de organización; texto en imagen y consistencia = limitaciones declaradas | No | Acceso a Seedream/FLUX/Gemini/MAI sin cuentas nuevas, pero sin Batch y bajo ZDR restringido |
| Privacidad / datos | Sin entrenamiento; 30 días; ZDR por ventas (excluye Batch/Files); DPA automático; 22 subencargados públicos | Sin entrenamiento; 30 días abuso; imágenes ZDR-elegible; DPA ejecutable en línea; subencargados fechados | Sin entrenamiento; retención sin plazo; **ZDR gratis**; DPA sin México; subencargados no visibles | Tercero extra; proveedores como subencargados sin aviso; Safety Retention de Google |
| Riesgo de concentración | Proveedor 1 de 2 generativos; mitigable con Bedrock/Vertex (cuenta alternativa, misma política) | **Single-vendor si DEC-0073 se extendiera a producción**: texto+imágenes+cuota+estado en una organización; 2 outages parciales + 1 total (Codex) en 3 meses | Proveedor pequeño "early access"; concentración de formato propietario; pero degrada a humano/determinista | Elimina concentración de integración pero no de dato; suspensiones unilaterales §9 |
| Facturación MX | USD, prepago o arrears; withholding H.2; México soportado | USD solo; gross-up; Tax ID en consola | Créditos, 402; caducidad 12 meses | USD; 5.5 % comisión; sin IVA MX documentado |

---

## 5. La decisión D12 en abierto (propuesta trazable, sin decidir)

### 5.1 Estado factual

- **DEC-0069** (canon vigente): TypeSafe directo (Jev); **Anthropic directo prioritario** para texto; OpenAI directo `gpt-image-2` para imágenes; OpenRouter fuera de nuevas ejecuciones y sin fallback. (01-inventory.md §8.1)
- **DEC-0073** (commit SOL MAIN `1f1c7da`, 2026-11-03 03:25): OpenAI para **toda la generación de desarrollo**; migración `0029` pone Anthropic `status='disabled'` (adaptador conservado, sin rutas activas/canary ni fallback); texto por Responses `store:false`, imágenes por Images API; candidatas: diseño → Sol (0.25)/Luna (0.05); edición simple → Luna (0.02); edición compleja → Sol (0.2)+Luna (0.05); compose/creatives → Luna (0.03), todo `reasoning_effort medium`, «selección explícita, no fallback». Se declara literalmente «configuración actual de desarrollo, no selección comercial irreversible» y «TypeSafe/Jev conserva clasificación semántica primaria». (01-inventory.md §8.4; openai.md §7.3)

### 5.2 Qué datos apoyan cada polo

| A favor de OpenAI único (DEC-0073) | A favor de Anthropic prioritario (DEC-0069) |
|---|---|
| **Tarifas por token idénticas** Luna=Haiku ($0.10/$0.50) y Sol=Sonnet ($2/$10): la comparación se decide en tokens por tarea, y los medidos favorecen a Luna (1.4–3× menos entrada) — aunque la causa probable (traducción de esquema de OpenRouter + tokenizador) es HIPÓTESIS y la vía directa Anthropic es NO MEDIDA | La calidad medida de Haiku no fue inferior donde compitió (9/9 diseño, 3/3 asistente, replies, insights); Luna ganó en ediciones/calendario/plan. Sonnet 5.5 tiene el mejor τ² (78.8 %) para tools y reseñas de riesgo |
| **Structured outputs sin límite publicado de `anyOf`** resuelve operativamente el bloqueo de 17 uniones que Anthropic tiene documentado (16) — el esquema raíz de MainSpot debe verificarse (raíz no-anyOf), NO MEDIDO | El esquema de 17 uniones es reparable **por diseño** (dividir por tipo de operación / sustituir uniones por enum+required) sin cambiar de proveedor (HIPÓTESIS, antropología del límite documentada; no medido) |
| **Terra ($1/$5)**: escalón intermedio que Anthropic no tiene; útil si el nivel barato falla calidad y el superior sobra | Escala de precio más simple; Haiku acepta `thinking: disabled` (menor costo/latencia en tareas simples); Sol no admite `none` |
| **Una sola integración** (Responses `store:false`) para texto e imágenes; un solo DPA/contrato; Images 99.990 % | Diversificación: Anthropic + OpenAI reparten riesgo de outage/cuota; el incidente de Sonnet 5.5 no habría detenido a Luna, y viceversa |
| Cobertura total del catálogo generativo con candidatas ya sembradas | DEC-0069 sigue vigente en canon; DEC-0073 se autodeclara reversible; producción **no está decidida** |

### 5.3 Implicaciones de estandarizar en OpenAI (si producción heredara DEC-0073) — ESTIMACIÓN/HIPÓTESIS

1. **Riesgo esquema raíz-`anyOf` NO MEDIDO**: si `EDIT_SCHEMA` es una unión discriminada en la raíz, OpenAI también la rechazaría (requiere envolver en objeto `{kind, patch}`); verificación de < $0.001 con Luna.
2. **Single-vendor**: outage/cuota/verificación de organización y cambios de precio (14 días de aviso) afectan todo el producto a la vez; el ecosistema OpenAI tuvo 1 outage total (Codex) y 2 parciales (APIs) en 3 meses. Mitigación ya presente: adaptador Anthropic conservado sin fallback automático; reactivarlo = decisión nueva.
3. **Razonamiento obligatorio en Sol**: candidatas DEC-0073 con `medium` ⇒ el costo por tarea de diseño/edición compleja puede multiplicarse frente a la cota de §3.2 (+$0.005 por 500 tokens de razonamiento); NO MEDIDO.
4. **Efecto contable**: todo costo será `estimated` (los adaptadores directos reportan `costUsd: null`); depende de mantener `ai_model.pricing` al día (debilidad ya detectada en el catálogo: precios Standard sin Batch, sin 2.5, sin gpt-image-1-mini deprecado).
5. **Privacidad simplificada**: un DPA, `store:false` + imágenes ZDR-elegibles; vs escenario Anthropic+OpenAI con dos DPAs que reconciliar.

### 5.4 Ensayos (A/B con canary) que decidirían — propuestas, NO ejecutadas

| Ensayo | Diseño | Criterio de decisión | Costo estimado |
|---|---|---|---|
| **B-TXT (texto directo)** | Mismas entradas sintéticas del lab × {Luna, Sol, Haiku, Sonnet} × effort {none/low, medium} contra los adaptadores directos; medir tokens, reparaciones, p50/p95, costo por éxito | Costo por éxito y tasa de reparación por caso; separar el efecto "traducción de OpenRouter" del tokenizador | <$1 (DEC-0068); requiere Anthropic reactivado para eval (decisión) |
| **Esquema 17 uniones** | 1 petición por modelo con `text.format`/`output_config` y el esquema real (y su variante raíz-objeto) | 400 vs 200 por proveedor; si Anthropic falla, validar las 3 mitigaciones documentadas | <$0.01 |
| **B-CLS (clasificación)** | 200 casos etiquetados × {jev-1.14.0, Luna structured, Luna Decisions, Haiku si se reactiva} (typesafe-jev.md §6.1) | F1 por clase, risk_misses=0, calibración (ECE), p95, costo por caso correcto | ≈$0.16 |
| **Imágenes** | Por subcaso (web/social/texto español/edición): gpt-image-2 low/medium/high vs Nano Banana 2.1 vs Seedream vs Klein; rúbrica tipográfica en español y fidelidad de logo | Tasa de rechazo, costo por imagen entregada, calidad tipográfica | <$2 (estimación interna; dentro de DEC-0068) |
| **Canary por caso** | El mecanismo ya existe (`registry.resolve` canary por hash de `useCase:key`); proponer rutas canary Luna↔Haiku y Sol↔Sonnet por caso con umbral de pass_rate/latencia/costo | Decisión de producción por caso, no global | Solo gasto de canary |

Marco de decisión: la selección de producción corresponde al propietario; DEC-0069 y DEC-0073 conviven (desarrollo ≠ producción) hasta que una nueva decisión las reconcilie.

---

## 6. Imágenes — comparativa corta

Detalle completo: `evidence/image-providers.md` (precios, capacidades, rankings AA/LMArena, términos por proveedor, propuesta §11). Resumen cruzado:

| Criterio | gpt-image-2 / 2.5 (OpenAI) | Nano Banana 2.1 (Google) | Seedream 5.0 (BytePlus) | FLUX 3 / Klein (BFL) |
|---|---|---|---|---|
| Precio por imagen entregada web (base ×1.3) | $0.053 medium / $0.007 low / $0.215 high | **$0.044** (1K) | **$0.023 flash** / $0.059 pro | **$0.012 Klein** / $0.062 FLUX 3 |
| Edición/adaptación | Hasta 16 refs + máscara; input_fidelity alto forzado | 14 refs, conversacional | Edición interactiva (bbox/punto), capas — ideal re-encuadre | 1–10 refs, bounding boxes quirúrgicos |
| Texto español en imagen | Limitación declarada | Buena ("accurate text") | **Nativo en español** (+13 idiomas) | Con comillas exactas en prompt |
| Calidad AA T2I | #1–4 (2.5 max / gpt-image-2 high) | #4 (1176) | #16 pro (1101) | #11 / #22 |
| Términos/licencia | SA+DPA; C2PA+SynthID; ZDR elegible; sin entrenamiento | DPA Google (pagado); SynthID obligatorio; **términos BytePlus no leídos** (Seedream) | **Verificación pendiente (bloqueante DEC-0067)** | **Licencia perpetua e irrevocable para entrenar con Entradas y Salidas (§2b)** — excluye datos reales de clientes |
| Estado cuenta | Verificación de organización requerida | Proyecto con billing (nunca cuota gratuita con datos) | Cuenta nueva + región única `ap-southeast-1` | Cuenta nueva; créditos no reembolsables |

Nota sobre la trampa BFL: la licencia de entrenamiento de FLUX API Service Terms (2026-08-04) cubre **inputs y outputs** del desarrollador; para fotos/productos de clientes es incompatible con DEC-0067 sin decisión explícita — propuesto en image-providers.md §11.5 excluir BFL de datos reales.

---

## 7. Lo que queda DESCONOCIDO / NO MEDIDO y qué decisión de propietario lo cierra

| # | Hueco | Estado | Decisión/acción del propietario que lo cierra |
|---|---|---|---|
| H1 | Tokens y calidad con **Anthropic/OpenAI directos** (sin capa OpenRouter), incl. el efecto del tokenizador +30 % de Claude y del thinking facturado | NO MEDIDO (Anthropic deshabilitado en dev; OpenAI directo sin trazas aún en esta base) | Autorizar el benchmark B-TXT ( <$1) y, para Anthropic, reactivación temporal de evaluación (modifica DEC-0073 en su ámbito de dev) |
| H2 | **Esquema raíz-`anyOf` de 17 uniones en OpenAI** (Structured Outputs) | NO MEDIDO (verificación <$0.001) | Ninguna económica; autorizar la prueba de esquema o integrarla al B-TXT |
| H3 | Costo por imagen de `gpt-image-2.5-*` y de gpt-image-2 en 2K/4K; tokens de **entrada** de edición de gpt-image-2 | DESCONOCIDO (calculadora JS / uso real) | Autorizar 1–3 llamadas de medición (≈$0.10–0.30) o leer la calculadora con navegador |
| H4 | Calidad tipográfica en español / fidelidad de logo / tasa de rechazo de imagen por proveedor | NO MEDIDO (0 llamadas de imagen en el lab) | Autorizar el benchmark de imágenes (§5.4); decidir si se abre cuenta Gemini pagada (DEC nueva) |
| H5 | Jev vs generativo para clasificación (Decisions API incluida) en español | NO MEDIDO | Autorizar B-CLS (≈$0.16); decidir el clasificador de producción (DEC-0066 vigente) |
| H6 | Verificación única de términos DEC-0067/0071: si la lectura documental de un agente satisface la condición o requiere acto del propietario (aceptación de DPA en consola); ZDR activado en TypeSafe; lista de subencargados de TypeSafe; tratamiento de IVA/retención ISR en facturas reales | DESCONOCIDO | D10 del inventario: definir quién da por válida la verificación; solicitar ZDR; consulta fiscal |
| H7 | Elección de producción por caso (texto barato vs medio vs superior; Anthropic vs OpenAI vs mixto; imágenes) | Abierta (D12) | Decisión del propietario tras B-TXT/B-CLS/benchmark de imágenes; el entregable 05 formulará la propuesta |
| H8 | Presupuesto productivo de Jev (DEC-0032 es global y de desarrollo) y tope por negocio/día | Pendiente de decisión | Nueva decisión de presupuesto para runtime |
| H9 | SLA contractual en cualquier proveedor self-service | No existe en ninguno (solo Enterprise) | Si el producto lo exige: negociación comercial (Anthropic ventas / OpenAI Scale / OpenRouter Enterprise) |
| H10 | Uptime 90 días oficial de Anthropic; latencia p50/p95 por proveedor directo | DESCONOCIDO / NO MEDIDO | Render con navegador o derivación de la API de Statuspage; benchmark de latencia con B-TXT |

---

## Fuentes

Archivos de evidencia del mismo directorio (todos auditados y fechados 2026-11-03; las URLs primarias están listadas dentro de cada archivo):

1. `evidence/anthropic.md` — precios/límites/structured outputs/privacidad de Anthropic directo (§1–§7), 31 incidentes de Claude API (§6.2), Bedrock/Vertex (§5).
2. `evidence/openai.md` — gpt-image-2/2.5, GPT-6 Luna/Terra/Sol, tiers, datos/ZDR, Decisions API (§1–§8), implicación DEC-0073 (§7.3).
3. `evidence/typesafe-jev.md` — Jev 1.14.0, precio/límites/MCA/DPA/estado, comparación vs generativo y Decisions API (§3, §5, §6).
4. `evidence/openrouter.md` — modelo de cobro, precios cruzados sin discrepancia, ZDR/guardrails, DPA, evidencia histórica del lab (§1–§6).
5. `evidence/image-providers.md` — Nano Banana 2.1/Pro, FLUX/BFL (licencia perpetua §3.3), Seedream/BytePlus, MAI/Azure, Ideogram, Recraft, rankings AA/LMArena, costo por imagen entregada (§10) y propuesta (§11).
6. `evidence/text-models-benchmarks.md` — AA Intelligence v5, LMArena Spanish oficial, τ² Airline, límites de esquema por proveedor, latencias y advertencias de comparabilidad (§1–§6).
7. `evidence/lab-traces.md` — tokens medidos por caso de uso × modelo, tasas de reparación, costos por éxito, precio aplicado = catálogo (hallazgos 1–7).
8. `evidence/lab-history.md` — contexto de corridas run1–run3, taxonomía de fallos, límites estadísticos (§1–§7).
9. `evidence/business-inputs.md` — FIX Banxico 18.7962, IVA/importación de servicios, comisiones PSP MX (§1–§3).
10. `01-inventory.md` — snapshot del repo, DEC-0066..0073, migración 0029, discrepancias D1–D12 (§8, §9).

URLs clave (primarias, todas consultadas 2026-11-03; detalle completo en cada archivo): platform.claude.com/docs/en/about-claude/pricing · developers.openai.com/api/docs/pricing · developers.openai.com/api/docs/guides/structured-outputs · developers.openai.com/api/docs/guides/your-data · docs.typesafe.ai/models · typesafe.ai/legal/mca · aistudio.google.com/docs/pricing · ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing.md · bfl.ai/legal/flux-api-service-terms · openrouter.ai/pricing · artificialanalysis.ai/leaderboards/models · arena.ai/leaderboard/chat/text/spanish · banxico.org.mx (FIX).

## Huecos

| Id | Hueco | Cómo cerrarlo |
|---|---|---|
| C1 | Toda celda "directa" de texto de §3.2 con tokens vía OpenRouter (sesgo alcista en Haiku/Sonnet; posible deriva en Luna directo) | B-TXT contra adaptadores directos (H1) |
| C2 | Efecto de razonamiento en Sol (`medium`, sin `none`) sobre el costo por tarea | Sensibilidad declarada; medir `output_tokens_details.reasoning_tokens` en B-TXT |
| C3 | Costos de imagen con reintentos/moderación reales para los casos MainSpot | Benchmark de imágenes (H4); entretanto usar k=1.15–1.6 de sensibilidad |
| C4 | Discrepancias menores entre costo medido y costo recalculado (≤10 %) por promediado de tokens vs costos por invocación | No afecta órdenes de magnitud; si se necesita exactitud, exportar por invocación (lab-traces ya lo hizo a nivel agregado) |
| C5 | Batch −50 % no modelado en el catálogo SOL MAIN (precios Standard sembrados) | Insumo para 04-unit-economics: modelar Batch para lo diferible (calendario, insights, informes) |
| C6 | Precios con fecha de caducidad: Argon ×2 desde 2026-12-01, Flash ×2 desde 2027-01-01, gpt-image-1-mini/1.5 apagados 2026-12-01, cambios de precio OpenAI con 14 días de aviso | Reverificación mensual de las páginas de pricing en cada corte del informe |
| C7 | Impuestos MX sobre facturas de Anthropic/OpenAI/TypeSafe (IVA autoliquidado vs cargado, CFDI, ISR) | Consulta al contador + revisión de una factura real de cada cuenta (H6) |
| C8 | `inference_geo: us` / residencia regional OpenAI: costo +10 % sin beneficio regulatorio mexicano documentado | Decisión de política (¿vale +10 %?); sin medida pendiente |

*Fin del entregable 02. Síntesis nueva de este documento: tablas §1–§6 y lecturas marcadas ESTIMACIÓN/HIPÓTESIS; el resto transcribe con referencia a los archivos de evidencia.*
