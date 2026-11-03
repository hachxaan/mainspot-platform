# 04 — Unit economics del MainSpot AI Core (por cliente/mes, escenarios, mixes y sensibilidad)

Fecha: 2026-11-03. Reproducible: `python3 04-unit-economics.py` (solo stdlib; sin red, sin secretos, determinista).
Salida: `04-unit-economics.csv` — **192 filas (16 casos × 4 escenarios × 3 mixes)**, sha256 de la corrida verificada `314e75615c1343e467d69b5216d0bd205b5b8a505e0cee6bc73646b1c9190cb1` (idéntico en dos corridas consecutivas).

Etiquetas usadas: **HECHO VERIFICADO** (fuente primaria fechada), **MEDICIÓN PROPIA** (laboratorio del 2026-10-30, negocio sintético, n pequeño), **ESTIMACIÓN** (cálculo con fórmula explícita), **HIPÓTESIS** (supuesto razonado), **DESCONOCIDO**.

## 0. Alcance y advertencia principal

Este documento modela el costo IA **por cliente/mes** y su efecto en el margen de los planes hipotéticos MXN 500/1,000/2,000, **en papel, con precios directos verificados**. No activa ningún proveedor ni cambia rutas (DEC-0069/DEC-0073 siguen vigentes). La mayor parte del costo IA del catálogo es texto barato y clasificación casi gratuita; el componente dominante son las **imágenes generadas**, que están **NO MEDIDAS** (0 invocaciones en el laboratorio: guardrail).

## 1. Método y fórmulas

**Texto y clasificación** (por invocación):

```
costo = (t_in × P_in + t_out × P_out) / 1e6          [tokens medidos → MEDICIÓN PROPIA]
Jev   = t_in × 0.042 / 1e6                            [salida gratis; fallos NO facturan]
```

- Los tokens medidos (`evidence/lab-traces.md`, promedio por invocación exitosa) **YA INCLUYEN las reparaciones** (el dispatcher paga la conversación completa dos veces cuando repara). Este modelo **NO las vuelve a aplicar**: factor de reintento de texto = 1.0. La tasa medida solo se usa en la sensibilidad «reparaciones ×2».
- Sin fallbacks: no hay consumo de `fallback_route_id` en el snapshot (01-inventory §5.3) ⇒ costo de fallback = 0 (HECHO VERIFICADO, no observado en operación).

**Imágenes** (por imagen generada; el dispatcher usa n=1, sin variantes — 01-inventory §3.1):

```
costo_entregada = precio_base × k_retry,  k_retry = 1.3   [HIPÓTESIS de image-providers §10.1: regeneraciones por rechazo/moderación]
```

- gpt-image-2 cobra además el prompt de texto (≈150 tokens × $5/MTok ≈ $0.00075) (openai.md §7.1). Calidad **medium** como base; `low` para borradores existe ($0.006 1024²).
- Batch de imágenes −50 % documentado para gpt-image-2 y Nano Banana (Seedream sin Batch documentado → no modelado).

**Batch de texto (−50 %)**: solo casos no interactivos — `business.insights.generate`, `editorial.calendar.suggest`, `marketing.campaign.plan`. **NO** aplica a respuestas a comentarios/reseñas ni al asistente (interactivos).

**Caché de prefijo** (§5): fracción del input leída a precio de lectura (régimen estacionario; la escritura única se reporta aparte).

## 2. Perfiles por caso de uso (tokens por tarea, fuente y latencia)

### 2.1 Origen de los tokens por caso × mix

