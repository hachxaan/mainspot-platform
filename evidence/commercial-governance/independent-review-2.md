# Re-verificación adversarial (segunda pasada) — DEC-0077, commits 842b64f y 7cae590

Revisor: GovAdversarialReview (anthropic/claude-opus-5-5, esfuerzo máximo). Fecha: 2026-11-05 (hora local).
Informe de la primera pasada: `local://gov-review.md` (hallazgos F-01…F-14, E-01, E-02 sobre `5549935`/`e4af950`).

## 1. Alcance, commits y entorno

- Rama `feat/commercial-governance-safeguards-20261105`: `842b64f` (fixup de canon) y `7cae590` (correcciones de código),
  sobre `e4af950`. Revisados: `git diff e4af950 7cae590` completo (15 archivos de código y pruebas) y `git show 842b64f`
  (CHANGELOG, FR-0016, FR-0020, DEC-0077.md/.json).
- Worktree propio `../mainspot-platform-gov-review-7cae590` (HEAD `7cae590`, `npm ci`). PG desechable `127.0.0.1:55498`:
  `mainspot_test_review_7c` (suite) y `mainspot_test_review_probe_7c` (sondas), preparadas con `node scripts/test-prep.ts`,
  `APP_ENV=test`. Sin navegador, sin puerto 3100, sin red ni proveedores reales. No toqué el worktree de integración.
- Sondas: `tests/probes/gov-review-2.test.ts` (sin seguimiento, solo en mi worktree). Las `R*` son P1a…P9 adaptadas al
  contrato nuevo (botones desde `notices`, código al final de la primera línea, `approve` con `text` o
  `draft_number`+`drafts_revision`) y afirman el comportamiento CORREGIDO; las `X*` afirman lo que reporto como residuo o hueco.
  Reproducir: `APP_ENV=test DATABASE_URL=postgres://mainspot:gov-local-only@127.0.0.1:55498/mainspot TEST_DATABASE_URL=postgres://mainspot:gov-local-only@127.0.0.1:55498/mainspot_test_review_probe_7c node --test --test-concurrency=1 tests/probes/gov-review-2.test.ts`.

## 2. Conteos (exactos, worktree en 7cae590)

| Comprobación | Resultado |
|---|---|
| `npx tsc --noEmit` | `TSC_EXIT=0` (antes de añadir las sondas); con las sondas, `0` |
| `npm run test:unit` | `ℹ tests 189 · pass 189 · fail 0 · cancelled 0 · skipped 0` (12,96 s) |
| `npm run test:integration` (`mainspot_test_review_7c`) | `ℹ tests 308 · pass 308 · fail 0 · cancelled 0 · skipped 0` (141,4 s); carreras libres de la suite `{"approval_stale":10,"approved":2}` |
| Sondas `gov-review-2.test.ts` | `12/12` (9 R confirman correcciones; 3 X reproducen residuos) — carreras de R2: `{"409/200":7,"200/409":3}`, nunca texto no visto |
| Canon: `validate_schemas_v2.py` | VALID: DEC-0077.json, source-register.yaml, decision-state/index.json, links.yaml, functional-canon-state.yaml, implementation-state.yaml |
| Canon: `validate_traceability.py` | `RESULT: FAIL — 5/106`: los mismos 5 enlaces preexistentes de `b809510`; 0 nuevos |

Respecto a e4af950: unitarias +2 (`tests/unit/engagement-consent-terms.test.ts`), integración +8 (3 en engagement-consent, 5 en
telegram-approval-binding).

## 3. Estado por hallazgo de la primera pasada

Líneas sobre `7cae590`.

