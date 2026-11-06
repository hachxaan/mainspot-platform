# Evidencia — ciclo local de gobernanza y seguridad (DEC-0077, SEC-CONSENT-01, SEC-TG-APPROVAL-01)

Rama `feat/commercial-governance-safeguards-20261105`, apilada sobre PR #17 (`b809510`) → #16 → #15 → #14 → #13.
Directiva: **SRC-0017** (texto literal del propietario, sha256 `6acfea9d…352c`), que formaliza lo confirmado en
**SRC-0016** (copia byte a byte de `SRC-006` del repositorio documental, sha256 `113a6344…8c`). Diseño, matriz
requisito → código → prueba → gate y riesgos: [`docs/architecture/commercial-governance-safeguards.md`](../../docs/architecture/commercial-governance-safeguards.md).

Todo lo de aquí es **local y simulado**: Google, Meta y Telegram simulados; IA con proveedores falsos o rutas simuladas
del entorno `test`. Ninguna llamada a proveedores reales, ninguna base real, ningún cambio de producción, DNS ni
infraestructura, ninguna firma de gate.

## 1. Commits

| Commit | Contenido | Antes del autosquash |
|---|---|---|
| `3d0f881` | Canon: SRC-0016, SRC-0017, DEC-0077 (R1–R9, precedencias), delta funcional 0.8.0 (FR-0008, FR-0010, FR-0016, BR-0007, NFR-0006; FR-0020 y FR-0021 nuevos), enlaces, contador `dec` 76 → 77, especificación de retención de 60 días | `8940101` + fixups `f6f1346`, `3543a9a`, `842b64f`, `e5f8013` |
| `db735b8` | Migración 0037 y su reversión; SEC-CONSENT-01 y SEC-TG-APPROVAL-01 (servicio, Telegram, API, panel, purga) y sus pruebas | `5549935` |
| `3e9eb8c` | Sin techo configurado no hay gasto de IA de pago; laboratorio nunca con `APP_ENV=production` (NFR-0006 AC-6006) | `e4af950` |
| `4bb8ee4` | Correcciones de la revisión independiente, pasada 1 (F-01…F-13, E-01) | `7cae590` |
| `fa7b7ea` | Correcciones de la pasada 2 (N-01…N-04, E-02) | `41d6c24` |
| `96e383c` | E2E DEV-E2E-03: comprobación determinista del id del chat simulado (O-1) | `aa455fe` |
| siguiente | Documento de diseño, esta evidencia, README y memoria del agente | — |

El autosquash solo movió las fixups de canon a su commit: el árbol final es idéntico byte a byte al de `aa455fe`
(`git diff aa455fe 96e383c` vacío).

## 2. Entorno

| Elemento | Valor |
|---|---|
| Host | Linux 7.0.0-38-generic x64, Node v24.16.0 |
| Base de datos | PostgreSQL 16.15 desechable (`postgres:16-alpine`), contenedor `mainspot-governance-pg-20261105` en `127.0.0.1:55498`; `mainspot_test` la recrea `scripts/test-prep.ts` en cada ejecución. Los revisores usaron bases propias en el mismo contenedor (`mainspot_test_review*`) |
| E2E | `https://app.mainspot.local.io` (proxy HTTPS del LXC `webserver` → upstream `:3100` que levanta cada prueba), TLS verificado sin `ignoreHTTPSErrors`, Chrome headless (`/usr/bin/google-chrome`). `mainspot-local` se detuvo para liberar el puerto 3100 y se volvió a arrancar al terminar (`active`, `/health` 200 por el dominio) |
| Proveedores | Simulados. AI Core en entorno `test` (rutas simuladas o proveedor falso de la suite). Sin `scripts/ai-eval.ts` ni `scripts/ai-core-lab-e2e.ts` con proveedores reales (DEC-0074) |
| Canon | Validadores de `canonflow-keystone` `70ff601`, solo ejecutados (su checkout no se modificó) |

## 3. Ejecuciones

| Ejecución | Código | tsc | Unitarias | Integración | Smoke | E2E (checks PASS/total) |
|---|---|---|---|---|---|---|
| Línea base | `b809510` | 0 | 187/187 | 270/270 | — | — |
| Implementación | `5549935` / `e4af950` | 0 | 187/187 | 300/300 | 5/5 | 218/218 (sobre `5549935` + árbol de trabajo) |
| Tras la pasada 1 | `7cae590` | 0 | 189/189 | 308/308 | 5/5 | 218/218 |
| **Final** | `41d6c24` (= `fa7b7ea`) | **0** | **189/189** | **308/308** | **5/5** | **218/218** (ver nota) |
| Corrección O-1 | `aa455fe` (= `96e383c`) | — | — | — | — | DEV-E2E-03 42/42 |