| Caso de uso | MIX-DEV | MIX-CANON | MIX-OPT | Fuente del perfil | Etiqueta |
|---|---|---|---|---|---|
| website.initial.design | sol | sonnet | terra | tokens MEDIDOS de Luna (1,608/2,033) para DEV/OPT; MEDIDOS de Haiku (4,029/3,396) para CANON-sonnet ×1.0 | tokens MEDIDOS; el **modelo** del mix NO MEDIDO (factor 1.0 declarado) |
| website.edit.simple | luna | haiku | luna | Luna MEDIDO (1,735/202); Haiku sin éxitos (0/10, `bad_request` 17 uniones) → PERFIL §7 anthropic.md (5,000/600) | Luna MEDIDA; Haiku ESTIMACIÓN |
| website.edit.complex | sol | haiku | terra | Luna MEDIDO (2,202/958); Haiku → PERFIL §7 (7,000/3,500) | idem |
| conversation.intent.classify | jev | jev | jev | MEDIDO 804 in / 140 out | MEDICIÓN PROPIA |
| website.image.generate | gpt-image-2 1536×1024 medium | idem | nano-banana-2.1 1K 16:9 | precio por imagen HECHO VERIFICADO; consumo real de la función NO MEDIDO (guardrail) | HECHO/ESTIMACIÓN |
| social.facebook.post.compose | luna | haiku | luna | MEDIDO (Luna 1,776/745; Haiku 4,424/2,550) | MEDICIÓN PROPIA |
| social.facebook.image.generate | gpt-image-2 1024² medium | idem | seedream-5-0-flash | idem | HECHO/ESTIMACIÓN |
| engagement.facebook.comment.classify | jev | jev | jev | MEDIDO 1,158 in / 265 out | MEDICIÓN PROPIA |
| engagement.facebook.comment.reply | luna | haiku | luna | MEDIDO (621/189 vs 1,287/249) | MEDICIÓN PROPIA |
| engagement.google.review.classify | jev | jev | jev | MEDIDO 1,158/265 | MEDICIÓN PROPIA |
| engagement.google.review.reply | luna | haiku | luna | MEDIDO (645/182 vs 1,315/203) | MEDICIÓN PROPIA |
| conversation.owner.assistant | luna | haiku | luna | MEDIDO (2,096/293 vs 4,729/427); 1 pregunta = 1 invocación (sin multi-turno) | MEDICIÓN PROPIA |
| marketing.campaign.plan | luna (Batch √) | haiku (Batch √) | terra (Batch √) | MEDIDO (1,105/1,072 vs 5,475/2,864) | MEDICIÓN PROPIA |
| marketing.campaign.creatives | luna | haiku | luna | MEDIDO (1,580/760 vs 4,243/2,067) | MEDICIÓN PROPIA |
| business.insights.generate | luna (Batch √) | haiku (Batch √) | luna (Batch √) | MEDIDO (712/404 vs 2,135/677) | MEDICIÓN PROPIA |
| editorial.calendar.suggest | luna (Batch √) | haiku (Batch √) | luna (Batch √) | Luna MEDIDO (1,767/1,860); Haiku sin éxitos (0/1) → proxy compose Haiku (4,424/2,550), probable sobreestimación | Luna MEDIDA; Haiku ESTIMACIÓN (proxy) |

Justificación de los factores: la comparación OpenAI↔Anthropic se decide en **tokens por tarea** (mismas tarifas 0.10/0.50 y 2/10 por MTok), y los únicos tokens comparables se midieron vía OpenRouter (anthropic.md §7.4, openai.md §7.4). Para Sol/Terra/Sonnet no existe medición; se usan los tokens medidos del modelo más cercano con **factor 1.0** (cota razonable: el mismo prompt; el razonamiento `medium` de Sol añadiría tokens — ver sensibilidad). Latencias de casos sin medición muestran el proxy del modelo de origen (Haiku para sonnet; Luna para sol/terra).

### 2.2 Tasa de reparación MEDIDA (los tokens ya la incluyen)

| Caso × modelo | p(reparación) | Caso × modelo | p(reparación) |
|---|---|---|---|
| compose Haiku | 80 % | compose Luna | 67 % |
| creatives Haiku / Luna | 75 % / 50 % | calendario Luna | 80 % |
| plan Haiku / Luna | 100 % / 17 % | insights Haiku / Luna | 50 % / 25 % |
| edit.complex Luna | 12 % | replies Luna | 25 % |
| design, asistente, Jev, ediciones Haiku | 0 % o sin medición | — | — |

### 2.3 Latencia medida p50/p95 (ms, sobre éxitos; lab-traces)

| Caso | Haiku | Luna | Jev |
|---|---|---|---|
| diseño inicial | 17,105 / 23,250 | 13,415 / 15,266 | — |
| edición simple | — (0/10) | 2,857 / 14,119 | — |
| edición compleja | — (0/2) | 6,091 / 18,979 | — |
| compose | 13,129 / 18,761 | 5,926 / 8,781 | — |
| respuesta FB / Google | 2,122 / 3,999 · 1,228 / 3,543 | 2,483 / 3,782 · 1,974 / 3,992 | — |
| asistente | 7,383 / 12,204 | 3,310 / 13,186 | — |
| insights | 3,693 / 9,342 | 3,679 / 7,922 | — |
| creatives | 10,207 / 19,199 | 5,804 / 8,620 | — |
| plan | 15,160 / 15,160 | 7,746 / 9,648 | — |
| calendario | — (0/1) | 16,307 / 18,864 | — |
| clasificación intención / comentario / reseña | — | — | 729/866 · 750/919 · 763/966 |

