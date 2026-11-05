---
source_id: SRC-005
title: "MainSpot — decisiones comerciales y evolución del producto, sesión de voz"
source_date: 2026-11-05
source_type: user_supplied_srt_conversation
epistemic_role: evidence_of_reported_human_decisions
status: NORMALIZED_EXTRACT
original_media_attached_to_repo: false
raw_audio_verified: false
---
# SRC-005 — Registro normalizado de decisiones de la conversación

## Procedencia y límites
Fuente: transcripciones SRT suministradas por el propietario a ChatGPT, correspondientes a la conversación del 5 de noviembre de 2026. Este archivo **no** es la transcripción íntegra, no acredita una grabación original ni contiene hash verificable de audio; reconstruye las manifestaciones explícitas y sus condiciones a partir del texto proporcionado. No inventar actas, firmas, IDs de aprobación ni precios. Antes de promoción canónica, reconciliar con la fuente original y con el canon operativo más reciente.

**Regla de epistemología:** DECIDED = el propietario dijo expresamente que aprobaba la propuesta; AGREED_CONCEPTUAL = expresó acuerdo pero detalles abiertos; PROPOSED = recomendación no aprobada; DEFERRED = decidida su postergación; OPEN = pendiente. Decisiones comerciales no equivalen a implementación ya probada.

## Decisiones aprobadas expresamente — ACTUAL / política del servicio
| ID provisional de fuente | Estado | Contenido y límites |
|---|---|---|
| C01 | DECIDED | Recepción/sincronización de reseñas no gasta cuota de respuestas con IA; respuesta manual tampoco. Cada respuesta generada con IA gasta una unidad de cuota mensual. El agotamiento de IA no detiene la recepción ni la respuesta manual, incluido el canal Telegram cuando esté conectado. |
| C02 | DECIDED | Las cuotas del mismo plan no dependen del giro comercial del negocio. |
| C03 | DECIDED | El número de planes a comercializar en el lanzamiento NO se fija anticipadamente: la investigación y la capacidad técnica decidirán entre A, A+B o una oferta con complementos, si estos últimos son implementables. Los planes comerciales no tienen nombres definitivos, precios ni cantidades aprobadas. |
| C04 | DECIDED | Las cuotas incluidas en un plan se renuevan mensualmente y no se acumulan. La vigencia depende de suscripción efectivamente activa/pagada. |
| C05 | DECIDED | Sin excedentes ni cargos automáticos por defecto. Al agotar cuotas de IA se bloquea esa operación, pero no otras funciones contratadas; avisar anticipadamente y ofrecer opciones comerciales realmente disponibles. Los umbrales 80 %/100 % fueron ejemplo, no decisión numérica aprobada. |
| C06 | DECIDED | Ciclo mensual individual anclado a la activación efectiva de la suscripción, no al primer día del mes calendario. Renovar cuotas al renovarse un periodo vigente. |
| C07 | DECIDED | Subir de plan: efecto inmediato tras confirmar el cobro; bajar: al siguiente ciclo. Mantener consumo del periodo. No entregar automáticamente la cuota completa del plan destino como si no hubiera consumo previo. |
| C08 | DECIDED | Aumento de plan a mitad de ciclo: proporcionalidad tanto del precio adicional como de la **capacidad incremental** por tiempo restante; sin regalar capacidad completa al cobrar solo fracción. Fórmula exacta, redondeo, límites y reembolsos siguen abiertos. |
| C09 | DECIDED | Fallo de pago: siete días naturales de recuperación. Durante ellos página publicada, panel y reseñas/manual disponibles; IA de costo variable suspendida y sin nuevas cuotas hasta regularizar. Aviso y mecanismo de actualización de pago; reintento automático solo con autorización. Tras siete días sin regularización, suscripción suspendida. |
| C10 | DECIDED | Tras suspensión por impago: página deja de publicarse después de la gracia; contenido y configuración se conservan durante 60 días para posible restauración. Avisos de suspensión/expiración por plataforma, correo y Telegram (según canal vinculado y disponible). No apropiarse de dominios ni alterar servicios ajenos. |
| C11 | DECIDED | Cancelación voluntaria sin penalizaciones ni fricciones: efectiva al terminar periodo pagado, sin cargo en renovaciones posteriores, prestación hasta finalizar ese periodo. Excepciones de devoluciones conforme reglas/ley aplicables. |
| C12 | DECIDED | Tras cancelación voluntaria: 60 días de retención de configuración y contenido, reactivación posible, notificaciones por correo/Telegram, exportación **e importación** de contenido, y posibilidad de eliminación anticipada cuando proceda legalmente. Formatos, alcance y ejecución física de import/export aún por definir. |
| C13 | DECIDED | Reactivación sin penalización, recupera información aún disponible. Nuevo periodo mensual al pago de reactivación cuando no hay periodo activo; respetar cualquier periodo ya pagado para evitar cobro duplicado. No permitir uso de reactivaciones para reiniciar indebidamente cuotas. |
| C14 | DECIDED | Experiencia gratuita limitada de demostración/trial, sin tarjeta bancaria ni cargos automáticos, con IA limitada y sin publicación real ni servicios recurrentes activados antes de contratar. Duración, volumen y mecanismos antiabuso no están fijados. |

