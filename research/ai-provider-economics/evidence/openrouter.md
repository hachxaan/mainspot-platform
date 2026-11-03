# OpenRouter — estudio en papel (precios, políticas de datos, pros/contras)

Fecha de consulta de todas las fuentes: **2026-11-03**. Moneda: USD. Estudio EN PAPEL: no se hizo ninguna llamada
autenticada ni pagada a OpenRouter; solo lectura de páginas públicas y de endpoints públicos sin clave
(`/api/v1/models`, `/api/v1/models/{id}/endpoints`, `/api/v1/endpoints/zdr`, `/api/v1/images/models/{id}/endpoints`).
La evidencia histórica del repositorio proviene de `evidence/ai-core/lab-e2e.txt` y
`docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-RESULTS.md` (solo lectura).

Política vigente que este documento **no cambia**: DEC-0069 (2026-11-03) excluye OpenRouter de nuevas ejecuciones y
sin fallback; DEC-0071/DEC-0067 condicionan datos reales a Anthropic/OpenAI directo; DEC-0068 fija techo de laboratorio
USD 25; DEC-0073 (commit SOL MAIN `1f1c7da`, 2026-11-03) fija OpenAI directo para toda la generación de desarrollo y
deshabilita Anthropic (migration 0029) — no toca OpenRouter, que sigue excluido de ejecuciones del producto. Reactivar
OpenRouter sería una decisión nueva del propietario (propuesta trazable, no acción).

**Auditoría 2026-11-03 (esta corrida)**: se re-verificaron en página oficial `faq.md`, `pricing.md`, `guardrails.md`,
`zdr.md` y dos endpoints públicos (`…/claude-sonnet-5.5/endpoints`, `…/images/models/openai/gpt-image-2/endpoints`);
se cruzó cada precio contra `anthropic.md`, `openai.md` e `image-providers.md` (sin discrepancias de tarifa de lista);
los SNIPPET de Seedream, FLUX Klein y costo-por-imagen de gpt-image-2 quedaron cerrados vía `image-providers.md`/`openai.md`.

Etiquetas: **HECHO VERIFICADO** (leído con `read` en la URL oficial o en el endpoint público), **SNIPPET** (visto solo en
resultado de búsqueda), **ESTIMACIÓN** (cálculo propio, fórmula mostrada), **HIPÓTESIS**, **DESCONOCIDO**.

---

## 1. Modelo de cobro

| Concepto | Valor | Unidad / condición | Etiqueta | Fuente |
|---|---|---|---|---|
| Precio de inferencia | Pass-through del precio de lista del proveedor, sin markup, en todos los planes | USD por token / imagen / request según el modelo | HECHO VERIFICADO | [1], [2] |
| Comisión de plataforma, plan Standard (pay-as-you-go) | **5.5 %** sobre la compra de créditos (no sobre cada request) | % del importe comprado | HECHO VERIFICADO | [2] |
| Comisión de plataforma, plan Business (pay-as-you-go, autoservicio, sin contrato) | **8 %** sobre la compra de créditos | % del importe comprado | HECHO VERIFICADO | [2] |
| Comisión Enterprise | «Fee discounts available»; precio por contrato (volumen, créditos prepagados, compromiso anual), facturación | contrato | HECHO VERIFICADO | [2] |
| Comisión en pago con criptomoneda (USDC vía Coinbase) | El FAQ confirma que existe («Crypto payments are charged a fee of {getTotalFeeString('coinbase', null)}») pero el valor sigue como plantilla sin renderizar en faq.md (re-verificado 2026-11-03; el fee de tarjeta es el template hermano `getTotalFeeString('stripe')` — el 5.5 %/8 % real viene de pricing.md) | — | DESCONOCIDO | [1] |
| Mínimo / máximo por transacción de créditos | **USD 5** mínimo, **USD 25,000** máximo por transacción | USD | HECHO VERIFICADO | [3] §4.1 |
| Caducidad de créditos | OpenRouter se reserva el derecho a expirar créditos no usados **365 días** después de la compra | días | HECHO VERIFICADO | [3] §4.2, [1] |
| Reembolso | Solo créditos no usados y solo dentro de **24 h** de la compra; la comisión de plataforma **no** se reembolsa; pagos cripto nunca reembolsables; al cerrar cuenta (sin incumplimiento) se devuelve el saldo en 30 días | — | HECHO VERIFICADO | [3] §4.1, §9 |
| Impuestos | Precios sin impuestos; «VAT/GST may be added on invoices» donde aplique. No hay mención de IVA mexicano ni CFDI | — | HECHO VERIFICADO (lo general) / DESCONOCIDO (México) | [2] |
| Medios de pago | Tarjeta de crédito/débito, AliPay, cripto (USDC); Enterprise: factura y órdenes de compra | — | HECHO VERIFICADO | [2], [1] |
| Auto top-up | Recarga automática por umbral, cancelable | — | HECHO VERIFICADO | [3] §4.2 |
| BYOK (clave propia del proveedor) | El proveedor factura la inferencia directo; Standard y Business incluyen **USD 25,000/mes de inferencia a precio de lista sin comisión**; por encima, **5 %** de lo que costaría en OpenRouter, descontado de créditos | USD de lista / mes | HECHO VERIFICADO | [2], [1] |
| Intentos fallidos / fallback | No se cobran los tokens del intento que da error; con «Zero Completion Insurance» tampoco una respuesta vacía sin finish reason; servicios auxiliares ya ejecutados (web search, parsing) sí pueden cobrarse | — | HECHO VERIFICADO | [2] |
| Descuento por volumen | No hay descuento de inferencia; solo descuento de comisión en Enterprise | — | HECHO VERIFICADO | [2], [1] |
| Descuento por ceder prompts | 1 % en uso si se **opta** por permitir que OpenRouter use prompts/completions para mejorar el producto (off por defecto) | % | HECHO VERIFICADO | [1], [9] |
| Rate limits en modelos de pago | Sin límite por plan; pass-through del proveedor; solo protección DDoS propia (429) | — | HECHO VERIFICADO | [2] |
| Workspaces | 5 en Free/Standard, 1,000 en Business; presupuesto por clave de API | — | HECHO VERIFICADO | [2] |
| SLA contractual | Solo Enterprise («Contractual SLAs»); Standard/Business: «as is / as available», sin garantía de disponibilidad de modelos | — | HECHO VERIFICADO | [2], [3] §5.4, §16 |
| Límite de responsabilidad | Mayor de: lo pagado en 12 meses o USD 100 | — | HECHO VERIFICADO | [3] §17 |
| Jurisdicción / arbitraje | Ley de Nueva York; arbitraje vinculante, sin acción colectiva | — | HECHO VERIFICADO | [3] §18–19 |

**ESTIMACIÓN del sobrecosto efectivo.** Si todos los créditos comprados se consumen, el sobrecosto sobre inferencia es
`fee = gasto_inferencia × 0.055` (Standard) o `× 0.08` (Business). Con BYOK y gasto de lista < USD 25,000/mes el
sobrecosto es `0` (la factura queda en el proveedor directo y OpenRouter actúa solo como enrutador). Sobre el
acumulado del laboratorio (USD 0.096726) la comisión Standard habría sido `0.096726 × 0.055 = USD 0.00532`; sobre un
recorrido E2E completo (USD 0.008954) `= USD 0.00049`.

