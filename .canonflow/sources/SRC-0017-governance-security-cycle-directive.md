# SRC-0017 — Directiva del propietario: siguiente ciclo local de gobernanza y seguridad (resolución comercial confirmada, SEC-CONSENT-01 y SEC-TG-APPROVAL-01)

Origen: mensaje explícito del propietario Carlos Pinacho en esta conversación OMP (2026-11-05, hora local), con el que
abre la sesión. Enumera con sus propias palabras las decisiones comerciales confirmadas (sección 2) y ordena
formalizarlas mediante CanonFlow en una nueva decisión canónica trazable que conserve los registros históricos y
documente expresamente las modificaciones de precedencia; ordena además implementar SEC-CONSENT-01 y
SEC-TG-APPROVAL-01 (sección 3).
Registro: 2026-11-06T00:56:36Z (UTC; 2026-11-05 en la hora local de la sesión). No procede de un nuevo QS/ANS ni
altera sus respuestas históricas.
Contexto que la directiva manda leer (rama `docs/owner-commercial-resolution-20261105`, PR #17, `b809510`):
`docs/handoffs/commercial-policy-2026-11-05/OWNER-RESOLUTION.md` (sha256
`eabce6b3e12ac51f12c636e87584a206673d36dff872c0c8a52e0764a6baf89d`) y `NEXT-LOCAL-ROUND.md` (sha256
`0889dd84fe7e3eddda2b4a21e24c36233ae57d5d9840b1c2e7df3cd4733f5b6c`). Detalle de la confirmación: SRC-006 del
repositorio documental, registrado aquí como SRC-0016 (la expresión literal del propietario en aquella conversación
fue «Adelante»; el resto de SRC-0016 es resumen contextual).
La transcripción conserva el texto recibido, incluidos los dos espacios finales de las tres primeras líneas de
metadatos.

## Instrucción literal

# MAINSPOT — Siguiente ciclo local: gobernanza y seguridad

**Modelo:** Claude Opus 5.5  
**Esfuerzo:** MAX  
**Repositorio:** `hachxaan/mainspot-platform`  
**Punto de partida:** PR #17 → #16 → #15 → #14 → #13

## Objetivo

Ejecutar el siguiente incremento local de MainSpot, formalizando las decisiones comerciales confirmadas por el propietario y cerrando las salvaguardas técnicas pendientes.

No reabrir decisiones comerciales aprobadas. No rehacer implementaciones ya verificadas sin una justificación técnica.

## 1. Recuperación del contexto

Leer íntegramente:

- `.omp/AGENTS.md` y las reglas locales vigentes.
- PR #17, rama `docs/owner-commercial-resolution-20261105`.
- `docs/handoffs/commercial-policy-2026-11-05/OWNER-RESOLUTION.md`.
- `docs/handoffs/commercial-policy-2026-11-05/NEXT-LOCAL-ROUND.md`.
- PR #16, rama `feat/commercial-quota-semantics-20261105`.
- `docs/architecture/commercial-quota.md`.
- `evidence/commercial-quota/`.
- SRC-006 y su resolución en staging en `hachxaan/mainspot-documentation`, rama `docs/commercial-governance-20261105`.
- DEC-0076, DEC-0018, DEC-0024 y DEC-0027.

Verificar el HEAD real y la relación entre los PR antes de modificar archivos.

## 2. Gobernanza canónica

Formalizar mediante CanonFlow las decisiones confirmadas:

- Recepción de reseñas sin límite comercial.
- Generación de respuestas con IA bajo demanda.
- Cuota mensual compartida entre respuestas automáticas con IA y propuestas solicitadas.
- Exclusión de comentarios Facebook de esta cuota específica, sin eliminar controles de costo.
- Laboratorio excluido de cuotas comerciales, con permisos y presupuestos.
- Separación de demostración pública gratuita y trial administrativo.
- Conservación recuperable de 60 días tras finalización efectiva del servicio o suspensión, con las excepciones legales correspondientes.

Crear una nueva decisión canónica trazable, conservando los registros históricos y documentando expresamente las modificaciones de precedencia.

Validar esquemas, trazabilidad y criterios de aceptación.

## 3. Salvaguardas técnicas obligatorias

**SEC-CONSENT-01 — Consentimiento**

Implementar consentimiento informado y versionado para clientes existentes cuyas respuestas automáticas consumirán la nueva cuota.

Sin aceptación verificable, no permitir que la automatización consuma unidades mediante IA.

**SEC-TG-APPROVAL-01 — Integridad de aprobación**

Garantizar que `/aprobar N` en Telegram únicamente publique el contenido que el usuario realmente vio.

Si el borrador cambió después del aviso, invalidar la aprobación antigua y solicitar nueva confirmación.

Probar ediciones concurrentes, mensajes antiguos, reintentos y aislamiento entre negocios.

## 4. Verificación

Realizar:

- Typecheck y pruebas unitarias.
- Integración con PostgreSQL desechable.
- Pruebas de concurrencia e idempotencia.
- Smoke y E2E por `https://app.mainspot.local.io`.
- Revisión independiente adversarial con Claude Opus 5.5, esfuerzo máximo.
- Validación de que Facebook y el laboratorio conservan límites técnicos de consumo.

Conservar evidencia reproducible. Distinguir pruebas simuladas de integraciones reales.

## 5. Límites

No modificar producción, bases reales, proveedores de pago, DNS ni infraestructura sin autorización específica.

No inventar cuotas, precios, fórmulas de prorrateo, proveedores ni umbrales comerciales.

No fusionar los PR existentes ni firmar gates humanos.

La funcionalidad de mensajes de voz por Telegram continúa como requisito obligatorio de la siguiente ronda de producto, pero queda fuera de este incremento.

## 6. Entregables

Dejar commits y un PR revisable con:

- Nueva decisión canónica.
- Implementación de ambas salvaguardas.
- Pruebas y evidencia.
- Matriz requisito → código → prueba → gate.
- Riesgos residuales.
- Dictamen separado para entorno local y producción.

**Ejecuta autónomamente el ciclo completo dentro del alcance autorizado. Solo solicita decisiones cuando exista un bloqueo material que no pueda resolverse con las decisiones ya registradas.**
