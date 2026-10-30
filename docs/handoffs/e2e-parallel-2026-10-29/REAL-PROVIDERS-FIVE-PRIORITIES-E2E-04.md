# MAINSPOT — DEV-E2E-04: cinco prioridades integradas, proveedores REALES y dominios SOLO locales

**Mandato:** ejecutar código, pruebas, depuración, evidencia y push; no quedarse en diseño. **Actualización 30-oct-2026: Telegram por webhook real/KVM-WireGuard, NO long polling.**
**Producto:** MainSpot · **Rama de integración:** feat/canonflow-implementation
**Alcance:** DESARROLLO/PILOTO CONTROLADO; nada de puesta pública en producción.
**Autoridad de ingeniería:** el propietario delegó decisiones de implementación y UX, sin HDC ni aprobaciones de desarrollo intermedias. Documentar decisiones brevemente en DECISION-LOG.md. Mantener las autorizaciones de los titulares de cuentas externas y las protecciones del producto.

## 0. Cambio fundamental frente a DEV-E2E-03

Se considera completada la unión de la interfaz de Claude con Express + PostgreSQL + worker; no rehacerla. Los informes de referencia son commit ed2f72b (funcionalidad), 6ce9594 (evidencias) y DEV-E2E-03 (42/42 pruebas de navegador; npm test 244/244, sobre proveedores SIMULADOS). **Estos números son baseline reportado, NO validación de servicios reales.**

**Instrucción nueva del propietario:** integrar **Google Business Profile, Facebook y Telegram con credenciales REALES y operaciones verificadas**. **La única excepción de alcance externo son los dominios de páginas públicas**: la publicación de sitios web de clientes se realizará realmente en la infraestructura local bajo HTTPS confiable, pero sin DNS público ni publicar sitios en Internet.

- URL oficial del panel: https://app.mainspot.local.io
- Proxy HTTPS local en LXC webserver, IP 10.209.99.101. El bootstrap inicial del dominio principal pertenece a otro trabajo ya encargado. **No volver a inspeccionar/provisionar preventivamente ese dominio ni regenerar certificados.** Leer .omp/RULES.md y .omp/AGENTS.md.
- Sitios de clientes: propuesta pragmática de hostname local único https://{slug}.mainspot.local.io, servido por el LXC en la misma red, con certificado local confiable y contenido real de la versión publicada. El slug y su unicidad se resuelven por los mecanismos actuales. **No confundir estos hostnames con DNS público**.
- /etc/hosts NO admite wildcard: para cada hostname de cliente crear una entrada explícita en el HOST que ejecuta las pruebas (o, si ya existe un resolvedor DNS local compatible, reutilizarlo sin reinstalar infraestructura). El alta de CADA sitio es una provisión de negocio, distinta del bootstrap ÚNICO de app.mainspot.local.io.
- En caso de que el equipo de pruebas incluya otros dispositivos, la resolución y la CA deben estar preparadas allí también; no afirmar que un hostname de hosts resuelve fuera de ese equipo.
- Nada de proveedor simulado como prueba de una integración que exige real; el modo simulado puede conservarse para unit/regresiones offline, pero **REAL E2E exige network calls auténticos, credenciales válidas, recursos reales autorizados, read-back y evidencia redactada**.

## 1. Regla de ejecución sin bloqueos

