# Evidencia — DEC-0076, cuotas comerciales de reseñas (2026-11-05)

Rama `feat/commercial-quota-semantics-20261105`, apilada sobre PR #15 (`83619f0`) → PR #14 (`f68746b`) → PR #13 (`b1cd3df`). Diseño, matriz y pendientes: `docs/architecture/commercial-quota.md`.

Sin despliegue, sin migraciones en bases reales, sin cobros, sin llamadas a proveedores de IA reales y sin cambios de configuración permanentes. Este documento no aprueba nada reservado al propietario. **Producción: NO-GO.**

## 1. Entorno

- Worktree aislado `/home/administrador/codeart/mainspoot/mainspot-platform-commercial`. El checkout principal (`feat/canonflow-implementation`, con 2 commits locales ajenos sin publicar) y los worktrees de PR #13/#14 no se tocaron.
- PostgreSQL 16.15 desechable en el contenedor propio `mainspot-commercial-pg-20261105` (`127.0.0.1:55497`). No se tocó `mainspot-platform-postgres-1` ni la BD `mainspot` de desarrollo. Las pruebas de migración crean y borran sus BD (`mainspot_cq_mig_*`, `mainspot_plancat_*`).
- Node v24.16.0, psql 16.15. AI Core en el entorno `test` con rutas **simuladas** (sin proveedor real); Jev simulado.
- E2E de navegador: Chrome headless (playwright-core) por `https://app.mainspot.local.io` con TLS verificado. Según `.omp/AGENTS.md`, `mainspot-local` se detuvo durante cada ejecución y se volvió a arrancar (activo y panel 200 al terminar). Infraestructura (hosts, LXC, TLS, WireGuard) sin cambios.

## 2. Commits

| SHA | Contenido |
|---|---|
| `5304bc8` | Canon: SRC-0014 (copia byte a byte del extracto SRC-005), SRC-0015 (directiva literal), DEC-0076, delta 0.7.0 de FR-0008/FR-0010/FR-0016, trazabilidad e índices |
| `41d1d1f` | Registro 2 y migración 0036 con su reversión; recepción sin cuota; IA medida; API y panel; pruebas |

A estos se suma el commit de documentación y evidencia que contiene este archivo.

## 3. Ejecuciones (BD desechable)

| SHA | tsc | Unitarias | Integración | Smoke | E2E navegador (checks) |
|---|---|---|---|---|---|
| `83619f0` (línea base) | 0 | 187/187 | 254/254 | — | — |
| `41d1d1f` | 0 | 187/187 | **270/270** | 5/5 | 3/3: cuota IA 24/24, Planes 43/43, INC-004/006 20/20 |

Listados completos: `test-runs-41d1d1f.txt` y `test-runs-83619f0-baseline.txt`. Transcripciones E2E: `e2e-ui.txt` (cuota de IA, con huellas sha256/16 de los assets servidos), `e2e-plan-catalog-ui.txt` y `e2e-inc004-006.txt`; capturas en `ui/`. Su cabecera dice «+ cambios sin commitear del árbol de trabajo»: en ese momento solo lo eran estos documentos y la evidencia, sin código. Las transcripciones de PR #13 (`evidence/plan-catalog/e2e-ui.txt`, `evidence/e2e-inc004-006.txt`) se dejaron como estaban.

Comandos (desde el worktree):

```sh
export DATABASE_URL=postgres://mainspot:***@127.0.0.1:55497/mainspot TEST_DATABASE_URL=postgres://mainspot:***@127.0.0.1:55497/mainspot_test APP_ENV=test
npx tsc --noEmit
npm run test:unit && npm run test:integration && npm run test:smoke
sudo systemctl stop mainspot-local
node scripts/test-prep.ts && EVIDENCE_SCREENSHOTS=1 node --test --test-concurrency=1 tests/e2e/commercial-quota-ui.test.ts
node scripts/test-prep.ts && node --test --test-concurrency=1 tests/e2e/plan-catalog-ui.test.ts tests/e2e/inc004-inc006-e2e.test.ts
sudo systemctl start mainspot-local
```

Validación offline del canon (`~/codeart/canonflow-keystone`, sin red): `validate_schemas_v2.py` VALID para `DEC-0076.json`, `source-register.yaml`, `decision-state/index.json` y `links.yaml`; `validate_traceability.py` 5/101, los mismos 5 fallos preexistentes (enlaces 62, 68, 73, 79, 83). `sha256sum` de SRC-0014 = `535c0ede…540c` (igual al blob documental) y SRC-0015 = `14a84078…ef89`.

