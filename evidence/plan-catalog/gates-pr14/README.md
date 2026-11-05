# Evidencia — PR #14 (G-MIG / G-SEC), 2026-11-05

Rama `fix/plan-catalog-gates-hardening-20261104`, apilada sobre PR #13 (`b1cd3df`). Diseño, procedimiento y la tabla completa de hallazgos están en `docs/architecture/plan-catalog-gates-hardening.md`.

No hubo despliegue, ni reparaciones sobre bases reales, ni llamadas a proveedores reales, ni cambios de configuración permanentes. Este documento no aprueba nada reservado al propietario. **NO-GO producción.**

## 1. Entorno

- Worktree aislado `/home/administrador/codeart/mainspoot/mainspot-platform-plan-gates`. El checkout principal (`feat/canonflow-implementation`, con cambios ajenos sin commitear) no se tocó.
- PostgreSQL 16.15 desechable en el contenedor propio `mainspot-gates-pg-20261105` (`127.0.0.1:55499`). El reinicio real se probó en un segundo contenedor desechable, ya eliminado. No se tocó `mainspot-platform-postgres-1` ni las BD `mainspot` de desarrollo.
- Node v24.16.0 y psql 16.15.
- E2E:
  - `tests/e2e/plan-catalog-ui.test.ts` es de navegador: Chrome (playwright-core) por `https://app.mainspot.local.io`, con TLS verificado;
  - `tests/e2e/inc004-inc006-e2e.test.ts` es de API, sin navegador, contra un servidor de la app que levanta la propia prueba (`bootApi`).

  Según `.omp/AGENTS.md`, `mainspot-local` se detuvo durante cada ejecución y se volvió a arrancar (activo y panel 200 al terminar).
- `TEST_DATABASE_URL`/`DATABASE_URL` apuntaban siempre a la instancia desechable. Las pruebas de scripts crean sus propias BD desechables (`mainspot_r1_*` y `mainspot_plancat_mig_*`) y las borran al terminar.

## 2. Commits de esta ejecución

| SHA | Contenido |
|---|---|
| `466b74d` | G-SEC: límite compartido acotado y sin caídas (upsert, timeouts, vía rápida, `runTransaction`, `pool.on('error')`); auditoría sin datos de negocio; login de tiempo constante; prueba multi-proceso |
| `52f834d` | R1: reparación (no parseaba) y preflight reescritos; pruebas con psql |
| `7928838` | G-MIG: reversión sin carreras (`LOCK`), regla de fijación, preflights bloqueantes, `ON_ERROR_STOP`, `lock_timeout` del runner; ciclo 0034→0035 |
| `b7c95ae` | Revisión final G-SEC: regla de bloqueo según el negocio de cada fila, ensayo de anonimización, motivos de grants, oyente de cliente en `connect`, tope de bcrypt, `strpos` |
| `2060725` | Revisión final G-MIG: `READ COMMITTED`, 37 nombres de 0034, relación `plan_limit`, `backfill_absent_deny` |
| `ca37e01` | NEW-07 (el 429 por saturación no gasta intentos) y NEW-08 (acción del ensayo) |
| `704aea4` | NEW-09: admisión separada de los huecos de bcrypt |
| `b3b0447` | NEW-10 y NEW-11: `lock_timeout` del límite 500 ms |

A estos se suma el commit de documentación y evidencia que contiene este archivo.

## 3. Ejecuciones de la suite (BD desechable)

| SHA | tsc | Unitarias | Integración | Smoke | E2E (checks) |
|---|---|---|---|---|---|
| `6e1eff8` (línea base) | 0 | 185/185 | 221/221 | — | — |
| `7928838` | 0 | 185/185 | 244/244 | 5/5 | 2/2 (62 PASS, 0 FAIL) |
| `2060725` | 0 | 187/187 | 252/252 | 5/5 | 2/2 (62 PASS, 0 FAIL) |
| `ca37e01` | 0 | 187/187 | 253/253 | 5/5 | 2/2 (62 PASS, 0 FAIL) |
| `704aea4` | 0 | 187/187 | 254/254 | 5/5 | 2/2 (62 PASS, 0 FAIL) |
| **`b3b0447`** | **0** | **187/187** | **254/254** | **5/5** | **2/2 (62 PASS, 0 FAIL)** |