1. SOL MAIN / Opus ejecuta de punta a punta, corrige, hace commit/push y verifica. No crear HDC, QS ni ANS para ingeniería de esta tanda; no pedir decisión visual/técnica que pueda resolverse con las políticas actuales y buenas prácticas.
2. **No inventar ni solicitar que se escriban secretos en prompts, commits, logs, issues o transcripciones.** Usar variables/secret store local protegido, nunca contraseñas en pruebas ni adjuntos. Proveer un checklist de aprovisionamiento seguro por proveedor.
3. El agente puede preparar conectores, seguridad, OAuth y pruebas sin detenerse por credenciales externas que no estén disponibles. **Pero NO marcar REAL PASS si el proveedor no autorizó la operación o faltan tokens/permisos.** Registrar por servicio: implemented, connected, real_verified, blocked_external, failed, no_support. Continuar el trabajo de las demás prioridades. El cierre del alcance solicitado exige resultados reales; cualquier bloqueo externo es entrega parcial honesta, no éxito global.
4. No activar automatizaciones que publiquen indiscriminadamente en negocios de terceros. Las pruebas con servicios reales requieren cuentas/fichas/páginas administradas o autorizadas, consentimiento específico y objetos de prueba controlados. Evitar efectos irreversibles y acciones en negocios reales sin autorización del titular. No publicar anuncios que gasten dinero ni habilitar campañas de pago por default.
5. Aislamiento tenant, RBAC, ledger/auditoría, idempotencia, políticas de publicación, protección de datos, cuotas y canon histórico permanecen. Registrar reconciliaciones normativas pendientes sin detener la construcción técnica; no sobrescribir DEC.
6. No tocar Gate 7, QS-0015, infraestructura de respaldos, Garage/KVM4, servicios de terceros ajenos o producción. No reescribir frontend Claude; extender lo mínimo necesario en src/web/panel.
7. Seguir desarrollando con el dominio HTTPS local ya configurado. No usar localhost o bypass de proxy como origen del navegador E2E, ni ignoreHTTPSErrors=true.

## 2. Prioridad P1 + P4 — integraciones externas REALES + publicaciones automáticas

El anterior punto de “publicador automático de Facebook” y el punto de “conectar proveedores” se ejecutan como UN SOLO BLOQUE. Este bloque cubre Google, Facebook y Telegram — **lectura y escritura reales**, no solo despliegue de adapters.

### 2A. Google Business Profile REAL

Estado inicial: src/reputation/google.ts contiene endpoints tentativos y compara tenantId con accountId, lo que NO es válido como identificación de un recurso Google. src/google/profile.ts y la ficha local son simulados. No tratar GOOGLE_GBP_TOKEN global como credencial reutilizable arbitrariamente para todos los negocios.

Implementar:
- Conexión OAuth 2.0 del dueño/administrador autorizado con scope necesario para Business Profile; intercambio del code en servidor, state/PKCE cuando corresponda, refresh/offline access, almacenamiento cifrado con permisos tenant-scoped y revocación/desconexión. Para una prueba local controlada, admitir aprovisionamiento seguro de tokens propios de prueba cuando el OAuth interactivo del dominio local no sea viable; NO fingir que esto equivale al onboarding OAuth de SaaS público.
- Descubrimiento de cuentas y ubicaciones realmente accesibles con la cuenta Google conectada. Persistir vínculo tenant → Google account/location ID reales; evitar emplear tenant_id como identificador de location.
- Business Profile Account Management / Business Information para datos autorizados de la ficha: leer; guardar y verificar con nueva lectura los cambios de teléfono, horario, website y demás campos que el proveedor permita. Si un campo es restringido, queda pending/unsupported con explicación, no simulated_synced.
- Reviews API Google My Business v4: listar paginado y por actualización, obtener reseñas verificadas, reconocer respuestas previas y realizar updateReply sobre una reseña de prueba autorizada con lectura posterior. Usar host correcto por API; el endpoint de Reviews no es el de Business Information.
- Alimentar el worker actual con ingesta incremental, deduplicación, política opt-in de respuestas seguras, umbral, escalamiento humano, tres propuestas, registro de versión de política, reconciliación de respuestas realizadas fuera de MainSpot.
- Validar la política de Google: consentimiento específico previo antes de acciones automáticas o respuestas a reseñas; no manipular opiniones ni dirigir selectivamente reseñas positivas. **Revisar las condiciones de almacenamiento de contenido de Business Profile, incl. límite temporal de hasta 30 días**, evitar retención indefinida de datos crudos de Google en engagement_case/auditoría/exportación; separar hechos operativos mínimos de contenido licenciado, implementar purga conforme a reglas vigentes.
- Rate limits y quota: 429/backoff/Retry-After, paginación, token refresh, revocación, errores 401/403/quota0, cuenta no verificada y reconexión. Fallo en Google NO borra casos ni responde en modo simulado.
- GOOGLE READY requiere: aprobación de acceso a APIs a nivel de proyecto (si no la hay), OAuth válido, ficha verificada, permisos reales, lectura de ficha/reseña y respuesta real de prueba verificable. Solicitud de acceso, propiedad y decisiones de cuenta corresponden al dueño del proyecto/cuenta y no pueden autootorgarse.

