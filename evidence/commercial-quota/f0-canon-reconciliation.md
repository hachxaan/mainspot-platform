# CanonRecon — Diagnóstico F0 de reconciliación canónica (ciclo comercial 2026-11-05)

Autor: subagente `CanonRecon` (anthropic/claude-opus-5-5). Diagnóstico de solo lectura: **ningún archivo de ningún repositorio fue modificado**; no hubo commits, migraciones, servicios, BD, red ni proveedores. Lo no observado se marca **[INFERENCE]**.

Abreviaturas de rutas:
- `WT` = `/home/administrador/codeart/mainspoot/mainspot-platform-commercial`, rama `feat/commercial-quota-semantics-20261105`, **HEAD `83619f0`** (= `origin/docs/commercial-handoff-20261105`), árbol limpio (`git status --short | wc -l` → `0`). Las rutas sin prefijo son relativas a `WT`.
- `DOC@<ref>:<ruta>` = `git -C /home/administrador/codeart/mainspoot/mainspot-documentation show <ref>:<ruta>`. Checkout local en `feat/canonical-baseline-v0.1` (`571a4d2`, sin upstream), árbol limpio.
- `KEY@5e3dc307` = `canonflow-keystone` en el pin de MainSpot (`scripts/canonflow-jev.py:21`). El checkout está en `70ff601`, pero `decision-console/app/canonflow_hdc`, `scripts/validate_*.py`, `check_gates.py` y los esquemas usados **no difieren del pin** (`git diff --stat 5e3dc307 HEAD -- …` vacío; `git status` vacío en esas rutas).
- Entradas exportadas en `/tmp/msp-commercial/*`: **idénticas byte a byte** a `DOC@origin/docs/commercial-governance-20261105` (sha256 SRC-005 `535c0ede…540c`, PATCH `4b37f150…a32d`, FUTURE `83fb8634…a28a`, source-register `76eef9f6…e5e` → `SAME` en las cuatro comparaciones).

---

## 0. Resumen ejecutivo

1. **Autoridad recomendada: el canon `.canonflow` de la plataforma** (línea funcional con baseline global 0.1.0 fijada desde la baseline aprobada v0.1 del repo documental + deltas por ítem hasta **0.6.0**; técnico 0.1.0 + deltas hasta 0.5.0). La rama documental `docs/commercial-governance-20261105` es un **esqueleto 0.0.0 + fuente + staging**: su `07-DECISIONS-OPEN-QUESTIONS.md` tiene **1 línea** y no contiene ninguna decisión; por sus propias reglas no puede gobernar la implementación (§1).
2. La baseline documental aprobada (`CANONICAL_BASE_APPROVED_v0.1`, DEC-015) vive **solo en la rama local `feat/canonical-baseline-v0.1`** (sin remoto); `origin/main` y las ramas derivadas siguen en `INITIALIZED/0.0.0`. Las huellas SRC-0004/SRC-0005 de la plataforma coinciden con esa rama local (verificado).
3. **Precedente P1 exacto (registro sin sesión HDC)**: tres commits; el más cercano es **`e67a7e5`** (SRC-0013 → DEC-0075, delta 0.6.0), **16 archivos, todos en `.canonflow/`**, commit de canon separado y previo al código (§2, checklist §2.11).
4. **HDC-MSP-06 sí está definido**, pero solo como **propuesta** en `DOC@origin/plan/mvp-real-ai-native-20261020:docs/decisions/proposed/2026-10-20-MAINSPOT_MVP_HDC_QUEUE.md:18` («Planes y consumo IA … Semántica mensual, rollover/no rollover, prepago presupuestario, cuotas por modelo/feature, scopes por tenant, overrides; A/B/C/personalizado sin precios»), en una rama remota que no está en ningún checkout local. **Nunca se generó como QS** (QS-0001…QS-0017 no lo cubren). Esto **corrige** el inventario previo, que no lo encontró en los repositorios locales revisados (`docs/research/plan-parameters-inventory.json:221`: «no existen como archivos en ningún repositorio local revisado»). El ROADMAP-MVP-REAL-20261020 v0.4 citado por DEC-0010 está en la misma rama (`docs/roadmaps/2026/ROADMAP_MAINSPOT_MVP_REAL_2026-10-20.md:3`, «PROPOSED / planning, **no** canon aprobado»).
5. **C01 no contradice `reviews_managed`**: en canon y código `reviews_managed` es un tope **acumulado de reseñas ingeridas (recepción/sync)**, no de respuestas (FR-0010.md:14; `src/plans/registry.ts:95-98`; `src/reputation/engine.ts:239-258`; `docs/architecture/plan-catalog.md:59`). C01 crea una **unidad nueva y distinta** («respuesta generada con IA», mensual). Tensión residual: `reviews_managed` sigue pudiendo bloquear la recepción por su propio tope (§4.2).
6. **Conflictos reales con decisiones registradas** (requieren arbitraje humano, no inferencia): **C14 ↔ DEC-0018** (Trial «mismas funcionalidades que `plan_piloto_1`» vs «sin publicación real»; duración 30 días propuesta vs «no fijada»); **C10/C12 ↔ DEC-0024/DEC-0027** (anonimización a los 30 días de la baja vs retención 60 días; ¿cancelación = baja?). Ambigüedades a confirmar: alcance de C04 vs las seis capacidades acumuladas (FR-0010 AC-10006); actor de C07/C11 vs autoasignación retirada (DEC-0075 P5); «pagada/cobro» vs piloto sin cobro (BR-0006).
7. **Q-004 sigue abierta** (C03 lo reafirma). **HDC-MSP-06 queda resuelto solo en su parte semántica** (ciclo, no-rollover, sin excedentes, cambios de plan); siguen abiertos cuotas numéricas, fórmula de prorrateo, presupuestos/prepago, overrides y cuotas por modelo (§4.3).
8. **IDs libres (verificados en 21 refs y 6 worktrees)**: SRC-0014, DEC-0076, APR-0004, RSK-0001, QS-0018/ANS-0018, FR-0020, NFR-0009, BR-0008 (libre en la línea principal pero **usado con otro significado** en la rama sin integrar `feat/f01-telegram-acknowledged-alerts`; BR-0009 es libre globalmente), INC-0009, RUN-0024, HDC-0010. **Delta de canon propuesto: 0.7.0** (§6).
9. **Brecha de procedencia (G-SOURCE)**: los precedentes registraron **texto literal de primera mano** con sha256; SRC-005 es un **extracto normalizado de segunda mano** sin hash de audio/SRT. Propuesta exacta en §5 (SRC-0014 = copia byte a byte del extracto con `reliability: unverified`, + directiva literal del propietario como SRC-0015 si existe en la sesión OMP).
10. **No hace falta ficha HDC-NNNN** si se replica P1 tal cual; sí si se usa/sortea un instrumento HDC (§2.10).

---

## 1. Autoridad: `.canonflow` de la plataforma vs `mainspot-documentation`

### 1.1 Estado canónico de la plataforma (citas literales)

`.canonflow/state/functional-canon-state.yaml:1-22`:
```yaml
canon: functional
version: 0.1.0
state: FUNCTIONAL_CANON_IN_PROGRESS
items_index: .canonflow/canon/functional/index.yaml
changelog: .canonflow/canon/functional/CHANGELOG.md
blocking_open:
- QS-0001
- QS-0002
note: >-
  Baseline global v0.1.0 desde DEC-015; los deltas INFERRED ajenos al AI Core conservan su estado.
  El subconjunto AI Core (FR-0012..0019, BR-0007, NFR-0006..0008) está DECIDED:
  APR-0003 aprueba 0.2.0 y DEC-0066..0071 incorporan QS-0017 en 0.3.0.
  Delta 0.4.0: solo BR-0007 cambió por DEC-0073/SRC-0011 (OpenAI generativo en DESARROLLO; historia).
  Delta 0.5.0: FR-0012, FR-0019, NFR-0006 y BR-0007 cambiaron por DEC-0074/SRC-0012: …
  Delta 0.6.0: BR-0007, FR-0010, FR-0018 y FR-0019 cambian por DEC-0075/SRC-0013 (catálogo de planes versionado):
  … mecanismo periódico sin activar hasta HDC-MSP-06; asignación exclusiva de platform_admin en Administration;
  ningún parámetro nuevo. No decide Q-004 ni Trial.
  No nueva sesión HDC ni decisión comercial irreversible; otros items conservan versión/estado.
  Esta aprobación acotada no declara terminado el canon global.
```

`.canonflow/state/technical-canon-state.yaml:1-15`:
```yaml
canon: technical
version: 0.1.0
derived_from_functional_version: 0.1.0
state: TECHNICAL_CANON_IN_PROGRESS
…
note: >-
  Baseline global 0.1.0 sin reclasificar otros deltas. AI Core DECIDED por APR-0003 y DEC-0066..0071.
  Delta 0.4.0: ARC-0001 y OPS-0001 cambiaron por DEC-0073/SRC-0011 (historia).
  Delta 0.5.0: ARC-0001, DAT-0001 y OPS-0001 cambian por DEC-0074/SRC-0012; SEC-0001 queda en 0.3.0.
  …
```

Vínculo con el repo documental:
- `.canonflow/canon/functional/index.yaml:2-10`: `canon_version: 0.1.0` … `upstream_canon: {location: /home/administrador/codeart/mainspoot/mainspot-documentation, version: 0.1.0, state: CANONICAL_BASE_APPROVED_v0.1, decision: DEC-015}`.
- `.canonflow/state/method-state.yaml:13`: `upstream_canon: /home/administrador/codeart/mainspoot/mainspot-documentation/docs/canonical/00-INDEX.md` (ruta de sistema de archivos, no ref fijada).
- `.canonflow/recovery/DR-0001/reconciliation-plan.md:6`: «Canon fijado: FC/TC v0.1.0 (pinned desde la baseline aprobada upstream, DEC-015).»
- `.canonflow/sources/source-register.yaml:30-47`: SRC-0004 (`00-INDEX.md`, `sha256:47cb39af…42b8ed`, «Canon funcional aprobado por humano (DEC-015 …) rama feat/canonical-baseline-v0.1») y SRC-0005 (`07-DECISIONS-OPEN-QUESTIONS.md`, `sha256:8565b3df…edb9`).
- **Verificado**: `DOC@571a4d2:docs/canonical/00-INDEX.md` → `47cb39af…42b8ed`; `DOC@571a4d2:docs/canonical/07-DECISIONS-OPEN-QUESTIONS.md` → `8565b3df…edb9` (coinciden con SRC-0004/SRC-0005).

Versiones por ítem observadas (lectura de `canon_version` en cada ítem): BR-0007, FR-0010, FR-0018, FR-0019 = **0.6.0**; FR-0012, NFR-0006 = 0.5.0; FR-0013…FR-0017, NFR-0007, NFR-0008 = 0.3.0; resto funcional = 0.1.0. Técnico: ARC-0001, DAT-0001, OPS-0001 = 0.5.0; SEC-0001 = 0.3.0; API-0001…0004 = 0.1.0.

