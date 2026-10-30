# MAINSPOT AI CORE — Handoff de implementación integral E2E
**Fecha:** 2026-10-30  
**Iniciativa padre:** https://github.com/hachxaan/mainspot-platform/issues/9  
**Repositorio:** hachxaan/mainspot-platform  
**Rama de integración:** feat/canonflow-implementation; baseline observado al preparar este documento: 69ab1db (verificar HEAD al arrancar)  
**Ejecución:** SOL MAIN / OMP, GPT-6.1 Sol, documentación canónica funcional → técnica → implementación → QA real.  
**Estado de este documento:** orden de ejecución para desarrollar toda la capacidad; NO certifica que el E2E ya exista ni concede permisos para alterar cuentas, pagar anuncios o enviar datos reales a proveedores nuevos.

## 0. Misión y no negociables

Convertir MainSpot en una plataforma de presencia digital **operada transversalmente por IA** para propietarios de micronegocios sin conocimientos técnicos. El cliente trata con **un solo asistente** mediante panel, Telegram y otros canales autorizados; la implementación despacha a capacidades especializadas con prompts, modelos y presupuestos independientes. Jev es el **clasificador semántico primario** para mensajes y eventos de texto (intención, sentimiento, categoría y necesidades de atención), no un generador ni un motor de autorización.

Entregar un sistema **E2E operable**: consolas, configuración dinámica de rutas y prompts, generación de texto e imágenes, sitio web inicial y ediciones, publicaciones Facebook, atención de comentarios y reseñas Google, asistente con acceso limitado al estado del negocio, borradores de campañas, analítica y gobernanza. No vale etiquetar un mock como real ni dar por integrado un proveedor externo porque un test sintético pasó.

Preservar infraestructura y funciones existentes. Leer antes de intervenir: .omp/RULES.md, .omp/AGENTS.md, README, documentación canónica y decisiones HDC, issue #9, issues #6/#8, docs/handoffs/e2e-parallel-2026-10-29/HANDOFF-2-RESULTS.md. Inspeccionar rama, working tree, commits de terceros, entorno, migraciones y contratos; no force push ni reset destructivo; no modificar KVM/WireGuard/Starlink, servicios ajenos, respaldos o Gate 7 por comodidad.

## 1. Hechos del baseline: no confundirlos con la meta

- Existen panel de **negocio** (administration/operation/view y /api/backoffice), autenticación por tenant, preview/aprobaciones, versión/restauración web, HTTPS **local**, casos de atención, red social con scheduler y conectores Google/Meta parcialmente implementados. No equivale a consolas **centrales** de administración o ingeniería.
- src/website/template.ts renderiza una plantilla HTML fija; src/website/edit-mapper.ts procesa ediciones por patrones, sin diseño web generativo.
- src/engagement/classifier.ts usa palabras clave para categoría, sentimiento y riesgo; src/reputation/engine.ts contiene otro flujo de reseñas. **Reconciliar** ambos antes de añadir generaciones automáticas para evitar respuestas duplicadas.
- Jev está integrado para intención/capacidad en src/conversation/jev-classifier.ts, con TypeSafe (jev-latest por alias), pero scripts/dev-panel.sh fuerza JEV_MODE=disabled. No afirmar Jev real/primario activo.
- DEC-0019 rechaza enviar mensajes reales a TypeSafe para evaluación en sombra; el comentario requiere autorización **separada** para uso de datos reales. La decisión del propietario del 30-oct-2026 **aprueba Jev como primario** para conversaciones, NO revoca tácitamente DEC-0019 ni habilita envío de información real. Formalizar como nuevo registro de decisión y resolver acceso/datos/retención en otro gate.
- DEC-0032 aprueba USD 1/día para TypeSafe **en desarrollo y pruebas**, no para el nuevo runtime de IA generativa.
- DEV-E2E-04: 302/302 tests y smokes locales reportados. Google, Meta, SMTP y webhook auténticos siguen BLOCKED_EXTERNAL por autorizaciones/credenciales/KVM; no cerrarlos como probados ni frenar por ello las capacidades independientes.

