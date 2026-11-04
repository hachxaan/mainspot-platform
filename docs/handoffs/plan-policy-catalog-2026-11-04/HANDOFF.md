# HANDOFF — Catálogo de planes y políticas por plan para MainSpot
Fecha: 2026-11-04
Estado: propuesta de implementación; no es una decisión canónica aprobada por sí sola.
Repositorio: hachxaan/mainspot-platform
Rama de origen: feat/canonflow-implementation
Rama de este handoff: docs/handoff-plan-policy-catalog-20261104
Punto de partida (SHA verificado al crear la rama): 95f9436084fccd4c3ae83b0dbde62bcdbaa1274b
Prompt de ejecución: ./BOOTSTRAP-PROMPT.md

## 1. Mandato del propietario

Evolucionar la configuración de MainSpot para que cada plan existente y futuro tenga sus parámetros comerciales y funcionales explícitos, versionados y mantenidos en PostgreSQL. Añadir el mantenimiento de planes a la Engineering Console (/ingenieria), reutilizando la infraestructura actual y sin alterar los controles de seguridad, calidad epistemológica, contratos externos o gobierno del producto.

Cada plan nuevo debe nacer como borrador con valores sugeridos. Antes de habilitarlo, el administrador de planes debe revisar y confirmar explícitamente todos los valores aplicables. El mantenimiento posterior debe poder crear nuevas revisiones, comparar diferencias, mostrar impacto, publicar y revertir. La interfaz final debe ser real, accesible, responsive, intuitiva y conectada al backend; no una maqueta.

Prioridades de diseño: exactitud, integridad transaccional, mínima duplicación, backward compatibility, trazabilidad, facilidad de operación y evolución comercial sin redeploy por cada cambio de cuotas.

## 2. Evidencia inicial: estado que se debe confirmar contra la rama de trabajo

Comprobado por lectura de la rama de origen:
- migrations/0009_subscriptions_plans.sql define plan, plan_limit y subscription; existen seeds plan_piloto_1, plan_basico y plan_completo, sin precios aprobados.
- src/subscriptions/entitlements.ts define KNOWN_CAPABILITIES = website, social_posts, social_ads, reviews_managed, agents, conversations. En esta implementación agents cuenta internal_user, por lo que NO equivale a agentes de IA.
- src/subscriptions/quota.ts tiene QuotaLedger con lock por tenant+capacidad, reserva, consumo atómico, idempotencia y reconciliación. Reutilizar; no debilitar.
- El conteo de uso para las seis capacidades se basa en filas de dominio. Esto NO equivale a cuota periódica. La consola de plataforma muestra algunos consumos mensuales desde quota_reservation: ambas semánticas requieren conciliación explícita.
- src/api/subscription-routes.ts ofrece lectura de catálogo/entitlements y asignación en el contexto del negocio; src/api/platform-routes.ts asigna planes a negocios por platform_admin. No se identificó CRUD de catálogo desde Engineering.
- src/web/platform/assets/console.js tiene Engineering Console (casos, laboratorio, modelos, trazas, costos, jobs), sin sección de configuración de planes. /plataforma y /ingenieria comparten shell con sesiones de plataforma separadas de las del negocio.
- src/platform/auth.ts contempla platform_admin, ai_engineer y platform_support; el acceso a planes debe hacerse explícito y mínimo por acción.
- FR-0010 (.canonflow/canon/functional/items/FR-0010.md) fija catálogo en BD, deny 403 limit_exceeded, deny subscription_required, auditoría y ausencia de cobro sin precio. FR-0019 regula Engineering Console, revisiones y controles. No contradecir estas decisiones ni presentar este documento como canon aprobado.

La presente lista es una SEMILLA DE HALLAZGOS, NO una auditoría exhaustiva ni una prueba del entorno desplegado. El agente deberá verificar cada punto y ampliar el inventario, sin copiar cifras por inercia.

## 3. Inventario semilla a auditar y clasificar

