# 05 — Recomendación por caso de uso, márgenes y decisiones pendientes del propietario

Fecha: 2026-11-03. Rama `research/ai-provider-economics-2026-11` (worktree `mainspot-ai-research`).
Naturaleza: **investigación y propuesta**. Nada de este documento es una aprobación vigente ni modifica rutas, presupuesto ni decisiones del canon. Las únicas decisiones vigentes citadas aquí son las ya registradas por el propietario (DEC-0066, DEC-0068, DEC-0069, DEC-0071, DEC-0073, DEC-0032, APR-0003); todo lo demás son PROPUESTAS que requieren decisión del propietario (§4).

Etiquetas: **HECHO VERIFICADO** (leído en fuente oficial o archivo del repo), **MEDICIÓN PROPIA** (laboratorio MainSpot del 2026-10-30 con datos sintéticos; **todo el texto generativo fue medido vía OpenRouter**, no por API directa), **ESTIMACIÓN** (cálculo propio con fórmula), **HIPÓTESIS**, **DESCONOCIDO**, **NO MEDIDO**.

---

## 1. Estado de partida (hechos)

### 1.1 Lo que está vigente (decisiones del propietario, no de esta investigación)

| Decisión | Contenido vigente | Fuente |
|---|---|---|
| **DEC-0066** | Jev (TypeSafe) es el clasificador semántico **primario** de todo mensaje/evento de texto, con gate de evaluación por pregunta; el backend conserva identidad/permisos/ejecución | `01-inventory.md` §8.1 |
| **DEC-0069** | TypeSafe directo; **Anthropic directo prioritario** para texto; OpenAI directo `gpt-image-2` para imágenes (comprobar acceso antes de incorporar); **OpenRouter fuera de nuevas ejecuciones y sin fallback** | `01-inventory.md` §8.1 |
| **DEC-0068** | Techo de laboratorio **USD 25 acumulado incluido el histórico**; gastado USD 0.096726 (OpenRouter) + intentos directos con costo 0 ⇒ disponible ≈ **USD 24.9**; TypeSafe con tope propio separado | `01-inventory.md` §8.1; `03-quality-benchmarks.md` §4.8 |
| **DEC-0071** | Anthropic (texto) y OpenAI (imágenes) pueden recibir datos de negocios reales «con las condiciones de TypeSafe» (verificación única de términos; MainSpot registra COVERED_WITH_CONDITIONS, cuya validez formal queda abierta — D10) | `01-inventory.md` §8.1, §8.3 |
| **DEC-0073** | Desarrollo: OpenAI para **toda la generación** (texto por Responses `store:false`; imágenes `gpt-image-2`); migración 0029 deshabilita Anthropic como proveedor (adaptador conservado, sin rutas ni fallback). Se declara «configuración actual de desarrollo, **no selección comercial irreversible**»; TypeSafe/Jev conserva clasificación primaria | `01-inventory.md` §8.0–§8.4 |
| **DEC-0032** | TypeSafe: USD 1/día **global por despliegue** (control de desarrollo, inadecuado como control productivo) | `02-provider-comparison.md` §2.3 |
| **APR-0003** | Canon AI Core 0.2.0 aprobado; operaciones dentro de autorizaciones vigentes se ejecutan autónomamente | `01-inventory.md` §8.1 |

### 1.2 El hallazgo crítico que condiciona toda recomendación

**La integración directa no tiene ni una generación exitosa medida.** El 2026-11-03 SOL MAIN ejecutó las evaluaciones directas: `direct-evals-2026-11-03.json` — 13 suites de texto `an:claude-haiku-5-5` **fallidas 0/N con `provider_unavailable: bad_request`** (causa exacta DESCONOCIDO; coherente con el límite de 16 uniones de Anthropic pero falla también en casos sin esquema de parche); `openai-development-evals-2026-11-03.json` — 20 suites (Luna, Sol, `gpt-image-2`) **fallidas 0/N con `provider_auth: insufficient_credit`** (cuenta sin saldo). Solo Jev pasó directo (8/8, 17/20, 17/20; p50 135–142 ms). — HECHO VERIFICADO (`03-quality-benchmarks.md` §2, §6).

Consecuencias para este entregable:

1. **Una selección «por caso de uso» basada en datos directos es hoy NO MEDIDO.** Cada recomendación de §2 declara en qué evidencia se apoya: (a) MEDICIÓN PROPIA del laboratorio 2026-10-30 **vía OpenRouter** + precio directo verificado (lo más fuerte disponible); (b) precio directo verificado + calidad inferida de benchmarks públicos; (c) solo inferencia.
2. Los tokens «medidos» de Haiku/Sonnet provienen de la traducción de esquema de OpenRouter (entrada inflada ~2–2.5× vs Luna; causa HIPÓTESIS). La vía directa Anthropic puede cerrar parte de esa brecha; B-TXT (§4, D-REC-1) es lo único que lo cierra.
3. **Imágenes: 0 invocaciones exitosas en toda la historia del proyecto** (`gpt-image-2` nunca fue invocado). Cualquier recomendación de imagen es de precio verificado + calidad de benchmarks públicos; el factor de reintento k=1.3 es HIPÓTESIS.