## 2. Decisiones y aportaciones arquitectónicas

### 2.1 Una interfaz humana, herramientas especializadas y responsabilidad unificada
Un único asistente visible al negocio; internamente un router de capacidades con registros estables. Evitar múltiples agentes que se envíen textos libres entre sí y pierdan contexto: pasar contratos tipados y referencias a contexto. Desacoplar clasificación (Jev), planificación/generación (LLMs), producción visual (modelos de imagen), lectura de hechos (herramientas) y ejecución externa (backend autorizado).

### 2.2 Brand Studio + Base de Hechos Verificados
NUEVA CAPACIDAD TRANSVERSAL: cada negocio configura una identidad de marca aprobada y versionada: nombre, giro, descripción, propuesta, voz, audiencia, idioma, tonos a evitar, paleta, fuentes permitidas, logo/variantes, imágenes propias/autorizadas, productos/servicios, ubicaciones, horario, canales, CTA, precios confirmados, promociones con vigencia y restricciones. Cada campo guarda origen, fecha, aprobación y nivel de confianza. El asistente recupera solo los datos necesarios por herramienta/tenant, nunca carga toda la cuenta ni completa información ausente inventando. Un cambio de facts puede invalidar borradores/campañas dependientes: avisar y ofrecer regeneración, no sobrescribir publicaciones ya aprobadas silenciosamente.

### 2.3 Biblioteca multimedia y composición por canal
NUEVA CAPACIDAD: generar, subir, adaptar, previsualizar y reutilizar assets con metadatos de fuente/licencia/consentimiento, ALT, formato, ratios, miniaturas, compresión y límites por plan. Para Facebook: texto, emojis con criterio, CTA, hashtags útiles, imagen o carrusel **solo si Graph API y capacidades efectivas lo soportan**, accesibilidad y vista previa fiel. Moderar marca, derechos, datos personales, logos ajenos, claims engañosos y contenido sensible antes de publicar. No usar fotos ficticias de instalaciones/productos como si fueran reales; cuando sea ilustración, tratarla como tal y etiquetar según canal/política aplicable.

### 2.4 Inteligencia editorial, no spam automatizado
NUEVA CAPACIDAD: calendario editorial sugerido (estacionalidad comprobada, promociones aprobadas, eventos locales verificados, frecuencia elegida y horario), lotes de borradores, feedback por rechazo/edición y detección de publicaciones duplicadas. Nunca ejecutar campañas/publicaciones no autorizadas ni inventar resultados comerciales. El usuario acepta o corrige ideas con una pantalla sencilla.

### 2.5 Control del costo y del resultado
NUEVA CAPACIDAD: medidores y cuotas por **tenant × capability × use_case × modelo × modalidad**; presupuestos diarios/mensuales, reserva antes de generar imágenes o iniciar trabajos caros, techo duro, alerta temprana, cálculo de costo solicitado y cobrado con origen del dato, métricas de calidad reales. Fallback a modelo pequeño SOLO si pasó eval para la tarea; no aplicar fallback inseguro a modelo no autorizado. No declarar ahorro sin medición comparativa.

### 2.6 Seguridad y restricciones comerciales
NUEVA CAPACIDAD: control plane de IA con deny-by-default, trazabilidad, observabilidad segura, aislamiento de tenant, defensa de prompt injection, herramientas de solo lectura vs mutación, permisos de plataforma separados de los del negocio. La clasificación de Jev puede contribuir a la evaluación de riesgo, pero nunca concede permisos ni sustituye validaciones deterministas. Human-in-the-loop proporcional al impacto. Consumo de servicios y credenciales de proveedores externos solo con cuenta y autorización explícitas.

