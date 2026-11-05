# F0 — Inventario de ciclo de vida de suscripción y superficies de política comercial (AC04, AC06–AC11)

- Fecha: 2026-11-05. Agente: `LifecycleInventory` (solo lectura).
- Worktree: `/home/administrador/codeart/mainspoot/mainspot-platform-commercial`, rama `feat/commercial-quota-semantics-20261105`, HEAD `83619f0`.
- Rutas `ruta:línea` relativas al worktree salvo indicación. Lo no observado se marca **[INFERENCE]**.
- No se editó ningún archivo de ningún repositorio, no se tocaron BD, servicios, infraestructura, secretos ni proveedores.

Estados usados: **IMPLEMENTED** (existe y se observa en código, con prueba o por construcción declarada) · **PARTIAL** (existe una parte o un mecanismo no conectado a la semántica pedida) · **OPEN** (no existe; implementable como política local) · **BLOCKED** (requiere insumo externo o decisión no disponible).

---

## 0. Verificación de base (comandos ejecutados)

| Comando | Resultado observado |
|---|---|
| `git log --oneline -n 12` | `83619f0` docs(handoff) · `30ca2de` docs(handoff) · `f68746b` docs(gates) · `b3b0447` … `6e1eff8` (fixes PR #14) |
| `git status --short` (al inicio y al final) | vacío (worktree limpio) |
| `git branch --show-current` | `feat/commercial-quota-semantics-20261105` |
| `git merge-base --is-ancestor` | `95f9436 ⊂ b1cd3df ⊂ f68746b ⊂ HEAD` (las tres comprobaciones OK) |
| `git rev-parse --short` | `origin/feat/plan-policy-catalog-impl-20261104` = `b1cd3df`; `origin/fix/plan-catalog-gates-hardening-20261104` = `f68746b`; `origin/feat/canonflow-implementation` = `95f9436` |
| `read pr://13` | OPEN, **Draft: true**, base `feat/canonflow-implementation`, head `feat/plan-policy-catalog-impl-20261104`, 72 archivos |
| `read pr://14` | OPEN, **Draft: true**, base `feat/plan-policy-catalog-impl-20261104`, head `fix/plan-catalog-gates-hardening-20261104`, 42 archivos, «Producción: NO-GO» |
| `node -e` sobre `package.json` | dependencias: express, libphonenumber-js, nodemailer, pg, sharp (+ dev: tipos, playwright-core, typescript). **Ningún SDK de pagos**; `ls node_modules \| grep -iE 'stripe\|paypal\|mercado\|conekta\|openpay\|braintree\|adyen\|square'` → vacío |

---

## 1. Resumen ejecutivo (hechos)

1. **Suscripción**: una fila por negocio (`tenant_id UNIQUE`), `status ∈ {active, suspended, cancelled}`, `started_at DEFAULT now()`, `updated_at` (`migrations/0009_subscriptions_plans.sql:30-37`) + `plan_revision_id NOT NULL` fijada (`migrations/0034_plan_policy_catalog.sql:278,424-430`). No hay `ends_at`, `trial_*`, periodo vigente, cambio programado, `past_due`/gracia ni `expired` (grep de `pending_plan|scheduled_plan|next_plan|effective_at|change_at|ends_at|expires_at|current_period|period_end|period_start|renew` en `src/plans`, `src/subscriptions`, 0009, 0014, 0034: solo `quota_reservation.expires_at`).
2. **Pago**: solo `PaymentProvider` abstracto + `SimulatedPaymentProvider` que siempre responde ok sin llamadas externas (`src/subscriptions/payment.ts:1-8,27-40`); su único consumidor es `EntitlementService.invoice`, que es **PROHIBITED sin precio** (`src/subscriptions/entitlements.ts:135-171`); todos los planes sembrados tienen `price_cents NULL` (`migrations/0009_subscriptions_plans.sql:40-44`). `PAYMENT_PROVIDER=stripe` se acepta en configuración pero no tiene implementación (`src/shared/config.ts:23,294-296`; `src/api/server.ts:201` construye `EntitlementService` sin proveedor).
3. **Ciclo mensual**: mecanismo implementado y probado (UTC, ancla `subscription.started_at`, día acotado a fin de mes sin deriva, sin rollover) (`src/plans/policy.ts:146-169`; `src/subscriptions/quota.ts:197-207`), pero **ningún parámetro real lo usa**: las 6 capacidades son `cumulative` (`src/plans/registry.ts:70,80,89,98,107,116`; `migrations/0034_plan_policy_catalog.sql:52,57,62,67,72,77`).
4. **Cambio de plan** = asignación administrativa inmediata (platform_admin + step-up + motivo), conserva ancla y uso, sin prorrateo, sin diferido y sin relación con pagos (`src/plans/assignment.ts:64-121`).
5. **Suscripción no activa** ⇒ el servidor solo deniega creaciones que consumen cuota (y facturar). Las operaciones manuales (responder/aprobar reseñas y casos, aprobar/publicar cambios web, restaurar versiones, comandos Telegram) **no** consultan la suscripción; el **panel** sí las oculta cuando la suscripción no está activa. **Ningún código** pone `subscription.status = 'suspended'`; `cancelled` solo se escribe en la baja confirmada por CLI.
6. **Suspensión de negocio** (`client.status='suspended'`, ruta de plataforma) sí despublica el sitio de forma reversible, pero también corta login, todas las sesiones y el worker; el canal de comandos de Telegram no comprueba `client.status`.
7. **Baja**: exportación JSON completa por operador + `exiting` + suscripción `cancelled` + anonimización a los **30 días** (DEC-0024; CHECK ≥30). Sin reactivación desde `exiting`, sin importación, sin exportación self-service de contenido.
8. **Avisos**: ningún aviso de suscripción, gracia, suspensión, vencimiento o cuota por correo ni por Telegram. El panel muestra «Tu plan no está activo» y uso/límite.
9. **Trial (DEC-0018)**: no implementado; el alta asistida asigna `plan_piloto_1` sin vencimiento (CF-16).

---

## 2. Modelo actual con evidencia

### 2.1 Esquema y semántica de la suscripción

| Elemento | Evidencia |
|---|---|
| Tabla `subscription` (una por negocio, status CHECK, `started_at DEFAULT now()`) | `migrations/0009_subscriptions_plans.sql:29-37` |
| Tipo TS `SubscriptionStatus = 'active' \| 'suspended' \| 'cancelled'`; `PolicySubscription.started_at` | `src/plans/policy.ts:19,21-29` |
| Fijación a revisión, FK compuesta, trigger guard (cambios solo de estado no tocan la revisión) | `migrations/0034_plan_policy_catalog.sql:278,317-341,424-433` |
| Historial append-only `subscription_history` (`change_kind ∈ backfill, assign, plan_change, revision_migration, status_change`); **no registra `started_at`** | `migrations/0034_plan_policy_catalog.sql:280-296,343-367` |
| Plan sin precio: `price_cents NULL` = no facturable; seeds `plan_piloto_1`, `plan_basico`, `plan_completo` (ningún `trial`) | `migrations/0009_subscriptions_plans.sql:7-17,40-44` |
| Parámetros de plan: registro tipado único; semánticas `cumulative/stock/periodic/rate_window/eligibility`; solo 6 parámetros, todos `cumulative` | `src/plans/registry.ts:9-15,18-23,65-121` |
| Espejo en BD con CHECK `periodic ⇔ subscription_month`; valores con FK a definiciones (una revisión no puede tener un parámetro periódico sin migración nueva) | `migrations/0034_plan_policy_catalog.sql:17-45,47-80,130-144` |

### 2.2 Escritores de `subscription` (lista completa; grep `(INSERT INTO|UPDATE|DELETE FROM)\s+subscription\b`)

| Escritor | Qué hace | Evidencia |
|---|---|---|
| Seed 0009 | `sub_a`/`sub_b` activos en `plan_piloto_1` | `migrations/0009_subscriptions_plans.sql:64-67` |
| Backfill 0034 | Solo fija `plan_revision_id` (no toca `started_at`) | `migrations/0034_plan_policy_catalog.sql:419-421`; prueba `tests/integration/plan-catalog-migration.test.ts:315-319` |
| Alta asistida (CLI `invite-owner`) | INSERT `status='active'` con `plan_piloto_1` por omisión | `src/identity/onboarding.ts:64-69`; `scripts/invite-owner.ts:24,32` |
| Asignación (Administration) | Reactivar mismo plan: `UPDATE status='active'` (conserva revisión); otro plan: UPSERT de `plan_id`, `plan_revision_id`, `status='active'`, `updated_at` (no toca `started_at` ni `subscription_id`) | `src/plans/assignment.ts:98-111` |
| Migración de revisión | `UPDATE plan_revision_id` | `src/plans/assignment.ts:170-174` |
| Baja confirmada | `UPDATE status='cancelled'` | `src/retention/service.ts:326` |
| Anonimización | `DELETE` (tabla en `TENANT_TABLES`) | `src/retention/service.ts:110-112,391-394` |
| `started_at` | Ningún escritor fuera de su DEFAULT; solo la prueba lo cambia por SQL | grep `started_at` en `src`, `migrations`, `scripts`; `tests/integration/quota-semantics.test.ts:306` |
| `status='suspended'` | **Ningún escritor en código**; solo SQL en pruebas | grep `suspend` en `src`; `tests/integration/quota-semantics.test.ts:156-163`, `tests/integration/plan-catalog.test.ts:1000` |

### 2.3 Qué deniega `resolveEffectivePolicy` cuando la suscripción no está activa

`resolveEffectivePolicy` lanza 403 `subscription_required` si no hay suscripción, si la revisión no es válida o si `status !== 'active'` (`src/plans/policy.ts:96-106`). Solo la invocan `QuotaLedger.assertCapacity` (`src/subscriptions/quota.ts:215-218`) y `assertEligible` (`src/subscriptions/quota.ts:237-240`); `loadPinnedPolicy` (lecturas) no exige estado activo (`src/plans/policy.ts:79-94`).

**Bloqueado por estado no activo (servidor):**

| Operación | Evidencia |
|---|---|
| Mensaje del dueño al asistente (reserva `conversations`) | `src/conversation/pipeline.ts:85-104` |
| Crear la página web (cuota `website`) | `src/api/conversation-routes.ts:319-339` |
| Crear borradores de publicación/anuncio (incluida la composición con IA) | `src/social/service.ts:254-258`; `src/ai/business.ts:158` |
| **Recepción/sincronización de reseñas** (lote `reviews_managed`, manual y worker) | `src/reputation/engine.ts:246-269`; `src/api/reputation-routes.ts:89`; `src/engagement/worker.ts:144-152` |
| Facturar | `src/subscriptions/entitlements.ts:138-145` |

**No bloqueado por estado de la suscripción (servidor):**

| Operación | Evidencia |
|---|---|
| Reseñas: escalar, editar, aprobar respuesta, rechazar | `src/reputation/engine.ts:308-455`; rutas `src/api/reputation-routes.ts:108,126,138,160` |
| Casos de atención (Google/Facebook): editar borrador, aprobar, rechazar | `src/engagement/service.ts:365-426`; `src/api/engagement-routes.ts:82-121` |
| Telegram `/aprobar` y `/rechazar` (también ignora `client.status`) | `src/engagement/telegram.ts:168-211` |
| Propuestas: confirmar, aprobar/publicar, rechazar; primera página, cambio de teléfono, restaurar versión | `src/api/conversation-routes.ts:189,215,289,421-424,430-449`; `src/website/site-proposals.ts:121-125` |
| Publicar la web (efecto) | `src/publishing/website.ts:63-123` |
| IA generativa (dispatcher): gates = caso de uso activo, política de datos, circuito, presupuesto USD; **sin suscripción** | `src/ai/dispatcher.ts:209,241-255,256-280`; `src/ai/governance.ts:26-38,52-79` |

**Panel (cliente)**: deriva `S.trial = 'active'` solo si `subscription.status === 'active'`, si no `'expired'` (`src/web/panel/assets/js/store.js:321-325`; `MS.expired` en `store.js:147`). Con `expired` oculta o bloquea: pedir cambios (`src/web/panel/assets/js/views-app.js:142-143,211,337,355,364`), aprobar/publicar (`views-app.js:426-434`), restaurar (`views-app.js:495`), redes (`src/web/panel/assets/js/views-channels.js:223,243`), responder y aprobar casos (`views-channels.js:369-374`), reglas (`views-channels.js:396,426`), confirmar en el asistente (`src/web/panel/assets/js/assistant.js:52`); banner global «Tu plan no está activo… Tus datos no se borran» (`views-app.js:55`).

### 2.4 Suspensión del negocio (`client.status`)

| Aspecto | Evidencia |
|---|---|
| Ruta de plataforma `POST /api/platform/tenants/:id/status` (`active ⇄ suspended`; solo filas `active/suspended`), `platform_admin` + step-up + motivo, auditoría negocio y plataforma | `src/api/platform-routes.ts:141-152`; consola `src/web/platform/assets/console.js:118-121,832-837` |
| Estados posibles del negocio: `active, suspended, exiting, anonymized` | `migrations/0015_retention_policy.sql:51-53` |
| Bloquea login y cada petición del panel (re-validación por petición) | `src/identity/repository.ts:54-57,66-70,116-128`; `src/boundary/session.ts:50-52` |
| Despublica el sitio público (404) de forma reversible (la fila del sitio no cambia) | `src/website/local-site.ts:91-93,112-116` |
| Detiene el worker (ingesta, respuestas automáticas, avisos) | `src/engagement/worker.ts:73-77` |
| Bloquea proveedores reales de IA y grants de laboratorio | `src/ai/governance.ts:32-34`; `src/ai/lab.ts:221` |
| **No** bloquea comandos Telegram de un chat ya vinculado (solo comprueba `telegram_link` y `internal_user`) | `src/engagement/telegram.ts:168-171,193-211`; `src/engagement/service.ts:365-399` (sin comprobación de negocio) |
| No toca dominios (el servicio de dominio solo aprovisiona) | `src/domain/service.ts:36-97`; `src/domain/hostinger.ts:31` |

### 2.5 Publicación / despublicación web

| Aspecto | Evidencia |
|---|---|
| `client_website.status ∈ {draft, published, suspended}` | `migrations/0005_website_domain.sql:15`; `src/website/repository.ts:17` |
| El sitio público solo sirve `published` con negocio `active` | `src/website/local-site.ts:91-93,112-116`; prueba `tests/integration/website-restore-local-site.test.ts:264-314` (incluye `suspended ⇒ 404` por SQL en `:310-313`) |
| **Ningún código pone `client_website.status='suspended'`** (grep `UPDATE client_website`: solo datos, `local_site_*` y el publicador) | `src/website/repository.ts:94-97`; `scripts/client-site-register.ts:62-66`; `src/publishing/website.ts:107-111` |
| El publicador fuerza `status='published'` en cada publicación (desharía una despublicación) | `src/publishing/website.ts:108` |

### 2.6 Retención, baja, exportación, anonimización

| Aspecto | Evidencia |
|---|---|
| Plazos: contenido conversacional 90 d, trazas IA 90 d, auditoría 2 años, agregados 2 años, **gracia de baja 30 d**, registro de anonimizados 30 d | `src/retention/service.ts:34-43` |
| CHECK BD `anonymize_after >= confirmed_at + 30 days` | `migrations/0015_retention_policy.sql:55-62` |
| Baja: solo negocio `active/suspended`; exporta JSON (0600, sin credenciales, formato `mainspot-tenant-export/v1`) → `tenant_exit` → `client='exiting'` → `subscription='cancelled'` → auditoría | `src/retention/service.ts:297-336,513-527` |
| Disparo: CLI de operador `npm run tenant:exit -- confirm`; «el vencimiento de una prueba no es una baja» | `scripts/tenant-exit.ts:1-12,32-55` |
| Anonimización diaria de bajas vencidas; verificación de ausencia de rastros; ensayo dry-run | `src/retention/service.ts:241-255,345-417,568-601`; `scripts/anonymization-dry-run.ts:40` |
| Exportación self-service del negocio: solo eventos de auditoría | `src/analytics/export.ts:1-5,32`; `src/api/analytics-routes.ts:58`; `src/api/routes.ts:395` |
| Importación | **No existe**: el único uso de `mainspot-tenant-export` es el productor `src/retention/service.ts:517` |
| Reactivación desde `exiting` | **No existe**: la ruta de estado solo actualiza `active/suspended` (`src/api/platform-routes.ts:147-148`); asignar rechaza otro estado (`src/plans/assignment.ts:70-71`); repetir la baja falla (`src/retention/service.ts:308-310`) |

### 2.7 Canales de aviso

| Canal | Qué existe | Evidencia |
|---|---|---|
| Plataforma (panel) | Banner «plan no activo»; «Mi plan» con uso/límite, «Completo», «Por encima del límite»; 403 con uso, máximo, unidad y periodo | `views-app.js:55,243-268`; `src/plans/policy.ts:128-142` |
| Correo | `Mailer` con transportes `disabled` (por defecto, nunca finge entrega), `smtp`, `resend`; único consumidor: recuperación de contraseña | `src/mail/mailer.ts:1-14,43-56,187-197`; `src/identity/password-reset.ts:174` |
| Telegram | Vínculo chat↔persona; avisos solo de casos `needs_human/failed`; `no_destination` si no hay chat; canal simulado si no hay token | `src/engagement/telegram.ts:1-5,230-250`; `src/engagement/service.ts:580-639`; `src/channels/registry.ts:14-20`; `src/channels/simulated.ts:24-27` |
| Telegram real | `TELEGRAM_WEBHOOK_REAL_VERIFIED: BLOCKED_EXTERNAL` | `docs/architecture/telegram-webhook-starlink.md:5-6,18-19` |
| Rama `feat/f01-telegram-acknowledged-alerts` | `6b66999` **no es ancestro de HEAD**; su diff (`git diff --stat HEAD...feat/f01-telegram-acknowledged-alerts`) solo toca `.canonflow`, docs, `scripts/ops/backup/*` y `tests/ops/*` (alertas de respaldos, no de negocio) | comando git |

### 2.8 Trial

| Aspecto | Evidencia |
|---|---|
| DEC-0018: plan `trial` en catálogo, asignación administrativa, 30 días desde activación con vencimiento registrado, mismos límites y funciones que `plan_piloto_1`, `EXPIRED` ⇒ DENY de DEC-0007, sin borrado automático, sin cobros ni conversiones | `.canonflow/decision-records/DEC-0018.md:14-15,29-44` |
| Opción rechazada `trial_es_piloto` | `.canonflow/decision-records/DEC-0018.md:17-19` |
| DEC-0039: el alta asistida «asigna Trial» | `.canonflow/decision-records/DEC-0039.md:14-15` |
| Estado: «pendiente de implementación» | `.canonflow/canon/functional/items/FR-0010.md:58-59`; `.canonflow/decision-records/DEC-0075.md:37`; `docs/architecture/plan-catalog.md:19,197` |
| Código: sin plan `trial`, sin vencimiento, sin `EXPIRED`; alta con `plan_piloto_1` indefinido (CF-16) | `migrations/0009_subscriptions_plans.sql:34,40-44`; `src/identity/onboarding.ts:64-69`; `docs/research/plan-parameters-inventory.md:644,683`; `evidence/plan-catalog/CIERRE.md:94` |

---

## 3. Matriz AC04, AC06–AC10 (cada subrequisito)

Fuente de cada subrequisito: SRC-005 (`/tmp/msp-commercial/SRC-005.md:21-34`) y HANDOFF (`git show HEAD:docs/handoffs/commercial-policy-2026-11-05/HANDOFF.md`, «Matriz mínima de aceptación»).

### AC04 — Ciclo mensual propio, renovaciones no acumulables, activación dependiente de pago (C02, C04, C06)

| ID | Subrequisito | Estado | Evidencia | Falta (delta) | Tests existentes |
|---|---|---|---|---|---|
| AC04.1 | Cálculo de ciclo mensual UTC anclado a `started_at`, día acotado a fin de mes, sin deriva | IMPLEMENTED (mecanismo) | `src/plans/policy.ts:146-169`; `src/subscriptions/quota.ts:197-207`; `src/plans/registry.ts:22,158`; `migrations/0034_plan_policy_catalog.sql:26,38` | — | `tests/unit/plan-policy.test.ts:38-134`; `tests/integration/quota-semantics.test.ts:245-301,303-333,414-450` |
| AC04.2 | Algún plan real usa semántica periódica | OPEN | Solo 6 parámetros `cumulative` (`src/plans/registry.ts:65-121`; `src/subscriptions/quota.ts:16`; `migrations/0034_plan_policy_catalog.sql:47-80`); FK de valores a definiciones (`0034:132`); FR-0010 AC-10006 lo exige así (`.canonflow/canon/functional/items/FR-0010.md:33-37,50`); reservado a HDC-MSP-06 (`.canonflow/decision-records/DEC-0010.md:46`; `DEC-0075.md:24,36`) | Parámetro(s) periódico(s) nuevos + migración espejo + revisión nueva por plan + autorización canónica (la unidad «respuesta IA» es de AC01/AC02). Los parámetros periódicos de prueba existen solo en BD desechable (`tests/integration/quota-semantics.test.ts:12-13,65-78`) | `quota-semantics.test.ts` (solo mecanismo inyectado) |
| AC04.3 | Ancla = activación **efectiva** (pagada) de la suscripción | PARTIAL | `started_at DEFAULT now()` al primer INSERT (`migrations/0009_subscriptions_plans.sql:35`): alta asistida o primera asignación, ambas `active` sin pago (`src/identity/onboarding.ts:68`; `src/plans/assignment.ts:107-108`) | Fijar el ancla al evento de activación pagada (requiere evento de pago: BLOCKED real; simulable localmente) | ninguno |
| AC04.4 | Ancla conservada en upgrade/downgrade/reactivación/migración | IMPLEMENTED por construcción, **sin prueba** | `src/plans/assignment.ts:105,109-110,171` (ninguna escritura de `started_at`); `docs/architecture/plan-catalog.md:95` | Prueba que afirme `started_at` invariable tras asignar otro plan, reactivar y migrar (grep `started_at` en tests: solo `quota-semantics.test.ts:306` y fixtures de migración) | `plan-catalog-migration.test.ts:315-319` (solo backfill 0034) |
| AC04.5 | Cuotas no acumulables (sin rollover) | IMPLEMENTED por construcción en el mecanismo; inactivo en producto | Límite fijo por revisión contra uso del ciclo; no hay saldo ni arrastre (`src/subscriptions/quota.ts:202-207,226-230`); `DEC-0075.md:15` («sin rollover») | Prueba explícita «lo no usado en el ciclo N no amplía el N+1» (`quota-semantics.test.ts:327-332` reinicia al mismo límite pero el ciclo previo estaba lleno) | `quota-semantics.test.ts:303-333` |
| AC04.6 | Renovar cuotas al renovarse un periodo vigente (pagado) | OPEN + BLOCKED (pago) | El ciclo avanza solo por tiempo desde el ancla, sin periodo ni renovación registrados (`src/plans/policy.ts:160-169`; grep de periodo/renovación: 0) | Entidad de periodo/renovación ligada al pago o simulación etiquetada | ninguno |
| AC04.7 | Vigencia de cuotas condicionada a suscripción activa | PARTIAL | Consumir exige `status='active'` (`src/plans/policy.ts:100-106`; `src/subscriptions/quota.ts:215-218,286-293`), pero `active` se fija sin pago (`src/plans/assignment.ts:105-111`; `src/identity/onboarding.ts:68`) | Estado previo a la activación (p. ej. pendiente de pago) y transición por pago | `quota-semantics.test.ts:484-501`; `subscriptions-inc006.test.ts:191-241` |
| AC04.8 | Activación dependiente de pago | BLOCKED (proveedor, precios) / OPEN (flujo simulado local) | `src/subscriptions/payment.ts:1-8,27-40`; `src/subscriptions/entitlements.ts:100-102,135-171`; `src/shared/config.ts:23,294-296`; `src/api/server.ts:201`; precios NULL `0009:40-44`; BR-0006 (`.canonflow/canon/functional/items/BR-0006.md:13`); sin SDK (`package.json`) | Proveedor real, precios, confirmación (webhook); o flujo simulado claramente etiquetado | `tests/unit/subscriptions.test.ts:33-37`; `subscriptions-inc006.test.ts:121-137` |
| AC04.9 | (C02) Mismas cuotas por plan sin importar el giro | IMPLEMENTED | El límite sale solo de la revisión fijada (`src/plans/policy.ts:79-94,113-120`); grep `vertical\|giro\|sector` en `src/plans` y `src/subscriptions`: 0 coincidencias | — | `quota-semantics.test.ts:452` (aislamiento); `plan-catalog.test.ts:535-645` |

### AC06 — Upgrade conserva uso y prorratea precio y capacidad; downgrade diferido (C07, C08)

| ID | Subrequisito | Estado | Evidencia | Falta (delta) | Tests existentes |
|---|---|---|---|---|---|
| AC06.1 | Qué hace hoy un cambio de plan | IMPLEMENTED (asignación administrativa inmediata) | Ruta `POST /api/platform/tenants/:id/plan` con `subscriptions.assign` + step-up (`src/api/platform-routes.ts:154-165`; `src/platform/permissions.ts:18-19`); `assign`: negocio `active/suspended` (`src/plans/assignment.ts:67-72`), plan habilitado con publicada (`:76-82`), noop (`:89-93`), 409 si mismo plan en revisión anterior (`:94-96`), reactivación (`:98-105`), cambio de plan (`:107-111`), auditorías (`:113-118`), historial (`0034:343-367`) | — | `plan-catalog.test.ts:977-1030`; `subscriptions-inc006.test.ts:30,76` |
| AC06.2 | Upgrade con efecto inmediato **tras confirmar el cobro** | PARTIAL + BLOCKED | Efecto inmediato sí; ningún cobro ni orden «superior/inferior» entre planes (sin precio) (`src/plans/assignment.ts:107-111`; `0009:40-44`) | Confirmación de cobro (proveedor, precios) | ninguno |
| AC06.3 | Downgrade efectivo al **siguiente ciclo** | OPEN (política local) | Sin campos de cambio programado (grep: 0); la asignación aplica al instante (`src/plans/assignment.ts:107-111`) | Modelo de cambio programado + aplicación en la frontera `monthlyCycle(started_at)` + ruta/UI + pruebas; criterio para distinguir upgrade de downgrade sin precio [INFERENCE] | ninguno |
| AC06.4 | Conservar el consumo (no reiniciar uso) | IMPLEMENTED por construcción | El uso se cuenta por negocio y capacidad, no por plan ni suscripción: acumuladas por SQL de dominio (`src/plans/registry.ts:74,83,92,101,110,119`; `src/subscriptions/quota.ts:192-196`), periódicas por libro (`quota.ts:202-206`); exceso tras bajar se conserva y solo se bloquean creaciones (`src/plans/assignment.ts:11`; `FR-0010.md:37-39`) | Prueba con cambio a **otro** plan (la de `plan-catalog.test.ts:1005` no afirma uso) y con uso periódico | `plan-catalog.test.ts:616-625,641-644` (migración de revisión); `subscriptions-inc006.test.ts:87-119` |
| AC06.5 | No entregar la cuota completa del destino como si no hubiera consumo | PARTIAL | El uso previo cuenta contra el nuevo límite (`src/subscriptions/quota.ts:218-229`), pero en un upgrade a mitad de ciclo el límite nuevo completo queda disponible al instante | Limitar la capacidad incremental al tiempo restante (ver AC06.6) | ninguno |
| AC06.6 | Prorrateo de precio adicional **y** capacidad incremental | OPEN + BLOCKED | grep `prorat\|proration`: 0; sin precios (`0009:40-44`); SRC-005 C08: «Fórmula exacta, redondeo, límites y reembolsos siguen abiertos» | Fórmula, redondeo, reembolsos, precios; modelo de concesión por ciclo y suscripción [INFERENCE sobre la forma] | ninguno |
| AC06.7 | Migración de revisión del mismo plan con vista previa y `expected_count` | IMPLEMENTED (DEC-0075) | `src/plans/assignment.ts:124-200`; `src/api/plan-catalog-routes.ts:130-140` | La vista previa y la reconciliación ignoran excesos de parámetros con ventana (`window !== null`) (`assignment.ts:143`; `quota.ts:372`) | `plan-catalog.test.ts:535-645,913-951` |

### AC07 — Impago: 7 días de gracia; luego suspensión y despublicación reversible (C09, C10)

| ID | Subrequisito | Estado | Evidencia | Falta (delta) | Tests existentes |
|---|---|---|---|---|---|
| AC07.1 | Estado de gracia / impago en la suscripción | OPEN | CHECK `active/suspended/cancelled` (`0009:34`; `policy.ts:19`) | Estado nuevo (p. ej. `past_due`) con semántica de capacidades parciales + migración del CHECK | ninguno |
| AC07.2 | Detectar fallo de pago y disparar la gracia | BLOCKED | Sin proveedor ni webhook (`src/subscriptions/payment.ts:27-40`; grep `stripe\|checkout\|billing\|past_due\|grace\|dunning`: sin implementación) | Proveedor; localmente, disparo administrativo o simulado etiquetado | ninguno |
| AC07.3 | Durante la gracia: página publicada, panel y operación manual disponibles | PARTIAL | Servidor: operaciones manuales no consultan la suscripción (§2.3); sitio depende solo de `client.status` y `client_website.status` (`src/website/local-site.ts:91-93,112-116`). Pero si la gracia se modela como «no activa»: (a) la recepción de reseñas se bloquea (`src/reputation/engine.ts:246-269`); (b) el panel oculta toda operación manual (`store.js:323`; `views-app.js:142-143,426-434`; `views-channels.js:369-374`) | Estado de gracia y clasificación explícita de operaciones permitidas; desacoplar recepción de reseñas de la suscripción (AC01); UI coherente con el servidor | ninguno (no hay prueba de operación manual con suscripción no activa) |
| AC07.4 | IA suspendida y sin nuevas cuotas durante la gracia | OPEN | Dispatcher sin gate de suscripción (`src/ai/dispatcher.ts:209,241-280`; `src/ai/governance.ts:26-38`); worker procesa todo negocio `active` (`src/engagement/worker.ts:73-77`); el ciclo se recalcula por tiempo (`policy.ts:160-169`) | Gate de estado de suscripción para casos de uso de IA; congelar generación de cuota del ciclo durante la gracia | ninguno |
| AC07.5 | Tras 7 días sin regularizar: suspender la suscripción | OPEN (scheduler local) + BLOCKED (disparo real) | Ningún job de ciclo de vida (`src/api/server.ts:378-424`: reconciliación, retención, worker, scheduler social, jobs IA); ningún escritor de `suspended` (§2.2) | Job/evaluación perezosa de vencimiento de gracia; valor 7 días está decidido (C09) | ninguno |
| AC07.6 | Despublicar de forma reversible tras la suspensión | PARTIAL | (a) `client.status='suspended'` despublica y es reversible, pero corta panel y sesiones (`platform-routes.ts:141-152`; `local-site.ts:92,115`; `identity/repository.ts:116-128`); (b) `client_website.status='suspended'` oculta el sitio (`0005:15`; prueba `website-restore-local-site.test.ts:310-313`) pero nadie lo escribe y el publicador lo pisa (`src/publishing/website.ts:108`); la suscripción no afecta la publicación | Ligar despublicación y restauración al estado de la suscripción; guard en el publicador | `website-restore-local-site.test.ts:264-314` (solo por SQL) |
| AC07.7 | Conservar contenido y configuración 60 días tras la suspensión | PARTIAL + BLOCKED (legal) | Nada borra al suspender; siguen las purgas globales (`src/retention/service.ts:34-43,202-240`) | Qué ocurre al día 60 no está definido; revisión legal | ninguno |
| AC07.8 | Avisos de gracia, suspensión y expiración (plataforma, correo, Telegram) | OPEN | Ver AC09 | Ver AC09 | ninguno |
| AC07.9 | Mecanismo de actualización de pago; reintento automático solo con autorización | BLOCKED | Sin proveedor | Proveedor y autorización | ninguno |
| AC07.10 | No apropiarse de dominios ni alterar servicios ajenos | IMPLEMENTED por ausencia | El servicio de dominio solo aprovisiona; no hay baja de DNS (`src/domain/service.ts:36-97`; `src/domain/hostinger.ts:31`) | — | ninguno específico |

### AC08 — Cancelación, retención 60 d, reactivación, import/export, borrado, aislamiento (C11, C12, C13)

| ID | Subrequisito | Estado | Evidencia | Falta (delta) | Tests existentes |
|---|---|---|---|---|---|
| AC08.1 | Cancelación voluntaria efectiva al final del periodo pagado, sin renovación | OPEN + BLOCKED («periodo pagado») | Solo baja inmediata por operador (CLI) con pérdida de acceso (`scripts/tenant-exit.ts:1-12,32-55`; `src/retention/service.ts:303-336`); sin acción de cancelación en la matriz del negocio (`src/rbac/matrix.ts:12-66`) | Solicitud self-service, marca de cancelación al final del periodo, permiso nuevo | `retention.test.ts:195-249` (baja inmediata) |
| AC08.2 | Retención de 60 días tras la cancelación | PARTIAL (valor en conflicto) | 30 días (`src/retention/service.ts:40`; `migrations/0015_retention_policy.sql:61`; `.canonflow/decision-records/DEC-0024.md:15`); 60 es compatible con el CHECK (≥30) | Reconciliar DEC-0024 frente a C12 y revisión legal; parametrizar | `retention.test.ts:195-249` (`grace_days: 30` en `:212-217`; «not before 30 days» en `:224-226`) |
| AC08.3 | Reactivación durante la retención | OPEN | Sin camino desde `exiting` (`platform-routes.ts:147-148`; `assignment.ts:70-71`; `retention/service.ts:308-310`) | Transición `exiting → active` con anulación de `tenant_exit` y auditoría | `plan-catalog.test.ts:953-975` (asignar durante la baja ⇒ 409) |
| AC08.4 | Reactivar suscripción suspendida/cancelada del mismo plan conserva revisión | IMPLEMENTED (alcanzable solo con negocio `active/suspended`; `cancelled` solo existe con negocio `exiting`) | `src/plans/assignment.ts:98-105` | — | `plan-catalog.test.ts:999-1003`; `quota-semantics.test.ts:499-500` |
| AC08.5 | Exportación | PARTIAL | Exportación completa solo dentro de la baja, por operador, archivo en el servidor (`retention/service.ts:311-318,513-527`); self-service solo auditoría (`analytics/export.ts:1-5`; `analytics-routes.ts:58`; `routes.ts:395`) | Exportación a petición del negocio durante la retención; formato y alcance (C12: por definir) | `retention.test.ts:202-210`; `analytics-inc007.test.ts` [INFERENCE: cubre export de auditoría; no leído] |
| AC08.6 | Importación | OPEN + BLOCKED (formato) | No existe (único uso del formato: `retention/service.ts:517`) | Formato, alcance y ejecución (C12) | ninguno |
| AC08.7 | Eliminación anticipada cuando proceda legalmente | PARTIAL + BLOCKED (legal) | Anonimización verificada existe (`retention/service.ts:345-417,568-601`) pero solo al vencer `anonymize_after` (`:241-255`) y el CHECK impide <30 días (`0015:61`) | Vía de solicitud, base legal, tratamiento de respaldos | `retention.test.ts:195-269,271` |
| AC08.8 | Aislamiento entre negocios (export, anonimización, cuotas) | IMPLEMENTED | Export por `tenant_id` (`retention/service.ts:519-525`); verificación de rastros (`:574-601`); candados de cuota por negocio (`quota.ts:172-174`) | — | `retention.test.ts:195-269`; `quota-semantics.test.ts:452` |
| AC08.9 | Reactivación sin penalización, sin regalar cuotas ni duplicar cobros | PARTIAL + BLOCKED (pago) | Reactivar conserva revisión y ancla (`assignment.ts:98-105,109-110`); el uso no se reinicia (`quota.ts:192-207`); no hay cobros | «Nuevo periodo mensual al pago de reactivación cuando no hay periodo activo» (re-anclaje) y no doble cobro de periodo pagado | `quota-semantics.test.ts:484-501` |

### AC09 — Avisos en canales aprobados; reportar entrega no verificada

| ID | Subrequisito | Estado | Evidencia | Falta (delta) | Tests existentes |
|---|---|---|---|---|---|
| AC09.1 | Avisos en plataforma (límite próximo/agotado, gracia, suspensión, vencimiento, opciones disponibles) | PARTIAL | Banner «plan no activo» (`views-app.js:55`); «Mi plan» con uso/límite (`views-app.js:243-268`); 403 con detalle (`policy.ts:128-142`) | Avisos de gracia/suspensión/vencimiento y umbrales (80/100 no aprobados, SRC-005 C05) | `subscriptions-inc006.test.ts:103`; `tests/e2e/plan-catalog-ui.test.ts:385-391` |
| AC09.2 | Correo | PARTIAL (infra) / OPEN (avisos) | `src/mail/mailer.ts:4-13,187-197`; por defecto `disabled` (`:6-7`); único uso: `src/identity/password-reset.ts:174` | Plantillas y disparo de avisos de suscripción; entrega real BLOCKED (transporte/remitente) [INFERENCE: no se inspeccionó configuración real; secretos no leídos] | `tests/unit/mailer.test.ts:120-274`; `tests/integration/password-reset.test.ts` |
| AC09.3 | Telegram | PARTIAL (infra) / OPEN (avisos) | Solo avisos de casos (`src/engagement/service.ts:580-639`); entrega real `BLOCKED_EXTERNAL` (`docs/architecture/telegram-webhook-starlink.md:5-6,18-19`) | Avisos de suscripción por chat vinculado | `engagement-agent.test.ts:348,376-378,396-397` |
| AC09.4 | Reportar entrega no verificada (no inventar) | PARTIAL (patrón existe) | `DisabledMailer` devuelve `sent:false` (`mailer.ts:43-56`); `no_destination` (`engagement/service.ts:594-599`); auditoría `telegram:<canal>` (`:634`) | Libro de avisos de suscripción con estado honesto por canal | `mailer.test.ts:260-269`; `engagement-agent.test.ts:348` |

### AC10 — Trial sin tarjeta, sin publicación real y con límites verificables (C14, DEC-0018)

| ID | Subrequisito | Estado | Evidencia | Falta (delta) | Tests existentes |
|---|---|---|---|---|---|
| AC10.1 | Plan `trial` asignado por Administration con vencimiento | OPEN | Sin plan `trial`, sin vencimiento, sin `EXPIRED` (`0009:34,40-44`); «pendiente de implementación» (`FR-0010.md:59`; `DEC-0075.md:37`) | Plan + vencimiento + transición a expirado (DEC-0018) | ninguno |
| AC10.2 | Alta asistida asigna Trial (DEC-0039) | OPEN (conflicto CF-16) | `src/identity/onboarding.ts:64-69` asigna `plan_piloto_1` indefinido; opción rechazada `trial_es_piloto` (`DEC-0018.md:19`); CF-16 abierto (`docs/research/plan-parameters-inventory.md:683`) | Decidir si el alta usa `trial` (OD-11) | `onboarding.test.ts:59-61` (afirma plan piloto) |
| AC10.3 | Sin tarjeta ni cobros automáticos | IMPLEMENTED por ausencia | Sin SDK; `invoice` PROHIBITED sin precio (`entitlements.ts:147-156`); precios NULL (`0009:40-44`) | — | `subscriptions-inc006.test.ts:121-137`; `subscriptions.test.ts:33-37` |
| AC10.4 | Sin publicación real antes de contratar | OPEN (y en conflicto con DEC-0018) | La publicación no consulta plan (`src/publishing/website.ts:63-123`); `plan_piloto_1` permite 1 página (`0009:47`); DEC-0018: «los mismos [límites y funcionalidades] que `plan_piloto_1`» (`DEC-0018.md:36`) | Gate de publicación por plan/estado; reconciliar DEC-0018 con C14 | ninguno |
| AC10.5 | Límites verificables (incluida IA limitada) | PARTIAL + BLOCKED (valores) | Las 6 capacidades se aplican por revisión (`quota.ts:215-231`); IA no es parámetro de plan (OD-13, `plan-parameters-inventory.md:646`); solo presupuesto USD por día y negocio (`src/ai/catalog.ts:360-363`) | Límite de IA por plan (AC01/AC02); duración, volumen, antiabuso (C14; OD-11 `plan-parameters-inventory.md:644`) | `quota-semantics.test.ts`; `plan-catalog.test.ts:535-645` |
| AC10.6 | Al vencer: DENY sin borrar datos | OPEN (reutilizable) | El deny de no-activa ya existe (`policy.ts:100-106`); nada borra al dejar de estar activa | Estado `expired` y transición | ninguno |

---

## 4. Cómo cambia hoy la plataforma el estado de la suscripción; `GET /tenants/:id`; «Mi plan»

### 4.1 Rutas y permisos (Administration `/plataforma`, Engineering `/ingenieria`, CLI)

| Efecto sobre la suscripción | Vía | Permiso / control | Evidencia |
|---|---|---|---|
| Alta (INSERT `active`) | `POST /api/platform/tenants/:id/plan` (sin suscripción previa) | `subscriptions.assign` (solo `platform_admin`) + step-up TOTP + motivo | `src/api/platform-routes.ts:154-165`; `src/platform/permissions.ts:18-19,32-35`; `src/platform/auth.ts:26,489-508` |
| Cambio de plan (UPSERT `active`) | misma ruta, otro plan | ídem | `src/plans/assignment.ts:107-111` |
| Reactivación (`suspended/cancelled → active`, conserva revisión) | misma ruta, mismo plan | ídem; negocio `active/suspended` | `src/plans/assignment.ts:67-72,98-105` |
| Migración de revisión | `POST /api/platform/plan-catalog/plans/:planId/migrate-subscriptions` | `subscriptions.assign` + step-up + `expected_count` | `src/api/plan-catalog-routes.ts:130-140` |
| Cancelación | CLI `npm run tenant:exit -- confirm` (sin ruta HTTP) | operador con acceso a BD | `scripts/tenant-exit.ts:4-8,50-54`; `src/retention/service.ts:326` |
| Suspensión de la suscripción | **No existe** (solo SQL) | — | §2.2 |
| Alta asistida | CLI `invite-owner` (`--plan`, por omisión `plan_piloto_1`) | operador | `scripts/invite-owner.ts:24,32`; `src/identity/onboarding.ts:64-69` |
| «Suspender/Reactivar» en la consola | `POST /api/platform/tenants/:id/status` → cambia **`client.status`**, no la suscripción | `platform_admin` + step-up + motivo | `src/api/platform-routes.ts:141-152`; `console.js:118-121,832-837` |
| Autoasignación del negocio | `POST /api/backoffice/subscriptions/assign` → 403 auditado | — | `src/api/subscription-routes.ts:60-65` |

### 4.2 `GET /api/platform/tenants/:id` (permiso `tenants.read`: `platform_admin`, `platform_support`)

- `tenant`: `client_id, business_name, status, data_classification, created_at, plan_id, plan, subscription_status, plan_revision_id, plan_revision_version, plan_revision_status` (`src/api/platform-routes.ts:118-124`).
- `plan_usage`: por cada definición del registro, `key, capability, label, unit, period, enforced, limit, usage` con la misma cuenta que el enforcement (`platform-routes.ts:125-131`; `quota.ts:247-261`). **No expone** `started_at`, la ventana del ciclo (`capacityStatus.window` se descarta) ni el historial.
- Además `ai_30d`, `connections`, `support_access`, `jobs_30d` (`platform-routes.ts:132-138`).
- Consola: «Cuenta» muestra plan, revisión y estado de la suscripción; «Alta» es `client.created_at`, no `started_at` (`console.js:110-111`); «Plan y consumo» lista uso de límite (`console.js:112-114`); «Asignar plan» (`console.js:126-136`).
- Pruebas: `plan-catalog.test.ts:641-644,1235-1237`; `tests/e2e/plan-catalog-ui.test.ts:318`.

### 4.3 Panel «Mi plan» (`#/negocio/plan`)

- Fuente: `GET /api/backoffice/subscriptions/entitlements` (`subscription.read`, los 3 perfiles), que devuelve suscripción (incluye `status`, `started_at`), plan (incluye `price_cents`, `is_pilot`), revisión, `limits`, `usage` y `parameters[{key, capability, label, unit, semantics, period, value, usage, enforced}]`; 404 sin suscripción (`src/api/subscription-routes.ts:67-82`; `src/subscriptions/entitlements.ts:48-58,105-129`). No incluye ventana de ciclo.
- Vista: nombre del plan, etiqueta «Activo/No activo» (`S.trial`), descripción, banner bloqueante si no activo, lista «Lo que incluye» con uso/máximo/periodo, «No incluido», «Este límite todavía no se aplica», «Completo», «Por encima del límite», nota «Sin cobros: tu plan no tiene precio aprobado» (`views-app.js:243-268`). No muestra fecha de inicio, ciclo, renovación ni vencimiento. Se refresca al entrar (`src/web/panel/assets/js/main.js:880-881`).
- Pruebas: `plan-catalog.test.ts:1188-1246`; `tests/e2e/plan-catalog-ui.test.ts:385-391`.

---

## 5. AC11 — Superficie de PR #13/#14 y catálogo de permisos (evitar cambios involuntarios)

### 5.1 Comandos y totales

| Rango | Resultado |
|---|---|
| `git diff --stat 95f9436..b1cd3df` (PR #13) | 72 archivos, +105231 / −401 |
| `git diff --stat b1cd3df..f68746b` (PR #14) | 42 archivos, +3247 / −104 |
| `git diff --shortstat 95f9436..f68746b` (PR #13+#14) | **105 archivos**, +108419 / −446 |
| `git diff --stat f68746b..83619f0` (handoff) | 2 archivos: `docs/handoffs/commercial-policy-2026-11-05/{HANDOFF,START-PROMPT}.md` |

### 5.2 Código, migraciones, scripts y pruebas tocados por PR #13+#14 (`git diff --name-only 95f9436..f68746b -- src migrations scripts tests`, 50 archivos)

- Migraciones: `migrations/0034_plan_policy_catalog.sql`, `migrations/0035_platform_auth_shared_attempts.sql`.
- Scripts: `scripts/anonymization-dry-run.ts`, `scripts/migrate.ts`, `scripts/plan-catalog-gmig-preflight.sql`, `scripts/plan-catalog-hardening-rollback.sql`, `scripts/plan-catalog-legacy-audit-preflight.sql`, `scripts/plan-catalog-legacy-audit-repair.sql`, `scripts/plan-catalog-rollback-preflight.sql`, `scripts/plan-catalog-rollback.sql`.
- `src`: `ai/lab.ts`, `api/plan-catalog-routes.ts`, `api/platform-routes.ts`, `api/subscription-routes.ts`, `audit/event.ts`, `conversation/state-machine.ts`, `db/pool.ts`, `identity/onboarding.ts`, `plans/assignment.ts`, `plans/catalog.ts`, `plans/policy.ts`, `plans/registry.ts`, `platform/auth.ts`, `platform/permissions.ts`, `rbac/matrix.ts`, `retention/service.ts`, `subscriptions/entitlements.ts`, `subscriptions/quota.ts`, `web/panel/assets/js/{main,store,views-app}.js`, `web/platform/assets/console.{css,js}`.
- Tests: `e2e/inc004-inc006-e2e.test.ts`, `e2e/plan-catalog-ui.test.ts`, `helpers/{plans,platform-auth-worker,psql,tenants}.ts`, `integration/{ai-manual-lab,nfr-0001-atomicity,plan-catalog-legacy-audit-repair,plan-catalog-migration,plan-catalog,platform-auth-multiprocess,quota-semantics,subscriptions-inc006}.test.ts`, `unit/{plan-policy,platform-reason,subscriptions}.test.ts`.
- Resto (docs/evidencia/canon): `.canonflow/*` (DEC-0075, SRC-0013, FR/BR deltas), `docs/architecture/plan-catalog*.md`, `docs/research/plan-parameters-inventory*`, `evidence/plan-catalog/**`, `README.md`.

**Observación**: casi todas las superficies de ciclo de vida (`policy.ts`, `assignment.ts`, `quota.ts`, `entitlements.ts`, `platform-routes.ts`, `retention/service.ts`, `onboarding.ts`, panel y consola) están en ese conjunto. Un incremento posterior necesariamente añade commits sobre ellas en la rama apilada; lo que AC11 puede proteger es no reescribir esos commits, no editar migraciones ya numeradas (0034/0035) ni los scripts de reversión/preflight, y mantener verdes las pruebas de PR #13/#14 [INFERENCE sobre la estrategia; decisión del agente principal].

### 5.3 Acoplamientos de G-MIG que una migración nueva puede romper

- La reversión de 0034 **aborta si hay migraciones posteriores a 0034** (`scripts/plan-catalog-rollback.sql:69-70`); el preflight lo reporta (`scripts/plan-catalog-rollback-preflight.sql:52-53`). Una 0036 de ciclo de vida necesitaría su propia reversión y orden documentado (como `scripts/plan-catalog-hardening-rollback.sql` para 0035).
- La reversión elimina `subscription.plan_revision_id`, triggers e historial (`scripts/plan-catalog-rollback.sql:91-99`) y bloquea `subscription` en `ACCESS EXCLUSIVE` (`:67-68`).
- Los preflights asumen las 6 capacidades de 0014 (`scripts/plan-catalog-rollback-preflight.sql:24-26`; `scripts/plan-catalog-gmig-preflight.sql:46-47,57-59`): una capacidad nueva cambia sus resultados.

### 5.4 Catálogo de permisos

| Catálogo | Contenido relevante | Evidencia |
|---|---|---|
| Negocio (RBAC, fuente de verdad) | Acciones `subscription.admin` (facturación, PROHIBITED sin precio) y `subscription.read`; `administration` = todo salvo bloqueadas; `operation` y `read_only` solo `subscription.read` | `src/rbac/matrix.ts:42-44,93-125,167-168`; motor `src/rbac/engine.ts:19-34` |
| Espejo BD del RBAC (debe coincidir, prueba de sincronía) | `permission`/`role_permission` | `migrations/0009_subscriptions_plans.sql:69-80`; `migrations/0034_plan_policy_catalog.sql:466-471`; `src/rbac/matrix.ts:88-92`; `tests/integration/rbac-context.test.ts:128-147` |
| Plataforma | `plans.read` (admin, ingeniería, soporte), `plans.edit`, `plans.publish` (admin, ingeniería), `subscriptions.assign` (solo admin), `tenants.read` (admin, soporte); escrituras con step-up | `src/platform/permissions.ts:11-35`; roles `src/platform/auth.ts:24`; step-up 10 min `src/platform/auth.ts:26,505-508` |
| Guardas por rol (no por permiso) | `platform.tenant.status`, `platform.tenant.data_classification` (solo `platform_admin` + step-up) | `src/api/platform-routes.ts:141,168` |
| Pruebas de autorización | asignar y migrar solo `platform_admin`; denegaciones auditadas | `tests/integration/plan-catalog.test.ts:326-397,399-446`; `tests/unit/subscriptions.test.ts` |

No existe ninguna acción/permiso para cancelar, exportar contenido, importar, gestionar pago, suspender suscripción ni gestionar trial (grep de `ACTIONS` en `src/rbac/matrix.ts:12-66` y `PLATFORM_PERMISSIONS`).

---

## 6. Pruebas existentes por AC

| AC | Pruebas | Qué cubren (y qué no) |
|---|---|---|
| AC04 | `tests/unit/plan-policy.test.ts:38-134`; `tests/integration/quota-semantics.test.ts:245-333,414-450,484-501,503-521`; `tests/integration/plan-catalog-migration.test.ts:315-319` | Ciclo UTC, fronteras, bisiestos, DST, consumo periódico, concurrencia, deny no activa, revisión SUPERSEDED, backfill sin mover suscripciones. **No**: parámetros reales periódicos, ancla tras cambio de plan, no-arrastre aislado, pago |
| AC06 | `tests/integration/plan-catalog.test.ts:535-645,913-951,977-1030`; `tests/integration/subscriptions-inc006.test.ts:30,76,87-119` | Asignar, noop, reactivar, migrar, cambiar plan (historial y auditorías), downgrade sin borrados, uso sobre límite. **No**: uso tras cambio a otro plan, prorrateo, diferido |
| AC07 | `quota-semantics.test.ts:484-501`; `subscriptions-inc006.test.ts:191-241`; `tests/integration/website-restore-local-site.test.ts:264-314`; `tests/integration/ai-manual-lab.test.ts:326-327` | Deny `subscription_required` al consumir; sitio 404 con `client_website='suspended'` (por SQL); grant de laboratorio con negocio suspendido. **No**: gracia, suspensión por ruta, efectos de `client.status` sobre sesión/sitio, operaciones manuales con suscripción no activa, Telegram con negocio suspendido |
| AC08 | `tests/integration/retention.test.ts:195-249,251-269,271`; `plan-catalog.test.ts:953-975,999-1003,1270-1355` | Baja con export, 30 días, anonimización sin rastros, reaplicación tras restaurar, asignar durante baja ⇒ 409, reactivar suspendida. **No**: 60 días, reactivar desde `exiting`, import, export self-service |
| AC09 | `tests/unit/mailer.test.ts:120-274`; `tests/integration/password-reset.test.ts`; `tests/integration/engagement-agent.test.ts:348,376-378,396-397`; `tests/e2e/plan-catalog-ui.test.ts:385-391` | Transportes de correo y `disabled` honesto; avisos de casos y `no_destination`; «Mi plan» en E2E. **No**: ningún aviso de suscripción/cuota |
| AC10 | `subscriptions-inc006.test.ts:121-137`; `tests/unit/subscriptions.test.ts:33-37`; `tests/integration/onboarding.test.ts:59-61` | Facturar sin precio PROHIBITED; proveedor simulado; alta con plan piloto. **No**: trial |
| AC11 | `tests/integration/rbac-context.test.ts:128-147`; `plan-catalog.test.ts:326-446`; `plan-catalog-migration.test.ts` (reversión/preflights, 21 pruebas según PR #14) | Espejo RBAC, permisos de plataforma, migración y reversión |

---

## 7. Dependencias: insumos no disponibles vs política local pura

### 7.1 Requieren insumos no disponibles (BLOCKED)

| Insumo | ACs afectados | Base |
|---|---|---|
| Proveedor de pago real (credenciales, webhooks, confirmación, fallo, reintento, actualización de medio de pago, reembolsos) | AC04.3/.6/.7/.8, AC06.2, AC07.2/.9, AC08.1 (periodo pagado), AC08.9 | `src/subscriptions/payment.ts:1-8`; `package.json`; PATCH «No alcance… cobros reales sin proveedor/autorización» (`/tmp/msp-commercial/PATCH.md:25`) |
| Precios por plan (Q-004; BR-0006) | AC04.8, AC06.2, AC06.6 | `0009:40-44`; `BR-0006.md:13`; SRC-005 C03 (`SRC-005.md:23`) |
| Fórmula de prorrateo (precio y capacidad), redondeo, límites, reembolsos | AC06.6, AC06.5 | SRC-005 C08 (`SRC-005.md:28`) |
| Trial: duración, volumen, IA permitida, antiabuso; semántica de «publicación real» | AC10.1/.4/.5 | SRC-005 C14 (`SRC-005.md:34`); OD-11 (`plan-parameters-inventory.md:644`) |
| Retención legal: 60 días frente a DEC-0024 (30), eliminación anticipada, respaldos | AC07.7, AC08.2, AC08.7 | SRC-005 C10/C12 (`SRC-005.md:30,32`); `DEC-0024.md:15`; PATCH punto 7 (`PATCH.md:40`) |
| Formato y alcance de import/export | AC08.5, AC08.6 | SRC-005 C12 (`SRC-005.md:32`) |
| Umbrales de aviso (80/100 solo ejemplo) y fallback de canales no vinculados | AC09.1 | SRC-005 C05 (`SRC-005.md:25`); PATCH STG-COM-05 (`PATCH.md:19`) |
| Entrega real Telegram (bot autorizado) y correo (transporte/remitente verificado) | AC09.2, AC09.3 | `docs/architecture/telegram-webhook-starlink.md:5-6,18-19`; `src/mail/mailer.ts:6-7` |
| Autoridad canónica (doc repo 0.0.0 vs `.canonflow` DEC-0075; HDC-MSP-06) | todos los cambios de enforcement | HANDOFF «Reconciliar autoridad…»; `DEC-0010.md:46` |

### 7.2 Política local pura (sin insumos externos; requiere autorización canónica antes de implementar)

- Estados nuevos de suscripción (gracia/impago, pendiente de pago, expirada) + migración del CHECK + máquina de estados auditada en `subscription_history` (el CHECK de `change_kind` ya admite `status_change`, `0034:284`).
- Transiciones disparadas por Administration o por un evento de pago **simulado y etiquetado** (sin afirmar cobro real).
- Clasificación de operaciones por estado: manuales permitidas en gracia; IA bloqueada en gracia; recepción de reseñas desacoplada de la suscripción (enlaza con AC01).
- Gate de estado de suscripción en el dispatcher/casos de uso de IA y en el worker de atención.
- Job o evaluación perezosa: 7 días de gracia (valor decidido, C09) → suspensión → despublicación (`client_website.status`) y restauración al reactivar; guard en el publicador.
- Downgrade programado a la frontera del ciclo `monthlyCycle(started_at)`.
- Regla de re-anclaje al reactivar sin periodo activo (dado un evento de pago, aunque sea simulado).
- Cancelación al final del periodo (marca) + solicitud self-service con permiso nuevo + reactivación desde `exiting` dentro de la ventana; parametrizar la ventana (el valor 60 depende de 7.1).
- Avisos en panel y libro de avisos por correo/Telegram con estado honesto (`transport_disabled`, `no_destination`, `failed`).
- Pruebas que faltan: ancla invariable tras cambio/reactivación; no-arrastre aislado; uso tras cambio a otro plan; operaciones manuales con suscripción no activa; efectos de la ruta de suspensión de negocio.

---

## 8. Conflictos canónicos detectados (entrada para F1; no se deciden aquí)

1. **Retención tras baja**: DEC-0024 «anonimizar a los 30 días» (`.canonflow/decision-records/DEC-0024.md:15`; código `retention/service.ts:40`, CHECK `0015:61`) frente a SRC-005 C12 «60 días» (`SRC-005.md:32`).
2. **Trial**: DEC-0018 (mismas funciones que `plan_piloto_1`, 30 días, `EXPIRED`) (`DEC-0018.md:35-39`) frente a SRC-005 C14 (sin publicación real antes de contratar; duración abierta) (`SRC-005.md:34`).
3. **Ciclo, rollover y cambios de plan**: reservados a HDC-MSP-06 (`DEC-0010.md:46`; `DEC-0075.md:36`) frente a decisiones C04/C06/C07/C08 de SRC-005, que están en staging no canónico (`/tmp/msp-commercial/PATCH.md:1-12`).
4. **CF-16**: alta asistida asigna `plan_piloto_1` indefinido (`onboarding.ts:64-69`) frente a DEC-0018/DEC-0039.
5. **Suscripción no activa**: el canon dice «lecturas permitidas, creaciones denegadas» (`FR-0010.md:14,44`); el panel bloquea además operaciones manuales que el servidor permite; C09 exige manual disponible durante la gracia.

---

## 9. Riesgos y hallazgos laterales (observados en código; no corregidos)

- **Telegram ignora la suspensión del negocio**: un chat ya vinculado puede `/aprobar` y publicar respuestas aunque `client.status='suspended'` (`src/engagement/telegram.ts:168-211`; `src/engagement/service.ts:365-399,436+`). Sin prueba; solo afecta al modo real, hoy `BLOCKED_EXTERNAL`.
- **Incoherencia panel/servidor**: el panel bloquea operaciones manuales con suscripción no activa; el servidor no (§2.3).
- **El publicador pisa `client_website.status`** con `published` (`src/publishing/website.ts:108`): una despublicación por estado se desharía con la siguiente publicación.
- **Exceso periódico invisible**: la vista previa de migración y la reconciliación solo reportan parámetros sin ventana (`src/plans/assignment.ts:143`; `src/subscriptions/quota.ts:372`).
- **El ciclo avanza durante la suspensión**: al reactivar, el ciclo vigente se calcula desde el ancla original, sin ligarse a pago (`policy.ts:160-169`) [efecto de negocio = INFERENCE].
- **Recepción de reseñas atada a suscripción y cuota** (`reputation/engine.ts:246-269`): cualquier estado no activo detiene la ingesta (conflicto con C01/C09).
- **G-MIG**: migraciones posteriores a 0034 bloquean la reversión documentada hasta revertirlas primero (`scripts/plan-catalog-rollback.sql:69-70`).

---

## 10. Límites de este diagnóstico

- No se ejecutaron pruebas, migraciones ni servidores (fuera de mandato F0); el estado «tests existentes» se basa en lectura de código de prueba, no en ejecución.
- No se inspeccionó ninguna BD (ni la de desarrollo): la afirmación «ningún plan usa semántica periódica» se basa en el registro, la migración 0034 y la FK de valores; una BD alterada a mano podría diferir [INFERENCE].
- No se leyeron secretos ni `.env`; el estado de transportes reales de correo/Telegram se toma de la documentación del repositorio.
- `tests/integration/analytics-inc007.test.ts` y `tests/integration/password-reset.test.ts` se citan por nombre; su contenido no se leyó en detalle.
- El repositorio documental y el canon se citaron solo donde afectan la clasificación; la reconciliación es de F1.

---

## Anexo A — Archivos no-código tocados por PR #13+#14 (55; complementan los 50 de §5.2 = 105)

Comando: `git diff --name-only 95f9436..f68746b -- . ':(exclude)src' ':(exclude)migrations' ':(exclude)scripts' ':(exclude)tests'`.

- Canon: `.canonflow/canon/functional/CHANGELOG.md`, `.canonflow/canon/functional/index.yaml`, `.canonflow/canon/functional/items/{BR-0007,FR-0010,FR-0018,FR-0019}.md`, `.canonflow/decision-records/DEC-0075.{json,md}`, `.canonflow/decision-state/index.json`, `.canonflow/decision-state/legacy/index.json.9c4b8caab90bdae5ce512bf9f5ff192baa9cc70d18a89f2fc580f1954f20c9da.json`, `.canonflow/decision-state/legacy/manifest.json`, `.canonflow/sources/source-register.yaml`, `.canonflow/sources/SRC-0013-plan-catalog-directive.md`, `.canonflow/state/{functional-canon-state,implementation-state}.yaml`, `.canonflow/traceability/links.yaml`.
- Docs: `README.md`, `docs/architecture/plan-catalog.md`, `docs/architecture/plan-catalog-gates-hardening.md`, `docs/handoffs/plan-policy-catalog-2026-11-04/REVIEW-GATES-PR14.md`, `docs/research/plan-parameters-inventory.{csv,json,md}`, `docs/research/plan-parameters-inventory/merge.py`, `docs/research/plan-parameters-inventory/slices/{V1-web-media-brand,V2-ai,V3-engagement-social,V4-platform-core,V5-canon-governance}.json`.
- Evidencia: `evidence/plan-catalog/{agent-model-manifest.md,CIERRE.md,e2e-ui.txt,test-runs.txt}`, `evidence/plan-catalog/ui/0{1..8}-*.png` (8 capturas), `evidence/plan-catalog/gates-pr14/{README.md,e2e-inc004-006.txt,e2e-plan-catalog-ui.txt,gmig01-rollback-race-before-6e1eff8.txt,gsec07-connection-loss-before-after.txt,gsec14-login-timing.txt,multiprocess-before-6e1eff8.txt,new01-login-flood.txt,new02-r1-scan-performance.txt,new07-saturation-before-2060725.txt,new09-head-of-line-before-ca37e01.txt,new10-pool-stall-after.txt,pg-restart-real.txt,test-runs-b3b0447.txt}`.