| ID (sev. original) | Estado | Evidencia |
|---|---|---|
| F-01 (HIGH) R2 `needsHuman` | **Cerrado** | `service.ts:456-466`: con `needsHuman` se libera la reserva (`ai_reply_needs_human`) y se descarta el texto. Sonda R4: `[needs_human, reply_needs_human, reply_invocation_id=null, ai_draft=null]`, texto de IA fuera de las numeradas, `committed=0`; «Redactar con IA» ⇒ 201 y `committed=1`. Canon corregido (`DEC-0077.md:27`, `FR-0016.md:41-43,83`) |
| F-02 (MEDIUM) formato no inyectivo / panel | **Cerrado** para `\n` y para el panel; **residuo LOW** (N-01) | `service.ts:1031-1046` (reseña y autor en una línea, `/aprobar`/`/rechazar` neutralizados en la reseña, continuaciones sangradas, código al final de la primera línea); `assistant.js:262-295` y `engagement-routes.ts:290-294` (botones desde la instantánea). Sondas R1a (el botón 2 confirma exactamente el texto publicado; 3 líneas `N) `; continuación `   2) …`) y R1b/R1c (reseña hostil aplanada, código del servidor ≠ `ZZZ234`). Residuo: X1 |
| F-03 (MEDIUM) `draft_number` | **Cerrado** | `service.ts:734-770`: sin `text` exige `draft_number` 1-3 + `drafts_revision` (400), revisión distinta ⇒ 409, y CAS `drafts_revision = $6` en el UPDATE. Sonda R2: `{}`⇒400, `{draft_number:1}`⇒400, revisión vieja⇒409; 10 carreras edición/aprobación sin publicar nunca lo no visto |
| F-04 (MEDIUM) revocación + `needsHuman` | **Cerrado** (por construcción: ya no hay unidad retenida en esa rama) | Sonda R4 (segunda parte): revocación durante la redacción ⇒ `needs_human`, `committed=0` |
| F-05 (MEDIUM) negocio suspendido/en baja | **Cerrado** | `telegram.ts:175-189` (`tenant_inactive`); la sesión del panel también se rechaza (`identity/repository.ts:124-125`); anonimización bloquea casos antes de borrar avisos (`retention/service.ts:393-394`). Sonda R8: `suspended` y `exiting` ⇒ `tenant_inactive`, panel 401/403, nada publicado |
| F-06 (LOW) re-aviso perdido | **Cerrado** | `service.ts:1152-1161` (`FOR SHARE` del caso y comparación de revisión antes de marcar enviada). Sonda R3 (misma intercalación forzada que P3): la fila no queda `sent`; el ciclo siguiente envía 1 aviso con «Edición dos (r+2) vigente» |
| F-07 (LOW) aviso de fallo / «cambiaron» | **Cerrado**; hueco nuevo en rama hoy inalcanzable (N-02) | `service.ts:991-999` (re-encola al agotar), `worker.ts:224-236` (CTE de `recoverStale`), `telegram.ts:244-249` (`approval_used`). Sonda R5: el chat que aprobó recibe «No pudimos publicar… · aviso <nuevo>» y el código usado responde «Ese aviso ya se usó…» |
| F-08 (LOW) versión↔texto | **Cerrado en código**; la BD sigue sin atarlo (residuo NIT) | `consent.ts:51-63` (`consentIsCurrent`: versión Y huella), `service.ts:238,253-256`; prueba unitaria que fija las huellas. Sonda R7: «v2» con otro texto ⇒ sin IA, `committed=0`, `reconsent_required=true` (la fila se sigue aceptando en BD) |
| F-09 (LOW) documento/evidencia ausentes | **Abierto (agravado)** | `docs/architecture/commercial-governance-safeguards.md` y `evidence/commercial-governance/` no existen en `7cae590` (`ls`: 0 y 0). `842b64f` pasa de «se registran al integrarlas» a afirmar que existen: `DEC-0077.json:47` («su diseño está en … y su verificación y evidencia en …, en la misma rama»), `DEC-0077.md:29-30,33-34` (R4/R5 «verificados en esta rama (evidencia en …)»), `CHANGELOG.md:34-35` |
| F-10 (LOW) guard de purga | **Cerrado** | `0037…sql:111-120`; psql sobre `mainspot_test_review_probe_7c`: `ERROR: … purging only empties the options`; prueba del repositorio ampliada |
| F-11 (NIT) encabezado «actualizadas» | **Cerrado** | `service.ts:1065-1067` (solo con un aviso previo de revisión menor). Sonda R6: el reintento tras fallo ambiguo dice «Caso pendiente de tu decisión · aviso …» y el primer código aprueba |
| F-12 (NIT) «mensaje genérico» en FR-0016 | **Cerrado** | `FR-0016.md:64-66`: genérico solo para otro chat/negocio; usado o sustituido se explica y se reenvía |
| F-13 (NIT) CHECK validado en 0037 | **Cerrado** | `0037…sql:33-34,37-38,62-63` NOT VALID; `pg_constraint.convalidated = f` en las 3; reversión por nombre sin cambios y prueba de migración 4/4 |
| F-14 (NIT) citas del canon | **Parcial** | AC-20005 corregido con enlaces DEC-0046/DEC-0057 (existen) y contrato de respaldos; AC-16004 «aparte de las tres numeradas». **AC-21003 sin cambios**: `FR-0021.md` no se tocó en `842b64f` ni en `7cae590` (sigue `FR-0021.md:27-28,35`) |
| E-01 (NIT) baldosa de laboratorio | **Cerrado** | `ai-routes.ts:125-126` (`lab_enabled`), `views-ai.js:177-179` |
| E-02 (NIT, preexistente) `pick` de techos globales | **Abierto** (no abordado) | `src/ai/governance.ts` sin cambios desde `e4af950` (`:63-66`) |

