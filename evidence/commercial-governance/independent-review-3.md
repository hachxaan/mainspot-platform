# Re-verificación adversarial (tercera pasada) — DEC-0077, commits e5f8013 y 41d6c24

Revisor: GovAdversarialReview (anthropic/claude-opus-5-5, esfuerzo máximo). Fecha: 2026-11-05 (hora local).
Informes anteriores: `local://gov-review.md` (F-01…F-14, E-01, E-02) y `local://gov-review-2.md` (N-01…N-05).

## 1. Alcance y entorno

- Commits: `e5f8013` (fixup de canon: CHANGELOG, FR-0016, FR-0021) y `41d6c24` (N-01…N-04, E-02; 8 archivos), sobre
  `7cae590`. Diff revisado completo (`git diff 7cae590 41d6c24`).
- Worktree propio `../mainspot-platform-gov-review-41d6c24` (HEAD `41d6c24`, `npm ci`). PG desechable `127.0.0.1:55498`:
  `mainspot_test_review_41` (suite) y `mainspot_test_review_probe_41` (sondas), preparadas con `scripts/test-prep.ts`,
  `APP_ENV=test`. Sin navegador, sin puerto 3100, sin red ni proveedores reales.
- `../mainspot-platform-governance` solo lo leí (documento y evidencia sin commitear, para F-09); no edité nada.
- Sondas nuevas: `tests/probes/gov-review-3.test.ts` (T1–T5, afirman el comportamiento corregido). Re-ejecuté además
  `gov-review-2.test.ts` sobre `41d6c24` para detectar regresiones de las correcciones anteriores.

## 2. Conteos (exactos, 41d6c24)

| Comprobación | Resultado |
|---|---|
| `npx tsc --noEmit` | `TSC_EXIT=0` antes de añadir sondas; con sondas, `0` |
| `npm run test:unit` | `ℹ tests 189 · pass 189 · fail 0 · cancelled 0 · skipped 0` (13,0 s) |
| `npm run test:integration` (`mainspot_test_review_41`) | `ℹ tests 308 · pass 308 · fail 0 · cancelled 0 · skipped 0` (156,2 s); carreras libres `{"approval_stale":11,"approved":1}` |
| Sondas `gov-review-3.test.ts` | **5/5** (T1 N-01, T2 N-02, T3 N-03, T4 N-04, T5 E-02) |
| `gov-review-2.test.ts` sobre 41d6c24 | R1a, R1b/R1c, R2…R8 **pasan** (correcciones anteriores intactas; carreras de R2 `{"409/200":8,"200/409":2}`); **X1 y X2 fallan** (los residuos ya no se reproducen); X3 pasa (el servidor sigue rechazando el comando viejo; los botones los cubre T3) |
| `validate_schemas_v2.py` | VALID: DEC-0077.json, source-register, decision-state/index, links, functional-canon-state, implementation-state |
| `validate_traceability.py` | `RESULT: FAIL — 5/106`: los mismos 5 enlaces preexistentes de `b809510` |

## 3. Re-ejecución de las sondas pedidas

