---
source_id: SRC-007
recorded_at: 2026-11-06
source_type: owner_conversation_followup
status: CONTEXTUAL_OWNER_APPROVAL
original_audio_verified: false
canonical_decision_published: false
---
# SRC-007 — Aprobación de política IA de Facebook, presupuestos y TypeSafe

## Procedencia
Registro literal de dos mensajes del propietario. No incluye audio original ni evidencia de proveedor.

> Ok para 2, 3, 4. Pero tengo una duda para la 1. El usuario podrá configurar la activación de generación de recomenración por AI autómatico? Para que no tenga que solicitar la generación? Esto con la advertencia clara del consumo de créditos. Pero si es un usurio que siempre solicitará la recomendación, le estaríamos dando la oportunidad de optimizar su flujo. En este caso, tanto a él le convieno por ahorrarse un paso, como a MainSpot para mayor uso. Así quedará o esto es una propuesta mia? ¿qué opinas?

Tras la propuesta explícita del asistente de tres modalidades para FB-1 (desactivada, bajo demanda y automática opt-in con aprobación humana; bajo demanda como predeterminada), y su pregunta de si se cerraban las cuatro, el propietario respondió literalmente:

> Adelante.

## Interpretación contextual aprobada (no es cita literal)

**FB-1.** Tres modos configurables por negocio: off = no generar sugerencias; on_demand (predeterminado) = solo por petición; auto_suggest_opt_in = generar propuestas para comentarios elegibles sin pulsar «Generar», **con aprobación humana** y advertencia explícita de créditos consumidos incluso si no se publica. La generación automática NO implica autorización para publicación automática; esta última requiere regla y consentimiento independientes. Mantener posibilidad de desactivar y un límite efectivo de consumo. Filtrar duplicados y casos donde no se justifique generación.

**FB-2.** En flujos orientados a publicación automática, verificar antes de invocar IA que exista elegibilidad y espacio bajo el límite horario. Si no se puede publicar, no generar por ese motivo. Excepción: con auto_suggest_opt_in la sugerencia para revisión humana puede generarse dentro de sus controles de crédito/costo aunque el límite de publicación automática esté agotado; no publicarla sin autorización. Solicitudes manuales también siguen permitidas dentro de los límites.

**FB-3.** Techo técnico global obligatorio; presupuesto técnico por negocio y atribución/controles por canal o función. Presupuesto del laboratorio separado del comercial operativo, sin eludir el techo global. Evitar cuotas rígidas arbitrarias que desperdicien capacidad: calibrar particiones por canal a partir de datos. Sin filas de presupuesto, fail-closed.

**TS-1.** TypeSafe/Jev debe reservar capacidad atómicamente antes de llamar, con idempotencia, confirmación o liberación, reconciliación de reservas abandonadas y pruebas concurrentes.

## Límites y asuntos abiertos
- Actualmente Facebook NO consume la cuota específica de Google (quota.ai_review_replies.max). **Ninguna cuota de créditos de Facebook, cantidad por plan, precio ni unidad de cobro ha sido fijada.** Antes de habilitar consumo comercial de sugerencias, definir semántica propia y controles transparentes; no heredar silenciosamente el parámetro de Google.
- No se aprobaron montos de presupuestos, umbrales, proveedor real, pagos, fusiones, migraciones ni despliegues.
- No modificar decisiones de retención, trial o voz por Telegram por esta resolución.
- La confirmación es conversacional y debe promoverse por un nuevo registro DEC, con gates, antes de declararse canon publicado.