## 4. Hallazgos nuevos o residuales

| ID | Sev. | Archivo:línea | Descripción | Sonda | Impacto | Corrección |
|---|---|---|---|---|---|---|
| N-01 | LOW | `src/engagement/service.ts:1032-1033,1041,1046` | El sangrado de opciones solo trata `\n` y `\r\n` (`/\r?\n/g`): `U+2028`, `U+2029` o `\r` suelto dentro de una opción (los escribe cualquiera con `engagement.respond`) quedan sin sangrar antes de `2) …`. El aplanado usa `\s`, que en JS no incluye `U+0085` (NEL), así que una reseña con NEL conserva ese salto. El autor se aplana pero no se neutralizan sus comandos (`· Ana /aprobar ZZZ234 1`) | **X1**: el aviso contiene `Lamentamos lo ocurrido.\u20282) Te llamamos hoy.`, `Gracias por avisarnos.\r2) Escríbenos.`, `\u00852) Texto del reseñante` y `· Ana /aprobar ZZZ234 1` | En el panel no afecta (botones desde la instantánea). En Telegram real, si el cliente pinta esos caracteres como salto de línea [INFERENCE: depende del cliente], vuelve a haber líneas `N) …` falsas para quien lee. `FR-0016.md:66-67` («no admite suplantación») queda sobredeclarado | Normalizar todos los terminadores antes de componer: `s.replace(/\r\n?\|[\n\u000B\u000C\u0085\u2028\u2029]/g, '\n')` (opciones) y el mismo conjunto en el aplanado (`/[\s\u0085]+/g`); neutralizar comandos también en `author_label`; añadir estos casos a la prueba de formato |
| N-02 | LOW (rama hoy inalcanzable) | `src/engagement/worker.ts:224-236`; `service.ts:1035-1037`; `telegram.ts:244-247` | Con un replier NO idempotente, `recoverStale` pasa el caso a `needs_human`/`delivery_uncertain` y ahora re-encola el aviso, que sale como «Caso pendiente de tu decisión» sin advertir que la respuesta pudo publicarse ya; aprobarlo vuelve a llamar al proveedor. Además, `approval_used` dice «la publicación no salió», falso si la entrega es incierta | **X2** (replier envoltorio con `idempotent:false`): `recovered=1`, aviso nuevo, `Motivo: delivery_uncertain`, sin advertencia, nueva aprobación ⇒ 1 llamada más al proveedor | Hoy todos los repliers declaran `idempotent=true` (`providers.ts:60`, `google/reviews.ts:192`, `social/meta-engagement.ts:99,222`); el riesgo aparece si se añade uno que no lo sea | Encabezado propio para `reason = 'delivery_uncertain'` («No sabemos si se publicó: revísalo en Google/Facebook antes de aprobar») y mensaje de `approval_used` condicionado al motivo; o no re-encolar esa rama |
| N-03 | NIT | `src/api/engagement-routes.ts:290-294`; `src/web/panel/assets/js/assistant.js:280-289` | `notices` no trae el estado de la instantánea: el chat simulado ofrece «Usar opción N» también en avisos sustituidos o usados (el servidor los rechaza como obsoletos) | **X3**: aviso sustituido sigue en `notices`; su botón ⇒ `approval_stale`, nada publicado | Botones que siempre fallan; confusión | Incluir `status` en `notices` y no ofrecer botones (o marcarlos «aviso sustituido») salvo para `active` |
| N-04 | NIT | `src/engagement/service.ts:1152-1161,1124` | Cuando la revisión cambió, `deliverNotice` no marca la fila pero devuelve `'sent'`: el informe del ciclo cuenta un envío «válido» y el caso queda `notify_status='failed'` hasta el siguiente ciclo | Lectura de código (rama de R3) | Métricas y estado del panel engañosos un ciclo | Devolver `'skipped'` (u `'outdated'`) cuando no se marca |
| N-05 | NIT (proceso) | `migrations/0037…sql` (editado en `7cae590`); `scripts/migrate.ts:35-44` | 0037 se modificó después de aplicarse en BD locales y el runner no guarda huella de contenido: una BD persistente que aplicó la versión de `5549935`/`e4af950` conserva el guard antiguo (F-10 abierto ahí) y los CHECK validados; reaplicar no lo corrige (0037 figura aplicada) | En el contenedor desechable no hay BD persistente con 0037 (`mainspot` sin `schema_migrations`; el resto son de pruebas, recreadas); no verifiqué otras BD | Deriva silenciosa del esquema en BD que ya migraron | Recrear cualquier BD no desechable migrada con la versión anterior, o llevar el cambio del guard a una migración nueva; dejarlo escrito en la reversión/runbook |