## 3. Escenarios BAJO / MEDIO / ALTO / ABUSO (HIPÓTESIS calibradas contra las cuotas del plan piloto)

Cuotas del plan piloto (migrations/0009): **website 1 · social_posts 10 · social_ads 5 · reviews_managed 20 · agents 5 · conversations 500**. Tope de respuestas automáticas: `max_auto_replies_per_hour` **10 por defecto, rango 1–60** (src/engagement/service.ts:153,187-190). Frecuencias mensuales por cliente:

| Caso | BAJO | MEDIO | ALTO | ABUSO | Justificación / control que acota |
|---|---|---|---|---|---|
| website.initial.design | 0.25 | **1** | 2 | 3 | cuota website=1; ALTO = diseño inicial + 1 rediseño; ABUSO = rediseño quincenal |
| website.edit.simple | 2 | 5 | 10 | 20 | sin cuota mensual explícita (ediciones del dueño); acotadas por rate limits del plano |
| website.edit.complex | 0.25 | 1 | 2 | 4 | rediseños contados |
| conversation.intent.classify | 2 | 5 | 10 | 20 | 1 por job de edición (1:1) |
| website.image.generate | 2 | **4** | 8 | 12 | ≤4 slots por diseño; MEDIO = slots del diseño del límite de cuota |
| social.facebook.post.compose | 4 | 8 | **10** | 30 | cuota social_posts=10 (ALTO = cuota); ABUSO = 10 publicadas + 20 intentos que consumen IA antes del chequeo near-duplicate/cuota (HIPÓTESIS de acotamiento) |
| social.facebook.image.generate | 1 | 3 | 5 | 10 | tope = cuota social_posts con imagen en todas |
| engagement.facebook.comment.classify | 10 | 40 | 100 | 750 | techo técnico 10/h × 720 h = 7,200/mes; ABUSO acotado a 25/día; clasifica todo comentario entrante |
| engagement.facebook.comment.reply | 8 | 30 | 80 | 600 | mismo techo 10/h; solo `safe_auto_reply`; acotado a 20/día |
| engagement.google.review.classify / reply | 5 / 4 | 12 / 10 | 20 / 20 | 60 / 60 | cuota reviews_managed=20 (ALTO = cuota); ABUSO = 3× cuota; el excedente queda bloqueado |
| conversation.owner.assistant | 20 | 100 | 300 | **500** | cuota conversations=500/mes (ABUSO = cuota); 1 pregunta = 1 invocación |
| marketing.campaign.plan / creatives | 0.25 | 1 | 2 | 5 | cuota agents=5 (ABUSO = cuota) |
| business.insights.generate | 1 | 4 | 8 | 30 | abstención gratuita con <7 días de actividad; ABUSO = 1/día |
| editorial.calendar.suggest | 0.25 | 1 | 2 | 4 | aprobación humana del calendario |

MEDIO se fija ligeramente por debajo de cada cuota (uso esperado del plan piloto); ALTO = cuota o uso intensivo; ABUSO = techo técnico/plan, **detectable y acotable** (las cuotas 0009 y el tope horario detienen el cobro, y la invocación de IA solo ocurre dentro de esos topes o antes del chequeo de cuota en el peor caso documentado).

## 4. Mixes de proveedor y costo por evento (USD, precios directos verificados)

- **MIX-DEV** — vigente en desarrollo tras DEC-0073: OpenAI texto Sol/Luna + OpenAI imágenes gpt-image-2 + Jev. 
- **MIX-CANON** — DEC-0069: Anthropic Haiku 5.5 (tramo ≤100K) + Sonnet 5.5 en diseño + OpenAI gpt-image-2 + Jev.
- **MIX-OPT** — optimización en papel: Terra/Luna por caso + Nano Banana 2.1 (web) / Seedream 5.0 flash (social) + Jev. Requeriría habilitar cuentas Gemini/BytePlus (decisión del propietario; términos BytePlus sin verificar).

