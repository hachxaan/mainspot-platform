# MainSpot Platform — INC-001 · INC-002 · INC-003

**Identidad/aislamiento/auditoría (INC-001) + ingestión conversacional con preview y aprobación humana (INC-002) + web administrable y dominio subdominio simulado (INC-003).**

Implementación de los contratos canónicos:
- [`INC-001`](https://github.com/hachxaan/mainspot-documentation/blob/main/implementation/increments/INC-001-client-identity-isolation-audit.md) (baseline `CANONICAL_BASE_APPROVED_v0.1`)
- [`INC-002`](https://github.com/hachxaan/mainspot-documentation/blob/main/implementation/increments/INC-002-conversational-preview-approval.md) — flujo conversacional (canal Telegram/simulado), clasificación de intención, confirmación → preview → aprobación humana → publicación idempotente (AC-004..AC-007).
- `INC-003` — página web administrable (web en el entorno del cliente, DEC-017) con edición asistida por lenguaje natural (básica) y aprovisionamiento de subdominio MainSpot en modo simulado (DEC-019/DEC-026, FLOW-006).

Stack (gate humano 2026-08-19): **TypeScript (Node ≥ 24, type-stripping nativo) + PostgreSQL 16 + sesión/JWT propio mínimo + Docker Compose local**. Aislamiento **LÓGICO por cliente** (`DEC-018`: `tenant_id` + contexto + fail-closed). Integraciones externas bajo `DEC-026`: interfaz de adaptador + implementación real opcional + **modo simulado funcional** (E2E y piloto sin credenciales externas).

> ⚠️ **Estado**: piloto de implementación. Las decisiones técnicas no cerradas por canon se marcan **TENTATIVA** más abajo y deben validarse/cerrarse antes de producción.

---

## 1. Estructura del monorepo (por capas, DEC-022)

```
mainspot-platform/
├── src/
│   ├── identity/    C1  modelo de cliente/tenant, usuario interno, rol, sesión
│   ├── boundary/    C2  resolución tenant+actor, middleware fail-closed, capa de datos con scope forzado
│   ├── rbac/        C3  matriz declarativa rol×contexto×acción + motor de chequeo
│   ├── audit/       C4  evento mínimo, sink fail-closed, consulta/export con correlación
│   ├── hooks/       C5  contratos INC-001 (resolve_identity / check_authorization / audit_sink)
│   ├── channels/    INC-002 adaptador de canal (Telegram real opcional + SimulatedChannel funcional, DEC-026)
│   ├── conversation/INC-002 clasificador determinista (TENTATIVA), pipeline de ingesta, repos, state machine FLOW-002
│   ├── publishing/  contrato Publisher genérico (reutilizable INC-003/005) + StubPublisher + WebsitePublisher
│   ├── website/     INC-003 plantilla de sitio (XSS-safe), editor asistido por LN (básico), repositorio
│   ├── domain/      INC-003 DomainProvider (Hostinger real opcional + SimulatedHostinger, DEC-019/026)
│   ├── api/         API HTTP mínima + UX + rutas conversacionales + preview público
│   ├── db/          pool PostgreSQL
│   └── shared/      config, logger estructurado, contexto por request (ALS), JWT propio, errores
├── migrations/      0001_schema + 0002_seed + 0003_login_unique + 0004_conversation_preview
│                    0005_website_domain (incluye seed de sitios) + 0006_permissions
├── scripts/         migrate / seed / db-setup / test-prep / matrix / export-audit / rollback / evidence
├── tests/           unit (sin DB) · integration (con DB + 2 tenants) · smoke · e2e (canal simulado)
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
- El runner registra archivos en `schema_migrations` con advisory lock (replay seguro). Seed 0002 + sección de seed de 0005 idempotentes.

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

## 7. Validaciones (AC-001/002/003/004/005/006/007/009)

```bash
npm run typecheck         # tsc --noEmit
npm run test:unit         # unit sin DB (RBAC, JWT, audit, classifier, website, publishing, ratelimit)
npm run test:integration  # recrea mainspot_test + aislamiento, RBAC, auditoría, INC-002 (AC-004..007), INC-003
npm run test:smoke        # smoke AC-009 + señales UX AC-008
npm run test:e2e          # E2E INC-002+INC-003 canal simulado → evidence/e2e-inc002-inc003.txt
npm test                  # typecheck + unit + integration + smoke + e2e
```

## 8. Evidencia reproducible (AC-009)

```bash
npm run evidence   # bash scripts/capture-evidence.sh
```

La salida real queda en `evidence/` (00-13): environment, typecheck, permission matrix, unit, db, integration, denied log, audit exports (por tenant), smoke, **13-e2e-inc002-inc003.txt** (transcript E2E), rollback, summary. Regla `06-ACCEPTANCE-EVIDENCE.md`: la evidencia no se basa en afirmaciones.

## 9. Rollback (AC-009)

1. Deshabilitar aprobaciones/publicaciones: `npm run rollback:simulate` revoca sesiones activas; ningún token previo sigue siendo válido.
2. Marcar previews pendientes como expired y conservar el intake read-only (rollback mínimo INC-002): `UPDATE preview_session SET status='expired' WHERE status='active'; UPDATE action_proposal SET status='expired' WHERE status IN ('confirmed','preview_ready');` — las consultas `read_only` siguen funcionando (FLOW-003).
3. Preservar auditoría: nunca se borran `audit_event`.
4. Revertir código: `git revert` del commit de la tanda. La matriz RBAC vive en `src/rbac/matrix.ts` (migración 0006 en espejo).

## 10. Mapa AC → implementación y evidencia

| AC | Dónde se cumple | Evidencia |
|---|---|---|
| **AC-001/002/003** (INC-001) | como en el README original | `tests/integration/*` (aislamiento, RBAC, auditoría) |
| **AC-004** Sensibles bloqueadas | `classifier.ts` (RULE-004/005) + `state-machine.ts` (approve sólo con `operation.approve`) | `tests/integration/conversation-inc002.test.ts` (sensible + prohibited) |
| **AC-005** Consulta sin efecto | `pipeline.ts` (read_only) + `read-answers.ts` | `tests/integration/conversation-inc002.test.ts` AC-005 |
| **AC-006** Confirmación detallada | `pipeline.ts` (confirmationText) + `edit-mapper.ts` (diff conceptual) | AC-006 (estado `awaiting_confirmation` + texto) |
| **AC-007** Publicar solo desde preview aprobado, idempotente | `state-machine.ts` + `publication.publish_key` UNIQUE + preview single-use | AC-007 + `tests/e2e/inc002-inc003-e2e.test.ts` |
| **AC-008** UX no técnica | `ui.ts` + mensajes en `errors.ts`/rutas + `previewPageHtml` | `tests/smoke/smoke.test.ts`, `docs/UX-CHECKLIST.md` |
| **AC-009** Evidencia y rollback | `capture-evidence.sh` (+ 13-e2e) + rollback §9 | `evidence/*` |
| **INC-003 REQ-012/REQ-018** | `website/` + `domain/` + `publishing/website.ts` | `tests/integration/website-inc003.test.ts` |

## 11. Decisiones TENTATIVA (a validar/cerrar; el canon no las fija)

| Tema | Decisión tomada | Marca |
|---|---|---|
| Clasificador de intención | DETERMINISTA por reglas/keywords en español (sin ML) | TENTATIVA e iterable |
| Canal Telegram real | `TelegramAdapter` con fetch a Bot API; ingesta por webhook y mapeo canal→cliente SIN implementar (identidad resuelta por sesión) | TENTATIVA |
| Enlace de preview | token aleatorio alto entropía, hash SHA-256 en BD, expiración configurable, single-use, alcance `proposal_publish` | TENTATIVA (canon 05: audiencia/revocación pendiente) |
| Publisher | contrato genérico `Publisher` (reutilizable INC-005); `WebsitePublisher` + `StubPublisher`; efecto abstracto para acciones sensibles (descuento ⇒ stub sin efecto externo) | TENTATIVA |
| Subdominio simulado | `<slug>.sim.mainspot.local` determinista; DNS CNAME + certificado simulados; idempotente | TENTATIVA (DEC-026) |
| Hostinger real | adaptador esqueleto FLOW-006 con fetch; sin credenciales NO se llama; no probado | TENTATIVA |
| Edición asistida de web | mapeo determinista de comandos comunes (sin generativo) | TENTATIVA e iterable |
| `website.publish` (permiso) | reservado en matriz para endpoints de publicación operativa de incrementos futuros (INC-005); sin ruta expuesta en esta tanda | TENTATIVA |
| Aprobaciones | solo `administration` (`operation.approve/reject` admin-only, ya definido en INC-001) | TENTATIVA |

## 12. Seguridad y notas operativas (INC-001 + INC-002/003)

- **Fail-closed**: sin contexto ⇒ deny; **canales no son identidad**; **publicar/confirmar/aprobar requieren permiso**; acciones sensibles y su audit son atómicas (ROLLBACK conjunto).
- **Anti-oráculo (IR-01)**: propuestas/requests de otro tenant responden 404 idéntico (la ruta de aprobación cross-tenant devuelve 404 igual que inexistente y audita `not_found`).
- **Auditoría sin secretos**: tokens de preview (hash) y contraseñas nunca se persisten/loguean; el sink y logger rechazan campos con nombre sensible.
- **Rate limiting**: login (IR-06) y aprobación/rechazo sensibles (IP + operador + propuesta; `APPROVAL_RATE_LIMIT_*`).
- **JWT_SECRET (IR-02)**: requerido fuera de `test`; sin default en código/compose.
- **Modo simulado determinista**: `SimulatedHostinger` y `SimulatedChannel` no usan aleatoriedad (pinned) ⇒ E2E reproducible; la única aleatoriedad es la de tokens/IDs (no afecta el flujo).
- **Nunca subir `.env`**; `.env.example` es referencia con placeholders.

## 13. Out of scope (recordatorio)

No pagos/precios/planes; no redes sociales (INC-005 futuro; pedidos a redes quedan bloqueados con mensaje claro); no Google Business Profile; no webhook real de Telegram (solo envío con token); no Hostinger real sin credenciales; la UI sigue mínima (sustituible por frontend real en incrementos posteriores).
