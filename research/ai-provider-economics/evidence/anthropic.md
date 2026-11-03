# Evidencia — Anthropic (Claude API directa) para el MainSpot AI Core

Fecha de consulta de todas las fuentes: **2026-11-03**. Moneda: **USD** salvo indicación. Unidad: **MTok = 1,000,000 tokens**.
Alcance: investigación, sin llamadas pagadas, sin cambios de política (DEC-0069/DEC-0071/DEC-0068 se mantienen).

Etiquetas de evidencia usadas: **HECHO VERIFICADO** (leído con `read` en la URL oficial), **SNIPPET** (visto solo en resultado de búsqueda), **ESTIMACIÓN** (cálculo propio con fórmula), **HIPÓTESIS**, **DESCONOCIDO**.

Nota metodológica: las páginas de `platform.claude.com/docs` se leyeron vía su alternativa Markdown oficial (`*.md`). Las tablas de precios de AWS Bedrock se resolvieron desde el endpoint público de precios que alimenta la página (`b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/...`), porque la tabla HTML se rellena en cliente. El Trust Center (`trust.anthropic.com`) es una SPA; se renderizó con Chromium local sin sesión para leer certificaciones y subencargados.

---

## 1. Catálogo actual de modelos API

### 1.1 Lineup vigente (HECHO VERIFICADO — Models overview + páginas de modelo)

| Modelo | ID API exacto | Lanzamiento | Ventana contexto | Salida máx. (sync) | Salida máx. (Batch, beta `output-300k-2026-03-24`) | Thinking | Effort por defecto | Retiro comprometido | Latencia comparativa |
|---|---|---|---|---|---|---|---|---|---|
| Claude Haiku 5.5 | `claude-haiku-5-5` | 7 oct 2026 | 1M tokens | 128K | 300K | Adaptativo (desactivable con `thinking: disabled` a effort ≤ high) | `medium` | No antes del 7 oct 2027 | Fastest |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 28 sep 2026 | 1M tokens | 128K | 300K | Adaptativo (`disabled` NO aceptado; mínimo es `between_tools`) | `high` | No antes del 28 sep 2027 | Fast |
| Claude Opus 5.5 | `claude-opus-5-5` | 22 sep 2026 | 1M tokens | 128K | 300K | Adaptativo **siempre activo** (`disabled` → 400) | `medium` | No antes del 22 sep 2027 | Moderate |
| Claude Fable 5.1 | `claude-fable-5-1` | — (retiro no antes del 1 sep 2027) | 1M | 128K | — | Adaptativo siempre activo | `high` | No antes del 1 sep 2027 | Slower |

Notas verificadas (HECHO VERIFICADO):
- Los IDs sin fecha de la generación 4.6+ son snapshots fijos (no alias móviles). El alias y el ID coinciden para 5.5.
- Corte de conocimiento fiable y de datos de entrenamiento: jun 2026 para los cuatro.
- Tokenizador nuevo desde Claude 4.7 (incluye todos los 5.5): **~30 % más tokens para el mismo texto** que Sonnet 4.6 y anteriores. Esto afecta cualquier comparación de precio por token con modelos previos o de otros proveedores.
- `temperature`, `top_p`, `top_k` eliminados en la versión de API `2026-10-21` (400 si se envían); en versiones anteriores devuelven error si se fijan en valor no-default en modelos 4.7+.
- Fable 5.1 / Mythos son "Covered Models": requieren retención de 30 días y no son elegibles para ZDR; Mythos requiere verificación (programa Cyber Verification). No relevantes para MainSpot.

### 1.2 Modelos anteriores aún disponibles y deprecaciones (HECHO VERIFICADO — Model deprecations)

| ID API | Estado | Deprecado | Retiro tentativo | Reemplazo recomendado |
|---|---|---|---|---|
| `claude-haiku-4-5-20251001` | Activo | — | No antes del 15 oct 2026 (nota: fecha ya alcanzada; la página sigue listándolo Activo sin aviso de deprecación) | — |
| `claude-sonnet-5` | Activo | — | No antes del 30 jun 2027 | — |
| `claude-sonnet-4-6` | Activo | — | No antes del 17 feb 2027 | — |
| `claude-sonnet-4-5-20250929` | **Deprecado** | 30 sep 2026 | **30 nov 2026** | `claude-sonnet-5-5` |
| `claude-opus-5` | Activo | — | No antes del 24 jul 2027 | — |
| `claude-opus-4-8` / `4-7` / `4-6` | Activo | — | 28 may 2027 / 16 abr 2027 / 5 feb 2027 | — |
| `claude-opus-4-5-20251101` | Activo | — | No antes del 24 nov 2026 | — |
| `claude-opus-4-1-20250805`, `claude-opus-4-20250514`, `claude-sonnet-4-20250514`, `claude-3-7-sonnet-*`, `claude-3-5-haiku-*`, `claude-3-haiku-*` | **Retirados** | — | ya retirados en 2026 | — |

Política de deprecación (HECHO VERIFICADO): aviso mínimo de 60 días antes del retiro para modelos públicos; fechas aplican a plataformas operadas por Anthropic (API directa, Claude Platform on AWS, Google Cloud Anthropic-managed, Foundry); Bedrock y Vertex (Google-managed) fijan sus propios calendarios.

Implicación para MainSpot: cualquier referencia a `claude-sonnet-4-5` en código/config debe migrarse antes del 30 nov 2026. Haiku 4.5 está en su ventana mínima de vida y Haiku 5.5 es 10× más barato en el tramo ≤100K, así que no hay razón económica para mantenerlo.

---

## 2. Precios (API directa, primera parte)

### 2.1 Precio base por modelo (HECHO VERIFICADO — Pricing)

| Modelo | Input base | Escritura caché 5 min | Escritura caché 1 h | Lectura caché (hit/refresh) | Output | Batch input | Batch output |
|---|---|---|---|---|---|---|---|
| Haiku 5.5 (prompt ≤ 100,000 tokens) | $0.10 | $0.125 | $0.20 | **$0.01** | $0.50 | $0.05 | $0.25 |
| Haiku 5.5 (prompt > 100,000 tokens) | $0.50 | $0.625 | $1.00 | $0.05 | $2.50 | $0.25 | $1.25 |
| Sonnet 5.5 | $2.00 | $2.50 | $4.00 | **$0.10** (0.05×; rebajado de $0.20 el 7 oct 2026) | $10.00 | $1.00 | $5.00 |
| Opus 5.5 | $4.00 | $5.00 | $8.00 | **$0.20** (0.05×) | $20.00 | $2.00 | $10.00 |
| Sonnet 5 | $2.00 | $2.50 | $4.00 | $0.20 | $10.00 | $1.00 | $5.00 |
| Sonnet 4.6 / 4.5 | $3.00 | $3.75 | $6.00 | $0.30 | $15.00 | $1.50 | $7.50 |
| Haiku 4.5 | $1.00 | $1.25 | $2.00 | $0.10 | $5.00 | $0.50 | $2.50 |
| Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5.00 | $6.25 | $10.00 | $0.50 | $25.00 | $2.50 | $12.50 |
| Fable 5.1 | $10.00 | $12.50 | $20.00 | $0.25 (0.025×) | $50.00 | $5.00 | $25.00 |

Multiplicadores de caché (HECHO VERIFICADO): escritura 5 min = 1.25× input; escritura 1 h = 2× input; lectura = 0.1× input en general, **0.05× en Opus 5.5 y Sonnet 5.5**, 0.025× en Fable 5.1. Los multiplicadores se apilan con Batch y con data residency.

### 2.2 Tramos por longitud de prompt (HECHO VERIFICADO — Long context pricing)
- Solo **Haiku 5.5** tiene tramo por longitud: si el prompt de la petición supera 100,000 tokens, **toda la petición** paga los precios altos (input, caché y output). La longitud cuenta todos los tokens de entrada incluidos cache reads y cache writes. Cada petición se tarifica individualmente.
- Opus 5.5, Sonnet 5.5 y todos los 4.6+ (excepto Haiku 5.5): **1M de contexto a precio estándar**, sin tramo.
- Para MainSpot ningún perfil de uso (§7) se acerca a 100K; el tramo alto de Haiku es irrelevante salvo abuso.