### 2.7 Restricciones relevantes de plataformas
- Google no permite review gating: no filtrar para solicitar reseña pública solo al satisfecho; sí alertar al dueño sobre calificaciones bajas **sin suprimir ni desviar el derecho del cliente a opinar**. Referencia: https://support.google.com/business/answer/7400114
- Política Business Profile para desarrolladores: autorización explícita previa para responder; límites a acceso indirecto en aplicaciones para terceros y almacenamiento temporal de contenido. **Investigar el modelo jurídico/técnico exacto de distribución SaaS antes de diseñar la activación productiva multiempresa; documentar dictamen de viabilidad y opción compatible, sin forzar una solución que viole términos.** https://developers.google.com/my-business/content/policies
- API reseñas Google: responder mediante operaciones oficiales y read-back de respuesta/estado; disponible para ubicaciones verificadas con permisos efectivos. https://developers.google.com/my-business/content/review-data
- Meta: permisos reales, revisión de la app, Page/token, capacidades verificadas; Ads API y acceso de marketing separados de posts/comments. Validar versión vigente, límites, formato admitido y permisos en fuente oficial en el momento de implementar. Sin gasto publicitario ni campañas reales sin confirmación específica de cuenta, importe, destino y límites.
- Antes de elegir proveedores de texto/imágenes, verificar licencias comerciales, tratamiento de datos/retención, jurisdicción, disponibilidad, límites y precios reales; no asumir compatibilidad por nombre.

## 3. Tres superficies UX y autoridad

**A. Business Panel (existente, ampliado).** Perfil del negocio, Brand Studio, conversación única, página/diseños, posts/calendario, comentarios/reseñas, campañas, pendientes y actividad. UX móvil primero, vocabulario no técnico, máximo una acción principal por pantalla, progreso y estados legibles. Usuarios ven **qué hizo MainSpot, qué está proponiendo y qué necesita decidir**; nunca los prompts, claves o nombres internos del modelo por defecto.

**B. MainSpot Administration (central).** Operación del SaaS, independiente de RBAC de tenants: alta/desactivación de negocios, trials/planes/entitlements, capacidad y costos/ingresos, salud de proveedores/canales y workers, soporte autorizado, incidentes, auditoría y atención de bloqueos. Impedir superadmin implícito por ser 'administration' de un negocio. Acceso central con MFA/step-up adecuado, expiración, privilegio mínimo, segregación de funciones, auditoría; asistencia al negocio con motivo/autorización y vistas limitadas, sin suplantación silenciosa.

**C. MainSpot Engineering Console (NUEVA).** UX de administración de IA como usuario final de ingeniería (sin editar archivos para configuración ordinaria):
- Catálogo versionado de casos de uso/skills; objetivo, entradas, salidas, riesgos, propietario, dependencias y estado.
- **Prompt Studio:** system/developer/task separados, plantillas con variables tipadas y whitelist, contexto de marca/herramientas controlado, versiones inmutables y hashes, diff, notas de cambio, vista de prompt final sanitizada y test cases. Las instrucciones de seguridad/autoridad de plataforma no son editables como prompts comunes.
- **Model Registry & Routing:** proveedores y modelos por modalidad y capacidad, referencias a secretos, región/retención/contratos, estado y modelo fijado por ID exacto en producción (alias solo para descubrimiento); ruta por use_case, complejidad, riesgos, presupuesto, plan y rollout, sin opciones implícitas. Modelo grande para diseño inicial, pequeño para edición sencilla *si pasa calidad*, modelo adecuado para social/atención/chat/campañas, generador visual distinto.
- **Playground + Evaluations:** corpus de escenarios sintéticos y autorizados, pruebas ciegas A/B, goldens de intención/sentimiento, calidad visual, factualidad, tono, seguridad, costos y latencia. Evaluación de humanos para calidad creativa. Comparar cambios de prompt/modelo con métricas.
- **Lifecycle:** DRAFT → TESTED → APPROVED → CANARY → ACTIVE → RETIRED; rollback inmediato, estado por ambiente, activación atómica de ruta/prompt, historial append-only, actor/motivo/resultado, bloqueo por gate. Un cambio no altera retrospectivamente ejecuciones ya iniciadas.
- **Operations:** traces sanitizadas, coste/tokens/imágenes por tenant/use_case/modelo, errores, incertidumbre, tiempos, drift de calidad, recomendaciones; administración de cuotas y alarmas. Nunca mostrar secretos ni conversación real sin permiso específico.
- **Proveedores:** secret references a almacén seguro, rotación, test de conectividad sin exponer secreto, scopes mínimos, límites y circuit breakers.