| Gasto mensual de IA (hipotético) | Sobrecosto Standard 5.5 % | Sobrecosto Business 8 % | Sobrecosto BYOK (< USD 25k/mes) |
|---|---|---|---|
| USD 50 | USD 2.75 | USD 4.00 | USD 0 |
| USD 500 | USD 27.50 | USD 40.00 | USD 0 |
| USD 5,000 | USD 275.00 | USD 400.00 | USD 0 |

Nota: con BYOK el dato de negocio sigue pasando por OpenRouter como encargado (ver §3), de modo que el ahorro de
comisión no elimina el tercero en la cadena de datos.

---

## 2. Precio por modelo: OpenRouter vs directo

Todos los precios de OpenRouter se leyeron del endpoint público `GET /api/v1/models?output_modalities=all` y de
`GET /api/v1/models/{id}/endpoints` el 2026-11-03 (HECHO VERIFICADO). Las cifras del campo `pricing` vienen en USD por
token; aquí se expresan por millón de tokens (×10⁶). Los precios directos se leyeron en las páginas oficiales indicadas;
los peers `anthropic.md` y `openai.md` deben prevalecer para detalle de cada proveedor. **Auditoría 2026-11-03**: cada
fila se cruzó contra `anthropic.md` §2.1/§2.9/§2.10, `openai.md` §1.3/§1.4/§3.2 e `image-providers.md`
§2.1/§3.1/§4.1/§5.3 — **sin discrepancia de tarifa de lista en ningún modelo**; el recargo regional +10 % coincide con
lo documentado por ambos proveedores directos.

### 2.1 Modelos de texto

| Modelo (slug OpenRouter) | OpenRouter: input / output (USD/M tok) | Caché lectura / escritura 5m / 1h (USD/M) | Directo oficial: input / output | Sobrecosto de lista | Etiqueta del directo | Observaciones |
|---|---|---|---|---|---|---|
| `anthropic/claude-haiku-5.5` (ctx 1,000,000; máx. salida 128,000) | **0.10 / 0.50** (≤100k tokens de prompt); 0.50 / 2.50 (>100k, `overrides.min_prompt_tokens=100000`) | 0.01 / 0.125 / 0.20 | 0.10 / 0.50 (≤100k); 0.50 / 2.50 (>100k) [5] | **0 %** | HECHO VERIFICADO | Endpoints regionales (Vertex us/europe, Bedrock us-east-1/eu-west-1, Azure/us) a 0.11 / 0.55 (+10 %), coherente con el recargo regional que Anthropic documenta [5]. `:batch` en OpenRouter 0.05 / 0.25 (= batch directo) |
| `anthropic/claude-sonnet-5.5` (ctx 1,000,000) | **2.00 / 10.00** | 0.10 / 2.50 / 4.00 | 2.00 / 10.00; caché hit 0.10 [5] | **0 %** | HECHO VERIFICADO | Regionales 2.20 / 11.00. `:batch` 1.00 / 5.00 |
| `anthropic/claude-opus-5.5` (ctx 1,000,000) | **4.00 / 20.00** | 0.20 / 5.00 / 8.00 | 4.00 / 20.00; fast mode 8 / 40 [5] | **0 %** | HECHO VERIFICADO | Endpoint `anthropic/fast` en OpenRouter 8.00 / 40.00 (= fast mode directo). `:batch` 2.00 / 10.00 |
| `openai/gpt-6-luna` (ctx 1,050,000) | **0.10 / 0.50** (≤272k); 0.20 / 0.75 (>272k) | 0.01 / 0.125 / — | 0.10 / 0.50 (short ≤272K); 0.20 / 0.75 (long) [6] | **0 %** | HECHO VERIFICADO | Endpoints `openai/flex` 0.05 / 0.25 y `openai/fast` 0.20 / 1.00 (= Flex y Fast directos). Azure/us, Azure/eu, Bedrock us-east-1 a 0.11 / 0.55. `:batch` 0.05 / 0.25 |
| `openai/gpt-6.1-sol` (ctx 1,050,000) | **2.00 / 10.00** (≤272k); 4.00 / 15.00 (>272k) | 0.10 / 2.50 / — | 2.00 / 10.00; long 4.00 / 15.00 [6] | **0 %** | HECHO VERIFICADO | `openai/flex` 1 / 5; `openai/fast` 4 / 20; `openai/ultrafast` 12 / 60 (= directo). `:batch` 1 / 5 |
| `google/gemini-4-argon` (ctx 1,048,576) | **2.00 / 10.00**; razonamiento interno 10.00; imagen/audio de entrada 2.00; caché 0.10 | 0.10 / 0.1875 / — | **2.00 / 10.00 hasta 2026-11-30; 4.00 / 20.00 desde 2026-12-01** [7] | 0 % hoy; el precio directo **se duplica el 1-dic-2026** y OpenRouter cobrará la nueva tarifa (política de cambio de precio [2]) | HECHO VERIFICADO | Vertex `priority` 3.60 / 18.00 = Priority directo. `google-ai-studio/flex` 1 / 5 = Flex directo. `:batch` 1 / 5 |
| `deepseek/deepseek-v4.1-flash` (slug genérico, versión 20260910; ctx 1,048,576) | Modelo: **0.045 / 0.50** (endpoint más barato); 32 proveedores terceros, de 0.035 / 0.315 (`morph/fp8`) a 0.45 / 1.80 (`fireworks/us`); cuantizaciones fp8 / fp4 / mxfp4 / desconocida | depende del endpoint (p. ej. 0.006 lectura) | DeepSeek directo (`deepseek-flash` = V4.1-Flash-1017): **0.30 / 1.20 en pico; 0.15 / 0.60 fuera de pico** (pico 01–04 y 06–10 UTC L–V) [8] | Negativo: terceros en OpenRouter cotizan **por debajo** del directo, pero con modelo/cuantización/host distintos | HECHO VERIFICADO | Existe `deepseek/deepseek-v4.1-flash-1017` con endpoint de primera parte `deepseek` que replica el horario pico/valle de DeepSeek (0.15 / 0.60 y 0.30 / 1.20). Comparación «misma cosa»: solo con ese endpoint. `:batch` 0.05 / 0.15 |

### 2.2 Modelos de imagen

Precio por imagen leído de `GET /api/v1/images/models/{id}/endpoints` (líneas `billable/unit/cost_usd`).