### 1.2 Estado canónico del repo documental (por ref)

Ramas: `main`/`origin/main` `ac45490` (2026-06-28); `feat/canonical-baseline-v0.1` `571a4d2` (2026-08-20, **solo local**, `git branch -vv` sin upstream); `origin/plan/mvp-real-ai-native-20261020` `0b8a331`; `origin/docs/commercial-governance-20261105` `2de11a2`. Las tres ramas remotas nacen de `ac45490` (`merge-base` = `ac45490`; la comercial está 4 commits por delante y **no contiene** los 11 commits de la baseline).

`DOC@origin/docs/commercial-governance-20261105:state/canonical-state.yaml:1-11` (idéntico en `main` y en `plan/mvp-real…`):
```yaml
schema_version: 1
project: mainspot
loop: canonical_documentation
status: INITIALIZED
canonical_version: 0.0.0
active_source_id: null
active_patch_id: null
blocked_by: []
checkpoint: null
next_action: PROCESS_REGISTERED_SOURCES
updated_at: 2026-06-28
```

`DOC@571a4d2:state/canonical-state.yaml:4-16` (baseline local):
```yaml
status: CANONICAL_BASE_APPROVED_v0.1
canonical_version: 0.1.0
…
blocked_by:
  - Q-004
checkpoint: docs/canonical/00-INDEX.md
next_action: IMPLEMENT_INCREMENT_1
updated_at: 2026-08-20
```

Contenido del canon en la rama comercial frente a la baseline (líneas por archivo, `wc -l`): `07-DECISIONS-OPEN-QUESTIONS.md` **1** vs 107; `00-INDEX.md` 33 vs 61; `03-REQUIREMENTS-RULES.md` 32 vs 66; etc. `DOC@…commercial…:docs/canonical/07-DECISIONS-OPEN-QUESTIONS.md:1` = «# Decisions and open questions» (sin Q-004 ni DEC). `state/traceability.json` = `{"canonical_version":"0.0.0","relations":[]}`; `state/implementation-state.yaml:4-10` = `NOT_STARTED`, `next_action: WAIT_FOR_CANONICAL_BASE_APPROVED`.

### 1.3 Documentos que declaran precedencia o autoridad

| Fuente | Cita (ruta:línea) | Efecto |
|---|---|---|
| Repo documental, README | `DOC@…commercial…:README.md:10-16` «`docs/canonical/`: fuente de verdad aprobada. `docs/staging/`: propuestas no aprobadas. `sources/`: evidencia primaria.»; `:36` «`mainspot-platform`: implementación futura alimentada por versiones canónicas aprobadas.»; `:40` «`INITIALIZED`: … la documentación funcional todavía no está aprobada.» | Declara al repo documental aguas arriba, pero en esta rama no hay canon aprobado. |
| Índice canónico 0.0.0 | `DOC@…commercial…:docs/canonical/00-INDEX.md:14` «Ningún documento de esta sección debe considerarse aprobado hasta que la versión alcance `CANONICAL_BASE_APPROVED`.»; `:33` «El loop de implementación no puede ampliar, reinterpretar ni sustituir el canon.» | La rama comercial no puede gobernar. |
| Staging | `DOC@…:docs/staging/README.md:3,7` «patches propuestos, todavía no canónicos … No se implementa directamente desde staging.» | PATCH/FUTURE no son canon. |
| Gobernanza | `DOC@…:docs/governance/README.md:5` «Canonical obligations may be supported only by `VERIFIED` evidence or an explicit `DECIDED` human decision.»; `:19-27` reglas de autoridad. | Las obligaciones exigen decisión humana registrada. |
| Loop de implementación | `DOC@…:docs/loops/02-canonical-implementation-loop.md:19-29` (no se inicia un incremento sin `canonical_version` congelada, contrato `INC-xxx` aprobado, AC verificables…). | Con 0.0.0 el loop documental bloquea todo; la plataforma ya implementó INC-0001…0008. |
| Patch comercial | `/tmp/msp-commercial/PATCH.md:12` «Es obligatorio identificar y reconciliar cuál versión gobierna el incremento antes de cambiar enforcement.» | Pide exactamente esta reconciliación. |
| SRC-005 | `/tmp/msp-commercial/SRC-005.md:59` «reconciliar autoridad y versión, sin suponer que un registro de una rama cambia automáticamente al otro.» | Ídem. |
| Roadmap (PROPOSED) | `DOC@origin/plan/mvp-real-ai-native-20261020:docs/roadmaps/2026/ROADMAP_MAINSPOT_MVP_REAL_2026-10-20.md:3` «PROPOSED / planning, **no** canon aprobado»; `:5` «Producto y código se implementarán en `mainspot-platform`»; `:17` la baseline citada por la plataforma está «en una rama local … no está publicada remotamente»; `:146` «La evidencia/decisiones por cliente MainSpot permanecen en el repositorio y HDC correspondiente»; `:159` «`main` inicial `0.0.0`; baseline aprobada v0.1 se recuperará del local del propietario, no se supondrá desde main». | El propio plan documental reconoce que las decisiones viven en la plataforma y que `main` 0.0.0 no es la baseline. |
| Cola HDC (PROPOSED) | `DOC@…plan/mvp…:docs/decisions/proposed/2026-10-20-MAINSPOT_MVP_HDC_QUEUE.md:9` «Las decisiones históricas `DEC-018` … `DEC-024` … están registradas en mainspot-platform»; `:22` «Las sesiones HDC definitivas deberán generarse por la versión vigente del runtime CanonFlow» | Ídem. |
| P0 (PROPOSED) | `DOC@…plan/mvp…:docs/product/2026/P0_MAINSPOT_RECONCILIATION_AND_FUNCTIONAL_DEFINITION_2026-10-20.md:7` «El canon histórico aprobado reside en una rama Git **local**, no disponible en el remoto» | Ídem. |
| Handoff/arranque | `docs/handoffs/commercial-policy-2026-11-05/HANDOFF.md:10`; `START-PROMPT.md:34-36` «RECONCILIAR: repositorio documental inicial vs .canonflow vigente … Nada de staged => canonical automático.» | Mandato de reconciliar. |
| CanonFlow (pin) | `KEY@5e3dc307:method/18-flow-existing-system-feature.md:9-11` «trusted canon exists? yes → pin current FC/TC versions»; `method/21-skill-layer.md` §7 «Obligations flow downstream only: human decisions → functional canon → technical canon → contracts → code»; `method/22-source-precedence-and-conflict.md:48-53` nivel 1 = «Registered human decisions. DEC/APR/RSK records ingested…»; `:77-81` «Chat / conversation. Never a source of truth…». **Nota**: `method/21` y `method/22` están en `Status: REVIEW_CANDIDATE` (líneas 3-4 de cada uno), no vinculantes plenos. | El nivel de autoridad máximo son los registros de decisión humana, que existen **solo** en la plataforma. |

### 1.4 Hallazgos

- La plataforma contiene todas las decisiones humanas registradas desde 2026-10-21: DEC-0001…DEC-0075 y APR-0001…APR-0003 (156 archivos = 78 registros × 2; `ls .canonflow/decision-records | wc -l` → `156`), 17 sesiones QS (16 ARCHIVED, QS-0015 PENDING) (`.canonflow/decision-state/index.json`).
- El repo documental no tiene ninguna decisión posterior al 2026-08-20 en `docs/canonical/` de ninguna rama; la rama comercial ni siquiera conserva DEC-001…026 ni Q-004 (archivo de 1 línea).
- Las ramas comerciales y de planeación del repo documental parten del esqueleto 0.0.0, no de la baseline. El «0.0.0» de la rama comercial es un **artefacto de ramificación desde `origin/main`**, no una afirmación sobre el canon vigente [INFERENCE apoyada en `merge-base` y en los mensajes de `DOC@…plan/mvp…` :17/:159].

### 1.5 Recomendación

**Autoridad de implementación = `.canonflow` de `mainspot-platform`** (canon funcional global 0.1.0 + deltas por ítem hasta 0.6.0; técnico 0.1.0 + deltas hasta 0.5.0). Razones:
1. Es la única línea con **registros de decisión humana** (nivel 1 de precedencia en `KEY@5e3dc307:method/22…:48-53`) y con estados, changelogs y trazabilidad versionados.
2. Deriva por huella sha256 de la única baseline aprobada (DEC-015) y la evolucionó solo por decisiones humanas (DR-0001; QS/ANS; P1).
3. Por sus propias reglas, la rama documental comercial no puede gobernar (0.0.0 «no aprobado», staging «no se implementa directamente», loop de implementación bloqueado).
4. Los documentos de planeación del repo documental remiten las decisiones a la plataforma (HDC queue :9; roadmap :146, :159).
5. El precedente inmediato del propietario para una decisión de planes (DEC-0075, respuesta 7 «SRC + DEC», `.canonflow/sources/SRC-0013-plan-catalog-directive.md:37-39`) usó el canal de la plataforma.

Tratamiento del repo documental en este ciclo: SRC-005 = **evidencia** a importar como fuente de la plataforma; PATCH/FUTURE = **propuestas de staging** (sin efecto normativo); no publicar ni editar `canonical_version` del repo documental (fuera de alcance). Recomendado dejar constancia de esta reconciliación en el comentario de DEC-0076 y en la entrada 0.7.0 del CHANGELOG, para cerrar G-CANON sin crear una segunda autoridad. No veo necesidad de preguntar al propietario por la autoridad: la evidencia registrada la resuelve; sí deben resolverse los conflictos concretos de §4.6.

---

## 2. Precedente exacto para registrar una directiva externa sin nueva sesión HDC (P1)

### 2.1 Commits y archivos tocados (`git show --stat`)

| Commit | Registro | Archivos | En `.canonflow/` |
|---|---|---|---|
| `1f1c7da` 2026-11-03 03:25 -0500 «feat(ai): select OpenAI generation for development under DEC-0073» | SRC-0011 → DEC-0073 (SUPERSEDES DEC-0069) | 49 | 19 |
| `95f9436` 2026-11-03 05:41 -0500 «feat(ai): Anthropic text, OpenAI images and manual DRAFT lab under DEC-0074» | SRC-0012 → DEC-0074 (SUPERSEDES DEC-0073) | 57 | 23 |
| **`e67a7e5`** 2026-11-04 17:52 -0500 «docs(canon): register SRC-0013 and DEC-0075 for the versioned plan catalog» | SRC-0013 → DEC-0075 | **16** | **16** |