**HDC/CanonFlow** documenta/aprueba decisiones canónicas cuando corresponda, pero **NO** es el dashboard de ingeniería ni el backoffice central.

## 4. Catálogo mínimo de use cases y contratos

Registrar como mínimo:
- conversation.intent.classify → **Jev primario**, preguntas tipadas: intención, target/capability, sentimiento (positivo/neutral/negativo/mixto), categoría, urgencia, sensibilidad/risk flags, aclaración requerida, grado de incertidumbre. Definir calibración evaluada; **no asumir** que confidence equivale a probabilidad calibrada del mundo real.
- conversation.owner.assistant → LLM conversacional con herramientas de consulta tipadas: estado de plan/cuenta, página/versiones, próximos posts, casos, métricas, conexiones; deny por rol/tenant y no acceso directo arbitrario a SQL, secretos ni todas las conversaciones.
- website.initial.design → modelo creativo/arquitectónico de capacidad alta: brief, wireframe/contenido, elección de componentes, diseño responsive, accesibilidad, SEO básico honesto, propuesta y preview. Layout compuesto con bloques/DSL verificados; código libre generado solo en sandbox de compilación/seguridad separado, sin ejecutar JS arbitrario en sitios publicados.
- website.edit.simple → modelo veloz/costo bajo para cambios textuales, de componentes/estilo, output parche tipado sobre versión inmutable; website.edit.complex → escala a capacidad superior si dificultad/eval lo justifica. Ambas requieren diff semántico y visual, preview y aprobación.
- website.image.generate → imagen, descripción, formato, rights/branding, ALT y asset id.
- social.facebook.post.compose → copy, variantes, emojis/hashtags contextualizados, CTA y propuesta editorial, sin ofertas inventadas.
- social.facebook.image.generate → imagen/carrusel y versiones para canal según API soportada.
- engagement.facebook.comment.classify y engagement.google.review.classify → Jev con sentimiento/riesgo, rating como señal independiente en Google, detección de queja/amenaza/PII.
- engagement.facebook.comment.reply y engagement.google.review.reply → respuestas con hechos verificados y tono de marca; opt-in por origen/categoría, límites y aprobación cuando sea sensible.
- marketing.campaign.plan y marketing.campaign.creatives → público objetivo, objetivos, canales, creatividad, presupuesto PROpuesto, revisión, sin autoactivación/gasto.
- business.insights.generate → resumen y recomendaciones explicables a partir de métricas autorizadas; mostrar evidencia y periodo de datos, abstenerse si insuficientes.

Contrato de invocación IA: request_id/idempotency_key, tenant_id, actor_id+roles, origin, use_case_id, input_ref o input tipado minimizado, brand_facts_version, prompt_version, route_version, model/provider, policy_version, consent_ref, trace_id, token/cost budget, deadline. Contrato de salida: schema version, structured result/draft refs, evidence sources, uncertainty, validation results, usage/cost, safety status, next action proposal. **El modelo no recibe credenciales ni decide quién tiene autoridad**.

Escribir schemas tipados y tests de validación. Si una tarea no necesita IA (por ejemplo cambiar un horario ya estructurado), permitir atajo determinista económico sin sacar a Jev del rol primario para **mensajes semánticos**.

## 5. Flujos E2E por producto

### 5.1 Primer acceso y memoria comercial
Invitación → login → datos del negocio/Brand Studio → información esencial verificada → conexiones de canales autorizadas → conversación de bienvenida contextualizada. Registrar qué hechos están confirmados, cuáles no y de qué fuente proceden; no pedir al negocio datos que el sistema ya posee. Altas, herramientas y agentes sujetos a permisos.

