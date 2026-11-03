# Evidencia — Proveedores de imágenes (API directa): Gemini/Nano Banana, FLUX (bfl.ai), Seedream (BytePlus ModelArk), MAI-Image (Azure AI Foundry), Ideogram, Recraft; comparación con `gpt-image-2`

Fecha de consulta de **todas** las fuentes: **2026-11-03**. Moneda: **USD**. Unidad: por imagen (o por megapíxel/1M tokens donde se indique).
Alcance: investigación, sin llamadas pagadas (no se ejecutó ninguna petición a ninguna API de generación de imágenes). Sin llamadas pagadas también el `dry_run` de Ideogram (marcado NO MEDIDO).

Etiquetas: **HECHO VERIFICADO** = leído con `read` en la URL oficial citada; **SNIPPET** = visto solo en resultado de búsqueda o página secundaria; **MEDICIÓN PROPIA** = datos del laboratorio; **ESTIMACIÓN** = cálculo propio (se muestra la fórmula); **HIPÓTESIS** = supuesto razonado; **DESCONOCIDO** = no verificable en fuentes públicas a la fecha.

Contexto de política (no se modifica): DEC-0069 fija OpenAI directo `gpt-image-2` para imágenes (ver `evidence/openai.md` para cifras cruzadas); DEC-0071/DEC-0067 condiciones de datos; DEC-0068 techo de laboratorio USD 25. Este documento es comparación de estudio y propuesta en papel; **no autoriza ni activa proveedor alguno**.

---

## 0. Resumen ejecutivo