| Modelo (slug OpenRouter) | OpenRouter: unidad y precio | Precio por imagen 1K | Directo oficial | Sobrecosto de lista | Etiqueta del directo | Edición (imagen de referencia) |
|---|---|---|---|---|---|---|
| `openai/gpt-image-2` (solo endpoint OpenAI; re-verificado 2026-11-03 en `/api/v1/images/models/openai/gpt-image-2/endpoints`: endpoint único, 8/5/30 por M tok, `input_references` 0–16, `n` 1–10) | por token: imagen de entrada 8.00/M, texto de entrada 5.00/M, **imagen de salida 30.00/M**; caché 2.00/M | Tabla oficial por imagen (openai.md §1.4): 1024² low **0.006** / medium **0.053** / high **0.211**; 1536×1024: 0.005 / 0.041 / 0.165. El ejemplo de OpenRouter (1536×864 `high` = USD 0.13 [10]) usa una resolución con menos píxeles — coherente, **no** es discrepancia | Imagen entrada 8.00/M, salida 30.00/M, texto 5.00/M, caché 2.00/M; Batch 4 / 15 / 2.50 [6] | **0 %** (sin `:batch` en OpenRouter → el 50 % de Batch directo no está disponible vía OpenRouter) | HECHO VERIFICADO | `quality` auto/low/medium/high; passthrough `moderation` |
| `google/gemini-3.1-flash-lite-image` (Nano Banana 2 Lite) | prompt 0.25/M, texto salida 1.50/M, **imagen salida 30.00/M tokens** | **USD 0.0336** (1,120 tokens × 30/M) | 0.25 / 1.50 / 30.00; «equivalent to $0.0336 per 1K image»; Batch 15.00/M → 0.0168 [7] | **0 %** (sin batch vía OpenRouter) | HECHO VERIFICADO | `input_references` 0–14; solo `1K`; `n`=1 |
| `microsoft/mai-image-2.6-flash` (solo endpoint Azure) | texto entrada 1.75/M, imagen entrada 2.50/M, **imagen salida 19.00/M tokens** | ESTIMACIÓN: tokens por imagen no publicados en OpenRouter; si fueran 1,024 → `1024 × 19/M = USD 0.0195` | **Precio directo oficial: DESCONOCIDO** (image-providers.md §5.3: la página de precios de Azure AI Foundry renderiza por JS y no expone montos; MAI-Image-2.6-Flash es **Preview**, sin SLA). Referencia secundaria AA: $19.5/1k imgs, consistente con 19.00/M ≈ $0.0195/imagen (no es fuente oficial). Ojo: MAI-Image-2 (GA, otro modelo) cuesta $5 texto / $33 imagen salida por M tok | **No cuantificable contra fuente oficial** | SNIPPET (agregador litellm) + cruce con image-providers.md §5.3 | `input_references` 0–5; `n`=1 |
| `bytedance-seed/seedream-5-0-flash` (endpoint Seed) | **USD 0.018 por imagen** de salida; imagen de entrada 0 | USD 0.018 (1K y 2K mismo precio) | USD 0.018 por imagen generada con éxito; entradas gratis (BytePlus ModelArk) | 0 % | **HECHO VERIFICADO vía image-providers.md §4.1** (precio oficial BytePlus leído 2026-11-03: `dola-seedream-5-0-flash-260915` = $0.018 única tarifa de salida, entradas gratis, imágenes bloqueadas por moderación no se cobran) | `input_references` 0–14; `1K`/`2K`; `seed` |
| `black-forest-labs/flux-3-image-klein` (endpoint BFL) | por imagen según resolución: **768: 0.008; 1K: 0.009; 1.5K: 0.011; 2K: 0.014; 4K: 0.036** | USD 0.009 | «Pricing starts at $0.009 per 1K image» [12]; **los cinco tiers coinciden con la tabla oficial verificada en image-providers.md §3.1** (bfl.ai: 768sq $0.008 · 1K $0.009 · 1.5K $0.011 · 2K $0.014 · 4K $0.036) | 0 % | HECHO VERIFICADO (todos los tiers, vía image-providers.md §3.1) | `input_references` 0–10; `jpeg`/`png`; `seed`; passthrough `safety_tolerance`, `steps` |

Conclusión de precio (auditoría 2026-11-03): en **ninguno** de los diez modelos comparados hay discrepancia entre la
tarifa de lista de OpenRouter y el directo verificado (HECHO VERIFICADO en Anthropic, OpenAI, Google, BFL/FLUX y
BytePlus/Seedream vía `anthropic.md`, `openai.md` e `image-providers.md`). El único caso sin precio directo oficial es
MAI-Image-2.6-Flash (Azure no publica el monto; la tarifa de OpenRouter es consistente con la referencia secundaria de
AA, pero no contrastable). El sobrecosto efectivo se reduce a la comisión de compra de créditos (§1) y a la pérdida de
los descuentos Batch de imagen (no existe `:batch` para modelos de imagen en OpenRouter; el Batch directo −50 % está
verificado en openai.md §1.3 e image-providers.md §2.1).

### 2.3 Proveedores subyacentes, ZDR y disponibilidad publicada (2026-11-03)

Fuente: `GET /api/v1/models/{id}/endpoints` (lista de endpoints, `uptime_last_1d`) y `GET /api/v1/endpoints/zdr`
(elegibilidad ZDR, campo `safety_retention`). Los campos `latency_last_30m` y `throughput_last_30m` devolvieron `null`
sin autenticación y la página web del modelo redirige a `llms.txt` sin esas cifras → **latencia/throughput publicados:
DESCONOCIDO** por vía pública. La latencia medida en el laboratorio (§5) es la única cifra disponible.

| Modelo | Endpoints (proveedor subyacente) | Endpoints elegibles ZDR (`safety_retention`) | **No** elegibles ZDR | `uptime_last_1d` observado |
|---|---|---|---|---|
| claude-haiku-5.5 | 10: Anthropic (1ª parte), Claude Platform on AWS, Google Vertex (global/us/europe), Amazon Bedrock (global/us-east-1/eu-west-1), Azure (global/us) | Vertex global/us/europe, Bedrock global/us-east-1/eu-west-1 (todos `false`) | **Anthropic 1ª parte**, Claude-on-AWS, Azure | 100 % en todos los endpoints con dato |
| claude-sonnet-5.5 | 10 (mismos proveedores) | Vertex ×3, Bedrock ×3 | **Anthropic 1ª parte**, Claude-on-AWS, Azure | 100 % salvo Bedrock global 99.93 % |
| claude-opus-5.5 | 11 (incluye `anthropic/fast`) | Vertex ×3, Bedrock ×3 | **Anthropic 1ª parte** (std y fast), Claude-on-AWS, Azure | 100 % salvo Azure/global 99.78 % |
| gpt-6-luna | 8: OpenAI (std/flex/fast), Azure (global/us/eu), Bedrock (global/us-east-1) | Azure global/us/eu | **OpenAI 1ª parte** (std/flex/fast), Bedrock | OpenAI 100 %; **OpenAI flex 67.85 %**; Bedrock global 99.61 % |
| gpt-6.1-sol | 9: OpenAI (std/flex/fast/ultrafast), Azure ×3, Bedrock ×2 | Azure global/us/eu | OpenAI 1ª parte, Bedrock | OpenAI 100 %; flex 99.03 %; Bedrock global 99.84 % |
| **gpt-image-2** | **1: OpenAI** | **ninguno** | OpenAI | 100 % |
| gemini-4-argon | 6: Google AI Studio (std/flex/priority), Vertex (global/us/global-priority) | Vertex global/us/global-priority **solo con `safety_retention=true`** (requiere «Allow Safety Retention») | AI Studio (std/flex/priority) | Vertex global/priority 100 %; Vertex global 98.19 %; Vertex us 96.93 %; AI Studio std **84.31 %**; AI Studio priority 92.31 % |
| deepseek-v4.1-flash (genérico) | 41 endpoints de 32 hosts terceros (DeepInfra, Fireworks, Together, Nebius, Google Vertex, Baseten, Alibaba, Baidu, …) | 36 endpoints de terceros (Vertex con `safety_retention=true`) | Novita, GMICloud, Alibaba, etc. | 97.0–100 % |
| deepseek-v4.1-flash-1017 | 45 endpoints incl. **DeepSeek 1ª parte** | 37 de terceros | **DeepSeek 1ª parte no es ZDR** | — |
| gemini-3.1-flash-lite-image | 2: Vertex global, AI Studio | Vertex global (`safety_retention=true`) | AI Studio | Vertex 100 %; AI Studio 97.06 % |
| mai-image-2.6-flash | 1: Azure | Azure (`false`) | — | 100 % |
| seedream-5-0-flash | 1: Seed | Seed (`false`) | — | 100 % |
| flux-3-image-klein | 1: Black Forest Labs | **ninguno** | BFL | 98.77 % |