### 5.2 Primera página y edición
Dueño: «Crea mi página» → Jev determina intención → brief guiado con preguntas necesarias → modelo website.initial.design + generación de assets → composición segura de diseño realmente personalizado → pruebas de HTML/CSS/SEO/accesibilidad/mobile → preview real con captura visual → usuario aprueba → versión inmutable → publicación HTTPS verificada (local en entorno lab, externa solo si autorizada y probada) → historial. 
Cambio simple: «cambia el horario» o «pon esta foto» → modelo liviano o ruta económica evaluada → diff exacto sin modificar contenido no solicitado → preview/aprobación/publicación. Cambio complejo: «rediseña la portada como una cafetería moderna» → ruta de mayor capacidad. Restaurar v1 después de v2 crea v3 (sin borrar historial). Assets siguen versionados.

### 5.3 Publicaciones Facebook completas
«Anuncia la promoción vigente» → lectura de oferta realmente aprobada → Jev intención → generación de 2-3 variantes de copy, emojis/hashtags y propuestas visuales → selección/regeneración parcial → previsualizar por canal → aprobación de texto+imagen+fecha+Page → scheduler durable → llamada Meta real cuando esté autorizado → lectura de post publicado/id, auditoría, resultado incierto separado. Publicación inmediata y programada, error de cuota, token caducado, cancelación y reintentos seguros. Que un scheduler con Meta falso pase **no** acredita publicación auténtica.

### 5.4 Comentarios y reseñas
Evento Facebook/Google autenticado o polling permitido → dedupe por source_id/revisión → Jev sentimiento/intención/categoría/riesgo → facts del negocio y política por tenant. Caso simple con consentimiento específico: respuesta generada, validada y automática dentro de límites. Caso negativo, ambivalente, sensible o sin hechos: tres propuestas útiles, alerta panel/Telegram, aprobación/edición/rechazo. Reconciliar src/reputation y src/engagement: **un solo ledger de respuesta por comentario/reseña**, prohibidas dobles respuestas desde vías paralelas. Reconocer errores inciertos y verificar proveedor antes de reintentar. No impedir reseñas negativas ni manipular puntuaciones.

### 5.5 Asistente dueño con acceso a estado
Ejemplo: «¿Qué publicaste esta semana? ¿Qué comentarios necesitan mi respuesta?». Jev enruta; el LLM llama **herramientas de lectura autorizadas** con tenant/actor; muestra resultados trazables reales, no cifras inventadas. Para «programa una campaña de $500» genera propuesta y requiere aprobación de cuenta, destino, importe y techo; no ejecutar anuncios ni compromisos de gasto por la sola instrucción.

### 5.6 Dos consolas administrativas
Admin central consulta clientes/planes/consumos/health y atiende incidentes sin exponer datos entre tenants. Engineering define dos versiones de prompt para website.edit, asigna proveedor/modelo distinto al de website.initial.design, ejecuta A/B synthetic, activa ruta por canary, ve costo/latencia, verifica nueva ejecución con IDs auditados y revierte sin deploy. Prueba negativa: un administrador de negocio y una cuenta de operación NO pueden invocar ninguna API administrativa/ingeniería. Configuración malformada no afecta ruta vigente.

## 6. Riesgos y gates obligatorios

**G0 — privacidad y autorización**: registrar en canon Jev PRIMARY como decisión explícita nueva; resolver DEC-0019 mediante decisión distinta sobre datos reales a TypeSafe (consentimiento, minimización, condiciones contractuales, retención, base legal en jurisdicción aplicable y alternativa compatible). Antes, usar Jev solo con datos sintéticos / corpus autorizado y mostrar BLOCKED_EXTERNAL para mensajes reales. No cambiar a primary en local engañando el gate ni borrar protección.

**G1 — proveedor y modelo**: evaluar al menos dos rutas candidatas donde sea práctico. Medir calidad real y costo/latencia de tareas representativas; modelos y precios exactos se documentan con fecha, sin inventarlos. Capacidades de imagen, términos comerciales, requisitos de uso. Mantener SDK/adaptadores desacoplados y no hardcodear un proveedor por toda la plataforma.