### 4.1 Costo unitario por caso × mix (USD/evento; escenario MEDIO; salida del script)

| Caso | MIX-DEV | MIX-CANON | MIX-OPT |
|---|---|---|---|
| website.initial.design | $0.023546 (sol) · caché $0.021407 | $0.042018 (sonnet) · caché $0.036659 | $0.011773 (terra) · caché $0.010704 |
| website.edit.simple | $0.000275 | $0.000800 | $0.000275 |
| website.edit.complex | $0.013984 | $0.002450 | $0.006992 |
| conversation.intent.classify (Jev) | $0.000034 | $0.000034 | $0.000034 |
| website.image.generate | $0.054275 | $0.054275 | $0.043680 |
| social.facebook.post.compose | $0.000550 | $0.001717 | $0.000550 |
| social.facebook.image.generate | $0.069875 | $0.069875 | $0.023400 |
| engagement.facebook.comment.classify (Jev) | $0.000049 | $0.000049 | $0.000049 |
| engagement.facebook.comment.reply | $0.000157 | $0.000253 | $0.000157 |
| engagement.google.review.classify (Jev) | $0.000049 | $0.000049 | $0.000049 |
| engagement.google.review.reply | $0.000155 | $0.000233 | $0.000155 |
| conversation.owner.assistant | $0.000356 · caché $0.000224 | $0.000686 · caché $0.000388 | $0.000356 · caché $0.000224 |
| marketing.campaign.plan | $0.000647 · batch $0.000323 | $0.001979 · batch $0.000990 | $0.006465 · batch $0.003233 |
| marketing.campaign.creatives | $0.000538 | $0.001458 | $0.000538 |
| business.insights.generate | $0.000273 · batch $0.000137 | $0.000552 · batch $0.000276 | $0.000273 · batch $0.000137 |
| editorial.calendar.suggest | $0.001107 · batch $0.000553 | $0.001717 · batch $0.000859 | $0.001107 · batch $0.000553 |

Lecturas: (1) **Jev es inmune al mix** ($0.000034–0.000049 por evento; <0.1 % del costo IA). (2) El diseño web y las **imágenes** dominan; en texto el volumen (compose) decide. (3) MIX-CANON ediciones usan perfiles §7 sin medir (Haiku 0/10 en lab por el límite de 16 uniones de Anthropic); con esquema aplanado el costo real podría acercarse al de Luna. (4) Terra queda entre Luna y Sol ($0.006992 vs $0.013984 vs $0.023546 en diseño) — el escalón que Anthropic no tiene.

## 5. Caché de prefijo (HIPÓTESIS declarada)

Supuesto del modelo: **70 % del input cacheable en asistente y diseño; 0 % en clasificación de un solo turno** (no hay prefijo compartido); los demás casos sin caché modelada. Mínimos cacheables: Anthropic **512** tokens, OpenAI **1,024** (HECHO VERIFICADO en anthropic.md §2.3 y openai.md §3.4). Comprobación de los perfiles: diseño 0.7×4,029 = 2,820 ≥ 512 (Haiku/Sonnet) y 0.7×1,608 = 1,126 ≥ 1,024 (Luna/Sol/Terra) ✓; asistente 3,310 y 1,467 ✓. **El dispatcher hoy no envía `cache_control`** (lab-traces, hueco) — esto es un ahorro potencial, no el costo base.

Ahorro mensual (escenario) y sobrecoste **único** de la primera escritura por prefijo:

| Mix | BAJO | MEDIO | ALTO | ABUSO | Escritura inicial (una vez) |
|---|---|---|---|---|---|
| MIX-DEV | $0.00318 | $0.01534 | $0.04389 | $0.07244 | $0.000599 |
| MIX-CANON | $0.00730 | $0.03515 | $0.10010 | $0.16504 | $0.001493 |
| MIX-OPT | $0.00291 | $0.01427 | $0.04175 | $0.06923 | $0.000318 |

En MEDIO el ahorro es ≈ 2.7 % (DEV) / 6.1 % (CANON) del costo IA: la caché **no cambia la economía** del negocio, pero sí el p95 del asistente y el costo del ABUSO del asistente (−41 % en esa partida). El efecto es mayor en perfiles dominados por input (asistente −35–43 %) y pequeño en diseño dominado por salida (−4–13 %).