Docs Google: 
- https://developers.google.com/my-business/content/prereqs
- https://developers.google.com/my-business/content/implement-oauth
- https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews
- https://developers.google.com/my-business/ref_overview
- https://developers.google.com/my-business/content/policies

**Observación externa:** la elegibilidad para acceso API GBP puede exigir website público legítimo de la entidad solicitante, perfil verificado activo y otros requisitos. El dominio de laboratorio app.mainspot.local.io y los dominios de clientes NO son website público elegible para esa solicitud. Documentar el bloqueo externo específico si ocurre, sin crear un dominio público por cuenta propia.

### 2B. Facebook Pages / Meta Graph API REAL

Estado inicial: src/social/meta.ts tiene rutas tentativas, confunde tenantId con Page ID y usa un token global; src/engagement/providers.ts no certifica comentario/reply reales.

Implementar:
- Conexión de un usuario/página realmente administrados: token de usuario, descubrimiento de Pages autorizadas y Page access token propio, vínculo tenant → Page ID, permisos/tareas efectivas; almacenamiento cifrado tenant-scoped, renovación/expiración/revocación y reautorización. Revisar la versión actual soportada de Graph API en la documentación de Meta y fijarla por configuración. NO presuponer que v21.0 o cualquier versión hardcodeada sigue vigente.
- Validar permisos específicos para listar Pages, leer interacciones/comentarios, crear posts, responder/moderar y, si procede, anuncios básicos. Solicitar solo lo necesario; respetar App Review, modo Development y cuentas tester/admin.
- Publicaciones reales de página: texto, y media/link si realmente soportado; obtener id externo, consultar post para confirmar que existe y reflejar published solo después de acuse verificado. Los fallos no producen falso published.
- Comentarios reales de las publicaciones del tenant: leer incremental/paginado, cursor de proveedor y deduplicación por Page/Post/comment externo. Responder al comentario autorizado, confirmar read-back y no duplicar en reintentos. Priorizar polling autorizado de comentarios en desarrollo local cuando webhooks exijan callback público; no abrir túnel público ni cambiar DNS sin permiso explícito. Si Meta no ofrece lectura polling conforme a permisos reales de la app, marcar dependencia externa, no inventar.
- **Scheduler obligatorio sin tick manual**: pequeño worker persistente que procese publicaciones autorizadas vencidas automáticamente (incl. tras crash/restart), en UTC y zona horaria configurable para el usuario; solo publicaciones ya aprobadas. Transacción/claim, idempotencia, auditoría, reintentos acotados con backoff, reconocimiento del id externo y protección contra duplicados cuando Meta no proporcione idempotencia nativa. En estado incierto tras timeout de escritura, reconciliar consultando proveedor o requerir revisión humana; **no** reenviar ciegamente.
- Ads básicos incluidos en el canon INC-005/DEC-017: verificar acceso a cuenta publicitaria y permisos necesarios, implementar/validar el alcance BÁSICO aprobado si hay cuenta autorizada y configuración, sin presupuestos no consentidos ni cargos inadvertidos. Si no existen credenciales/permisos/ad account, marcar blocked_external separado de publicaciones Pages. Instagram y campañas avanzadas siguen fuera.
- Teléfono del canal facebook: conservar configuración propia. Solo anunciar actualización real del teléfono público de Facebook cuando Graph API/permiso/campo concreto lo soporte y se haya confirmado por read-back; de otro modo indicar dato interno pendiente de sincronizar y no mentir al propietario.
- Manejo de tokens inválidos, permisos perdidos, errores de Graph, cuotas/rate, publicaciones duplicadas, post/comment eliminado, cambios de rol Page, horario de verano y ejecución concurrente.

