
# Handoff siguiente ronda local — gobernanza y seguridad de PR #16

**Entrada:** OWNER-RESOLUTION.md (en esta carpeta); SRC-006 y la resolución en staging del repositorio documental; PR #16; DEC-0076; DEC-0018; DEC-0024; DEC-0027; reglas .omp/AGENTS.md. Antes de tocar código, comprobar el HEAD actual, el estado de PR #13–#16 y la documentación canónica más reciente.

## Paquete A — promoción canónica sin falsificar autoridad
- Incorporar SRC-006 como fuente humana contextual, sin inventar sesiones HDC ni timestamp exacto.
- Formalizar la nueva resolución en una DEC posterior mediante el procedimiento CanonFlow, con precedencia clara trial público vs administrativo, y 30→60 días de retención solo en los estados comerciales cubiertos.
- Modificar FR/AC afectados, estado, índices y trazabilidad. Validar esquemas y separar errores preexistentes de nuevos; no editar decisiones históricas para ocultar el conflicto.
- Coordinar registro en repositorio documental sin asumir que staging es canon.

## Paquete B — requisitos de seguridad antes de producción
- **SEC-CONSENT-01:** reconsentimiento informado/versionado de clientes con reglas automáticas heredadas antes de cobrarles cuota IA; sin él, no consumir. Probar tanto las rutas negativas como las positivas y la auditoría.
- **SEC-TG-APPROVAL-01:** vincular /aprobar N al texto/versión visto en Telegram. Caso adversarial: enviar tres opciones, editar la primera desde panel, usar mensaje antiguo /aprobar 1: debe rechazarse o requerir nueva confirmación, nunca publicar el texto modificado. Probar concurrente y replay.
- Confirmar que el laboratorio y Facebook conservan grants, límites técnicos de costo y aislamiento pese a no consumir esta cuota comercial. Si no está garantizado, bloquear habilitación pública de esos caminos y reportarlo.
- Ejecutar TypeScript, unitarias, integración PostgreSQL desechable, smoke y E2E local TLS; revisión independiente, con evidencia de rutas/commits/tests. Proveedores simulados NO acreditan entrega real.

## Paquete C — fuera de este cierre
- Demo pública como flujo distinto del trial administrativo: contrato, antiabuso, límites y aceptación por definir sin inventar cifras.
- Retención 60 días: solo especificación y validación técnica/legal antes de tareas irreversibles. Importación/exportación y respaldos requieren incremento propio.
- Precios, números de cuota por plan, proveedor de pago, prorrateo doble y umbrales/canales siguen OPEN; no bloquear por ellos los requisitos independientes.
- Voz por Telegram sigue obligatoria para siguiente ronda de producto; no desarrollarla por inercia en esta ronda.

## Entregables y límites
Matriz DEC/FR/AC → código → prueba → evidencia → gate, PR revisable, riesgos residuales, GO/NO-GO local y de producción por separado. No desplegar, no migrar BD real, no cobrar, no firmar gates humanos. No reabrir decisiones ya confirmadas.
