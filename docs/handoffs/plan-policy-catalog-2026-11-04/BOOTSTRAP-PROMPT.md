# BOOTSTRAP — MainSpot | Catálogo de planes y políticas por plan

## Instrucción inicial para el agente ejecutor

Actúa como Principal Software Architect + Staff Engineer con responsabilidad de implementación integral y trazabilidad de evidencia. Trabaja en el repositorio hachxaan/mainspot-platform.

MANDATO: implementar de manera incremental y gobernable el mantenimiento de planes y parámetros desde PostgreSQL, con una UI real bajo /ingenieria, después de realizar auditoría exhaustiva de constantes, validaciones, cuotas, capacidades y políticas del código. Mantén la integridad de los contratos canónicos y las decisiones reservadas al propietario.

REFERENCIA OBLIGATORIA:
- docs/handoffs/plan-policy-catalog-2026-11-04/HANDOFF.md (leer completo antes de tocar código).
- .canonflow/canon/functional/items/FR-0010.md y FR-0019.md.
- Referencias y baselines vigentes en mainspot-documentation y estado de .canonflow (validar en el entorno real; no inventar aprobación).
- package.json, migraciones, src/subscriptions, src/web/platform, src/api/platform-routes.ts, src/ai/contracts.ts y los puntos de enforcement descubiertos.

RAMA:
- La rama de este handoff es docs/handoff-plan-policy-catalog-20261104 (solo documentación).
- La implementación debe basarse en feat/canonflow-implementation a partir del SHA actual VERIFICADO al comenzar; crea rama nueva de implementación, sin cambiar master y sin sobreescribir trabajo de terceros.
- Compara el handoff con el HEAD real: el código puede haber cambiado desde la fecha del documento. Mantén las referencias de commits en el reporte.

## POLÍTICA DE MODELOS — MANDATORIA, NO NEGOCIABLE

Aplica al AGENTE DE DESARROLLO Y A TODOS SUS SUBAGENTES, revisores, investigadores, testers y delegaciones. No cambia por sí misma el catálogo de modelos de IA que MainSpot ofrece a sus clientes.

1. PROHIBIDO utilizar Fable. Esta prohibición alcanza al agente principal, subagentes, workers de coding, reviewers y cualquier delegación, también si Fable aparece como default, alias o fallback automático.
2. PROHIBIDO degradar calidad para ahorrar costo/latencia. No usar tier económico/liviano (Haiku, Flash, mini, nano, small, fast, compact, lightweight o equivalentes); no usar en tareas “fáciles” un modelo inferior sin autorización expresa. El tamaño de la tarea NO justifica una degradación silenciosa.
3. Antes de crear subagentes, determina los model IDs reales, el modelo en uso y el mecanismo real de selección del runtime. Selecciona explícitamente un modelo flagship de máxima capacidad de razonamiento disponible, idealmente la familia Claude Opus más capaz realmente disponible o equivalente de capacidad superior demostrable. No supongas que el nombre de un modelo definido para el producto es un model ID ejecutable en tu orquestador.
4. Asigna y verifica explícitamente el modelo de CADA subagente y revisor. No confíes en auto-routing ni defaults no comprobados. Registra rol, modelo efectivo y evidencia de selección; si no puedes comprobarlos, NO delegues.
5. Si no existe modelo flagship verificable para una delegación, ejecuta ese trabajo personalmente con el modelo principal de máxima calidad; si tampoco puedes garantizar calidad del principal, detén la ejecución y reporta el bloqueo. Nunca sustituyas en silencio por Fable u otro modelo de menor capacidad.
6. Para arquitectura, seguridad, migraciones, pruebas y revisión independiente usa el mismo estándar de calidad del ejecutor; no externalices pensamiento crítico a un modelo más barato.
7. Preferencia por calidad > costo/velocidad; un fallo real se declara BLOCKED, no se reetiqueta como PASS para ahorrar llamadas.
8. La verificación de selección de modelos es una condición de arranque y forma parte de las evidencias de aceptación (AC12 del handoff).

## OBJETIVO FUNCIONAL

1. Inventariar de forma exhaustiva todos los parámetros candidatos a variar por plan, por negocio y por plataforma, y todos los hardcodes: límites, textos, tamaños, cuotas, períodos, flags, máximos, defaults, thresholds, capacidades, elegibilidad, IA, media, website, brand, marketing, engagement, cuentas y conectores.
2. Clasificar por autoridad: comercial del plan, preferencia del negocio, operación de plataforma, seguridad/calidad/contrato. Prohibido mover indiscriminadamente todo a plan.
3. Reutilizar plan, plan_limit, subscription, EntitlementService y QuotaLedger, evolucionándolos a un catálogo tipado, versionado y validado con periodos y semánticas explícitas.
4. Incorporar una sección real “Planes” en Engineering Console con creación/clonación, defaults sugeridos, confirmación explícita de TODOS los parámetros aplicables antes de publicar, edición de borradores, diff, publicación con step-up TOTP, rollback e historial.
5. El rol ai_engineer debe poder gestionar parámetros mediante permiso específico de plataforma; platform_admin también según matriz aprobada. No habilitar permisos de facturación ni secretos por ese motivo. No permitir edición por platform_support ni perfiles de negocio.
6. Unificar los puntos de validación de API, generación IA, edición web, persistencia y ejecución de trabajos, evitando inconsistencias.
7. Mantener observabilidad, auditoría, aislamiento multi-tenant, idempotencia y cuotas atómicas en concurrencia.