`e67a7e5` (lista completa, autor `hachxaan-main <mainspot-platform@hachxaan.local>`; mensaje: «… No APR, QS/ANS or source_ref.»):
```
.canonflow/canon/functional/CHANGELOG.md           (+21)
.canonflow/canon/functional/index.yaml             (comentarios)
.canonflow/canon/functional/items/BR-0007.md
.canonflow/canon/functional/items/FR-0010.md
.canonflow/canon/functional/items/FR-0018.md
.canonflow/canon/functional/items/FR-0019.md
.canonflow/decision-records/DEC-0075.json          (A)
.canonflow/decision-records/DEC-0075.md            (A)
.canonflow/decision-state/index.json               ("dec": 74 → 75)
.canonflow/decision-state/legacy/index.json.9c4b8caab90bdae5ce512bf9f5ff192baa9cc70d18a89f2fc580f1954f20c9da.json (A)
.canonflow/decision-state/legacy/manifest.json     (+1 entrada)
.canonflow/sources/SRC-0013-plan-catalog-directive.md (A)
.canonflow/sources/source-register.yaml            (+13)
.canonflow/state/functional-canon-state.yaml       (nota)
.canonflow/state/implementation-state.yaml         (nota INC-0006)
.canonflow/traceability/links.yaml                 (+1)
```
Está en las ramas de PR #13/#14 y en `WT` (`git branch -a --contains e67a7e5`); es el **primer** commit tras `95f9436` y precede a 4 commits de código hasta `b1cd3df` (commit de canon separado y previo).

`95f9436` en `.canonflow/` (23): CHANGELOG funcional y técnico; `functional/index.yaml`, `technical/index.yaml`; ítems BR-0007, FR-0012, FR-0019, NFR-0006, ARC-0001, DAT-0001, OPS-0001; DEC-0074.json/.md (A); `decision-state/index.json`; snapshot `legacy/index.json.0b169ce2…1430.json` (A); `legacy/manifest.json`; `increments/INC-0008.md`; SRC-0012 (A); `source-register.yaml`; los tres `state/*-state.yaml`; `traceability/links.yaml`. Fuera de `.canonflow/`: `.env.example`, `.omp/AGENTS.md`, `README.md`, `docs/architecture/ai-core.md`, `docs/architecture/ai-providers-data-terms.md`, el handoff AI Core, `evidence/**`, migraciones 0030/0031, `src/**`, `tests/**`.

`1f1c7da` en `.canonflow/` (19): CHANGELOG funcional y técnico, índices, BR-0007, ARC-0001, OPS-0001, DEC-0073.json/.md (A), `index.json`, snapshot `legacy/index.json.f365be19…caf0a.json` (A), `manifest.json`, `INC-0008.md`, SRC-0011 (A), `source-register.yaml`, tres estados, `links.yaml`; además `.env.example`, `.omp/AGENTS.md`, `README.md`, docs, evidencia, migración 0029, `src/ai/catalog.ts`, tests.

**No tocados en ninguno de los tres** (verificado por `--stat` y `git log`): `decision-state/latest.json`, `decision-state/sessions/*`, `decision-sessions/*`, `skill-runs/*` (último RUN-0023, commit `d297e8a`), `state/method-state.yaml`, `state/roadmap-checkpoint.yaml`, `skill-state/*`, `.canonflow-updates/*` (último commit `d297e8a`).

### 2.2 Disparador del precedente

El P1 se usó solo cuando una **directiva literal del propietario** ordenaba registrar: SRC-0011:10,22 («**Nueva decisión explícita del propietario:** …»; «9. Registrar trazablemente esta nueva decisión del propietario y actualizar el canon…»); SRC-0012:30 «Registra la nueva decisión con trazabilidad, preservando QS-0017 y DEC-0073»; SRC-0013:37-39 (respuesta 7 «SRC + DEC»). El método solo admite fallback por chat si no se pueden generar archivos (`KEY@5e3dc307:method/15-human-decision-console.md:51-52` «Chat fallback (plain-text questions) is allowed **only** when the environment cannot generate files»; `.canonflow/skills/cards/canonflow-human-decision-console.skill-card.yaml:83`), por lo que P1 es **práctica del proyecto** habilitada por la orden del propietario, no una excepción que el agente pueda invocar por su cuenta (coincide con `docs/research/plan-parameters-inventory/slices/V5-canon-governance.json` → `registration_precedent.summary_es`).

### 2.3 Esquemas y forma de los registros

**SRC (sin front matter YAML; cabecera en prosa)** — `SRC-0013-plan-catalog-directive.md:1-13`: título `# SRC-00NN — Directiva del propietario: …`; «Origen: respuestas explícitas del propietario Carlos Pinacho en esta conversación OMP (2026-11-04) …» (distingue texto del agente vs selección del propietario, `:3-6`); «Registro: 2026-11-04T19:04:34Z. No procede de un nuevo QS/ANS ni altera sus respuestas históricas.» (`:7`); qué conserva (`:8-9`); contexto (`:10-13`, incluida la omisión justificada de una pregunta no de producto); `## Transcripción literal` (`:15-39`). SRC-0012 `:1-8`: «Origen: mensaje explícito del propietario …»; «Registro: 2026-11-03T09:16:52Z»; `## Instrucción literal`.

**Entrada del registro de fuentes** (`source-register.yaml:117-129`):
```yaml
- id: SRC-0013
  title: Instrucción explícita del propietario — catálogo de planes versionado (respuestas a preguntas del agente)
  kind: document
  location: .canonflow/sources/SRC-0013-plan-catalog-directive.md
  fingerprint: sha256:4fb1bd5472b4ae373c16ab8d950929074ac54563151ee0890d8b0a03ba0b9fa4
  reliability: authoritative
  registered_at: '2026-11-04'
  notes: >-
    Fuente humana literal externa al HDC; registrada como DEC-0075 sin inventar QS/ANS. …
```
Esquema `KEY@5e3dc307:schemas/source-register.schema.yaml:11-20`: obligatorios `id, title, kind, fingerprint, reliability, registered_at`; `kind ∈ {idea, interview, document, ticket, regulation, code, runtime_evidence, config, published_doc, other}`; `reliability ∈ {authoritative, informative, unverified}`. **No existe campo `raw_verified`**: la procedencia va en `notes`. Verificado: `sha256sum` de SRC-0011/0012/0013 = huellas registradas (`b4b6563a…`, `883591ed…`, `4fb1bd54…`).

**DEC-0075.json** (13 claves, idénticas en DEC-0073/0074):

| Campo | Valor en DEC-0075 (`DEC-0075.json:línea`) |
|---|---|
| `schema_version` | `2` (:2) |
| `record_id` | `"DEC-0075"` (:3) |
| `kind` | `"decision"` (:4) |
| `title` | (:5) |
| `decision` | texto completo por respuesta 1–7 y «No decide: …» (:6, 2 964 caracteres) |
| `owner` | `"Carlos Pinacho"` (:7) |
| `decided_at` | `"2026-11-04T19:04:34Z"` (:8) = instante del registro, «no un timestamp aportado por el propietario» (:42) |
| `source` | `"SRC-0013 — respuestas explícitas del propietario a preguntas del agente en conversación OMP"` (:9) |
| `artifact_ref` | `".canonflow/sources/SRC-0013-plan-catalog-directive.md"` (:10) |
| `options_rejected` | 7 opciones no elegidas de preguntas de respuesta única (:11-19) |
| `affected_items` | 19 (BR-0007, FR-0010, FR-0018, FR-0019, DEC-0010, DEC-0018, INC-0006, migración, `src/**`) (:20-40) |
| `expiry` | `""` (:41) |
| `comment` | «Origen humano externo al HDC. source_ref se omite porque el esquema v2 lo permite como campo opcional y solo admite QS/ANS cuando está presente; no se inventa una sesión. Fuente literal registrada en SRC-0013 (sha256 …) … No sustituye ninguna decisión … Es un registro de decisión, no una aprobación (APR)…» (:42) |

Sin `source_ref` (esquema `KEY@5e3dc307:schemas/decision-record.schema.yaml:13` exige solo `record_id, kind, title, decision, owner, decided_at, source`). `validate_schemas_v2.py` → `VALID` para DEC-0075.json y DEC-0074.json (ejecutado ahora, §Apéndice).

**DEC-0075.md**: front matter `record_id, kind, owner, decided_at, source` (`:1-7`); «JSON estructurado: `DEC-0075.json`. Fuente literal: `../sources/SRC-0013-…` (sha256 …)» (`:10-11`); `## Decisión` (`:13-15`); `## Respuestas y efecto en el canon (delta 0.6.0)` tabla (`:17-27`); `## Qué no decide y qué conserva` tabla (`:29-40`); `## Procedencia y alcance` (`:42-44`).

### 2.4 Ítems de canon: dónde viven y cómo se versionan

- Archivos: `.canonflow/canon/functional/items/<ID>.md` (y `technical/items/`). Front matter: `id`, `state` (sigue `DECIDED`), **`canon_version`** (salta directamente al número del delta: FR-0010 0.1.0 → 0.6.0, FR-0018 0.3.0 → 0.6.0; `git show e67a7e5 -- …FR-0010.md`), `tier_hint`, `links` + `- {to: DEC-0075, type: CONSTRAINED_BY}` (BR-0007.md:15; FR-0010.md:9; FR-0018.md:10; FR-0019.md:11).
- Cuerpo: párrafos rotulados «(DEC-0075)» en `## Statement` (FR-0010.md:16-39; FR-0018.md:25-31; FR-0019.md:42-54; BR-0007.md:56-64 + matriz :66-74), ACs nuevos con numeración por ítem (AC-10001…10008, AC-18004…18007, AC-19007…19011) y nota (FR-0010.md:54-59). Las salvaguardas derivadas se marcan «no decisión nueva» (FR-0019 AC-19011; CHANGELOG.md:14-18).
- Al tocar FR-0010 se corrigió la sangría YAML del segundo enlace (CHANGELOG.md:21-22). El mismo defecto sigue en **todos** los ítems baseline no tocados (BR-0001…0006, FR-0001…0009, FR-0011, NFR-0001…0005: `^  - {to:` en la línea 8).
- Índice: solo líneas de comentario (`functional/index.yaml:66`, `:145`); `canon_version: 0.1.0` del índice no cambia.
- CHANGELOG: sección `## 0.6.0 — 2026-11-04` (`functional/CHANGELOG.md:3-22`) con ítems, DEC, «directiva humana externa … no nueva respuesta HDC», qué no decide y «Se conservan byte a byte…». El técnico no cambió en 0.6.0 (`technical/CHANGELOG.md` termina en 0.5.0).

### 2.5 Trazabilidad

`.canonflow/traceability/links.yaml:96-100`: solo cadenas de gobierno (`DEC-0073 → SRC-0011 DERIVES_FROM`, `DEC-0073 → DEC-0069 SUPERSEDES`, `DEC-0074 → SRC-0012`, `DEC-0074 → DEC-0073 SUPERSEDES`, `{from: "DEC-0075", to: "SRC-0013", type: "DERIVES_FROM", by: "Carlos Pinacho", at: "2026-11-04T19:04:34Z"}`). Los vínculos ítem→DEC viven en el front matter de cada ítem. DEC-0074 usó `SUPERSEDES` pese a ser sustitución parcial.