A. Web y medios:
- media/service.ts: MAX_ASSETS_PER_TENANT=300; MAX_INPUT_BYTES=8 MiB; limitInputPixels=40 millones; alt 160; variantes y calidad WebP; listing pagination hasta 300.
- website/design.ts: 3..10 bloques; máximo 4 imágenes; máximo 8 items/bloque; contratos de longitud; SEO; invariantes hero/contacto.
- website/design-edit.ts: máximo 10 bloques al agregar; 8 items; heading 120, subheading 200, body 700, CTA 40; facts (hours/address 200, email 120, line 160, about 600).
- website/site-proposals.ts: hasta 12 servicios de 80 caracteres; email 200; otras restricciones sobre cambios y propuestas.
- website/ai-site.ts: idea hasta 1500; cambio hasta 1000; selección de imágenes de biblioteca hasta 50.
- brand/service.ts: services 20; locations 10; channels 8; prices 30; promotions 10; palette 6; fonts 3; campos de texto y longitudes.
- Inconsistencias conocidas: título/subtítulo generación 90/180 vs edición 120/200; email edición 120 vs propuesta 200; servicios web 12 vs perfil de marca 20. Determinar si son distintos conceptos o drift antes de unificar.

B. Contratos AI, marketing y atención:
- ai/contracts.ts: operaciones de edición <=12; social 2..3 variantes, texto 20..700, 4 hashtags, 3 emojis; respuestas 5..600; campaña 1..2 canales, duración 1..60 días, 1..3 creatividades, 1..4 KPIs, presupuesto propuesto hasta 100000 MXN; calendario 1..8 ideas; insights 5 highlights, 3 recomendaciones y mínimo 7 días de actividad; assistant 1400 caracteres y hasta 6 evidencias.
- ai/catalog.ts y ai/prompt.ts: instrucciones del generador, longitudes de variables, prompts, contexto, versión y restricciones de modelos.
- ai/registry.ts: parámetros por ruta (max_tokens 64..32000, timeout_ms 2000..300000, temperature, repair_attempts, quality y otros), costo máximo; NO convertir estos techos técnicos en edición comercial.
- ai/governance.ts, ai/dispatcher.ts, ai/jobs.ts: presupuesto, circuit breakers, concurrencia, reintentos, idempotencia, costo y seguridad. Distinguir elegibilidad de modelos por plan del control operativo de rutas.
- engagement/service.ts: MAX_TEXT=1000; política por negocio versionada; max_auto_replies_per_hour=10 por defecto, rango 1..60; requiere consentimiento expreso para safe_auto_reply; reintentos=5, lease=120 s.
- social/scheduler.ts: maxAttempts=5, publishTimeoutMs=20000, batchSize=25, lease=120; separar operaciones de plataforma de frecuencia comercial.
- shared/config.ts y reputation/engine.ts: REVIEW_THRESHOLD default 4 por entorno; evaluar preferencia por negocio bajo política, no levantar la aprobación humana por un plan.
- Integraciones Meta/Google, conectores, creación de imágenes, notificaciones, agente de atención, conversación, publicador y exportes: auditoría exhaustiva requerida.

C. Cuotas ya existentes:
- website: actualmente hasta 1 en seeds y posible unicidad por tenant en tablas; comprobar contratos reales antes de proponer multi-sitio.
- social_posts, social_ads, reviews_managed, agents, conversations: definir unidad de consumo precisa y si cuenta creados, publicados, activos, procesados o ciclo de facturación.
- Revisar cuota por generación de IA, imágenes, almacenamiento, GB, conectores, páginas/sitios, usuarios internos, asistentes IA, campañas, publicaciones programadas, sucursales, tareas y analítica. Estos son CANDIDATOS; no tratarlos como funcionalidades existentes sin evidencia.
- Auditar cuotas en todos los entrypoints: API, workers, jobs, webhooks, cron, backoffice, importaciones, propuestas y jobs AI.