## GUÍA DE EJECUCIÓN

FASE 0: PRE-FLIGHT
- Confirma repositorio, branch, HEAD, estado git y herramientas disponibles; comprueba runtime de agente y modelos de subagentes con la política anterior.
- Lee HANDOFF.md íntegro. Comprueba canónica y decisiones. Identifica qué está corroborado y qué es solo inventario semilla.
- No hagas cambios destructivos, despliegues ni gastos de APIs reales.

FASE 1: INVESTIGACIÓN + CONTRATOS
- Recorre el repo real de forma exhaustiva; usa búsqueda sistemática de constantes, esquemas, validadores, SQL, migraciones, env, frontend, prompts, background jobs y tests, más revisión manual de rutas críticas.
- Crea docs/research/plan-parameters-inventory.md y JSON/CSV equivalente, con trazabilidad archivo:línea, unidad, tipo, default, semántica, período, enforcement y clasificación HECHO/INFERENCIA/PROPUESTA. Detecta contradicciones y capacidades comercialmente inexistentes.
- Define ADR/arquitectura, wire contracts, RBAC y estrategia de migración. Documenta las decisiones que dependan de owner/canon: solicita gate humano solo cuando la autoridad realmente lo exija; no fuerces ni supongas aprobación.
- Entrega resumen de riesgos de diseño: cuotas vitalicias vs periódicas; cambios masivos de planes; multi-site limitado por DB; AI schema vs editor; políticas de retención, revisión humana y consentimientos.

FASE 2: BACKEND
- Esquema aditivo y migración idempotente de planes existentes, conservando comportamiento efectivo, sin pricing inventado.
- Planes en borrador y revisiones publicadas inmutables; validación completa server-side y checksum. Valores ausentes => fail-closed; defaults NO se publican sin confirmación.
- Resolver tipado por tenant/suscripción/revisión/tiempo; cuotas acumuladas, simultáneas, periódicas, sliding window, elegibilidad; lock y consumo atómico; release/replay/rollback.
- API restringida por permisos de plataforma + step-up y motivo, con historial/diff, auditoría. Garantiza que el planeado override por negocio no supere los techos aprobados.
- No cambies políticas de seguridad, retención, proveedor o gate humano según categoría de plan.

FASE 3: UI
- Agrega tab “Planes” a /ingenieria. Formulario simple, no wizard innecesario: definición legible, unidades, límites por categoría, validaciones, impacto de cambios y confirmación completa.
- Diferencia claramente plan draft, publicado, deshabilitado y suscripciones afectadas. Edita por versión, jamás in-place la publicada. UX accesible, desktop/mobile, mensajes claros.
- Asegura que los defaults del plan recién creado no se confirman automáticamente al guardar el draft.

FASE 4: ENFORCEMENT Y MIGRACIÓN
- Sustituye hardcodes COMERCIALES de manera incremental y consistente en media, web, brand, IA, marketing, atención, cuotas y entradas asíncronas. Los techos técnicos siguen hardcoded o en config de plataforma protegida.
- Si un número surge de un proveedor o de un formato de API, preserva su naturaleza; no lo vendas como cuota.
- Asegura que prompts y esquemas no sean incompatibles con el valor del plan. No rompas la validación tipada.
- Mantén compatibilidad con los tres planes y tenants existentes; prueba downgrade sin borrados.

FASE 5: REVIEW + EVIDENCIA
- Revisión independiente de arquitectura, autorización, aislamiento multi-tenant, migraciones/rollback y UX con agentes de calidad flagship, todos sin Fable y con selección comprobada.
- Corre tests unit, integration, E2E de UI/API con DB de pruebas y casos de concurrencia; no llames reales a pruebas simuladas. Corrige fallas o márcalas BLOCKED con evidencias.
- Prepara PR(s) con commits lógicos; deja documentación canónica y decisiones T3/T4 en su estado autorizado, sin autocertificar owner approval.
- Reporta cobertura exacta de directorios y parámetros auditados, matriz AC01..AC12, comandos ejecutados, resultados y limitaciones. Si un módulo queda sin migrar, reporta el límite persistente y el motivo.

## DEFINICIÓN DE HECHO

Solo declarar DONE cuando:
- inventario exhaustivo comprobable, sin hechos inferidos como confirmados;
- diseño versionado y coherente con canon;
- mantenimiento de planes funcional y protegido en /ingenieria;
- todos los planes existentes conservan límites explicitados y la creación nueva exige confirmación total;
- cuotas consumidas con semántica adecuada y transacción segura;
- pruebas reproducibles, reviewer independiente y rollback documentado;
- evidencia de que ningún agente/subagente usó Fable ni un modelo de calidad degradada.

El objetivo es el sistema completo, no una interfaz simulada ni una simple sustitución de constantes por queries.

## PRIMERA RESPUESTA ESPERADA DEL AGENTE

Informa en un mensaje compacto:
- branch base y SHA real;
- paths canónicos leídos;
- capacidades existentes verificadas y riesgos prioritarios;
- modelos del agente principal/subagentes REALMENTE comprobados (sin Fable);
- plan de trabajo por fases, lo que se implementará y las decisiones humanas estrictamente necesarias.

Después EJECUTA las fases posibles en la sesión, no te quedes solo en un plan, no inventes evidencias ni tiempos.