### 2.6 Estados

- `functional-canon-state.yaml`: solo `note` (+4 líneas «Delta 0.6.0: …»); `version`, `state`, `blocking_open` intactos.
- `technical-canon-state.yaml`: solo cuando cambia el técnico (1f1c7da, 95f9436), no en e67a7e5.
- `implementation-state.yaml:29-34`: nota de evolución de INC-0006 («Código en la rama … su verificación y evidencia se registran al integrarlo, no en este registro»); `state`/`evidence` intactos.

### 2.7 Incrementos

DEC-0073/0074 actualizaron `.canonflow/increments/INC-0008.md` (cabecera `:3-7` con delta vigente; tabla de plan `:21-33`). DEC-0075 **no** creó ni editó archivo de incremento: solo la nota de INC-0006 en `implementation-state.yaml`. En `.canonflow/increments/` solo existe `INC-0008.md`.

### 2.8 `decision-state`

- `index.json`: único cambio `"dec": 74` → `75` (`index.json:248`); `latest` y `reconstructed` sin tocar (`:252-258`, `reconstructed.at: 2026-11-03T05:40:27Z`, `by: RUN-0023`). `latest.json` = QS-0017 ARCHIVED (sin cambio).
- Snapshot: copia del **index.json resultante** nombrada por su sha256. Verificado: `sha256(index.json@e67a7e5^)` = `0b169ce2…` (snapshot de 95f9436) y `sha256(index.json@e67a7e5)` = `9c4b8caa…` = snapshot añadido por e67a7e5 = `sha256sum` del archivo `legacy/index.json.9c4b8caa….json` y del `index.json` actual (7 294 bytes).
- `legacy/manifest.json:675-681`: `{bytes: 7294, captured_at: "2026-11-04T19:08:30Z", original_path: ".canonflow/decision-state/index.json", sha256: "9c4b8caa…", snapshot_path: ".canonflow/decision-state/legacy/index.json.9c4b8caa….json"}`, claves ordenadas, igual que escribe `canonflow_hdc.legacy.preserve_legacy_indexes` (`KEY@5e3dc307:decision-console/app/canonflow_hdc/legacy.py:29-75`, `json.dumps(…, sort_keys=True)`). [INFERENCE] El agente editó el contador y luego invocó esa función (o la imitó); el repo no registra cuál.

### 2.9 Instrumentos CanonFlow: usados y no usados

- **No usados en P1**: `canonflow-hdc rebuild-index` (`KEY…/cli.py:156-166`; reescribiría `sessions/latest/reconstructed`, que siguen con el sello de RUN-0023); `.canonflow-updates/artifacts/HDC-0006-regenerate-compat-views.py` (regenera `index.json` completo con `--run RUN-NNNN`, `:36-72`); `publish-session`/`publish-ingestion`/`mark-session` (vía HDC normal P3); `scripts/canonflow-jev.py` (subcomandos `status|set-key|review-offline|review-live`, `:206-209`; es del flujo de activación de Jev; `review-live` llama a TypeSafe `:29` → no aplica y no debe ejecutarse).
- **Validadores offline (lectura, sin red)** ejecutados ahora: `validate_schemas_v2.py` → VALID (DEC-0075.json, DEC-0074.json, `source-register.yaml`, `decision-state/index.json`, `links.yaml`); `validate_traceability.py` → `RESULT: FAIL — 5/99 link(s) offending`, todos preexistentes y ajenos a P1: `link[62]` ANS-0012→QS-0010, `[68]` ANS-0013→QS-0012, `[73]` ANS-0014→QS-0013, `[79]` ANS-0015→QS-0014 (regla ANS-N = QS-N) y `[83]` QS-0017 SUPERSEDES QS-0016. Tras añadir `DEC-0076 → SRC-0014` el resultado esperable es 5/100 [INFERENCE].

### 2.10 ¿Necesita este ciclo una ficha `HDC-NNNN`?

Regla (`.canonflow-updates/README.md:133-152`): «Todo cambio de HDC pedido en MainSpot se registra aquí … También se registra todo defecto de HDC o de sus instrumentos (CLI, índices, ciclo de vida) que un agente sortee en MainSpot, aunque no modifique código de HDC».
- **No**, si se replica P1 exactamente (contador `dec` + snapshot + manifiesto, sin QS ni regeneración): los tres precedentes no tocaron `.canonflow-updates/` (`git log -- .canonflow-updates` → último `d297e8a`, 2026-11-03).
- **Sí, nota de reaplicación** en la ficha existente si se usa `HDC-0006-regenerate-compat-views.py` o el envoltorio `HDC-0009-publish-session-stamped.py` (precedente `d297e8a`, +20 líneas en `HDC-0006-vistas-compatibilidad-tras-ingestion.md`).
- **Sí, ficha nueva `HDC-0010`** (plantilla `:154-175`, más la fila del índice `:33-43`) si se modifica HDC/UI o se sortea un defecto nuevo (p. ej., fallo de validador o de `rebuild-index`).
- Riesgo de lectura estricta: el aumento manual del contador podría verse como un rodeo de «índices». Tres precedentes no lo registraron; para transparencia, mencionarlo en el `comment` de DEC-0076 [recomendación].

### 2.11 Checklist para replicar (SRC-0014 → DEC-0076, delta 0.7.0)

Commit **solo de canon** (como `e67a7e5`), antes de cualquier código:
1. `.canonflow/sources/SRC-0014-<slug>.md` (A): contenido según §5.3.
2. `.canonflow/sources/source-register.yaml`: añadir la entrada SRC-0014 (y SRC-0015 si aplica §5.3), con `fingerprint: sha256:<hex>` calculado sobre el archivo final.
3. `.canonflow/decision-records/DEC-0076.json` (A): esquema v2, las 13 claves de §2.3, sin `source_ref`, `decided_at` = instante de registro (RFC 3339 UTC) y procedencia en `comment`.
4. `.canonflow/decision-records/DEC-0076.md` (A): front matter de 5 claves; puntero al JSON y a la fuente con sha256; `## Decisión`; tabla C01–C14 → efecto en canon (delta 0.7.0); `## Qué no decide y qué conserva` (Q-004, numéricos, fórmula C08, F01–F08, DEC-0005/0006/0007/0017/0039…); `## Procedencia y alcance` (G-SOURCE abierto).
5. `.canonflow/decision-state/index.json`: solo `counters.dec` 75 → 76.
6. `.canonflow/decision-state/legacy/index.json.<sha256-del-nuevo-index>.json` (A): copia exacta del `index.json` resultante.
7. `.canonflow/decision-state/legacy/manifest.json`: añadir `{bytes, captured_at, original_path, sha256, snapshot_path}` (claves ordenadas).
8. `.canonflow/traceability/links.yaml`: `{from: "DEC-0076", to: "SRC-0014", type: "DERIVES_FROM", by: "Carlos Pinacho", at: "<decided_at>"}` (+ `SRC-0015`), y `SUPERSEDES` **solo** si el propietario confirma una sustitución (p. ej., DEC-0018 parcial; §4.6).
9. Ítems afectados (§6.3): `canon_version: 0.7.0`, `- {to: DEC-0076, type: CONSTRAINED_BY}`, párrafos «(DEC-0076)», ACs nuevos con su numeración y corrección de la sangría YAML si el ítem es baseline.
10. `.canonflow/canon/functional/index.yaml`: comentarios (y entradas si hay ítems nuevos: `id/title/state/tier_hint/path/source`).
11. `.canonflow/canon/functional/CHANGELOG.md`: `## 0.7.0 — 2026-11-05`.
12. `.canonflow/state/functional-canon-state.yaml`: añadir «Delta 0.7.0: …» a `note` (sin tocar `version`/`state`).
13. `.canonflow/state/implementation-state.yaml`: nota de evolución de INC-0006, o nueva entrada INC-0009 (§6.1).
14. Condicional: canon técnico (ítems, `technical/index.yaml`, `technical/CHANGELOG.md`, `technical-canon-state.yaml`) solo si cambia algún ítem técnico (DEC-0075 no lo hizo); `.canonflow/increments/INC-0009.md` solo si se abre contrato propio.
15. No tocar `latest.json`, `sessions/*`, `decision-sessions/*`, `skill-runs/*`, `method-state.yaml`, `roadmap-checkpoint.yaml` ni `.canonflow-updates/*` (salvo §2.10).
16. Validación offline posterior (la ejecuta el agente principal): `python3 -B <KEY>/scripts/validate_schemas_v2.py <instancia> --schema <KEY>/schemas/<esquema>.yaml` para DEC-0076.json, `source-register.yaml`, `index.json` y `links.yaml`; `validate_traceability.py --links … --store .canonflow` (esperar solo los 5 fallos preexistentes); `sha256sum` de SRC y snapshot.
17. Commits de implementación después; documentación de proyecto (README, `docs/architecture/plan-catalog.md`, `.omp/AGENTS.md` si cambia el contexto persistente), como en `1f1c7da`/`95f9436`.

---

## 3. Contenido y estado de los registros y del canon pertinentes