**G2 — seguridad**: threat model multi-tenant, prompt injection y exfiltración por comentarios/reseñas/URLs/archivos, autorización de herramientas, documentos no confiables, output encoding, XSS/CSP, SSRF, suplantación, rate limits, secretos, sesiones MFA de admins, poisoning de memoria comercial, abuso/costo de imágenes, invalidación y expiración. Pruebas negativas automatizadas y adversariales. Acciones externas fail-closed.

**G3 — publicación y dinero**: propuestas y consentimiento, no ejecutar gastos de Ads ni campañas pagadas sin autorización explícita específica y presupuesto límite; no post/reply no autorizado. Escalamiento manual disponible. Uso de proveedores de prueba propios, nunca clientes reales sin permiso.

**G4 — resiliencia**: cola/outbox durable, leases/fencing, idempotencia interna, reconcile external uncertainty antes de reenvío, rate limit/429/5xx/backoff, caídas de proveedor, DB reinicio, cancelación, rotación de credenciales, timeout y rollback; no prometer exactly-once externo si API no lo garantiza.

**G5 — verificaciones externas**: Meta/Google/SMTP/Telegram/Ads quedan BLOCKED_EXTERNAL si no hay tokens, permisos, acceso al proveedor o autorización. No cerrar E2E real con imitaciones HTTP. Resolver el modelo Google SaaS conforme a política antes de presentar automatización Google como comercialmente viable.

**G6 — autorización de infraestructura**: no reiniciar host entero, KVM ni servicios no relacionados sin ventana autorizada; no consumir cuentas de producción ni alterar dominios públicos para pruebas.

## 7. Estructura sugerida, sin imponer implementaciones

Un registro central de AI use cases, prompt revisions (immutable), model/provider registry, model route revisions, rollout assignments, evaluation suites/runs, policy+consent revisions, generation jobs, generation artifacts/media, usage ledger, approved brand facts, execution traces y unified engagement ledger. Migraciones aditivas y reversibles; preferir módulos compatibles con el stack TS/Node/PostgreSQL existente. Configuración dinámica desde DB con cache invalidation/version pin, no lectura continua de ENV para cada cambio de modelo.

Capas: adapters Jev/LLM/image, capability dispatcher, fact retrieval tools, prompt renderer estricto, evaluator, policy/gate, artifacts/versioning, orchestrator/outbox, provider connectors. Evitar framework multiagente pesado sin necesidad demostrada. Preservar canon existente y reusar pipelines/versionado/scheduler/auditoría.

## 8. Orden de ejecución autónoma, con checkpoints comprobables

**F0 — descubrimiento y documentación canónica funcional.** Inventario real de paneles, código, proveedor y restricciones; mapa de capacidades y journeys, vocabulario de usuario, requisitos de calidad medibles, requisitos no funcionales, matriz de roles, modelo de consentimiento, coste estimado por operación y riesgos. Reconciliar con canon y decisiones existentes; **no editar retrospectivamente registros de decisión**. Publicar arquitectura de información/UX de consolas y prototipos E2E aprobables. Entregar contratos funcionales y backlog por historia con dependencias.

**F1 — documentación canónica técnica + laboratorio de modelos.** Versionado de prompt/route, schemas, store de secret references, privacy gate, Jev preguntas tipadas (intención+sentimiento), evaluar corpus sintético en español (ironía, negación, puntuaciones contradictorias, quejas, prompt injection), escoger proveedores candidatos por función con métricas reales. Diseñar BFF de paneles, admin RBAC central, modelo de datos y procesos. Entregar decisión GO/NO-GO de proveedores y riesgos.

**F2 — AI Core + Engineering Console.** Infra de adapters con pruebas, routing granular dinámico, prompt studio, evaluación y rollout/canary/rollback, seguridad, registro de uso, coste, trazabilidad. Probar en navegador real desde el entorno local, con rutas sintéticas y modelos verdaderos solo si credenciales/autorización disponibles. Demostrar configuración sin cambiar código ni redeploy.

