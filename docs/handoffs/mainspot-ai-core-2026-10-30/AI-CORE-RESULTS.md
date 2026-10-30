# MainSpot AI Core — resultados E2E (issue #9, 2026-10-30)

Rama `feat/canonflow-implementation`. Operación y arquitectura: `docs/architecture/ai-core.md`.
Evidencia: `evidence/ai-core/` (`lab-e2e.txt`, `evals-lab-run*.json`, `screens/`).

## Veredicto

| Ámbito | Veredicto |
|---|---|
| AI Core local (despacho versionado, consolas, rollout/canary/rollback sin código, jobs durables, presupuestos, Brand Studio, biblioteca, web generativa, Facebook generado, atención con Jev, asistente, campañas sin gasto, calendario, resumen) | **GO local** — piloto con negocios sintéticos y proveedores reales |
| Imágenes generadas por IA | **BLOCKED_EXTERNAL** — guardrail de la cuenta OpenRouter |
| Datos reales de clientes hacia proveedores de IA | **NO-GO** hasta QS-0016 (DEC-0019 vigente) |
| Publicación real en Meta/Google, Telegram real, gasto publicitario | **BLOCKED_EXTERNAL / NO-GO por diseño** (ver DEV-E2E-04) |
| Producción | **NO-GO** — fuera de alcance (laboratorio local) |

## Matriz E01–E20

Fuente de cada resultado: **E2E real** = `scripts/ai-core-lab-e2e.ts` (Chrome por HTTPS con CA local verificada,
OpenRouter + TypeSafe reales, negocio sintético); **INT** = `tests/integration/ai-core.test.ts` (PostgreSQL real,
simulador o proveedor falso inyectado); **EVAL** = suites reales de la Engineering Console.

| # | Criterio | Resultado | Evidencia |
|---|---|---|---|
| E01 | Brand Studio y mismo asistente en el panel | PASS | E2E real: alta → «Mi marca» (datos del alta + 6 campos, versión) → el asistente usa `brand_facts` |
| E02 | Jev primario: intención y sentimiento con ironía/negación/mixto | PASS (sintético) | EVAL Jev 1.14.0: sentimiento 89 % (≥ 85 %), 0 riesgos omitidos; E2E: Jev decide el alcance de la edición y lee la ironía como negativa. Datos reales: pendiente QS-0016 |
| E03 | Roles separados dueño / platform_admin / ai_engineer | PASS | INT: 401/403 cruzados, tokens no intercambiables, MFA + anti-replay, step-up; E2E: logins separados en `/plataforma` y `/ingenieria` |
| E04 | Versionar prompt, comparar modelos, canary, rollback | PASS | INT: prompt v+1 inmutable, ruta → evaluación → aprobación → canary → promote → rollback; E2E: canary 20 % y retiro desde el navegador; EVAL: Haiku vs Luna vs Sonnet por caso de uso |
| E05 | Página inicial IA con diseño diferencial | PASS (imágenes IA: BLOCKED_EXTERNAL) | E2E: Claude Haiku 5.5 real, sitio 360/768/1440 sin desbordes, 1 h1, ALT, 0 scripts; EVAL: 3 negocios con 3 firmas de diseño (`screens/eval-diseno-*.png`) |
| E06 | Cambio simple vs complejo por rutas distintas, sin extras | PASS | E2E: Jev → `layout_complex` → GPT-6 Luna, 2 operaciones (color + FAQ), v2 publicada; INT: ruta fijada aunque cambie el rollout |
| E07 | Preview, aprobación, versiones, restaurar v1→v3, HTTPS | PASS | E2E: v1 diseño → v2 edición → «Restaurar» v1 como v3 (restored_from_version=1, HTML idéntico salvo versión), servido por HTTPS con TLS verificado |
| E08 | Facebook texto/emojis/imagen aprobado y programado | PASS local; Meta real BLOCKED_EXTERNAL; imagen IA BLOCKED_EXTERNAL | E2E: 3 variantes Haiku (≤ 1 emoji, CTA, hashtags), borrador → aprobado, trazado a la generación |
| E09 | Comentario simple auto-consentido, queja a humano | PASS (eventos simulados de Facebook, Jev real) | E2E: «gracias» → Jev positivo → respuesta automática; ironía → Jev negativo → humano con borrador |
| E10 | Reseña Google baja → aviso + propuesta, sin review gating | PASS local (INT/E2E previos de reputación + Jev para reseñas en EVAL); Google real BLOCKED_EXTERNAL | EVAL `engagement.google.review.*`; ledger único reputación/atención (INT FR-0016) |
| E11 | Asistente con estado real, sin inventar ni cruzar negocios | PASS | E2E: respuesta con cifras de `attention_cases`; INT: herramientas solo del negocio de la sesión, `read_only` sin generación, cifras sin fuente → reparación |
| E12 | Campaña: brief y borradores, sin gasto sin confirmación | PASS | E2E: plan (Luna) + creatividades (Haiku), aprobado «sin gasto»; INT: constraint `spend_authorized=false` |
| E13 | Imagen con ALT/licencia/asset, disponible web/social | PASS (foto propia); generada: BLOCKED_EXTERNAL | E2E: JPEG con EXIF/GPS → WebP 1280×960 sin EXIF, ALT y derechos, usado en la página; INT: imágenes acotadas al negocio |
| E14 | Reentrega, reinicio de worker, timeout, resultado incierto | PASS (INT) | INT: caída a mitad de job → reintento con lease, paso pagado reutilizado (1 invocación); invocación huérfana → `uncertain_abandoned` con la reserva contada. Sin caos con reinicio real del servicio (lease de 10 min) |
| E15 | Cuotas/costo/latencia con procedencia y techo duro | PASS | INT: reservas concurrentes contra el techo; E2E: costo y latencia por caso de uso leídos de `ai_invocation` (tabla abajo) |
| E16 | Inyección, fuga de secretos, SSRF, XSS, PII, RBAC | PASS (local) | Unit: render sin HTML/JS del modelo, datos no confiables delimitados; EVAL: casos de inyección en atención pasan; imágenes solo `b64_json` (sin descargar URLs); INT: aislamiento por negocio (404), sin secretos en listados de plataforma |
| E17 | Plataforma ve salud/consumo sin suplantar | PASS | E2E: Administration muestra consumo por caso de uso sin texto de clientes; INT: soporte solo con acceso temporal con motivo, visible para el negocio |
| E18 | Prompt/modelo estables durante un job aunque cambie el routing | PASS | INT: rollout cambiado a mitad → el job usa la ruta fijada |
| E19 | Calidad: publicaciones, respuestas y diseños distintivos | PASS con rúbrica (abajo) | Revisión visual de `screens/` y textos en `lab-e2e.txt` |
| E20 | UX móvil del dueño: alta → web → post → atención | PASS | E2E: todo el recorrido en 390 px; capturas `own-*.png`; sin errores de JavaScript |