Catálogo global el 2026-11-03: 685 modelos; 63 con salida de imagen, de los cuales **17** tienen al menos un endpoint
ZDR (Seedream 4.5/5.0 flash/lite/pro, Gemini 2.5/3/3.1 image, Krea, MAI-Image 2.5/2.6, Tencent HY-Image). Ninguno de
los `openai/gpt-image-*` es ZDR en OpenRouter (HECHO VERIFICADO).

Diferencia de capacidades que importa a MainSpot (HECHO VERIFICADO en el campo `supports_tool_choice` de los endpoints):
todos los endpoints de Claude 5.5 en OpenRouter reportan `required: false, function: false` (solo `none`/`auto`),
mientras que la API directa de Anthropic documenta `tool_choice: any`/`tool` (con su sobrecoste de tokens de sistema)
[5]. Para `conversation.owner.assistant` (tools de solo lectura) esto significa que **forzar una herramienta concreta no
está disponible vía OpenRouter** para Claude. Los endpoints OpenAI, Gemini y la mayoría de DeepSeek sí reportan
`required/function: true`.

Interacción `require_parameters: true` (que el conector del repo envía) + `structured_outputs`: para Haiku 5.5 solo
los endpoints Google Vertex, Azure y Anthropic 1ª parte anuncian `structured_outputs`; Bedrock y Claude-on-AWS no. Si
además la cuenta impone ZDR para Anthropic (que excluye la 1ª parte) y Azure no es ZDR, el pool efectivo queda en
**Vertex global/us/europe**: tres endpoints de un solo proveedor, con lo que la «redundancia multi-proveedor» que
vende OpenRouter se reduce a una.

---

## 3. Políticas de datos, guardrails, DPA, subencargados, términos

### 3.1 Logging y retención por OpenRouter (HECHO VERIFICADO [1], [9], [4])

- OpenRouter **no almacena prompts ni respuestas** por defecto; solo metadatos (tokens, latencia, modelo, timestamps).
  Dos opt-in: «Private Input & Output Logging» (visible para el admin de la organización) y «OpenRouter Use of
  Inputs/Outputs» (1 % de descuento; licencia perpetua e irrevocable sobre el contenido, incluida venta anonimizada —
  Terms §6.2).
- Excepción nueva: desde **2026-10-27** OpenRouter cribará **todo** el tráfico, incluido ZDR, en busca de CSAM; el
  contenido marcado puede retenerse para revisión humana y reporte a NCMEC.
- «Anonymous Input Categorization»: muestreo de prompts para categorizar y alimentar rankings; se declara anónimo y
  hecho con un modelo ZDR; Terms §6.5 otorga licencia perpetua sobre inputs anonimizados.
- Licencia general (Terms §6.1): licencia no exclusiva, transferible y sublicenciable sobre User Content «solely in
  connection with operating and providing the Service».

### 3.2 Niveles de política de datos y ZDR (HECHO VERIFICADO [4])

Tres niveles por endpoint: **ZDR** (sin almacenamiento rutinario), **Safety Retention** (OpenRouter o el proveedor
pueden retener cualquier prompt/respuesta solo para prevenir abuso; no entrenamiento; desde 2026-10-18 Google exige
este nivel para sus modelos en Vertex, hasta 90 días) y **Retention and Training**. Si OpenRouter no puede confirmar la
política de un endpoint, lo marca conservadoramente como «retiene y entrena».

ZDR se impone en tres capas con lógica OR: ajuste de cuenta (`settings/privacy`, por grupo de modelos: Anthropic,
OpenAI, Google, SpaceXAI, resto), guardrail (`enforce_zdr_anthropic|openai|google|xai|other`) y por request
(`provider.zdr: true`). Un guardrail solo puede ser más estricto que la cuenta. Efecto documentado por grupo:
«Anthropic: removes first-party Anthropic endpoints (Bedrock and Vertex remain available)»; «OpenAI: removes
first-party OpenAI endpoints (Azure remains available)». Cuentas self-serve permiten Safety Retention por defecto;
Enterprise usa «ZDR only».

El conector del repo envía `provider: { data_collection: 'deny', require_parameters: true }`. `data_collection: deny`
excluye proveedores «which store user data non-transiently and may train on it» (nivel 3), **no** equivale a ZDR
(nivel 1) — HECHO VERIFICADO [11] §Requiring Providers to Comply with Data Policies.

Caché implícita de prompts en memoria del proveedor **no** cuenta como retención a efectos ZDR (postura de OpenRouter).
ZDR no cubre plugins ni server tools (web search, etc.).

### 3.3 Mecanismo del bloqueo del laboratorio (imágenes y Sonnet 5.5)

Lo documentado: AI-CORE-RESULTS marca «Imágenes generadas por IA — BLOCKED_EXTERNAL — guardrail de la cuenta
OpenRouter» y pide «permitir en https://openrouter.ai/workspaces/default/guardrails un modelo de imagen con endpoint
ZDR (`google/gemini-3.1-flash-lite-image`, `microsoft/mai-image-2.6-flash` o `bytedance-seed/seedream-5-0-flash`)» y
«Claude Sonnet 5.5 — mismo guardrail». El conector (`src/ai/providers/openrouter.ts`) clasifica HTTP 404 como
`policy_blocked` con el comentario «OpenRouter responde 404 cuando la política de la cuenta (guardrails, ZDR) no deja
ningún endpoint». El estado HTTP real de cada bloqueo no está en los archivos de evidencia leídos.

Mecanismo según docs (HECHO VERIFICADO [4], [13], [14]; **re-verificado el 2026-11-03 contra guardrails.md y zdr.md
oficiales**: settings de guardrail = presupuesto USD, allowlist de modelos, allowlist de proveedores, ZDR por grupo
(Anthropic/OpenAI/Google/SpaceXAI/resto), Safety Retention por grupo, regiones de datos, detección regex de prompt
injection y PII; bloqueos → 403, y solo los checks de contenido incluyen `openrouter_metadata.pipeline`; jerarquía:
allowlists por intersección, ZDR por OR, Safety Retention la más estricta, «stricter rules always win» — todo
coincide):

| Capa | Qué hace | Respuesta documentada |
|---|---|---|
| Ajustes de privacidad de cuenta | ZDR por grupo de modelos; «ZDR only» vs «Allow Safety Retention»; proveedores ignorados; permitir/denegar entrenamiento | Si ningún endpoint cumple la política: la request «will get an error and your request will not complete» [1] (el FAQ no especifica código HTTP para este caso); el **404 «no endpoints for this model found»** está documentado explícitamente para modelos deprecados [2]; el conector del repo clasifica 404 como `policy_blocked` |
| Guardrail (por workspace, miembro o clave) | Budget USD (diario/semanal/mensual), **allowlist de modelos**, **allowlist de proveedores**, ZDR por grupo, Safety Retention, regiones de datos, filtros regex/PII | Budget, allowlist y región → **403** antes de llegar al proveedor; filtros de contenido → 403 con `openrouter_metadata.pipeline` |
| Jerarquía | Allowlists: intersección; ZDR: OR; Safety Retention: la más estricta; budgets: cada uno por separado | «stricter rules always win» |