## 6. Resultados: costo IA por cliente/mes, margen por plan y breakeven

### 6.1 Costo IA por cliente/mes por escenario × mix (USD y MXN al FIX 18.7962)

| Mix | BAJO | MEDIO | ALTO | ABUSO |
|---|---|---|---|---|
| MIX-DEV | $0.2012 (MXN 3.78) | **$0.5180 (MXN 9.74)** | $1.0023 (MXN 18.84) | $1.8386 (MXN 34.56) |
| MIX-CANON | $0.2173 (MXN 4.09) | $0.5776 (MXN 10.86) | $1.1494 (MXN 21.60) | $2.1432 (MXN 40.28) |
| MIX-OPT | $0.1303 (MXN 2.45) | $0.3232 (MXN 6.08) | $0.6593 (MXN 12.39) | $1.2125 (MXN 22.79) |

Variante con **Batch aplicado a los elegibles** (insights, calendario, plan): MIX-DEV MEDIO $0.5166, MIX-CANON $0.5746, MIX-OPT $0.3189 — ahorro adicional ≤ 0.9 % del total (el Batch solo importa si esos casos crecen).

### 6.2 Margen de contribución y margen bruto por plan

Fórmula: `margen = neto_MXN/FIX − PSP − infra − IA`. Netos con IVA 16 % (431.03 / 862.07 / 1,724.14 MXN); PSP = Openpay tarjeta nacional 2.9 % + $2.50 + IVA sobre el precio al público (la más barata publicada en tarjeta; SPEI $8.00+IVA es aún más barata); infra = **USD 0.12**/cliente/mes (escala 1,000 clientes; rango medido 0.07–0.19); IA = costo std del escenario/mix.

| Plan (neto USD) | PSP (USD) | Escenario | MIX-DEV margen (%) | MIX-CANON margen (%) | MIX-OPT margen (%) |
|---|---|---|---|---|---|
| MXN 500 (USD 22.932) | 1.049 | BAJO | 21.562 (94.0 %) | 21.546 (94.0 %) | 21.633 (94.3 %) |
| | | MEDIO | 21.245 (92.6 %) | 21.185 (92.4 %) | 21.440 (93.5 %) |
| | | ALTO | 20.761 (90.5 %) | 20.613 (89.9 %) | 21.104 (92.0 %) |
| | | ABUSO | 19.924 (86.9 %) | 19.620 (85.6 %) | 20.550 (89.6 %) |
| MXN 1,000 (USD 45.864) | 1.944 | MEDIO | 43.282 (94.4 %) | 43.222 (94.2 %) | 43.477 (94.8 %) |
| | | ABUSO | 41.961 (91.5 %) | 41.657 (90.8 %) | 42.588 (92.9 %) |
| MXN 2,000 (USD 91.728) | 3.734 | MEDIO | 87.356 (95.2 %) | 87.297 (95.2 %) | 87.551 (95.4 %) |
| | | ABUSO | 86.036 (93.8 %) | 85.731 (93.5 %) | 86.662 (94.5 %) |

(Tabla completa BAJO–ABUSO × 3 mixes en la salida del script; se listan MEDIO y ABUSO como extremos relevantes.) **Lectura central:** incluso en ABUSO el costo IA queda en 1.3–2.6 % del plan 500 — el margen no lo fija la IA sino precio, PSP, soporte humano (USD 4.1–4.4/h; ~USD 0.51–0.55/ticket, business-inputs §7) y churn. **Ningún escenario de IA amenaza el margen de los planes hipotéticos.**

### 6.3 Breakeven: cuántas unidades financia cada plan

Presupuesto variable por plan (neto − PSP − infra): MXN 500 → **$21.76**; 1,000 → $43.80; 2,000 → $87.87 (USD). Unidades financiadas si todo ese presupuesto se destinara a UN caso (unitarios MEDIO de §4.1):

| Plan / mix | Posts | Imágenes web | Rediseños | Respuestas a comentarios |
|---|---|---|---|---|
| 500 / MIX-DEV | 39,562 | 401 | 924 | 138,971 |
| 500 / MIX-CANON | 12,672 | 401 | 518 | 85,951 |
| 500 / MIX-OPT | 39,562 | 498 | 1,849 | 138,971 |
| 1,000 / MIX-DEV | 79,622 | 807 | 1,860 | 279,693 |
| 2,000 / MIX-DEV | 159,742 | 1,619 | 3,732 | 561,138 |

