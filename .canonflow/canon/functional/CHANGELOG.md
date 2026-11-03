# Functional Canon changelog

## 0.5.0 — 2026-11-03
- FR-0012, FR-0019, NFR-0006 y BR-0007 cambian por DEC-0074 (directiva humana externa SRC-0012, no nueva
  respuesta HDC; sustituye solo la asignación generativa de desarrollo de DEC-0073, que se conserva como historia):
  Anthropic directo para texto/razonamiento, OpenAI directo solo imágenes, Jev primario; ambos adaptadores sin
  fallback; OpenRouter deshabilitado. No decide proveedor comercial de producción.
- Ejecución de rutas DRAFT solo en laboratorio con grant explícito (emisor con step-up, tenant+usuario, allowlist
  de rutas, caducidad, revocación, auditoría, presupuestos vigentes). Aceptación manual del propietario con
  evidencia real por invocación y checklist marca DRAFT→TESTED en un registro propio, distinto de la suite;
  aprobar y activar siguen separados; producción exige suite PASS. El agente no ejecuta pruebas generativas.
- Se conservan byte a byte QS/ANS-0017, DEC-0066..0073, SRC-0011 y el artefacto aprobado. Presupuestos,
  permisos y gates no se relajan; créditos declarados por el propietario no se registran como verificados.

## 0.4.0 — 2026-11-03
- Solo BR-0007 cambia por DEC-0073 (directiva humana externa SRC-0011, no nueva respuesta HDC):
  OpenAI directo para todo texto/imágenes en DESARROLLO, Jev primario; Anthropic técnico no operativo
  sin rutas activas/canary ni fallback; OpenRouter deshabilitado. No decide proveedor comercial de producción.
- Se conservan byte a byte los registros QS/ANS-0017, DEC-0066..0072 y el artefacto aprobado.
  Los restantes items mantienen su versión; presupuestos, permisos y gates no se relajan.

## 0.3.0 — 2026-11-03
- AI Core aprobado: FR-0012..FR-0019, NFR-0006..NFR-0008 y BR-0007 pasan a DECIDED por APR-0003 (QS-0017/ANS-0017;
  canon 0.2.0 ligado por sha256 en el artefacto aprobado). Se incorporan las decisiones de la misma sesión sin
  alterar registros previos: DEC-0066 (Jev primario en todo texto; FR-0012 AC-12001), DEC-0067 (datos reales hacia
  TypeSafe tras verificar la cobertura una vez; sustituye a DEC-0019; FR-0012 AC-12002, BR-0007), DEC-0071 (mismas
  condiciones para Anthropic y OpenAI; BR-0007), DEC-0069 (solo proveedores directos, OpenRouter retirado; BR-0007),
  DEC-0068 (USD 25 acumulado incluido el historial; procedencia del costo; NFR-0006).

## 0.2.0-proposed — 2026-10-30
- AI Core (issue #9): FR-0012..FR-0019, NFR-0006..NFR-0008 y BR-0007 en estado PROPOSED. Fuente: definición
  del propietario en issue #9 y handoff `docs/handoffs/mainspot-ai-core-2026-10-30/`. Aprobación pedida en QS-0016.
  No modifica ítems DECIDED/INFERRED previos ni registros de decisión.