El listado completo de pruebas de `b3b0447` está en `test-runs-b3b0447.txt`. Las transcripciones E2E de ese SHA están en `e2e-plan-catalog-ui.txt` (con las huellas sha256/16 de los assets servidos) y `e2e-inc004-006.txt`. Su cabecera dice «+ cambios sin commitear del árbol de trabajo»: en el momento de la ejecución solo lo eran el documento de endurecimiento y este directorio, sin código. Las transcripciones de PR #13 (`evidence/plan-catalog/e2e-ui.txt` y `evidence/e2e-inc004-006.txt`) se dejaron como estaban.

Comandos (desde el worktree):

```sh
export DATABASE_URL=postgres://mainspot:***@127.0.0.1:55499/mainspot TEST_DATABASE_URL=postgres://mainspot:***@127.0.0.1:55499/mainspot_test APP_ENV=test
npx tsc --noEmit
npm run test:unit && npm run test:integration && npm run test:smoke
sudo systemctl stop mainspot-local
node scripts/test-prep.ts && node --test --test-concurrency=1 tests/e2e/plan-catalog-ui.test.ts tests/e2e/inc004-inc006-e2e.test.ts
sudo systemctl start mainspot-local
```

## 4. Reproducciones antes y después

Cada defecto corregido tiene una prueba permanente que falla con el código anterior, o una medición desechable.

| Hallazgo | Antes | Después | Archivo |
|---|---|---|---|
| Bloqueo retenido sin `lock_timeout` y carrera entre purga y reserva | 5/7 en `6e1eff8`: «still waiting» tras 20 s; la purga concurrente da 500 en lugar de 401 | 7/7 (hoy 12/12 en el archivo) | `multiprocess-before-6e1eff8.txt` |
| Reinicio real de PostgreSQL | — | caída: 500 `ECONNREFUSED` también con credenciales válidas; el contador persiste (3 + 2 ⇒ 429); 1 sola sesión | `pg-restart-real.txt` |
| GSEC-07, conexión inactiva terminada | el proceso cae (`Unhandled 'error' event`, código 1) | vivo; la siguiente consulta funciona | `gsec07-connection-loss-before-after.txt` |
| GSEC-14, oráculo de tiempo | 45,8 frente a 4,1 ms | 44,6 frente a 44,9 ms | `gsec14-login-timing.txt` |
| GMIG-01, reversión con una publicación en curso | `'ok'`: revierte en silencio | 55000 sin cambios | `gmig01-rollback-race-before-6e1eff8.txt` |
| NEW-01, ráfaga de 300 logins inventados | 3.169 ms, 300 × 401 | 876 ms, 34 × 401 y 266 × 429 | `new01-login-flood.txt` |
| NEW-02, escaneo R1 (102 negocios, 20.050 filas) | preflight ~20 min; ejecución cortada a los 30 min sin terminar la reparación | preflight 7,0 s; reparación 7,0 s | `new02-r1-scan-performance.txt` |
| NEW-07, 429 por saturación | el 429 reservaba intentos de la clave del operador | no reserva; 200 tras la ráfaga | `new07-saturation-before-2060725.txt` |
| NEW-09, bloqueo en cabeza de cola | las otras claves esperan a la bloqueada: la prueba falla a los 10,2 s; FinalGSec midió ~4.850 ms por login | 59–98 ms (FinalGSec); prueba en verde | `new09-head-of-line-before-ca37e01.txt` |
| NEW-10, pool detenido tras una clave retenida | 7.807 ms (`704aea4`, según FinalGSec) | 963 ms | `new10-pool-stall-after.txt` |

