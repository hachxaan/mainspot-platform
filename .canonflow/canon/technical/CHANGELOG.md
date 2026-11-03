# Technical Canon changelog

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