Referencia de Meta: https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api ; consola y docs oficiales de Meta: https://developers.facebook.com/docs/ .

**META READY requiere:** una Page administrada autorizada, permisos reales, post publicado desde MainSpot y comprobado en Meta, un comentario real recibido y respuesta enviada/comprobada, scheduler reiniciado y sin duplicados. Ads básicos, si dentro del alcance habilitado, con estado de validación propio; nunca ejecutar gasto real sin consentimiento específico.

### 2C. Telegram Bot REAL — webhook público mediante KVM y WireGuard PRIVADO a Starlink

**Decisión actual (30-oct-2026): WEBHOOK REAL; queda anulada la propuesta anterior de getUpdates/long polling.** No crear ni ejecutar un poller mientras exista webhook.

**Infraestructura instalada en KVM según el reporte del propietario (NO reinstalarla):** HTTPS POST **https://tg.mainspot.io/telegram/webhook** → webserver público del KVM **89.116.170.99** (TLS Let's Encrypt, allowlist IP Telegram, solo POST) → LXC wireguard-telegram **10.13.247.77** → nginx privado / wg0 **10.77.0.1:8080** → túnel WireGuard UDP/51820 → peer Linux Starlink **10.77.0.2** → receptor HTTP **10.77.0.2:8080** → MainSpot Express **POST /api/telegram/webhook**. **Hay dos rutas diferentes**: el receptor Starlink debe reescribir /telegram/webhook a /api/telegram/webhook y preservar JSON, método POST y X-Telegram-Bot-Api-Secret-Token.