Lectura del caso concreto:
- **`openai/gpt-image-2` tiene un único endpoint (OpenAI 1ª parte) y no es ZDR** (HECHO VERIFICADO, `/api/v1/endpoints/zdr`).
  Con ZDR impuesto para el grupo OpenAI (cuenta o guardrail) el pool queda vacío → 404 → `policy_blocked`. Es
  coherente con que la recomendación del handoff fuese cambiar a un modelo de imagen **con endpoint ZDR**.
  HIPÓTESIS (consistente con toda la evidencia): la cuenta del laboratorio tenía ZDR activo para OpenAI/Google (y
  probablemente «ZDR only», que además excluye Vertex para Gemini image por Safety Retention).
- **Claude Sonnet 5.5 sí tiene seis endpoints ZDR (Bedrock, Vertex)**, idénticos en política a los de Haiku, que sí
  funcionó. Por tanto ZDR por sí solo no explica el bloqueo de Sonnet. HIPÓTESIS: el guardrail del workspace tenía una
  **allowlist de modelos** (Haiku 5.5 y GPT-6 Luna) o de proveedores que dejaba fuera a Sonnet (respuesta 403), o un
  presupuesto por clave. Verificable sin costo leyendo el guardrail en el panel (sin ejecutar inferencia).
- **`lab-traces.md` (MEDICIÓN PROPIA, extracto read-only de `ai_invocation`) registra los bloqueos como
  `blocked_external`**: Sonnet 5.5 en `website.edit.complex` (2) y `website.initial.design` (3), y los tres modelos de
  imagen (1 invocación cada uno, en `website.image.generate` y `social.facebook.image.generate`). El estado HTTP real
  (403 vs 404) no quedó registrado en la traza — sigue siendo el dato que falta para distinguir allowlist (403) de
  pool vacío por ZDR (404/error).
- Si el propietario quisiera reabrir imágenes vía OpenRouter manteniendo ZDR: Seedream 5.0 Flash y MAI-Image-2.6 Flash
  son ZDR «puro» (`safety_retention=false`); Gemini 3.1 Flash Lite Image solo con «Allow Safety Retention» para Google;
  gpt-image-2 y FLUX 3 Klein **no** son alcanzables bajo ZDR.

### 3.4 DPA, subencargados, términos comerciales (HECHO VERIFICADO [3], [15], [16])

- **DPA** incorporado por referencia a los Terms para uso comercial (Terms §10.2); versión 2026-08-26. Roles:
  cliente = responsable, OpenRouter = encargado. Define ZDR contractualmente (§1.19, §2.4): borrado «promptly following
  generation» salvo ley/abuso y si no se ha optado por logging; clasificación automática de riesgo previa al borrado.
  §2.4(b): con «ZDR-only routing» OpenRouter no enruta a proveedores no designados ZDR en su registro, pero «it does not
  constitute OpenRouter's guarantee of AI Model Provider compliance».
- **Subencargados** (§5): OpenRouter puede usar afiliadas y terceros; aviso de 30 días **excluyendo a los proveedores de
  modelos** («excluding processing by AI Model Providers»); el cliente puede excluir proveedores en la configuración.
  Lista en https://trust.openrouter.ai/ (Schedule 3): la página pública muestra **Customer.io, Coinbase, Cloudflare,
  ClickHouse, Clerk**; la tabla completa requiere solicitar acceso al Trust Center (DESCONOCIDO el resto). Cada
  proveedor de modelos es, de hecho, un subencargado adicional cuyo contrato con MainSpot no existe: Terms §5.1 obliga a
  MainSpot a aceptar y hacer cumplir («flow-down») los Model Terms de cada proveedor, incluidos sus clientes.
- **Datos sensibles** (§2.6): OpenRouter no está obligado a procesar Sensitive Data salvo acuerdo expreso; Schedule 1
  dice que no se prevé procesarlos. Comentarios/reseñas de clientes finales pueden contener datos personales ordinarios;
  si incluyeran datos sensibles habría que amendar el DPA.
- **Transferencias**: SCC Módulo 2 (UE→OpenRouter), UK Addendum, Suiza. No hay cláusulas específicas para México;
  la aplicabilidad de la LFPDPPP para un responsable mexicano que transfiere a un encargado en EE. UU. **no** está
  cubierta por el DPA → DESCONOCIDO (revisión legal).
- **Seguridad** (Schedule 2): SOC 2 Type II, TLS 1.2+, AES-256, hosting GCP en regiones de EE. UU., notificación de
  incidentes < 72 h, borrado a solicitud en 30 días hábiles. Residencia UE/EE. UU. del payload solo en Business/
  Enterprise (`eu.openrouter.ai`, `us.openrouter.ai`); los datos de cuenta/facturación pueden quedar en EE. UU.
- **Plan Business** (8 %): DPA «signed copy on request»; Enterprise: DPA personalizable, SSO/SAML, SLA, invoicing.
- **Uso comercial**: permitido incorporar el servicio en productos propios (Terms §5.1), prohibido revender acceso a
  modelos o construir un servicio competidor (§7.4); prohibido red teaming sin autorización escrita (§7.11, §8) — ojo
  con evaluaciones de inyección de prompts como las de la Engineering Console: si se ejecutaran contra OpenRouter
  podrían calificar como Red Teaming.
- **Disponibilidad**: Terms §5.4–5.5: sin garantía de modelo alguno; el proveedor puede suspender acceso y OpenRouter
  declina responsabilidad; cambios de precio del proveedor se trasladan sin aviso previo específico [2].

---

## 4. Ventajas y desventajas frente a Anthropic/OpenAI directo

| Dimensión | OpenRouter | Directo (Anthropic / OpenAI / Google / BFL…) | Etiqueta |
|---|---|---|---|
| Precio de lista de tokens/imágenes | Igual al directo (10/10 modelos comparados) | Igual | HECHO VERIFICADO |
| Sobrecosto | 5.5 % (Standard) / 8 % (Business) sobre compra de créditos; 0 % con BYOK < USD 25k/mes de lista | 0 % | HECHO VERIFICADO |
| Descuentos Batch | `:batch` disponible para los 6 modelos de texto (mismo −50 %); **no** para ningún modelo de imagen | Batch −50 % en texto e imágenes (OpenAI gpt-image-2, Gemini image) | HECHO VERIFICADO |
| Cobertura multi-proveedor | 685 modelos, 80+ proveedores, una API (Chat Completions, Responses, `/images`), una factura | Una integración por proveedor; modelos de imagen de BFL/ByteDance/Microsoft exigen cuentas adicionales | HECHO VERIFICADO |
| Fallback y enrutamiento | Fallback automático entre endpoints del mismo modelo, `models[]` para fallback entre modelos, `:nitro/:floor/:exacto`, sort por precio/latencia/throughput, `max_price`; intento fallido no se cobra | Hay que implementarlo (el repo ya tiene dispatcher/rutas/rollout propios) | HECHO VERIFICADO |
| Redundancia real bajo ZDR + structured outputs | Para Claude se reduce a Vertex (3 regiones); para GPT a Azure (3 regiones); gpt-image-2 a 0 endpoints | N/A (un solo proveedor por diseño; ZDR por contrato directo según DEC-0067/DEC-0071) | HECHO VERIFICADO |
| Dependencia adicional | Un tercero más en la cadena (disponibilidad, cambios de política, suspensión unilateral §9, arbitraje NY) | Solo el proveedor | HECHO VERIFICADO |
| Tratamiento de datos | OpenRouter encargado + proveedor como subencargado sin aviso de cambio; política por endpoint; CSAM screening in-flight; Safety Retention en Google | Contrato directo con el proveedor; políticas ZDR/retención negociables directamente (ver anthropic.md / openai.md) | HECHO VERIFICADO |
| Structured outputs / tool use | Pass-through: «Enforcement varies by provider… Strict modes may also restrict which JSON Schema features you can use» [17]; los límites del proveedor subyacente (p. ej. el tope de 16 uniones de Anthropic que rompió `website.edit.*`) **se mantienen**; `tool_choice` forzado no disponible en endpoints Claude; soporte por endpoint, no por modelo | Límites del proveedor, pero con acceso a parámetros nativos completos | HECHO VERIFICADO (docs) / contexto del repo (16 uniones) |
| Contabilidad de costo | `usage.cost` en cada respuesta (el repo ya lo usa como procedencia) | Hay que calcularlo a partir de tokens y tarifas | HECHO VERIFICADO |
| Latencia | Salto adicional; cifras públicas no disponibles sin clave | Directa | DESCONOCIDO (NO MEDIDO comparativo) |
| SLA | Solo Enterprise | Según contrato directo (ver anthropic.md / openai.md) | HECHO VERIFICADO |
| Cumplimiento con DEC-0069 | **Incompatible hoy**: DEC-0069 excluye OpenRouter de nuevas ejecuciones y sin fallback | Conforme | Política vigente |