- **DEC-0075** (`DEC-0075.json:6`; `.md:17-40`): catálogo en Engineering con `plans.read/edit/publish`; publicar = configuración operativa «Sin aprobación comercial»; suscripciones fijadas a su revisión con migración explícita; P4 `periodic` = «Mecanismo sin activar … ningún plan real lo usa hasta HDC-MSP-06; las seis capacidades conservan su semántica actual (acumulada)»; P5 autoasignación del negocio **retirada** (403); P6 ningún parámetro nuevo («Biblioteca de medios, Elegibilidad de IA, Plan Trial (DEC-0018), Techo de autorrespuestas» ni aprobados ni rechazados, `json:42`); P7 «SRC + DEC». No decide: precios/nombres/paquetes/límites comerciales (Q-004, DEC-0010); ciclo, rollover, excedentes, cambios de plan (HDC-MSP-06); Trial (DEC-0018 vigente, pendiente de implementación); `agents` (DEC-0006/0017). Estado: DECIDED, sin APR.
- **Q-004** (canon upstream, no es archivo de la plataforma): `DOC@571a4d2:docs/canonical/07-DECISIONS-OPEN-QUESTIONS.md:50` `OPEN` «¿Se aprueban planes, nombres, precios y límites de la landing?» POSPUESTA; infraestructura vía DEC-024. Plataforma: DEC-0010 la mantiene pospuesta «exclusivamente en lo relativo a la aprobación comercial…» (`DEC-0010.md:15,33`); DR-0001 DI-0003 (`drift-report.yaml:39-47`). Upstream REQ-019 `OPEN` (`DOC@571a4d2:…/03-REQUIREMENTS-RULES.md:38`), RULE-006 (`:51`), CAP-012 `OPEN` (`…/02-DOMAIN-CAPABILITIES.md:43`). **Estado: OPEN.**
- **HDC-MSP-06**: definición (PROPOSED, «no constituye sesiones HDC contestadas», `…HDC_QUEUE.md:3`) en `…HDC_QUEUE.md:18`; P0 `:119` «`HDC-MSP-06` / `S0` | Semántica de cuotas mensuales, sobreconsumo/rollover, prioridad override, medición y reservas | Antes de consumo de tokens reales; no hace falta elegir precios comerciales.»; roadmap `:87` (S0) y `:90` (S3: upgrades, renovaciones y cancelaciones como comercial futura). En la plataforma: designado en DEC-0010 (`DEC-0010.md:29,46`; `DEC-0010.json:29-30`) y QS-0004 (`decision-sessions/archived/QS-0004.questions.json:162`); invocado por DEC-0075, FR-0010.md:36,50,58, CHANGELOG 0.6.0 y `plan-catalog.md:14,19`. **Estado: designado, nunca creado** (ninguna QS lo cubre; el siguiente QS sería QS-0018).
- **DEC-0010** (QS-0002/ANS-0002 Q-PLANS, 2026-10-21): Q-004 pospuesta solo en lo comercial; dirección A/B/C/Personalizado «no equivale a una aprobación canónica» (`.md:35-42`); el MVP debe tener S0/S1 «sin requerir precios definitivos, pasarela de pagos ni facturación real» (`:44`); «Quedan pendientes las cuotas numéricas, el ciclo mensual, rollover, excedentes, cambios de plan, presupuestos y políticas de consumo. Deben resolverse mediante HDC-MSP-06 antes de activar consumo real» (`:46`); «No posponer … la infraestructura de planes» (`:48`).
- **DEC-0018** (QS-0004/ANS-0004 Q-TRIAL): Trial = plan `trial` del catálogo, asignación administrativa (`.md:33-34`); «Vigencia inicial propuesta: **30 días naturales desde su activación**» (`:35`); «Límites y funcionalidades: **los mismos que `plan_piloto_1`**» (`:36`); consumo contabilizado, sin inferencia ilimitada (`:37-38`); al vencer `EXPIRED` y DENY de DEC-0007 (`:39`); datos no se eliminan automáticamente (`:40`); extensiones con autorización y auditoría (`:43`); «No se realizan cobros ni conversiones automáticas» (`:44`); Trial automático solo por «decisión específica de HDC» (`:48`). **Estado: DECIDED, sin implementar** (FR-0010.md:59; `plan-catalog.md:197` «el alta asistida asigna `plan_piloto_1` sin vencimiento (CF-16 frente a DEC-0018)»). Relacionados: DEC-0039 (alta asistida: el administrador de MainSpot «asigna Trial», `.md:15`), DEC-0007 (DENY sin plan; «Por lo menos debe tener creada una cuenta Trial», `.md:15,28`).
- **DEC-0005** (cuota atómica por tenant, sin TOCTOU, `.md:15`), **DEC-0006** (diferir `agents`, `.md:15`), **DEC-0017** (orden de remediación; TOCTOU primero porque «el consumo y la reserva de cuotas deben ser atómicos, seguros ante concurrencia e idempotentes por tenant. Constituye una base reutilizable para S1», `.md:38`; `agents` diferido `:44`). Vigentes y compatibles con SRC-005.
- **BR-0007** (0.6.0): consentimiento de respuestas automáticas «opt-in por origen y categoría, texto de consentimiento literal, versión, límite por hora y revocación» (`:31`); campañas «sin gasto sin autorización explícita específica» (`:33`); planes y roles (`:56-64`), panel del negocio en solo lectura (`:69`).
- **FR-0010** (0.6.0): límite en el punto de creación, «lote atómico para reseñas», exceso ⇒ 403 `limit_exceeded`, sin plan ⇒ 403 `subscription_required`, facturación PROHIBITED sin precio (`:14`); catálogo versionado (`:16-24`); suscripción fijada (`:26-31`); semántica de cuota: seis acumuladas, periódico sin activar hasta HDC-MSP-06, sin parámetros nuevos, bajar un límite no borra nada (`:33-39`); AC-10006 «las seis capacidades son acumuladas y ninguna es periódica» (`:50`); AC-10008 sin precio ni cobro (`:52`).
- **FR-0018** (0.6.0): Administration con alta/suspensión/reactivación de negocios con motivo (`:20`); asignación y migración exclusivas de `platform_admin` con step-up, motivo e historial; el negocio no cambia su plan (`:25-31`; AC-18004…18007).
- **FR-0019** (0.6.0): sección Planes `/ingenieria#/planes`, permisos, «Sin aprobación comercial», sin precio ni cobro (`:42-54`; AC-19007…19011).
- **Reseñas / reputación / engagement**: FR-0008 (0.1.0) ingesta idempotente, umbral configurable (default <4), escalado, respuesta con preview + aprobación; ocultar/borrar bloqueado (`:13`); FR-0016 (0.3.0) Jev clasifica; caso simple con consentimiento ⇒ respuesta **generada y enviada automáticamente**; caso negativo/sensible ⇒ **tres propuestas** + aviso panel/Telegram + decisión humana; **un solo ledger de respuesta** por reseña (`:19-24`); BR-0003 (0.1.0) «Toda respuesta o publicación pública … requiere preview + aprobación humana; no existe auto-publicación visible» (`:13`) — **contradicción preexistente con FR-0016:19-20**, también señalada como abierta en `origin/fix/engagement-rating-gate:docs/handoffs/e2e-parallel-2026-10-29/DECISION-LOG.md` (commit `9e8d42f`: «La reconciliación de `DEC-011`/`BR-0003` … sigue abierta»; ese registro «no es HDC/DEC»). Casos de uso de respuesta IA: `engagement.google.review.reply`, `engagement.facebook.comment.reply` (FR-0012.md:40; `src/ai/catalog.ts:51-52`). Upstream: DEC-011 (sin auto-publicación visible, `DOC@571a4d2:07…:26`), DEC-023 (umbral `<4`, `:38`).
- **Estados de suscripción**: ningún ítem canónico enumera estados. Código: `status IN ('active','suspended','cancelled')` (`migrations/0009_subscriptions_plans.sql:34`; `src/plans/policy.ts:19`); solo `active` actúa (`src/plans/policy.ts:102`; `plan-catalog.md:85`); reactivar conserva la revisión (`UPDATE` solo del estado, `plan-catalog.md:114`). DEC-0018 exige `EXPIRED` (inexistente en el esquema). No hay estado de gracia/impago.
- **Pago/facturación**: BR-0006 «No existen precios reales ni procesador de pagos en el piloto; facturar sin precio es PROHIBITED» (`:13`); upstream DEC-024 (catálogo sin precios, interfaz abstracta de pago + adaptador simulado, `DOC@571a4d2:07…:39`); código `src/subscriptions/payment.ts:1-8,33` («SimulatedPaymentProvider siempre responde ok y NO hace llamadas externas»; `stripe` TENTATIVA); `src/shared/config.ts:23,296` (`PAYMENT_PROVIDER` por defecto `simulated`).
- **Retención**: DEC-0021 contenido conversacional 90 días; DEC-0022 auditoría 2 años; DEC-0023 agregados 2 años; **DEC-0024 «Baja de un negocio: anonimizar a los 30 días»** (`.md:15`); DEC-0025 borrado automático diario con informe auditado; DEC-0026 respaldos diarios cifrados 14 días; **DEC-0027** «A los 30 días de confirmarse la baja … eliminar sus datos personales, mensajes originales, credenciales, documentos…» (`.md:31`), «El vencimiento del Trial no constituye una baja. La operación requiere baja confirmada, posibilidad de exportación previa y ejecución auditada» (`:41`), «no autoriza ejecutar anonimización destructiva antes de implementar y validar los mecanismos» (`:47`); FR-0011 export ETL, retención configurable (default 90 días) (`:13`); OPS-0001 «exportación y baja incluyen `brand_fact`, `media_asset`, `ai_invocation`…» (`:58-59`). **No existe ninguna retención de 60 días** en canon ni decisiones (`grep "60 d[ií]as|60 days"` sin resultados).
- **Notificaciones**: FR-0016 «aviso en panel/Telegram» (`:21`); DEC-0041 bot único con vinculación de un solo uso; BR-0001 canales ≠ identidad (`:13`). Correo: no hay canon para avisos a clientes; existe un módulo de correo para recuperación de contraseña, deshabilitado por defecto y que «Nunca se simula una entrega» (`src/mail/config.ts:5-7`; `src/mail/mailer.ts:6-7`). DEC-0055/DEC-0064 rechazaron SMTP para **alertas de infraestructura del propietario** (otro ámbito, no conflicto).

---

## 4. Mapeo SRC-005 C01–C14 contra el canon

Leyenda: **NUEVO** = obligación sin antecedente; **CONFIRMA**; **RESUELVE** = cierra una cuestión abierta; **MODIFICA** = cambia texto canónico vigente; **CONFLICTO** = contradice una decisión registrada (cita doble); **TENSIÓN** = compatibilidad dependiente de interpretación.