**El plan 500 financia con holgura las cuotas completas del piloto en cualquier mix** (10 posts + 4 imágenes + 1 rediseño + 500 conversaciones ≈ $0.52 en MIX-DEV). La restricción real de las cuotas es producto/operación, no costo IA. Si la IA cubriera soporte humano (30 respuestas + 100 asistencias MEDIO), el ahorro potencial frente a un agente (~$15–25/ticket-mes) es 30–50× el costo IA de esa partida.

## 7. Sensibilidad (escenario MEDIO, costo IA std por cliente/mes; margen plan 500 para FX)

| Mix | Base | Precios +25 % | Precios −25 % | Imágenes ×2 | Reparaciones ×2 | Mix de uso ALTO | FX −10 % (margen) | FX +10 % (margen) |
|---|---|---|---|---|---|---|---|---|
| MIX-DEV | $0.5180 | $0.6475 | $0.3885 | $0.9447 | $0.5241 | $1.0023 | $23.676 | $19.256 |
| MIX-CANON | $0.5776 | $0.7219 | $0.4332 | $1.0043 | $0.5944 | $1.1494 | $23.617 | $19.196 |
| MIX-OPT | $0.3232 | $0.4040 | $0.2424 | $0.5681 | $0.3349 | $0.6593 | $23.871 | $19.450 |

- **Imágenes ×2 es el factor dominante** (+82–83 % del costo IA en DEV/CANON): cualquier decisión de producto que duplique imágenes (variantes, carruseles) domina cualquier optimización de precio de texto.
- **Precios ±25 %**: ±25 % del costo IA (−0.13/+0.13 USD en plan 500 MEDIO) — irrelevante para el margen.
- **Reparaciones ×2**: +1.2–2.9 % del costo IA (los tokens medidos ya incluyen las reparaciones actuales; el factor añade `freq × unitario × p_repair`).
- **FX ±10 %** mueve el margen del plan 500 más que todos los escenarios de IA juntos (−$1.99/+$1.43): el riesgo de cambio pesa más que el riesgo de proveedores. Banda razonable ±4 % observada en 5 días (18.58–18.81).
- **Mix de uso ALTO** duplica el costo IA ($0.52→$1.00 DEV): sigue < 4.4 % del plan 500.

## 8. Advertencias — lo NO MEDIDO (obligatorio)

1. **Imágenes**: 0 invocaciones reales en el laboratorio (guardrail `blocked_external`). Los costos por imagen son tarifas oficiales × k_retry=1.3 (HIPÓTESIS de calidad/rechazo, sin medición propia); consumo real de gpt-image-2 2K/4K y de Nano Banana/Seedream en el pipeline de MainSpot: DESCONOCIDO. Calidad visual no evaluada.
2. **Anthropic/OpenAI directos**: todo token medido pasó por OpenRouter (traducción de schema y tokenizador incluidos). Hallazgo 3 de lab-traces (Haiku consume 2–2.5× más input que Luna con el mismo prompt vía OR) puede cambiar con las integraciones directas. Sol/Terra/Sonnet: tokens NUNCA medidos (factor 1.0 sobre Luna/Haiku — ESTIMACIÓN).
3. **Conversaciones largas**: el asistente medido es 1 pregunta = 1 invocación (sin historial multi-turno, 01-inventory §7). Un asistente conversacional real multiplicaría el costo por conversación (cada turno re-paga el contexto; con caché el efecto se mitiga — no modelado).
4. **n pequeño y datos sintéticos**: 3–12 éxitos por caso de texto (calendario n=1; plan Haiku n=1), 16–41 por caso Jev; negocios ficticios en español; latencias p95 con pocas muestras. Sin intervalos de confianza.
5. **Thinking/razonamiento**: los tokens medidos incluyen el razonamiento observado vía OR; con Anthropic directo (thinking adaptativo) o Sol (`medium`, sin `none`) el output facturado puede crecer +20–100 % en diseño/complejos (HIPÓTESIS de anthropic.md §2.6 / openai.md §3.6).
6. **Escenarios de uso**: todas las frecuencias son HIPÓTESIS calibradas contra las cuotas de migrations/0009 y los topes de `engagement_policy`; ninguna frecuencia real de clientes está observada.
7. **Terceros del margen no modelados aquí**: soporte humano, churn (Recurly 3.8–3.2 % anual en estos ARPC), IVA de importación de servicios (neutro pero con flujo), CFDI/PAC — ver business-inputs.md.