---

## 5. Evidencia histórica del repositorio (solo lectura; sin recálculo)

`evidence/ai-core/lab-e2e.txt` (E2E del 2026-10-30T22:15Z, HEAD 878f7de, negocio sintético «Café Brisa Lab
2e397c»; costos leídos de `ai_invocation`, procedencia: respuesta del proveedor `usage.cost`):

| Caso de uso | Ruta | n | USD | p50 ms | p95 ms |
|---|---|---|---|---|---|
| conversation.intent.classify | ts:jev-1.14.0 (TypeSafe, no OpenRouter) | 1 | 0.000034 | 308 | 308 |
| conversation.owner.assistant | or:anthropic/claude-haiku-5.5 | 2 | 0.001257 | 3,181 | 11,954 |
| editorial.calendar.suggest | or:openai/gpt-6-luna | 1 | 0.000497 | 7,135 | 7,135 |
| engagement.facebook.comment.classify | ts:jev-1.14.0 | 2 | 0.000098 | 213 | 356 |
| engagement.facebook.comment.reply | or:anthropic/claude-haiku-5.5 | 2 | 0.000533 | 1,698 | 2,816 |
| marketing.campaign.creatives | or:anthropic/claude-haiku-5.5 | 1 | 0.002106 | 19,199 | 19,199 |
| marketing.campaign.plan | or:openai/gpt-6-luna | 1 | 0.000684 | 8,467 | 8,467 |
| social.facebook.post.compose | or:anthropic/claude-haiku-5.5 | 1 | 0.001111 | 10,122 | 10,122 |
| website.edit.complex | or:openai/gpt-6-luna | 1 | 0.000542 | 8,588 | 8,588 |
| website.initial.design | or:anthropic/claude-haiku-5.5 | 1 | 0.002224 | 16,474 | 16,474 |

- «OpenRouter este recorrido: USD 0.008954 · laboratorio acumulado: USD 0.096726 de 25» (lab-e2e.txt l.73;
  AI-CORE-RESULTS l.60–61). Todo lo facturado vía OpenRouter fue Haiku 5.5 y GPT-6 Luna; **ninguna imagen** se generó
  (`website.initial.design` reporta `bloqueadas ["hero:no_active_route","about:no_active_route"]`).
- **MEDICIÓN PROPIA (`lab-traces.md`, 2026-11-03, extracto read-only de `ai_invocation`, 310 invocaciones del
  2026-10-30): el precio aplicado por OpenRouter fue el de catálogo, sin sobreprecio por token visible en
  `usage.cost`** — p. ej. `website.initial.design` Haiku 5.5: 5,091 in / 2,665 out → USD 0.0018416 = exactamente
  5,091×0.10/M + 2,665×0.50/M; lo mismo para GPT-6 Luna a 0.10/0.50. La comisión de compra de créditos no aparece en
  la traza. Gasto acumulado vía OpenRouter: **USD 0.096726**.
- Las cifras de `usage.cost` son a precio de lista, sin la comisión de compra de créditos: la comisión implícita del
  acumulado sería USD 0.00532 (Standard) — ESTIMACIÓN §1.
- Las latencias son **a través de OpenRouter** (incluye el salto del enrutador) y de un único recorrido (n=1–2): no
  sirven como p95 productivo ni para comparar con directo (NO MEDIDO).
- El techo DEC-0068 (USD 25) quedó consumido al 0.39 %.

---

## 6. Conclusión en papel

1. **Precio**: OpenRouter no abarata la inferencia; cobra lo mismo que el directo (cruzado sin discrepancias, §2) y
   añade 5.5–8 % en la compra de créditos (0 % con BYOK por debajo de USD 25,000/mes de lista). La evidencia histórica
   del repo lo confirma: el laboratorio acumuló **USD 0.096726** vía OpenRouter y el precio aplicado coincidió con el
   catálogo (Haiku 5.5 y GPT-6 Luna a 0.10/0.50 por MTok, sin sobreprecio en `usage.cost` — `lab-traces.md`, §5), por
   lo que la comisión implícita habría sido USD 0.00532 (ESTIMACIÓN Standard). A USD 500/mes de IA serían
   USD 27.50/mes (Standard). Además pierde el −50 % Batch en imágenes.
2. **Dónde tendría ventaja material** (todas sujetas a decisión del propietario, DEC-0069 vigente):
   - *Evaluación multi-modelo sin abrir cuentas*: comparar Gemini 4 Argon, DeepSeek V4.1 Flash, Seedream, FLUX, MAI
     con una sola clave y `usage.cost` homogéneo; sobrecosto ≈ 5.5 % del gasto de evaluación (p. ej. USD 10 de
     evaluación → USD 0.55). Para esto bastaría un workspace de laboratorio separado con guardrail de presupuesto.
   - *Modelos de imagen baratos no ofrecidos por Anthropic/OpenAI*: Seedream 5.0 Flash USD 0.018, FLUX 3 Klein USD
     0.009 (1K), Gemini 3.1 Flash Lite Image USD 0.0336, frente a `gpt-image-2` directo (openai.md §1.4, tabla oficial:
     1024² low $0.006 / medium $0.053 / high $0.211). Si el benchmark de calidad (ImageAlternatives) los valida,
     OpenRouter evita firmar con BytePlus/BFL/Azure; el sobrecosto sería 5.5 % sobre un precio por imagen menor contra
     medium/high (ESTIMACIÓN: `0.053/0.018 ≈ 2.9`; `0.053/0.009 ≈ 5.9`; `0.053/0.0336 ≈ 1.6` contra medium;
     11.7×/23.4×/6.3× contra high) pero **mayor contra `low`** de gpt-image-2 (Klein $0.009 = 1.5×; Seedream $0.018 =
     3×; Gemini lite $0.0336 = 5.6× el low de $0.006). La comparación depende de la calidad mínima que valide el
     benchmark (NO MEDIDO).
   - *Edición de imágenes existentes* (capacidad propuesta, hoy ausente del catálogo): los cinco modelos aceptan
     `input_references` (gpt-image-2 hasta 16, Seedream/Gemini 14, FLUX 10, MAI 5) vía la misma API `/images`.
   - *Fallback entre proveedores del mismo modelo* (Vertex ↔ Bedrock para Claude; Azure para GPT) sin integrar
     Bedrock/Vertex/Azure; útil solo si se acepta que bajo ZDR + `require_parameters` el pool real es un proveedor.