## Costo y latencia del último recorrido real (procedencia: respuesta del proveedor)

| Caso de uso | Modelo | Llamadas | USD | p95 ms |
|---|---|---|---|---|
| website.initial.design | Claude Haiku 5.5 | 1 | 0.002224 | 16474 |
| website.edit.complex | GPT-6 Luna | 1 | 0.000542 | 8588 |
| social.facebook.post.compose | Claude Haiku 5.5 | 1 | 0.001111 | 10122 |
| engagement.facebook.comment.classify | Jev 1.14.0 | 2 | 0.000098 | 356 |
| engagement.facebook.comment.reply | Claude Haiku 5.5 | 2 | 0.000533 | 2816 |
| conversation.intent.classify | Jev 1.14.0 | 1 | 0.000034 | 308 |
| conversation.owner.assistant | Claude Haiku 5.5 | 2 | 0.001257 | 11954 |
| marketing.campaign.plan | GPT-6 Luna | 1 | 0.000684 | 8467 |
| marketing.campaign.creatives | Claude Haiku 5.5 | 1 | 0.002106 | 19199 |
| editorial.calendar.suggest | GPT-6 Luna | 1 | 0.000497 | 7135 |

Recorrido completo: USD 0.008954 en OpenRouter. Acumulado del laboratorio (todas las evaluaciones y recorridos
E2E de esta sesión): USD 0.096726 de USD 25 autorizados.

## Rúbrica de calidad (E19)

| Artefacto | Criterio | Observado |
|---|---|---|
| Diseño | Distinto por negocio (paleta, tipografía, estructura), legible, AA, sin huecos | Café (cálido, marrón, slab), taller (moderno, azul marino, rejilla 2×2, bandas de confianza), estética (elegante, ciruela, didone). Corregido durante la revisión: galería vacía, hero sin imagen a media columna, FAQ en dos columnas, 4 servicios con huérfano, «Contacto» fuera del menú |
| Publicación | Humana, ≤ 3 emojis, CTA, solo hechos/promos confirmadas | 3 variantes con horario/dirección/precios confirmados, 0–1 emoji, hashtags locales |
| Respuesta | Agradece o deriva; nunca inventa | Agradecimiento respondido; ironía derivada a humano con borrador |
| Asistente | Cifras con fuente | «1 comentario… 1 publicación», fuente `attention_cases`; acción sugerida enlazada |
| Edición | Solo lo pedido | Color principal + FAQ con horario/ubicación/productos; un pedido con datos inexistentes (pagos, estacionamiento) se devolvió como `needs_clarification` en lugar de inventarlos |

## Bloqueos y cómo se desbloquean

1. **Imágenes IA** — permitir en https://openrouter.ai/workspaces/default/guardrails un modelo de imagen con
   endpoint ZDR (`google/gemini-3.1-flash-lite-image`, `microsoft/mai-image-2.6-flash` o
   `bytedance-seed/seedream-5-0-flash`); después, en `/ingenieria`: evaluar → aprobar → activar.
2. **Claude Sonnet 5.5** — mismo guardrail (opcional: Haiku pasa donde se usa).
3. **QS-0016** (HDC, PENDING) — Jev primario con datos reales y política de datos reales hacia proveedores.
   Mientras tanto los negocios `real` reciben BLOCKED_EXTERNAL y la atención usa reglas deterministas.
4. **Meta/Google/Telegram reales y anuncios** — credenciales y autorizaciones de titulares (DEV-E2E-04).

## Pendiente de decisión (no implementado a propósito)

- DEC-0021 (purga de contenido conversacional a 90 días) cubre `conversation_request`; las instrucciones del
  dueño guardadas en `ai_job.input` (p. ej. el texto de una edición) no entran en esa purga y se borran con la
  baja. Si deben tratarse como contenido conversacional, es una decisión de canon.

## Datos del laboratorio que quedan

Negocios ficticios «Café Brisa Lab …» clasificados `synthetic` (uno, «c3780c», quedó suspendido por un error de
la consola ya corregido). Son datos de laboratorio sin clientes reales.