D. Valores no comercializables:
- Retención legal/contractual y de proveedor (retention/service.ts, google/retention.ts); Google 29 días implementados para respetar máximo de almacenamiento declarado.
- Autenticación/MFA/TOTP, expiración y anti-replay, rate limiting de seguridad, integridad tenant, límites de proveedor, timeout de sistema, circuit breaker, max pixels técnico, ventanas de idempotencia, requisitos de aprobación, consentimientos, prevención de publicación sin autorización, presupuestos globales/laboratorio aprobados.
- No transformar mínimos de evidencia (INSIGHTS_MIN_ACTIVE_DAYS=7) en beneficios de un plan premium. No tomar presupuesto PROPUESTO de marketing como autorización de gasto.

## 4. Auditoría exhaustiva obligatoria ANTES de programar

Inspeccionar exhaustivamente el árbol REAL de la rama de ejecución (no solo esta semilla):
1. Identificar fuente canónica aplicable en mainspot-documentation y .canonflow, estados, decisiones y conflictos; registrar referencias exactas y requerir decisión humana solo para cambios de autoridad/política que no estén aprobados.
2. Enumerar migraciones, constraints, triggers, modelos de dominio, contratos JSON Schema/Zod (si existieran), validadores, middleware, constantes, envs, feature flags, prompts, workers, proveedores, rate limits, UI, tests y documentos relevantes.
3. Buscar tanto números explícitos como constantes indirectas y defaults construidos en runtime. Usar búsquedas semánticas y estructurales; recorrer manualmente rutas críticas. Nunca declarar exhaustividad solo por ejecutar grep.
4. Generar docs/research/plan-parameters-inventory.md más su representación tabular machine-readable (CSV o JSON) con una fila por definición: key estable, descripción, source paths/lineas, comprobación exacta, valor actual, unidad, tipo, ámbito (sistema/plan/tenant/runtime), semántica, reset, hard upper bound, dependencias, punto de enforcement, consumidor UI, riesgos, clasificación comercial/operativo/seguridad/legal, decisión propuesta y estado evidenciado/propuesto.
5. Detectar duplicidades y valores inconsistentes entre generación, edición, persistencia, mensajes al usuario y prompt. Diferenciar schema de salida de límites realmente cobrables.
6. Identificar parámetros compartidos con infraestructura externa y obligaciones contractuales. No asumir que subir un límite o activar un proveedor es seguro o técnicamente soportado.
7. Documentar el resultado como HECHO / INFERENCIA / PROPUESTA; sin cifras comerciales nuevas ni pricing inventado.

## 5. Arquitectura objetivo

No reconstruir de cero; evolucionar catálogo de PostgreSQL y EntitlementService/QuotaLedger.

Entidades propuestas (nombres revisables):
- plan: identidad comercial, estado general, metadatos sin alterar información de precios aprobada.
- plan_parameter_definition: registro tipado de claves, categoría, tipo, unidad, default sugerido, rango permitido, techo no sobrepasable, comportamiento de ausencia, periodicidad, descripción legible y restricciones cruzadas.
- plan_revision: revisiones inmutables DRAFT / PUBLISHED / SUPERSEDED y su versión, actor, razón, fecha efectiva y checksum.
- plan_parameter_value: valores explícitos por revisión; no guardar JSON arbitrario sin contrato verificable; snapshots completos por revisión.
- subscription y subscription_history: plan, versión o política de actualización de revisión y vigencia de la asignación; registrar cambios.
- quota_reservation y mecanismos existentes: respetar atomicidad, idempotencia, reconciliación y la misma transacción de creación + auditoría.

ResolverEffectivePolicy(tenant, instante, capability) debe aplicar: validación de negocio y suscripción activa; plan/revisión publicada; preferencia autorizada del negocio solo si aplica; techo de sistema/contrato externo. Un valor ausente o desconocido produce deny/errores tipados, NUNCA concesión implícita; 0 = deshabilitado, null = sin valor, unlimited solo explícito y sujeto a techo técnico si se autoriza.