### 2.3 Prompt caching — reglas operativas (HECHO VERIFICADO — Prompt caching)
- Mínimo cacheable: **512 tokens** en Haiku 5.5, Sonnet 5.5, Opus 5.5 (2,048 en Opus 4.7 / Mythos Preview). Prompts más cortos no se cachean y no dan error (ambos campos de caché en 0 en `usage`).
- TTL mínimo 5 min (se refresca con cada uso); opción 1 h (2× escritura).
- Caché automática (`cache_control` a nivel de petición) o breakpoints explícitos; ventana de lookback de 20 bloques.
- `max_tokens: 0` permite pre-calentar la caché (paga escritura, no output); no permitido dentro de Batch.
- Las lecturas de caché **no cuentan para ITPM** (límite de tasa), solo `input_tokens` + `cache_creation_input_tokens`.
- Retención: representaciones KV y hashes en memoria durante el TTL, borrados "prontamente" tras expirar; aislado por organización y por workspace.
- Rentabilidad: caché 5 min se paga con 1 lectura; 1 h con 2 lecturas.

### 2.4 Batch API (HECHO VERIFICADO — Batch processing)
- **50 % de descuento** en input y output (también en escrituras/lecturas de caché según tabla de Vertex; en API directa la página de precios dice que los multiplicadores "se apilan").
- Sin SLA formal: "la mayoría de los lotes terminan en < 1 hora"; resultados disponibles cuando todo termina **o a las 24 h**; los lotes **expiran a las 24 h** si no se completan. Bajo demanda alta puede haber más expiraciones.
- Límites: 100,000 peticiones o 256 MB por lote; resultados descargables 29 días; `max_tokens ≥ 1`; no `stream`, no `speed` (fast mode), no `fallbacks`.
- **No elegible para ZDR** (retención 29 días, almacenamiento asíncrono).
- Límites propios por tier (RPM / cola / por lote): Start 1,000 / 200,000 / 100,000; Build 2,000 / 300,000 / 100,000; Scale 4,000 / 500,000 / 100,000.
- Los lotes pueden sobrepasar ligeramente el spend limit del workspace.

### 2.5 Herramientas (HECHO VERIFICADO — Tool use pricing / Specific tool pricing)

| Concepto | Valor |
|---|---|
| Tokens de system prompt inyectados por tool use (`tool_choice` auto/none) | **286 tokens** en Haiku 5.5, Sonnet 5.5 y Opus 5.5 (Haiku 5.5 con `any`/`tool`: 406; Sonnet/Opus 5.5 no listan cifra para `any`/`tool`) |
| Tokens de `tools` (definiciones), `tool_use` y `tool_result` | se facturan como input normal |
| Web search (server-side) | **$10 por 1,000 búsquedas** + tokens; los resultados cuentan como input en el turno y en turnos posteriores; búsquedas con error no se cobran |
| Web fetch (server-side) | sin cargo adicional, solo tokens del contenido (usar `max_content_tokens`) |
| Code execution | gratis si va con web_search/web_fetch `20260209+`; si no, por tiempo: 1,550 h gratis/mes por organización, luego $0.05/h/contenedor, mínimo 5 min; **no ZDR** (contenedor retiene hasta 30 días) |
| Bash tool / text editor | +325 / +974 tokens de definición en modelos 4.7+ |
| Computer use toolset / Browser use toolset | ~4,500 / ~6,600 tokens de overhead por petición |
| Structured outputs / strict tools | el system prompt inyectado cuesta tokens de input ("ligeramente más"); cambiar `output_config.format` invalida la caché de prompt; la gramática compilada se cachea 24 h |

### 2.6 Thinking / effort (HECHO VERIFICADO — Thinking, Effort)
- Los tokens de razonamiento **se facturan como output** aunque no se devuelvan (`display: omitted` reduce latencia, no coste) y **cuentan para `max_tokens`**.
- Se cobra el razonamiento completo, no el resumen devuelto.
- Thinking de turnos previos: en modelos que lo preservan, se factura como input en el historial.
- `effort` (`low`/`medium`/`high`/`xhigh`/`max`) es la palanca de coste: afecta a **todos** los tokens de salida (texto, tool calls y thinking). Es señal de comportamiento, no presupuesto estricto.
- Opus 5.5: thinking siempre activo; `disabled` → 400. Sonnet 5.5: no acepta `disabled`; mínimo `between_tools` (válido a low/medium/high). Haiku 5.5: acepta `disabled` a effort ≤ high.
- Recomendación de Anthropic para Haiku 5.5: `low` para chat, tool tasks cortas y alto volumen; `medium` por defecto; `high` para seguimiento estricto de instrucciones.
- Implicación: los perfiles de §7 asumen tokens de salida **visibles**; en producción el output facturado incluirá thinking adaptativo (HIPÓTESIS de sensibilidad: +20–100 % de output según effort; **NO MEDIDO**).

### 2.7 Structured outputs — límites documentados (HECHO VERIFICADO — Structured outputs § JSON Schema limitations / Schema complexity limits)

| Límite explícito | Valor | Alcance |
|---|---|---|
| Herramientas `strict: true` por petición | 20 | — |
| Parámetros opcionales (no en `required`) | **24** | total combinado entre todos los schemas estrictos y `output_config.format` de la petición |
| **Parámetros con tipos unión** (`anyOf` o arrays de tipo como `["string","null"]`) | **16** | total combinado entre todos los schemas estrictos de la petición; "coste de compilación exponencial" |
| Timeout de compilación de gramática | 180 s | — |
| Límites internos de tamaño de gramática | no publicados | error 400 "Schema is too complex for compilation" aunque se cumplan los explícitos |

- **Confirmado**: el fallo de MainSpot con 17 uniones en `website.edit.*` es consistente con el límite documentado de 16 parámetros con unión. **Strict tool use NO es alternativa**: comparte "the same grammar pipeline" y los mismos límites (la página de strict tool use remite a las mismas limitaciones).
- Soportado: tipos básicos, `enum` (solo primitivos), `const`, `anyOf`/`allOf` (allOf sin `$ref`), `$ref`/`$defs` internos, `default`, `required`, `additionalProperties:false` (obligatorio), formatos de string (`date-time`, `email`, `uri`, `uuid`…), `minItems` 0/1, regex simples.
- No soportado: esquemas recursivos, `$ref` externos, `minimum`/`maximum`/`multipleOf`, `minLength`/`maxLength`, otras restricciones de array, `additionalProperties` ≠ false, backreferences/lookahead/`\b` en regex.
- Caveats de salida: `stop_reason: refusal` (200, se factura, puede no cumplir schema); `max_tokens` corta la salida; **no se garantiza la capitalización** de valores `enum`/`const`.
- Orden de propiedades: `required` primero y luego opcionales, en el orden del schema.
- Mitigaciones documentadas por Anthropic (en este orden): marcar strict solo herramientas críticas; reducir opcionales (hacerlas `required` con default explícito); aplanar anidamiento; **dividir en varias peticiones/subagentes**.
- Alternativas para el DSL de parches de 17 uniones (HIPÓTESIS de diseño, a validar): (a) discriminar el parche en dos pasos: primer paso clasifica tipo de operación (enum, barato, incluso Haiku) y segundo paso usa un schema **por tipo** con ≤16 uniones; (b) sustituir uniones por objetos con `kind` enum + campos `required` con `null` evitado (los arrays de tipo con `null` cuentan como unión); (c) JSON sin constrained decoding + validación local y reparación (coste de reintento). Ninguna está medida.

### 2.8 Priority tier (HECHO VERIFICADO — Service tiers)
- **Legacy.** "Priority Tier capacity commitments are no longer available for purchase." Solo organizaciones con compromiso vigente; además, **no soportado en Haiku 5.5, Sonnet 5.5, Opus 5.5, Sonnet 5, Opus 5, Fable/Mythos**. Para capacidad garantizada: contactar ventas. Sin precio público.
- Para MainSpot: no existe una vía de "prioridad" comprable; la resiliencia debe venir de reintentos, Batch para lo diferible y, si se desea, cuentas alternativas (Bedrock/Vertex) — esto último exigiría nueva decisión.

### 2.9 Fast mode (HECHO VERIFICADO — Pricing)
- Solo Opus (5.5, 5, 4.8). Opus 5.5 fast: **$8 / $40 por MTok** (2×). Rate limits dedicados; no disponible con Batch. Irrelevante para MainSpot salvo necesidad de latencia extrema en Opus.

### 2.10 Data residency / inference geo (HECHO VERIFICADO — Data residency, Pricing)
- `inference_geo: "global"` (default) precio estándar; `inference_geo: "us"` → **1.1× en todas las categorías** (input, output, cache write, cache read; en Haiku 5.5 también sobre el tramo >100K). Solo modelos 4.6+; en 4.5 y anteriores → 400.
- Workspace geo: solo `"us"` disponible; se fija al crear el workspace y no se cambia.
- Rate limits compartidos entre geos.
- Para MainSpot (datos de pymes en México): no existe geo "MX" ni "LATAM"; la elección es global (default) o US-only (+10 %). No hay beneficio regulatorio mexicano documentado por Anthropic para "us".