**F3 — Brand Studio, asistente y creación/edición web visual.** Entregar memoria aprobada, herramientas de estado permitidas, primera página con modelo potente, editor económico para cambios simples y escalamiento a complejo, generación/optimización de imágenes, publicación real local + historial y restauración. UX responsive de calidad revisada visualmente.

**F4 — social y atención con Jev.** Facebook publicaciones completas e imágenes + calendario + scheduler; comentario Facebook y reseña Google clasificados Jev; respuestas generadas y automáticas por consentimiento, pendientes para humano; una sola bandeja/ledger entre Reputation y Engagement. E2E real de proveedores cuando haya acceso; simulación etiquetada mientras tanto.

**F5 — plataforma central + campañas + insights.** MainSpot Administration, soporte, métricas financieras/IA; plan de campañas y assets, presupuesto/consentimiento, conexiones/Ads solo si autorizadas; insights grounded con periodo y evidencia; validación UX de micronegocios.

**F6 — hardening y auditoría E2E final.** Suite completa: tests, seguridad, navegador, visual, integraciones reales, caos controlado, costos/latencia/eficacia, retención, recuperación y GO/NO-GO por capacidad. Si existe bloqueo externo, publicar todo lo independiente y reporte exacto de lo no verificado, NO fingir cierre global.

Checkpoint por fase: source + tests + docs + evidencia sanitizada + commit + push sin force + issues actualizadas + evaluación y límites. No pedir aprobación intermedia para decisiones puramente reversibles de ingeniería dentro de esta autorización; **sí** elevar a dueño/HDC decisiones canónicas, transferencias de datos reales, gasto externo, cambios disruptivos y publicación a terceros.

## 9. Matriz mínima E2E (obligatoria)

| ID | Journey / aserción | Evidencia exigida |
|---|---|---|
| E01 | Negocio invitado configura Brand Studio, mismo asistente en panel | Browser + BD + contexto correcto |
| E02 | Jev primario clasifica intención y sentimiento, incluye ironía/negación/mixto | API TypeSafe auténtica con datos autorizados + eval set; si no, BLOCKED_EXTERNAL (mocks no cuentan) |
| E03 | Roles separados: owner, platform-admin y engineer | 200/403/tenant isolation en API y browser |
| E04 | Engineer versiona prompt, compara modelos, activa canary y rollback | Browser + read-back config + execution trace |
| E05 | Página inicial IA con imágenes y diseño diferencial por negocio | Modelo auténtico + screenshots 360/768/1440 + review visual/a11y |
| E06 | Cambio simple usa ruta económica y complejo usa otra; no edita extras | Trace model/version + diffs + métricas de calidad |
| E07 | Preview/aprobación/versiones/restaurar v1→v3/publicar HTTPS | Browser + SSL verificado + HTML servido + BD |
| E08 | Facebook texto/emojis/imagen aprobado y programado | Meta real ID/read-back; sinon BLOQUEADO_EXTERNO |
| E09 | Comentario Facebook simple auto consentido, queja a humano | Evento auténtico, decisión y read-back externo |
| E10 | Reseña Google con puntuación baja notifica y genera propuesta sin review gating | Ubicación verificada, respuesta/read-back real o bloqueo |
| E11 | Asistente responde sobre estado de cuenta sin inventar ni cruzar tenants | LLM real + tools/read-back + pruebas negativas |
| E12 | Campaña genera brief y borradores, no gasta sin confirmación | UI + contrato API + rechazo de gasto no autorizado |
| E13 | Imagen creada, ALT/licencia/asset guardado y disponible web/social | Fichero verificable + metadata + vista previa |
| E14 | Fallos: reentrega, reinicio de worker, timeout y resultado incierto | DB/cola/audit, sin doble publicación/decisión interna |
| E15 | Cuotas/tokens/imágenes/costo/latencia y techo duro por tenant | Métricas con procedencia + bloqueo por budget |
| E16 | Prompt injection/secret leakage/SSRF/XSS/PII y RBAC | Suite adversarial, negativas fail-closed |
| E17 | Plataforma admin ve salud/consumo sin suplantar usuarios | UI/API auditadas y MFA/step-up según riesgo |
| E18 | Prompt y modelo activos estables durante un job mientras cambia routing | Prueba de version pin y rollback concurrente |
| E19 | Calidad: publicaciones útiles, respuestas correctas y diseños distintivos | Rúbrica humana documentada + muestras e iteraciones |
| E20 | Mobile UX propietario: alta → primera web → post → caso de atención | Browser real 360–414px y desktop; sin jerga ni pasos técnicos |