Pruebas permanentes nuevas o ampliadas:
- `tests/integration/platform-auth-multiprocess.test.ts` (12): 3 procesos reales; ráfagas; anti-replay; step-up; SIGKILL; proxy cortado; bloqueo retenido; purga; conexiones terminadas (inactiva, en la transacción del límite y en un `pool.connect()` directo); saturación; cabeza de cola.
- `tests/integration/plan-catalog-legacy-audit-repair.test.ts` (8): psql real; 14 rechazos; contrato según el negocio de cada fila; `client_` huérfano; reparación autorizada; redacción opcional; ensayo de anonimización antes y después.
- `tests/integration/plan-catalog-migration.test.ts` (de 8 a 21): preflights; 0034→0035; orden de reversión; códigos de salida de psql; carrera con una publicación; REPEATABLE READ; objetos sobrantes; relación `plan_limit`.
- `tests/unit/platform-reason.test.ts` (2) y casos nuevos en `plan-catalog.test.ts` y `ai-manual-lab.test.ts`.

## 5. Modelos efectivos (de las trazas de sesión de OMP)

Recuento del 2026-11-05 a las 07:15 UTC; la sesión principal siguió con el mismo modelo hasta el final.

| Agente | Rol | Mensajes del asistente | Modelo | Esfuerzo | Fallback |
|---|---|---|---|---|---|
| Sesión principal | Orquestación, implementación y pruebas | 361 | `anthropic/claude-opus-5-5` | `max`. Los 10 primeros mensajes, comprobaciones de entorno anteriores a las 02:53:33 UTC, fueron en `xhigh` | — |
| GSecReview | Revisión independiente G-SEC sobre 6e1eff8 | 102 | `anthropic/claude-opus-5-5` | `max` | `resolvedModelIsFallback: false` |
| GMigReview | Revisión independiente G-MIG sobre 6e1eff8 | 104 | `anthropic/claude-opus-5-5` | `max` | `false` |
| FinalGSec | Revisión final G-SEC sobre 7928838; verificaciones de 2060725, ca37e01, 704aea4 y b3b0447 | 194 | `anthropic/claude-opus-5-5` | `max` | `false` |
| FinalGMig | Revisión final G-MIG sobre 7928838; verificación de 2060725 | 134 | `anthropic/claude-opus-5-5` | `max` | `false` |

Notas sobre los modelos:
- **Llamadas auxiliares.** `model_usage` registra `job-caption` (18) y `job-widget` (13), todas con `claude-opus-5-5`. La única compactación fue `remote`, del propio proveedor Anthropic. Ningún evento de las cinco trazas menciona otro modelo.
- **Perfil de los subagentes.** `.omp/agents/opus-max.md` (`model: anthropic/claude-opus-5-5`, `thinking-level: max`).
- **Ajustes de la sesión.** Fueron temporales y no se guardaron; se restauran a sus valores originales al terminar el trabajo, después de este commit:
  - `defaultThinkingLevel` `max`;
  - `find.enabled` `off`;
  - `recap.enabled` `false`;
  - `task.completionProbe` `false`;
  - `task.showResolvedModelBadge` `true`;
  - `compaction.methodOrder` `[remote, snapcompact, shake]`.
- **Ya desactivados.** Se comprobó que `advisor.enabled`, `retry.modelFallback` y `providers.anthropic.serverSideFallback` estaban desactivados.

## 6. Límites

- **Datos legacy sintéticos.** La Fase B (respaldo restaurado, preflights y ensayo de anonimización sobre el destino) no se ejecutó: no hay acceso al destino, y hacerlo no estaba autorizado.
- **Alcance de los E2E.** El E2E de navegador cubre el catálogo de planes (login de plataforma con TOTP, step-up y permisos); INC-004/006 se cubre por API. Las ráfagas multi-proceso, los cortes de red y las reparaciones se probaron a nivel de proceso y de BD, no por HTTP a través de nginx. Por eso el comportamiento con `trust proxy` en producción es [INFERENCE].
- **Rol de BD.** Las BD desechables se usaron con un rol superusuario; la reparación exige el rol propietario de la tabla.
- **Decisiones del propietario pendientes** (§4 del documento de endurecimiento):
  - GSEC-04/09: política de bloqueo, `trust proxy` y red;
  - redactar logins heredados;
  - GMIG-13: regla de fijación;
  - R4: texto libre;
  - retención de `platform_audit_event`;
  - firma de G-MIG y G-SEC.
