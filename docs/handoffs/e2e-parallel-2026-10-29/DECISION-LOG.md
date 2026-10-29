# Decisiones operativas — desarrollo E2E

Este registro **no** es HDC/DEC ni pretende modificar documentos históricos. Un registro por decisión material, breve; el objetivo es dejar trazabilidad **sin bloquear implementación**.

## 2026-10-29 · Autonomía de desarrollo y trabajo paralelo

- **Fuente:** instrucción explícita del propietario en esta conversación.
- **Decisión:** SOL MAIN y Claude Design trabajan en paralelo, resuelven detalles de desarrollo conforme a buenas prácticas y pruebas, **sin sesiones ni gates HDC** para esta tanda; se conserva distinción de producción y autorizaciones de clientes.
- **Razón:** el backend ya dispone de cimientos, contratos y controles; el propietario quiere cerrar el flujo E2E sin burocracia.
- **Límites:** no tocar Gate 7 / QS-0015 / respaldos, no usar cuentas externas reales sin permisos, no manipular reseñas y no confundir automatismo seguro bajo política con aprobación universal.
- **Evidencia esperada:** tests E2E y commits de cada frente. El trabajo posterior a esta autorización aún **no** ha sido ejecutado por los agentes.

## 2026-10-29 · Número alternativo por integración

- **Fuente:** aclaración del propietario «El otro número puede ser diferente siempre. No otro número único».
- **Decisión:** un `other_phone` independiente para cada uno de **website**, **google_business_profile**, **facebook**, además de un `primary_phone` compartido para el modo `own`. No existiría un número alternativo global.
- **Razón:** cada integración puede presentar un contacto diferente.
- **Prueba obligatoria:** TEL-01 (3 overrides distintos al mismo tiempo), TEL-02 (cambiar solo uno no altera otros), TEL-03 (primario modifica solo modos `own`).

## 2026-10-29 · SOL MAIN · Teléfonos por integración (TEL-01..04)

- **Decisión:** tablas `business_contact` (principal) e `integration_phone` (una fila por `website`, `google_business_profile`, `facebook`, cada una con su `mode` y su propio `other_*`). API `GET /api/backoffice/contact/phones`, `PUT …/primary`, `PUT …/integrations/:channel` (lectura `data.read`; escritura `client.config.manage`).
- **Razón:** columnas explícitas en vez de `client.metadata`; UPSERT por `(tenant, channel)` evita pisar canales hermanos. `other→own` conserva el override; solo `other_phone: null` lo borra. Validación E.164 con `libphonenumber-js` (metadatos completos), errores por campo.
- **Web:** la vista previa y la publicación usan el teléfono efectivo de `website` (si existe configuración); sin configuración se conserva el teléfono del sitio. Con teléfonos configurados, «cambia el teléfono» por chat o Telegram no crea propuesta: responde que se cambia en «Teléfonos de contacto» → Página web (mismo criterio que la iteración 2 de Claude Design: una sola fuente del número). Sin configuración se conserva la edición conversacional previa.
- **Proveedores:** Google/Facebook marcan `sync.mode=simulated` sin credenciales y `not_verified` con credenciales; nunca se afirma sincronía real.
- **Evidencia:** `tests/integration/contact-phones.test.ts` (6/6 PASS). Auditoría sin dígitos.

## 2026-10-29 · SOL MAIN · Agente de atención por políticas (AG-01..04)