### 2.11 Facturación (HECHO VERIFICADO — Pricing § Billing, soporte "How do I pay", Commercial Terms H.2)
- Todo en **USD**; prepago de créditos con tarjeta (créditos **caducan a 1 año**, **no reembolsables**, Credit Terms) o facturación mensual en arrears vía ventas (factura Stripe).
- Solo se cobran llamadas exitosas; una petición que iba a completarse y cuyo cliente se desconecta **sí** se cobra.
- Auto-reload disponible; "plus applicable taxes" al comprar créditos.
- **Impuestos**: Commercial Terms H.2: las tarifas **no incluyen impuestos**; el cliente es responsable de retenciones (withholding) y de aportar evidencia; cooperación para aplicar tratados. Soporte: nombre, dirección y datos fiscales de la factura se toman de los datos de facturación al emitirla. **No hay documentación pública específica de IVA/retención para México** → DESCONOCIDO (ver Huecos).
- México figura en la **Supported Regions Policy** (HECHO VERIFICADO — lista de países).
- Créditos mensuales de API para suscriptores Max ($100), Ultra ($200), Team (hasta $500 pooled) (HECHO VERIFICADO — anuncio Haiku 5.5): usables en cualquier modelo del Claude Platform; **no** usables en Claude Code ni apps. Esto es un detalle de cuenta/dev, no prueba de capacidad productiva; cualquier uso requeriría decisión del propietario.

### 2.12 Plataformas de marketplace operadas por Anthropic (HECHO VERIFICADO — Pricing)
- **Claude Platform on AWS** y **Claude in Microsoft Foundry**: mismas tarifas por token que la API directa, convertidas a CCU ($0.01/CCU, 100 CCU = $1), facturación mensual en arrears por el marketplace, el marketplace gestiona impuestos. Misma política de retención/ZDR que la API directa. Rate limits iguales pero sin flujo self-service "Request tier increase".

---

## 3. Rate limits, tiers y límites de gasto (HECHO VERIFICADO — Rate limits, soporte)

### 3.1 Spend caps mensuales
| Tier | Tope mensual |
|---|---|
| Evaluation (nuevas organizaciones, historial limitado) | por debajo de los límites estándar; sube automáticamente |
| Start | **$500** |
| Build | **$1,000** |
| Scale | **$200,000** |
| Custom | sin tope, con account team |

- Al alcanzar el tope: **HTTP 429** `rate_limit_error` con `error_code: enforced_spend_limit_reached`, **sin `retry-after`**; pausa hasta 00:00 UTC del día 1 del mes siguiente salvo subida de tier. Un límite propio más bajo devuelve **400** `invalid_request_error`.
- Los lotes Batch pueden exceder ligeramente el límite del workspace.

### 3.2 Rate limits Messages API por tier (RPM / ITPM / OTPM)

| Modelo | Start | Build | Scale |
|---|---|---|---|
| Haiku 5.5 | 4,000 / 2,000,000 / 400,000 | 10,000 / 5,000,000 / 1,000,000 | 13,000 / 10,000,000 / 2,000,000 |
| Sonnet 5.5 | 4,000 / 2,000,000 / 400,000 | 10,000 / 5,000,000 / 1,000,000 | 13,000 / 10,000,000 / 2,000,000 |
| Opus 5.5 | 4,000 / 2,000,000 / 400,000 | 10,000 / 5,000,000 / 1,000,000 | 13,000 / 10,000,000 / 2,000,000 |
| Haiku 4.5 / Sonnet 5 / Sonnet 4.x / Opus 5 / Opus 4.x | 1,000 / 2,000,000 / 400,000 | 5,000 / 5,000,000 / 1,000,000 | 10,000 / 10,000,000 / 2,000,000 |

- Cada modelo 5.5 tiene su **propio bucket**; Opus 4.x y Sonnet 4.x comparten buckets combinados.
- ITPM cuenta solo tokens no cacheados (`input_tokens` + `cache_creation_input_tokens`); OTPM cuenta tokens reales generados (`max_tokens` no influye). Token bucket; pueden aplicarse límites de aceleración ante picos.
- Los límites son máximos, no mínimos garantizados.

### 3.3 Cómo se sube de tier
- **No hay depósito ni compra que suba de tier**: asignación automática por historial de uso y standing (soporte, actualizado esta semana). Puede solicitarse aumento en Console cuando se usa ≥ 50 % de los límites actuales. Organizaciones vinculadas a un plan Team pasan al menos a Build.
- Implicación para MainSpot: una organización nueva arranca en Evaluation con límites **inferiores** a Start y tope ≤ $500/mes; el crecimiento de clientes debe planificarse contra el tope de gasto, no solo contra RPM.

---

## 4. Datos, privacidad y cumplimiento

| Aspecto | Hallazgo | Etiqueta | Fuente |
|---|---|---|---|
| Uso para entrenamiento (API comercial) | "By default, we will not use your inputs or outputs from our commercial products to train our models". Commercial Terms §B: "Anthropic may not train models on Customer Content from Services". Excepción: feedback explícito (thumbs up/down, reportes) → retenido 5 años y usable para entrenar | HECHO VERIFICADO | Privacy Center 7996868 (18 ago 2026); Commercial Terms (17 jun 2025) |
| Propiedad de Inputs/Outputs | El cliente retiene derechos sobre Inputs y es dueño de Outputs; Customer Content es información confidencial del cliente | HECHO VERIFICADO | Commercial Terms §B, §E.1 |
| Retención por defecto | Inputs/outputs eliminados del backend **dentro de 30 días**; excepciones: Files API, ZDR acordado, violaciones de Usage Policy (hasta 2 años; scores T&S 7 años), ley. Covered Models: 30 días obligatorios | HECHO VERIFICADO | Privacy Center 7996866 (1 jul 2026); API and data retention |
| Zero Data Retention | Por organización, **a solicitud a ventas** (no self-service); no cubre Console/playground, Managed Agents, consumer, **Batch (29 días)**, **Files API**, code execution, MCP connector, Skills, message threads; **CORS no soportado** con ZDR. Estructuras: structured outputs "Yes (qualified)" (solo el schema se cachea 24 h); prompt caching, thinking, effort, web search, data residency, PDF inline: elegibles | HECHO VERIFICADO | API and data retention |
| DPA | DPA (24 feb 2025) con SCC UE, UK Addendum y Swiss Addendum **incorporado automáticamente** al aceptar los Commercial Terms; no requiere firma separada. Si se accede por plataforma de terceros, rigen los términos de ésta | HECHO VERIFICADO | Privacy Center 7996862 (16 mar 2026); Legal Center |
| DPA — detalles (notificación de brecha 48 h, objeción a subencargados 15 días, borrado 30 días tras terminación) | DPA completo leído en la página oficial (vigente desde 24 feb 2025): **G.1** notificación de Security Breach por escrito "without undue delay, but in any event within 48 hours"; **C.3** objeción a un nuevo subencargado por escrito dentro de **15 días** de la notificación (silencio = consentimiento); **H.1** retorno o borrado de Customer Data dentro de **30 días** de terminación/expiración (con excepciones de ley, disputas y uso dañino); **I.1–I.2** SCCs Módulo 2 (controller→processor) y Módulo 3 (processor→processor) más anexos por país incorporados por referencia; auditoría a petición escrita (F.2, no más de 1×/12 meses). PDF oficial enlazado: https://assets.claude.com/d16e60156ee20e9a1c5cfff5c0cabfba39b7c9bf.pdf | HECHO VERIFICADO | https://www.anthropic.com/legal/data-processing-addendum — 2026-11-03 |
| Subencargados (lista pública, 22) | Google Cloud, AWS, Microsoft Azure (infra, worldwide); Cloudflare (CDN); Stripe (billing, US); WorkOS (SSO); Intercom, Nutun (Sudáfrica), Boldr (Canadá) (soporte); Twilio, Iterable (comunicaciones); Sentry; Sift, Arkose Labs, hCaptcha/Intuition Machines (fraude); Brave Search, TurboPuffer, Parallel Web Systems (web search); ElevenLabs (voz, Claude for Work); Persona, Yoti (verificación consumer); Palantir PFCS (C4G). Última actualización publicada: 14 oct 2026 | HECHO VERIFICADO (render de Trust Center) | trust.anthropic.com/subprocessors |
| Certificaciones "Claude via Anthropic's API" | SOC 2 Type 2 ✅, ISO 27001:2022 ✅, ISO/IEC 42001:2023 ✅, CSA STAR ✅, HIPAA ✅, NIST 800-171 ✅; FedRAMP/IL4/IL5 N/A. Documentos: SOC 2 Type 2 2025, SOC 3 2025, bridge letters ago/oct 2026, certificados ISO 2025, pen-test 2025. Bedrock/Vertex: SOC2/ISO ✅ "solo aplicable al modelo y contenedores suministrados" | HECHO VERIFICADO (render de Trust Center) | trust.anthropic.com |
| Regiones de procesamiento | Inferencia `global` (cualquier geografía disponible) o `us`; datos en reposo en workspace geo `us` (única opción). Subencargados de infra "Worldwide" | HECHO VERIFICADO | Data residency; Trust Center |
| Usage Policy (vigente/actualizada 12 nov 2026 según Legal Center) relevante para MainSpot | (1) **Todo chatbot/agente de cara al consumidor debe revelar que el usuario interactúa con IA**, al inicio de la sesión o en la interfaz (no hace falta nombrar Anthropic/Claude). (2) Prohibido crear personas/cuentas falsas, **reseñas falsas**, astroturfing, bots que se hagan pasar por humanos, ocultar patrocinio de mensajes para influir. (3) Agentes: el cliente responde por las acciones de sus agentes. (4) High-risk (salud, legal, finanzas, vivienda…) requiere persona cualificada responsable y aviso de IA. Marketing/redes sociales no está prohibido como industria | HECHO VERIFICADO | anthropic.com/legal/aup |
| Limitación de outputs | Commercial Terms D.3: el cliente debe evaluar si los outputs son apropiados, incluida revisión humana, y **notificar a sus usuarios** que las afirmaciones factuales pueden ser falsas | HECHO VERIFICADO | Commercial Terms |
| Indemnización IP | Anthropic defiende "Customer Claims" por infracción IP de outputs en uso pagado conforme a términos (con exclusiones) | HECHO VERIFICADO (texto parcial) | Commercial Terms §K |
| Términos privados | No se ha revisado ningún contrato negociado; todo lo anterior es oferta pública self-service | DESCONOCIDO | — |