| C | SRC-005 (línea) | Canon/decisiones afectadas | Relación | ¿Resuelve abierto? | Queda abierto |
|---|---|---|---|---|---|
| C01 | `:21` Recepción/sync y respuesta manual no gastan cuota de respuestas IA; cada respuesta generada con IA = 1 unidad mensual; agotar IA no detiene recepción ni manual (incl. Telegram) | FR-0010:14,33-37,50 (seis acumuladas; «no añade parámetros nuevos»; AC-10006); FR-0016:19-24; FR-0008:13; BR-0007:31; DEC-0075 P4/P6; FR-0012:40 | NUEVO (unidad «respuesta IA», periódica) + MODIFICA FR-0010 (AC-10006, parámetro nuevo) y FR-0016 (conteo). **No hay conflicto literal con `reviews_managed`** (§4.2) | OD-13/OD-15 (parcial), HDC-MSP-06 «cuotas por feature» (parcial) | Unidad exacta: ¿tres propuestas = 1 o 3?; editar una propuesta IA ¿es manual?; regenerar; fallo o incertidumbre ⇒ liberar. Alcance: ¿comentarios de Facebook? Valores por plan (C03). Posible consumo de `conversations` por respuestas manuales vía Telegram [INFERENCE: `src/conversation/pipeline.ts:92` consume `conversations`; verificar en F0 de código] |
| C02 | `:22` cuotas del plan independientes del giro | FR-0010:14,16-24; `plan-catalog.md:85` (suscripción → revisión fijada → valor); `plan-catalog.md:52` (campos de cada definición: clave, capacidad, categoría, unidad, tipo, semántica, periodo, rango, techo… sin dimensión de giro); DEC-0011 (sin vertical) | CONFIRMA el modelo actual (ningún parámetro por giro en `src/plans/registry.ts:67-113`; ausencia [INFERENCE] a confirmar en F0 de código) | — | Overrides por negocio (HDC-MSP-06) no deben depender del giro |
| C03 | `:23` número de planes no fijado (A, A+B o con complementos); sin nombres, precios ni cantidades aprobados | DEC-0010:15,35-42; FR-0010:20-22 («Sin aprobación comercial»); BR-0005:13; Q-004 upstream `:50` | CONFIRMA Q-004 abierta; refina la dirección no canónica A/B/C/Personalizado | No (Q-004 sigue OPEN) | Todo lo comercial |
| C04 | `:24` renovación mensual, no acumulable; vigencia ligada a suscripción activa/pagada | DEC-0010:46; FR-0010:33-37,50; `plan-catalog.md:14,91,95`; BR-0006:13; `src/plans/policy.ts:102` | RESUELVE (no-rollover, renovación mensual) + MODIFICA FR-0010 (activar periodicidad). **TENSIÓN de alcance**: «cuotas incluidas en un plan» frente a las seis acumuladas (FR-0010:33-34, AC-10006; DEC-0075 P4). SRC-005:57-58 prohíbe reinterpretarlas ⇒ lectura mínima: solo cuotas mensuales nuevas. **TENSIÓN** «pagada» vs BR-0006 | OD-01 (parcial); HDC-MSP-06 ciclo/rollover | Zona horaria (el mecanismo usa UTC); qué cuotas son mensuales |
| C05 | `:25` sin excedentes ni cargos automáticos; bloquear solo la operación IA; avisar con antelación y ofrecer opciones reales; 80/100 % solo ejemplo | FR-0010:14; `plan-catalog.md:97-98`; NFR-0006:15-19, AC-6001; BR-0005; BR-0006 | RESUELVE HDC-MSP-06 «excedentes»; CONFIRMA bloqueo selectivo; NUEVO aviso anticipado | HDC-MSP-06 excedentes | Umbrales, canal y contenido de avisos; hoy no hay ofertas comerciales publicadas [INFERENCE] |
| C06 | `:26` ciclo individual anclado a la activación efectiva; renovar al renovarse el periodo | FR-0010:35; `plan-catalog.md:95` (ancla = `subscription.started_at`; cambiar de plan no mueve el ancla); DEC-0018:35; DEC-0075 json:6 («la forma del mecanismo periódico no los fija») | RESUELVE HDC-MSP-06 ciclo; coincide con el mecanismo implementado | HDC-MSP-06 ciclo | «Activación efectiva» vs `started_at` (alta, no pago); ancla en reactivación (`plan-catalog.md:114`) [INFERENCE] |
| C07 | `:27` upgrade inmediato tras cobro; downgrade al siguiente ciclo; conservar consumo | DEC-0010:46; FR-0010:37-39; FR-0018:25-31, AC-18004 (asignación inmediata); DEC-0075 P5; `plan-catalog.md:95,97`; BR-0006 | RESUELVE HDC-MSP-06 «cambios de plan» (OD-12); MODIFICA FR-0018 (downgrade diferido). **TENSIÓN** «tras confirmar el cobro» vs BR-0006; **conflicto potencial** si implica autoservicio del cliente (DEC-0075 P5 «Retirarla») | HDC-MSP-06 cambios de plan | Quién inicia; qué confirma el «cobro» en el piloto |
| C08 | `:28` prorrateo de precio y de capacidad incremental; fórmula, redondeo, límites y reembolsos abiertos | BR-0006:13; FR-0010:14, AC-10008; Q-004 | NUEVO principio; precio prorrateado imposible sin precios ⇒ **BLOCKED**; capacidad prorrateada sin fórmula ⇒ **BLOCKED** (G-PLAN) | Parcial (principio) | Fórmula, redondeo, topes, reembolsos |
| C09 | `:29` impago: 7 días naturales; sitio, panel, reseñas y manual disponibles; IA de costo variable suspendida y sin cuotas nuevas; aviso y actualización de pago; reintento solo autorizado; después suspensión | FR-0010:14; `plan-catalog.md:85`; `src/plans/policy.ts:19,102` (solo `active` actúa); FR-0018:20; BR-0006; `payment.ts:5` (simulado siempre ok); DEC-0029 (Jev sin presupuesto ⇒ clasificador determinista) | NUEVO estado de gracia con capacidades parciales ⇒ MODIFICA FR-0010 (gate binario actual) | — | Proveedor de pago (no hay real); el simulado no puede fallar; canales de aviso |
| C10 | `:30` tras gracia: despublicar; conservar 60 días; avisos por plataforma, correo y Telegram; no apropiarse de dominios | FR-0007:13; DEC-0042 (MainSpot sirve el sitio; versiones conservadas); DEC-0004 / DEC-019 (subdominio MainSpot); DEC-0024/0027; DEC-0021/0026; FR-0016:21; DEC-0041; `src/mail/config.ts:5-7` | NUEVO; **TENSIÓN** con DEC-0024/0027: el 60.º día no tiene destino decidido; si la suspensión acaba en baja, rigen los 30 días de anonimización | — | Acción al vencer 60 días; correo sin transporte (BLOCKED_EXTERNAL por defecto); entrega no verificada |
| C11 | `:31` cancelación sin fricción al final del periodo pagado; devoluciones según ley | BR-0006; FR-0018:20,30-31 (panel del negocio en solo lectura); DEC-0075 P5; BR-0005 / RULE-005 upstream | NUEVO; **TENSIÓN** de actor («sin fricciones» puede implicar autoservicio) | — | Actor y canal de cancelación |
| C12 | `:32` tras cancelación: 60 días de retención, reactivación, correo/Telegram, exportación **e importación**, borrado anticipado legal | DEC-0024:15 «Anonimizar a los 30 días»; DEC-0027:31,41,47; FR-0011:13; FR-0004:13; OPS-0001:58-59; DEC-0026 | NUEVO + **CONFLICTO** candidato con DEC-0024/0027 si «cancelación» = «baja» (30 vs 60 días); exportación coherente con DEC-0027:41; importación NUEVA | — | Formatos, alcance, ejecución; plazos legales; respaldos 14 días |
| C13 | `:33` reactivación sin penalización; nuevo periodo al pagar si no hay periodo activo; sin doble cobro; sin reinicio indebido de cuotas | FR-0018:20; `plan-catalog.md:114,95`; DEC-0005 | NUEVO; posible divergencia con la implementación (`started_at` no se mueve al reactivar) [INFERENCE] | — | Reglas de ancla al reactivar |
| C14 | `:34` demo/trial gratuito limitado, sin tarjeta ni cargos, IA limitada, sin publicación real ni servicios recurrentes antes de contratar; duración, volumen y antiabuso no fijados | DEC-0018:33-44,48; DEC-0039:15; DEC-0007; FR-0010:59; `plan-catalog.md:39` (`plan_piloto_1`: website 1, social_posts 10, social_ads 5…), `:197`; DEC-0042; DEC-0075 P6 | **CONFLICTO** con DEC-0018:36 (mismas funcionalidades que `plan_piloto_1`, que incluye publicación real); **TENSIÓN** duración (DEC-0018:35 «30 días» propuesta vs «no fijada»); CONSISTENTE sin cobros (DEC-0018:44) y consumo contado (`:37-38`) | OD-11: no (solo «sin tarjeta») | Duración, límites, antiabuso, `EXPIRED`, extensiones |

### 4.2 C01 frente a `reviews_managed`

- **Definición canónica = recepción/ingesta**: FR-0010.md:14 «el límite se verifica en el punto de creación (lote atómico para reseñas)»; FR-0008.md:13 «Las reseñas se ingieren de forma idempotente…»; FR-0010.md:33 (DEC-0075) «Las seis capacidades conservan su semántica acumulada (cuentan los recursos del negocio sin reinicio periódico)».
- **Arquitectura y código**: `plan-catalog.md:59` `quota.reviews_managed.max | acumulada | … | sync (lote atómico)`; `src/plans/registry.ts:95-98` «Reseñas gestionadas … Reseñas que MainSpot puede ingerir y gestionar. Cuenta todas las reseñas ingeridas durante toda la suscripción; cada sincronización consume el lote completo o nada.» (`semantics: 'cumulative'`); `src/reputation/engine.ts:239-258` (bloqueo de cuota, `consumeInTx` con `units: fresh`, 403 `limit_exceeded` si el lote no cabe). Puntos de consumo con capacidad literal: `website`, `conversations`, `reviews_managed` (`grep "capability: '…'"`); **no existe unidad de respuestas IA**.
- **Un techo de respuestas es otro parámetro, no seleccionado**: DEC-0075 P6 incluía «Techo de autorrespuestas» y no se eligió (`SRC-0013:34-36`; `DEC-0075.json:42`; `plan-catalog.md:190`).
- **Conclusión**: no hay conflicto literal. C01 añade una unidad distinta; SRC-005:57 prohíbe renombrar o reinterpretar `reviews_managed`, y el HANDOFF:27 coincide. Tensiones: (a) agotar `reviews_managed` sigue bloqueando la recepción por su propio tope acumulado (20 en `plan_piloto_1`, `plan-catalog.md:39`), lo que choca con la intención comercial si se lee como «recepción ilimitada» (PATCH:15 la limita «a efectos de cuota de IA»); decidirlo corresponde al propietario (G-SEM). (b) La clasificación Jev en la recepción es IA de costo variable pero no «respuesta»; en la gracia de C09 caería al clasificador determinista (DEC-0029). (c) Añadir el parámetro nuevo con «ausente ⇒ deny» (`plan-catalog.md:65`; FR-0010:29-31) bloquearía las respuestas IA de todos los negocios fijados a la revisión 1 hasta publicar una revisión con valor confirmado y migrar (§7, R7).

### 4.3 Cobertura de HDC-MSP-06 por SRC-005

| Tema (DEC-0010:46; HDC_QUEUE:18; P0:119) | SRC-005 | Estado tras SRC-005 |
|---|---|---|
| Ciclo/semántica mensual | C04, C06 | Decidido (semántica); zona horaria sin fijar |
| Rollover | C04 «no se acumulan» | Decidido (sin rollover) |
| Excedentes/sobreconsumo | C05 | Decidido (no por defecto); F06 recargas prepagadas opt-in como futuro condicional |
| Cambios de plan | C07, C08 | Parcial: reglas decididas; fórmula de prorrateo abierta |
| Cuotas por feature | C01 (respuestas IA a reseñas) | Parcial: otras operaciones IA (publicaciones, web, asistente) sin decidir |
| Cuotas por modelo | — | Abierto |
| Cuotas numéricas | C03 «sin cantidades aprobadas» | Abierto |
| Presupuestos / prepago presupuestario | F06 (futuro) | Abierto (NFR-0006 sin cambio) |
| Scopes por tenant / overrides / prioridad | C02 (no por giro) | Abierto |
| A/B/C/Personalizado sin precios | C03 | Abierto (Q-004) |
| Medición y reservas | C01 + AC03 del handoff | Mecanismo existente reutilizable (DEC-0005/0017) |

