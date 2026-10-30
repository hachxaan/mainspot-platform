# DEV-E2E-03 · Integrar frontend Claude Design con backend MainSpot

**Mandato:** SOL MAIN / agente local. **Entorno:** DESARROLLO. **Ejecución:** autónoma y E2E sin HDC ni aprobación intermedia, de acuerdo con OWNER-AUTHORIZATION.md. Rama feat/canonflow-implementation.

## 1. Estado de partida verificado

- Claude Design entregó prototipo UX/UI navegable en c27a930 (bitácora 67d930c): docs/ux/claude-design/deliverables/index.html y assets/**, SCREEN-MAP.md (DS-01..DS-17) y QA.md. Su estado vive en localStorage, con fixtures y simuladores; **no** es frontend conectado al backend.
- SOL MAIN entregó backend/API + UI temporal en d83be37 (evidencia evidence/e2e-dev-e2e-02.txt): 31 pasos E2E registrados sobre servidor Express/CLI/worker y PostgreSQL reales, con Google/Meta/Telegram simulados.
- Los informes son de **dos sistemas separados**. Falta una prueba del recorrido visual de Claude contra API y BD de SOL MAIN.
- La corrección e978f08 ya armonizó «cambia mi teléfono»: si hay configuración por integración, lleva a tarjeta Teléfonos de contacto y no edita por otro camino el teléfono de la web. **No reintroducir una segunda fuente de verdad**.
- **Defecto preexistente por resolver:** editar la página de un negocio sin client_website produce preview y al publicar falla 502. El alta no crea automáticamente la página. Presentar un paso «Crear mi página» que use el endpoint y respete cuota/permisos antes de editar/publicar.

## 2. Objetivo

Servir **el diseño visual de Claude Design** como frontend REAL y funcional de MainSpot en /panel (o ruta equivalente de la misma aplicación), con login e invitación reales, datos server-side, permisos y persistencia PostgreSQL. No reconstruir visualmente el diseño ni crear otro prototipo. No agregar frameworks SPA, microservicios ni rehacer servicios existentes. Reutilizar assets, CSS, fuentes, iconos y estructura JS que ya existen; crear adaptadores pequeños.

**Propiedad:** no modificar docs/ux/claude-design/**, que continúa como prototipo de referencia. Adaptar/copiar archivos al directorio del runtime integrado; evitar alterar el canon aprobado. No usar MS.S/localStorage como fuente de verdad en runtime real. Puede conservarse localStorage solo para preferencias visuales no sensibles.

## 3. Mapa de integración (confirmar payloads/roles leyendo el código)

Todas las rutas protegidas están bajo /api/backoffice. Consultar src/api/server.ts, src/api/*-routes.ts, src/contact/phones.ts y DECISION-LOG.md antes de conectar vistas. Este mapa no pretende ser definición completa de DTO.

| Pantalla | API existente | Criterio |
|---|---|---|
| Invitación / login | POST /api/auth/invitation, POST /api/auth/invitation/accept, POST /api/auth/login, GET /api/backoffice/me | invitación one-use neutral; correo/contraseña sin tenant_id visible; cuidar token en fragmento |
| Dashboard / negocio / plan | GET /api/backoffice/me, GET /api/backoffice/subscriptions/entitlements, recursos de actividad existentes | hidratar desde BD, no fixtures; roles/restricciones desde backend |
| Teléfonos | GET /contact/phones, PUT /contact/phones/primary, PUT /contact/phones/integrations/:channel | 3 overrides independientes; mapeo **UI google = API google_business_profile**; modo own/other; E.164 y 3 valores distintos |
| Página web | POST/GET /website, POST /conversation/messages, GET /conversation/proposals, POST /conversation/proposals/:id/confirm|approve|reject, /preview/:token | detectar sitio ausente y crearlo; cambio + preview + decisión + publicación coherente |
| Google Maps/ficha | GET/PUT /google/profile | ficha persistida en backend y sincronización simulada explícita; teléfono solo de Google |
| Facebook | GET/POST /social/posts, POST /social/posts/:id/schedule|approve|reject, POST /social/process-due | posts/programación/preview/approval; comentarios vinculados al agente |
| Agente | GET /engagement/cases, GET /engagement/cases/:id, POST /engagement/cases/:id/drafts/:index, POST /engagement/cases/:id/approve|reject, GET/PUT /engagement/policies | mapear status visual a state API, source visual a origin API; backend autoridad de estado/política/consentimiento y auditoría |
| Telegram | GET/DELETE /telegram/link, POST /telegram/link-code | mismo caso y decisión entre panel/Telegram; teléfono público NO es chat Telegram |
| Simulador | /dev/simulator/* | solo visible/disponible en DEV; ninguna simulación se anuncia como entrega real |

**IMPORTANTE:** los endpoints anteriores que no empiezan con /api/auth deben llevar el prefijo /api/backoffice. No inventar rutas ni campos: revisar el código y adaptar. La fuente final de autorización es el backend; esconder botones no sustituye RBAC.

## 4. Requisitos específicos que NO deben perderse

1. **TEL-01..04:** website, google_business_profile y facebook con modo own u other; cada other_phone es independiente; cambiar solo Facebook no cambia los otros; modificar primario solo cambia efectivos own; other→own→other conserva override. País/prefijo; errores de servidor y sin cruzar tenants.
2. **Google:** ficha básica, horarios, ubicación, teléfono propio; reseñas con agente; indicar sin conexión real mientras la API esté simulada.
3. **Facebook:** publicar/programar con aprobación, comentarios bajo el post, casos y respuestas simuladas del agente, teléfono propio. Instagram y campañas avanzadas fuera.
4. **Atención:** clasificación por worker sin navegador, respuestas automáticas **solo** para política opt-in explícita del dueño del negocio y casos seguros; excepciones con hasta tres opciones editables, decisión humana desde panel o Telegram; estado unificado tras reload, reinicio y dos sesiones, sin duplicados.
5. **Página:** nueva cuenta sin client_website debe crearla antes de publicar; cambios vía chat/preview/aprobación; no un 502 por sitio inexistente.
6. **Login:** invitación usada/caducada neutra; login real sin tenant_id; no contraseñas en localStorage; recuperar sesión/estado en carga nueva sin inventar cuenta/demo.
7. **UX:** diseño móvil 360, 390, 414; escritorio 1024–1279 (pendiente del reporte Claude), 1280 y 1440; no barras horizontales; teclado/contraste. Mantener identidad visual, no reformular diseño.
8. **Seguridad:** control real RBAC administración/operación/lectura, rate-limit, cookies/token según mecanismo existente, XSS safe, CSP de misma procedencia si posible, fallos 401/403/404/409/429 informativos sin filtrar datos de otros tenants.
9. **Google/Meta/Telegram reales:** no tocar ni usar credenciales reales; todas las pruebas de proveedores son SIMULADAS. Worker/HTTP/PG en pruebas sí deben ser reales.

## 5. Ruta de ejecución sin esperar aprobaciones

1. Integrar shell/assets de Claude en Express, sin modificar el prototipo fuente.
2. Añadir cliente API liviano y manejo de sesión/errores; retirar uso de localStorage/fixtures como estado de negocio real.
3. Conectar primero login/invitación y teléfonos, luego web/primera publicación, Google, Facebook, agente y Telegram.
4. Resolver discrepancias de nombres/estados usando adaptadores mínimos y contratos reales. No cambiar la API si basta adaptar presentación.
5. Montar E2E con **servidor Express + PostgreSQL + navegador** que pruebe las vistas visuales ya conectadas. Probar recarga, 2 sesiones, 2 tenants, casos negativos, fallos y reanudación.
6. Ejecutar npm test completo y automatización browser; arreglar hasta PASS; producir evidencia con comandos y resultados honestos, distinguiendo simulated/not_verified de real.
7. Commit y push no forzado; resumen claro con HEAD, URL de desarrollo, procedimiento de ejecución y matriz de casos. No dejar el trabajo detenido tras solo documentar.

## 6. Aceptación E2E

- [ ] La interfaz de Claude (no tarjetas temporales de /panel) abre desde el servidor, con sesión/invitación y datos de backend real.
- [ ] Tres números independientes persisten entre sesiones y reinicios, sin cambiar canales hermanos; cross-tenant bloqueado.
- [ ] Primera página de negocio recién creado se puede crear y publicar sin error de sitio inexistente.
- [ ] Solicitud web por chat → preview real → aprobación autorizada → publicación de desarrollo y versión visible sin duplicados.
- [ ] Facebook posts + comentarios, Google ficha + reseñas, políticas/consentimiento, bandeja de casos y resolución por panel/Telegram simulados pero **persistidos realmente**.
- [ ] Worker funciona con navegador cerrado; refresh/segunda sesión ven la misma resolución.
- [ ] Roles y errores ejercitados por API y navegador. No se puede habilitar respuesta automática sin consentimiento.
- [ ] npm test PASS y test browser integrado PASS con evidence; sin confundir pruebas de prototipo file:// con E2E de servidor.
- [ ] No nuevas sesiones HDC ni modificaciones a DEC históricos, backups, Gate 7, QS-0015 o producción.

## 7. Autonomía y evidencias

El propietario ya delegó esta ejecución; no se piden aprobaciones por decisión estética, cambio de contrato compatible o pruebas de desarrollo. Registrar decisiones técnicas relevantes en DECISION-LOG.md, **sin gates**. Si falta token/proveedor externo, resolver su trayecto E2E mediante simuladores, anotar dependencia y continuar. No afirmar que la UI integrada existe hasta que de verdad esté disponible.

**Finalidad:** un único MainSpot de DESARROLLO, con UI/UX Claude + backend SOL MAIN, listo para usar y recorrer E2E.