**Dependencia previa obligatoria:** completar y verificar el [handoff Starlink](STARLINK-WIREGUARD-TELEGRAM-CLIENT.md), [issue #8](https://github.com/hachxaan/mainspot-platform/issues/8). El 502 público actual se atribuye al peer Starlink ausente, NO prueba entrega real. Pendientes: handshake Starlink-KVM, túnel, recepción HTTP, persistencia systemd sin OMP, registro webhook, entrega real y getWebhookInfo. El KVM README operativo reside en ~/wireguard-telegram/README.md **del KVM**. Las pruebas del peer temporal no sustituyen la prueba Starlink. No volver a provisionar KVM ni dominio principal del panel.

**Fronteras:** el panel sigue en **https://app.mainspot.local.io**, solo local. El dominio público **tg.mainspot.io** es una excepción autorizada ÚNICAMENTE como entrada HTTPS de Telegram, NO para publicar sitios de clientes ni abrir panel/API en Internet.

**Implementar en MainSpot:**
- Token real de bot en secret store/archivo local protegido. Verificar identidad del bot con getMe. Mantener TELEGRAM_WEBHOOK_SECRET no vacío y secreto en modo real incluso si APP_ENV=development; actualmente src/api/engagement-routes.ts permite omitir secret fuera de producción, y eso se debe endurecer. La comparación actual timingSafeEqual es apropiada. Secret incorrecto → rechazo (el backend actual usa 401), sin procesar ni filtrar información. Limitación de métodos/rutas, payload, TLS y origen mediante proxy/túnel.
- Persistir inbox por identificador real del bot y **update_id único**, con claim/transacción para aceptar y deduplicar updates tras reintentos, reinicios o concurrencia. La construcción de requestId desde update_id NO es suficiente. Responder HTTP 2xx únicamente tras aceptación/encolado durable (y control de dedupe), NO cuando se perdió el update. Si app/DB fallan antes de persistir, responder 5xx; Telegram puede reintentar. Consumidor y outbox de avisos/respuestas idempotentes; si el proveedor carece de semántica exactly-once, reconciliar estados o declarar entrega incierta, no emitir duplicados ciegamente.
- Reutilizar TelegramLinkService.handleUpdate y RBAC: /start con código, /aprobar, /rechazar, doble confirmación cuando corresponda; vincular chat_id a user/tenant. No usar teléfono público como destino de Telegram. sendMessage y llegada del comando deben ser de Telegram auténtico; la decisión debe verse en panel/PostgreSQL una sola vez.
- **Solo tras READY_FOR_WEBHOOK_REGISTRATION del cliente Starlink**, comprobar getWebhookInfo actual, bot autorizado/dedicado y registrar setWebhook URL exacta **https://tg.mainspot.io/telegram/webhook**, secret_token válido, allowed_updates limitados a tipos utilizados, drop_pending_updates=false, inicialmente max_connections=1 para diagnóstico y protección de carreras. No sobrescribir un webhook de un bot de producción o ajeno; no ejecutar deleteWebhook ni purgar actualizaciones pendientes por defecto. getUpdates queda deshabilitado con webhook.
- Probar getWebhookInfo REAL (URL, pending_update_count, last_error_message y timestamp), /start enviado realmente desde Telegram, chat vinculado, alerta real, respuesta/decisión real en la bandeja y confirmación tras reinicio; comprobar comportamiento ante fallo WG (502), backend caído (5xx), token inválido, webhook secret inválido, duplicados/retries y bot bloqueado. Si getWebhookInfo revela errores, corregirlos antes del cierre.
- Mantener simulador únicamente para regresión offline. **No llamar REAL_VERIFIED a una entrega de prueba dentro del túnel ni a una simulación de Telegram.**

**Telegram READY / REAL_VERIFIED exige simultáneamente:** (1) handshake persistente Starlink-KVM y receptor :8080, (2) getMe/setWebhook/getWebhookInfo auténticos, (3) actualización auténtica que atraviese la URL pública hacia la aplicación, (4) aviso real sendMessage recibido y (5) decisión real persistida y visible en panel, sin duplicados tras retries/restart.

Referencias oficiales: https://core.telegram.org/bots/api y https://core.telegram.org/bots/webhooks .

## 3. Prioridad P2 — recuperación de contraseña REAL

No basta añadir un botón o resetear contraseñas vía CLI.

- UI existente: «¿Olvidaste tu contraseña?» → solicitud por correo → link token un solo uso → nueva contraseña → login. El origen de link es https://app.mainspot.local.io y el equipo de prueba resuelve hosts y confía en la CA. Nunca poner token ni email en logs, URL pública de issue o evidencia.
- Servicio real de envío de correo configurable (SMTP o API transaccional con credenciales legítimas), conexión protegida; verificar en una cuenta de prueba controlada recepción del correo y que el link funciona. No inventar entrega si falta proveedor/credencial; marcar blocked_external y continuar otras prioridades.
- Seguridad: respuesta neutra incluso para correo inexistente, rate limit por IP/cuenta sin revelar existencia; token aleatorio fuerte **hasheado en BD**, TTL corto (ej. 30 min), consume una sola vez de forma atómica, contraseña hasheada según convención del repo, revocar sesiones activas tras reset, sin aceptar reutilización ni fuerza bruta.
- Sin tenant_id en UI; si el login pertenece a más de un negocio resolver identidad con mecanismo que no revele pertenencia ni permita restablecer equivocadamente otra cuenta. Verificar permisos/identidad.
- Probar caducidad, reutilización, dos solicitudes, carreras, sesión antigua invalidada, sin correo, rate limit, XSS y CSRF si aplica.
- No guardar contraseñas en memoria persistente del navegador ni incluirlas en capturas.

## 4. Prioridad P3 — restauración de versiones de Página Web

- Ampliar el historial de versiones persistidas de website_content. Mostrar versiones de la página y acción «Restaurar esta versión».
- No reescribir ni borrar historial anterior. **Restaurar = generar una nueva versión** con contenido de la seleccionada, autor/referencia, diff, timestamp, y mantener audit trail.
- Vista previa «actual vs versión solicitada», confirmación y aprobación humana según roles del canon. No aplicar cambios al sitio en vivo antes de aprobar.
- Protección contra versiones obsoletas/concurrentes: optimistic concurrency o guard equivalente; repetición idempotente sin nueva versión duplicada; rollback de publicación fallida sin dejar estado ficticio de éxito.
- **Dominio del sitio REAL pero LOCAL:** al publicar o restaurar, generar y servir la versión aprobada en un vhost/proxy HTTPS del LXC, hostname local por negocio. Crear solo la provisión específica del nuevo sitio cuando falte (hosts + CA/site cert + routing/renderer) de forma idempotente; no tocar el bootstrap ya completado de app.mainspot.local.io. El certificado de host local debe ser válido; nunca publicar en DNS externo.
- No asumir que las entradas /etc/hosts aceptan wildcard. Proveer/automatizar registro concreto por sitio y limpieza controlada solo cuando corresponda, sin borrar de forma destructiva otras entradas.
- Probar navegador real por el hostname del sitio: primera publicación, contenido y teléfono del canal, restauración A→B→A como versión C, refresh/restart, concurrencia, 404 no publicado, HTTPS, tenant isolation y ausencia de side effects DNS público.
- Priorizar mínimo cambio al publicador/repository y seguir usando el pipeline actual de preview y aprobación.

## 5. Prioridad P5 — hardening pre-piloto y criterio GO/NO-GO

**No dar GO por 244/244 tests simulados**. Ejecutar un pase de seguridad y operaciones con evidencia real de endpoints externos, conservando controles actuales:

A. **Seguridad**
- Secretos en .env/secret store con permisos, cifrados en repositorio DB para tokens OAuth/refresh/page; no exponer a frontend, logs, errores HTTP, GitHub o backups sin protección. Rotación/revocación/desconexión por tenant.
- OAuth state/redirect allowlist, CSRF, trust proxy acotado a LXC, TLS verificado, session lifetime, revocación, protección XSS, rate limiting, CSRF donde aplique, minimización de PII, seguridad del contenido recibido (prompt injection/social engineering).
- Consentimiento expreso, versionado, revocable y scope limitado para respuestas automáticas de Google/Facebook; fail closed ante proveedor no verificado, policy absent, alta incertidumbre, contenido sensible o permisos insuficientes.
- Google: revisar retención de API Content y eliminar/anonimizar material según política vigente; tests para límites y export/tenant exit, sin retener indefinidamente texto de reseñas.
- RBAC/protección multi-tenant: un negocio NO puede acceder a tokens, Pages, locations, mensajes, números, casos ni posts de otro. No enumeración de cuentas ni emails.
- Privacidad/revocación de conectores Google y Meta, y gestión de datos relacionados conforme requisitos del proveedor.

B. **Resiliencia**
- Worker real de schedule y engagement sobreviven SIGKILL/restart y carreras; reconciliación no hace doble publicación.
- Timeouts, 429/backoff y límites de reintentos, observabilidad, métricas de conectores, health por proveedor sin filtrar secretos; fallback nunca convierte un fallo real en éxito simulado.
- Errores de auth/permiso distinguen usuario debe reconectar vs reintento; casos no se pierden.
- Migraciones aditivas y rollback probado donde sea viable; no destruir datos del negocio; backup/restore solo con mecanismos autorizados para entorno de test, NO tocar productor de backups existente.

C. **Evaluación de piloto**
- Reporte por capacidad: REAL VERIFIED / IMPLEMENTED NOT VERIFIED / BLOCKED EXTERNAL / SIMULATED REGRESSION / FAILED, con evidencia exacta, sin copiar claims de reportes antiguos como hechos actuales.
- Distinguir pruebas contra cuentas controladas de pruebas reales de clientes; no activar clientes ni flujos de reputación reales sin autorización del titular.
- Criterio para declarar piloto técnico listo: proveedores requeridos conectados y verificados, políticas de seguridad y respuestas, password reset, restore versions, scheduler, sitios con dominio local, E2E completo sin casos críticos/altos sin resolver.
- Si Google API approval/App Review de Meta u otros requisitos externos no están disponibles, NO-GO para comercializar esa función; el código puede quedar listo y testeado con mocks, pero el E2E REAL sigue bloqueado. Entregar checklist claro de requisitos que el propietario deberá completar legítimamente.

## 6. Dependencias externas y credenciales — trabajo autónomo, evidencia HONESTA

**El agente debe inspeccionar qué capacidades/credenciales efectivamente existen en el workspace SIN IMPRIMIR sus valores ni leer innecesariamente datos sensibles.** Nunca proporcionar secretos en chat.

Crear lista de prerequisitos con nombres de variables (no valores), estatus y paso oficial para obtenerlos. Separar:

- Google: proyecto Google Cloud con acceso Business Profile aprobado, OAuth Client ID/Secret, consent screen/scopes, refresh, cuenta/ubicación verificada autorizada. Google puede requerir sitio público legítimo para otorgar acceso; NO crear uno bajo la excepción de dominios locales.
- Meta: App ID/Secret, Page ID y Page token accesible con tasks/permisos apropiados, App Review cuando aplique, y cuenta publicitaria autorizada para Ads básicos. OAuth redirect puede requerir dominio públicamente validado; en laboratorio local se permite prueba con credenciales de cuentas controladas o mecanismo oficialmente permitido, sin saltarse requisitos del proveedor.
- Telegram: BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET protegidos, peer/receptor Starlink persistentes, registro setWebhook sobre tg.mainspot.io y pruebas de mensaje/decisión reales; NO polling.
- Email reset: SMTP/API transaccional y buzón de prueba controlados.
- Local LXC: el bootstrap app.mainspot.local.io ocurre en otra tarea; para sitios de clientes usar el LXC existente, con privilegios mínimos para provisionar cada hostname y CA local.

**No descargar ni usar recursos protegidos sin autorización legítima.** Si un paso requiere que el titular complete OAuth, 2FA, verificación de propiedad, un permiso de plataforma, o aceptar términos, dejar instrucciones exactas y continuar el resto. No reportar E2E REAL antes de completarlo. No inferir que el proyecto tiene acceso a cuentas por mera existencia de variables.

## 7. Plan de ejecución técnico (puede paralelizarse sin sobreingeniería)

1. Sync rama/HEAD actual con cuidado a otras tareas, leer .omp/RULES.md y fuentes del repo. Configuración del dominio principal es trabajo ajeno EN CURSO: NO modificarla ni esperar si ya está utilizable. Desarrollar proveedor/worker/tests de manera independiente mientras termina.
2. Inventariar contratos, migraciones y tests reales; hacer cambios incrementales aditivos. Implementar conexión por tenant, secretos seguros, credenciales y status providers con feature flags no disruptivas.
3. Construir Google y Facebook sobre código existente: adapter real, permisos, refresh, read/write y case pipeline. Añadir scheduler Facebook automático con seguridad de publicación.
4. Completar primero cliente persistente Starlink (issue #8), luego Telegram real por webhook HTTPS tg.mainspot.io vía WireGuard; inbox/outbox deduplicados, setWebhook/getWebhookInfo y pruebas auténticas de chat/decisión.
5. Implementar correo/reset de contraseñas con proveedor real y pruebas de entrega.
6. Restauración de versiones; publicación real local de sitios con URL individual por cliente mediante LXC.
7. Integrar pantallas existentes con estados reales y estados de error (connected / needs_authorization / permission_missing / disconnected / failed / provider_unavailable), sin rediseñar.
8. Tests unit/integration con mocks para fallos + pruebas reales de cada proveedor cuando sus credenciales están presentes, con datasets/cuentas autorizados.
9. E2E navegador sobre https://app.mainspot.local.io (nunca localhost), E2E sitio cliente local HTTPS, workers persistentes sin navegador, pruebas multi-tenant y reinicio.
10. npm test total, browser E2E, evidencia saneada, commit/push no force, comentario issue y resumen con matriz de cierre; no dejar decisiones técnicas normales bloqueadas esperando HDC.

## 8. Escenarios de aceptación obligatorios

| ID | Escenario | Éxito verificable |
|---|---|---|
| REAL-G-01 | Vincular cuenta GBP autorizada | Cuenta/location verdaderos, refresh y estado persistente |
| REAL-G-02 | Leer reseñas y enviar respuesta a prueba | API real, read-back del proveedor y DB actualizada una vez |
| REAL-G-03 | Editar ficha/teléfono Google soportado | API real, estado read-back o unsupported honesto |
| REAL-M-01 | Vincular Page Meta y publicar post | ID real y post consultado en Graph |
| REAL-M-02 | Detectar comentario y responder bajo política | Comentario real, respuesta confirmada, sin duplicado |
| REAL-M-03 | Programar publicación aprobada y cerrar navegador | Se publica automáticamente a su hora sin tick manual, restart-safe |
| REAL-M-04 | Ads básicos autorizados (si hay acceso) | API real y lectura de resultado sin gasto no consentido; o blocked_external |
| REAL-T-01 | Peer Starlink persistente, getMe/setWebhook/getWebhookInfo y /start REAL vía URL pública | Bot real, update persistido una vez y chat vinculado al usuario/tenant |
| REAL-T-02 | Alerta y aprobación Telegram real por webhook | sendMessage recibido, decisión en PostgreSQL/panel, sin duplicados tras reintentos/reinicio |
| AUTH-RESET | Solicitar email, abrir link, cambiar contraseña | Correo realmente recibido, token single-use, revocación de sesión |
| WEB-RESTORE | Volver versión anterior con preview/aprobación | Nueva versión publicada, historial intacto, tenant-safe |
| WEB-LOCAL | Abrir cliente en hostname HTTPS local | vhost/CA/datos reales, sin DNS público y sin TLS bypass |
| SEC-01 | Negativo de roles/tenant/credenciales vencidas | 401/403/404 correctos, no filtración ni cross-tenant |
| SEC-02 | Caída/retry y confirmación de efecto externo | Sin dobles mensajes/posts, estados reconciliados |
| SEC-03 | Consentimiento revocado o ausente | Ninguna respuesta automática posterior |
| SEC-04 | Retención/PII/secretos/escapes | Auditoría sin tokens, purga Google conforme a política, XSS seguro |

**Validar tanto el primer ciclo como la reanudación tras crash, renovación de token y cambios de permisos.**

## 9. Entrega final requerida

- Rama, HEAD, commits, PR/issue.
- Comandos de ejecución y URL canónica https://app.mainspot.local.io, URLs de sitios de cliente locales creados realmente.
- Tests ejecutados y resultados exactos, separados por mock/simulado vs API REAL. Identificadores externos redactados y evidencia confirmatoria sin tokens.
- Matriz por Google (perfil + reseñas), Facebook (posts + comentarios + scheduler + Ads básicos), Telegram, email reset, website restore, seguridad.
- Evidencias de proveedor real cuando exista acceso; si alguna credencial/API no está disponible, detallar BLOCKED_EXTERNAL y el paso oficial necesario, no llamarlo PASS.
- Documentación de política de consentimiento, seguridad y retención.
- Un dictamen GO/NO-GO para **piloto técnico controlado**, no para producción general, con justificaciones.
- Guardar lecciones decisorias en DECISION-LOG.md sin crear HDC. Hacer commit/push y continuar cualquier trabajo implementable hasta cerrar todo lo disponible.

**Regla de cierre:** E2E con proveedores externos es REAL solo cuando hubo acceso legítimo, llamada auténtica, resultado verificado y efecto confirmado. Que el sistema conserve simuladores no convierte esos tests en certificación de proveedor real.