Usar una sola fuente de verdad tipada para validación de API, schemas generativos, editor, backend y mensajes de UI; las rutas AI deben validar estructura inmutable del contrato y límite efectivo plan/tenant de forma consistente. Si la generación de schemas por tenant/revisión implica riesgos de caché, medir y versionar. No debilitar seguridad al inyectar valores dinámicos.

Tipos de cuota:
- simultánea/stock: p. ej. activos en biblioteca; liberar al archivar, con invariantes transaccionales;
- acumulada sin período: p. ej. sitios activos;
- periódica: uso por ciclo de suscripción (decidir anclaje temporal y zona de manera explícita), con reservas y liquidación;
- sliding window/rate: p. ej. respuestas automáticas por hora, sin confundir con limitador de seguridad;
- elegibilidad/feature: inclusión de funcionalidad, sin sustituir RBAC, consentimiento ni autorización.
Definir bien cuándo cuenta el consumo, cómo se devuelve por fallo, replay, reversión y cancelación, cómo actúa el downgrade (no borrados destructivos), cambios de ciclo, TZ/DST, renovación y concurrent updates.

Definir si una suscripción fija la revisión del plan por contrato o sigue la revisión publicada. Nunca cambiar las condiciones vigentes de un cliente inadvertidamente. Previsualizar afectados antes de publicar.

## 6. Engineering Console: experiencia y autorización

Agregar tab Planes en /ingenieria, sin romper las pantallas actuales y sin duplicar la interfaz /plataforma. Secciones: catálogo, crear/clonar, editor agrupado de parámetros, validaciones, revisión de diferencias, confirmar todos los valores, publicar, historial/rollback, negocios afectados y consumo real vs asignado.

El usuario con rol ai_engineer debe acceder a la sección, pero solo mediante permisos de plataforma explícitos para leer y gestionar catálogo; platform_admin también podrá operar según regla formal; platform_support no podrá escribir. Separar gestión de límites y capacidades de cualquier precio, cobro, crédito, consentimiento o gasto de terceros. No convertir en self-service del negocio. Toda escritura requiere step-up TOTP, motivo, auditoría con actor y diff; validación server-side y control de concurrencia por revisión.

Crear un plan NO significa activar defaults. Los defaults son propuestas precargadas que deben revisarse y confirmarse de forma expresa en creación; no permitir publicar con campos obligatorios sin confirmar, aunque tengan un número prellenado. En edición: draft aislado, comparar, confirmar cambios, publicar nueva revisión; no modificar versión histórica. Buenas etiquetas, unidad, significado y período visibles (p. ej. 30 publicaciones por ciclo vs 30 en toda la vida), indicador de límite seguro y detección de conflictos. Accesibilidad AA razonable y validaciones claras, responsive.

Compatibilidad: el panel del negocio mantiene solo lectura del plan/consumo, nunca permisos administrativos para editar el catálogo.

## 7. Entregables y plan de ejecución

ETAPA A (reconocimiento): inventario exhaustivo, mapa de enforcing paths, inconsistencias, fuentes canónicas y riesgos; escribir evidencia. No inventar que la investigación concluyó si hay carpetas/entornos no disponibles.
ETAPA B (contrato y decisiones): diseño de tablas, migración/backfill compatible, decisión sobre periodicidad de cuotas, activación por revisión, límites de sistema, permisos y confirmación. Cerrar cuestiones T3/T4 con el propietario según CanonFlow antes de operaciones irreversibles.
ETAPA C (implementación backend): migraciones aditivas idempotentes; tests; servicios de resolución y API; aislamiento de tenants; locking/transaction; observabilidad y auditoría; sin pagos reales.
ETAPA D (UI): mantenimiento /ingenieria funcional con lectura/escritura, confirmación por parámetro, previews, diff, errores, revisión y rollback.
ETAPA E (integración): migrar de forma incremental límites comerciales hardcoded a resolver efectivo, conservar inmutables técnicos, normalizar contratos inconsistentes. Priorizar media, web, marca, generación de IA, marketing, atención y quotas; documentar exclusiones.
ETAPA F (verificación): unit/integration, DB migrations/backfill y rollback en DB de pruebas, E2E real UI/API (sin depender de simulaciones engañosas), concurrencia >1 worker/tenant, pérdida de conexión, timeouts, replays, escalamiento de seguridad, cross-tenant deny, invalid plan, estados draft, downgrade, renovación, consumo y reconciliación, performance. Incluir revisores independientes de máxima calidad para arquitectura, seguridad, migraciones y UX.