Nota E2E final: en la primera pasada de regresión sobre `41d6c24`, DEV-E2E-03 falló el check 6
([`regression/e2e-dev-e2e-03-intermittent-failure.txt`](regression/e2e-dev-e2e-03-intermittent-failure.txt)); repetida en
el mismo HEAD dio 42/42. Causa (confirmada por el revisor con 200 000 ids simulados): el check buscaba 10 dígitos
seguidos en `sim-<12 hex>`, lo que ocurre en ~1,65 % de los ids. `96e383c` comprueba la forma opaca del id; verificado
42/42 en `aa455fe`.

| E2E por el dominio (código final) | Checks | Transcript |
|---|---|---|
| Salvaguardas DEC-0077 (reconsentimiento, aviso antiguo, publicación del texto mostrado) | 30/30 | [`e2e-ui.txt`](e2e-ui.txt), capturas [`ui/`](ui/) |
| DEV-E2E-02 (agente de atención, worker y CLI reales) | 31/31 | [`regression/e2e-dev-e2e-02.txt`](regression/e2e-dev-e2e-02.txt) |
| DEV-E2E-03 (interfaz de Claude Design) | 42/42 | [`regression/e2e-dev-e2e-03.txt`](regression/e2e-dev-e2e-03.txt) |
| Cuota comercial (DEC-0076) | 24/24 | [`regression/commercial-quota-e2e-ui.txt`](regression/commercial-quota-e2e-ui.txt) |
| Catálogo de planes | 43/43 | [`regression/plan-catalog-e2e-ui.txt`](regression/plan-catalog-e2e-ui.txt) |
| INC-004…006 | 20/20 | [`regression/e2e-inc004-006.txt`](regression/e2e-inc004-006.txt) |
| INC-002/003 | 28/28 | [`regression/e2e-inc002-inc003.txt`](regression/e2e-inc002-inc003.txt) |

Las pruebas E2E de regresión escriben en sus transcripts históricos (`evidence/e2e-*.txt`, `evidence/plan-catalog/`,
`evidence/commercial-quota/`): se copiaron aquí y los originales se restauraron sin cambios. Cuando un transcript marca
«cambios sin commitear del árbol de trabajo», eran solo documentación (este directorio, el documento de diseño,
`README.md` y `.omp/AGENTS.md`); el código era el del HEAD indicado.

Concurrencia observada en la integración final: 12 carreras libres editor/aprobador `{"approval_stale":11,"approved":1}`
y ninguna publicó un texto que el aviso no mostró; el revisor obtuvo `{"409/200":7,"200/409":3}` en su sonda del panel.
Resúmenes por prueba: [`runs/`](runs/) (`final-unit.txt`, `final-integration.txt`, `final-smoke.txt`, `final-tsc.txt`,
`baseline-b809510.txt`, `canon-validation.txt`).

Canon (árbol final): `validate_schemas_v2.py` VALID en `DEC-0077.json`, `decision-state/index.json`,
`source-register.yaml`, `functional-canon-state.yaml`, `implementation-state.yaml` y `links.yaml`;
`validate_traceability.py` 5/106 con los mismos 5 enlaces que ya fallaban en `b809510` (62, 68, 73, 79, 83).

## 4. Cómo reproducir

```bash
docker run -d --name mainspot-governance-pg-20261105 -e POSTGRES_USER=mainspot -e POSTGRES_PASSWORD=gov-local-only \
  -e POSTGRES_DB=mainspot -p 127.0.0.1:55498:5432 postgres:16-alpine
export DATABASE_URL=postgres://mainspot:gov-local-only@127.0.0.1:55498/mainspot \
  TEST_DATABASE_URL=postgres://mainspot:gov-local-only@127.0.0.1:55498/mainspot_test APP_ENV=test
npm ci
npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:smoke
# E2E por el dominio: liberan el puerto 3100 y lo vuelven a ocupar al terminar
node scripts/test-prep.ts
sudo systemctl stop mainspot-local
EVIDENCE_SCREENSHOTS=1 node --test --test-concurrency=1 tests/e2e/governance-safeguards-ui.test.ts
node --test --test-concurrency=1 tests/e2e/dev-e2e-02.test.ts tests/e2e/ui-e2e-03.test.ts tests/e2e/commercial-quota-ui.test.ts \
  tests/e2e/plan-catalog-ui.test.ts tests/e2e/inc004-inc006-e2e.test.ts tests/e2e/inc002-inc003-e2e.test.ts
sudo systemctl start mainspot-local
# Canon (solo lectura de canonflow-keystone)
python3 ~/codeart/canonflow-keystone/scripts/validate_traceability.py --links .canonflow/traceability/links.yaml --store .canonflow
```

## 5. Revisión adversarial independiente

Subagente `GovAdversarialReview` (Claude Opus 5.5, esfuerzo máximo), en worktrees propios, sin navegador, sin puerto
3100 y sin red. Sus sondas (`tests/probes/gov-review*.test.ts`) viven en esos worktrees y no forman parte del PR.