- **Decisión:** `engagement_case` (dedupe `tenant+origin+external_ref`), `engagement_policy` append-only (versión, consentimiento literal, revocable), motor determinista `src/engagement/classifier.ts` (sin IA decisora), worker `src/engagement/worker.ts` en el proceso del servidor (`ENGAGEMENT_WORKER=on`, cada 15 s) o como proceso propio (`scripts/engagement-worker.ts`). Candado consultivo por tenant; cursor/backoff por origen; lease de envío con recuperación.
- **Google:** el worker reutiliza `ReputationEngine.sync` (cuota `reviews_managed`, dedupe, auditoría) y crea casos para las reseñas no respondidas; responder un caso marca la reseña `published`; si se respondió por la vía de reseñas, el caso se cierra (`closed_elsewhere`) sin doble respuesta.
- **Autonomía (OWNER-AUTHORIZATION §5):** solo `gratitude` y `basic_info` admiten `safe_auto_reply`, con `consent: true`; riesgo (salud, compensación/ofertas, legal, amenaza, acusación, datos privados), categoría ambigua, confianza baja, dato no verificado o cupo/hora agotado → humano. La calificación sola nunca autoriza. `basic_info` responde con el teléfono **del canal** (Google o Facebook) o con la ficha simulada.
- **Aprobación humana:** aprobar un caso (panel o Telegram) con el texto exacto es la decisión del cliente; se publica directo desde el caso (no por la propuesta/preview de INC-004), con claim atómico e idempotency key. Reconciliación canónica pendiente con DEC-011 para fase productiva.
- **Proveedores:** simulador en PostgreSQL (`sim_provider_*`) con fallos inyectables; `delivery_mode=simulated` en todo resultado. Adaptadores reales sin certificar: respuestas a comentarios de Meta devuelven `not_verified`; con proveedor no idempotente un envío interrumpido pasa a revisión humana en vez de reenviarse.
- **Telegram:** chat vinculado por código de un solo uso (`/start`), avisos por (caso, chat) sin duplicados, `/aprobar <caso> <n>` y `/rechazar <caso>` usan el mismo servicio y RBAC que el panel. Webhook exige `TELEGRAM_WEBHOOK_SECRET` en producción.
- **Evidencia:** `tests/unit/engagement-classifier.test.ts` 5/5, `tests/integration/engagement-agent.test.ts` 9/9 (todo `simulated`).

## 2026-10-29 · SOL MAIN · Alta asistida, acceso sin tenant_id y UI mínima (FLOW-01/02)

- **Decisión:** `owner_invitation` (token de 256 bits, solo SHA-256 en BD, 72 h, un solo uso consumido con `UPDATE … RETURNING` en la misma transacción que crea la cuenta Administración). Operación crea negocio + plan piloto + invitación con `node scripts/invite-owner.ts --business … --email …`; el enlace lleva el token en el fragmento (`/invitacion#…`), fuera de registros del servidor. Inválida, usada o caducada → misma respuesta neutra; intentos limitados por IP.
- **Login:** `tenant_id` pasa a ser opcional. Sin él, el negocio se resuelve por correo + contraseña; si la misma credencial vale en varios negocios → `409 tenant_selection_required` con nombres de negocio (solo tras demostrar la contraseña). Con `tenant_id` el flujo anterior no cambia.
- **UI:** tarjetas temporales en `/panel` (`src/api/ui-e2e.ts`): teléfonos por integración, agente (políticas con consentimiento, casos, 3 borradores, publicar/descartar), Telegram, ficha de Google y simulador (solo fuera de producción). Se sustituirán por la UI de Claude Design (issue #3) consumiendo las mismas rutas.
- **Observación:** una edición web sobre un negocio sin página creada llega a vista previa y falla al publicar (`client_website_not_found`, 502, sin publicar nada). El alta no crea la web: el dueño la crea con `POST /api/backoffice/website` (cuota `website`). Comportamiento previo, sin cambio en esta tanda.
- **Evidencia:** `tests/integration/onboarding.test.ts` 3/3; `tests/e2e/dev-e2e-02.test.ts` (servidor real, CLI y worker independiente; caída con SIGKILL y reinicio).

## 2026-10-29 · SOL MAIN · Shape publicado para Claude Design

- Teléfonos: `GET /api/backoffice/contact/phones` → `{tenant_id, primary_phone|null, integration_phones:{website|google_business_profile|facebook:{mode, other_phone|null, effective_phone|null, effective_source, needs_primary, sync:{mode,status,synced_at}}}}`; `PUT …/primary {primary_phone:{country_iso2, national_number}}`; `PUT …/integrations/:channel {mode, other_phone?|null}`. Errores `400 {error:{code:'validation_error', message, fields:[{field,message}]}}`.
- Agente: `GET /engagement/cases?state=` → `{cases:[{case_id, origin, external_ref, author_label, body, rating, state, reason, drafts[≤3], response_text, resolution_channel(auto|panel|telegram), policy_version, delivery_mode(simulated|real), notify_status, post_id, review_id}]}`; `POST /engagement/cases/:id/drafts/:n {text}`; `POST /engagement/cases/:id/approve {draft_number|text}`; `POST /engagement/cases/:id/reject`; `GET|PUT /engagement/policies {origin, category(gratitude|basic_info), mode(review_required|safe_auto_reply), consent:true}`.
- Telegram: `GET|DELETE /telegram/link`, `POST /telegram/link-code` → `{code, expires_at, instructions, channel_mode}`. Ficha: `GET|PUT /google/profile`. Alta: `POST /api/auth/invitation {token}`, `POST /api/auth/invitation/accept {token, display_name, password}`, `POST /api/auth/login {login, password, tenant_id?}`.