Canal: DEC-0010:46 dice «mediante HDC-MSP-06», y el 2026-11-04 el propietario mantuvo el mecanismo sin activar «hasta HDC-MSP-06» (DEC-0075 P4). Para que DEC-0076 cierre la parte semántica sin sesión HDC, la directiva del propietario debe ordenar el registro (P1, §2.2). `START-PROMPT.md:14-16` («Consolidar en el canon aplicable los acuerdos comerciales aprobados…») y `:69` («No solicitar al propietario decisiones ya aprobadas en SRC-005») apuntan a ello **si el propietario lo envió literalmente en la sesión OMP** [INFERENCE: solo el agente principal ve su prompt]. Sin esa orden, la vía es QS-0018 (HDC normal).

### 4.4 Q-004

Sigue **OPEN**: C03 reafirma que nombres, precios y cantidades no están aprobados; DEC-0075 P2 («Sin aprobación comercial») y DEC-0010 siguen vigentes.

### 4.5 F01–F08 (fuera del cierre)

`SRC-005.md:39-46`: F05 (voz por Telegram) «DECIDED — FUTURO MANDATORIO» para la siguiente ronda; F06 (recargas prepagadas opt-in con tope) «DECIDED — FUTURO CONDICIONAL»; F01/F02/F03/F04 diferidos; F07 PROPOSED; F08 AGREED_CONCEPTUAL. No crean obligaciones de canon en este ciclo; conviene listarlos en «Qué no decide» de DEC-0076 para que no se pierdan (`/tmp/msp-commercial/FUTURE.md:5-21`).

### 4.6 Conflictos que exigen arbitraje humano (cita doble)

1. **C14 ↔ DEC-0018**. DEC-0018.md:36 «Límites y funcionalidades: **los mismos que `plan_piloto_1`**» y `:35` «Vigencia inicial propuesta: 30 días naturales» frente a SRC-005.md:34 «sin publicación real ni servicios recurrentes activados antes de contratar. Duración, volumen y mecanismos antiabuso no están fijados.» El PATCH pide «Reconciliar sin sobreescribir sus decisiones vigentes» (`PATCH.md:41`).
2. **C10/C12 ↔ DEC-0024/DEC-0027**. DEC-0024.md:15 «Anonimizar a los 30 días»; DEC-0027.md:31 «A los 30 días de confirmarse la baja de un negocio, eliminar…» frente a SRC-005.md:32 «60 días de retención de configuración y contenido, reactivación posible…» y `:30` («se conservan durante 60 días»). Hay que decidir si cancelación o suspensión equivalen a «baja» y qué ocurre el día 60.
3. **Ambigüedades G-SEM** (confirmar, no decidir por inferencia): alcance de C04 frente a AC-10006/DEC-0075 P4 (la lectura mínima la ampara SRC-005.md:57-58); actor de C07/C11 frente a DEC-0075 P5; «pagada/cobro» (C04/C07/C09/C11/C13) frente a BR-0006:13; unidad de C01 (tres propuestas, edición, comentarios de Facebook); destino de `reviews_managed`.
4. **Preexistente, no creado por SRC-005**: BR-0003:13 frente a FR-0016:19-20 (auto-respuesta).

Base del arbitraje: resolver un `CONFLICTED` es exclusivo del humano (`KEY@5e3dc307:method/09-human-approval-model.md:12-14`); `method/22` §4 (REVIEW_CANDIDATE) exige QS para conflictos con registros de nivel 1. Esto no reabre lo ya decidido en SRC-005 (START-PROMPT:69): son bloqueos materiales concretos (START-PROMPT:70).

---

## 5. Procedencia (G-SOURCE) y propuesta de registro

### 5.1 Cómo lo resolvieron SRC-0011/0012/0013

- Texto **literal de primera mano** recibido en la propia sesión OMP del agente («Origen: mensaje explícito del propietario … en esta conversación»; SRC-0013 separa el texto del agente de la selección del propietario y omite con motivo una pregunta ajena al producto).
- Sello de registro («Registro: <UTC>»); fingerprint `sha256` del archivo SRC en el registro de fuentes, repetido en el `comment` del DEC y en su `.md`; `reliability: authoritative`.
- Salvedades explícitas en `notes`/`comment`: «sin inventar QS/ANS», «no se inventa una sesión», «La fecha es la del registro …, no un timestamp aportado por el propietario», «Créditos declarados …, no verificados», «Es un registro de decisión, no una aprobación (APR)».
- No existe campo `raw_verified` en el esquema de la plataforma.

### 5.2 La brecha de SRC-005

Front matter `SRC-005.md:2-9`: `source_type: user_supplied_srt_conversation`, `epistemic_role: evidence_of_reported_human_decisions`, `status: NORMALIZED_EXTRACT`, `original_media_attached_to_repo: false`, `raw_audio_verified: false`; `:14` «no es la transcripción íntegra, no acredita una grabación original ni contiene hash verificable de audio … Antes de promoción canónica, reconciliar con la fuente original». El registro documental no da hash ni autor (`/tmp/msp-commercial/source-register.yaml:21-25`), contra su propio loop (`DOC@…:docs/loops/01-canonical-documentation-loop.md:36` «Registrar la fuente con SRC-xxx, autor, fecha, hash…»). Por tanto es de segunda mano (extracto de ChatGPT), no literal y sin original verificable; el método se detiene ante «A source that cannot be fingerprinted or attributed» (`KEY@5e3dc307:method/02-functional-canon-loop.md:40`). El extracto sí se puede fijar por huella (`sha256 535c0edec4a9778ff1dbaac4a854de70b20f87fcd8546033ac74570d4006540c`; blob `eaae4b3e…911f`; añadido en `f5f49b1`, registrado en `2de11a2`, 9 285 bytes) y atribuir como «decisiones reportadas del propietario».

### 5.3 Propuesta exacta (sin inventar aprobaciones)

IDs verificados libres: **SRC-0014** y **SRC-0015** (máximo SRC-0013 en 21 refs y 6 worktrees sin cambios en `.canonflow`), **DEC-0076** (`counters.dec` = 75; máximo DEC-0075 en todas las refs). Alias obligatorio en título y notas: «SRC-005 del repositorio documental», para no confundirlo con **SRC-0005** de la plataforma (log de decisiones upstream, `source-register.yaml:39-47`).

1. **SRC-0014 = copia byte a byte del extracto** en `.canonflow/sources/SRC-0014-commercial-voice-decisions-2026-11-05.md`, con fingerprint `sha256:535c0ede…540c` idéntico al blob documental. No se añade cabecera al archivo: la cabecera de los precedentes era para textos literales propios y aquí rompería la identidad de hash con la evidencia upstream. Entrada en el registro:
   ```yaml
   - id: SRC-0014
     title: Extracto normalizado de decisiones comerciales del propietario (sesión de voz 2026-11-05; SRC-005 del repositorio documental)
     kind: document
     location: .canonflow/sources/SRC-0014-commercial-voice-decisions-2026-11-05.md
     fingerprint: sha256:535c0edec4a9778ff1dbaac4a854de70b20f87fcd8546033ac74570d4006540c
     reliability: unverified
     registered_at: '2026-11-05'
     notes: >-
       Copia byte a byte de hachxaan/mainspot-documentation@docs/commercial-governance-20261105
       (commit f5f49b1, registrado en 2de11a2), sources/normalized/SRC-005-…md. Extracto de ChatGPT a partir
       de SRT suministrados por el propietario; no literal; raw_audio_verified: false; sin hash de audio/SRT
       (G-SOURCE abierto). Estados DECIDED según el extracto, no según una transcripción verificada.
   ```
   `unverified` es el valor del enum que describe fielmente un original no verificado; `informative` es la alternativa si se prefiere marcarlo como contexto.
2. **SRC-0015 = directiva literal del propietario**, solo si existe en la sesión OMP del agente principal (p. ej., el texto de arranque pegado por el propietario u otra orden explícita de consolidar SRC-005). Se registra con el formato exacto de SRC-0011/0012: cabecera «Origen: mensaje explícito del propietario Carlos Pinacho en esta conversación», «Registro: <UTC>», «## Instrucción literal» íntegra; `kind: document`, `reliability: authoritative`, sha256 del archivo. Si coincide byte a byte con `START-PROMPT.md`, citar en notas su blob `2d2a6851…` y sha256 `1660e1e8…91b4`; si no coincide, solo lo recibido en la sesión. Es el disparador P1 (§2.2).
3. **DEC-0076** (`schema_version: 2`, sin `source_ref`): `source` «SRC-0015 — directiva explícita del propietario en conversación OMP que adopta las decisiones del extracto SRC-0014»; `artifact_ref` apuntando a SRC-0015 y SRC-0014 (o la primera, con la segunda en `comment`); `decision` con C01–C14 literales y los resultados de §4.6 **solo en la medida en que el propietario los resuelva**; `options_rejected: []` (el extracto no enumera opciones rechazadas; no inventarlas); `affected_items` según §6.3 más DEC-0010, DEC-0018, DEC-0024/0027, DEC-0075 e INC-0006; `comment` con «no literal; G-SOURCE abierto; no se inventa sesión; fecha = registro; no es APR; no certifica producción». Enlaces `DERIVES_FROM` a SRC-0014 y SRC-0015.
4. **Alternativas**: (a) si no hay directiva literal, pedir una **confirmación única de procedencia** («¿C01–C14 de SRC-005 reflejan tus decisiones?»), que cierra G-SOURCE en su parte humana sin redecidir nada, o publicar **QS-0018** por la vía HDC normal (P3); (b) cierre completo de G-SOURCE: registrar los SRT originales como fuente `kind: interview` con sha256, como SRC-0001; el PATCH dice que esto no bloquea la preparación local (`PATCH.md:52`).
5. **No hacer**: crear APR/RSK/QS/ANS que el propietario no emitió; marcar el extracto `authoritative`; poner `SUPERSEDES` sobre DEC-0018 o DEC-0024 sin arbitraje; reutilizar los IDs STG-COM-xx o AC01…AC11 como canónicos (`PATCH.md:14`; `HANDOFF.md:39-49`).

---

## 6. IDs libres, convenciones y versión

### 6.1 Siguientes IDs (comprobados en 21 refs y 6 worktrees)