## 4. Pruebas permanentes nuevas o ampliadas

- `tests/integration/commercial-quota.test.ts` (13): AC01 por sync y worker con `reviews_managed` e IA en 0; acceso sin suscripción; atomicidad del lote; «Redactar con IA» = 1 por caso, replay, agotada, manual en panel y Telegram sin consumo; 8 peticiones simultáneas con límite 3 y 6 sobre un mismo caso; propuesta aparte sin renumerar el aviso de Telegram; ciclo siguiente, no acumulación y ancla al cambiar de plan; fail-closed sin parámetro o sin suscripción; anti-oráculo multi-negocio; fallo de IA sin consumo; respuesta automática medida y agotada; clasificaciones simultáneas; Facebook fuera de la cuota.
- `tests/integration/commercial-quota-migration.test.ts` (4): espejo = registro 2, nada más cambia y re-ejecutable; reversión exacta (pg y psql); bloqueada por valor, reserva o `ai_draft`; orden 0036 → 0035 → 0034.
- `tests/e2e/commercial-quota-ui.test.ts` (24 checks): flujo completo en el panel por el dominio.
- Ajustes: `plan-catalog-migration.test.ts` (registro 1 en BD con 0034/0035), `plan-catalog.test.ts` (regresión F3: más reseñas que `reviews_managed` no es un exceso), `plan-catalog-ui.test.ts` (7 parámetros), `subscriptions-inc006.test.ts` (se retira la prueba del antiguo tope de recepción, sustituida por AC01), `tests/helpers/plans.ts` (definiciones leídas de la BD).

## 5. Revisión independiente

`f3-independent-review.md` (agente QuotaReview, Claude Opus 5.5, esfuerzo max): 11 hallazgos sobre el diff sin commit (1 HIGH, 4 MEDIUM, 5 LOW, NIT) sin doble ni sub-contabilidad. Todos se corrigieron o documentaron antes de `41d1d1f` y la re-verificación del mismo agente dio PASS a F1–F10 y PASS parcial a F11 (queda el NIT de 502 con código `validation_error`, igual que la ruta del laboratorio). Antes y después:

| Hallazgo | Antes | Después |
|---|---|---|
| F1 HIGH: `/aprobar N` tras «Redactar con IA» publicaba un texto no visto | sonda P1 reproducida | propuesta en `ai_draft`; prueba «La propuesta con IA va aparte…» |
| F2 edición que borraba la propuesta cobrada | sondas P2/P5 | `ai_draft` fuera del arreglo editable |
| F3 vista previa marcaba `reviews_managed` en exceso | regresión falla sin el arreglo (observado) | `ENFORCED_KEYS` en `assignment.ts` |
| F6 reserva vencida cortaba el tick | sonda P3 | TTL 15 min y caída al texto seguro |
| F10 prueba no determinista | ≈3 % de fallo | acepta ambos ganadores; ids de update por ejecución |

Riesgos que quedan (LOW, documentados): una reserva huérfana tras una caída ocupa la unidad hasta 15 min; editar una opción numerada después del aviso cambia lo que publica `/aprobar N` (preexistente); consentimientos previos conservan su texto (la pantalla de reglas sí avisa).

Diagnóstico F0: `f0-canon-reconciliation.md` (autoridad, precedente SRC-0013/DEC-0075, mapeo C01–C14, conflictos, ids) y `f0-lifecycle-inventory.md` (AC04, AC06–AC11 con `ruta:línea`). Ambos de solo lectura.

## 6. Modelos

Sesión principal y los tres subagentes (CanonRecon, LifecycleInventory, QuotaReview): `anthropic/claude-opus-5-5`; los subagentes con el perfil `.omp/agents/opus-max.md` (`thinking-level: max`) y la primera línea de cada respuesta con su id de modelo. Ningún agente usó Fable ni modelos económicos.

## 7. Límites

- Proveedores simulados: nada aquí prueba Anthropic, TypeSafe, Google, Meta ni Telegram reales.
- G-MIG de 0036 sobre una copia restaurada de producción: no ejecutado (sin acceso ni autorización).
- La respuesta automática medida se prueba con un lector semántico controlado: el Jev simulado del entorno `test` marca riesgos en todo texto y nunca llega a la respuesta automática.
- Valores de cuota usados en pruebas (1, 2, 3, 5) son fixtures, no ofertas.