| Pregunta | Veredicto breve |
| --- | --- |
| ¿Qué familia de Google es vigente y con precio público? | Nano Banana 2.1 (`gemini-nano-banana-2.1`, oct 2026): **$0.0336/img 1K**, $0.0504 2K, $0.113 4K, Batch −50 %; entrada $1.50/M. Nano Banana Pro (`gemini-3-pro-image`): $0.134/img 1K–2K, $0.24 4K. Imagen 4 en Gemini API **apagada 2026-08-17**. | HECHO VERIFICADO |
| ¿FLUX (BFL) directo es viable? | Sí en API (`api.bfl.ai`): FLUX 3 Image $0.041–0.607/img por tier; Klein $0.008–0.036; FLUX.2 por MP. **Advertencia contractual:** los FLUX API Service Terms otorgan a BFL licencia perpetua e irrevocable sobre Entradas **y Salidas**, explícitamente **para entrenar sus modelos** (§2b). | HECHO VERIFICADO |
| ¿Seedream (BytePlus ModelArk)? | Sí, API estilo OpenAI (`/v3/images/generations`): `dola-seedream-5-0-pro-260628` $0.045 (≤2.61 Mpx) / $0.09 (>2.61 Mpx); flash $0.018; lite $0.035; texto en imagen **nativo en español y 14 idiomas**; edición con hasta 10 imágenes de referencia; límite 500 IPM; región documentada `ap-southeast-1`. | HECHO VERIFICADO |
| ¿MAI-Image en Azure AI Foundry? | Sí: MAI-Image-2 (GA, precio oficial «desde» $5/M tokens texto + $33/M tokens imagen salida) y MAI-Image-2.5/2.5-Flash/2.5-Pro/2.6/2.6-Flash (todos **Preview**; página de precios Azure solo render JS → montos **DESCONOCIDOS** desde fuente oficial). Edición por multipart con hasta 5 imágenes de referencia; máx 2 359 296 px (2.6) / 1 048 576 px (2.5). | HECHO VERIFICADO + DESCONOCIDO |
| ¿Ideogram y Recraft API? | Ambas existen y son facturables. Recraft publica tabla completa (V4.1 Flash **$0.007/img**; V4.1 raster $0.035; V3 i2i/inpaint/outpaint $0.04). Ideogram documenta la API pero **no publica tabla estática de precios** (la lista vive en la app; se puede cotizar con `dry_run=true` sin generar ni cobrar → NO MEDIDO). | HECHO VERIFICADO (Recraft) / DESCONOCIDO (precio Ideogram) |
| ¿Quién lidera los rankings fechados? | **Artificial Analysis T2I (2026-11-03):** 1) GPT Image 2.5 Sunburst (max) 1223, 4) Nano Banana 2.1 1176, 11) FLUX 3 Image 1119, 16) Seedream 5.0 Pro 1101. **AA Image Editing (2026-11-03):** 1) GPT Image 2.5 Sunburst 1199, 2) MAI-Image-2.7-Preview (sin API) 1196, 5) Nano Banana 2.1 1151, 9) Seedream 5.0 Pro 1129. **LMArena T2I (2026-10-26, espejo oficial):** 1) GPT-Image-2.5 Sunburst 1427, 5) Nano Banana 2.1 1325, 14) Seedream 5.0 Pro 1250, 28) FLUX.2 [max] 1161. | HECHO VERIFICADO (AA) / SNIPPET+espejo (LMArena) |
| ¿Costo por imagen ENTREGADA (2 generadas, 1 elegida, reintento 1.3)? | Web 16:9 estándar: **$0.09–0.13** (Nano Banana 2.1/Seedream flash)…**$0.18** (FLUX 3 Image 1.5K); alta 2K: $0.13–0.30; 4K: $0.29 (NB 2.1)…$1.58 (FLUX 3 Image 4K). Social 1:1 1024²: **$0.09–0.14** estándar; edición: **$0.04–0.07** por imagen editada entregada. Ver §10. | ESTIMACIÓN |
| ¿Conviene reemplazar gpt-image-2 (DEC-0069)? | En generación volumétrica, Nano Banana 2.1 ofrece calidad comparable (AA #4–5 T2I/editing) a **~30–60 % del costo** por imagen entregada; gpt-image-2.5 Sunburst lidera rankings pero con precio alto ($0.134+/img 1K). En edición con hasta 16 imágenes de entrada y ZDR, `gpt-image-2` sigue siendo el más flexible documentado. Propuesta trazable en §11; **no se decide aquí**. | ESTIMACIÓN/HIPÓTESIS |

---

## 1. Casos de uso y matriz de capacidades

Subcasos de la tarea: **(a) generación web 16:9 (~1536×1024 o mayor)**, **(b) generación social (1:1, 4:5)**, **(c) generación social con texto legible en español (promos, precios)**, **(d) edición/adaptación de imágenes existentes del negocio** (cambiar fondo, re-encuadre por canal, variaciones manteniendo producto/logo), **(e) consistencia de marca** (producto/logo), **(f) texto en imagen**. Capacidad faltante hoy: `website.image.generate` y `social.facebook.image.generate` están **BLOCKED** en el catálogo (`src/ai/catalog.ts`, familia de imágenes sin proveedor activo).

| Capacidad | Gemini Nano Banana 2.1 | Nano Banana Pro | FLUX 3 Image | FLUX.2 [pro/max] | Seedream 5.0 pro | MAI-Image-2.5/2.6 | Ideogram 3.0 | Recraft |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Aspect ratios 16:9 y 1:1 | Sí (tabla nativa) | Sí | Sí (enum 15 ratios) | Sí | Sí (1:1, 16:9, 21:9… tabla) + `widthxheight` libre | Libre `width×height` (≥768 cada lado) | Sí (enum) | Sí (docs de modelo) |
| 4:5 | Sí (928×1152 @1K) | Sí | Sí (enum 4:5) | Sí | No en tabla de presets; sí con `widthxheight` explícito | Sí (con dims) | Sí | Sí |
| Edición con referencias múltiples | Hasta **14** imágenes de referencia (10 objetos + 4 personajes) | Hasta 14 (6 objetos + 5 personajes + 3 estilo) | **1–10** imágenes | Hasta 10 (FLUX 3) / FLUX.2 pro edita | **Hasta 10** (pro/flash); hasta 14 (lite/4.5/4.0) | **Hasta 5** (multipart) | Hasta 10 estilo + máscara de personaje | Estilos (+$0.005) |
| Máscara/inpainting explícita | No documentada (edición conversacional) | No documentada | Bounding boxes; FLUX.1 Fill [pro] $0.05 inpainting | — | Marcas libres + `<bbox>`/`<point>` (edición interactiva) | Form multipart sin máscara documentada | Máscara de personaje | Inpainting/outpainting V3 |
| Texto en imagen (ES) | Sí («accurate text rendering») | Sí («high-fidelity text») | Sí (con comillas exactas en el prompt) | — | **Nativo en español + 13 idiomas más** | «Accurate text rendering» | Fuerte en tipografía (histórico) | Fuerte en diseño |
| n por llamada | 1 imagen (edición conversacional) | 1 | 1 (batch multiplica costo) | 1 | 1 (o base + ≤16 capas) | 1 (`data[]`) | `num_images` | — |
| Marca de agua | **SynthID en todas** | SynthID | No documentada | No documentada | Parámetro `watermark` configurable | No documentada | No documentada | No documentada |
| Precio por imagen 1K/1024² | $0.0336 | $0.134 | $0.048 (1K) | $0.045 (2Mpx pro) / $0.10 (max) | $0.045 | DESCONOCIDO (2.5/2.6) | DESCONOCIDO | $0.035 (V4.1) |
| Disponibilidad México | **Sí** (lista oficial incluye México) | Sí | Restricción no documentada | — | Región documentada `ap-southeast-1`; restricción por país no documentada | Azure opera; **sin región MAI en Mexico Central** (Global Standard) | No documentada | No documentada |

Todas las celdas no marcadas con fuente directa abajo se apoyan en las fuentes numeradas del final. Fuente por fila: §2–§8.

---

## 2. Google — Nano Banana (Gemini API)

### 2.1 Modelos vigentes y precios — HECHO VERIFICADO [F1]

| Modelo | ID API | Entrada (texto/imagen) | Salida imagen | Costo 1K (1024²) | 2K (2048²) | 4K | Batch |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Nano Banana 2.1 | `gemini-nano-banana-2.1` (oct 2026) | $1.50 /M | $30 /M tokens | **$0.0336** (1120 tok) | $0.0504 (1680 tok) | $0.113 (2520 tok) | −50 % ($0.0168/1K) |
| Nano Banana 2 (Gemini 3.1 Flash Image) | `gemini-3.1-flash-image` (feb 2026) | $0.50 /M | $60 /M | $0.067 | $0.101 | $0.151 | no documentado en la página |
| Nano Banana 2 Lite | `gemini-3.1-flash-lite-image` (jun 2026) | $0.25 /M | $30 /M | **$0.0336** | — («per 1K») | — | −50 % |
| Nano Banana Pro | `gemini-3-pro-image` (nov 2025) | $2.00 /M; imagen entrada **560 tokens = $0.0011/imagen** | $120 /M | $0.134 (1K y 2K) | $0.134 | $0.24 (2000 tok) | solo pestaña Standard publicada |

Notas oficiales [F1]: los tokens de salida de imagen son constantes por tier para Nano Banana 2.1 (1K = 1120 tokens **independientemente del aspect ratio**). Ejemplo: 16:9 1K = 1376×768 (1120 tokens); 4:5 1K = 928×1152 (1120 tokens) [F1][F2]. `gemini-2.5-flash-image` (Nano Banana original) está deprecado con apagado **2027-03-15**; la migración recomendada es a `gemini-3.1-flash-lite-image` [F1][F4].

### 2.2 Capacidades — HECHO VERIFICADO [F2]

- **Hasta 14 imágenes de referencia** mezclables (Nano Banana 2.1 y 3.1 Flash Image: ≤10 de objetos + ≤4 de personajes; Nano Banana Pro: ≤6 objetos + ≤5 personajes + ≤3 estilo). Directamente útil para **consistencia de marca** (producto/logo).
- Aspect ratios nativos: 1:1, 2:3, 3:2, 3:4, 4:3, **4:5, 5:4**, 9:16, **16:9**, 21:9, más 1:4, 4:1, 1:8, 8:1 (nuevos en 2.1/3.1 Flash Image).
- `image_size`: `1K`, `2K`, `4K` (o 512px en Lite según tabla).
- **SynthID** en **todas** las imágenes generadas [F2].
- Modelos con «Thinking» controlable (3 Pro Image) para instrucciones complejas y **consistencia de marca**; texto de alta fidelidad [F2].
- Prompt: texto e imágenes en el mismo `input`; salida vía `interaction.output_image` (Interactions API) — integración distinta a la Images API clásica; **NO MEDIDO** en el laboratorio.
- Grounding con búsqueda (Web/Image) disponible en 2.1 y 3 Pro Image con costo aparte ($14/1 000 consultas tras 5 000/mes gratis) [F1].

### 2.3 Limites de tasa, datos y términos — HECHO VERIFICADO

- **Rate limits:** RPM/TPM y **IPM** (imágenes por minuto) por proyecto; el valor por modelo/tier se consulta en AI Studio y no se publica una tabla estática en el sitio de docs [F5]. Límites basados en gasto por ventana de 10 min: Tier 1 $10, Tier 2 $200 [F5]. Batch enqueued tokens: Gemini 3.1 Flash Lite Image 2 000 000; 3 Pro Image Preview 2 000 000 (Tier 1) [F5].
- **Datos:** servicio pagado («Paid Services»): Google **no usa** prompts ni respuestas para mejorar sus productos y los procesa bajo el DPA de Google como encargado; retención limitada solo para detección de violaciones de la Prohibited Use Policy. Cuota gratuita (**Unpaid Services**): el contenido **sí** se usa para mejorar productos y puede ser leído por revisores humanos [F6]. ⇒ para producción, proyecto con billing activo.
- **Términos:** Google no reclama propiedad del contenido generado; prohibido competir con los servicios y hacer ingeniería inversa; uso en EEE/Suiza/UK solo con servicios pagados; cambios de precio con 30 días de aviso [F6].
- **México:** en la lista oficial de regiones disponibles de Gemini API/AI Studio [F7].
- Indemnización IP: no se encontró compromiso público de indemnización en los Additional Terms leídos → **DESCONOCIDO** (revisar contrato Google Cloud si se habilita).

---

## 3. Black Forest Labs — FLUX (`api.bfl.ai` / `docs.bfl.ai`)

### 3.1 Precios — HECHO VERIFICADO [F8][F9] (1 crédito = $0.01; mismo precio API y Playground; batch multiplica por imagen)

**FLUX 3 Image** (por imagen, según tier de resolución; `match_input` cobra el tier mínimo con ≥ píxeles):

| Tier | Dimensiones típicas | Precio |
| --- | --- | ---: |
| 768sq | 768×768 | $0.041 |
| 1K | ≈1 Mpx (p. ej. 1376×768 16:9) | **$0.048** |
| 1.5K | ≈2 Mpx (p. ej. 2048×1152 16:9) | **$0.070** |
| 2K | ≈4 Mpx | $0.10 |
| 4K | ≈16 Mpx | $0.607 |

**FLUX 3 Image Klein** (T2I y edición al mismo precio): 768sq $0.008 · 1K $0.009 · 1.5K $0.011 · 2K $0.014 · 4K $0.036.

**FLUX.2** (por megapíxel, redondeo **hacia arriba** del total; 1920×1080 = 2.07 Mpx → 3 MP):

| Modelo | T2I | Edición |
| --- | --- | --- |
| FLUX.2 [pro] | primer MP $0.03, adicionales $0.015/MP (1.57 Mpx → 2 MP = **$0.045**) | «from $0.045/MP» |
| FLUX.2 [max] | primer MP $0.07, adicionales $0.03/MP | from $0.07/MP |
| FLUX.2 [flex] | $0.05/MP | $0.10/MP |
| FLUX.2 [klein] 9B | primer MP $0.015, adicionales $0.002/MP | — |
| FLUX.2 [klein] 4B | primer MP $0.014, adicionales $0.001/MP | — |

Herramientas: FLUX Outpainting $0.10/MP (high) o primer MP $0.045 + $0.006/MP (fast); FLUX Erase primer MP $0.03 + $0.004/MP; FLUX VTO primer MP $0.0375 + $0.005/MP; FLUX.1 Kontext [pro] $0.04/img, [max] $0.08/img; FLUX 1.1 [pro] $0.04/img, Ultra/Raw $0.06/img; FLUX.1 Fill [pro] (inpainting) $0.05/img [F9]. `FLUX.2 [dev]` es open weights **sin API alojada** y con licencia no-comercial [F8][F9].

### 3.2 Capacidades — HECHO VERIFICADO [F10][F11]

- Endpoint asíncrono `POST /v1/flux-3-image` + `polling_url`; respuesta incluye `cost`, `input_mp`, `output_mp`, `result.duration` (tiempo de generación en segundos). Latencia publicada: **no se publica cifra p50/p95** → DESCONOCIDO; medible por nosotros en laboratorio (NO MEDIDO).
- **Edición y multi-referencia en el mismo endpoint**: `prompt` + `images` 1–10 (URL o base64, cada imagen ≤16 Mpx, ≥256×256). Sin campo `mode`: la instrucción define editar o mezclar.
- **Bounding boxes** para composición y edición dirigida (`<id>` + bbox 0–1000 en el prompt; puede preservar regiones «exactamente sin cambios») — útil para re-encuadre/cambio de fondo preservando producto.
- Aspect ratios: enum `21:9, 2:1, 16:9, 3:2, 7:5, 4:3, 5:4, 1:1, 4:5, 3:4, 5:7, 2:3, 9:16, 1:2, 9:21, auto`; resolución `768sq|1k|1.5k|2k|4k|match_input`; `width`/`height` explícitos [256, 6256] px (límite 4 194 304 px con referencias).
- **Texto en imagen**: guía oficial recomienda citar el texto exacto con comillas y ubicación [F10].
- Moderación: `Request Moderated` / `Content Moderated` bloquean entrada o salida; **reintentar sin cambios vuelve a fallar**; `safety_tolerance` 0–7 (default 2).
- Grounding por defecto activo (web + búsqueda de imagen) — desactivable.

### 3.3 Términos, datos, propiedad — HECHO VERIFICADO [F12]

- **Licencia sobre Entradas y Salidas**: «Developer grants the Company a fully paid, royalty-free, perpetual, irrevocable, worldwide, non-exclusive, and fully sublicensable right and license to use … Developer's Input and Output for the purpose of operating the FLUX Services, **improving the Company's products and services, and developing new products and services**… the Company may use Inputs and Outputs **to train and improve its artificial intelligence models**» (API Terms §2b, vigente 2026-08-04). ⇒ **riesgo directo para fotos/productos de clientes** con datos reales; contrastar con DEC-0067 antes de cualquier uso real.
- Uso restringido a la Developer Application propia; prohibido revender endpoints a terceros (§2a).
- Créditos prepago no reembolsables; cambios de especificación «at any time in the Company's sole discretion» (§6) — riesgo de continuidad sin SLA público.
- Retención/almacenamiento: solo Video Outputs documentados con ventana de retención; para imágenes **DESCONOCIDO**.
- México: sin restricción geográfica publicada en los términos leídos → **DESCONOCIDO**.

---

## 4. ByteDance — Seedream (BytePlus ModelArk)

### 4.1 Precios — HECHO VERIFICADO [F13]

| Model ID | Entrada (por imagen) | Salida | Notas |
| --- | --- | --- | --- |
| `dola-seedream-5-0-pro-260628` | 1.ª imagen **gratis**; desde la 2.ª **$0.003** | **$0.045** si ≤2.61 Mpx (1.5K o menos); **$0.09** si >2.61 Mpx | Descomposición en capas: la mitad por capa ($0.0225 ≤2.61 Mpx) |
| `dola-seedream-5-0-flash-260915` | gratis | **$0.018** (única tarifa) | — |
| `seedream-5-0-lite-260128` | gratis | $0.035 | 2K–4K |
| `seedream-4-5-251128` | gratis | $0.04 | — |
| `seedream-4-0-250828` | gratis | $0.03 | — |
| `seededit-3-0-i2i-250628` | gratis | $0.03 | i2i |
| `dola-seedream-5-0-pro` (capas) | — | $0.0225/≤2.61 Mpx; $0.045/>2.61 Mpx | hasta 16 capas |

Reglas de facturación oficiales [F13]: las imágenes bloqueadas por moderación **no se cobran**; en generaciones secuenciales se cobra lo generado realmente. ⚠ **1536×1024 = 1.57 Mpx ≤ 2.61 Mpx → cobra tier $0.045**; 1.5K 16:9 (2048×1152 ≈ 2.36 Mpx) también $0.045 («1.5K tiene el mismo precio que 1K») [F14].

### 4.2 Capacidades — HECHO VERIFICADO [F14][F15][F16]

- API estilo OpenAI: `POST /v3/images/generations`, SDK `ark-runtime`, también invocable con el SDK `openai` (base_url propio). Streaming SSE para imágenes disponible en otros modelos (5.0 pro/flash «streaming no soportado todavía»).
- **Edición interactiva** con marcas libres (dibujo), `<bbox>`, `<point>`, flechas y coordenadas; soporta «mantener el resto de la imagen exactamente sin cambios». Referencias: **2–10 imágenes** (5.0 pro/flash) o hasta 14 (lite/4.5/4.0) con entrada/salida ≤15.
- **Descomposición en capas**: base + hasta 16 capas PNG con alfa (`z_index`, `bounding_box`, `name`, `description`) — operación distintiva para re-encuadre/variación por canal.
- **Texto nativo en español** (y ruso, árabe, filipino, tailandés, turco, coreano, malayo, español, portugués, indonesio, francés, alemán, vietnamita, japonés) [F15]. Prompt en español soportado explícitamente.
- Tamaños 5.0 pro/flash: `1K|1.5K|2K` (default 2K) o `widthxheight` libre con total px en [921 600, 4 624 220] y ratio [1/16, 16] (⇒ 1:1, 4:5 y 16:9 posibles con dimensiones explícitas). Formatos png/jpeg.
- **Rate limit: 500 IPM** para 5.0 pro y flash [F15].
- Parámetro `watermark: true|false` en la API [F15] — marca de agua de IA activable; **no** es SynthID ni C2PA documentado → DESCONOCIDO.
- Latencia publicada: no se publica cifra (flash «más rápido»); medible en laboratorio → NO MEDIDO.

### 4.3 Términos, datos, disponibilidad — DESCONOCIDO parcial

- **No revisé** los términos de servicio/data usage de BytePlus ModelArk en esta corrida (páginas de ToS no leídas) → política de entrenamiento/retención **DESCONOCIDO**; verificación pendiente antes de datos reales (condición DEC-0067).
- Regiones documentadas en docs: `ap-southeast-1` (base URL de todos los ejemplos); la página de disponibilidad de regiones [F17] existe pero **no leí el detalle** → disponibilidad en México **DESCONOCIDO** (no hay región latam documentada en los ejemplos).
- Facturación postpago/prepago; suspensión por mora 2 h [F13].

---

## 5. Microsoft — MAI-Image (Azure AI Foundry / Microsoft Foundry)

### 5.1 Modelos y disponibilidad — HECHO VERIFICADO [F18][F19][F20]

| Modelo | Versión | Estado | T2I | Edición i2i |
| --- | --- | --- | --- | --- |
| `MAI-Image-2.6-Flash` | 2026-07-31 | **Preview** | ✓ | ✓ |
| `MAI-Image-2.6` | 2026-07-31 | **Preview** | ✓ | ✓ |
| `MAI-Image-2.5-Pro` | 2026-06-19 | **Preview** | ✓ | ✓ |
| `MAI-Image-2.5-Flash` | 2026-06-02 | **Preview** | ✓ | ✓ |
| `MAI-Image-2.5` | 2026-06-02 | **Preview** | ✓ | ✓ |
| `MAI-Image-2` | — | GA (anuncio 2026-04-02) | ✓ | — |

**Preview = sin SLA** («provided without a service-level agreement… not recommended for production workloads») [F18].

Regiones (Global Standard, tablas oficiales): MAI-Image-2.5/2.6 y variantes — **eastus, westcentralus, westus2** (Américas); **sin región Mexico Central** para estos modelos [F20]. Global Standard puede procesar en cualquier región donde esté desplegado el modelo.

### 5.2 API y límites — HECHO VERIFICADO [F18]

- Endpoints Microsoft-gestionados: `/mai/v1/images/generations` y `/mai/v1/images/edits` (multipart). Autenticación por API key o Microsoft Entra ID. Salida siempre **PNG b64**.
- **Edición: hasta 5 imágenes de referencia** (repetir campo `image`), JPEG/PNG.
- Dimensiones: `width`/`height` mínimos **768 px** cada uno; máx producto **2 359 296 px (1536×1536)** en 2.6 y **1 048 576 px (1024×1024)** en 2.5. `auto_aspect_ratio` y `web_grounding` (Bing) solo en 2.6. Prompt máx 32 000 tokens.
- **Rate limits (Global Standard):** Tier 1: 6 RPM (2.6/2.6-Flash), 2 RPM (2.5/2.5-Flash/Pro); Tier 6: 36 y 12 RPM. Tier 0 (gratis): 0 RPM. Escalado por formulario.
- Responsable AI: prohibido por defecto editar imágenes fotorrealistas de menores (acceso por solicitud; enterprise aprobación automática).

### 5.3 Precios y datos

- **MAI-Image-2** (GA): «starts at **$5 per 1M tokens for text input and $33 per 1M tokens for image output**» — HECHO VERIFICADO [F21] (anuncio oficial, actualizado 2026-06-09). Tokens por imagen consumidos: **DESCONOCIDO** (sin tabla pública). ESTIMACIÓN con ~1120 tokens/imagen (paridad con Gemini): 1120 × $33/M ≈ **$0.037/imagen**.
- **MAI-Image-2.5/2.6/Flash/Pro**: página oficial de precios Foundry Models «Microsoft» renderiza por JS y no expone los valores en texto («$-») → montos **DESCONOCIDOS** en fuente oficial [F19]. Referencia secundaria (SNIPPET, Artificial Analysis): MAI-Image-2.6 ≈ $38.9/1k imgs, 2.6-Flash $19.5/1k, 2.5 $48.1/1k, 2.5-Pro $108.5/1k [F22].
- Datos/entrenamiento: términos de Microsoft para Foundry **no revisados aquí** → DESCONOCIDO (leer Microsoft Product Terms + DPA antes de DEC-0067). Moderación de menores documentada [F18].

---

## 6. Ideogram (API)

- API productiva con esquema MCP propio; endpoints `api.ideogram.ai/v2/...`; modelo de carácter consistente **Ideogram 3.0** con `character_reference_images` (≤25 MB), máscara de personaje, hasta 10 imágenes de estilo, `num_images`, `aspect_ratio`, webhooks Ed25519 y **`dry_run=true`** que devuelve `PriceQuote` **sin generar, sin guardar y sin cobrar** — HECHO VERIFICADO [F23].
- **Precio por imagen: la lista oficial vive en la app («Usage costs»/«Pricing»), no en docs públicas** → valor público por operación **DESCONOCIDO**; cotizable sin costo con `dry_run` (NO MEDIDO) [F23].
- Referencia secundaria de mercado (SNIPPET): AA lista «Ideogram 4.0 (Quality)» a $100.0/1k imgs (T2I, Elo 1025) e «Ideogram 4.5 (High)» $220.0/1k en editing (Elo 1069) [F22].
- Términos/datos/propiedad: no revisados → **DESCONOCIDO**.
- México: sin restricción publicada encontrada → **DESCONOCIDO**.

---

## 7. Recraft (API)

- Unidades prepago: **$1 = 1 000 unidades**, sin expiración; cada respuesta devuelve `credits` — HECHO VERIFICADO [F24].
- **Generación** (por imagen): V4.1 **Flash raster $0.007**; V4.1 y V4.1 Utility raster $0.035, vector $0.08, Pro raster (2K) $0.21, Pro vector $0.30; V4 raster $0.04; V3 raster $0.04. Estilo con referencias añade $0.005/req.
- **Edición** con V3 (raster): image-to-image, inpainting, outpainting, replace/generate background: **$0.04 c/u** (vector $0.08).
- **Herramientas**: erase region $0.002; crisp upscale $0.004; create style $0.005; vectorize $0.01; remove background $0.01; remix $0.04; creative upscale $0.25.
- Creado para diseño/vector/brand assets (vector real y pagos por herramienta); resolución típica y aspect ratios detallados en docs de modelos — no extraídos aquí → detalle fino **DESCONOCIDO**.
- Términos/datos/propiedad: no revisados → **DESCONOCIDO**. México: DESCONOCIDO.

---

## 8. OpenAI `gpt-image-2` — fila de comparación (cruza con `evidence/openai.md`)

**HECHO VERIFICADO vía `evidence/openai.md` (2026-11-03)**: `gpt-image-2` ($5/M texto, $8/M imagen entrada, $30/M imagen salida), 1024²: low $0.006 / medium $0.053 / high $0.211; 1536×1024: $0.005 / $0.041 / $0.165; Batch −50 %; hasta **16 imágenes de entrada** + máscara de inpainting; texto en imagen y consistencia siguen siendo limitaciones declaradas; SynthID **+ C2PA** en la salida; ZDR elegible para `/v1/images/*`; no-región México (+10 % regional si aplica); IPM 20 (Build) / 150 (Launch) / 250 (Grow). Generación siguiente vigente: `gpt-image-2.5-sunburst/-flare` (misma tarifa por token; costo por imagen **DESCONOCIDO** sin medición).

---

## 9. Rankings públicos de calidad (fechados) — ⚠ no equivalentes a una evaluación con prompts de MainSpot

> **Advertencia metodológica:** los rankings son con **prompts y votos ajenos** (preferencia humana ciega). No miden los atributos que MainSpot necesita: español correcto, precio/marca/promo, consistencia con logo/producto, ratios de Facebook, tasa de rechazo del pipeline. Toda decisión requiere **evaluación propia** con los casos de `src/ai/catalog.ts` (propuesta en §11; NO MEDIDO).

### 9.1 Artificial Analysis — AA-Image-T2I v2.1 (consultado 2026-11-03) — HECHO VERIFICADO [F22]

| # | Modelo | Elo ±IC | Muestras | Lanzamiento | Precio AA (/1k imgs) |
| --- | --- | --- | ---: | --- | ---: |
| 1 | GPT Image 2.5 Sunburst (max) | 1223 ±10 | 13 070 | sep 2026 | $210.7 |
| 2 | GPT Image 2.5 Flare (max) | 1207 ±10 | 12 418 | sep 2026 | $210.7 |
| 3–4 | GPT Image 2 (high) | 1189 ±11 | 12 885 | abr 2026 | $211.0 |
| 4 | **Nano Banana 2.1** | 1176 ±12 | 6 248 | oct 2026 | $33.6 |
| 5 | Grok Imagine Image 2.0 | 1168 ±12 | 7 523 | ago 2026 | $60.0 |
| 6 | MAI-Image-2.6 | 1167 ±12 | 8 395 | ago 2026 | $38.9 |
| 7 | Nano Banana 2 (3.1 Flash Image) | 1140 ±10 | 16 125 | feb 2026 | $67.0 |
| 11 | **FLUX 3 Image** | 1119 ±12 | 6 173 | oct 2026 | $48.0 |
| 13 | Nano Banana Pro (3 Pro Image) | 1118 ±10 | 15 233 | nov 2025 | $134.0 |
| 15 | Nano Banana 2 Lite | 1107 ±10 | 15 129 | jun 2026 | $33.6 |
| 16 | **Seedream 5.0 Pro** | 1101 ±11 | 11 676 | jul 2026 | $90.0 |
| 22 | **FLUX 3 Image Klein** | 1043 ±12 | 5 224 | oct 2026 | $9.0 |
| 26 | MAI-Image-2.5-Flash | 1029 ±11 | 5 909 | jun 2026 | $20.0 |
| 32 | Ideogram 4.0 (Quality) | 1025 ±10 | 10 742 | jun 2026 | $100.0 |

Otros relevantes: FLUX.2 [flex] #30 (1026), Recraft V4.1 Utility #31 (1026), Seedream 4.5 #28 (1027), MAI-Image-2.5 #12 (1118), MAI-Image-2.5-Pro #14 (1114). GPT Image 2 (high) #3.

### 9.2 Artificial Analysis — AA-Image-Editing v2.1 (consultado 2026-11-03) — HECHO VERIFICADO [F22]

| # | Modelo | Elo ±IC | Muestras | Nota |
| --- | --- | --- | ---: | --- |
| 1–2 | GPT Image 2.5 Sunburst (max) | 1199 ±11 | 18 300 | API (openai.md) |
| 2 | **MAI-Image-2.7-Preview** | 1196 ±15 | 4 954 | **«No API available»** en AA |
| 3 | GPT Image 2.5 Flare (max) | 1183 ±11 | 19 199 | API |
| 4–7 | Krea 3 (Ultra) / **Nano Banana 2.1** / MAI-Image-2.6 / MAI-Image-2.6-Flash | 1151 / 1151 / 1151 / 1145 | 5 573 / 6 937 / 16 713 / 10 825 | — |
| 8 | GPT Image 2 (high) | 1137 ±13 | 14 632 | DEC-0069 |
| 9 | **Seedream 5.0 Pro** | 1129 ±13 | 13 446 | — |
| 13 | Nano Banana 2 (3.1 Flash Image) | 1124 ±12 | 16 720 | — |
| 15 | **FLUX 3 Image** | 1123 ±14 | 4 967 | — |
| 18 | Nano Banana Pro | 1109 ±12 | 15 639 | — |
| 33 | Seedream 5.0 Lite | 1062 ±13 | 6 526 | — |
| 35 | Nano Banana 2 Lite | 1055 ±12 | 8 163 | — |

### 9.3 LMArena — Text-to-Image (estado 2026-10-26; tabla espejo del dataset oficial CC BY 4.0) — SNIPPET/espejo [F25]

| # | Modelo | Score | Votos |
| --- | --- | ---: | ---: |
| 1 | GPT-Image-2.5 Sunburst | 1 427 | 40 323 |
| 2 | GPT-Image-2.5 Flare | 1 401 | 39 218 |
| 3 | GPT-Image-2 (Medium) | 1 381 | 103 385 |
| 4 | MAI-Image-2.6 | 1 329 | 34 596 |
| 5 | **Gemini Nano Banana 2.1** | 1 325 | 5 290 |
| 6 | Grok Imagine Image 2.0 | 1 317 | 10 902 |
| 13 | MAI-Image-2.5 | 1 253 | 61 286 |
| 14 | **Seedream 5.0 Pro** | 1 250 | 105 824 |
| 15 | Gemini 3.1 Flash-Lite Image | 1 249 | 17 813 |
| 16 | Gemini 3 Pro Image (2K) | 1 246 | 188 288 |
| 20 | Ideogram 4.0 (Quality) | 1 200 | 72 865 |
| 28 | FLUX.2 [max] | 1 161 | 123 144 |
| 32 | FLUX.2 [pro] | 1 153 | 223 179 |

El sitio `lmarena.ai`/`arena.ai` devolvió **HTTP 403** a la lectura directa; el ranking se tomó del espejo `offscreenspace.com` que replica el dataset oficial en Hugging Face (`lmarena-ai/leaderboard-dataset`). LMArena **image edit**: no capturado en esta corrida → **HUECO** (usar AA-Image-Editing como referencia de edición).

---

## 10. ESTIMACIÓN — costo por imagen ENTREGADA

### 10.1 Supuestos (ESTIMACIÓN, sensibilidad indicada)

- **Factor de reintento k_retry = 1.3**: cubre regeneraciones por rechazo de calidad automática y bloqueos de moderación. Fórmula: `k = 1 / (1 − t_rechazo)`; con t_rechazo ≈ 23 % ⇒ k ≈ 1.30. Rango razonable 1.15–1.6 (moderadores estrictos como BFL pueden subirlo). BFL/Seedream no cobran lo bloqueado; OpenAI/Gemini sí cobran toda generación aunque se descarte.
- **Variantes:** para piezas de marketing se generan **2 y se elige 1** ⇒ multiplicador 2.0 en generación original. En **edición** se asume 1 salida con reintento (×1.3) salvo que el pipeline pida comparativa.
- **Costo entregado = precio_base × variantes × k_retry.** Sin costo de almacenamiento/egress (fuera de alcance de proveedor).

### 10.2 Generación — web 16:9 (~1376×768 a 2048×1152 según tier)

| Proveedor / modelo | Tier/calidad | Precio base | Entregada (×2 ×1.3 = ×2.6) | Entregada solo con reintento (×1.3) |
| --- | --- | ---: | ---: | ---: |
| Gemini `gemini-nano-banana-2.1` | 1K (1376×768) | $0.0336 | **$0.087** | $0.044 |
| Gemini `gemini-nano-banana-2.1` | 2K (2752×1536) | $0.0504 | **$0.131** | $0.066 |
| Gemini `gemini-nano-banana-2.1` | 4K (5504×3072) | $0.113 | **$0.294** | $0.147 |
| Gemini `gemini-3.1-flash-lite-image` | 1K | $0.0336 | **$0.087** | $0.044 |
| Gemini `gemini-3-pro-image` | 1K–2K | $0.134 | **$0.348** | $0.174 |
| Gemini `gemini-3-pro-image` | 4K | $0.24 | **$0.624** | $0.312 |
| BFL FLUX 3 Image | 1K | $0.048 | **$0.125** | $0.062 |
| BFL FLUX 3 Image | 1.5K (≈1536×1024) | $0.070 | **$0.182** | $0.091 |
| BFL FLUX 3 Image | 4K | $0.607 | **$1.578** | $0.789 |
| BFL FLUX 3 Image Klein | 1.5K | $0.011 | **$0.029** | $0.014 |
| BFL FLUX.2 [pro] | 1.57 Mpx → 2 MP | $0.045 | **$0.117** | $0.059 |
| BFL FLUX.2 [max] | 2 MP | $0.10 | **$0.260** | $0.130 |
| BytePlus Seedream 5.0 pro | ≤2.61 Mpx (1K–1.5K 16:9) | $0.045 | **$0.117** | $0.059 |
| BytePlus Seedream 5.0 flash | cualquier tier | $0.018 | **$0.047** | $0.023 |
| BytePlus Seedream 5.0 lite | 4K | $0.035 | **$0.091** | $0.046 |
| Microsoft MAI-Image-2 (GA) | ≈1 Mpx | ≈$0.037* | **≈$0.096** | ≈$0.048 |
| Microsoft MAI-Image-2.6 (Preview) | 1:1≈1536² máx | ~$0.0389 (SNIPPET AA) | **≈$0.101** | ≈$0.051 |
| OpenAI `gpt-image-2` | 1536×1024 medium | $0.041 | **$0.107** | $0.053 |
| OpenAI `gpt-image-2` | 1536×1024 high | $0.165 | **$0.429** | $0.215 |
| OpenAI `gpt-image-2` | 1536×1024 low | $0.005 | **$0.013** | $0.007 |
| Recraft V4.1 | raster | $0.035 | **$0.091** | $0.046 |
| Recraft V4.1 Flash | raster | $0.007 | **$0.018** | $0.009 |

\* MAI-Image-2: ESTIMACIÓN 1120 tokens × $33/M [F21]; consumo real DESCONOCIDO.

### 10.3 Generación — social 1:1 (1024×1024) y 4:5 (928×1152)

Los tokens por tier de Nano Banana 2.1 no dependen del aspect ratio ⇒ 1:1 y 4:5 cuestan lo mismo que 1024² [F1][F2].

| Proveedor / modelo | Calidad | Precio base | Entregada (×2.6) | Entregada (×1.3) |
| --- | --- | ---: | ---: | ---: |
| Gemini `gemini-nano-banana-2.1` | 1K (1024² o 928×1152) | $0.0336 | **$0.087** | $0.044 |
| Gemini `gemini-nano-banana-2.1` | 2K | $0.0504 | **$0.131** | $0.066 |
| BFL FLUX 3 Image | 1K | $0.048 | **$0.125** | $0.062 |
| BFL FLUX 3 Image | 768² | $0.041 | **$0.107** | $0.053 |
| BFL FLUX.2 [pro] | 1 MP | $0.03 | **$0.078** | $0.039 |
| BytePlus Seedream 5.0 pro | 1K 1:1 (1024²) o 4:5 con `widthxheight` | $0.045 | **$0.117** | $0.059 |
| BytePlus Seedream 5.0 flash | — | $0.018 | **$0.047** | $0.023 |
| OpenAI `gpt-image-2` | 1024² medium | $0.053 | **$0.138** | $0.069 |
| OpenAI `gpt-image-2` | 1024² high | $0.211 | **$0.549** | $0.274 |
| Microsoft MAI-Image-2.5/2.6 | 1024² máx (2.5) | DESCONOCIDO (SNIPPET AA 2.6 $0.0389) | ≈$0.101 | ≈$0.051 |
| Recraft V4.1 | raster | $0.035 | **$0.091** | $0.046 |
| Ideogram 4.0 (Quality) | — | ~$0.10 (SNIPPET AA) | ≈$0.26 | ≈$0.13 |

### 10.4 Edición/adaptación (1 imagen editada entregada; re-encuadre/cambio de fondo/variación con producto+logo)

| Proveedor / modelo | Método | Precio base | Entregada (×1.3) | Notas |
| --- | --- | ---: | ---: | --- |
| Gemini `gemini-nano-banana-2.1` | 1 ref + instrucción | ≈$0.0336 (1K) + entrada imagen ≈$0.0008* | **≈$0.045** | Hasta 14 refs; token de entrada de imagen no verificado ⇒ ESTIMACIÓN |
| Gemini `gemini-nano-banana-2.1` | 2K | $0.0504 | **$0.066** | — |
| Gemini `gemini-3-pro-image` | 1 imagen de entrada | 560 tok = **$0.0011 fijo** + salida $0.134 (1K–2K) | **$0.175** | HECHO VERIFICADO el costo de entrada |
| BFL FLUX 3 Image | `images` 1–10 + bbox | $0.048 (1K, `match_input` disponible) | **$0.062** | Edición y T2I mismo precio |
| BFL FLUX.2 [pro] | edición | from $0.045/MP | **$0.059** (1 MP) | primer MP |
| BytePlus Seedream 5.0 pro | 1 imagen ref (entrada gratis) | $0.045 | **$0.059** | Edición interactiva con bbox/punto; descomposición en capas −50 % |
| OpenAI `gpt-image-2` | `images[]` hasta 16 + `mask` | tokens imagen entrada $8/M (fidelidad alta forzada) + salida; costo edit típico en openai.md | ver `evidence/openai.md` §1.4/1.5 | — |
| Microsoft MAI-Image-2.5/2.6 | `/mai/v1/images/edits` multipart (≤5 refs) | precio por token desconocido | DESCONOCIDO | Preview, sin SLA |
| Recraft V3 | i2i / inpainting / replace background | $0.04 | **$0.052** | Herramientas complementarias baratas (erase $0.002, upscale $0.004) |
| BFL FLUX.1 Fill [pro] | inpainting con máscara | $0.05 | **$0.065** | Máscara explícita clásica |

### 10.5 Sensibilidad

`entregada_gen = base × 2 × k`; con k ∈ {1.15, 1.3, 1.6}: Nano Banana 2.1 1K web = $0.077 / **$0.087** / $0.107; gpt-image-2 medium web = $0.094 / **$0.107** / $0.132. El orden relativo de proveedores no cambia dentro de ese rango. Generar 3 variantes y elegir 1 sube a ×3×k (+15 % sobre ×2×k).

---

## 11. Propuesta en papel (sin decidir) — 1 primario + 1 alternativa por subcaso

> Marco: DEC-0069 mantiene `gpt-image-2` (OpenAI directo) como vía de imágenes aprobada. Todo cambio requiere decisión del propietario (y condiciones DEC-0067/DEC-0071 antes de datos reales). Ninguna recomendación de abajo está aplicada.

### 11.1 Generación web (16:9, sitio de negocio)

- **Propuesta:** primario **`gemini-nano-banana-2.1`** (Gemini API pagado). Condiciones: proyecto con billing (no cuota gratuita), Batch (−50 %) para calendario editorial, tolerar SynthID en la salida (verificar necesidad de strip-tool — **no intentar removerla**).
- **Alternativa:** **`gpt-image-2`** (vía aprobada) cuando se requiera el máximo ELO (GPT Image 2.5 Sunburst max, AA #1) o herramienta de Responses integrada; costo 1.3–2.6× mayor por imagen entregada según calidad.
- **Riesgos:** tokens de salida variables por calidad (gpt-image-2.5 consumo no documentado); dependencia de una sola región US/EU en ambos; SynthID no removible.
- **Justificación cuantitativa:** calidad AA T2I #4 (1176) vs #3 (1189) con **$0.087 vs $0.107–0.429** entregadas (media/alta).

### 11.2 Generación social con texto en español (1:1 y 4:5, promos/precios)

- **Propuesta:** primario **`dola-seedream-5-0-pro-260628`** (BytePlus ModelArk) por texto **nativo en español** + edición interactiva + $0.045 ≤2.61 Mpx; alternativa **`gemini-nano-banana-2.1`** con mismo costo y ecosistema más simple, o **`gemini-3-pro-image`** para piezas tipográficas de alta exigencia ($0.134).
- **Riesgos Seedream:** términos de datos de BytePlus **sin verificar** (DESCONOCIDO) — bloqueante para DEC-0067; región única documentada `ap-southeast-1`; disponibilidad legal en México sin confirmar.
- **Criterio de cambio propuesto:** evaluar en laboratorio (sintético) tasa de error tipográfico español y consistencia de logo en 3 modelos + gpt-image-2; decidir con datos, NO MEDIDO.

### 11.3 Edición/adaptación de imágenes existentes (cambio de fondo, re-encuadre, variaciones con producto/logo)

- **Propuesta:** mantener **`gpt-image-2`** como primario (vía aprobada): hasta 16 imágenes de entrada, máscara de inpainting, ZDR elegible, C2PA — el único con las cuatro capacidades verificadas en una sola API.
- **Alternativa:** **`gemini-nano-banana-2.1`** (14 refs, edición conversacional, ~30–45 % del costo) o **FLUX 3 Image** (bounding boxes que preservan regiones «exactamente sin cambios»; útil para re-encuadre quirúrgico) — con la advertencia severa de que **BFL entrena con Entradas y Salidas** (§3.3): solo con datos sintéticos/no sensibles.
- **Re-encuadre por canal específicamente:** Seedream 5.0 **descomposición en capas** (base + ≤16 capas) es la operación más directa para reciclar una pieza en 1:1/4:5/16:9; propuesta a validar.

### 11.4 Consistencia de marca transversal

- Máximo de referencias documentado: Gemini 14, Seedream 5.0 pro 10 (lite/4.5: 14), FLUX 3 10, gpt-image-2 16, MAI 5, Ideogram 10 de estilo. Propuesta: fijar 1 asset-kit por negocio (logo, producto, fondo) y probar fidelidad — pendiente de medición.

### 11.5 Decisiones nuevas que requerirían propietario (no implementar)

1. Habilitar cuenta Gemini API pagada para imágenes (DEC adicional).
2. Verificación de términos BytePlus ModelArk y evaluación legal de región/transferencia.
3. Excluir BFL de datos de negocio reales mientras su licencia de entrenamiento no cambie.
4. Presupuesto de laboratorio para benchmark propio por subcaso (estimación interna, sin llamadas a proveedores en esta fase).

---

## Fuentes

1. Gemini Developer API Pricing — https://aistudio.google.com/docs/pricing (canonical https://ai.google.dev/gemini-api/docs/pricing) — 2026-11-03 — precios de `gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`; tokens por tier; Batch −50 %.
2. Gemini API — Nano Banana image generation — https://aistudio.google.com/docs/image-generation — 2026-11-03 — 14 referencias, ratios nativos (incl. 4:5 y 16:9 con dimensiones), SynthID, pensando/consistencia, edición conversacional.
3. (Uso indirecto de 2) Fórmula de tokens 1K=1120/2K=1680/4K=2520 (2.1) — misma URL que [2].
4. Gemini deprecations — https://aistudio.google.com/docs/deprecations — 2026-11-03 — apagado Imagen 4.0 (2026-08-17) y su reemplazo `gemini-nano-banana-2.1`; deprecación `gemini-2.5-flash-image` (2027-03-15).
5. Gemini API — Rate limits — https://aistudio.google.com/docs/rate-limits — 2026-11-03 — IPM, límites por gasto/tier, Batch enqueued tokens de modelos de imagen.
6. Gemini API Additional Terms of Service (efectivas 2026-03-23) — https://aistudio.google.com/docs/terms — 2026-11-03 — uso de datos Paid/Unpaid, propiedad del contenido, restricciones regionales EEE.
7. Available regions for Google AI Studio and Gemini API — https://aistudio.google.com/docs/available-regions — 2026-11-03 — México en la lista.
8. BFL Pricing — https://bfl.ai/pricing (JSON-LD incrustado; leído con `:raw`) — 2026-11-03 — precios por tier FLUX 3 Image/Klein, FLUX.2 por MP, herramientas.
9. BFL Knowledge Base — What are the costs — https://help.bfl.ai/articles/7986977817 — 2026-11-03 — créditos $0.01, megapíxel/MP tiers, precios FLUX.2/FLUX.1 Kontext/Fill.
10. BFL Docs — FLUX 3 Text to Image — https://docs.bfl.ai/flux_3/flux3_image_generate.md — 2026-11-03 — flujo asíncrono, edición/multi-referencia 1–10, moderación, texto con comillas.
11. BFL Docs — API reference `POST /v1/flux-3-image` — https://docs.bfl.ai/api-reference/utility/generate-an-image-with-flux-3.md — 2026-11-03 — enum de aspect ratios, resoluciones, width/height, safety_tolerance, grounding, layout con bounding boxes.
12. BFL — FLUX API Service Terms (2026-08-04) — https://bfl.ai/legal/flux-api-service-terms — 2026-11-03 — §2a/§2b licencia de Entradas/Salidas y entrenamiento, rate limits, créditos no reembolsables.
13. BytePlus ModelArk — Pricing — https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing.md — 2026-11-03 — tabla de precios de generación de imágenes (Seedream 5.0 pro/flash/lite, 4.5, 4.0, seededit), reglas de facturación, 500 IPM.
14. BytePlus ModelArk — Image generation API — https://ai.byteplus.com/ark/region:ap-southeast-1/docs/image-generation-api.md — 2026-11-03 — referencias 2–10/2–14, tamaños y ratios por tier, límites de píxeles, idiomas de prompt.
15. BytePlus ModelArk — Seedream 5.0 pro/flash tutorial — https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedream-5-0-pro.md — 2026-11-03 — edición interactiva, descomposición en capas, idiomas nativos (español), IPM 500, watermark.
16. BytePlus ModelArk — Seedream 5.0 interactive editing guide — https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedream-5-0-pro-editing-guide.md (referenciado desde [15]) — no leído completo.
17. BytePlus ModelArk — Region availability — https://ai.byteplus.com/ark/region:ap-southeast-1/docs/region-availability.md — indexado, no leído completo.
18. Microsoft Learn — Deploy and use MAI image models in Microsoft Foundry — https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image — 2026-11-03 (doc dated 2026-09-21) — modelos, endpoints, límites de píxeles, ≤5 referencias, tiers RPM, menores bloqueados, preview sin SLA.
19. Azure — Foundry Models Pricing (Microsoft) — https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/microsoft/ — 2026-11-03 — nombres de modelos MAI-Image-2/2.5/2.6 (+Efficient, 2.5 Pro/Flash); montos no legibles (JS).
20. Microsoft Learn — Region availability for Foundry Models sold by Azure — https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability — 2026-11-03 — regiones Global Standard de MAI-Image-2.5/2.6 (eastus, westcentralus, westus2).
21. Microsoft AI — Announcing 3 new world class MAI models (2026-04-02, actualizado 2026-06-09) — https://microsoft.ai/news/today-were-announcing-3-new-world-class-mai-models-available-in-foundry/ — 2026-11-03 — precio MAI-Image-2 «$5 per 1M tokens text input, $33 per 1M tokens image output».
22. Artificial Analysis — AA-Image-T2I v2.1 y AA-Image-Editing v2.1 Leaderboards — https://artificialanalysis.ai/image/leaderboard/text-to-image y /image/leaderboard/editing — consultados 2026-11-03 — Elos, muestras, precios publicados por AA.
23. Ideogram — API docs — https://docs.ideogram.ai/plans-and-billing/ideogram-api.md y https://developer.ideogram.ai/api-reference/images/generate/ideogram-3-character.md — 2026-11-03 — modelo de créditos, dry_run/PriceQuote, referencias de personaje/estilo.
24. Recraft — API Pricing — https://www.recraft.ai/docs/api-reference/pricing — 2026-11-03 — unidades, precios por modelo/operación.
25. LMArena Text-to-Image — https://lmarena.ai/leaderboard/text-to-image (403) vía espejo https://offscreenspace.com/benchmarks/lmarena-text-to-image (estado 2026-10-26, dataset oficial `lmarena-ai/leaderboard-dataset` CC BY 4.0) — 2026-11-03 — scores T2I.
26. `evidence/openai.md` (este repositorio) — 2026-11-03 — precios y límites de `gpt-image-2`/2.5, endpoints, ZDR, C2PA/SynthID.

---

## Huecos

1. **Precio oficial de Ideogram API por operación** — no existe tabla pública en docs; verificar con `dry_run=true` (NO MEDIDO, sin costo) o consulta a ventas; cifra de AA solo SNIPPET.
2. **Precios oficiales de MAI-Image-2.5/2.6/Flash/Pro** — la página de Azure no renderiza montos sin JS; los valores usados para 2.6 son SNIPPET de AA. Verificar en el portal/EA o con la calculadora autenticada.
3. **Tokens por imagen consumidos por MAI-Image-2/2.5/2.6** — sin tabla pública ⇒ el costo por imagen es ESTIMACIÓN (asume ~1120 tokens).
4. **Términos de datos de BytePlus ModelArk (entrenamiento/retención), Ideogram, Recraft y Microsoft Foundry para MAI** — no leídos; bloqueantes para uso con datos reales bajo DEC-0067.
5. **Disponibilidad legal/geográfica en México de BFL, BytePlus, Ideogram y Recraft** — sin declaración pública encontrada en las páginas leídas; verificar ToS completos.
6. **Latencia publicada p50/p95 de todos los proveedores de imagen** — ninguna cifra oficial; medir en laboratorio (NO MEDIDO) usando los campos que exponen (`result.duration` en BFL).
7. **Rate limits Gemini por modelo/tier (IPM)** — publicados solo dinámicamente en AI Studio; los del texto del proveedor indican cómo consultarlos, no el número.
8. **LMArena image-edit** — el dominio oficial devolvió 403; no se capturó. Alternativa usada: AA-Image-Editing. Reintentar con dataset de Hugging Face en otra corrida.
9. **Costo por imagen de `gpt-image-2.5-sunburst/flare`** — cruzado con `evidence/openai.md`: tarifas por token iguales, consumo por imagen desconocido.
10. **Costo de entrada de imagen en Gemini Nano Banana 2.1** (tokens de imagen a $1.50/M) — se asumió despreciable en ediciones; verificar con una medición real.
11. **Indemnización IP de Google/OpenRouter-level y C2PA de Gemini/Seedream** — no verificados; Gemini documenta SynthID pero no C2PA en lo leído; gpt-image-2 sí (C2PA+SynthID, openai.md).