| Tipo | Último en línea principal (evidencia) | Uso en otras ramas | Siguiente recomendado |
|---|---|---|---|
| SRC | SRC-0013 (`source-register.yaml:117`) | — | **SRC-0014** (+SRC-0015) |
| DEC | DEC-0075 (`index.json:248`) | ≤ DEC-0065 en f01/research/landing | **DEC-0076** |
| APR | APR-0003 (`apr: 3`) | — | APR-0004 (no previsto) |
| RSK | ninguno (`rsk: 0`) | — | RSK-0001 (solo si el propietario acepta un riesgo) |
| QS/ANS | QS-0017/ANS-0017 | — | QS-0018/ANS-0018 (solo vía HDC; ANS-N = QS-N evita el fallo del validador) |
| FR | FR-0019 | `feat/f01-telegram-acknowledged-alerts` usa FR-0012…0015 con otro significado (staging) | **FR-0020** (libre en todas) |
| BR | BR-0007 | f01 usa **BR-0008** («El respaldo nunca espera al acuse», staging F01-FUN-0.2.0) | BR-0008 libre en la línea principal; **BR-0009** libre globalmente |
| NFR | NFR-0008 | f01 usa NFR-0006/0007 con otro significado | **NFR-0009** (ver colisión de AC) |
| Técnico | API-0004, ARC-0001, DAT-0001, OPS-0001, SEC-0001 | f01: API-0005…0009, ADR-0001…0004, TR-0001…0007 | DAT-0002/ARC-0002/OPS-0002/SEC-0002 libres globalmente; API-0010/ADR-0005/TR-0008 libres globalmente |
| INC | INC-0008 (`implementation-state.yaml:39-40`) | f01 usa INC-0008 (alertas F-01) | **INC-0009**, o nota de evolución de INC-0006 (precedente DEC-0075) |
| RUN | RUN-0023 | f01 RUN-0017…0019 (otro contenido); landing RUN-0020 | RUN-0024 (P1 no lo usa) |
| HDC | HDC-0009 (`.canonflow-updates/README.md:35-43`) | — | HDC-0010 (solo si aplica §2.10) |

`git grep` de `SRC-0014|DEC-0076|APR-0004|QS-0018|FR-0020|NFR-0009|INC-0009|HDC-0010|RUN-0024` en todas las refs: sin uso (solo un ejemplo de INC-0009 en una skill-card del framework). `BR-0008`: solo en f01.

### 6.2 Convención de AC

- Baseline: `AC-90NN` por FR-00NN (AC-9001…AC-9011).
- Ítems AI Core y deltas: `AC-<número del ítem><secuencia de 3 dígitos>` (FR-0010 → AC-10001…10008; FR-0016 → AC-16001…16003; FR-0018 → AC-18001…18007; FR-0019 → AC-19001…19011; NFR-0006 → AC-6001…6003; NFR-0007 → AC-7001…7003). f01 usa además `AC-9121…9172`.
- Siguientes: FR-0010 → **AC-10009**; FR-0016 → **AC-16004**; FR-0018 → **AC-18008**; FR-0019 → AC-19012; FR-0008 → AC-8001 (estilo nuevo, como FR-0010 respecto de AC-9010); FR-0020 → AC-20001.
- **Colisiones del patrón**: NFR-0009 daría AC-9001, ya usado por FR-0001; BR-0008 (AC-8001) chocaría con un delta de FR-0008. Los IDs deben ser únicos en el proyecto (`KEY@5e3dc307:method/07-traceability-model.md:20`): comprobar con `grep` antes de asignar y preferir ACs en ítems existentes.
- Los AC01…AC11 del handoff (`HANDOFF.md:39-49`) son temporales y ya hay AC01/AC08 locales en `plan-catalog.md:35,98` con otro significado: mapearlos a IDs canónicos en F1.

### 6.3 Versión de canon y elementos que cambian

- **Delta funcional 0.7.0** (último 0.6.0). El proyecto numera cada delta como MINOR (0.4.0, 0.5.0, 0.6.0), incluso cuando sustituye (DEC-0074 sobre DEC-0073); la versión global del estado e índice queda en 0.1.0 (precedente). `method/08` llamaría MAJOR a contradecir obligaciones aprobadas, pero en 0.x y con el precedente, 0.7.0 es coherente [INFERENCE].
- **Ítems mínimos para el delta local** (C01, C04–C07): **FR-0010** (unidad mensual de respuestas IA, activación de la periodicidad solo para ella, no-rollover, sin excedentes, ancla, cambios de plan, reformulación de AC-10006) y **FR-0016** (conteo: generada = 1 unidad, manual gratuita, el agotamiento no detiene recepción ni manual).
- **Probables**: FR-0018 (downgrade diferido; suspensión por impago, cancelación y reactivación como funciones de Administration), BR-0006 (cómo leer «pagada/cobro» en un piloto sin cobro) y FR-0008 (recepción y respuesta manual no consumen cuota IA).
- **Condicionales**: FR-0007 (despublicación reversible; Trial sin publicación real), FR-0011/OPS-0001 (exportación/importación), un ítem nuevo para el ciclo de vida comercial de la suscripción (BR-0009 o BR-0008) y uno de avisos (FR-0020).
- **Técnico**: no cambia en DEC-0075 y no tiene ítem para el modelo de planes y suscripciones (DAT-0001 es el modelo del AI Core). Si F1 lo requiere, DAT-0002 con delta **0.7.0** alineado con la decisión (0.6.0 fue solo funcional), declarando el salto en `technical/CHANGELOG.md` [recomendación].

---

## 7. Riesgos y límites

- **R1. Procedencia**: SRC-005 no es literal ni verificable contra el original; sin directiva literal o confirmación, cualquier DEC sería atribución inferida (§5).
- **R2. Autoridad frágil**: la baseline aprobada solo existe en una rama local sin remoto; `method-state.yaml:13` apunta a una **ruta del árbol de trabajo** (si alguien hace checkout de la rama comercial, el puntero resuelve al esqueleto 0.0.0). La huella SRC-0004 detectaría la deriva. Los enlaces del README a `mainspot-documentation/blob/main/implementation/increments/INC-001…` apuntan a archivos inexistentes en `main` (solo están en `571a4d2`) [INFERENCE por `git diff --name-status origin/main 571a4d2`].
- **R3. Espacios de IDs confundibles**: SRC-005 (documental) frente a SRC-0005 (plataforma); DEC-018 (aislamiento lógico, upstream) frente a DEC-0018 (Trial); DEC-024 (infraestructura sin precios) frente a DEC-0024 (anonimización a 30 días); STG-COM-xx y AC01…AC11 temporales.
- **R4. Colisiones entre ramas**: la rama sin integrar `feat/f01-telegram-acknowledged-alerts` reutiliza FR-0012…0015, BR-0007/BR-0008, NFR-0006/0007, INC-0008, RUN-0017…0019 y API-0005…0009 con otro contenido (staging «F01-FUN-0.2.0», pendiente de G-FUN). Usar BR-0008 o API-0005 en la línea principal amplía la colisión.
- **R5. Conflictos sin arbitrar** (§4.6): C14/DEC-0018, C10-C12/DEC-0024-0027 y las ambigüedades G-SEM.
- **R6. Canal de HDC-MSP-06**: DEC-0010 exigía una sesión HDC y DEC-0075 la reafirmó el día anterior; sustituirla por SRC+DEC requiere la orden del propietario.
- **R7. Fail-closed del parámetro nuevo**: un parámetro ausente en la revisión fijada deniega (`plan-catalog.md:65`; FR-0010:29-31). Introducir la cuota de respuestas IA bloquea esas respuestas en todos los negocios hasta que un operador (`plans.publish` y `subscriptions.assign`, con step-up) publique una revisión con valor confirmado y migre suscripciones. El valor es comercial y no está aprobado (C03; SRC-005.md:60 «No configurar arbitrariamente»): el agente no debe elegirlo.
- **R8. Deriva de método preexistente**: el delta se edita en el propio ítem en lugar de usar staging (`method/08` «never edited in place»); `derived_from_functional_version: 0.1.0` nunca se actualizó; `blocking_open` lista QS-0001/0002 ya ARCHIVED (`functional-canon-state.yaml:6-8`) y `method-state.yaml:3-5` describe un foco obsoleto. Los precedentes no lo tocaron.
- **R9. DEC-0040** (diseño del panel aprobado en HDC antes de construir) puede aplicar a la UI nueva del propietario (avisos, gracia, cancelación, exportación/importación); OD-25 sigue abierta (`docs/research/plan-parameters-inventory.md:658`).
- **R10. Pago simulado**: `SimulatedPaymentProvider` siempre responde ok (`payment.ts:5,33`), así que no puede representar el impago de C09 sin ampliar la simulación; nunca afirmar cobros reales.
- **R11. Correo/Telegram**: el correo está deshabilitado por defecto y nunca simula entregas; la entrega real de Telegram no está verificada (reglas del perfil). AC09 debe informar «entrega no verificada».
- **R12. Validadores**: `validate_traceability.py` arrastra 5 fallos preexistentes; según V5, `check_gates.py --gate G-TRACE` no sirve como verificador en este layout (no lo ejecuté).
- **Límites de este diagnóstico**: no revisé el estado vivo de los PR #13/#14, la ejecución del código ni las pruebas (fuera del alcance de reconciliación canónica). Las citas de código son lecturas puntuales. No leí secretos.

---

## 8. Bloqueos

Ninguno para este diagnóstico. Pendientes del propietario o del agente principal: (1) confirmar si su prompt de sesión contiene la directiva literal de consolidar SRC-005 (disparador P1 y SRC-0015); (2) arbitrar los conflictos de §4.6; (3) opcionalmente aportar los SRT originales para cerrar G-SOURCE.

---

## Apéndice A — Comandos ejecutados y salidas clave (solo lectura)

```text
git -C WT log --oneline -n 30                      → HEAD 83619f0 … (PR #14 f68746b, PR #13 b1cd3df en la historia)
git -C WT status --short | wc -l                    → 0
git log --all --diff-filter=A -- SRC-0011/12/13, DEC-0073/74/75 → 1f1c7da, 95f9436, e67a7e5
git show --stat e67a7e5                             → 16 files changed, 533 insertions(+), 13 deletions(-)
sha256(index.json@e67a7e5^) = 0b169ce2…1430 ; sha256(index.json@e67a7e5) = 9c4b8caa…20c9da (7294 bytes)
sha256sum SRC-0011/12/13                            → b4b6563a…, 883591ed…, 4fb1bd54… (= source-register)
DOC: sha256(571a4d2:00-INDEX.md)=47cb39af… ; sha256(571a4d2:07-DECISIONS…)=8565b3df… (= SRC-0004/0005)
DOC canonical-state: main/plan/commercial = INITIALIZED 0.0.0 ; 571a4d2 = CANONICAL_BASE_APPROVED_v0.1 0.1.0
DOC wc -l 07-DECISIONS: commercial=1, baseline=107
DOC git grep HDC-MSP → solo origin/plan/mvp-real-ai-native-20261020 (HDC_QUEUE:13-20, P0:116-122, handoffs) y PATCH:41
IDs en 21 refs: máximo SRC-0013, DEC-0075, APR-0003; counters {qs:17, ans:17, dec:75, apr:3, rsk:0}
validate_schemas_v2.py → VALID: DEC-0075.json, DEC-0074.json, source-register.yaml, decision-state/index.json, links.yaml
validate_traceability.py → RESULT: FAIL — 5/99 (links 62, 68, 73, 79, 83; preexistentes)
grep "60 d[ií]as|60 days" en .canonflow y plan-catalog.md → sin resultados
```