Definir antes de implementar las **metas cuantitativas** de calidad, tasa de éxito, coste por artefacto, latencia P50/P95, accesibilidad, satisfacción y riesgo por use case a partir de baseline medido. No inventar SLOs o afirmar que 100% de tests automatizados = calidad visual.

Estado por caso: NOT_STARTED, IMPLEMENTED, SIMULATED_TESTED, LOCAL_REAL_VERIFIED, EXTERNAL_REAL_VERIFIED, BLOCKED_EXTERNAL, FAILED. Reportar el estado por **journey y proveedor**, no una sola etiqueta global.

## 10. Entregables concretos

1. Canon funcional y técnico coherentes, trazabilidad requisitos → modelos → herramientas → riesgos → tests y bitácora de decisiones pendientes.
2. Pantallas y APIs reales de Business Panel ampliado, MainSpot Administration y MainSpot Engineering Console.
3. Versionado inmutable de prompts y routing, Jev ampliado, memoria de marca, adapters, asset library, generation jobs, usage ledger y monitoreo.
4. Publicaciones integradas texto+imagen, sitios web generativos editables con preview y restore, engagement auto con permiso, chatbot grounded y campañas planeadas.
5. Matriz E2E E01–E20, logs reproducibles, capturas visuales, métricas de costo/latencia y fuentes de accesos autorizados sin mostrar secretos.
6. Guía de operación, onboarding técnico de proveedores, rollback, respuesta a incidentes y GO/NO-GO explícito; issues #6/#8 quedan separadas hasta cerrar sus propios bloqueos.
7. Commits acotados con nombres claros, push seguro a rama definida, issue #9 actualizado con enlaces exactos y SHA. Ningún archivo de claves ni tokens en Git.

**Criterio de término:** todas las capacidades implementables sin credenciales externas verificadas localmente con modelos reales donde estén autorizados; todo conector externo marcado EXTERNAL_REAL_VERIFIED solo después de operación real y read-back con cuenta autorizada; bloqueos nombrados con responsable, requisito exacto y prueba pendiente. El producto completo es NO-GO producción mientras permanezcan riesgos/gates críticos o integraciones esenciales sin verificar.

## 11. Referencias fuente

- Issue padre: https://github.com/hachxaan/mainspot-platform/issues/9
- Handoff local anterior: https://github.com/hachxaan/mainspot-platform/blob/69ab1db/docs/handoffs/e2e-parallel-2026-10-29/HANDOFF-2-RESULTS.md
- Infra: https://github.com/hachxaan/mainspot-platform/issues/8
- Integraciones: https://github.com/hachxaan/mainspot-platform/issues/6
- Jev: src/conversation/jev-classifier.ts; src/jev/client.ts; .canonflow/decision-records/DEC-0019.md y DEC-0032.md
- Web: src/website/template.ts, edit-mapper.ts, site-proposals.ts
- Atención: src/engagement/classifier.ts, service.ts; src/reputation/engine.ts
- Social: src/social/service.ts, scheduler.ts
- RBAC y panel: src/rbac/matrix.ts, src/api/routes.ts, src/web/panel/
- Visión original: reunión/luz de ideas 2026-06-04 (micronegocios, un asistente, redes, web, atención y calificaciones) y decisiones del propietario 2026-10-30
- TypeSafe: https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Política Google GBP: https://developers.google.com/my-business/content/policies
- Política Google reviews: https://support.google.com/business/answer/7400114

**No trasladar contenido íntegro de la reunión, datos personales ni credenciales al repo; se referencia la visión de producto, no la transcripción privada.**