## Principios de propuesta de valor — FUTURO
| ID | Estado | Alcance |
|---|---|---|
| F01 | AGREED_CONCEPTUAL / DEFERRED | Plan base con complementos de capacidad adquiribles durante onboarding o después, de tipo puntual por ciclo y recurrente mensual; el recurrente puede ofrecer mejor precio unitario **si margen lo permite**. La comparación deberá recomendar plan superior si resulta económicamente más conveniente, sin forzar artificialmente precios. |
| F02 | DEFERRED | Recomendaciones de capacidad basadas en consumo/historial, primero mediante estadísticas y reglas explicables; IA de recomendación solo si aporta valor verificable. |
| F03 | DEFERRED | Vista previa de publicación Facebook en Telegram con imagen + texto/emojis en el mismo mensaje (enlace opcional), preservando flujos de aprobación, cambios y rechazo. |
| F04 | DEFERRED | Vista previa de cambio web en Telegram mediante captura de una **versión real previsualizada** de la web; no imagen imaginada por IA; permitir aprobación/solicitud de ajustes. |
| F05 | DECIDED — FUTURO MANDATORIO, siguiente ronda de producto | Instrucciones de voz mediante mensajes de audio Telegram. Mismo agente/políticas que texto; transcripción, interpretación contextual, aclaración antes de actuar ante error/ambigüedad, confirmación de actos sensibles, trazabilidad y privacidad. El propietario solicitó implementarlo en la siguiente ronda, pero sin ampliar el cierre técnico actual. |
| F06 | DECIDED — FUTURO CONDICIONAL | Recargas automáticas **prepagadas**, opt-in explícito, con límite de gasto y cantidad/frecuencia de recargas. Nunca consumo ilimitado automático por defecto. |
| F07 | PROPOSED | Chatbot en página como eventual diferenciador de plan C; expansión WhatsApp; otras capacidades. No aprobada exclusividad ni disponibilidad por plan. |
| F08 | AGREED_CONCEPTUAL | Diferenciación de planes por valor y costo unitario sostenible; evitar funcionalidades artificiales para justificar número de planes. Telegram como posible capacidad transversal esencial, no reservarlo automáticamente para un plan alto. |

## Forma de trabajo aprobada
- Distinguir **ACTUAL** (trabajo de cierre y comportamiento aprobado) de **FUTURO** (evolución).
- Cerrar cada propuesta como aprobada, modificada y confirmada, rechazada con motivo o pospuesta con condición de reanudación; el silencio no aprueba.
- Exigir criterio crítico: detectar contradicciones, riesgos económicos y falsa evidencia.
- No reiterar a cada paso que precios e investigación están pendientes; consignarlo aquí.
- No reabrir funciones ya probadas sólo para preparar opciones futuras, salvo incompatibilidad concreta.
- Al final de la conversación, propietario aprobó **terminar la apertura de reglas comerciales** y dar paso a consolidar documentación, contrastar PR #13/#14 y reanudar trabajo local.

## Fronteras no resueltas que requieren reconciliación
- Las capacidades actuales del catálogo en el PR #13 son `website`, `social_posts`, `social_ads`, `reviews_managed`, `conversations`, `agents`; las seis figuran como acumuladas. La nueva regla de **respuesta de IA por reseña** NO autoriza a renombrar silenciosamente `reviews_managed` o a reinterpretar migraciones existentes.
- El mecanismo mensual existe en el PR #13, pero se describe como desactivado; activación y semántica precisas requieren revisión de contrato y pruebas de regresión.
- El repositorio documental `hachxaan/mainspot-documentation` presenta canon inicial `0.0.0`, mientras que el repositorio de implementación maneja la línea `.canonflow` y DEC-0075: **reconciliar autoridad y versión**, sin suponer que un registro de una rama cambia automáticamente al otro.
- No se han aprobado cantidades A/B/C, precios, tarifas, cálculo preciso de prorrateo, límites trial, retención legal detallada, formato de importación/exportación ni capacidades por canal. No configurar arbitrariamente.
- PR #13 y #14 están en borrador/apilados y con cierres de despliegue pendientes; esta fuente no certifica la producción.