## Fuentes

1. `evidence/lab-traces.md` + `evidence/lab-invocations.csv` (310 filas, sha256 `4b35bab9…`) — tokens por caso × modelo MEDIDOS (incluyen reparaciones), tasas de reparación, latencias p50/p95, hallazgo de 2–2.5× en input Haiku vs Luna.
2. `evidence/anthropic.md` §2.1/§2.3/§2.4/§7 — precios directos Haiku/Sonnet (0.10/0.50 y 2/10 ≤100K; caché read 0.01/0.10, write 0.125/2.50, mín. 512; Batch −50 %) y perfiles §7 (ediciones 5,000/600 y 7,000/3,500).
3. `evidence/openai.md` §3.2/§3.4/§3.7/§1.4/§7 — Luna 0.10/0.50 (cached 0.01, mín. 1,024, write 1.25×), Terra 1/5 (read 0.05), Sol 2/10 (read 0.10); Batch/Flex −50 %; gpt-image-2 $5/$8/$30 por MTok y por imagen 1024² 0.006/0.053/0.211, 1536×1024 medium 0.041, Batch −50 %, caché de imagen solo vía Responses.
4. `evidence/typesafe-jev.md` §3.1/§5 — Jev 0.042/MTok in, salida gratis, fallos no facturan; tokens medidos 804/1,158.
5. `evidence/image-providers.md` §2.1/§4.1/§10 — Nano Banana 2.1 $0.0336/img 1K (Batch −50 %), Seedream 5.0 flash $0.018; factor de reintento 1.3 y análisis de costo entregado.
6. `evidence/business-inputs.md` §1/§2/§3/§4 — FIX 18.7962 (30-oct-2026), IVA 16 % y netos, Openpay 2.9 %+$2.50+IVA, infra USD 0.07–0.19/cliente/mes, soporte/churn.
7. `01-inventory.md` §3/§5/§7 y `migrations/0009_subscriptions_plans.sql` — mecánica del dispatcher (reparación ≤1, imágenes n=1, sin fallback), cuotas del plan piloto (website 1, social_posts 10, social_ads 5, reviews_managed 20, agents 5, conversations 500).
8. `src/engagement/service.ts:153,187-190` — `max_auto_replies_per_hour` por defecto 10, rango 1–60.
9. `evidence/lab-history.md` §3/§5 — costos por éxito vía OpenRouter (referencia histórica) y límites estadísticos.

## Huecos

| Hueco | Cómo cerrarlo |
|---|---|
| Costo/latencia/calidad real de imágenes en el pipeline (gpt-image-2, Nano Banana, Seedream) | Benchmark B-IMG del entregable 03 con autorización de gasto (DEC-0068) — el único factor económico dominante del modelo |
| Tokens por tarea con integraciones directas (Sol/Terra/Sonnet; Anthropic sin traducción de OpenRouter) | Benchmark B-TXT contra los adaptadores directos; mientras tanto factor 1.0 sobre tokens Luna/Haiku medidos |
| Tasa de reparación de Sol/Terra/Sonnet y del esquema aplanado de ediciones en Anthropic | Correr las suites del catálogo con esos modelos; registrar `validation.first_errors` |
| Efecto de caché real | Habilitar `cache_control` en el dispatcher y medir `usage` antes/después (hoy el dispatcher no lo envía) |
| Frecuencias reales de uso por cliente | Cohortes del piloto; sustituir las HIPÓTESIS de §3 por datos observados |
| Discrepancia PSP en business-inputs (tabla cita MXN 34.44 para plan 1,000; la fórmula documentada da 36.54) | Confirmar con la calculadora oficial de Openpay; este modelo usa la fórmula §3.1 |
| Costo por imagen 2K/4K de gpt-image-2 y consumo de gpt-image-2.5-* | Calculadora interactiva en navegador o una medición real leyendo `usage.output_tokens` |
| Sensibilidad thinking/effort por perfil (Anthropic directo; Sol `medium`) | Medir `usage.output_tokens` real con effort medium vs none/low |