Producir entregables verificables en repo: inventario, diseño/ADR, cambios de esquema, API, UI, pruebas y un documento de cierre con filas PASS/FAIL/BLOCKED, pruebas realmente ejecutadas, comandos, outputs y commit SHA. No marcar producción READY sin evidencia integral.

## 8. Restricciones de implementación

- No alterar master ni desplegar a producción automáticamente. Trabajo en rama propia desde la base correcta; PR para revisión.
- No introducir precio, cargos ni procesador real donde el canon los prohíbe.
- No borrar contenido en degradación de plan.
- Preservar checks de calidad de insights, protección contra prompt injection, gates humanos, consentimientos, retención, políticas de datos y límites del proveedor.
- Nada de fallback silencioso a proveedores o modelos de IA; las rutas del producto permanecen gobernadas por su registro y decisiones vigentes.
- No usar Fable en el agente principal ni en subagentes. No delegar trabajo a modelos de calidad reducida. Seguir íntegramente la política de ejecución del prompt de arranque.
- Si el régimen canónico exige autorización humana para cambiar decisiones de producto, dejar propuesta claramente separada del código o solicitar el gate; nunca autocertificar aprobación.
- No llamar PASS a pruebas no ejecutadas, pruebas sintéticas como si fueran reales, ni a un análisis no exhaustivo.

## 9. Criterios de aceptación (mínimos)

AC01: los planes existentes quedan migrados con sus valores vigentes explícitos, sin pérdida y sin introducir beneficios comerciales inventados.
AC02: cada parámetro tiene tipo, unidad, ámbito, enforcement, default propuesto y techo justificado.
AC03: crear/clonar un plan muestra defaults pero exige confirmación de todos los valores aplicables para publicación.
AC04: edición agrega nueva revisión, diff, motivo, confirmación, step-up, auditoría y recuperación de versión anterior.
AC05: control del catálogo disponible al ai_engineer con permisos específicos, y denegado a soporte/tenants/roles no autorizados.
AC06: cuotas periódicas, acumuladas, simultáneas, rate y elegibilidad funcionan según su semántica, sin carrera ni doble consumo en replay.
AC07: la API, frontend, workers y AI contracts consumen límites compatibles y muestran errores adecuados.
AC08: ninguna cuota comercial modifica seguridad, integridad, retención, consentimiento, autorización humana o techos de proveedor.
AC09: ausencia de plan o valor requerido deniega correctamente; plan en borrador no se asigna; downgrade no destruye datos.
AC10: pruebas automatizadas + UI E2E reproducibles respaldan cada afirmación; cambios de BD tienen backfill y estrategia de reversión.
AC11: documentación canónica y estado de gobernanza coherentes con la modificación, sin aprobar decisiones reservadas al humano.
AC12: manifiesto de agentes y subagentes muestra modelos efectivos de clase flagship, sin Fable ni degradaciones.

## 10. Protocolo de trabajo y reporte

Reportar al propietario: base SHA y branch; inventario de archivos revisados; decisiones existentes vs propuestas; matriz de riesgos; etapas con commits/PR; resultados de verificaciones; limitaciones y blockers. Si solo es posible completar un subconjunto, decirlo, sin generalizar cobertura. No hacer cambios externos sin autorización.

Este documento define el trabajo, NO representa ejecución final ni certifica que el catálogo completo esté implementado.