Implicaciones directas para los casos de uso de MainSpot:
- `engagement.facebook.comment.reply` / `engagement.google.review.reply`: las respuestas automáticas públicas en nombre del negocio son permitidas; **MainSpot debe garantizar que no se generen reseñas falsas ni se simule ser humano cuando el usuario final conversa con el bot**. Las respuestas a comentarios publicadas como "el negocio" (con revisión del dueño) no son un chatbot de cara al consumidor en sentido estricto; un bot que conteste mensajes directos en tiempo real sí lo sería y necesitaría el aviso de IA. Esto es interpretación (HIPÓTESIS) y debería confirmarse con asesoría legal.
- `conversation.owner.assistant`: el propietario es usuario del cliente (MainSpot); aplica D.3 (aviso sobre fiabilidad de hechos).
- DEC-0071/DEC-0067: la verificación "una vez" de entrenamiento/retención/subencargados queda cubierta por esta sección; falta solo lectura íntegra del PDF del DPA y la cuestión fiscal mexicana.

---

## 5. Mismo modelo vía Amazon Bedrock y Google Cloud (Vertex / Agent Platform)

### 5.1 Disponibilidad e IDs (HECHO VERIFICADO — Models overview)
| Plataforma | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 | Procesador de datos |
|---|---|---|---|---|
| Amazon Bedrock (AWS-operated) | `anthropic.claude-haiku-5-5` | `anthropic.claude-sonnet-5-5` | `anthropic.claude-opus-5-5` | AWS |
| Google Cloud, Google-managed (Vertex/Agent Platform) | `claude-haiku-5-5` | `claude-sonnet-5-5` | `claude-opus-5-5` | Google |
| Google Cloud, Anthropic-managed | igual | igual | igual | Anthropic (misma política que API directa) |
| Microsoft Foundry | igual | igual | igual | Anthropic (hosted on Anthropic) / Azure |
| Claude Platform on AWS (marketplace) | igual | igual | igual | Anthropic |

### 5.2 Precios Bedrock, USD/MTok (HECHO VERIFICADO — endpoint de precios de aws.amazon.com/bedrock/pricing, región US East N. Virginia)

| Modelo | Input | Output | Batch in/out | Caché 5m | Caché 1h | Caché read |
|---|---|---|---|---|---|---|
| Haiku 5.5 — tabla 1 (global cross-region) | $0.10 | $0.50 | **N/A** | $0.125 | $0.20 | $0.01 |
| Haiku 5.5 long context (>100K) — tabla 1 | $0.50 | $2.50 | N/A | $0.625 | $1.00 | $0.05 |
| Sonnet 5.5 — tabla 1 | $2.00 | $10.00 | **N/A** | $2.50 | $4.00 | $0.10 |
| Opus 5.5 — tabla 1 | $4.00 | $20.00 | **N/A** | $5.00 | $8.00 | $0.20 |
| Haiku 5.5 — tabla 2 (regional/geo, +10 %) | $0.11 | $0.55 | N/A | $0.1375 | $0.22 | $0.011 |
| Haiku 5.5 long context — tabla 2 | $0.55 | $2.75 | N/A | $0.6875 | $1.10 | $0.055 |
| Sonnet 5.5 — tabla 2 | $2.20 | $11.00 | N/A | $2.75 | $4.40 | $0.11 |
| Opus 5.5 — tabla 2 | $4.40 | $22.00 | N/A | $5.50 | $8.80 | $0.22 |

- Interpretación tabla 1 = endpoints globales (precio idéntico a API directa); tabla 2 = endpoints regionales (+10 %, coherente con la nota de Anthropic "regional endpoints include a 10 percent premium"). La etiqueta exacta de cada tabla no se pudo leer en el HTML (solo el encabezado "Global Cross-region Inference" precede a la primera) → ESTIMACIÓN de etiquetado, cifras HECHO VERIFICADO.
- **Batch aparece "N/A" para los tres modelos 5.5 en Bedrock** (HECHO VERIFICADO). Bedrock también ofrece "Reserved Tier" y Provisioned Throughput (precio con account team; DESCONOCIDO).
- Nota en la página: "Starting October 7, 2026, cache read pricing for Claude Sonnet 5.5 is reduced by 50 %" (coincide con API directa).

### 5.3 Precios Google Cloud (Agent Platform / Vertex partner models), USD/MTok (HECHO VERIFICADO — cloud.google.com/model-garden/partner-models/pricing)

| Modelo | Región | Input | Output | Batch in/out | Caché 5m | Caché 1h | Caché hit | Batch caché 5m / 1h / hit |
|---|---|---|---|---|---|---|---|---|
| Haiku 5.5 (≤100K) | global | $0.10 | $0.50 | $0.05 / $0.25 | $0.125 | $0.20 | $0.01 | $0.0625 / $0.10 / $0.005 |
| Haiku 5.5 (>100K) | global | $0.50 | $2.50 | — | $0.625 | $1.00 | $0.05 | — |
| Sonnet 5.5 | global | $2.00 | $10.00 | $1.00 / $5.00 | $2.50 | $4.00 | $0.10 | $1.25 / $2.00 / $0.05 |
| Opus 5.5 | global | $4.00 | $20.00 | **$2.50 / $12.50** | $5.00 | $8.00 | $0.20 | $2.50 / $4.00 / $0.10 |
| Haiku 5.5 (≤100K) | regional/multi-región | $0.11 | $0.55 | $0.055 / $0.275 | $0.1375 | $0.22 | $0.011 | $0.06875 / $0.11 / $0.0055 |
| Sonnet 5.5 | regional | $2.20 | $11.00 | $1.10 / $5.50 | $2.75 | $4.40 | $0.11 | $1.375 / $2.20 / $0.055 |
| Opus 5.5 | regional | $4.40 | $22.00 | $2.20 / $11.00 | (5m no listado) | $8.80 | $0.22 | $2.75 / $4.40 / $0.11 |

- **Discrepancia detectada**: Google lista Batch de Opus 5.5 global a $2.50/$12.50 (= precio batch de Opus 5), mientras Anthropic directo y la fila regional de Google ($2.20/$11.00 = 1.1 × $2/$10) implican $2.00/$10.00. Parece error de la página de Google o precio distinto real → DESCONOCIDO; verificar en el SKU de facturación antes de asumirlo.
- Google cobra solo respuestas 200; precios en USD (otras monedas según Cloud SKUs). Umbral de contexto largo: Haiku 5.5 a 100K; resto de Claude a 200K (solo afecta Sonnet 4.5 en la tabla).
- Regla general Anthropic (HECHO VERIFICADO — Pricing): desde 4.5 en adelante, endpoints regionales/multi-región en Bedrock y Google-managed llevan **10 % de recargo** sobre globales; la API directa es global por defecto.

