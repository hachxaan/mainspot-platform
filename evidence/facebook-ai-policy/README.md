# Evidencia — política de IA de comentarios de Facebook y costos (DEC-0078), ciclo local 2026-11-06

Directiva: SRC-0019 (texto literal de la sesión) sobre la aprobación del propietario SRC-0018 (= SRC-007). Diseño,
matriz requisito → código → prueba → gate y riesgos: [`docs/architecture/facebook-ai-policy.md`](../../docs/architecture/facebook-ai-policy.md).
Decisión canónica: [`DEC-0078`](../../.canonflow/decision-records/DEC-0078.md) (delta 0.9.0).

## Dictamen

| Ámbito | Dictamen | Motivo |
|---|---|---|
| Local (código, pruebas, navegador por el dominio de desarrollo) | **GO** | FB-1, FB-2, FB-3 y TS-1 implementados; commits ajenos adaptados a SEC-CONSENT-01/SEC-TG-APPROVAL-01; todas las suites en verde; hallazgos de la revisión independiente corregidos o declarados |
| Producción | **NO-GO** | No autorizado. Pendientes: activación comercial del medidor de Facebook (**BLOCKED**, decisión económica), valor de `lab_experiment` (**OPEN**), reapertura de `primary` de Jev tras TS-1 (**OPEN**, evaluación de pago que autoriza el propietario), G-MIG y G-SEC sin firmar, 0032/0033 sin script de reversión, proveedores reales sin verificar, botones de Telegram ligados al aviso sin pulsar en Telegram real |

## Ramas y commits

| Rama (PR) | Base | Commits |
|---|---|---|
| `integrate/telegram-channels-notice-binding-20261106` | `122e74d` (PR #19) | `ab6ff40` y `017f58d` (cherry-pick con autoría de `0cf90bf`/`2f91053`), `3d00e3e` (botones ligados al código del aviso), `5354283` (estado de Telegram real, revisión F-06) |
| `feat/facebook-ai-policy-20261106` | `3d00e3e` | `c1f334e` FB-1/FB-2/medidor/consentimiento/panel · `2b976df` canon DEC-0078 · `1e918be` reversión de 0038 · `2905d1d` E2E · `3368a31` FB-3 · `d0613e0`+`d573cdf` TS-1 · `362de50` E2E de planes (registro v3) · `f7a4d12`, `be81f60`, `6e68646`, `5e8edd7`, `1c269d6` correcciones de la revisión 1 · `c87848c`, `05939be`, `2f2f28a`, `d4bf8a4` correcciones de la revisión 2 · `4673061` carrera de la prueba E2E de planes · documentación, canon final y esta evidencia |

La rama de la política parte de `3d00e3e`; `5354283` (solo documentación) está en la de integración y no en ella: al
fusionar las dos, el árbol final contiene ambas sin conflicto (archivos distintos).

## Entorno

- PostgreSQL 16.15 desechable (`postgres:16-alpine`, contenedor `mainspot-fbpolicy-pg-20261106`, `127.0.0.1:55506`);
  `scripts/test-prep.ts` recrea la BD de pruebas en cada corrida. Ninguna base real ni persistente.
- Node v24.16.0. Navegador: Chromium de Playwright por **https://app.mainspot.local.io** con TLS verificado (sin
  `ignoreHTTPSErrors` ni `localhost:3100` como atajo); `mainspot-local` se detuvo para liberar el puerto 3100 y se
  reinició después (`/health` 200).
- Proveedores: TypeSafe/Jev con MockJev o `fetch` interceptado; Anthropic y OpenAI sustituidos en memoria; Meta,
  Google y Telegram simulados. Ninguna llamada real, ningún gasto, ninguna evaluación de pago (DEC-0074).

## Resultados

Código verificado: `4673061` (tsc y E2E; unitarias, integración y smoke en `d4bf8a4`, que solo difiere en
`tests/e2e/plan-catalog-ui.test.ts`). Los commits posteriores solo cambian documentación, canon y evidencia.

| Verificación | Resultado | Archivo |
|---|---|---|
| Base `122e74d` al empezar | tsc 0 · unit 189/189 · integración 308/308 | — (observado al inicio de la sesión) |
| `tsc --noEmit` | 0 errores | [`runs/final-tsc.txt`](runs/final-tsc.txt) |
| Unitarias | 208/208 | [`runs/final-unit.txt`](runs/final-unit.txt) |
| Integración (PostgreSQL real) | 365/365 | [`runs/final-integration.txt`](runs/final-integration.txt) |
| Smoke | 5/5 | [`runs/final-smoke.txt`](runs/final-smoke.txt) |
| E2E de navegador, las 8 suites en una corrida y en orden | 8/8 suites · 247 comprobaciones: Facebook 29, salvaguardas 30, cuota 24, DEV-E2E-02 31, DEV-E2E-03 42, INC-002/003 28, INC-004/006 20, planes 43. En `d4bf8a4` la prueba de planes falló una vez en su comprobación 1 (contó los enlaces antes de que llegara el catálogo; las dos corridas completas anteriores pasaron): `4673061` espera los enlaces y la corrida completa pasó | [`runs/final-e2e.txt`](runs/final-e2e.txt), [`regression/`](regression/) |
| E2E de la política con capturas (`EVIDENCE_SCREENSHOTS=1`) | 29/29 | [`e2e-ui.txt`](e2e-ui.txt), [`ui/`](ui/) |
| Validadores de `canonflow-keystone` (solo lectura) | 6 VALID; trazabilidad 5/118, los mismos 5 enlaces históricos que antes (62, 68, 73, 79, 83) | [`runs/canon-validation.txt`](runs/canon-validation.txt) |
| Rama de integración sola (`5354283`) | tsc 0 · unit 200/200 · integración 325/325 · smoke 5/5 · E2E 7/7 suites, 218 comprobaciones (la suite de la política no existe en esa rama) | [`runs/integration-branch-*.txt`](runs/), [`regression/integration-branch/`](regression/integration-branch/) |

