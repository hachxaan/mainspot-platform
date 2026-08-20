# MainSpot Platform — INC-001

**Client identity, tenant isolation and audit foundation.**

Implementación del contrato canónico [`INC-001`](https://github.com/hachxaan/mainspot-documentation/blob/main/implementation/increments/INC-001-client-identity-isolation-audit.md) (baseline `CANONICAL_BASE_APPROVED_v0.1`, canonical_version `0.1.0`), según el plan `PLAN-INC-001` y el diseño `DESIGN-INC-001`.

Stack (gate humano 2026-08-19): **TypeScript (Node ≥ 24, type-stripping nativo) + PostgreSQL 16 + sesión/JWT propio mínimo + Docker Compose local**. Aislamiento **LÓGICO por cliente** (`DEC-018`: `tenant_id` + contexto + fail-closed) con capa de ejecución intercambiable — NO Docker/LXC por cliente en este incremento.

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
│   ├── hooks/       C5  contratos para INC-002 (resolve_identity / check_authorization / audit_sink)
│   ├── api/         API HTTP mínima + UX backoffice en lenguaje claro (AC-008)
│   ├── db/          pool PostgreSQL
│   └── shared/      config, logger estructurado, contexto por request (ALS), JWT propio, errores
├── migrations/      0001_schema.sql + 0002_seed.sql (2 tenants, 3 roles, usuarios simulados)
├── scripts/         migrate / seed / db-setup / test-prep / matrix / export-audit / rollback / evidence
├── tests/           unit (sin DB), integration (con DB + 2 tenants), smoke
├── evidence/        evidencia real capturada (AC-009)
└── docker-compose.yml
```

## 2. Prerrequisitos

- Node.js **≥ 24** (usa type-stripping nativo; `node -v` debe mostrar `v24.x`)
- npm ≥ 10 (o pnpm)
- Docker + Docker Compose (para PostgreSQL local)
- **JWT_SECRET** (requerido por el app/`npm start`, ver §11; los scripts de BD y tests no lo necesitan)

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

- Migraciones: `migrations/0001_schema.sql` (client, tenant_context, internal_user, role, permission, role_permission, user_role, session_context, client_data, demo_action, audit_event), `migrations/0002_seed.sql` (2 clients `client_a` / `client_b`, 3 roles, 6 usuarios, datos de prueba) y `migrations/0003_login_unique_per_tenant.sql` (IR-05: quita el UNIQUE global de `internal_user.login`, añade `tenant_id` a `internal_user` backfilled desde `user_role` y crea el UNIQUE compuesto `(lower(login), tenant_id)`).
- **Procedimiento de regeneración de BD dev/test (IR-05)**: las migraciones 0001→0003 son in-place; para regenerar desde cero: `docker compose down -v && docker compose up -d postgres && npm run db:setup` (dev) y `npm run test:integration` recrea `mainspot_test` sola. No hay datos reales fuera del seed en este piloto.
- El runner registra archivos aplicados en `schema_migrations` y usa advisory lock (replay seguro).
- El seed es idempotente (`ON CONFLICT DO NOTHING`).

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

Rutas principales:

| Ruta | Protegida | Acción |
|---|---|---|
| `GET /` | — | Página de ingreso (lenguaje claro, AC-008) |
| `POST /api/auth/login` | — | Inicia sesión → devuelve JWT de sesión (propio, HS256) |
| `POST /api/auth/logout` | sesión | Revoca la sesión |
| `GET /api/backoffice/me` | `data.read` | Contexto actual (cliente, perfil, permisos) |
| `GET /api/backoffice/data` | `data.read` | Lista datos del cliente (solo tenant propio) |
| `POST /api/backoffice/data` | `data.write` | Crea dato del cliente (siempre en tenant de la sesión) |
| `GET /api/backoffice/data/:id` | `data.read` | Lectura con scope; id de otro cliente → deny auditado |
| `GET /api/backoffice/audit?request_id=…` | `audit.read` | Consulta de auditoría con correlación (AC-003) |
| `GET /api/backoffice/audit/export` | `audit.export` | Export JSON de auditoría (sin secretos) |
| `GET/POST /api/backoffice/users` | `user.manage` | Listar/crear usuarios internos (admin) |
| `POST /api/backoffice/actions` | `operation.create` | Crea operación de prueba (fixture AC-003) |
| `POST /api/backoffice/actions/:id/{approve,reject,execute}` | `operation.approve/reject/execute` | Verbos AC-003 (idempotentes) |

## 5. Validaciones (AC-001/002/003/009)

```bash
npm run typecheck         # tsc --noEmit
npm run test:unit         # unit sin DB (matriz RBAC, JWT, evento audit, logger)
npm run test:integration  # recrea mainspot_test + corre aislamiento 2 tenants, RBAC, auditoría, hooks
npm run test:smoke        # smoke AC-009 + señales UX AC-008
npm test                  # typecheck + unit + integration + smoke
```

Los tests de integración/smoke lanzan la app real en proceso contra la BD `mainspot_test` que `scripts/test-prep.ts` recrea desde cero (fixture determinista de 2 tenants).

## 6. Evidencia reproducible (AC-009)

```bash
npm run evidence   # bash scripts/capture-evidence.sh
```

Captura salidas reales en `evidence/`:

| Archivo | Contenido |
|---|---|
| `00-environment.txt` | versiones node/npm/docker/git y estado git |
| `01-typecheck.txt` | salida `tsc --noEmit` |
| `02-permission-matrix.txt` + `permission-matrix.md` | matriz de permisos (AC-001) |
| `03-unit-tests.txt` | tests unitarios |
| `04-db-up.txt` | arranque postgres |
| `05-db-setup.txt` | migrate + seed |
| `06-integration-tests.txt` | tests de integración (aislamiento, RBAC, auditoría, hooks) |
| `07-smoke.txt` | smoke AC-009 |
| `08-denied-cross-tenant.log` | eventos `decision=deny` exportados (evidencia AC-002) |
| `09/10-…audit-export-*.json` | eventos de auditoría por tenant (evidencia AC-003) |
| `11-rollback-simulate.txt` + `rollback-report.md` | simulación de rollback (AC-009) |
| `12-summary.txt` | resumen PASS/FAIL por gate |

Regla `06-ACCEPTANCE-EVIDENCE.md`: la evidencia no se basa en afirmaciones — estos archivos contienen salida real de comandos reproducibles.

## 7. Rollback (AC-009, contrato §Rollback)

Procedimiento ejecutable (también documentado en `evidence/rollback-report.md` tras `npm run rollback:simulate`):

1. **Deshabilitar paths nuevos**: revocar todas las sesiones activas (`npm run rollback:simulate` hace `UPDATE session_context SET revoked_at=now()`); ningún token previo sigue siendo válido (el simulador verifica **revocación real de una sesión válida**, IR-12).
2. **Revertir configuración de roles/permisos**: re-sincronizar `role_permission` desde la matriz de código (idempotente). Para revertir **código** (matriz o endpoints): `git revert` del commit de este incremento o checkout del commit anterior — la matriz vive en `src/rbac/matrix.ts`.
3. **Preservar auditoría**: no se borra ningún `audit_event`; el simulador verifica conteo antes/después (PRESERVADO).
4. **Verificar que no queda acceso cruzado**: re-ejecutar el test negativo de 2 tenants (`npm run test:integration`) y resolver sesiones revocadas ⇒ deny.
5. **Documentar** el reporte como evidencia.

> Riesgo explícito (para Reviewer): si un path nuevo deshabilitado aquí ya lo usara INC-002 en el futuro, la coordinación es obligatoria (fuera de alcance de INC-001).

## 8. Mapa AC → implementación y evidencia

| AC | Dónde se cumple | Evidencia |
|---|---|---|
| **AC-001** Roles y contexto | `src/rbac/matrix.ts` (matriz), `src/rbac/engine.ts` (motor), `src/boundary/middleware.ts` + `src/api/routes.ts` (chequeo por contexto), `src/api/ui.ts` (perfil visible) | `tests/unit/rbac.engine.test.ts`, `tests/integration/rbac-context.test.ts`, `permission-matrix.md`, salida de denegaciones por rol |
| **AC-002** Aislamiento por cliente | `src/boundary/session.ts` (resolución ANTES del acceso), `src/boundary/datasource.ts` (scope `tenant_id` forzado en SQL), middleware fail-closed, seed 2 tenants | `tests/integration/isolation.test.ts` (positivo + negativos), `08-denied-cross-tenant.txt` |

> Anti-oráculo (IR-01): los recursos inexistentes y los de otro tenant responden 404 idéntico (mismo status, body y evento audit), para no filtrar existencia. Verificado por `IR-01 anti-oracle` en `tests/integration/isolation.test.ts`.
| **AC-003** Auditoría mínima | `src/audit/event.ts` (esquema), `src/audit/sink.ts` (sink fail-closed), `src/audit/query.ts` (correlación `request_id`) | `tests/integration/audit-correlation.test.ts`, `audit-export-*.json` |
| **AC-008** UX no técnica | `src/api/ui.ts` (lenguaje claro, labels, `role=alert`), mensajes de error en `src/shared/errors.ts` / rutas | `tests/smoke/smoke.test.ts` (señales UX), `docs/UX-CHECKLIST.md` |
| **AC-009** Evidencia y rollback | `scripts/capture-evidence.sh`, `scripts/simulate-rollback.ts`, este README | `evidence/*`, `rollback-report.md` |

## 9. Hooks para INC-002 (T-015) — sin consumidores

`src/hooks/contracts.ts` expone las tres superficies que `INC-002` consumirá:

- `identity.resolveIdentity(header)` → cliente + usuario + rol desde sesión.
- `authorization.checkAuthorization(role, tenant, action, resource)` → verdad de permiso (fail-closed).
- `audit.auditSink(event)` y `audit.eventsForRequest(tenant, requestId)` → persistencia + correlación de eventos.

No se implementa ningún consumidor (INC-002 fuera de alcance). El stub de consumidor está en `tests/integration/hooks.test.ts`.

## 10. Decisiones TENTATIVA (a validar/cerrar; el canon no las fija)

| Tema | Decisión tomada | Marca |
|---|---|---|
| Motor RBAC declarativo en código (`D-04`) | matriz en `src/rbac/matrix.ts` + espejo en BD `role_permission` (validado por test) | TENTATIVA |
| Pipeline de auditoría (`D-05`) | tabla directa + transacción para acciones sensibles (fail-closed) | TENTATIVA |
| Correlación (`D-06`) | `request_id` obligatorio por request (ALS) | TENTATIVA |
| IDs | `client_a`/`client_b` legibles en seed; UUIDs generados para filas nuevas | TENTATIVA |
| Sesión | tabla `session_context` + JWT HS256 propio como referencia firmada (revocación real) | TENTATIVA |
| Contraseñas | pgcrypto bcrypt; las del seed son simuladas y documentadas | TENTATIVA |
| `tenant_id` en eventos deny sin contexto | valor reservado `'unknown'` | TENTATIVA |
| Acción demo `operation.create` | añadida a la matriz para cubrir AC-003 | TENTATIVA (design §5 permite definir nombres en implementación) |
| Retención de auditoría | sin borrado en dev; pendiente decisión humana (PEND-011) | PENDIENTE |
| Export de auditoría por `client_a` CLI | `scripts/export-audit.ts` | — |
| Cuenta interna por tenant (`IR-05`) | modelada con `internal_user.tenant_id` + UNIQUE compuesto `(lower(login), tenant_id)` en `0003` | TENTATIVA v1 |

## 11. Seguridad y notas operativas

- **Fail-closed**: sin contexto de tenant/actor o chequeo fallido ⇒ deny siempre; nunca default-allow.
- **Auditoría sin secretos**: el sink y el logger rechazan campos con nombre sensible (`password`, `token`, …); los eventos de fallo usan `decision='deny'`/`result='failed'` **genérico (sin mensajes crudos de error que puedan contener logins)**; el export se valida con test SEC.
- **Privilegio mínimo**: `read_only` no muta; `operation` no gestiona usuarios ni ve auditoría.
- **Canales no son identidad** (`RULE-001`, `DEC-006`): no hay asociación canal→cliente en INC-001.
- **JWT_SECRET (IR-02)**: **requerido** en toda env distinta de `test`; no existe default en código ni en compose, y los placeholders conocidos son rechazados al arrancar (fail-fast). Generar con `openssl rand -hex 32` y proveer via `.env`/secret manager. El contenedor `app` se niega a arrancar sin él (`docker compose up -d postgres` sigue funcionando para la BD dev local).
- **Rate limiting de login (IR-06)**: intentos fallidos limitados por IP+login (5 fallos / ventana 60s, luego bloqueo 60s con `Retry-After`; acierto resetea). Implementación in-memory por instancia: en despliegues multi-instancia se requiere store compartido antes de exponer login. Las cuentas seed son SOLO dev y deben rotarse antes de exponer el panel (gate T-019).
- **Auditoría de denegaciones (IR-11)**: los denies de acceso a recursos protegidos se persisten con el `request_id` de la solicitud. EXCEPCIÓN declarada: la escritura del evento de denegación es **best-effort** (si falla, se loguea `warn` y se responde el 4xx igual — nunca se bloquea la respuesta por un problema de auditoría); las acciones sensibles SÍ fallan-cerrado (Guerra: la operación y su evento se revierten juntas).
- El `.env.example` es la referencia; incluye solo placeholders y **nunca** un secreto real; **nunca** subir `.env`.

## 12. Out of scope (recordatorio)

No se implementa INC-002 (conversacional/preview/aprobación), ni Telegram/WhatsApp, ni LXC/Docker por cliente, ni UI de producto, ni planes/precios/pagos. Las tablas `client_data` y `demo_action` son fixtures de prueba/evidencia, no dominios de producto.