### 5.4 Diferencias no de precio (HECHO VERIFICADO salvo indicación)
- Retención/DPA: en Bedrock y Google-managed el **procesador es el proveedor cloud**; aplica su DPA, su retención y sus controles (no la ZDR de Anthropic). Certificaciones de Anthropic cubren "solo el modelo y los contenedores suministrados".
- Lifecycle: Bedrock y Google-managed fijan sus propias fechas de retiro.
- Rate limits/quotas: propios de cada cloud (no verificados aquí → DESCONOCIDO).
- `inference_geo` no aplica (la región la fija el endpoint/perfil de inferencia).
- Prompt caching en Bedrock: mínimos y nombres de campos según documentación de AWS (no verificados).
- Para MainSpot: Bedrock/Vertex son una alternativa de **cuenta y facturación** (p. ej. consolidar en una factura cloud, créditos cloud, facturación en MXN vía Google Cloud SKUs si la cuenta de facturación lo permite — HIPÓTESIS no verificada) a precio igual (global) o +10 % (regional), con la pérdida de Batch en Bedrock para 5.5. Adoptarlos requeriría una nueva decisión (no cubierta por DEC-0069).

---

## 6. Rendimiento y fiabilidad

### 6.1 Latencia/throughput publicados
- Anthropic **no publica cifras absolutas** de tokens/s ni p50/p95. Solo "latencia comparativa": Haiku 5.5 Fastest, Sonnet 5.5 Fast, Opus 5.5 Moderate, Fable 5.1 Slower; "actual latency depends on prompt length, output length, and thinking effort" (HECHO VERIFICADO — Models overview).
- Anuncio Haiku 5.5 (HECHO VERIFICADO — anthropic.com/claude-haiku-5-5): "our fastest model to date"; coste ~75 % menor que Haiku 4.5 en promedio (footnote: 90 % menor ≤100K, 50 % menor >100K, ajustado por tokenizador); testimonios de clientes: Asana ">30 % reducción de latencia… hasta 2.5× más rápido por turno"; Box "11 puntos más que Haiku 4.5 a la mitad de latencia". Son afirmaciones de terceros citadas por Anthropic, no mediciones de MainSpot.
- Anuncio Opus 5.5 (HECHO VERIFICADO — https://www.anthropic.com/claude-opus-5-5, 22 sep 2026): "costs 40% less to run than Opus 5 on typical workloads" — el **40 % es coste por tarea** (precio por token −20 %: $4/$20 vs $5/$25 — coincide con §2.1 — **más** menos tokens por tarea); lecturas de caché $0.20 ("60% less" vs $0.50); "generates output more than 30% faster than Opus 5"; fast mode "up to 2.5x speed" a $8/$40 (coincide con §2.9). Anuncio Sonnet 5.5 (HECHO VERIFICADO — https://www.anthropic.com/claude-sonnet-5-5, 28 sep 2026): mismo precio por token que Sonnet 5 ($2/$10); lecturas de caché $0.10 ("half of Sonnet 5's $0.20"); "runs 30%+ faster" y "costs up to 30% less per task". Ambos son claims del propio Anthropic sobre sus pruebas, no mediciones de MainSpot.
- **NO MEDIDO**: p50/p95 por caso de uso de MainSpot. Plan: benchmark sintético con 20 entradas por perfil de §7, 3 modelos × effort {low, medium}, streaming on, midiendo TTFT, tokens/s y `usage` real (incluido thinking) — requiere gasto estimado < $2 (ESTIMACIÓN: 8 perfiles × 20 × 6 configs × ~$0.01 medio ≈ $9.6 en el peor caso con Opus; con Haiku/Sonnet dominantes, ~$2–3), dentro del techo DEC-0068 pero pendiente de autorización.

### 6.2 Status page — último trimestre (HECHO VERIFICADO — status.claude.com, 3 nov 2026)
- Estado actual: "All Systems Operational"; componentes: claude.ai, Console, **Claude API (api.anthropic.com)**, Claude Code, Cowork, Claude for Government.
- La página de uptime histórico (`/uptime`) no expone porcentajes en HTML estático → **porcentaje de uptime 90 días DESCONOCIDO**.
- Incidentes de API visibles en la ventana 20 oct – 3 nov 2026 (todos resueltos, duraciones según el propio reporte):

| Fecha (UTC) | Modelo(s) | Duración reportada |
|---|---|---|
| 21 oct | Fable 5 (degradación) | ~40 min (19:49–20:29) |
| 23–24 oct | Fable 5.1, Sonnet 5.5, Haiku 5.5, Opus 5.5 fast | 31 min (23:28–23:59) |
| 24 oct | Opus 5.5 | 11 min (00:23–00:34) |
| 24 oct | Fable 5 / 5.1 | 35 min (05:00–05:35) |
| 25 oct | Mythos 5.1, Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 | 30 min (06:05–06:35) |
| 25 oct | Fable 5.1 | 21 min (08:08–08:29) |
| 27 oct | Sonnet 5.5 (×2) | ~42 min (09:14–09:56) y 35 min (14:42–15:17) |
| 28 oct | Conectores Gmail / Google Calendar (claude.ai/Code/Cowork, no API Messages) | horas |

- Historial completo vía API pública de Statuspage (HECHO VERIFICADO — https://status.claude.com/api/v2/incidents.json, 2026-11-03; cubre los 100 incidentes más recientes, en la práctica desde 5 ago 2026): **31 incidentes tocaron el componente "Claude API (api.anthropic.com)" entre 5 ago y 28 oct 2026** (created_at→resolved_at; suma acumulada ≈ 2,933 min, que incluye incidentes no de modelos: p. ej. "Delayed credits" 376 min el 1 oct y "Elevated latency on the Claude API" 101 min el 10 sep). Correcciones a la tabla de arriba —las horas mostradas en la página web no coinciden exactamente con los campos created_at/resolved_at de la API, que aquí se toman como registro canónico:
  - 23–24 oct: 23:37→00:11 = **34 min, severidad critical** (la página mostraba 31 min; haiku 5.5 sí figura en el título del incidente).
  - 24 oct Opus 5.5: 00:31→00:37 = **6 min** (la página mostraba 11 min).
  - 24 oct Fable 5/5.1: 05:16→05:53 = **37 min** (página: 35 min).
  - 25 oct: 06:14→07:53 = **99 min** ("Sonnet 5.5 and other models"; la página mostraba 30 min 06:05–06:35) y 08:17→08:49 = **32 min** Fable 5.1 (página: 21 min).
  - 27 oct Sonnet 5.5 ×2: 09:14→09:56 (42 min, major) y **15:09→15:50 (41 min, major)** (la página mostraba 14:42–15:17, 35 min).
- Lectura: en 2 semanas hubo **7 incidentes de "elevated errors"** que tocaron Sonnet 5.5 en 4 ocasiones; con los timestamps de la API, Sonnet 5.5 acumula ≈ **4.3 h** (42+41+99+34 min) en la ventana 20 oct–3 nov (la lectura de la página estimaba ≈2.3 h). Ningún incidente > 1 h exclusivamente de modelos en la ventana corta, aunque en el trimestre sí los hubo (p. ej. 177 min el 3 sep, 204 min el 24 ago). Esto respalda diseñar reintentos con backoff y, para lo diferible, Batch; no respalda un único modelo sin alternativa de degradación (p. ej. Sonnet 5.5 → Haiku 5.5 a effort high para tareas de texto no críticas; HIPÓTESIS de diseño, no autorizada).
- El porcentaje de uptime 90 días sigue DESCONOCIDO: el HTML carga las barras de forma diferida desde un endpoint `/uptime_showcase` (JSON con valores `ninety/sixty/thirty`), que respondió vacío por GET sin sesión; requiere navegador con render.

---

## 7. Costo por llamada de perfiles MainSpot (ESTIMACIÓN)

Supuestos y fórmula:
- Precios de §2.1, API directa, `inference_geo: global`, Haiku 5.5 en tramo ≤100K (todos los perfiles están muy por debajo).
- `in`/`out` = tokens del perfil. Los tokens de salida son los **visibles**; el thinking adaptativo (facturado como output) **no está incluido** (ver sensibilidad).
- "cache70": régimen estacionario con el 70 % del input como prefijo cacheado leído a precio de lectura y el 30 % restante a precio base: `coste = (0.3·in·P_in + 0.7·in·P_read + out·P_out) / 1e6`. La primera llamada paga además escritura 5 min: `0.7·in·(P_write5m − P_in)/1e6` (tabla aparte).
- Turno de asistente: 2 llamadas × 4,000 tokens de entrada + **286 tokens de system prompt de tool use por llamada** (§2.5), 500 tokens de salida en total; sin Batch (interactivo).
- Batch = 50 % sobre todo; "cache+batch" apila ambos (la documentación afirma que los multiplicadores se apilan).
- Clasificación corta: 70 % de 800 = 560 tokens ≥ 512 mínimo cacheable (justo); si el prefijo real baja de 512 tokens no habrá caché.

### 7.1 Coste por llamada, USD

| Perfil | Tokens in/out | Haiku 5.5 std | Haiku cache70 | Haiku batch | Haiku cache+batch | Sonnet 5.5 std | Sonnet cache70 | Sonnet batch | Sonnet cache+batch | Opus 5.5 std | Opus cache70 | Opus batch | Opus cache+batch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Clasificación corta | 800/60 | 0.000110 | 0.000060 | 0.000055 | 0.000030 | 0.002200 | 0.001136 | 0.001100 | 0.000568 | 0.004400 | 0.002272 | 0.002200 | 0.001136 |
| Respuesta a comentario | 1,500/200 | 0.000250 | 0.000156 | 0.000125 | 0.000078 | 0.005000 | 0.003005 | 0.002500 | 0.001502 | 0.010000 | 0.006010 | 0.005000 | 0.003005 |
| Post Facebook 3 variantes | 2,500/900 | 0.000700 | 0.000543 | 0.000350 | 0.000271 | 0.014000 | 0.010675 | 0.007000 | 0.005338 | 0.028000 | 0.021350 | 0.014000 | 0.010675 |
| Diseño web inicial | 6,000/7,000 | 0.004100 | 0.003722 | 0.002050 | 0.001861 | 0.082000 | 0.074020 | 0.041000 | 0.037010 | 0.164000 | 0.148040 | 0.082000 | 0.074020 |
| Edición simple | 5,000/600 | 0.000800 | 0.000485 | 0.000400 | 0.000243 | 0.016000 | 0.009350 | 0.008000 | 0.004675 | 0.032000 | 0.018700 | 0.016000 | 0.009350 |
| Edición compleja | 7,000/3,500 | 0.002450 | 0.002009 | 0.001225 | 0.001004 | 0.049000 | 0.039690 | 0.024500 | 0.019845 | 0.098000 | 0.079380 | 0.049000 | 0.039690 |
| Turno asistente (2 tool calls) | (4,000+286)×2 / 500 | 0.001107 | 0.000603 | n/a | n/a | 0.022144 | 0.011504 | n/a | n/a | 0.044288 | 0.023008 | n/a | n/a |
| Insight mensual | 6,000/1,200 | 0.001200 | 0.000822 | 0.000600 | 0.000411 | 0.024000 | 0.016020 | 0.012000 | 0.008010 | 0.048000 | 0.032040 | 0.024000 | 0.016020 |

Sobrecoste de la **primera** llamada por escritura de caché 5 min (ESTIMACIÓN):

| Perfil | Tokens cacheados | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|---|
| Clasificación corta | 560 | +0.000014 | +0.000280 | +0.000560 |
| Respuesta a comentario | 1,050 | +0.000026 | +0.000525 | +0.001050 |
| Post Facebook | 1,750 | +0.000044 | +0.000875 | +0.001750 |
| Diseño web inicial | 4,200 | +0.000105 | +0.002100 | +0.004200 |
| Edición simple | 3,500 | +0.000087 | +0.001750 | +0.003500 |
| Edición compleja | 4,900 | +0.000122 | +0.002450 | +0.004900 |
| Turno asistente | 2,800 | +0.000070 | +0.001400 | +0.002800 |
| Insight mensual | 4,200 | +0.000105 | +0.002100 | +0.004200 |

### 7.2 Lecturas rápidas (ESTIMACIÓN)
- Relación de precio Haiku : Sonnet : Opus ≈ **1 : 20 : 40** en todos los perfiles (porque input y output escalan igual).
- El caché recorta ~45–50 % en perfiles dominados por input (clasificación, edición simple, asistente) y solo ~5–10 % en perfiles dominados por output (diseño web).
- El perfil más caro es **diseño web inicial** por sus 7,000 tokens de salida: $0.082 en Sonnet, $0.164 en Opus por intento; un rediseño con 2 reintentos en Opus ≈ $0.49.
- Ejemplo de mix mensual por cliente (HIPÓTESIS de volúmenes: 300 clasificaciones, 60 respuestas, 12 posts, 0.25 diseños, 8 ediciones simples, 2 complejas, 40 turnos de asistente, 1 insight): todo en Haiku ≈ **$0.11** (std) / $0.07 (cache70); todo en Sonnet ≈ **$2.28** / $1.30; todo en Opus ≈ **$4.57** / $2.60. Con tipo de cambio hipotético 18–20 MXN/USD, un plan de MXN $500 soportaría el mix completo en Sonnet con margen amplio **antes** de thinking, reintentos, imágenes e infraestructura (que no están en esta tabla).
- Sensibilidad thinking (HIPÓTESIS): si el thinking adaptativo añade +50 % de output, los perfiles con mucho output (diseño, edición compleja) suben ~35–45 %; los de poco output (clasificación) suben <10 %. Debe medirse con `usage.output_tokens` real.
- Sensibilidad inference_geo "us": +10 % lineal en todo.

### 7.3 Lo que NO está en estos números
- Reintentos/reparaciones por salida inválida; refusals (se facturan).
- Tokens de `tools` (definiciones) en el asistente más allá del system prompt de 286; `tool_result` grandes.
- Web search ($10/1,000) si se usara en insights o campañas.
- Thinking adaptativo (ver arriba) y el +30 % del nuevo tokenizador si se comparan con cifras medidas en Sonnet 4.6/OpenRouter.
- Imágenes (no es capacidad de Anthropic; ver evidencia OpenAI).

### 7.4 Contraste con los tokens medidos en el laboratorio (MEDICIÓN PROPIA)

Fuente: `evidence/lab-traces.md` — tabla `ai_invocation`, 310 invocaciones del 2026-10-30, **vía OpenRouter**, promedios por invocación exitosa **incluyendo sus reparaciones**; n pequeño (3–12 éxitos por caso), negocios sintéticos. Los tokens medidos de entrada incluyen la traducción del `response_format` JSON Schema que OpenRouter hace hacia Anthropic (esquema inyectado como herramienta/prompt); la vía directa puede diferir (el adaptador directo de SOL MAIN activa `output_config.format` solo si el esquema tiene ≤16 uniones/≤24 opcionales — discrepancia D3 del inventario —, y sin Anthropic directo activo (DEC-0073, §8.1) no hay medición de la vía directa).

| Perfil de §7 (in/out) | Medido Haiku 5.5 vía OR (in/out) | Caso de uso medido | Δ input | Δ output | Coste medido vs perfil std (Haiku) |
|---|---|---|---|---|---|
| Clasificación corta 800/60 | — sin medición Anthropic | la vía medida es Jev/TypeSafe: 804/140, $0.000034 | — | — | — |
| Respuesta a comentario 1,500/200 | 1,287/249 | engagement.facebook.comment.reply | −14 % | +25 % | $0.000253 vs $0.000250 (+1 %) |
| Post Facebook 3 variantes 2,500/900 | 4,424/2,550 | social.facebook.post.compose | +77 % | +183 % | $0.001717 vs $0.000700 (+145 %) |
| Diseño web inicial 6,000/7,000 | 4,029/3,396 | website.initial.design | −33 % | −51 % | $0.002101 vs $0.004100 (−49 %) |
| Edición simple 5,000/600 | — sin éxitos Haiku (0/10: circuit_open/provider_unavailable) | — | — | — | — |
| Edición compleja 7,000/3,500 | — sin éxitos Haiku (0/2) | — | — | — | — |
| Turno asistente ≈4,286/250 por llamada | 4,729/427 por invocación | conversation.owner.assistant | +10 % | +71 % | $0.000686/invocación; el perfil ($0.001107) asume 2 llamadas |
| Insight mensual 6,000/1,200 | 2,135/677 | business.insights.generate | −64 % | −44 % | $0.000552 vs $0.001200 (−54 %) |

Lecturas (MEDICIÓN PROPIA/ESTIMACIÓN):
- **Coherencia de precios confirmada**: el costo registrado coincide exactamente con la tarifa directa verificada de §2.1 aplicada a los tokens medidos: diseño 4,029×$0.10/MTok + 3,396×$0.50/MTok = $0.002101 (= costo medido); ídem compose ($0.001717), respuesta ($0.000253), insights ($0.000552), asistente ($0.000686). Es decir, OpenRouter no aplicó sobreprecio por token frente a la tarifa directa de Anthropic en estas trazas (la verificación del catálogo de OpenRouter corresponde al entregable 02, no aquí).
- Los perfiles **sobreestiman** diseño (~1.5–2×), insights (~2.2×) y respuesta en input (+14 % de holgura), y **subestiman** compose (~2.8× el output y ~1.8× el input). En compose, el 80 % de reparaciones (la conversación completa se paga dos veces) y el esquema traducido inflan el promedio; sin descomposición no se sabe cuánto es reparación vs esquema vs tokenizador (+30 % vs Sonnet 4.6, §1.1). Sonnet 5.5 no tiene éxitos medidos (0/3: blocked_external).
- Recomendación para `04-unit-economics.py`: usar los tokens medidos donde existan (respuesta, compose, diseño, asistente, insights) y mantener los tokens de perfil solo para clasificación y ediciones (sin medición Anthropic), etiquetados ESTIMACIÓN; distinguir coste "por éxito" de "incluyendo fallos con costo" (compose: $0.001794 con fallos vs $0.001717 por éxito).
- El dispatcher no envía `cache_control`: ningún dato medido incluye ahorro de caché; el régimen cache70 de §7.1 sigue siendo hipótesis de diseño (hueco en lab-traces).

---

## 8. Resumen para la comparación de proveedores
- Anthropic API directa es viable para todo el texto de MainSpot con tres puntos de precio claros; Haiku 5.5 cambia la economía de clasificación/respuestas (≈$0.0001–0.0003 por evento) y es candidato a competir con Jev en coste nominal, aunque **calidad y p95 no están medidos**.
- El bloqueo de structured outputs con 17 uniones está documentado (límite 16) y strict tool use no lo evita; la solución es de diseño de schema/flujo.
- Riesgos de cuenta: tope de gasto $500/mes en Start (y menor en Evaluation), créditos prepagados que caducan en 1 año, sin Priority Tier comprable, incidentes cortos pero frecuentes en Sonnet 5.5 en las últimas dos semanas.
- Privacidad: sin entrenamiento por defecto, 30 días de retención, DPA automático, SOC 2/ISO 27001/ISO 42001 verificados; ZDR solo por ventas y excluye Batch/Files.
- Bedrock/Vertex: mismo precio global, +10 % regional, sin Batch en Bedrock para 5.5; alternativa de facturación/cuenta, no de precio.

### 8.1 Implicación DEC-0073 (hechos, sin decidir)

Hechos (fuente: `01-inventory.md` §8.0/§8.4, verificados con `git`/hashes sobre SOL MAIN; no interpretación):
- **DEC-0069** (ingestado en `d297e8a`, 2026-11-03 00:41, sigue vigente en canon): "TypeSafe directo (Jev); **Anthropic directo prioritario** para texto; OpenAI directo `gpt-image-2` para imágenes; OpenRouter fuera de nuevas ejecuciones y sin fallback".
- **DEC-0073** (commit `1f1c7da`, 2026-11-03 03:25): OpenAI para **toda** la generación en desarrollo. La migración `0029_ai_openai_development.sql` ejecuta `UPDATE ai_provider SET status = 'disabled' WHERE kind = 'anthropic'` y comenta literalmente: «configuración actual de desarrollo, no selección comercial irreversible» y «Anthropic conserva adaptador/modelos/evidencia como alternativa técnica, fuera de operación». No se activan rutas OpenAI sin evaluación y aprobación previas. Candidatas de desarrollo reasignadas vía OpenAI (inventario §8.4): diseño → `oa:gpt-6.1-sol` (0.25) / `oa:gpt-6-luna` (0.05); edición compleja → Sol (0.2) / Luna (0.05); compose/creatives → Luna (0.03); edición simple → Luna (0.02). La discrepancia D12 del inventario registra la tensión entre ambas decisiones.

Lo que el desarrollo deja de ejercer mientras Anthropic esté deshabilitado (hechos de código + este archivo):
- La ruta de structured outputs nativa (`output_config.format`) y su enforcement de límites (≤16 uniones / ≤24 opcionales, implementado en `anthropic.ts` como `STRUCTURED_OUTPUT_LIMITS`): el problema de las 17 uniones de `website.edit.*` no volverá a manifestarse en dev con OpenAI, y el criterio de conteo del adaptador ("uniones en todo el árbol", D3) no se podrá calibrar contra el comportamiento real de la API.
- La medición del efecto del tokenizador Anthropic (+30 % vs 4.6, §1.1) y del thinking adaptativo facturado como output (§2.6): solo medibles con Anthropic directo.
- El ahorro cache70 (§7.1): el dispatcher no envía `cache_control` y, con Anthropic deshabilitado, no hay vía para medirlo en dev.

Lo que gana el desarrollo (según lo medido): costo por tarea menor vía Luna — 2–2.5× menos tokens de entrada que Haiku en los mismos prompts (lab-traces, hallazgo 3) — y una sola integración (Responses `store:false`) para texto e imágenes.

Alcance: esta configuración es de desarrollo; la selección de producción sigue siendo decisión del propietario (D12). Este archivo aporta la evidencia de precios/límites/privacidad de Anthropic para esa comparación y no recomienda activar ni mantener deshabilitado Anthropic.

---

## Fuentes

1. Pricing — Claude Platform Docs — https://platform.claude.com/docs/en/about-claude/pricing — 2026-11-03 — tabla de precios por modelo, caché, batch, long context, tool use (286 tokens), web search $10/1k, web fetch, code execution, fast mode, data residency 1.1×, CCU en AWS/Foundry, facturación USD, tiers.
2. Models overview — https://platform.claude.com/docs/en/models/overview — 2026-11-03 — IDs API/Bedrock/Google/Foundry, contexto 1M, salida 128K/300K batch, effort por defecto, latencia comparativa, retiros, tokenizador +30 %.
3. Model deprecations — https://platform.claude.com/docs/en/about-claude/model-deprecations — 2026-11-03 — estados, fechas de retiro, Sonnet 4.5 deprecado al 30 nov 2026, política de 60 días, parámetros eliminados.
4. Claude Haiku 5.5 overview — https://platform.claude.com/docs/en/models/haiku-5-5/overview — 2026-11-03 — lanzamiento 7 oct 2026, precios por tramo, mínimo caché 512, plataformas.
5. Claude Opus 5.5 overview — https://platform.claude.com/docs/en/models/opus-5-5/overview — 2026-11-03 — lanzamiento 22 sep 2026, thinking siempre activo, effort medium.
6. Claude Sonnet 5.5 overview — https://platform.claude.com/docs/en/models/sonnet-5-5/overview — 2026-11-03 — lanzamiento 28 sep 2026, effort high.
7. Structured outputs — https://platform.claude.com/docs/en/build-with-claude/structured-outputs — 2026-11-03 — límites 20/24/16, timeout 180 s, features soportadas/no, caché de gramática 24 h, prompt inyectado, refusals, casing de enum, ZDR qualified.
8. Strict tool use — https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use — 2026-11-03 — remite a las mismas limitaciones de schema.
9. Rate limits — https://platform.claude.com/docs/en/api/rate-limits — 2026-11-03 — spend caps $500/$1,000/$200,000, tablas RPM/ITPM/OTPM por tier, ITPM cache-aware, límites Batch, Evaluation tier, errores 429/400.
10. Batch processing — https://platform.claude.com/docs/en/build-with-claude/batch-processing — 2026-11-03 — 50 %, <1 h típico, 24 h expiración, 29 días resultados, límites 100k/256 MB, no ZDR, parámetros no soportados.
11. Prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching — 2026-11-03 — mínimos 512/2,048, TTL, pre-warm, retención en memoria.
12. Effort — https://platform.claude.com/docs/en/build-with-claude/effort — 2026-11-03 — niveles, defaults por modelo, thinking disabled/between_tools, recomendaciones.
13. Thinking — https://platform.claude.com/docs/en/build-with-claude/thinking — 2026-11-03 — thinking facturado como output, cuenta en max_tokens, resumen vs. cobro.
14. Service tiers — https://platform.claude.com/docs/en/api/service-tiers — 2026-11-03 — Priority Tier legacy, no se vende, no soportado en 5.5.
15. Data residency — https://platform.claude.com/docs/en/manage-claude/data-residency — 2026-11-03 — inference_geo global/us, workspace geo us, 1.1×.
16. API and data retention — https://platform.claude.com/docs/en/manage-claude/api-and-data-retention — 2026-11-03 — ZDR por organización vía ventas, exclusiones (Batch, Files, Console, CORS), tabla de elegibilidad, Covered Models 30 días, HIPAA.
17. Privacy Center — How long do you store my organization's data? — https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data — 2026-11-03 (artículo 1 jul 2026) — 30 días, excepciones, 2 años por violaciones, feedback 5 años.
18. Privacy Center — Is my data used for model training? — https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training — 2026-11-03 (18 ago 2026) — no entrenamiento por defecto, feedback.
19. Privacy Center — How do I view and sign your DPA? — https://privacy.anthropic.com/en/articles/7996862-how-do-i-view-and-sign-your-data-processing-addendum-dpa — 2026-11-03 (16 mar 2026) — DPA incorporado automáticamente.
20. Commercial Terms of Service — https://www.anthropic.com/legal/commercial-terms — 2026-11-03 (versión 17 jun 2025) — §B Customer Content/no training, D.3 notice to users, D.4 restricciones, E confidencialidad, H.2 impuestos/withholding, K indemnización.
21. Legal Center — https://www.anthropic.com/legal — 2026-11-03 — fechas de versión: Commercial Terms 17 jun 2025, DPA 24 feb 2025, Usage Policy 12 nov 2026, Service Specific Terms 31 ago 2026, Supported Regions 12 nov 2026, Credit Terms 4 mar 2024.
22. Usage Policy — https://www.anthropic.com/legal/aup — 2026-11-03 — disclosure de IA en chatbots de consumidor, prohibición de reseñas falsas/personas falsas, agentic use, high-risk.
23. Supported countries — https://www.anthropic.com/supported-countries — 2026-11-03 — México listado.
24. Trust Center (render Chromium) — https://trust.anthropic.com/ y /subprocessors — 2026-11-03 — matriz SOC 2 Type 2 / ISO 27001 / ISO 42001 / CSA STAR / HIPAA / NIST 800-171 por producto; lista de 22 subencargados; update 14 oct 2026.
25. Help Center — How can I get higher rate limits? — https://support.claude.com/en/articles/10366389-how-can-i-get-higher-rate-limits-on-the-claude-api — 2026-11-03 — tiers automáticos, sin depósito, solicitud al 50 % de uso.
26. Help Center — How do I pay for my Claude API usage? — https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage — 2026-11-03 — créditos prepago, caducidad 1 año, no reembolsables, auto-reload, facturación mensual vía ventas, cobro de peticiones desconectadas.
27. Help Center — Understanding your Claude API invoices — https://support.claude.com/en/articles/16608069-understanding-your-claude-api-invoices — 2026-11-03 — datos fiscales de factura según billing details.
28. Anuncio Claude Haiku 5.5 — https://www.anthropic.com/claude-haiku-5-5 — 2026-11-03 — 7 oct 2026, 75 % más barato (footnote 90 %/50 %), rebaja cache read Sonnet 5.5 a $0.10, créditos mensuales Max/Ultra/Team, testimonios de latencia.
29. AWS Bedrock pricing — https://aws.amazon.com/bedrock/pricing/ (tabla resuelta vía https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/{public/48fdab7f-…/51, public/9cc355ee-…/26}.json, región US East N. Virginia) — 2026-11-03 — precios Claude 5.5 global y regional, Batch N/A, nota cache read Sonnet 5.5.
30. Google Cloud Partner Models Pricing — https://cloud.google.com/model-garden/partner-models/pricing — 2026-11-03 — tablas Claude global y regional, batch, caché, umbrales 100K/200K, cobro solo 200.
31. Google Cloud Agent Platform pricing — https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing — 2026-11-03 — USD, cobro solo 200, remite a partner models.
32. Claude Status — https://status.claude.com/ — 2026-11-03 — estado operativo, incidentes 20 oct–3 nov 2026.
33. Búsquedas web (SNIPPET) — **cerradas en la auditoría del 2026-11-03**: los claims de Opus 5.5/Sonnet 5.5 quedaron verificados leyendo las páginas de anuncio (fuentes 35–36) y el DPA completo se leyó en su página oficial (fuente 34).
34. DPA (texto completo) — https://www.anthropic.com/legal/data-processing-addendum — 2026-11-03 — vigente 24 feb 2025; G.1 brecha ≤48 h, C.3 objeción a subencargados 15 días, H.1 borrado/retorno 30 días, I.1–I.2 SCCs Módulo 2/3 incorporados; PDF: https://assets.claude.com/d16e60156ee20e9a1c5cfff5c0cabfba39b7c9bf.pdf.
35. Anuncio Claude Opus 5.5 — https://www.anthropic.com/claude-opus-5-5 — 2026-11-03 — 22 sep 2026; 40 % menos coste por tarea (precio por token −20 %), caché $0.20 (−60 %), >30 % más rápido, fast mode 2.5× a $8/$40.
36. Anuncio Claude Sonnet 5.5 — https://www.anthropic.com/claude-sonnet-5-5 — 2026-11-03 — 28 sep 2026; mismo precio por token que Sonnet 5, caché $0.10 (mitad), 30 %+ más rápido, hasta 30 % menos por tarea.
37. Claude Status API (Statuspage) — https://status.claude.com/api/v2/summary.json y https://status.claude.com/api/v2/incidents.json — 2026-11-03 — componentes y 31 incidentes tocando "Claude API (api.anthropic.com)" desde 5 ago 2026 (resumen y correcciones en §6.2).

## Huecos

1. **Porcentaje de uptime 90 días** de api.anthropic.com: la página `/uptime` no lo expone en HTML (las barras se cargan de forma diferida desde `/uptime_showcase`, que respondió vacío por GET sin sesión el 2026-11-03). Verificación: abrir `https://status.claude.com/uptime` en navegador con render, o derivar un porcentaje agregando duraciones de `https://status.claude.com/api/v2/incidents.json` (ver §6.2; no equivale al uptime oficial).
2. **~~Historial completo del trimestre~~ CERRADO 2026-11-03**: leído vía `https://status.claude.com/api/v2/incidents.json` (los 100 incidentes más recientes, desde 5 ago 2026); resumen en §6.2.
3. **Latencia/throughput absolutos** (TTFT, tokens/s, p50/p95) por modelo y effort: Anthropic no los publica. Verificación: benchmark propio NO MEDIDO (plan en §6.1), requiere autorización de gasto bajo DEC-0068.
4. **Coste real de thinking adaptativo** por perfil y effort: no medido. Verificación: mismas ejecuciones del benchmark, leyendo `usage.output_tokens` frente a tokens visibles.
5. **Impuestos para cliente en México** (IVA en factura de Anthropic PBC, retención ISR, CFDI): no documentado públicamente más allá de H.2 ("fees exclude taxes; customer responsible for withholding"). Verificación: consulta a `support@anthropic.com`/ventas y asesoría fiscal; revisar una factura real de Stripe de la cuenta de desarrollo (sin exponer datos) para ver si se desglosa impuesto.
6. **~~Texto íntegro del DPA~~ CERRADO 2026-11-03**: leído en la página oficial (G.1 48 h, C.3 15 días, H.1 30 días, I.1–I.2 SCCs — ver §4 y fuente 34).
7. **Discrepancia Batch Opus 5.5 en Google Cloud** ($2.50/$12.50 vs $2/$10 esperado). Verificación: consultar SKUs de Cloud Billing para `Claude Opus 5.5 Batch` o confirmar con soporte de Google.
8. **Etiquetado exacto de las dos tablas Bedrock** (global vs. regional/geo): inferido por el +10 % y el encabezado "Global Cross-region Inference"; verificación visual en navegador con el selector de región.
9. **Rate limits y quotas en Bedrock/Vertex** para Claude 5.5, mínimos de caché en Bedrock y retención de datos de cada cloud: no consultados. Verificación: docs de AWS Bedrock (quotas, prompt caching) y Google Cloud (quotas partner models, data governance).
10. **Tokens de system prompt de tool use con `tool_choice: any/tool`** para Sonnet 5.5 y Opus 5.5: la tabla oficial deja la celda vacía. Verificación: `POST /v1/messages/count_tokens` con y sin `tools` (gratuito, cuenta para rate limit pero no para gasto) — permitido sin coste pero requiere clave de API; no ejecutado.
11. **~~Anuncios Opus 5.5 y Sonnet 5.5~~ CERRADO 2026-11-03**: claims verificados leyendo las páginas de anuncio (HECHO VERIFICADO — ver §6.1 y fuentes 35–36).
12. **Interpretación de la Usage Policy** sobre respuestas automáticas a comentarios/reseñas publicadas en nombre del negocio (si constituyen "consumer-facing chatbot" que exige aviso de IA): requiere lectura legal; no es un hecho verificable en la página.
13. **Términos negociados** (volumen, ZDR, facturación en arrears): no revisados; todo lo documentado es oferta pública self-service.
14. **Tokens con Anthropic directo** (sin la traducción de schema de OpenRouter): la comparación de §7.4 usa trazas vía OpenRouter; con Anthropic deshabilitado en desarrollo (DEC-0073, §8.1) no hay vía para medir la directa. Cerrar con el benchmark B-TXT de `03-quality-benchmarks.md` contra el adaptador directo cuando vuelva a estar activo o en un laboratorio desechable autorizado (DEC-0068).
