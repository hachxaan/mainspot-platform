# MainSpot AI Core — investigación de proveedores, modelos y economía unitaria

**Estado: COMPLETA (verificado el 2026-11-03).** Naturaleza: investigación y propuesta. No cambia rutas, presupuesto ni decisiones vigentes; las recomendaciones del 05 requieren decisión explícita del propietario.

## Ejecutivo

| Pregunta | Respuesta corta | Detalle |
|---|---|---|
| ¿Cuánto cuesta la IA por cliente/mes? | **USD 0.32–0.58 en uso MEDIO** según mix (OPT/DEV/CANON); abuso ≤ USD 2.14 | `04-unit-economics.md` (192 filas reproducibles, 3 mixes × 4 escenarios) |
| ¿Amenaza el margen? | No: el costo IA es **1.3–2.6 % del plan MXN 500** incluso en abuso; margen bruto 87–94 % con Openpay + infra R2/Neon | `04-unit-economics.md` §6 |
| ¿Qué domina el costo? | **Las imágenes** (×2 volumen = +82–83 % del costo IA); el texto es marginal | `04-unit-economics.md` §7, `05-recommendation.md` §3 |
| ¿Qué modelo por caso? | Jev para clasificar (DEC-0066); **Luna** como caballo de batalla de texto (pasó todo en lab, incl. el esquema de 17 uniones); Sol/Haiku donde hay razonamiento; `gpt-image-2` medium para imágenes con Nano Banana 2.1/Seedream como candidatos de evaluación | `05-recommendation.md` §2 (tabla de 18 filas con confianza y condición de cambio) |
| ¿OpenRouter? | Sin discrepancia de precio de lista vs directo en 10 modelos y comisión 5.5–8 %, pero **excluido de ejecuciones** por DEC-0069; su rol fue histórico (lab) y el motor de esta investigación no toca el producto | `evidence/openrouter.md` §6, `05-recommendation.md` §6 |
| Hallazgo crítico | La integración directa **no tiene ni una generación exitosa medida**: Anth directo 0/31 (`bad_request`), OpenAI directo 0/53 (`insufficient_credit`) — toda elección «directa» es hoy NO MEDIDA | `03-quality-benchmarks.md` §2, `05-recommendation.md` §1 |
| Decisión abierta D12 | DEC-0069 (Anthropic prioritario en producción) vs DEC-0073 (OpenAI en desarrollo, Anthropic deshabilitado en 0029): tarifas por token idénticas (Luna=Haiku, Sol=Sonnet); resolverla requiere la fase 1 del benchmark (≈ USD 4.5 de un techo de 25, gastado 0.0967) | `01-inventory.md` §8, `02-provider-comparison.md` §5 |

## Snapshot de partida

| Referencia | SHA | Nota |
|---|---|---|
| Commit de partida del handoff | `73271a29d777cd010e8833b92e25360fddecc4f0` | Estado del AI Core analizado |
| Rama de investigación (HEAD inicial) | `d440e2a1b2bf90325669277e6eb1e498c31ca8e0` | 73271a2 + `HANDOFF.md` |
| SOL MAIN `feat/canonflow-implementation` (externo, solo lectura) | `d297e8a` → `36af79c` → `1f1c7da` durante la investigación | QS-0017 (DEC-0066…0072) y luego integración directa + **DEC-0073** + migración 0029; reconciliado por referencias SHA en `01-inventory.md` §8 |

Aislamiento: worktree `../mainspot-ai-research`, rama `research/ai-provider-economics-2026-11`. Escrituras solo bajo `research/ai-provider-economics/`. Sin llamadas pagadas a proveedores, sin servidores, sin secretos; la única consulta a la base del laboratorio fue de solo lectura (`ai_invocation`, columnas numéricas).

## Entregables

| Archivo | Estado | Verificación |
|---|---|---|
| `01-inventory.md` | **RESULTADO VERIFICADO** | ~35 referencias archivo:línea re-comprobadas; snapshot SOL MAIN actualizado a `1f1c7da` con hashes sha256 |
| `02-provider-comparison.md` | **RESULTADO VERIFICADO** | Síntesis cruzada de 9 archivos de evidencia auditados; cero discrepancias de precio de lista OR vs directo |
| `03-quality-benchmarks.md` | **RESULTADO VERIFICADO** (diseño de benchmark = PROPUESTA NO MEDIDA) | Métricas reproducidas desde `lab-invocations.csv`; corrección del mito «DeepSeek 0/5» (`circuit_open`) |
| `04-unit-economics.md` + `.csv` + `.py` | **RESULTADO VERIFICADO** | Script stdlib ejecutado 2× con el mismo sha256 del CSV (`314e7561…`), re-ejecutado por el integrador (rc=0, 192 filas) |
| `05-recommendation.md` | **RESULTADO VERIFICADO** como propuesta | 7 decisiones de propietario numeradas (D-REC-1…7); nada presentado como aprobado |
| `sources.md` | **ÍNDICE COMPLETO** | 228 URLs primarias deduplicadas por proveedor → archivos que las usan |
| `evidence/` (11 archivos) | Notas auditadas | Cada afirmación crítica con etiqueta HECHO VERIFICADO / SNIPPET / MEDICIÓN PROPIA / ESTIMACIÓN / HIPÓTESIS / DESCONOCIDO + URL + fecha |

## Evidencia en dos capas

1. **Medición propia (histórica, 2026-10-30, vía OpenRouter/TypeSafe)**: 310 invocaciones con tokens, reparaciones, costo y latencia reales por caso de uso (`evidence/lab-traces.md`, `lab-history.md`). Advertencias: n pequeño, datos sintéticos, contabilidad que omite fallos con costo.
2. **Precios y términos oficiales verificados el 2026-11-03** (Anthropic, OpenAI, TypeSafe, Google/BFL/BytePlus/Ideogram/Recraft, OpenRouter, Banxico/PSP/infra): cada dato con URL y etiqueta en `evidence/*.md` y `sources.md`.

## Cómo se ejecutó (transparencia de método)

Orquestador + subagentes corrieron en `openrouter/z-ai/glm-5.3-flash` (override nativo de OMP `task.agentModelOverrides`, sesión). La primera ola de recolección usó otro modelo y murió por cuota (429) **después** de escribir sus borradores; cada borrador fue auditado por un agente independiente (verificación contra fuentes oficiales y contra los tokens medidos) antes de integrarse — el trabajo válido se conservó y lo incompleto se re-ejecutó. Commits incrementales en la rama de investigación; ningún merge con ramas de implementación.

## Huecos principales (verificación pendiente, con vía de cierre)

- Tokens/costos de **proveedores directos** (Anthropic/OpenAI): requiere saldo OpenAI y diagnóstico del `bad_request` Anthropic → D-REC-1/3.
- **Imágenes**: 0 invocaciones reales; factor de reintento k=1.3 y cuotas por plan son HIPÓTESIS → D-REC-1 (B-IMG) / D-REC-4.
- Caché de prompts no enviado por el dispatcher hoy; frecuencia real de uso: solo con cohortes del piloto.
- Fechas límite de vigencia de precios: Argon ×2 y apagado `gpt-image-1.5` el **2026-12-01**; retiro `claude-sonnet-4-5` el **2026-11-30**.