3. **Dónde no conviene**: texto con Claude/GPT en producción con datos reales. No añade descuento, añade un
   encargado más con subencargados (los proveedores) fuera del aviso de 30 días, pierde `tool_choice` forzado en
   Claude, mantiene los límites de esquema del proveedor (16 uniones), y contradice DEC-0069/DEC-0071. Para Gemini 4
   Argon además el precio directo se duplica el 2026-12-01.
4. **Bloqueo del laboratorio**: el 404/`policy_blocked` de imágenes se explica porque `gpt-image-2` no tiene endpoint
   ZDR y el único modo de generar imágenes bajo ZDR en OpenRouter es con Seedream/MAI (ZDR puro) o Gemini image (Safety
   Retention). El bloqueo de Sonnet 5.5 no se explica por ZDR (tiene los mismos endpoints ZDR que Haiku) y apunta a
   una allowlist/presupuesto del guardrail (HIPÓTESIS verificable en el panel sin gasto).
5. **Recordatorio**: este estudio no autoriza nada. Cualquier reactivación (incluso solo para evaluación) requiere
   decisión explícita del propietario que modifique o excepcione DEC-0069, defina el workspace/guardrail de
   laboratorio, el presupuesto (DEC-0068) y la clasificación de datos (solo sintéticos hasta nueva decisión).
6. **Implicación DEC-0073/DEC-0069**: DEC-0073 (commit SOL MAIN `1f1c7da`) fija OpenAI directo para toda la generación
   de desarrollo y deshabilita Anthropic (migration 0029); **no modifica la posición de OpenRouter, que sigue
   excluido de ejecuciones del producto por DEC-0069 y sin fallback**. Reactivar OpenRouter —incluso solo para la
   evaluación multi-modelo del punto 2— sería una decisión del propietario; esta sección es propuesta trazable, no
   acción.

---

## Fuentes

1. OpenRouter FAQ — https://openrouter.ai/docs/faq (versión markdown `faq.md`), consultada 2026-11-03. Pass-through sin
   markup, comisión en compra de créditos (valor como plantilla), BYOK USD 25,000/mes y 5 %, créditos expiran al año,
   reembolso 24 h, logging opt-in con 1 %, ZDR/Safety Retention, residencia UE, formas de pago, sin descuento por volumen.
2. OpenRouter Pricing — https://openrouter.ai/pricing (markdown `pricing.md`), 2026-11-03. Tabla de planes: 5.5 % Standard,
   8 % Business, Enterprise por contrato; BYOK; DPA por plan; SLA solo Enterprise; impuestos; rate limits; intentos
   fallidos no cobrados; 404 en modelo deprecado; cambio de precio se traslada; workspaces.
3. OpenRouter Terms of Service (Last Updated 2026-08-31) — https://openrouter.ai/terms, 2026-11-03. §4.1 mínimo USD 5 /
   máximo USD 25,000, reembolso 24 h, comisión no reembolsable; §4.2 expiración 365 días; §5 Model Terms y flow-down; §6
   licencias sobre contenido, logging opt-in, categorización; §7.4 no reventa; §7.11/§8 red teaming; §9 terminación;
   §10.2 DPA; §16–17 sin garantías, límite de responsabilidad; §18–19 ley NY y arbitraje.
4. OpenRouter ZDR docs — https://openrouter.ai/docs/guides/features/zdr (`zdr.md`), 2026-11-03. Niveles de política,
   ZDR por grupo de modelos (efecto sobre 1ª parte Anthropic/OpenAI/Google), Safety Retention de Google desde
   2026-10-18, `provider.zdr`, caché implícita, CSAM desde 2026-10-27, endpoint público `/api/v1/endpoints/zdr`.
5. Anthropic Pricing — https://platform.claude.com/docs/en/about-claude/pricing (`pricing.md`), 2026-11-03. Haiku 5.5
   0.10/0.50 (≤100k) y 0.50/2.50; Sonnet 5.5 2/10; Opus 5.5 4/20; caché; batch −50 %; fast mode 8/40; recargo regional
   10 %; tokens de sistema por `tool_choice` any/tool.
6. OpenAI Pricing — https://platform.openai.com/docs/pricing (sirve developers.openai.com/api/docs/pricing), 2026-11-03.
   gpt-6-luna 0.10/0.50 (short ≤272K), 0.20/0.75 (long); gpt-6.1-sol 2/10 y 4/15; Flex/Fast/Ultrafast; Batch;
   gpt-image-2 imagen 8/30, texto 5, caché 2; Batch 4/15/2.50; uplift 10 % residencia.
7. Gemini Developer API pricing — https://ai.google.dev/gemini-api/docs/pricing (sirve aistudio.google.com/docs/pricing),
   2026-11-03. Gemini 4 Argon 2/10 hasta 2026-11-30 y 4/20 desde 2026-12-01; Batch/Flex/Priority; Gemini 3.1 Flash Lite
   Image 0.25 / 1.50 / 30 por M tokens, 1,120 tokens = USD 0.0336 por imagen 1K; Batch 15/M.
8. DeepSeek Models & Pricing — https://api-docs.deepseek.com/quick_start/pricing, 2026-11-03. `deepseek-flash` =
   DeepSeek-V4.1-Flash-1017: pico 0.30/1.20, valle 0.15/0.60; caché hit 0.006/0.003; horario pico UTC.
9. OpenRouter Data Collection — https://openrouter.ai/docs/guides/privacy/data-collection (`.md`), 2026-11-03. Sin
   almacenamiento de prompts salvo opt-in o CSAM; metadatos; categorización anónima.
10. OpenRouter Image Generation — https://openrouter.ai/docs/guides/overview/multimodal/image-generation (`.md`),
    2026-11-03. API `/api/v1/images`, endpoint público de precios por endpoint, ejemplo gpt-image-2 1536×864 high USD
    0.13 / 94 s, `input_references`, parámetros.
11. OpenRouter Provider Routing — https://openrouter.ai/docs/guides/routing/provider-selection (`.md`), 2026-11-03.
    `order`, `allow_fallbacks`, `require_parameters`, `data_collection` (allow/deny), `zdr`, `only/ignore`, `sort`,
    `max_price`; 404 si ningún proveedor cumple; enrutamiento por defecto.
12. Black Forest Labs — blog «FLUX 3 Image Klein» https://bfl.ai/blog/flux-3-image-klein/ (USD 0.009 por imagen 1K) y
    https://bfl.ai/pricing?category=flux+3+image (tabla por tier solo visible en snippet de búsqueda), 2026-11-03.
13. OpenRouter Guardrails — https://openrouter.ai/docs/guides/features/guardrails (`.md`), 2026-11-03. Budget, allowlists
    de modelos/proveedores, ZDR por grupo, Safety Retention, regiones, filtros; jerarquía; 403 al bloquear.
14. OpenRouter Errors — https://openrouter.ai/docs/api_reference/errors-and-debugging.md, 2026-11-03. 402/403/404/429,
    `limit_source`, guardrail errors, `content_policy_violation`/`refusal` como 403.
15. OpenRouter DPA (Last Updated 2026-08-26) — https://openrouter.ai/data-processing-agreement, 2026-11-03. Roles,
    definición ZDR, §2.4, §2.6 datos sensibles, §5 subencargados (aviso 30 días excluyendo proveedores de modelos),
    Schedule 2 seguridad (SOC 2 Type II, GCP EE. UU.), Schedule 3 → Trust Center, Exhibit A UE.