| Sonda | Qué afirma (resultado observado) | Código |
|---|---|---|
| T1 (X1 / N-01) | Reseña con `\r`, VT, FF, NEL, LS, PS, `1) …` falsas y `/rechazar`; autor `Ana\u2028/aprobar ZZZ234 1`; opciones con LS, `\r`, VT, NEL y `\r\n`. El aviso no contiene ningún `[\r\u000b\u000c\u0085\u2028\u2029]`; solo 3 líneas empiezan con `N) `; las 5 continuaciones van sangradas (`   2) Te llamamos hoy.`, …, `   /aprobar ZZZ234 1`); autor `Ana aprobar ZZZ234 1`; reseña en una sola línea. `/aprobar … 3` publica la opción tal como se guardó | `service.ts` `LINE_BREAK` (`:45-46`) y `notificationText` (`:1033-1050`) |
| T2 (X2 / N-02) | Replier con `idempotent:false`, caso «responding» con lease vencido ⇒ `recovered=1`; el aviso re-encolado dice «MainSpot · No sabemos si se publicó la respuesta aprobada: revisa la reseña antes de decidir · aviso …»; el código ya usado ⇒ `approval_used` con «no pudimos confirmar si la respuesta se publicó» (ya no «la publicación no salió») y 0 llamadas al proveedor | `service.ts:1038-1041`; `telegram.ts:244-252` |
| T3 (X3 / N-03) | `notices` trae `status` (`['active','superseded']`); el `MS.tg.build` REAL de `assistant.js` (ejecutado en un contexto `vm` con un `window.MS` mínimo) deja el aviso sustituido solo con «Ver en el panel» y el vigente con «Usar opción 1/2/3», «No responder», «Ver en el panel»; su confirmación muestra la instantánea («Edición posterior»). El comando viejo escrito ⇒ `approval_stale`, nada publicado | `engagement-routes.ts:290-295`; `assistant.js:270-289` |
| T4 (N-04) | Misma carrera forzada envío/edición que P3/R3: el informe del ciclo da `sent=0, failed=0` y el caso queda `notify_status='pending'`; el ciclo siguiente envía 1 aviso con «Edición dos vigente» y el caso pasa a `sent` | `service.ts:1131-1136,1161-1169` |
| T5 (E-02) | En una transacción revertida, con filas `lab_total` y `platform_month` de valor 0 para el negocio A: `reserveBudget` de 41d6c24 ⇒ `allowed` para A, B y sin negocio; la de `e4af950` (importada de mi worktree anterior) ⇒ `denied lab_total` para los tres. Sin fila global `lab_total` y la de A a USD 1000: 41d6c24 ⇒ `denied lab_total`; `e4af950` ⇒ `allowed` (la fila del negocio hacía de techo de toda la plataforma) | `governance.ts:59-64` |

## 4. Estado final por hallazgo

| ID | Estado final | Evidencia |
|---|---|---|
| F-01 | Cerrado | R4 (pasada 2, sigue pasando en 41d6c24) |
| F-02 | Cerrado | R1a/R1b; su residuo N-01 cerrado (T1) |
| F-03 | Cerrado | R2 |
| F-04 | Cerrado | R4 (revocación) |
| F-05 | Cerrado | R8 |
| F-06 | Cerrado | R3 |
| F-07 | Cerrado | R5; su hueco N-02 cerrado (T2) |
| F-08 | Cerrado en código; residuo de BD aceptado y documentado | R7; prueba unitaria de huellas; documento §8.12 (la BD no ata versión ↔ texto) |
| F-09 | **Parcial** | `docs/architecture/commercial-governance-safeguards.md` (156 líneas) y `evidence/commercial-governance/` existen en el árbol de integración **sin commitear**; lo que afirma el canon coincide con el código de 41d6c24 en lo que contrasté (§3/§4/§5/§6 del documento; `e2e-ui.txt` en HEAD `41d6c24` con 30 PASS, sin errores de página y la huella de `assistant.js` `3e358fbf3761ab4d` igual a la mía; registros de regresión en `41d6c24`; 7 capturas; `cost-bounds-report.md`). Falta `evidence/commercial-governance/README.md`, al que enlazan el documento (líneas 7 y §9) y el canon. Se cierra con el commit de documentación |
| F-10 | Cerrado | psql (pasada 2) + prueba del repositorio |
| F-11 | Cerrado | R6 |
| F-12 | Cerrado | `FR-0016.md:64-66` |
| F-13 | Cerrado | NOT VALID (pasada 2) |
| F-14 | Cerrado | `e5f8013`: AC-21003 «**Pendiente de confirmación del propietario.**» (`FR-0021.md:35`) |
| E-01 | Cerrado | `lab_enabled` (pasada 2) |
| E-02 | Cerrado | T5 |
| N-01 | Cerrado | T1; el canon ya no sobredeclara: «el aviso separa lo que escribe MainSpot del texto de terceros… (cualquier salto de línea cuenta)» (`FR-0016.md:66-68`, `CHANGELOG.md:15`) |
| N-02 | Cerrado | T2 |
| N-03 | Cerrado | T3 |
| N-04 | Cerrado | T4 |
| N-05 | Aceptado y documentado (sin cambio de código) | Documento §8.11: 0037 cambió antes de publicarse y `migrate.ts` no guarda huella; ninguna BD persistente la aplicó y cualquier otra debe recrearse |

