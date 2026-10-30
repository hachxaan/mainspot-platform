# MainSpot Platform — INC-001 · INC-002 · INC-003 · INC-004 · INC-005 · INC-006 · INC-007(base)

**Identidad/aislamiento/auditoría (INC-001) + ingestión conversacional con preview y aprobación humana (INC-002) + web administrable y dominio subdominio simulado (INC-003) + reputación/reseñas Google (INC-004) + Facebook publicaciones/Ads simulados (INC-005) + suscripciones/planes/límites configurables sin cobro (INC-006) + analítica mínima y export ETL (INC-007 base).**

Implementación de los contratos canónicos:
- [`INC-001`](https://github.com/hachxaan/mainspot-documentation/blob/main/implementation/increments/INC-001-client-identity-isolation-audit.md) (baseline `CANONICAL_BASE_APPROVED_v0.1`)
- [`INC-002`](https://github.com/hachxaan/mainspot-documentation/blob/main/implementation/increments/INC-002-conversational-preview-approval.md) — flujo conversacional (canal Telegram/simulado), clasificación de intención, confirmación → preview → aprobación humana → publicación idempotente (AC-004..AC-007).
- `INC-003` — página web administrable (web en el entorno del cliente, DEC-017) con edición asistida por lenguaje natural (básica) y aprovisionamiento de subdominio MainSpot en modo simulado (DEC-019/DEC-026, FLOW-006).
- `INC-004` — Google Business Profile y reputación (`DEC-011` respuesta pública = preview/aprobación, `DEC-023` umbral configurable default `<4`, `DEC-026` modo simulado): detección → sugerencia (3 borradores) → escalamiento humano → aprobación → publicación UNA vez; SIN manipulación de opiniones.
- `INC-005` — Facebook publicaciones y Ads básicos (`DEC-017`, `DEC-026`): crear/adaptar/programar/consultar; publicación SOLO con preview/aprobación; cola programada con tick manual; campañas avanzadas/Instagram FUERA (permiso bloqueado).
- `INC-006` — suscripciones, planes y límites (`DEC-024`): catálogo CONFIGURABLE sin precios, enforcement de límites en creación (deny 403 `limit_exceeded` auditado), `PaymentProvider` abstracto + simulado (sin cobro).
- `INC-007` base — analítica mínima (`DEC-025`): export ETL JSON/CSV paginado por tenant y agregados diarios básicos; dashboards/research son fase 2. La retención es global y automática (QS-0006, §10.1).

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
│   ├── conversation/INC-002 clasificador determinista (TENTATIVA), pipeline de ingesta, repos, state machine FLOW-002, Jev como clasificador disabled/shadow/primary (APR-0002)
│   ├── publishing/  contrato Publisher genérico (reutilizable INC-003/004/005) + Stub/Website/Reputation/Social publishers
│   ├── website/     INC-003 plantilla de sitio (XSS-safe), editor asistido por LN (básico), repositorio
│   ├── domain/      INC-003 DomainProvider (Hostinger real opcional + SimulatedHostinger, DEC-019/026)
│   ├── reputation/  INC-004 ReputationProvider (GBP real opcional + SimulatedReviews determinista), engine FLOW-004, publisher
│   ├── social/      INC-005 SocialProvider (Meta real opcional + SimulatedMeta determinista), servicio + cola de programación, publisher
│   ├── subscriptions/ INC-006 catálogo de planes/límites (EntitlementService), QuotaLedger (consumo atómico, DEC-0005), PaymentProvider abstracto + simulado
│   ├── analytics/   INC-007 base ExportService (JSON/CSV paginado), AnalyticsService (agregados diarios)
│   ├── retention/   QS-0006 RetentionService: purga diaria por plazo, baja con exportación, anonimización verificada y re-aplicación tras restaurar (DEC-0021..0027)
│   ├── jev/         núcleo cliente Jev/TypeSafe (vendorizado de hyper-jev; lo usan el clasificador Jev y su evaluación, APR-0002)
│   ├── api/         API HTTP + rutas conversacionales/preview + reputation/social/subscriptions/analytics/contact/engagement
│   ├── web/panel/   interfaz de Claude Design integrada (DEV-E2E-03): shell + assets servidos por Express en /, /panel, /invitacion
│   ├── db/          pool PostgreSQL
│   └── shared/      config, logger estructurado, contexto por request (ALS), JWT propio, errores
├── migrations/      0001_schema + 0002_seed + 0003_login_unique + 0004_conversation_preview
│                    0005_website_domain + 0006_permissions + 0007_reputation_reviews
│                    0008_social_posts + 0009_subscriptions_plans + 0010_analytics_summary
│                    0011_social_approval_gate + 0012_jev_classification
├── scripts/         migrate / seed / db-setup / test-prep / matrix / export-audit / rollback / evidence / jev-evaluate / dev-panel.sh
├── tests/           unit (sin DB) · integration (con DB + 2 tenants) · smoke · e2e (servidor real; ui-e2e-03 con navegador real)
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
  - `0012_jev_classification.sql` — APR-0002 (sustituye a la `0012_jev_shadow_evaluation.sql` de DEC-0001, que nunca se aplicó fuera de bases de prueba temporales): `jev_classification` (una fila por `conversation_request` clasificada con Jev; FK compuesta `(request_id, tenant_id)` sobre el índice único `uq_conversation_request_request_tenant` ⇒ siempre del mismo tenant) con modo efectivo, origen y motivo de la decisión (CHECK de coherencia D1–D4), clasificación determinista y final, lectura completa de Jev (intent, capability_target, distribuciones, confianzas), modelos, usage/costo, día del presupuesto, latencia, código de error seguro y cuerpos JSON exactos (sin cabeceras ni credencial); y `jev_evaluation_run` (evaluaciones sintéticas del gate D4, sin datos de tenant). Ver §5.1.
  - `0013_jev_gate_final_outcome.sql` — DEC-0033/DEC-0034: `jev_evaluation_run` añade `risk_definition` (`jev_only` en las ejecuciones anteriores, `final_outcome` desde DEC-0033), `jev_risky_misses` (cifra de Jev solo, informativa; backfill = `risky_misses` en las anteriores) y `decision_code_sha256` (bytes de `classifier.ts` + `jev-classifier.ts` evaluados). CHECK: una fila `final_outcome` exige hash de 64 hex y `jev_risky_misses`.
  - `0014_quota_reservation.sql` — DEC-0005 + NFR-0001: `quota_reservation` (una fila por consumo o reserva de cuota: `reserved` → `committed` | `released` | `expired`), única por `(tenant_id, capability, idempotency_key)`; FK a `client` RESTRICT; índices parciales de reservas vigentes y de vencimiento. Sin datos personales.
  - `0015_retention_policy.sql` — QS-0006 (DEC-0021..0027): `content_purged_at` en `conversation_request`/`action_proposal`/`jev_classification` (el CHECK de Jev admite cuerpos raw purgados), `retention_run` (informe de cada ejecución, solo totales; una programada completada por día UTC), estados de `client` `exiting`/`anonymized`, `tenant_exit` (baja confirmada con sha256 del export; anonimización ≥ 30 días después) y `anonymized_tenant` (solo sha256 del id, para no reintroducir bajas al restaurar). Permiso `analytics.purge` → `analytics.retention`.
  - `0016_contact_phones.sql` — DEV-E2E-02: `business_contact` (teléfono principal) e `integration_phone` (una fila por `website`/`google_business_profile`/`facebook` con su `mode` y su propio `other_*`).
  - `0017_engagement_agent.sql` — DEV-E2E-02: `engagement_policy` (versionada, opt-in con consentimiento), `engagement_case` (único por `tenant+origin+external_ref`), `engagement_cursor`, `engagement_notification` (única por caso+chat), `telegram_link`/`telegram_link_code` (código hasheado de un uso), `gbp_profile` (ficha simulada), `sim_provider_*` (simulador determinista con fallos inyectables) y permisos `engagement.*`/`telegram.link`.
  - `0018_owner_onboarding.sql` — DEV-E2E-02: `owner_invitation` (token solo como SHA-256, caducidad, un solo uso).
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
| `GET /`, `/panel`, `/invitacion` | — (la sesión la pide la propia interfaz) | Interfaz de MainSpot (Claude Design integrada; rutas internas `#/…`) |
| `POST /api/auth/login` | — | Inicia sesión → JWT de sesión (propio, HS256) |
| `POST /api/auth/logout` | sesión | Revoca la sesión |
| `GET /api/backoffice/me` | `data.read` | Contexto actual (cliente, perfil, permisos) |
| `GET/POST /api/backoffice/data` | `data.read/write` | Datos del cliente (solo tenant propio) |
| `GET /api/backoffice/audit(?:/export)?` | `audit.read/export` | Consulta/export de auditoría |
| `GET/POST /api/backoffice/users` | `user.manage` | Listar/crear usuarios internos (admin) |
| `GET/POST /api/backoffice/actions` | `operation.create` | Listar/crear operaciones de prueba del tenant (listado mínimo para el panel) |
| `POST /api/backoffice/actions/:id/{approve,reject,execute}` | `operation.*` | Verbos AC-003 (fixture) |

### Contrato `GET /api/backoffice/me`

Endpoints canónicos de contexto del panel. **SIEMPRE** devuelve `permissions`
como **array** de strings (nunca un conteo numérico). Shape (ejemplo real):

```json
{
  "session": {
    "user_id": "user_a_admin",
    "display_name": "Ana Administradora",
    "tenant_id": "client_a",
    "tenant": { "id": "client_a", "business_name": "Restaurante El Sol (cliente de prueba A)", "status": "active" },
    "role_id": "administration",
    "role_label": "Administración",
    "role_description": "Puede gestionar usuarios, configuración y auditoría, y ejecutar todas las acciones del panel…",
    "permissions": ["user.manage", "audit.read", "data.read", "website.publish", "website.provision", "social.read", "social.create", "social.schedule", "social.approve", "reputation.read", "reputation.respond", "reputation.escalate", "reputation.approve", "subscription.admin", "subscription.read", "analytics.read", "analytics.export", "analytics.purge", "operation.create", "operation.execute", "operation.approve", "operation.reject", "data.write", "client.config.manage", "audit.export", "conversation.read", "conversation.send", "conversation.confirm"],
    "expires_at": "2026-08-20T16:12:40.040Z"
  }
}
```

- `permissions` es el snapshot de la sesión (espejo de `src/rbac/matrix.ts`); la
  autorización por request SIEMPRE re-chequea la matriz (el snapshot es
  informativo/UI).
- `tenant` contiene solo `id`/`business_name`/`status` (nunca `contact_email` ni
  `metadata`).
- `display_name` proviene de `internal_user`; si no existe cae a `user_id`.
- Implementación: `src/api/routes.ts` (`GET /me`) + helpers de
  `src/identity/repository.ts` (`getUserDisplayName`, `getTenantSummary`);
  integración contractual en `tests/integration/me-contract.test.ts`.

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
| `GET /api/backoffice/analytics/retention` | `analytics.retention` | Vista previa de lo que purgará la retención automática para el tenant, plazos, baja (si existe) y última ejecución. No borra nada (§10.1) |

### 4.1 Deploy local LXD (contenedores LXC/LXD)

Para un piloto **sin Docker**, la plataforma se despliega en contenedores
`LXC/LXD` locales con [`scripts/deploy/deploy-lxd.sh`](scripts/deploy/deploy-lxd.sh)
(idempotente): dos contenedores `mainspot-db` (PostgreSQL 16) y `mainspot-app`
(Node ≥ 24, type-stripping nativo), app expuesta en `http://localhost:3000` vía
device proxy LXD. Aplica migraciones 0001→0012 + seed y genera secretos
aleatorios **fuera** del repo (`~/.config/mainspot/mainspot-secrets.env`, 0600).

Ver [`scripts/deploy/README-deploy-lxd.md`](scripts/deploy/README-deploy-lxd.md)
para requisitos, uso (`--reset`/`--destroy`), arquitectura, logs y evidencia
real en `evidence/deploy-lxd/`.

```bash
./scripts/deploy/deploy-lxd.sh        # crea/asegura contenedores, BD, app y proxy
./scripts/deploy/deploy-lxd.sh --update-code  # solo código: copia repo → npm ci → typecheck → restart (sin recrear contenedores)
curl -s http://localhost:3000/health  # {"ok":true,...}
```

## 5. INC-002 — Conversational request intake with preview and human approval

Flujo implementado (según `INC-002`, AC-004..AC-007, FLOW-001/002/003):

1. **Canal** (`src/channels/`): `ChannelAdapter` (interfaz) + `TelegramAdapter` (real con `TELEGRAM_BOT_TOKEN`, fetch a Bot API; `parseUpdate` TENTATIVA) + `SimulatedChannel` (funcional para E2E/piloto). Registro por `CHANNEL_PRIMARY`; sin token ⇒ simulado (DEC-026). **El canal no sustituye identidad** (RULE-001): la identidad/tenant la resuelve la capa de sesión INC-001.
2. **Intake** (`src/conversation/pipeline.ts`): normaliza → resuelve actor/tenant (sesión) → clasifica intención (FLOW-001) → audita → enruta.
3. **Clasificador** (`src/conversation/classifier.ts`): DETERMINISTA por reglas/keywords en español (TENTATIVA, iterable), traduce la matriz de autonomía del canon: `read_only` (RULE-002), `draft` (sugerencia), `preview_required` (cambio visible, RULE-003), `human_approval_required` (sensible, RULE-004), `prohibited` (inventar precios/condiciones, RULE-005).
4. **State machine** (`src/conversation/state-machine.ts`, FLOW-002): `drafted → awaiting_confirmation → confirmed → preview_ready → approved_for_publish → published | rejected | expired | failed`. Transiciones sensibles atómicas con su auditoría (fail-closed).
5. **Publicación idempotente** (AC-007): `publication.publish_key` UNIQUE por (proposal, attempt); repetir aprobación ⇒ `already_published` (audit `conversation.publish_attempt`), NUNCA duplica.
6. **Preview seguro** (CAP-008, TENTATIVA): token aleatorio (`pv_…`), SOLO hash en BD, expiración configurable (`PREVIEW_TOKEN_TTL_MINUTES`), alcance limitado a un proposal, single-use; botón **Aplicar cambios** en `POST /preview/:token/apply`.
7. **Auditoría**: toda acción emite eventos (`conversation.received/classified/answered/prohibited/proposal.created/confirmed/preview.created/approved/published/publish_attempt/rejected/expired`) con `request_id`; sin secretos (el token y las contraseñas jamás llegan a audit).

### 5.1 Jev como clasificador semántico: disabled / shadow / primary (APR-0002)

DEC-0001 (Q-CLASSIFIER = `override`, "Debe ser con TypeSave/Jev") abrió la evaluación de Jev. APR-0002 aprueba la arquitectura `MSP-JEV-CLASSIFIER-MODES v1` (`.canonflow/state/jev-classifier-modes-proposal.md`) con sus puntos de decisión: D1 escalar a aprobación humana (DEC-0028), D2 respaldo determinista (DEC-0029), D3 pedir aclaración (DEC-0030), D4 primary automático al superar la evaluación (DEC-0031) y D5 USD 1/día (DEC-0032). QS-0008 sustituye en parte a DEC-0031: un fallo de riesgo se mide sobre el resultado final del sistema con D1–D3 (DEC-0033) y solo un conjunto reservado v3 nuevo puede abrir primary (DEC-0034); los criterios se corrigen según DEC-0035 y DEC-0036. **DEC-0019 no acepta** enviar mensajes reales de clientes: solo salen textos de tenants sintéticos.

| Variable | Default | Regla |
|---|---|---|
| `JEV_MODE` | `disabled` | `disabled` \| `shadow` \| `primary`. Con `disabled` no se construye cliente ni sale nada. `JEV_ENABLED` y `JEV_SHADOW_MODE` ya no existen: si están definidas, el arranque falla. |
| `JEV_PROVIDER` | — | Con `shadow`/`primary` debe ser exactamente `typesafe` (explícito, sin fallback; nunca se cambia de proveedor ante un fallo). Otro valor ⇒ el arranque falla. |
| `TYPESAFE_API_KEY` | — | Requerida (no vacía) con `shadow`/`primary`. Nunca se loguea, audita, persiste ni aparece en mensajes de error. |
| `JEV_MODEL` | alias del proveedor (`jev-latest`) | Modelo solicitado; cada fila guarda además el modelo versionado que respondió. Se recomienda fijar uno versionado. |
| `JEV_DATA_SCOPE` | `synthetic` | Único valor válido (DEC-0019). |
| `JEV_SYNTHETIC_TENANTS` | — | Requerida con `shadow`/`primary`: tenants con datos sintéticos (p. ej. `client_a,client_b`). Los demás se procesan como `disabled` y su auditoría lleva `jev_skipped=data_scope`. |
| `JEV_DAILY_BUDGET_USD` | `1` | `0 < valor ≤ 1` (DEC-0032). Libro por proceso y día UTC, sembrado desde la BD (clasificaciones + evaluaciones); agotado ⇒ D2. |

- **Flujo** (`src/conversation/jev-classifier.ts`, cliente en `src/jev/`): una llamada con dos preguntas Choice, `intent` (los 8 intents de `classifier.ts` + `other`) y `capability_target`; `actionClass` se deriva en código con la tabla del determinista. Un intento, deadline 10 s, máx. 16 llamadas simultáneas por proceso, mensajes de hasta 8 KiB.
  - `shadow`: decide `classifyIntent`; Jev se evalúa **sin await** y solo deja evidencia.
  - `primary`: si la **última** evaluación de `(política, JEV_MODEL, bytes del conjunto reservado, bytes del código que decide)` en `jev_evaluation_run` está calculada con la definición `final_outcome` y cumple los umbrales (≥ 200 casos, ≥ 90 % de acierto del intent de Jev, 0 fallos de riesgo; recalculados en código, caché 60 s), Jev determina la clasificación con la política pura `decidePrimary`: D2 (no disponible, error, presupuesto o modelo resuelto no evaluado ⇒ determinista marcado) → D1 (discrepancia que involucra prohibited o human_approval_required ⇒ aprobación humana) → D3 (`other` o probabilidad < 0,70 ⇒ aclaración). D1 va antes que D3 por ser la salida más conservadora. Con el gate cerrado, `primary` se comporta como `shadow` (`primary_gated`).
  - El backend conserva identidad, tenant, RBAC, cuotas, preview/confirmación, aprobación humana, bloqueo y auditoría: Jev nunca ejecuta, aprueba ni publica.
- **Auditoría**: `conversation.classified` añade el origen al `result` (`<intent>:<clase>;source=deterministic|jev|deterministic_fallback|human_escalation`, más `;jev=<motivo>` o `;jev_skipped=data_scope`).
- **Evaluación (gate D4)**: `jev-intent-eval-set.v1.json` (`dev`) sirve para ajustar los criterios; `jev-intent-eval-set.v3.json` (`gate`, DEC-0034) lo escribió un agente separado sin acceso a v1, v2 ni a sus resultados, no comparte mensajes con ellos y es el único que abre `primary`. `jev-intent-eval-set.v2.json` (gate anterior, 6 fallos con la definición de Jev solo) se conserva solo como evidencia de RUN-0004. Para cada caso la evaluación calcula las reglas deterministas y el resultado final con `decidePrimary`; un **fallo de riesgo** (DEC-0033) es un caso etiquetado prohibited o human_approval_required cuyo resultado final no es bloqueo, aprobación humana ni aclaración (`isContained`). La cifra de Jev solo se guarda como información (`jev_risky_misses`), junto con las rutas de decisión (carga de escalados de D1). El gate exige los bytes exactos del conjunto y de `classifier.ts` + `jev-classifier.ts`: cambiar las reglas, los criterios o la política invalida los aprobados. `npm run jev:evaluate` evalúa el conjunto `gate` con TypeSafe real (presupuesto D5) y guarda métricas por intent, matriz de confusión, rutas de decisión y resultado por caso en `jev_evaluation_run`; si supera los umbrales, `primary` se abre solo. `-- --set=dev` evalúa el conjunto de desarrollo (se guarda, nunca abre el gate). `-- --mock` usa el proveedor simulado, sin red ni persistencia (solo prueba el cableado). Política vigente: `intent-classifier-v3` (v2 más DEC-0035: las preguntas informativas sobre las condiciones de MainSpot son consultas; y DEC-0036: una queja sin petición concreta pide aclaración).
- **Datos que salen**: solo el **texto del mensaje** de tenants de `JEV_SYNTHETIC_TENANTS` más las preguntas fijas, hacia `https://api.typesafe.ai/v1/systemone`. No se envían tenant, actor, nombres ni tokens. **No se asume ZDR** (zero data retention) del proveedor.
- **Evidencia** (`jev_classification`, tenant-scoped): ver la migración 0012. No guarda más datos sensibles que `conversation_request.raw_message`; la retención de conversaciones (DEC-0021, §10.1) pone sus cuerpos raw a `NULL` a los 90 días.
- **Apagado**: con Jev habilitado, `SIGTERM`/`SIGINT` esperan las clasificaciones pendientes de persistir. `npm start` no carga `.env` por sí mismo (usar el entorno del proceso, `docker compose` o `node --env-file=.env`).

### 5.2 AI Core (issue #9) — IA generativa gobernada

Un único despachador (`src/ai/`) con casos de uso, prompts y rutas versionados, rollout por entorno con canary
y rollback sin redeploy, evaluaciones antes de aprobar, presupuestos con techo duro y trazas con costo del
proveedor. Sobre él: Mi marca, Biblioteca, página con IA (diseño y edición con vista previa y aprobación),
publicaciones de Facebook, atención con Jev + ledger único de respuestas, asistente con herramientas de solo
lectura, campañas sin gasto, calendario editorial y resumen. Consolas de plataforma con MFA y step-up:
`/plataforma` (Administration) y `/ingenieria` (Engineering Console). Proveedores reales solo con
`AI_REAL_PROVIDERS=on` y negocios clasificados `synthetic`. Operación, rutas activas, estado GO/NO-GO y
bloqueos: [`docs/architecture/ai-core.md`](docs/architecture/ai-core.md); resultados E01–E20:
[`AI-CORE-RESULTS.md`](docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-RESULTS.md).

## 6. INC-003 — Website administration + dominio subdominio MainSpot (modo simulado)

- **WebsiteService** (`src/website/`): plantilla estática XSS-safe con datos de negocio (nombre, giro, servicios, horarios, contacto); render determinista; **editor asistido por LN** (`edit-mapper.ts`, TENTATIVA/básico): "cambia el teléfono a …", "agrega la sección servicios", "agrega un servicio llamado …", etc. → parche estructurado → propuesta del INC-002.
- **Publicación** (`src/publishing/website.ts`): solo tras aprobación humana (RULE-003); renderiza y persiste `website_content` versionado + `client_website.published_version`.
- **Dominio** (`src/domain/`): `DomainProvider` + `SimulatedHostinger` (subdominio `<slug>.sim.mainspot.local`, DNS CNAME y certificado simulados, determinista e idempotente) + `HostingerAdapter` (real, SOLO con `HOSTINGER_API_TOKEN`). Al publicar se garantiza la provisión (FLOW-006); también por endpoint.
- **Preview público**: `GET /preview/:token` renderiza el sitio propuesto; aplicar publica.
- **DEV-E2E-04**: restauración como versión nueva mediante vista previa/aprobación y sitios HTTPS locales por negocio, comprobados en Chrome con CA local. [Modelo, operación y límites del proxy](docs/architecture/website-restore-local-sites.md).
- **Contraseña**: recuperación con token de un uso, revocación de sesiones y SMTP/Resend reales implementados; entrega externa bloqueada hasta disponer de proveedor autorizado. [Contrato y configuración](docs/architecture/password-reset.md).

## 7. INC-004 — Reputación y reseñas (CAP-002/CAP-004, DEC-011/023/026)

- **Adaptador**: `ReputationProvider` con `SimulatedReviews` explícito o conector GBP en `src/google/` por conexión OAuth cifrada de cada negocio. `REPUTATION_PROVIDER=google_business_profile` no cae a simulación ante falta de acceso. Ficha parcial con lectura posterior, reseñas paginadas, respuestas confirmadas y retención específica: [conectores reales](docs/architecture/real-provider-connectors.md). Verificación externa pendiente de credenciales/autorización; no se declara Google real verificado.
- **Engine** (`src/reputation/engine.ts`): ingesta idempotente → clasificación (`>=4 positive`, `==3 neutral`, `≤2 negative`) → enrutamiento por `REVIEW_THRESHOLD` (DEC-023, default 4 ⇒ `<4` escala). Estados FLOW-004: `detected → suggested → awaiting_human → approved → published | rejected`, con `edited` para borradores corregidos y `acknowledged` para positivas (sin publicación). Sugerencia determinista de **3 borradores** (sin inventar descuentos/precios, RULE-005).
- **Respuesta pública** = cambio visible (DEC-011): al aprobar la respuesta se crea una propuesta `capability_target='reputation'` del flujo INC-002 → **preview → aprobación → publica UNA vez** (publisher idempotente `src/reputation/publisher.ts`). Editar respuesta SOLO en borrador (antes de aprobar); después de publicado ⇒ 409 `prohibited`. **Sin manipulación**: ocultar/borrar reseñas está BLOQUEADO (permiso `reputation.hide_review` deny para todos; 403 + audit deny).

## 8. INC-005 — Facebook publicaciones y Ads (CAP-003, DEC-017/026)

- **Adaptador** (`src/social/`): `SimulatedMeta` explícito o `MetaPagesAdapter` con Page/token cifrado por negocio, Graph versionada y read-back de posts/respuestas. No hay token global ni fallback real→simulado. Ads básicos sin cuenta publicitaria autorizada: `BLOCKED_EXTERNAL` separado; el chequeo disponible es solo lectura.
- **Servicio**: borrador → aprobación → cola durable → publicación confirmada. El scheduler del servidor ejecuta las aprobadas sin pestaña ni tick manual; claims `SKIP LOCKED`, leases, backoff y reconciliación por id externo conocido. Una escritura incierta sin id requiere revisión humana, no reenvío ciego. [Configuración, estados y recuperación](docs/architecture/real-provider-connectors.md).
- **Gate de aprobación (PR-01, Reviewer)**: el tick SOLO publica filas con evidencia de aprobación (propuesta `published`/`approved_for_publish` + fila de `publication`); sin aprobación marca la fila `blocked` con auditoría deny (`social.published`/`not_approved`) y NUNCA publica. `updateStatus()` impide llegar a `published` desde un estado no aprobado (exige `scheduled`). Endpoints `approve` con rate limiting (PR-06).
- **Fuera del MVP**: campañas avanzadas e Instagram (permiso `social.campaign_advanced` deny para todos; intento ⇒ 403 + audit deny).

## 9. INC-006 — Suscripciones y límites (CAP-012, DEC-024)

- **Catálogo CONFIGURABLE en BD** (`plan`, `plan_limit`, `subscription`): plan **"Piloto 1"** único sin precio + planes opcionales sin precio (RULE-006). Una suscripción activa por tenant (seed para los 2 tenants).
- **EntitlementService** (`src/subscriptions/entitlements.ts`): asignar plan (admin), consultar entitlements (los 3 perfiles), conteo de uso por capacidad y mensajes de límite.
- **QuotaLedger** (`src/subscriptions/quota.ts`, DEC-0005 + NFR-0001): la comprobación y el consumo de cuota son **atómicos por tenant**. Uso = filas de dominio + unidades reservadas vigentes, leído bajo `pg_advisory_xact_lock(tenant, capacidad)`: las operaciones concurrentes del mismo tenant y capacidad se serializan y nunca superan el límite; los demás tenants no comparten candado ni filas. Exceso ⇒ **403 `limit_exceeded`**; sin plan activo ⇒ 403 `subscription_required` (fail-closed; la ruta audita el deny).
  - **Un paso** (`consumeInTx`): candado, comprobación, creación del recurso, fila `committed` y evento `quota.consumed` en la MISMA transacción (si la auditoría falla, no queda ni el recurso ni el consumo).
  - **Dos pasos** (`reserve` → `commitInTx` | `release`) cuando hay trabajo externo en medio (clasificación Jev): la reserva aparta la unidad 120 s (`quota.reserved`); se confirma con la solicitud persistida o se devuelve (`quota.released`). Si el proceso cae a mitad, la reserva deja de contar al vencer y la **reconciliación** (cada 60 s en el servidor; `quota.expired`, actor `system:quota-reconciler`) la cierra e informa del uso por encima del límite (p. ej. tras un cambio de plan), sin borrar nada.
  - **Idempotencia**: cabecera opcional `Idempotency-Key` (1–128 caracteres `A-Za-z0-9._:-`) en `POST /conversation/messages`, `POST /website` y `POST /social/posts`. Repetir la clave devuelve el resultado original con **200 `replayed: true`** sin consumir otra vez (los mensajes no se reenvían por el canal); repetirla mientras la primera sigue en curso ⇒ **409 `request_in_progress`**; tras un fallo la misma clave puede reintentarse. Sin cabecera, la clave es el `request_id` (sin deduplicación). Las claves son por tenant.
- **Enforcement por capacidad**:
  - `conversations` — reserva en `pipeline.ingest()` antes de clasificar; consumo en la transacción que persiste la solicitud.
  - `website` — `POST /website`: un paso; un sitio por tenant (UNIQUE) + 409 si ya existe (revierte también el consumo). La provisión de dominio/publicación NO cuenta como creación.
  - `social_posts`/`social_ads` — `social.createDraft`: un paso.
  - `reviews_managed` — `reputation.sync`: el lote se mide y se consume entero bajo el candado, en la transacción de las inserciones (sin estado parcial).
  - `agents` — SIN enforcement (DEC-0006: no existe creación de agentes todavía). Ver §15.
- **Política sin plan (PR-02, decisión del owner)**: **DENY 403 `subscription_required`** en toda operación que CREA recursos (mensajes, posts, reseñas, sitios, facturación); las lecturas (entitlements, data.read, listados, analítica de lectura) siguen permitidas. Documentada en §15.
- **Pago** (`src/subscriptions/payment.ts`): `PaymentProvider` abstracto + `SimulatedPaymentProvider` (siempre ok, sin llamadas externas). `POST /subscriptions/invoice` con plan SIN precio ⇒ **PROHIBITED** + audit deny (`no_price_prohibited`). El piloto NO cobra.

## 10. INC-007 base — Analítica mínima + export ETL (CAP-014 base, DEC-025)

- **ExportService** (`src/analytics/export.ts`): exporta eventos de auditoría por tenant con filtros `from/to/action`, formato JSON/CSV, paginación (page/page_size, `has_more`), auditoría del exporte.
- **Retención**: ya no hay purga manual ni `RETENTION_DAYS`; la aplica la retención global automática (§10.1).
- **Agregados** (`src/analytics/summary.ts` + `analytics_daily_summary`): contadores por día/acción/resultado con SELECT en vivo; `refresh-summary` materializa (upsert idempotente). **Dashboards completos, ETL externo y research/recomendaciones son INC-007 fase 2 (fuera de este bloque).**

### 10.1 Retención global, baja y anonimización (QS-0006: DEC-0021..DEC-0027)

`src/retention/service.ts` (`RetentionService`). Plazos fijos por decisión (no configurables):

| Dato | Plazo | Qué hace la purga |
|---|---|---|
| Contenido conversacional (DEC-0021) | 90 días desde `conversation_request.created_at` | Mensaje → texto fijo de "contenido eliminado", respuesta → `NULL`; propuestas de esa solicitud: resumen → texto fijo, `detail` → `{}`, las abiertas pasan a `expired` (ya no se pueden aplicar); `jev_classification.raw_request/raw_response` → `NULL`. Se conservan intención, clase, estado y fechas |
| Auditoría (DEC-0022) | 2 años (`audit_event.ts`) | Borrado |
| Agregados de analítica (DEC-0023) | 2 años (`analytics_daily_summary.day`) | Borrado |
| Registro de anonimizados | 30 días (respaldos de 14 días + margen) | Borrado de la huella |

- **Ejecución automática diaria (DEC-0025)**: el servidor comprueba cada 15 min y, a partir de las 03:00 UTC, corre una ejecución `scheduled` por día UTC (candado consultivo entre procesos; una ejecución interrumpida queda `running` y se reintenta; una con fallos no se repite hasta el día siguiente y la purga por plazo recupera lo pendiente). Cada tenant va en **su propia transacción con su evento `retention.purged`** (conteos, actor `system:retention`, NFR-0001); si el evento no se puede escribir, ese tenant se revierte y los demás siguen. `retention_run` guarda el informe (solo totales, sin ids de tenant).
- **Manual**: `npm run retention:run -- --dry-run` (informe sin cambios) o `npm run retention:run`; `GET /api/backoffice/analytics/retention` muestra la vista previa por tenant.
- **Baja (DEC-0024/DEC-0027)**: la decide una persona; el vencimiento de una prueba **no** es una baja. `npm run tenant:exit -- confirm --tenant=<id> --by=<operador> [--export-dir=<dir>]` exporta primero los datos del negocio (JSON 0600, sin `password_hash` ni `token_hash`; por defecto `MAINSPOT_EXPORT_DIR` o `/var/lib/mainspot/exports`, fuera del directorio que reemplaza el despliegue) y luego, en una transacción: `tenant_exit` con el sha256 del export, cliente `exiting` (sin login ni sesiones vigentes), suscripción `cancelled` y evento `tenant.exit_confirmed`. `npm run tenant:exit -- status --tenant=<id>` la consulta.
- **Anonimización (≥ 30 días después, en la ejecución diaria)**: una transacción por tenant: cliente nuevo `anon_<uuid>` (`Negocio anonimizado`, estado `anonymized`); agregados y auditoría pasan a ese id, con actores y `request_id` sustituidos por tokens aleatorios sin correspondencia guardada (se conservan los actores `system:*`), `resource` reducido a su tipo y `evidence_ref` a `NULL`; se borran todas las filas operativas del tenant (orden compatible con las FK) y se registra `anonymized_tenant` (sha256) y `tenant.anonymized`. **Antes de confirmar** se verifica que ningún identificador técnico o de contacto (id del tenant, correo, ids y logins de usuarios, slug, subdominio, ids de solicitud, request_id propios) aparece en **ninguna** columna de texto/JSON de la base, y que los nombres (negocio, personas, sitio) no quedan en lo que se conserva; si algo aparece, se revierte todo, la ejecución queda `failed` y el log nombra la tabla y columna (nunca el valor). Una mención del tenant en datos de otro bloquea su anonimización hasta resolverla.
- **Respaldos (DEC-0026/DEC-0027)**: tras restaurar, `npm run retention:run -- --reapply-exits` vuelve a anonimizar los tenants cuya huella está en el registro restaurado; si se restaura un respaldo **anterior** al más reciente, primero `npm run retention:run -- --export-registry > registry.json` sobre la base más reciente disponible (o una copia restaurada del último respaldo) y después `--reapply-exits --registry=registry.json`. Un respaldo previo a la migración 0015 necesita migrar antes (`npm run migrate`). `scripts/ops/backup/db-restore-test.sh` ejecuta la re-aplicación en cada prueba mensual.

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
# Escribe evidence/e2e-inc002-inc003.txt, evidence/e2e-inc004-006.txt, evidence/e2e-dev-e2e-02.txt
# (servidor real, CLI de alta y worker independiente) y evidence/e2e-dev-e2e-03.txt
# (interfaz de Claude en Chrome headless vía playwright-core por https://app.mainspot.local.io contra
#  servidor + PostgreSQL reales; usa /usr/bin/google-chrome o CHROME_PATH; EVIDENCE_SCREENSHOTS=1
#  guarda capturas en evidence/dev-e2e-03/). E2E_BASE_URL cambia el origen; la prueba arranca su
#  servidor como upstream del proxy (E2E_UPSTREAM_PORT=3100): detén mainspot-local.service mientras corre y arráncalo después.
```

### DEV-E2E-03 — interfaz de Claude Design conectada al backend (desarrollo)

Origen oficial de desarrollo: **https://app.mainspot.local.io** (panel `/panel`, invitaciones `/invitacion#<TOKEN>`). Lo sirve el nginx del LXC `webserver` (10.209.99.101) con certificado de la CA local, como proxy al proceso de MainSpot en el puerto interno 3100 del host. La instalación de hosts/proxy/TLS se hizo una sola vez con `scripts/dev-domain-bootstrap.sh` (evidencia `evidence/dev-domain-bootstrap.txt`); el arranque diario no la toca.

```bash
sudo systemctl start mainspot-local.service                        # PostgreSQL en 127.0.0.1:55432 (BD mainspot_dev),
                                                                  # servidor + un único worker persistente detrás del dominio
scripts/dev-panel.sh invite "Panadería Lupita" lupita@example.com # imprime https://app.mainspot.local.io/invitacion#… (un solo uso, 72 h)
```

Abre el enlace: invitación → contraseña → datos del negocio (crea la página y su primera versión con vista previa) → Telegram simulado → panel. Después se entra en `https://app.mainspot.local.io/` con correo + contraseña (sin id de cliente). La interfaz es la del prototipo `docs/ux/claude-design/deliverables` (referencia intacta) adaptada en `src/web/panel` para leer y escribir solo por la API (`/api/auth/*`, `/api/backoffice/*`); localStorage solo guarda qué avisos se leyeron. En desarrollo aparecen el simulador de reseñas/comentarios (Atención) y un chat de Telegram simulado, ambos deshabilitados en producción. El simulador invoca el servicio de Telegram directamente; el webhook externo exige secreto incluso en desarrollo. Google y Meta siguen simulados; Telegram también por defecto, con activación real explícita y credenciales protegidas, todavía sin certificación de entrega real.

Otros modos: `node scripts/invite-owner.ts …` con `npm start` (puerto 3000), y `ENGAGEMENT_WORKER=off npm start & node scripts/engagement-worker.ts` para el worker como proceso propio. Decisiones y shape de API: `docs/handoffs/e2e-parallel-2026-10-29/DECISION-LOG.md`.

### Telegram — receptor persistente Starlink

El endpoint público es `https://tg.mainspot.io/telegram/webhook`: KVM → WireGuard → proxy exclusivo `10.77.0.2:8080` → Express `POST /api/telegram/webhook`. El túnel no enruta Internet general. La infraestructura del panel y sus certificados son independientes y no se reconfiguran.

Instalación, recuperación y estados de aceptación: [runbook Telegram](docs/architecture/telegram-webhook-starlink.md). Arranque persistente de Express y worker: [servicio local](scripts/deploy/README-mainspot-local.md). Nunca lanzar otro `scripts/dev-panel.sh` mientras `mainspot-local.service` esté activo.

`TELEGRAM_WEBHOOK_SECRET` vive fuera de Git en `~/.config/mainspot/telegram-webhook.env` (0600). Sin secreto el webhook devuelve 503; con cabecera ausente o incorrecta, 401. La existencia de esta instalación no acredita `INFRASTRUCTURE_READY` ni `TELEGRAM_WEBHOOK_REAL_VERIFIED`: consultar evidencia y bloqueos del runbook.

## 12. Evidencia reproducible (AC-009)

```bash
npm run evidence   # bash scripts/capture-evidence.sh
```

La salida real queda en `evidence/` (00-14): environment, typecheck, permission matrix, unit, db, integration, denied log, audit exports (por tenant), smoke, **13-e2e-inc002-inc003.txt** y **14-e2e-inc004-006.txt** (transcripts E2E), rollback, summary. Regla `06-ACCEPTANCE-EVIDENCE.md`: la evidencia no se basa en afirmaciones.

## 13. Rollback (AC-009)

1. Deshabilitar aprobaciones/publicaciones: `npm run rollback:simulate` revoca sesiones activas; ningún token previo sigue siendo válido.
2. Marcar previews pendientes como expired y conservar el intake read-only (rollback mínimo INC-002): `UPDATE preview_session SET status='expired' WHERE status='active'; UPDATE action_proposal SET status='expired' WHERE status IN ('confirmed','preview_ready');` — las consultas `read_only` siguen funcionando (FLOW-003).
3. Preservar auditoría: `audit_event` solo se borra por la retención automática a los 2 años (DEC-0022) y solo se re-etiqueta al anonimizar una baja (DEC-0024).
4. Revertir código: `git revert` del commit de la tanda. La matriz RBAC vive en `src/rbac/matrix.ts` (migraciones espejo 0006/0007/0008/0009/0010/0015).

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
| **INC-007 base** (DEC-025) | `analytics/` (export/summary) | `tests/integration/analytics-inc007.test.ts`, `tests/unit/analytics.test.ts` |
| **QS-0006** retención, baja y anonimización (DEC-0021..0027) | `retention/service.ts` + `scripts/retention-run.ts` + `scripts/tenant-exit.ts` + ejecución diaria en `api/server.ts` + migración 0015 | `tests/integration/retention.test.ts` (plazos y límites, dry-run, NFR-0001 por tenant, programación diaria concurrente, baja con export, anonimización sin rastros, reversión si queda un rastro, re-aplicación tras restaurar y caducidad del registro) |
| **DEC-0005** cuotas atómicas + **NFR-0001** | `subscriptions/quota.ts` (`QuotaLedger`) + rutas y servicios que consumen cuota + migración 0014 | `tests/integration/quota-toctou.test.ts`, `tests/integration/nfr-0001-atomicity.test.ts` |
| **APR-0002** Jev disabled/shadow/primary (D1–D5) | `conversation/jev-classifier.ts` + `jev-repository.ts` + `jev-evaluation.ts` + `scripts/jev-evaluate.ts` + `jev/` + `pipeline.ts` + `jev_classification`/`jev_evaluation_run` | `tests/unit/jev-classifier.test.ts`, `tests/unit/jev-evaluation.test.ts`, `tests/unit/config.test.ts`, `tests/integration/jev-classifier.test.ts` |
| **PR-03** sync atomic | `reputation/engine.ts` (lote medido y consumido bajo el candado de `QuotaLedger`, en la transacción de las inserciones) | `tests/integration/subscriptions-inc006.test.ts` |

## 15. Decisiones TENTATIVA (a validar/cerrar; el canon no las fija)

| Tema | Decisión tomada | Marca |
|---|---|---|
| Clasificador de intención | DETERMINISTA por reglas/keywords en español; Jev puede determinar la clasificación en `JEV_MODE=primary` tras superar la evaluación sintética (APR-0002, §5.1), con el determinista como respaldo (D2) y contraste de seguridad (D1) | TENTATIVA e iterable (umbral D3 a recalibrar con la evaluación) |
| Canal Telegram real | `TelegramAdapter` con fetch a Bot API; webhook autenticado y vínculo chat→persona→tenant implementados. Transporte KVM/WireGuard y receptor persistente instalados; entrega auténtica pendiente de bot autorizado | TENTATIVA: ver runbook Telegram |
| Enlace de preview | token aleatorio alto entropía, hash SHA-256 en BD, expiración configurable, single-use, alcance `proposal_publish` | TENTATIVA (canon 05: audiencia/revocación pendiente) |
| Publisher | contrato genérico `Publisher` (reutilizando INC-003/004/005) con `WebsitePublisher`/`ReputationPublisher`/`SocialPublisher`; `StubPublisher` como fallback | TENTATIVA |
| Subdominio simulado | `<slug>.sim.mainspot.local` determinista; DNS CNAME + certificado simulados; idempotente | TENTATIVA (DEC-026) |
| Hostinger real | adaptador esqueleto FLOW-006 con fetch; sin credenciales NO se llama; no probado | TENTATIVA |
| Edición asistida de web | mapeo determinista de comandos comunes (sin generativo) | TENTATIVA e iterable |
| Aprobaciones | solo `administration` (`operation.approve/reject`, `reputation.approve`, `social.approve` admin-only) | TENTATIVA |
| Umbral de reseñas | `REVIEW_THRESHOLD` configurable por env, default `<4` (DEC-023); el valor definitivo queda para investigación con datos (Q-013) | TENTATIVA (decisión con dato diferida) |
| Sugerencia de respuesta | plantillas deterministas (3 borradores, sin generativo); sin inventar hechos comerciales (RULE-005) | TENTATIVA e iterable |
| Revisión de Google/API Meta reales | esqueleto con fetch; mapeo exacto a endpoints sin validar; sin credenciales NO se llaman | TENTATIVA |
| Límites por capacidad | enforcement en el punto de creación: `conversations` (ingesta), `website` (creación de sitio), `social_posts`/`social_ads` (crear borrador), `reviews_managed` (ingesta con validación de lote); comprobación y consumo atómicos por tenant con reserva idempotente (`QuotaLedger`, §9) | Decidido (DEC-0005) |
| `agents` sin enforcement | no existe creación de agentes en esta tanda: el límite se muestra en entitlements pero no se verifica en ninguna operación (futuro INC agente) | TENTATIVA (deuda registrada) |
| Política sin plan | **DENY 403 `subscription_required`** en toda operación que CREA recursos (mensajes/posts/reseñas/sitios/facturación); lecturas permitidas — decisión PR-02 de owner | TENTATIVA (configurable con plan "libre" si el piloto lo pide) |
| Sync de reseñas (PR-03) | validación de capacidad del LOTE antes de insertar + ingesta y auditoría en UNA transacción (sin estado parcial) | TENTATIVA (mejora del ítem anterior) |
| Retención/analítica | retención global automática diaria con plazos fijos, baja con exportación y anonimización verificada (§10.1); dashboards = fase 2 | Decidido (DEC-0021..DEC-0027) |
| `website.publish` (permiso) | reservado en matriz para endpoints de publicación operativa futura; sin ruta expuesta en esta tanda | TENTATIVA |

## 16. Seguridad y notas operativas (INC-001 + INC-002..007)

- **Fail-closed**: sin contexto ⇒ deny; **canales no son identidad**; **publicar/confirmar/aprobar requieren permiso**; acciones sensibles y su audit son atómicas (ROLLBACK conjunto). Acciones bloqueadas (`reputation.hide_review`, `social.campaign_advanced`) no se conceden a NINGÚN rol.
- **Gate de aprobación social (PR-01)**: la cola `scheduled_post` solo existe tras aprobación humana (`proposal_id` + `status='scheduled'`); el tick verifica evidencia de publicación por fila y bloquea las que no la tengan (audit deny `not_approved`). `updateStatus` impide `→ published` sin estado previo `scheduled`.
- **Anti-oráculo (IR-01)**: propuestas/requests/reseñas/publicaciones de otro tenant responden 404 idéntico (la ruta de aprobación cross-tenant devuelve 404 igual que inexistente y audita `not_found`).
- **Auditoría sin secretos**: tokens de preview (hash), contraseñas y credenciales de integraciones jamás se persisten/loguean; el sink y logger rechazan campos con nombre sensible.
- **Sin llamadas HTTP reales sin token**: los adaptadores Meta/Google/Hostinger solo se instancian con credenciales; por defecto el sistema usa simuladores deterministas (DEC-026). Jev/TypeSafe solo se contacta con `JEV_MODE=shadow|primary` + `JEV_PROVIDER=typesafe` + `TYPESAFE_API_KEY`, solo para tenants de `JEV_SYNTHETIC_TENANTS` y dentro del presupuesto diario (§5.1); los tests simulan `fetch` y nunca usan la red.
- **No manipulación de opiniones**: no existe endpoint efectivo para ocultar/borrar reseñas; el intento se bloquea y audita como deny.
- **Rate limiting**: login (IR-06) y aprobación/rechazo sensibles (IP + operador + propuesta; `APPROVAL_RATE_LIMIT_*`) — incluye `approve` de reputación y social que generan propuestas (PR-06).
- **JWT_SECRET (IR-02)**: requerido fuera de `test`; sin default en código/compose.
- **Modo simulado determinista**: `SimulatedHostinger`, `SimulatedChannel`, `SimulatedReviews` y `SimulatedMeta` no usan aleatoriedad (pinned) ⇒ E2E reproducible; la única aleatoriedad es la de tokens/IDs (no afecta el flujo).
- **Nunca subir `.env`**; `.env.example` es referencia con placeholders.

## 17. Out of scope (recordatorio)

No pagos/precios/planes aprobados (DEC-024: solo infraestructura sin cobro; `invoice` PROHIBITED); no campañas avanzadas de redes ni Instagram (DEC-017); no Google Business Profile real sin credenciales (simulado determinista); no API Meta real sin token (simulado); no dashboards completos/research de analítica (INC-007 fase 2); no webhook real de Telegram verificado (el chat del panel es simulado); no Hostinger real sin credenciales; sin recuperación de contraseña ni restauración de versiones anteriores de la página en la interfaz.