| Pasada | Objeto | Resultado | Informe |
|---|---|---|---|
| 1 | `5549935`, `e4af950` y fixups de canon | 14 hallazgos (F-01 HIGH; F-02…F-05 MEDIUM; F-06…F-10 LOW; F-11…F-14 NIT) y E-01/E-02; 11/11 sondas reproducidas | [`independent-review-1.md`](independent-review-1.md) |
| 2 | `842b64f`, `7cae590` | Cerrados F-01, F-03…F-07, F-10…F-13, E-01; residuos N-01…N-05; F-09 abierto (este documento no estaba commiteado); F-14 parcial | [`independent-review-2.md`](independent-review-2.md) |
| 3 | `e5f8013`, `41d6c24` | Cerrados F-01…F-07, F-10…F-14, E-01, E-02, N-01…N-04; F-08 (la BD no ata versión y texto) y N-05 (0037 editada antes de publicarse) aceptados y documentados; F-09 se cierra con este commit; observaciones O-1 (E2E inestable, corregida en `96e383c`) y O-2 (redacción del riesgo 7, corregida) | [`independent-review-3.md`](independent-review-3.md) |

Verificación independiente de Facebook y del laboratorio (subagente `CostBoundsFbLab`, Claude Opus 5.5, esfuerzo
máximo): [`cost-bounds-report.md`](cost-bounds-report.md) y `tests/integration/ai-cost-bounds.test.ts`.

## 6. Qué queda probado y qué no

| Probado en local (simulado) | No probado |
|---|---|
| Sin consentimiento vigente (versión y huella) no hay IA ni unidad en respuestas automáticas; aceptación versionada, auditada, idempotente, con RBAC y aislamiento | Ningún proveedor real (IA, Google, Meta, Telegram) |
| `/aprobar <código> N` publica exactamente la opción del aviso; cualquier cambio posterior lo invalida; carreras, mensajes antiguos, reentregas, códigos usados y aislamiento | Entrega real de Telegram (`TELEGRAM_WEBHOOK_REAL_VERIFIED` pendiente) |
| Facebook fuera de `ai_review_replies` y acotado por presupuestos técnicos; laboratorio con grant y presupuestos, deshabilitado en producción, sin techos no hay gasto | G-MIG sobre una copia restaurada de producción; firma G-SEC |
| Migración 0037 aditiva y su reversión con negativas | Ventana de 60 días (FR-0020, BLOCKED) y demostración pública (FR-0021, OPEN): solo especificadas |

## 7. Dictamen (no es firma de gate)

**Local: GO técnico.** DEC-0077 queda formalizada con precedencias explícitas y validada; SEC-CONSENT-01 y
SEC-TG-APPROVAL-01 están implementadas con pruebas de integración, concurrencia e idempotencia y E2E por el dominio en
verde; la revisión independiente no deja hallazgos de código abiertos. Límites conocidos y aceptados: proveedores
simulados, F-08 a nivel de BD, N-05, y los huecos de Facebook FB-1, FB-2, FB-3 y TS-1 que requieren decisión del
propietario.

**Producción: NO-GO**, mientras falte cualquiera de estos puntos:
1. Firmas humanas G-MIG (migraciones 0034–0037 sobre copia restaurada) y G-SEC.
2. Entrega real de Telegram verificada (`TELEGRAM_WEBHOOK_REAL_VERIFIED`) y adopción del código del aviso por los
   commits locales `0cf90bf`/`2f91053` (hoy aprueban por índice).
3. Fusión revisada de la cadena PR #13 → #17 y de este PR.
4. Entorno de IA de producción definido (hoy solo existen `lab` y `test`) con su techo `lab_total` decidido, y
   proveedores reales ejercitados bajo las reglas de DEC-0074.
5. Decisión del propietario sobre FB-1/FB-3/TS-1 (política de IA por canal, presupuesto por origen, reserva de TypeSafe).
6. Para la ventana de 60 días y la demostración pública: G-LEGAL y G-PAY (FR-0020) y los parámetros OPEN de FR-0021.

## 8. Recursos auxiliares que siguen en la máquina

- Worktrees de los subagentes (sin cambios en el repositorio remoto): `../mainspot-platform-gov-costbounds` (rama local
  `wip/gov-cost-bounds-20261105`, no publicada), `../mainspot-platform-gov-review` (`5549935`),
  `../mainspot-platform-gov-review-e4af950`, `../mainspot-platform-gov-review-7cae590`,
  `../mainspot-platform-gov-review-41d6c24`, con las sondas del revisor sin seguimiento.
- Contenedor `mainspot-governance-pg-20261105` (solo datos de prueba). Se pueden retirar cuando ya no hagan falta para
  revisar el PR: `git worktree remove <ruta>`, `git branch -D wip/gov-cost-bounds-20261105`,
  `docker rm -f mainspot-governance-pg-20261105`.