**Escala de confianza usada en §2** (definida por el encargo): **ALTA** = medido en lab + precio verificado; **MEDIA** = precio verificado + calidad inferida; **BAJA** = solo inferencia. Nota obligatoria: toda celda «ALTA» es ALTA **en la vía OpenRouter histórica**; ninguna celda alcanza ALTA sobre la vía directa (§1.2.1).

---

## 2. Recomendación por caso de uso (PROPUESTA, no aprobación)

Los «mixes» citados (DEV/CANON/OPT) son los del entregable 04: **MIX-DEV** = vigente en desarrollo tras DEC-0073 (Sol/Luna OpenAI + gpt-image-2 + Jev); **MIX-CANON** = DEC-0069 en papel (Haiku/Sonnet + gpt-image-2 + Jev); **MIX-OPT** = optimización en papel (Terra/Luna + Nano Banana 2.1/Seedream + Jev, requiere cuentas nuevas).

### 2.1 Tabla de recomendación

| # | Caso de uso | Recomendado (mix en que aplica) | Alternativa | Confianza | Tradeoff principal | Condición de cambio (qué medición revierte la elección) |
|---|---|---|---|---|---|---|
| 1 | `conversation.intent.classify` | **Jev 1.14.0** (los tres mixes; DEC-0066). Fallback PROPUESTO: `gpt-6-luna` structured o Decisions API — hoy sin fallback automático (`fallback_route_id` sin consumidor) | Luna structured ($0.00018/evento, 3.7× Jev) | **ALTA** | Formato propietario concentrado en un proveedor pequeño (MCA §2.5 permite cambios incompatibles); español «no equally well» (aviso del proveedor) | B-CLS muestre un generativo con 0 falsos negativos de riesgo y exactitud ≥ Jev a costo igual o menor; o cambio adverso de términos/precio de TypeSafe (MCA permite 60 días de aviso) |
| 2 | `engagement.facebook.comment.classify` | **Jev 1.14.0** | Luna structured / Decisions API | **ALTA** | 3 etiquetas reproduciblemente erróneas (sugg1, pii1, inject1); exactitud 0.895 medida en n=20 sintético | B-CLS por clase (n≥100): exactitud por clase <0.85 o riesgo omitido ⇒ versionar pregunta; si un generativo empatara riesgos a menor costo |
| 3 | `engagement.google.review.classify` | **Jev 1.14.0** | idem | **ALTA** | idem; p95 de 10 s observado durante el incidente TypeSafe del 2026-10-30 (causalidad [INFERENCE]) | idem; si los p95 con datos reales exceden el SLA operativo de engagement |
| 4 | `website.initial.design` | **Sol `gpt-6.1-sol`** (MIX-DEV, DEC-0073) / **Haiku 5.5 o Sonnet 5.5** (MIX-CANON, DEC-0069). Haiku medido 9/9 a $0.0021/diseño vía OR; Sonnet nunca ejecutado (guardrail) | Luna ($0.0012 medido, 3/3) | **MEDIA** | Sol: razonamiento `medium` obligatorio (sin `none`) ⇒ costo/latencia NO MEDIDOS; Sonnet/Haiku directo NO MEDIDOS (0/31 directo) | B-TXT: si Luna alcanza calidad de diseño (firmas distintas ≥3/5, `validateDesign`) a $0.0012 vs $0.0235+, o si el razonamiento de Sol multiplica el costo por diseño |
| 5 | `website.edit.simple` | **Luna `gpt-6-luna`** (los tres mixes; DEC-0073 la única ruta que superó la suite) | Haiku con esquema reducido a <16 uniones; Sonnet vía tool-use forzado (B-EDIT) | **ALTA** | **Riesgo raíz-`anyOf` en OpenAI directo NO MEDIDO**: si `EDIT_SCHEMA` es una unión discriminada en la raíz, OpenAI directo también la rechazaría (requiere envolver en objeto `{kind, patch}`; verificación <$0.001) | Sonda de esquema (B-EDIT): 400 de OpenAI directo ⇒ reescribir esquema o activar mitigación Anthropic; B-EDIT muestre Haiku/Sonnet con parche válido a costo comparable |
| 6 | `website.edit.complex` | **Luna** (MIX-DEV/OPT; $0.00063–0.0007); Sol en candidatas DEC-0073 (0.2) | Haiku/Sonnet vía tool-use (mitigación del límite de 16 uniones documentado) | **ALTA** | Sol `medium` multiplica costo (cota $0.014 vs $0.0007 Luna); calidad superior NO demostrada | B-TXT/B-EDIT: si Sol demuestra calidad que Luna no alcanza (no-cambios colaterales) y el costo es tolerable; si Anthropic directo con esquema aplanado/tool-use empatara calidad a costo de Haiku |
| 7 | `social.facebook.post.compose` | **Luna** (DEV/OPT; $0.00055 medido 6/6, 67 % reparaciones) / **Haiku** (CANON; $0.0017 medido 10/12, 80 % reparaciones) | — (elegir entre ambos con B-TXT directo) | **ALTA** | Luna es 3× más barato por tarea y no perdió casos; Haiku redacta más largo (2,550 vs 745 tokens de salida) — la preferencia humana no fue evaluada | B-TXT con rúbrica humana: si Haiku produce copy que el propietario prefiere y el sobre costo ($0.0012/post) es aceptable; o si Luna directo falla las reglas de dominio |
| 8 | `marketing.campaign.creatives` | **Luna** (DEV/OPT, $0.00055) / **Haiku** (CANON, $0.00146) | — | **ALTA** | idem compose | idem compose |
| 9 | `engagement.facebook.comment.reply` | **Luna** (DEV/OPT, $0.000157) / **Haiku** (CANON, $0.000253) | Sonnet solo para reseñas negativas escaladas (propuesta) | **ALTA** | Riesgo de marca en respuestas públicas: la rúbrica determinista no mide tono; `needs_human` obligatorio ante riesgo ya cubre fallo seguro | B-TXT + rúbrica humana de tono; tasa de `needs_human` falsos (escalación excesiva) por modelo |
| 10 | `engagement.google.review.reply` | idem (#9) | idem | **ALTA** | idem | idem |
| 11 | `conversation.owner.assistant` | **Luna** (DEV/OPT, $0.000356/invocación) o **Haiku** (CANON, $0.000686): **según medición** — τ² Airline favorece a Haiku (72.8 % vs 67.3 % de Luna) con herramientas; el lab pasó ambas | Sonnet 5.5 como escalación (τ² 78.8 %) | **ALTA** | El proxy público usa dominio aéreo en inglés, no las 7 herramientas de lectura de MainSpot; multi-turno NO MEDIDO (hoy 1 pregunta = 1 invocación) | B-ASST (§4): si Haiku directo sostiene tool use mejor que Luna en las 7 herramientas reales a costo aceptable (diferencia absoluta: $0.33/100 preguntas) |
| 12 | `business.insights.generate` | **Luna** (DEV/OPT, $0.000273, abstención gratuita <7 días) / **Haiku** (CANON, $0.000552) | — | **ALTA** | «No inventar cifras» solo parcialmente medido (`untracedNumbers`); el benchmark público de alucinación (Argon 4 %) no cubre Luna/Haiku | B-TXT con `untracedNumbers` sobre corpus de métricas reales del piloto; 2 corridas consecutivas con cifra sin fuente ⇒ suspender el modelo (criterio §5 de 03) |
| 13 | `marketing.campaign.plan` | **Luna** (DEV/OPT; $0.00065 medido 6/6, 17 % reparaciones) / **Haiku** (CANON; 1/2, $0.00398 con fallos pagados) | Sol (candidata DEC-0073, nivel `medium`) | **ALTA** | Haiku pagó un `invalid_output` completo ($0.002) — costo por éxito vs por llamada; calidad del plan no evaluada por humanos | B-TXT: costo por éxito y pass_rate; si Sol/Haiku produce planes que el propietario califica mejor en rúbrica humana |
| 14 | `editorial.calendar.suggest` | **Luna** (los tres mixes; $0.0011 medido 5/5, **80 % de reparaciones** — diagnosticar primero con `validation.first_errors`) | Sol / Batch −50 % (diferible) | **ALTA** | La tasa de reparación del 80 % infla el p95 (16.3 s→18.9 s) y sugiere un problema de prompt/esquema, no del modelo | Si `first_errors` revela defecto de prompt/esquema ⇒ corregirlo baja el costo ~45 %; si persiste, probar Sol o Batch |
| 15 | `website.image.generate` | **`gpt-image-2` medium 1536×1024** (DEC-0069, canon y DEV; $0.0418 generada / $0.053 entregada ×1.3) | MIX-OPT: Nano Banana 2.1 ($0.0438 entregada, AA #4) | **MEDIA** | **0 mediciones MainSpot** (guardrail); texto en español dentro de la imagen = limitación declarada de OpenAI; `high` ($0.1658) excede el maxCost sembrado de $0.08 | B-IMG: tasa de rechazo real, OCR de texto en español, rúbrica humana; si NB 2.1 entrega ≥ calidad a $0.044 y se aprueba cuenta Gemini |
| 16 | `social.facebook.image.generate` | **`gpt-image-2` medium 1024×1024** ($0.053 generada / $0.069–0.138 entregada según variantes) | MIX-OPT: Seedream 5.0 flash ($0.0234 entregada; términos BytePlus **NO leídos** — bloqueante DEC-0067) | **MEDIA** | idem #15; ratio 1:1 con sujetos de negocio sin medir | idem #15; además: verificación de términos BytePlus antes de cualquier dato (sintético o real) |
| P1 | **Edición/adaptación de imagen** — PROPUESTA (no existe en el catálogo) | `gpt-image-2` `/v1/images/edits` (16 refs + máscara, AA-Editing 1137 en high) o Nano Banana 2.1 (14 refs, ~$0.045/edición) | Seedream pro (capas); FLUX excluido por licencia (§6) | **BAJA** | Costo de edición de gpt-image-2 ≈$0.089–0.124 (HIPÓTESIS, tokens de entrada no publicados); requiere caso de uso + contrato nuevos | Decisión de catálogo + B-EDIT-img dentro de B-IMG; sin medición no se compromete |
| P2 | **Orquestación/enrutamiento** — PROPUESTA (capacidad parcial) | Mantener: Jev decide alcance de edición (medido, E06) + resolución activa/canary del registry; formalizar «router» como familia medible con su costo propio | Fallback automático entre rutas (no implementado) | **BAJA** | Sin métrica de overhead; un fallback mal diseñado duplicaría costo sin medida | Implementar registro de costo de orquestación y decidir fallback tras B-TXT (decisión de propietario + desarrollo) |

Confianzas declaradas por celda con su evidencia: **ALTA** (#1–#14) = suite del laboratorio 2026-10-30 pasada por el modelo recomendado **vía OpenRouter** + tarifa directa verificada (`02` §1). **MEDIA** (#15, #16) = precio por imagen verificado en tabla oficial + calidad inferida de AA-Image-T2I/LMArena; **ninguna medición MainSpot**. **BAJA** (P1, P2) = solo inferencia/capacidad declarada.

### 2.2 Lecturas que sostienen la tabla

- **Luna es 1.4–3× más barata que Haiku por tarea a tarifa idéntica** ($0.10/$0.50) porque consume menos tokens de entrada con el mismo prompt (diseño 1,608 vs 4,029; asistente 2,096 vs 4,729) — MEDICIÓN PROPIA vía OR; la causa (tokenizador + traducción de esquema) es HIPÓTESIS y podría cambiar con la vía directa.
- **Luna ganó donde compitió en calidad de contrato**: únicas ediciones que superaron `EDIT_SCHEMA` (17 uniones), calendario 5/5, plan 6/6. Haiku ganó en τ² tool use (72.8 % vs 67.3 %) y pasó todo lo que compitió (diseño 9/9, asistente 11/11, replies, insights). Con n de 1–12, ninguna diferencia es estadísticamente significativa (`03` §1.5) — por eso los casos 7–12 se resuelven con B-TXT, no por la tabla sola.
- **Clasificación**: Jev es el más barato en tiempo real ($0.000034–0.000049/evento), el único con probabilidades calibradas nativas, 0 riesgos omitidos en todas las corridas, y el gate D4 con 98.3 % de intención (240 casos). El costo NO es el argumento (Decisions API solo cuesta 2.4×); la calidad medida sí.
- **La divergencia DEC-0069 (Anthropic prioritario) vs DEC-0073 (OpenAI en desarrollo) queda en abierto (D12)**: ambos mixes cuestan casi lo mismo por cliente/mes ($0.518 vs $0.578 MEDIO); la diferencia decide la calidad medida con vías directas, no el precio. Ver D-REC-1/D-REC-2.

---

## 3. Margen y viabilidad de negocio (resumen del entregable 04 + lectura comercial)

### 3.1 Escenarios y márgenes (precios directos verificados; planes MXN **hipotéticos, no aprobados**)

Costo IA por cliente/mes (FIX 18.7962 MXN/USD del 30-oct-2026):

| Mix | BAJO | MEDIO | ALTO | ABUSO |
|---|---|---|---|---|
| MIX-DEV | $0.20 (MXN 3.78) | **$0.52 (MXN 9.74)** | $1.00 (MXN 18.84) | $1.84 (MXN 34.56) |
| MIX-CANON | $0.22 (MXN 4.09) | $0.58 (MXN 10.86) | $1.15 (MXN 21.60) | $2.14 (MXN 40.28) |
| MIX-OPT | $0.13 (MXN 2.45) | $0.32 (MXN 6.08) | $0.66 (MXN 12.39) | $1.21 (MXN 22.79) |

Margen bruto por plan (neto − PSP − infra $0.12 − IA): **86.9–94.3 %** en el plan MXN 500 (extremos: ABUSO con MIX-CANON 85.6 % … MEDIO MIX-OPT 93.5 %), 90.8–94.8 % en MXN 1,000, 93.5–95.4 % en MXN 2,000. **Incluso en ABUSO el costo IA queda en 1.3–2.6 % del plan 500**: la IA no fija el margen; lo fijan precio, PSP, soporte humano y churn (ESTIMACIÓN, `04` §6.2).

Breakeven: el plan MXN 500 financia con holgura las cuotas completas del piloto en cualquier mix (10 posts + 4 imágenes web + 3 sociales + 1 rediseño + 500 conversaciones ≈ **$0.52/mes** en MIX-DEV MEDIO). La restricción real de las cuotas es producto/operación, no costo IA (HECHO VERIFICADO + ESTIMACIÓN, `04` §6.3).

### 3.2 Lectura de negocio: las imágenes son LA variable comercial

Sensibilidad MEDIO (`04` §7): **imágenes ×2 = +74–82 % del costo IA** en DEV/CANON (DEV +82.4 %, CANON +73.9 %; $0.518→$0.945); precios de texto ±25 % mueven ±$0.13 (irrelevante); FX ±10 % mueve el margen más que **todos** los escenarios de IA juntos (−$1.99/+$1.43). La IA de texto (todo lo no-imagen) es **≤1–2 % del plan** incluso en ALTO.

Consecuencia: **las cuotas de imágenes por plan son la decisión comercial que controla el costo variable de IA**, no la elección de modelo de texto. Propuesta concreta como **HIPÓTESIS (no aprobada)**, calibrada sobre las frecuencias MEDIO/ALTO del 04 y el precio entregado de `gpt-image-2` medium (~$0.053 web / ~$0.069 social):

| Plan (hipotético) | Cuota de imágenes generadas/mes PROPUESTA | Costo IA implícito de la cuota (gpt-image-2 medium) | Excedente PROPUESTO |
|---|---|---|---|
| MXN 500 | 6 (p. ej. 4 web + 2 sociales) | ≈ $0.29 (5.7 % del plan) | por imagen extra, o bloqueo con aviso |
| MXN 1,000 | 12 | ≈ $0.57 | idem |
| MXN 2,000 | 30 | ≈ $1.43 | idem |

Con estas cuotas, el peor cliente razonable queda bajo ALTO ($1.00 MIX-DEV) y el caso ABUSO queda acotado por la cuota misma. Si el producto decidiera duplicar imágenes (variantes/carruseles), la primera palanca de contención es la cuota, no cambiar de proveedor; la segunda es `quality: low` para borradores ($0.0053 web, −87 %) aprobando dentro del producto qué piezas van en medium. **Ninguna cuota aquí está aprobada**: es insumo para D-REC-4.

---

## 4. Decisiones que SÍ requieren propietario (solo las nuevas)

Ninguna de estas está aprobada; cada una es una propuesta trazable. La numeración D-REC-* es propia de este entregable y no modifica DEC/APR existentes.

| # | Decisión | Qué se pide | Por qué | Costo | Si no se hace |
|---|---|---|---|---|---|
| **D-REC-1** | **Ejecutar el benchmark fase 1** (B-CLS + B-EDIT + B-TXT tamizaje, diseño en `03` §4.3–4.4, §4.8) | Autorizar ≈ **USD 4.5** del techo DEC-0068 (disponible ≈ $24.9; B-CLS Jev corre contra el tope propio DEC-0032: ≈$0.02) | Toda selección por caso de uso con datos directos es hoy NO MEDIDO (0/31 Anthropic, 0/53 OpenAI); fase 1 mide tokens, reparaciones, `first_errors`, costo por éxito por celda directa | ≈ $4.5 API + tiempo de ejecución; sin riesgo presupuestal (≈18 % del disponible) | La selección de producción se hará con calidad inferida y costos con factor 1.0 sobre tokens vía OR; el error se pagará en producción, no en el lab |
| **D-REC-2** | **Resolver D12** (DEC-0073 OpenAI-en-desarrollo vs DEC-0069 Anthropic-prioritario) **después** de la fase 1 | Nueva decisión del propietario que reconcile ambas para producción por caso de uso (o global), con la tabla B-TXT como insumo | DEC-0073 se autodeclara reversible y «no selección comercial»; producción no está decidida; dos decisiones vigentes apuntan a proveedores distintos | $0 (decisión) | Ambigüedad permanente: rutas de dev y criterios de producción divergen sin resolución |
| **D-REC-3** | **Habilitar saldo OpenAI directo y diagnosticar el `bad_request` de Anthropic** | Cargar saldo a la cuenta OpenAI (bloquea 20/53 suites) y leer el cuerpo del 400 de Anthropic (0/31; puede ser esquema, no calidad) — lectura de logs sin costo | Sin cuenta funcional no hay fase 1 ni fase 2; el diagnóstico de Anthropic decide si su alternativa técnica es viable (ediciones) | Saldo inicial a elección del propietario (el benchmark necesita <$5); diagnóstico $0 | Benchmark bloqueado indefinidamente; la alternativa Anthropic queda sin poder evaluarse jamás |
| **D-REC-4** | **Decidir cuotas de imágenes por plan** (§3.2) | Decisión comercial: cuota por plan + manejo del excedente (cobro o bloqueo) + qué piezas van en `medium` vs `low` | Las imágenes dominan el costo variable (+74–82 % del costo IA si se duplican, según mix); es la única partida que puede amenazar margen si el producto se amplía | $0 | El costo de imágenes queda indefinido y cualquier ampliación de producto (carruseles, variantes) puede duplicar el costo IA sin control |
| **D-REC-5** | **Evaluar Nano Banana 2.1 / Seedream vía cuenta directa** (fuera de OpenRouter) **si se quieren alternativas de imagen** | Crear/autorizar cuenta Gemini pagada y (para Seedream) verificar términos BytePlus primero (NO leídos, bloqueante DEC-0067) — solo datos sintéticos hasta entonces | NB 2.1: −80 % de costo vs medium y AA #4; Seedream flash $0.023 entregada. Son los únicos candidatos MIX-OPT viables | Benchmark B-IMG de alternativas ≈ $2.6–3.5 si se aprueba; $0 si no | La imagen queda mono-proveedor (OpenAI) sin alternativa medida; un cambio de precio de OpenAI (aviso de 14 días) no tendría contrapeso |
| **D-REC-6** | **Activar caché de prompts en el dispatcher** | Decidir + tarea de desarrollo (hoy el dispatcher no envía `cache_control`); perfiles ya cumplen los mínimos (Anthropic 512, OpenAI 1,024) | Ahorro MEDIO 2.7 % (DEV) – 6.1 % (CANON); −35–43 % en asistente; −41 % en el abuso del asistente; mejora p95 del asistente | Desarrollo (una vez) + sobrecoste único de escritura ≈ $0.0006/prefijo | Se paga entrada plena en cada invocación para siempre; el efecto crece con el multi-turno del asistente si se implementa |
| **D-REC-7** | **Registrar `validation.first_errors`** | Pequeño cambio del dispatcher (registro del error del primer intento antes de reparar) | Las reparaciones ocultan la causa: el calendario con 80 % de reparaciones no es diagnosticable hoy; condiciona las condiciones de cambio de #14 y la mitad de B-TXT | Desarrollo pequeño, $0 API | Cada celda con reparaciones frecuentes seguirá siendo una caja negra; las decisiones de nivel por caso seguirán tomándose sin causa raíz |

---

## 5. Condiciones de cambio y vigencia

### 5.1 Precios y modelos con caducidad conocida (HECHO VERIFICADO, fuentes de `02` §1 y `evidence/*`)

| Fecha | Evento | Afecta |
|---|---|---|
| **2026-11-21** | Fin de tarifa promocional de `gpt-5.6-sol` (no es candidato vigente; advertencia de caducidad del patrón «igual precio») | solo referencia |
| **2026-11-30 → 2026-12-01** | **Retiro de `claude-sonnet-4-5-20250929`**; cualquier referencia en código/config debe migrar a `claude-sonnet-5-5` antes | catálogo si se agregara Sonnet 4.5 |
| **2026-12-01** | **Gemini 4 Argon ×2** ($2/$10 → $4/$20; caché $0.10→$0.20): cualquier MIX-OPT con Argon pierde sentido ese día | MIX-OPT (Argon no es pilar, pero revisar) |
| **2026-12-01** | **Apagado `gpt-image-1.5` y `gpt-image-1-mini`** (OpenAI) — los «baratos» nominales de imagen dejan de existir | alternativas de imagen |
| **2026-12-11** | Apagado `gpt-5-mini`/`gpt-5-nano` | referencia |
| **2027-01-01** | Gemini 3.8 Flash ×2 ($0.75→$1.50) | estudio |
| continuo | Cambios de precio OpenAI efectivos **14 días** tras publicarse; Anthropic y TypeSafe sin fecha fija (TypeSafe avisó 60 días de MCA; sostenibilidad del precio «esperamos que baje» — cita del proveedor) | todo; reverificación mensual de páginas de pricing |

### 5.2 Cómo se revierte una ruta (mecánica existente, sin código)

El ciclo `DRAFT → TESTED → APPROVED → CANARY | ACTIVE → RETIRED` ya está implementado (`registry.ts:5-7, 196-212`): una ruta activa reemplazada vuelve a `APPROVED` (destino de rollback), y `registry.resolve` enruta canary por hash de `useCase:key` (porcentaje configurable). **El cambio de modelo por caso de uso se ejecuta desde la consola (rollout de rutas) sin tocar código**, siempre que la ruta candidata esté TESTED. Límites conocidos: no existe fallback automático entre rutas (`fallback_route_id` sin consumidor) y el dispatcher no reintenta HTTP en texto/imagen (solo Jev ×3 y jobs ×3) — HECHO VERIFICADO. Revertir = reactivar la ruta previa desde consola; el costo de una decisión equivocada es acotado por `max_cost_usd` ≤ $2/llamada y los presupuestos DEC-0068/0032.

### 5.3 Qué vigilar trimestralmente (PROPUESTA de calendario)

1. **Precios**: páginas de pricing de OpenAI/Anthropic/Google/TypeSafe; reverificar los escalones de caché/Batch contra `ai_model.pricing` sembrado (todo costo directo será `estimated`: el precio sembrado ES la contabilidad).
2. **Uso real por cliente** (cohortes del piloto): sustituir las HIPÓTESIS de frecuencia del 04 §3 por datos observados; recalcula la tabla de §3.1.
3. **Tasa de rechazo de imágenes real** (k=1.3 es HIPÓTESIS) y cuota cumplida vs cobrada.
4. **Estados de proveedor**: incidentes Anthropic (31 en ~3 meses), uptime OpenAI Images (99.990 %), TypeSafe (99.858 %, incidentes de sobrecarga); revisar si la concentración single-vendor (§4 de 02) empezó a materializarse en incidentes que afectaron producto.
5. **Términos**: cambios del MCA TypeSafe (60 días de aviso), DPA/subencargados, y el cierre de D10 (verificación de términos — acto del propietario).
6. **Modelos deprecados**: ventana de retiro de cada modelo en uso (Haiku 5.5 no antes del 7-oct-2027; Luna/Sol sin snapshot fechado — fijar snapshot al adoptar en producción).

---

## 6. Lo que NO se recomienda (y por qué)

1. **OpenRouter en ejecuciones de producto** — DEC-0069 lo prohíbe para nuevas ejecuciones y esta investigación no reabre esa puerta por sí sola: comisión de 5.5–8 % sobre el gasto, **sin Batch −50 % para ningún modelo de imagen**, `tool_choice` forzado no disponible en endpoints Claude, los límites de esquema del proveedor subyacente se mantienen (16 uniones Anthropic), y añade un tercero más al flujo de datos (proveedores como subencargados sin aviso de 30 días). Valor residual legítimo: **evaluación multi-modelo** (una clave para Argon/DeepSeek/Seedream/FLUX) — reactivarlo aunque sea para evaluación requiere decisión (D-REC-5 lo cubre con cuentas directas, que es mejor alternativa).
2. **Usar la suscripción Codex/OMP como backend de producto** — `openai-codex/*` es acceso OAuth por suscripción de consumidor: los ToU prohíben extracción programática y redistribución; Plus/Pro sin compromiso de no-entrenamiento por defecto; **sin DPA**. No apta para backend; la vía válida es API key bajo Services Agreement (HECHO VERIFICADO, `openai.md` §2).
3. **FLUX 3 / BFL para datos reales** — los FLUX API Service Terms §2b otorgan a BFL una **licencia perpetua e irrevocable sobre Entradas y Salidas para entrenar sus modelos**: incompatible con fotos/productos de clientes bajo DEC-0067 sin decisión explícita del propietario. Klein es el más barato de la lista ($0.012 entregada) y aun así queda excluido para datos reales; sintético solo si el propietario aprueba la cuenta.
4. **Clasificar con generativos sin benchmark B-CLS** — la diferencia de costo es marginal (<$1/mes incluso en abuso), así que la decisión es de calidad; con n=20 del lab **ninguna comparación es significativa** y un falso negativo de riesgo (seguridad/legal/PII) tiene tolerancia 0. Sustituir Jev sin B-CLS por clase (n≥100) sería tomar la decisión más sensible del producto con la evidencia más débil.
5. **Subir el presupuesto o abrir más cuentas sin ejecutar primero la fase 1 del benchmark** — el techo de $25 cubre el benchmark completo (≈$15.3 base / $23 con holgura), pero **sin margen para repetirlo**: gastar en exploración no dirigida (o en más cuentas antes de saber qué celda decide) consume el único presupuesto disponible. Fase 1 (≈$4.5) define las celdas de decisión; fase 2 (≈$11) solo después.

Adicional, de conservación de presupuesto: no evaluar `gpt-image-2.5-*` en producción antes de conocer su costo por imagen (DESCONOCIDO; consumo no documentado) ni `high` de `gpt-image-2` en rutas con maxCost $0.08 (lo excede: $0.1658).

---

## Fuentes

1. `research/ai-provider-economics/HANDOFF.md` — objetivo, §7 (definición del entregable 05), aislamiento.
2. `research/ai-provider-economics/01-inventory.md` — estado técnico, DEC-0066..0073, migración 0029, discrepancias D1–D12 (D12 en §9).
3. `research/ai-provider-economics/02-provider-comparison.md` — precios directos verificados, costos por tarea con tokens medidos, D12 en abierto (§5), imágenes (§6), impuestos MX (§2.5).
4. `research/ai-provider-economics/03-quality-benchmarks.md` — lo medido/no medido (§1–2), fallo de directos 0/31 y 0/53 (§2), diseño de benchmark B-CLS/B-TXT/B-IMG/B-EDIT/B-ASST y costo ≈$15.3 (§4), fallo seguro (§5).
5. `research/ai-provider-economics/04-unit-economics.md` (+ `.csv`, `.py`) — mixes, escenarios, márgenes 86.9–94.3 %, sensibilidad (imágenes ×2 dominante, FX), breakeven, cuotas del plan piloto (migrations/0009).
6. `research/ai-provider-economics/evidence/` — `anthropic.md` (retiro Sonnet 4.5 30-nov-2026, límite 16 uniones), `openai.md` (gpt-image-2, Decisions API, apagados 2026-12-01/11), `typesafe-jev.md` (MCA, DEC-0032, comparación vs generativos), `openrouter.md` (comisión, guardrails ZDR), `image-providers.md` (NB 2.1, Seedream, licencia BFL §2b, costo entregado §10), `text-models-benchmarks.md` (LMArena Spanish 2026-10-27, τ², AA), `lab-traces.md` + `lab-invocations.csv` (tokens/costos medidos), `lab-history.md`, `business-inputs.md` (FIX, PSP, infra).
7. Evidencia SOL MAIN citada vía `03` §6: `evidence/ai-core/direct-evals-2026-11-03.json`, `openai-development-evals-2026-11-03.json`, `jev-gate-dev-2026-11-03.json`, `docs/architecture/ai-core.md`, `docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-RESULTS.md`, `migrations/0009_subscriptions_plans.sql`, `src/ai/{catalog,registry,dispatcher}.ts`, `src/engagement/service.ts`.

## Huecos

| Id | Hueco | Cómo se cierra |
|---|---|---|
| G1 | **Cero generaciones directas exitosas** (0/31 Anthropic, 0/53 OpenAI): ninguna recomendación de texto alcanza ALTA sobre vía directa | D-REC-1 (fase 1 del benchmark) + D-REC-3 (saldo/diagnóstico) |
| G2 | Causa exacta del `bad_request` de Anthropic directo (¿esquema de 17 uniones u otra cosa? falla también en casos sin parche) | Lectura del cuerpo del 400 en logs de SOL MAIN ($0); sonda de B-EDIT (≈$0.01) |
| G3 | Riesgo raíz-`anyOf` de `EDIT_SCHEMA` en OpenAI directo (si la raíz es una unión, OpenAI también rechaza) | Sonda de esquema <$0.001 dentro de B-EDIT |
| G4 | Imágenes: 0 invocaciones MainSpot en la historia (costo de reintento real, texto español en imagen, fidelidad de marca) | D-REC-1 fase 2 (B-IMG ≈$8.3) + D-REC-5 (alternativas) |
| G5 | Tokens/calidad de Sol/Terra/Sonnet directos (factor 1.0 sobre Luna/Haiku medidos; razonamiento `medium` de Sol sin medir) | B-TXT (fase 1) |
| G6 | Cuotas de imagen y frecuencias reales: todas las frecuencias del 04 son HIPÓTESIS calibradas contra cuotas del piloto | Cohortes del piloto + decisión D-REC-4 |
| G7 | Validación formal de la «verificación única de términos» (D10) y ZDR activado en TypeSafe | Decisión del propietario; solicitud a TypeSafe |
| G8 | Presupuesto productivo de Jev (DEC-0032 es global/desarrollo) y tope por negocio/día en runtime | Nueva decisión de presupuesto (fuera de D-REC-1..7; propuesta pendiente) |
| G9 | Multi-turno real del asistente y efecto de caché | B-ASST (≈$2.8) + D-REC-6 |
| G10 | Términos BytePlus (Seedream) no leídos — bloqueante para cualquier uso de Seedream | Verificación documental previa a D-REC-5 |
