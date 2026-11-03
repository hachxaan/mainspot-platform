# Technical Canon changelog

## 0.5.0 — 2026-11-03
- ARC-0001, DAT-0001 y OPS-0001 cambian por DEC-0074/SRC-0012 (sustituye solo la asignación generativa de
  desarrollo de DEC-0073): adaptador `anthropic` (Messages) para todo texto/razonamiento con candidatas DRAFT
  `claude-haiku-5-5`/`claude-sonnet-5-5` sembradas por `ensureAiCatalog`; `openai` solo Images `gpt-image-2`;
  modelos de texto OpenAI deshabilitados y rutas RETIRED (migración 0030); TypeSafe primario; sin fallback.
- Migración aditiva 0031: `ai_lab_grant` + `ai_lab_grant_route` (allowlist inmutable), `ai_manual_review`
  (inmutable, separado de `ai_eval_run`), `ai_route_revision.tested_manual_review_id`, `ai_job.lab_grant_id`,
  `ai_invocation.lab_grant_id`/`output_sha256` y `assignment='manual_lab'`. El despachador, el worker y el replay
  revalidan el grant; DRAFT nunca por simple pin; error `lab_grant_invalid` sin fallback.
- Despliegue: `APPROVED` sigue siendo estado global; una ruta con evidencia solo manual únicamente se despliega
  (canary/activa) en `lab`; producción exige suite PASS. Fuera de `lab` toda petición con grant se rechaza.
  Presupuestos sin cambio; SEC-0001 y el resto del canon no cambian.

## 0.4.0 — 2026-11-03
- Solo ARC-0001 y OPS-0001 cambian por DEC-0073/SRC-0011: OpenAI Responses `store:false` e Images
  para toda generación de DESARROLLO; TypeSafe semántico primario. Anthropic conserva adaptador/catálogo
  sin rutas activas/canary ni fallback; OpenRouter deshabilitado, historial intacto.
- Luna (`gpt-6-luna`) eficiente y Sol (`gpt-6.1-sol`) complejo son candidatas API-descubiertas, no
  generación/calidad probadas. DRAFT hasta suites reales PASS. Sin cambio de presupuestos ni
  decisión comercial irreversible de producción. DAT-0001, SEC-0001 y el resto del canon no cambian.

## 0.3.0 — 2026-11-03
- ARC-0001, DAT-0001, SEC-0001 y OPS-0001 pasan a DECIDED por APR-0003. ARC-0001: adaptadores directos `anthropic` y
  `openai`, OpenRouter retirado (DEC-0069). DAT-0001: `ai_provider.real_data` con base y fecha de verificación,
  acción `retire` en el historial de rollout (migración 0028). OPS-0001: credenciales directas, datos reales por
  proveedor verificado (DEC-0067, DEC-0071) y techo acumulado (DEC-0068).
- Verificación del corte: deadline de adaptadores incluye el cuerpo HTTP; saldo Anthropic 400 y cuota OpenAI
  429 se clasifican sin revelar el cuerpo. Gastos inciertos conservan reserva. La retención diaria aplica
  los 90 días de DAT-0001/OPS-0001 a salida y validación de trazas sin borrar costos; replay purgado fail-closed.

## 0.2.0-proposed — 2026-10-30
- AI Core: ARC-0001, DAT-0001, SEC-0001 y OPS-0001 (PROPOSED), derivados del canon funcional 0.2.0-proposed.