## 5. Regresiones o huecos nuevos

En `41d6c24` / `e5f8013`: **ninguno en el código.** Comprobado:
- `LINE_BREAK` (con `/g`) solo se usa con `.replace` (sin estado de `lastIndex`); `\r\n` cuenta como un salto.
- Precedencia del encabezado: `failed` > `delivery_uncertain` > «actualizadas» > pendiente. Un caso incierto editado sigue
  avisando de la incertidumbre, que es lo prudente.
- `notify_status`: `failed` si alguna fila falló, `pending` si queda alguna pendiente, si no `sent`. El despacho vuelve a
  tomar `pending`; la auditoría `engagement.notified` solo sale con `sent`.
- `reserveBudget`: con fila global los techos se aplican igual que antes; sin fila global se deniega (fail-closed). La
  consola solo modifica filas globales, así que ningún flujo dependía de filas de un negocio.
- Panel: si un servidor anterior no enviara `status`, no hay botones (falla del lado seguro).
- Las sondas R de la pasada 2 (correcciones F-01…F-11) siguen pasando en 41d6c24.

Observaciones (NIT, ajenas al código de estos commits):

| ID | Sev. | Dónde | Descripción | Corrección |
|---|---|---|---|---|
| O-1 | NIT (preexistente, prueba) | `tests/e2e/ui-e2e-03.test.ts:263` (igual en `b809510`) | `!/\d{10}/.test(link.chat_id)` sobre ids simulados `sim-<12 hex>` (`engagement-routes.ts:44-46`) falla al azar cuando el hex contiene 10 dígitos seguidos: 3299/200000 = **1,65 %** de ids simulados. Explica `evidence/commercial-governance/regression/e2e-dev-e2e-03-intermittent-failure.txt` (`FAIL 6. chat vinculado…`, HEAD `41d6c24`), mientras que `e2e-dev-e2e-03.txt` en el mismo HEAD da 42 PASS. No es una regresión de esta rama | Comprobar `link.chat_id.startsWith('sim-')` o que no contenga los dígitos del teléfono del negocio, no cualquier secuencia de 10 dígitos |
| O-2 | NIT (documento sin commitear) | `docs/architecture/commercial-governance-safeguards.md` §8 riesgo 7 | Dice que sin techos se deniega «toda IA de pago, también Jev de pago»; TypeSafe no está en `PAID_PROVIDER_KINDS` (`governance.ts:24`), así que la ausencia de filas `ai_budget` no afecta a Jev, que mantiene su tope DEC-0032 | «toda invocación a Anthropic, OpenAI u OpenRouter; Jev/TypeSafe sigue con su tope diario (DEC-0032)» |

## 6. Canon e5f8013

- FR-0016 (`:66-68`) y CHANGELOG (`:15`): la descripción del aviso coincide con 41d6c24 (T1). Sin cifras ni decisiones nuevas.
- FR-0021 AC-21003: marcado «Pendiente de confirmación del propietario»; el enunciado (`:27-28`) sigue presentándolo como
  salvaguarda derivada, coherente con la marca.
- Validadores sin cambios (ver §2). DEC-0077.md/.json no cambian en estos commits.

## 7. Recomendación del revisor (no es firma de gate)

- **Local: GO técnico.** Todos los hallazgos de código están cerrados con sondas y pruebas (tsc 0, unitarias 189/189,
  integración 308/308, sondas 5/5) y sin regresiones. Condición para cerrar el incremento y el PR: commitear
  `docs/architecture/commercial-governance-safeguards.md` y `evidence/commercial-governance/` **con su README** (F-09),
  corrigiendo antes O-2. Recomendable: O-1 (prueba E2E inestable preexistente).
- **Producción: NO-GO.** Faltan los gates humanos (G-MIG sobre copia restaurada, G-SEC); la entrega real de Telegram no está
  verificada (`TELEGRAM_WEBHOOK_REAL_VERIFIED` pendiente); ningún proveedor real se ejercitó; el valor de `lab_total` para un
  entorno productivo no está decidido (es el techo acumulado de toda la IA de pago y ahora es obligatorio), y FB-1, FB-3 y TS-1
  siguen abiertos por decisión del propietario.
