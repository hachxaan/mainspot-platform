# MainSpot Platform — INC-001 · INC-002 · INC-003 · INC-004 · INC-005 · INC-006 · INC-007(base)

**Identidad/aislamiento/auditoría (INC-001) + ingestión conversacional con preview y aprobación humana (INC-002) + web administrable y dominio subdominio simulado (INC-003) + reputación/reseñas Google (INC-004) + Facebook publicaciones/Ads simulados (INC-005) + suscripciones/planes/límites configurables sin cobro (INC-006) + analítica mínima y export ETL (INC-007 base).**

Implementación de los contratos canónicos:
- [`INC-001`](https://github.com/hachxaan/mainspot-documentation/blob/main/implementation/increments/INC-001-client-identity-isolation-audit.md) (baseline `CANONICAL_BASE_APPROVED_v0.1`)
- [`INC-002`](https://github.com/hachxaan/mainspot-documentation/blob/main/implementation/increments/INC-002-conversational-preview-approval.md) — flujo conversacional (canal Telegram/simulado), clasificación de intención, confirmación → preview → aprobación humana → publicación idempotente (AC-004..AC-007).
- `INC-003` — página web administrable (web en el entorno del cliente, DEC-017) con edición asistida por lenguaje natural (básica) y aprovisionamiento de subdominio MainSpot en modo simulado (DEC-019/DEC-026, FLOW-006).
- `INC-004` — Google Business Profile y reputación (`DEC-011` respuesta pública = preview/aprobación, `DEC-023` umbral configurable default `<4`, `DEC-026` modo simulado): detección → sugerencia (3 borradores) → escalamiento humano → aprobación → publicación UNA vez; SIN manipulación de opiniones.
- `INC-005` — Facebook publicaciones y Ads básicos (`DEC-017`, `DEC-026`): crear/adaptar/programar/consultar; publicación SOLO con preview/aprobación; cola programada con tick manual; campañas avanzadas/Instagram FUERA (permiso bloqueado).
- `INC-006` — suscripciones, planes y límites (`DEC-024`): catálogo CONFIGURABLE sin precios, enforcement de límites en creación (deny 403 `limit_exceeded` auditado), `PaymentProvider` abstracto + simulado (sin cobro).
- `INC-007` base — analítica mínima (`DEC-025`): export ETL JSON/CSV paginado por tenant, retención configurable (default 90 días) con DRY-RUN seguro, agregados diarios básicos; dashboards/research son fase 2.

Stack (gate humano 2026-08-19): **TypeScript (Node ≥ 24, type-stripping nativo) + PostgreSQL 16 + sesión/JWT propio mínimo + Docker Compose local**. Aislamiento **LÓGICO por cliente** (`DEC-018`: `tenant_id` + contexto + fail-closed). Integraciones externas bajo `DEC-026`: interfaz de adaptador + implementación real opcional + **modo simulado funcional** (E2E y piloto sin credenciales externas).

> ⚠️ **Estado**: piloto de implementación. Las decisiones técnicas no cerradas por canon se marcan **TENTATIVA** más abajo y deben validarse/cerrarse antes de producción.

---

## 1. Estructura del monorepo (por capas, DEC-022)

```
mainspot-platform/
├── src/
│   ├── identity/    C1  modelo de cliente/tenant, usuario interno, rol, sesión
│   ├── boundary/    C2  resolución tenant+actor, middleware fail-closed, capa de datos con scope forzado
│   ├── rbac/        C3  matriz declarativa rol×contexto×acción + motor de chequeo (incluye acciones INC-004..007 y bloqueadas `reputation.hide_review`/`social.campaign_advanced`)
│   ├── audit/       C4  evento mínimo, sink fail-closed, consulta/export con correlación
│   ├── hooks/       C5  contratos INC-001 (resolve_identity / check_authorization / audit_sink)
│   ├── channels/    INC-002 adaptador de canal (Telegram real opcional + SimulatedChannel funcional, DEC-026)
│   ├── conversation/INC-002 clasificador determinista (TENTATIVA), pipeline de ingesta, repos, state machine FLOW-002
│   ├── publishing/  contrato Publisher genérico (reutilizable INC-003/004/005) + Stub/Website/Reputation/Social publishers
│   ├── website/     INC-003 plantilla de sitio (XSS-safe), editor asistido por LN (básico), repositorio
│   ├── domain/      INC-003 DomainProvider (Hostinger real opcional + SimulatedHostinger, DEC-019/026)
│   ├── reputation/  INC-004 ReputationProvider (GBP real opcional + SimulatedReviews determinista), engine FLOW-004, publisher
│   ├── social/      INC-005 SocialProvider (Meta real opcional + SimulatedMeta determinista), servicio + cola de programación, publisher
│   ├── subscriptions/ INC-006 catálogo de planes/límites (EntitlementService/checkLimit), PaymentProvider abstracto + simulado
│   ├── analytics/   INC-007 base ExportService (JSON/CSV paginado), RetentionService (DRY-RUN), AnalyticsService (agregados diarios)
│   ├── api/         API HTTP mínima + UX + rutas conversacionales/preview + reputation/social/subscriptions/analytics
│   ├── db/          pool PostgreSQL
│   └── shared/      config, logger estructurado, contexto por request (ALS), JWT propio, errores
├── migrations/      0001_schema + 0002_seed + 0003_login_unique + 0004_conversation_preview
│                    0005_website_domain + 0006_permissions + 0007_reputation_reviews
│                    0008_social_posts + 0009_subscriptions_plans + 0010_analytics_summary
├── scripts/         migrate / seed / db-setup / test-prep / matrix / export-audit / rollback / evidence
├── tests/           unit (sin DB) · integration (con DB + 2 tenants) · smoke · e2e (canal simulado + INC-004/005/006)
├── evidence/        evidencia real capturada (AC-009)
└── docker-compose.yml
```

## 2. Prerrequisitos

- Node.js **≥ 24** (usa type-stripping nativo; `node -v` debe mostrar `v24.x`)
- npm ≥ 10 (o pnpm)
- Docker + Docker Compose (para PostgreSQL local)
- **JWT_SECRET** (requerido por el app/`npm start`, ver §12; los scripts de BD y tests no lo necesitan)

```bash
cp .env.example .env          # NUNCA commits .env. Ajusta valores; JWT_SECRET es OBLIGATORIO para el app.
#   Genera el secreto:  JWT_SECRET=$(openssl rand -hex 32)  (añádelo a .env)
npm install                   # instala dependencias (express + pg)
```

## 3. Setup de la base de datos

```bash
npm run db:up        # docker compose up -d postgres  (crea la BD 'mainspot')
npm run db:setup     # asegura la BD, aplica migraciones + seed (idempotente)
```

- Migraciones 0001→0003 (INC-001 descritas en el README original) y nuevas:
  - `0004_conversation_preview.sql` — `conversation_request`, `action_proposal` (state machine FLOW-002), `preview_session` (token SOLO hasheado), `approval`, `publication` (idempotencia AC-007). FKs a `client` con `ON DELETE RESTRICT`.
  - `0005_website_domain.sql` — `client_website`, `client_domain` (provisión simulada), `website_content` (sitio estático versionado) + **seed idempotente de sitios** de los 2 tenants (`el-sol`, `la-luna`).
  - `0006_permissions.sql` — espejo de la matriz ampliada (acciones `conversation.read/send/confirm`, `website.publish/provision`).
  - `0007_reputation_reviews.sql` — `review` (estados FLOW-004) + permisos `reputation.*` (mirror de la matriz; `hide_review` queda deny para todos).
  - `0008_social_posts.sql` — `social_post` + `scheduled_post` (cola de programación) + permisos `social.*` (`campaign_advanced` deny para todos).
  - `0009_subscriptions_plans.sql` — `plan`, `plan_limit`, `subscription` + **seed de planes sin precio** (`Piloto 1` único) y asignación a los 2 tenants + permisos `subscription.*`.
  - `0010_analytics_summary.sql` — `analytics_daily_summary` + índice de retención sobre `audit_event(ts)` + permisos `analytics.*`.
  - `0011_social_approval_gate.sql` — PR-01 (Reviewer): la cola `scheduled_post` SOLO existe tras aprobación humana. Amplía el CHECK de estado (`scheduled`/`blocked`), añade `scheduled_post.proposal_id → action_proposal` (FK RESTRICT + índice) y **backfill** de filas legacy: con evidencia de aprobación → `scheduled`; huérfanas → `blocked` (nunca auto-publicadas).
- El runner registra archivos en `schema_migrations` con advisory lock (replay seguro). Seeds 0002/0005/0009 idempotentes (`ON CONFLICT DO NOTHING`).
- **Regeneración de BD dev/test**: `npm run db:setup` (dev) o `npm run test:integration`/`test:e2e` (recrean `mainspot_test` desde cero con `scripts/test-prep.ts`). Si una BD existente ya tiene datos, `npm run migrate` aplica 0011 y convierte los legacy de `scheduled_post` automáticamente (no se pierde la intención de las filas aprobadas).

### Credenciales de prueba (SIMULADAS — solo dev)

| Cliente | Perfil | Login | Contraseña |
|---|---|---|---|
| `client_a` | administración | `admin.a@example.com` | `Simula-A-Admin-2026!` |
| `client_a` | operación | `ops.a@example.com` | `Simula-A-Ops-2026!` |
| `client_a` | solo lectura | `reader.a@example.com` | `Simula-A-Reader-2026!` |
| `client_b` | administración | `admin.b@example.com` | `Simula-B-Admin-2026!` |
| `client_b` | operación | `ops.b@example.com` | `Simula-B-Ops-2026!` |
| `client_b` | solo lectura | `reader.b@example.com` | `Simula-B-Reader-2026!` |

## 4. Ejecutar la aplicación

```bash
npm start                 # node src/api/server.ts  (http://localhost:3000)
# o con Docker (app + postgres):
docker compose up --build
```

Rutas principales (INC-001):

| Ruta | Protegida | Acción |
|---|---|---|
| `GET /` | — | Página de ingreso (lenguaje claro, AC-008) |
| `POST /api/auth/login` | — | Inicia sesión → JWT de sesión (propio, HS256) |
| `POST /api/auth/logout` | sesión | Revoca la sesión |
| `GET /api/backoffice/me` | `data.read` | Contexto actual (cliente, perfil, permisos) |
| `GET/POST /api/backoffice/data` | `data.read/write` | Datos del cliente (solo tenant propio) |
| `GET /api/backoffice/audit(?:/export)?` | `audit.read/export` | Consulta/export de auditoría |
| `GET/POST /api/backoffice/users` | `user.manage` | Listar/crear usuarios internos (admin) |
| `POST /api/backoffice/actions/:id/{approve,reject,execute}` | `operation.*` | Verbos AC-003 (fixture) |

Rutas INC-002/INC-003:

| Ruta | Protegida | Acción |
|---|---|---|
| `POST /api/backoffice/conversation/messages` | `conversation.send` | Ingiere mensaje del canal (simulado/TELEGRAM); clasifica, confirma o bloquea (FLOW-001) |
| `GET /api/backoffice/conversation/requests` | `conversation.read` | Solicitudes del tenant (filtro `?status=`) |
| `GET /api/backoffice/conversation/proposals` | `conversation.read` | Propuestas del tenant (filtro `?status=`) |
| `GET /api/backoffice/conversation/proposals/:id` | `conversation.read` | Detalle (anti-oráculo 404) |
| `POST /api/backoffice/conversation/proposals/:id/confirm` | `conversation.confirm` | Confirmar → genera preview (preview_ready + token) |
| `POST /api/backoffice/conversation/proposals/:id/approve` | `operation.approve` | Aprobar y publicar (idempotente, AC-007; rate-limited) |
| `POST /api/backoffice/conversation/proposals/:id/reject` | `operation.reject` | Rechazar (no publica; rate-limited) |
| `GET /api/backoffice/website` | `data.read` | Sitio del tenant + dominio aprovisionado |
| `POST /api/backoffice/website/provision` | `website.provision` | FLOW-006: subdominio simulado idempotente |
| `GET /preview/:token` | público | Vista previa con enlace seguro (HTML, AC-007) |
| `POST /preview/:token/apply` | público (token) | "Aplicar cambios": aprueba y publica UNA vez (single-use + expiración) |

Rutas INC-004 (reputación/reseñas):

| Ruta | Protegida | Acción |
|---|---|---|
| `GET /api/backoffice/reputation/reviews` | `reputation.read` | Reseñas del tenant (filtro `?state=`) |
| `POST /api/backoffice/reputation/reviews/sync` | `reputation.respond` | Ingesta del proveedor (simulado determinista; idempotente; respeta `reviews_managed`) |
| `POST /api/backoffice/reputation/reviews/:id/escalate` | `reputation.escalate` | Escalamiento humano (FLOW-004) |
| `POST /api/backoffice/reputation/reviews/:id/response` | `reputation.respond` | Editar borrador de respuesta (solo antes de aprobar) |
| `POST /api/backoffice/reputation/reviews/:id/approve` | `reputation.approve` | Aprueba respuesta → crea propuesta de preview/publicación (DEC-011) |
| `POST /api/backoffice/reputation/reviews/:id/reject` | `reputation.respond` | Rechaza el caso (antes de publicar) |
| `POST /api/backoffice/reputation/reviews/:id/hide` · `DELETE /reputation/reviews/:id` | `reputation.hide_review` | **BLOQUEADO para todos** (no se manipulan opiniones; 403 + audit deny) |

Rutas INC-005 (social):

| Ruta | Protegida | Acción |
|---|---|---|
| `POST /api/backoffice/social/posts` | `social.create` | Crear borrador (post o ad básico; verifica límite del plan) |
| `GET /api/backoffice/social/posts` | `social.read` | Listado (filtro `?status=`) |
| `POST /api/backoffice/social/posts/:id/schedule` | `social.schedule` | Programar borrador (aprobación posterior) → `awaiting_approval` + cola |
| `POST /api/backoffice/social/posts/:id/approve` | `social.approve` | Aprobar contenido → propuesta de preview/publicación |
| `POST /api/backoffice/social/posts/:id/reject` | `social.schedule` | Rechazar (la cola queda `skipped`) |
| `POST /api/backoffice/social/process-due` | `social.schedule` | Tick manual del worker: publica programaciones vencidas (idempotente) |
| `POST /api/backoffice/social/campaigns/advanced` | `social.campaign_advanced` | **BLOQUEADO** (campañas avanzadas fuera del MVP; 403 + audit deny) |

Rutas INC-006 (suscripciones):

| Ruta | Protegida | Acción |
|---|---|---|
| `POST /api/backoffice/subscriptions/assign` | `subscription.admin` | Asignar plan (una suscripción activa por tenant; idempotente) |
| `GET /api/backoffice/subscriptions/entitlements` | `subscription.read` | Plan + límites del cliente |
| `GET /api/backoffice/subscriptions/plans` | `subscription.read` | Catálogo de planes (configurable en BD) |
| `POST /api/backoffice/subscriptions/invoice` | `subscription.admin` | Facturar; **PROHIBITED** si el plan no tiene precio (piloto sin cobro) |

Rutas INC-007 base (analítica):

| Ruta | Protegida | Acción |
|---|---|---|
| `GET /api/backoffice/analytics/export` | `analytics.export` | Export ETL JSON/CSV paginado con filtros `from/to/action/page/page_size` |
| `GET /api/backoffice/analytics/summary` | `analytics.read` | Agregados diarios por acción/resultado (en vivo) |
| `POST /api/backoffice/analytics/refresh-summary` | `analytics.export` | Materializa `analytics_daily_summary` (upsert idempotente) |
| `POST /api/backoffice/analytics/purge` | `analytics.purge` | Retención ON-DEMAND; **default DRY-RUN** (no borra; `dry_run=false` aplica) |

## 5. INC-002 — Conversational request intake with preview and human approval

Flujo implementado (según `INC-002`, AC-004..AC-007, FLOW-001/002/003):

1. **Canal** (`src/channels/`): `ChannelAdapter` (interfaz) + `TelegramAdapter` (real con `TELEGRAM_BOT_TOKEN`, fetch a Bot API; `parseUpdate` TENTATIVA) + `SimulatedChannel` (funcional para E2E/piloto). Registro por `CHANNEL_PRIMARY`; sin token ⇒ simulado (DEC-026). **El canal no sustituye identidad** (RULE-001): la identidad/tenant la resuelve la capa de sesión INC-001.
2. **Intake** (`src/conversation/pipeline.ts`): normaliza → resuelve actor/tenant (sesión) → clasifica intención (FLOW-001) → audita → enruta.
3. **Clasificador** (`src/conversation/classifier.ts`): DETERMINISTA por reglas/keywords en español (TENTATIVA, iterable), traduce la matriz de autonomía del canon: `read_only` (RULE-002), `draft` (sugerencia), `preview_required` (cambio visible, RULE-003), `human_approval_required` (sensible, RULE-004), `prohibited` (inventar precios/condiciones, RULE-005).
4. **State machine** (`src/conversation/state-machine.ts`, FLOW-002): `drafted → awaiting_confirmation → confirmed → preview_ready → approved_for_publish → published | rejected | expired | failed`. Transiciones sensibles atómicas con su auditoría (fail-closed).
5. **Publicación idempotente** (AC-007): `publication.publish_key` UNIQUE por (proposal, attempt); repetir aprobación ⇒ `already_published` (audit `conversation.publish_attempt`), NUNCA duplica.
6. **Preview seguro** (CAP-008, TENTATIVA): token aleatorio (`pv_…`), SOLO hash en BD, expiración configurable (`PREVIEW_TOKEN_TTL_MINUTES`), alcance limitado a un proposal, single-use; botón **Aplicar cambios** en `POST /preview/:token/apply`.
7. **Auditoría**: toda acción emite eventos (`conversation.received/classified/answered/prohibited/proposal.created/confirmed/preview.created/approved/published/publish_attempt/rejected/expired`) con `request_id`; sin secretos (el token y las contraseñas jamás llegan a audit).

## 6. INC-003 — Website administration + dominio subdominio MainSpot (modo simulado)

- **WebsiteService** (`src/website/`): plantilla estática XSS-safe con datos de negocio (nombre, giro, servicios, horarios, contacto); render determinista; **editor asistido por LN** (`edit-mapper.ts`, TENTATIVA/básico): "cambia el teléfono a …", "agrega la sección servicios", "agrega un servicio llamado …", etc. → parche estructurado → propuesta del INC-002.
- **Publicación** (`src/publishing/website.ts`): solo tras aprobación humana (RULE-003); renderiza y persiste `website_content` versionado + `client_website.published_version`.
- **Dominio** (`src/domain/`): `DomainProvider` + `SimulatedHostinger` (subdominio `<slug>.sim.mainspot.local`, DNS CNAME y certificado simulados, determinista e idempotente) + `HostingerAdapter` (real, SOLO con `HOSTINGER_API_TOKEN`). Al publicar se garantiza la provisión (FLOW-006); también por endpoint.
- **Preview público**: `GET /preview/:token` renderiza el sitio propuesto; aplicar publica.

## 7. INC-004 — Reputación y reseñas (CAP-002/CAP-004, DEC-011/023/026)

- **Adaptador** (`src/reputation/provider.ts`, `simulated.ts`, `google.ts`): `ReputationProvider` (listReviews + postPublicResponse). `SimulatedReviews` con dataset determinista por tenant (2+ positivas, 1 neutra, 1 negativa con calificación <4); `GoogleBusinessProfileAdapter` real SOLO con `GOOGLE_GBP_TOKEN` (fetch TENTATIVA; sin token NUNCA se llama).
- **Engine** (`src/reputation/engine.ts`): ingesta idempotente → clasificación (`>=4 positive`, `==3 neutral`, `≤2 negative`) → enrutamiento por `REVIEW_THRESHOLD` (DEC-023, default 4 ⇒ `<4` escala). Estados FLOW-004: `detected → suggested → awaiting_human → approved → published | rejected`, con `edited` para borradores corregidos y `acknowledged` para positivas (sin publicación). Sugerencia determinista de **3 borradores** (sin inventar descuentos/precios, RULE-005).
- **Respuesta pública** = cambio visible (DEC-011): al aprobar la respuesta se crea una propuesta `capability_target='reputation'` del flujo INC-002 → **preview → aprobación → publica UNA vez** (publisher idempotente `src/reputation/publisher.ts`). Editar respuesta SOLO en borrador (antes de aprobar); después de publicado ⇒ 409 `prohibited`. **Sin manipulación**: ocultar/borrar reseñas está BLOQUEADO (permiso `reputation.hide_review` deny para todos; 403 + audit deny).

## 8. INC-005 — Facebook publicaciones y Ads (CAP-003, DEC-017/026)

- **Adaptador** (`src/social/`): `SocialProvider` (getPage + publishPost). `SimulatedMeta` determinista (página fija por tenant, external_ref = hash del contenido ⇒ idempotente); `MetaAdapter` real SOLO con `META_GRAPH_TOKEN` (API Graph TENTATIVA; sin token NUNCA se llama).
- **Servicio** (`src/social/service.ts`): `draft → awaiting_approval → proposal FLOW-002 → publicado UNA vez`. Crear borrador (límite `social_posts`/`social_ads` verificado), programar (**PR-01**: `schedule()` SOLO registra la intención `scheduled_at`; la cola `scheduled_post` se materializa cuando la aprobación humana genera la publicación), publicar vía FLOW-002 (publisher `src/social/publisher.ts` crea la fila de cola con `status='scheduled'` y `proposal_id`), listar, tick manual `POST /social/process-due`.
- **Gate de aprobación (PR-01, Reviewer)**: el tick SOLO publica filas con evidencia de aprobación (propuesta `published`/`approved_for_publish` + fila de `publication`); sin aprobación marca la fila `blocked` con auditoría deny (`social.published`/`not_approved`) y NUNCA publica. `updateStatus()` impide llegar a `published` desde un estado no aprobado (exige `scheduled`). Endpoints `approve` con rate limiting (PR-06).
- **Fuera del MVP**: campañas avanzadas e Instagram (permiso `social.campaign_advanced` deny para todos; intento ⇒ 403 + audit deny).

## 9. INC-006 — Suscripciones y límites (CAP-012, DEC-024)

- **Catálogo CONFIGURABLE en BD** (`plan`, `plan_limit`, `subscription`): plan **"Piloto 1"** único sin precio + planes opcionales sin precio (RULE-006). Una suscripción activa por tenant (seed para los 2 tenants).
- **EntitlementService** (`src/subscriptions/entitlements.ts`): asignar plan (admin), consultar entitlements (los 3 perfiles), `checkLimit(tenant, capability)` en el punto de creación — exceso ⇒ **403 `limit_exceeded` auditado**; sin plan activo ⇒ 403 `subscription_required` (fail-closed). `remainingQuota(tenant, capability)` permite validar LOTES antes de insertar (PR-03).
- **Enforcement por capacidad (PR-02, Reviewer)**:
  - `conversations` — verificado en `pipeline.ingest()` (todo mensaje entrante exige plan activo y cuota; deny 403 + audit en la ruta).
  - `website` — verificado en `POST /website` (creación del sitio, INC-003/PR-02): sin plan ⇒ 403 `subscription_required`; uso completo ⇒ 403 `limit_exceeded`; un sitio por tenant (UNIQUE) + 409 si ya existe. La provisión de dominio/publicación NO cuenta como creación (no rompe el flujo de tenants con sitio de seed).
  - `social_posts`/`social_ads` — verificado en `social.createDraft`.
  - `reviews_managed` — verificado en `reputation` sync/ingesta con validación de LOTE atómica (PR-03).
  - `agents` — SIN enforcement en esta tanda (no existe creación de agentes todavía; solo lectura del límite). Ver §15.
- **Política sin plan (PR-02, decisión del owner)**: **DENY 403 `subscription_required`** en toda operación que CREA recursos (mensajes, posts, reseñas, sitios, facturación); las lecturas (entitlements, data.read, listados, analítica de lectura) siguen permitidas. Documentada en §15.
- **Pago** (`src/subscriptions/payment.ts`): `PaymentProvider` abstracto + `SimulatedPaymentProvider` (siempre ok, sin llamadas externas). `POST /subscriptions/invoice` con plan SIN precio ⇒ **PROHIBITED** + audit deny (`no_price_prohibited`). El piloto NO cobra.

## 10. INC-007 base — Analítica mínima + export ETL (CAP-014 base, DEC-025)

- **ExportService** (`src/analytics/export.ts`): exporta eventos de auditoría por tenant con filtros `from/to/action`, formato JSON/CSV, paginación (page/page_size, `has_more`), auditoría del exporte.
- **RetentionService** (`src/analytics/retention.ts`): retención configurable (`RETENTION_DAYS`, default 90) ON-DEMAND; la operación es **DRY-RUN por defecto** (no borra) y solo con `dry_run=false` elimina (scope por tenant; la retención global de plataforma queda como limitación documentada).
- **Agregados** (`src/analytics/summary.ts` + `analytics_daily_summary`): contadores por día/acción/resultado con SELECT en vivo; `refresh-summary` materializa (upsert idempotente). **Dashboards completos, ETL externo y research/recomendaciones son INC-007 fase 2 (fuera de este bloque).**

## 11. Validaciones (AC-001/002/003/004/005/006/007/009)

```bash
npm run typecheck         # tsc --noEmit
npm run test:unit         # unit sin DB (RBAC/engine+matrix ampliada, JWT, audit, classifier, website, publishing, reputation, social, subscriptions, analytics)
npm run test:integration  # recrea mainspot_test + aislamiento, RBAC, auditoría, INC-002 (AC-004..007), INC-003, INC-004..007
npm run test:smoke        # smoke AC-009 + señales UX AC-008
npm run test:e2e          # E2E INC-002+INC-003 (canal simulado) + INC-004/005/006 (proveedores simulados)
npm test                  # typecheck + unit + integration + smoke + e2e
```

### Remedios PR-01..PR-06 (tanda de remediación full review)

| Hallazgo | Cobertura |
|---|---|
| **PR-01** gate de aprobación social | `tests/integration/social-inc005.test.ts` — "programar sin aprobar ⇒ tick NO publica + audit deny + fila blocked"; "programar con aprobación → cola SOLO tras aprobar → tick publica UNA vez" |
| **PR-02** enforcement de límites | `tests/integration/subscriptions-inc006.test.ts` — conversaciones (403 en ingesta), creación de sitio sin plan (403 `subscription_required`) y con plan (201); límites sociales previos |
| **PR-03** sync de reseñas transaccional | `tests/integration/subscriptions-inc006.test.ts` — lote que excede ⇒ 403 sin estado parcial (cero reseñas insertadas) |
| **PR-04** pin de commit en evidencia | `scripts/capture-evidence.sh` — HEAD + `git status --short` en `evidence/12-summary.txt` |
| **PR-06** rate limiting en approves | `tests/integration/reputation-inc004.test.ts` y `social-inc005.test.ts` — approve repetido ⇒ 429 tras el umbral |

### Correr el E2E simulado (DEC-026, sin credenciales)

```bash
npm run db:up && npm run db:setup && npm run test:e2e
# Escribe evidence/e2e-inc002-inc003.txt y evidence/e2e-inc004-006.txt
```

## 12. Evidencia reproducible (AC-009)

```bash
npm run evidence   # bash scripts/capture-evidence.sh
```

La salida real queda en `evidence/` (00-14): environment, typecheck, permission matrix, unit, db, integration, denied log, audit exports (por tenant), smoke, **13-e2e-inc002-inc003.txt** y **14-e2e-inc004-006.txt** (transcripts E2E), rollback, summary. Regla `06-ACCEPTANCE-EVIDENCE.md`: la evidencia no se basa en afirmaciones.

## 13. Rollback (AC-009)

1. Deshabilitar aprobaciones/publicaciones: `npm run rollback:simulate` revoca sesiones activas; ningún token previo sigue siendo válido.
2. Marcar previews pendientes como expired y conservar el intake read-only (rollback mínimo INC-002): `UPDATE preview_session SET status='expired' WHERE status='active'; UPDATE action_proposal SET status='expired' WHERE status IN ('confirmed','preview_ready');` — las consultas `read_only` siguen funcionando (FLOW-003).
3. Preservar auditoría: nunca se borran `audit_event` (salvo la purga explícita de retención INC-007 con `dry_run=false`).
4. Revertir código: `git revert` del commit de la tanda. La matriz RBAC vive en `src/rbac/matrix.ts` (migraciones espejo 0006/0007/0008/0009/0010).

## 14. Mapa AC → implementación y evidencia

| AC/INC | Dónde se cumple | Evidencia |
|---|---|---|
| **AC-001/002/003** (INC-001) | como en el README original | `tests/integration/*` (aislamiento, RBAC, auditoría) |
| **AC-004** Sensibles bloqueadas | `classifier.ts` (RULE-004/005) + `state-machine.ts` (approve sólo con `operation.approve`) | `tests/integration/conversation-inc002.test.ts` (sensible + prohibited) |
| **AC-005** Consulta sin efecto | `pipeline.ts` (read_only) + `read-answers.ts` | `tests/integration/conversation-inc002.test.ts` AC-005 |
| **AC-006** Confirmación detallada | `pipeline.ts` (confirmationText) + `edit-mapper.ts` (diff conceptual) | AC-006 (estado `awaiting_confirmation` + texto) |
| **AC-007** Publicar solo desde preview aprobado, idempotente | `state-machine.ts` + `publication.publish_key` UNIQUE + preview single-use | AC-007 + `tests/e2e/inc002-inc003-e2e.test.ts` |
| **AC-008** UX no técnica | `ui.ts` + mensajes en `errors.ts`/rutas + `previewPageHtml` | `tests/smoke/smoke.test.ts`, `docs/UX-CHECKLIST.md` |
| **AC-009** Evidencia y rollback | `capture-evidence.sh` (13/14-e2e) + rollback §13 | `evidence/*` |
| **INC-003 REQ-012/REQ-018** | `website/` + `domain/` + `publishing/website.ts` | `tests/integration/website-inc003.test.ts` |
| **INC-004** (DEC-011/023) | `reputation/` + `publishing/reputation` + preview/aprobación INC-002 | `tests/integration/reputation-inc004.test.ts`, `tests/unit/reputation.test.ts` |
| **INC-005** (DEC-017/026) | `social/` + `publishing/social` + cola `scheduled_post` (gate PR-01) | `tests/integration/social-inc005.test.ts`, `tests/unit/social.test.ts` |
| **INC-006** (DEC-024) | `subscriptions/` (planes/límites/pago simulado) + enforcement conversaciones/sitios (PR-02) | `tests/integration/subscriptions-inc006.test.ts`, `tests/unit/subscriptions.test.ts` |
| **INC-007 base** (DEC-025) | `analytics/` (export/retention/summary) | `tests/integration/analytics-inc007.test.ts`, `tests/unit/analytics.test.ts` |
| **PR-03** sync atomic | `reputation/engine.ts` (capacidad de lote + transacción) + `entitlements.remainingQuota` | `tests/integration/subscriptions-inc006.test.ts` |

## 15. Decisiones TENTATIVA (a validar/cerrar; el canon no las fija)

| Tema | Decisión tomada | Marca |
|---|---|---|
| Clasificador de intención | DETERMINISTA por reglas/keywords en español (sin ML) | TENTATIVA e iterable |
| Canal Telegram real | `TelegramAdapter` con fetch a Bot API; ingesta por webhook y mapeo canal→cliente SIN implementar (identidad resuelta por sesión) | TENTATIVA |
| Enlace de preview | token aleatorio alto entropía, hash SHA-256 en BD, expiración configurable, single-use, alcance `proposal_publish` | TENTATIVA (canon 05: audiencia/revocación pendiente) |
| Publisher | contrato genérico `Publisher` (reutilizando INC-003/004/005) con `WebsitePublisher`/`ReputationPublisher`/`SocialPublisher`; `StubPublisher` como fallback | TENTATIVA |
| Subdominio simulado | `<slug>.sim.mainspot.local` determinista; DNS CNAME + certificado simulados; idempotente | TENTATIVA (DEC-026) |
| Hostinger real | adaptador esqueleto FLOW-006 con fetch; sin credenciales NO se llama; no probado | TENTATIVA |
| Edición asistida de web | mapeo determinista de comandos comunes (sin generativo) | TENTATIVA e iterable |
| Aprobaciones | solo `administration` (`operation.approve/reject`, `reputation.approve`, `social.approve` admin-only) | TENTATIVA |
| Umbral de reseñas | `REVIEW_THRESHOLD` configurable por env, default `<4` (DEC-023); el valor definitivo queda para investigación con datos (Q-013) | TENTATIVA (decisión con dato diferida) |
| Sugerencia de respuesta | plantillas deterministas (3 borradores, sin generativo); sin inventar hechos comerciales (RULE-005) | TENTATIVA e iterable |
| Revisión de Google/API Meta reales | esqueleto con fetch; mapeo exacto a endpoints sin validar; sin credenciales NO se llaman | TENTATIVA |
| Límites por capacidad | enforcement en el punto de creación: `conversations` (ingesta), `website` (creación de sitio), `social_posts`/`social_ads` (crear borrador), `reviews_managed` (ingesta con validación de lote); TOCTOU entre check e insert aceptado en piloto | TENTATIVA (endurecer con UNIQUE/claims en fase productiva) |
| `agents` sin enforcement | no existe creación de agentes en esta tanda: el límite se muestra en entitlements pero no se verifica en ninguna operación (futuro INC agente) | TENTATIVA (deuda registrada) |
| Política sin plan | **DENY 403 `subscription_required`** en toda operación que CREA recursos (mensajes/posts/reseñas/sitios/facturación); lecturas permitidas — decisión PR-02 de owner | TENTATIVA (configurable con plan "libre" si el piloto lo pide) |
| Sync de reseñas (PR-03) | validación de capacidad del LOTE antes de insertar + ingesta y auditoría en UNA transacción (sin estado parcial) | TENTATIVA (mejora del ítem anterior) |
| Retención/analítica | purge ON-DEMAND DRY-RUN por defecto, scope por tenant; retención global de plataforma y dashboards = fase 2 | TENTATIVA (INC-007 base) |
| `website.publish` (permiso) | reservado en matriz para endpoints de publicación operativa futura; sin ruta expuesta en esta tanda | TENTATIVA |

## 16. Seguridad y notas operativas (INC-001 + INC-002..007)

- **Fail-closed**: sin contexto ⇒ deny; **canales no son identidad**; **publicar/confirmar/aprobar requieren permiso**; acciones sensibles y su audit son atómicas (ROLLBACK conjunto). Acciones bloqueadas (`reputation.hide_review`, `social.campaign_advanced`) no se conceden a NINGÚN rol.
- **Gate de aprobación social (PR-01)**: la cola `scheduled_post` solo existe tras aprobación humana (`proposal_id` + `status='scheduled'`); el tick verifica evidencia de publicación por fila y bloquea las que no la tengan (audit deny `not_approved`). `updateStatus` impide `→ published` sin estado previo `scheduled`.
- **Anti-oráculo (IR-01)**: propuestas/requests/reseñas/publicaciones de otro tenant responden 404 idéntico (la ruta de aprobación cross-tenant devuelve 404 igual que inexistente y audita `not_found`).
- **Auditoría sin secretos**: tokens de preview (hash), contraseñas y credenciales de integraciones jamás se persisten/loguean; el sink y logger rechazan campos con nombre sensible.
- **Sin llamadas HTTP reales sin token**: los adaptadores Meta/Google/Hostinger solo se instancian con credenciales; por defecto el sistema usa simuladores deterministas (DEC-026).
- **No manipulación de opiniones**: no existe endpoint efectivo para ocultar/borrar reseñas; el intento se bloquea y audita como deny.
- **Rate limiting**: login (IR-06) y aprobación/rechazo sensibles (IP + operador + propuesta; `APPROVAL_RATE_LIMIT_*`) — incluye `approve` de reputación y social que generan propuestas (PR-06).
- **JWT_SECRET (IR-02)**: requerido fuera de `test`; sin default en código/compose.
- **Modo simulado determinista**: `SimulatedHostinger`, `SimulatedChannel`, `SimulatedReviews` y `SimulatedMeta` no usan aleatoriedad (pinned) ⇒ E2E reproducible; la única aleatoriedad es la de tokens/IDs (no afecta el flujo).
- **Nunca subir `.env`**; `.env.example` es referencia con placeholders.

## 17. Out of scope (recordatorio)

No pagos/precios/planes aprobados (DEC-024: solo infraestructura sin cobro; `invoice` PROHIBITED); no campañas avanzadas de redes ni Instagram (DEC-017); no Google Business Profile real sin credenciales (simulado determinista); no API Meta real sin token (simulado); no dashboards completos/research de analítica (INC-007 fase 2); no webhook real de Telegram (solo envío con token); no Hostinger real sin credenciales; la UI sigue mínima (sustituible por frontend real en incrementos posteriores).