Las corridas del E2E reescriben las transcripciones históricas de otras suites (`evidence/commercial-governance/`,
`evidence/commercial-quota/`, `evidence/e2e-*.txt`, `evidence/plan-catalog/`): sus copias de este ciclo están en
[`regression/`](regression/) (y las de la rama de integración en `regression/integration-branch/`) y los originales se
restauraron sin cambios en las dos ramas.

### Capturas

| Captura | Qué muestra |
|---|---|
| [`01-reglas-bajo-demanda`](ui/01-reglas-bajo-demanda.png) | Modo predeterminado «Bajo demanda» y estado del medidor |
| [`02-caso-sugerir-con-ia`](ui/02-caso-sugerir-con-ia.png) | Costo informado antes de «Sugerir con IA» |
| [`03-propuesta-a-pedido`](ui/03-propuesta-a-pedido.png) | Propuesta con IA guardada aparte de las numeradas |
| [`04-autorizacion-automaticas`](ui/04-autorizacion-automaticas.png) | Hoja con las condiciones literales, el costo y la casilla de aceptación |
| [`05-sugerencia-automatica`](ui/05-sugerencia-automatica.png) | Sugerencia preparada sin publicar, como opción 1 |
| [`06-aprobada-desde-telegram`](ui/06-aprobada-desde-telegram.png) | Publicación solo tras aprobar el aviso en Telegram (simulado) |
| [`07-medidor-agotado`](ui/07-medidor-agotado.png) | Medidor agotado: explicación y respuesta manual |
| [`08-plan-sin-medidor`](ui/08-plan-sin-medidor.png) | Plan sin el parámetro: fail-closed con explicación |

## Revisión adversarial independiente

Dos pasadas, cada una de un agente revisor distinto que no implementó nada (Claude Opus 5.5, esfuerzo máximo): solo
lectura, en worktrees separados y con sus propias bases desechables; sondas sin seguimiento y sin llamadas reales.
Informes completos: [`review/pass-1.md`](review/pass-1.md) y [`review/pass-2.md`](review/pass-2.md); resolución de cada
hallazgo: §12 de [`facebook-ai-policy.md`](../../docs/architecture/facebook-ai-policy.md).

| Pasada | Código | Veredicto | Hallazgos | Resolución |
|---|---|---|---|---|
| 1 | `d573cdf` | NO-GO hasta corregir F-01 | 1 HIGH (F-01: la anonimización fallaba tras conversar con Jev), 2 MEDIUM (F-02 gate de Jev sin declarar; F-03 evaluaciones fuera de `lab_experiment`), 3 LOW, 3 NIT | Corregidos F-01, F-03, F-04, F-05, F-07, F-08, F-09 (`f7a4d12`, `be81f60`, `6e68646`, `5e8edd7`, `1c269d6`) y F-06 (`5354283`); F-02 declarado y OPEN para el propietario |
| 2 | `5e8edd7` | GO de código local con reservas | F-01, F-03 y F-05 cerrados; F-04 parcial; G-01 y G-03 LOW, G-02 y G-04 a G-07 NIT | Corregidos G-01, G-03, G-05, G-06 (`c87848c`, `05939be`, `2f2f28a`, `d4bf8a4`); G-02, G-04 y G-07 documentados como riesgos residuales |

## Decisiones pendientes del propietario

| Tema | Estado | Efecto mientras tanto |
|---|---|---|
| Activación comercial de los créditos de Facebook (cantidades, precios, reposiciones, cuotas por plan, unidad de cobro) | BLOCKED | Ningún plan define `quota.ai_facebook_suggestions.max`: toda IA de pago de comentarios de Facebook se deniega con explicación |
| Valor de `lab_experiment` | OPEN | Ni el laboratorio ni las evaluaciones de rutas de pago gastan |
| Reapertura de `primary` de Jev tras TS-1 (evaluación nueva de pago, DEC-0033; huella `5a115a0d…` frente a `05f7ada8…` evaluada) | OPEN | Decide el clasificador determinista; TypeSafe sigue leyendo en sombra |
| Particiones o límites por canal | OPEN | Solo atribución, sin límites por canal |
| Pulsar los botones ligados al aviso en Telegram real | Pendiente | Cubiertos con el canal simulado |

## Reproducir

```bash
export DATABASE_URL=postgres://mainspot:<pwd>@127.0.0.1:55506/mainspot TEST_DATABASE_URL=postgres://mainspot:<pwd>@127.0.0.1:55506/mainspot_test APP_ENV=test
npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run test:smoke
sudo systemctl stop mainspot-local && npm run test:e2e; sudo systemctl start mainspot-local
EVIDENCE_SCREENSHOTS=1 node --test tests/e2e/facebook-ai-policy-ui.test.ts   # con mainspot-local detenido
python3 ~/codeart/canonflow-keystone/scripts/validate_traceability.py --links .canonflow/traceability/links.yaml --store .canonflow
```

## Simulado frente a real

Nada de esta evidencia acredita un proveedor real, su facturación o su calidad, ni la entrega real de Meta o Google.
La entrega real de Telegram se verificó el 2026-11-04 (ver `docs/architecture/telegram-webhook-starlink.md`), pero las
decisiones con los botones ligados al aviso solo se probaron con el canal simulado. Los importes de los presupuestos
son los ya configurados (DEC-0032, DEC-0068, OPS-0001); `lab_experiment` y el medidor de Facebook no tienen valor
sembrado y las pruebas fijan los suyos.