16. OpenRouter Trust Center — https://trust.openrouter.ai/, 2026-11-03. SOC 2 Type 2; subencargados visibles:
    Customer.io, Coinbase, Cloudflare, ClickHouse, Clerk (lista completa tras solicitud de acceso).
17. OpenRouter Structured Outputs — https://openrouter.ai/docs/guides/features/structured-outputs (`.md`), 2026-11-03.
    Soporte por endpoint, `require_parameters`, enforcement variable y restricciones de esquema del proveedor.
18. OpenRouter Models API — https://openrouter.ai/api/v1/models?output_modalities=all (685 modelos) y
    https://openrouter.ai/api/v1/models/{id}/endpoints para los 12 modelos, 2026-11-03. Precios, `overrides`, caché,
    `supported_parameters`, `supports_tool_choice`, `uptime_last_1d`, `latency_last_30m`/`throughput_last_30m` = null.
19. OpenRouter ZDR endpoints API — https://openrouter.ai/api/v1/endpoints/zdr (1,098 endpoints), 2026-11-03.
    Elegibilidad ZDR y `safety_retention` por endpoint.
20. OpenRouter Image endpoints API — https://openrouter.ai/api/v1/images/models/{id}/endpoints para los 5 modelos de
    imagen, 2026-11-03. Líneas `billable/unit/cost_usd`, `input_references`, passthrough.
21. OpenRouter model page markdown — https://openrouter.ai/anthropic/claude-haiku-5.5/llms.txt, 2026-11-03. Precios por
    proveedor, routing UE, errores por código.
22. Repositorio (solo lectura): `evidence/ai-core/lab-e2e.txt`; `docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-RESULTS.md`;
    `src/ai/providers/openrouter.ts` (cabecera, `classify()`, `provider: { data_collection: 'deny', require_parameters: true }`).
23. Referencias secundarias: BytePlus ModelArk pricing https://docs.byteplus.com/en/docs/modelark/model-pricing (tabla JS;
    el precio de Seedream 5.0 Flash $0.018 quedó **verificado en fuente oficial** vía image-providers.md §4.1) y
    MAI-Image-2.6 Flash 1.75 / 2.50 / 19.00 por M tokens (agregador litellm; Azure no renderiza la fila;
    image-providers.md §5.3 confirma que el precio oficial Azure es DESCONOCIDO y solo existe la referencia secundaria
    AA de $19.5/1k imgs).
24. Archivos hermanos del mismo directorio usados para el cruce (2026-11-03): `evidence/anthropic.md` §2.1/§2.9/§2.10;
    `evidence/openai.md` §1.3/§1.4/§3.2; `evidence/image-providers.md` §2.1/§3.1/§4.1/§5.3; `evidence/lab-traces.md`
    (MEDICIÓN PROPIA: precio aplicado = catálogo 0.10/0.50 en Haiku 5.5 y GPT-6 Luna sin sobreprecio en `usage.cost`,
    acumulado USD 0.096726, `blocked_external` en imágenes y Sonnet 5.5).
25. Re-verificación de auditoría (lecturas propias de esta corrida, 2026-11-03): `https://openrouter.ai/docs/faq.md`
    (plantillas de fee cripto, BYOK, reembolsos, caducidad, 1 % logging, ZDR/Safety Retention, medios de pago),
    `https://openrouter.ai/pricing.md` (5.5 % Standard / 8 % Business / Enterprise por contrato, BYOK 25k/5 %,
    workspaces 5/5/1,000, SLA solo Enterprise, DPA por plan, 404 deprecado, cambio de precio),
    `https://openrouter.ai/docs/guides/features/guardrails.md` (settings, jerarquía, 403) y
    `https://openrouter.ai/docs/guides/features/zdr.md` (tres niveles, grupos ZDR, CSAM 2026-10-27, Google Safety
    Retention 2026-10-18, defaults self-serve/enterprise), más `https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints`
    (endpoints 2/10, caché 0.10/2.50/4.00, `tool_choice` required/function=false) y
    `https://openrouter.ai/api/v1/images/models/openai/gpt-image-2/endpoints` (endpoint único OpenAI, 8/5/30 por M tok).

## Huecos

| Hueco | Cómo se verificaría (sin costo salvo indicación) |
|---|---|
| Comisión exacta para pagos cripto | Renderizar el FAQ con navegador (`browser`) o leer el flujo de compra en `settings/credits` con sesión; no requiere comprar (re-confirmado 2026-11-03: la plantilla `{getTotalFeeString('coinbase')}` sigue sin renderizar en faq.md) |
| Latencia (TTFT) y throughput publicados por endpoint | Los campos públicos devuelven `null` sin clave; leer la página del modelo con navegador autenticado en el workspace de laboratorio (sin inferencia), o `GET /api/v1/models/user` con la clave existente (lectura, sin costo) |
| Uptime histórico / incidentes | https://status.openrouter.ai/ es JS puro; cargar con navegador |
| Estado HTTP real (403 vs 404) de los bloqueos del laboratorio y configuración del guardrail (allowlist, ZDR por grupo, Safety Retention) | Leer el guardrail en https://openrouter.ai/workspaces/default/guardrails y los logs de actividad con sesión; no ejecutar inferencia |
| Lista completa de subencargados (Schedule 3) | Solicitar acceso al Trust Center (SafeBase) |
| Tokens por imagen de MAI-Image-2.6 Flash (precio por imagen) y precio oficial en Azure | Página de precios de Azure AI Foundry con navegador; o documentación de Microsoft Learn del modelo (image-providers.md §5.3 ya estableció que el precio oficial Azure es DESCONOCIDO; la referencia secundaria AA $19.5/1k imgs es consistente con la tarifa de OpenRouter) |
| ~~Precio oficial de Seedream 5.0 Flash en BytePlus (tabla JS)~~ | **CERRADO en esta auditoría**: image-providers.md §4.1 (2026-11-03) verificó $0.018/imagen en la fuente oficial BytePlus |
| ~~Tabla de tiers de FLUX 3 Klein en bfl.ai/pricing~~ | **CERRADO en esta auditoría**: image-providers.md §3.1 (2026-11-03) verificó la tabla completa de tiers en bfl.ai (768 $0.008 · 1K $0.009 · 1.5K $0.011 · 2K $0.014 · 4K $0.036) |
| ~~Tokens por imagen de gpt-image-2 por calidad/tamaño~~ | **CERRADO en esta auditoría**: openai.md §1.4 publica la tabla oficial de costo por imagen (1024²: 0.006/0.053/0.211; 1536×1024: 0.005/0.041/0.165), usada en §2.2 y §6.2 |
| Equivalencia ZDR contractual OpenRouter↔proveedor (p. ej. si el endpoint Vertex «ZDR» de Claude equivale al ZDR directo de Anthropic bajo DEC-0067) | Cruzar con `anthropic.md`/`openai.md`; revisión legal; el DPA §2.4(b) declara que no es garantía |
| Aplicabilidad LFPDPPP / transferencia internacional México→EE. UU. bajo el DPA | Revisión legal; el DPA solo cubre GDPR/UK/Suiza/CCPA |
| Latencia comparativa OpenRouter vs directo por caso de uso | NO MEDIDO: requeriría llamadas pagadas; plan: mismas entradas sintéticas, n≥20 por caso, p50/p95, misma región, solo con autorización explícita (DEC-0068/DEC-0069) |
| Comportamiento de `tool_choice` forzado en Claude vía OpenRouter (el API lo reporta no soportado) | NO MEDIDO: prueba con una llamada mínima requeriría gasto y excepción a DEC-0069 |