Comprobado sin hallazgos (regresiones buscadas):
- CTE de `recoverStale`: el `UPDATE` de entregas se ejecuta aunque la consulta principal no lo lea (semántica de WITH con
  modificación); devuelve `recovered` correcto (X2). Rama idempotente sin cambios.
- Re-encolado al agotar en `respondCase`: inocuo si el UPDATE del caso no aplicó (el despacho solo toma `needs_human`/`failed`);
  automáticos escalados reciben aviso (no tenían filas).
- `FOR SHARE` en `deliverNotice`: mismo orden caso→entrega que la edición (`UPDATE caso`→ofertas→entregas) y que `/aprobar`
  (caso→oferta→entrega); `recoverStale` trabaja con casos `responding`, disjuntos de los que despacha. Sin ciclo de candados.
- Orden de candados en la anonimización: ahora caso→aviso; además `tenant_inactive` y el rechazo de la sesión impiden decidir
  sobre un negocio `exiting`, así que la carrera ya no es alcanzable.
- `tenant_inactive`: cubre `/aprobar`, `/rechazar`, códigos heredados y ayuda; `/start` sigue vinculando (inocuo).
- NOT VALID en 0037 y su reversión: las 3 restricciones se aplican a filas nuevas o modificadas; la reversión las borra por nombre.
- Guard de purga: la purga de Google solo cambia `options` y `status` (superseded_at lo fija antes el trigger) y pasa.
- `consentIsCurrent`: la huella guardada la impone el trigger (`sha256(consent_text)`), así que igualdad de huella ⇒ texto
  vigente exacto; FB y `review_required` conservan su semántica.
- Aplanado/neutralización: el código del aviso solo puede aparecer al final de la primera línea (la escribe el servidor); la
  reseña hostil de R1b no produce líneas `N) ` ni encabezados (resto: N-01).
- `lab_enabled`: falso fuera de `lab` y siempre con `APP_ENV=production`.
- F-01: la IA a pedido usa otra clave de idempotencia (`case:<id>:reply:<requestId>`, `ai-semantics.ts:103-105`), así que no
  reutiliza la salida descartada; la reserva liberada se reutiliza sin `request_in_progress`.

## 5. Canon — fixup 842b64f frente a SRC-0017 / SRC-0016 / OWNER-RESOLUTION

- R2 (`DEC-0077.md:27`, `FR-0016.md:41-43`, AC-16004): fiel a `OWNER-RESOLUTION.md:11` («no recibe automáticamente propuesta IA…
  se guarda aparte de las tres alternativas numeradas»). Liberar la unidad cuando la redacción automática pide revisión es la
  lectura literal (no hubo respuesta automática con IA, R3); no fija cifras ni crea decisión comercial.
- FR-0016: la «salvaguarda derivada» de negocio suspendido/en baja (`:69-70`) está marcada como tal y es coherente con DEC-0024
  («acceso retirado») y la suspensión de FR-0018. La frase «el texto del aviso no admite suplantación» (`:66-67`,
  `CHANGELOG.md:15`) se sobredeclara mientras siga N-01.
- FR-0020 AC-20005: atribución corregida; los enlaces nuevos DEC-0046/DEC-0057 resuelven (existen sus registros).
- DEC-0077.md/.json: sin cifras, precios ni aprobaciones nuevas; las huellas de SRC-0016 (`113a6344…`) y SRC-0017 (`6acfea9d…`)
  no cambian. Sí afirma artefactos que no existen (F-09) y R4/R5 «verificados» con evidencia en un directorio ausente.
- FR-0021 AC-21003 no se tocó (F-14 parcial).

## 6. Recomendación del revisor (no es firma de gate)

- **Local:** GO técnico para las salvaguardas SEC-CONSENT-01 y SEC-TG-APPROVAL-01: F-01…F-08, F-10…F-13 y E-01 cerrados con
  sondas y pruebas; sin regresiones (tsc 0, 189/189, 308/308). **Condición antes de dar el incremento y el PR por cerrados:**
  F-09 — crear `docs/architecture/commercial-governance-safeguards.md` y `evidence/commercial-governance/`, o retirar del canon
  las afirmaciones de que existen. Recomendado, no bloqueante en local: N-01, N-02 y los NIT (N-03…N-05, F-14/AC-21003, E-02).
- **Producción:** NO-GO por ahora. Faltan los gates humanos (G-MIG/G-SEC sin firmar), la entrega real de Telegram no está
  verificada (las pruebas usan el canal simulado), los proveedores reales no se ejercitaron y quedan las E2E por el dominio
  (las corre el agente principal). Antes de producción conviene cerrar N-01, porque su efecto depende del cliente real de
  Telegram, y decidir el techo `lab_total` heredado de `e4af950` (techo acumulado de toda la IA de pago).
