
# Resolución del propietario — revisión de DEC-0076 / PR #16

**Fecha:** 2026-11-05. **Estado:** confirmado conversacionalmente, pendiente de promoción formal a canon mediante nueva DEC validada. No es aprobación de despliegue.

**Fuente:** [SRC-006](https://github.com/hachxaan/mainspot-documentation/blob/docs/commercial-governance-20261105/sources/normalized/SRC-006-owner-confirmation-2026-11-05.md), que registra la respuesta literal «Adelante» del propietario a la propuesta inmediatamente anterior. [Resolución contextual en staging](https://github.com/hachxaan/mainspot-documentation/blob/docs/commercial-governance-20261105/docs/staging/RESOLUTION-2026-11-05-commercial-sem-trial-retention.md).

## G-SEM — cinco interpretaciones confirmadas

1. **Recepción:** reseñas de Google sin límite comercial de recepción; no consumir cuota IA por sincronizar ni por responder manualmente. Conservar permisos, aislamiento, paginación, costos y protección ante abuso. reviews_managed puede mantenerse para métricas, sin impedir recepción.
2. **IA a petición:** la reseña que espera decisión no recibe automáticamente propuesta IA. El usuario la pide expresamente, se descuenta una unidad por caso generado y se guarda aparte de las tres alternativas numeradas del aviso de Telegram.
3. **Cuota compartida:** las respuestas automáticas autorizadas que usan IA consumen de la misma bolsa mensual que las propuestas IA solicitadas. Pueden agotar el saldo; debe informarse y consentirse. Sin saldo: comportamiento seguro sin IA según reglas y consentimiento.
4. **Facebook:** sus comentarios NO consumen esta cuota específica de respuestas IA a reseñas Google en el MVP. Esto NO autoriza IA gratuita o ilimitada: verificar presupuesto técnico, permisos y futura política por canal.
5. **Laboratorio:** excluido de cuotas comerciales, con grants/roles, presupuestos técnicos y trazabilidad; nunca inferencia ilimitada.

## Arbitrajes humanos frente a decisiones anteriores

**Trial (C14 vs DEC-0018):** separar una demostración pública sin tarjeta, publicación real ni cargos automáticos, del plan trial ADMINISTRATIVO de DEC-0018 (asignación manual y prestaciones de piloto supervisado). No modificar retrospectivamente trial administrativo ni convertirlo en autoservicio. Duración y volumen de demo pública siguen abiertos.

**Retención (C10/C12 vs DEC-0024/DEC-0027):** 60 días de recuperación de contenido/configuración desde el fin efectivo del servicio tras cancelación o desde la suspensión efectiva tras impago y gracia. Pasado el plazo, eliminación/anonimización verificable según clase de datos, salvo conservación legal justificada. Enmienda acotada al anterior plazo general de 30 días para estos estados; requiere nueva decisión formal con precedencia, análisis de datos, proveedores y backups. No ejecutar borrado irreversible ni extender plazos sin revisión legal. Mantener eliminación anticipada cuando proceda, importación/exportación y protección entre tenants.

## Salvaguardas obligatorias previas a producción

**SEC-CONSENT-01 — reconsentimiento.** Usuarios con reglas automáticas autorizadas antes de la nueva contabilidad deben recibir y aceptar explícitamente la nueva condición ANTES de que estas reglas gasten unidades. Versionar y auditar consentimiento. Sin aceptación, denegar gasto IA automático y usar una alternativa segura solo donde también esté autorizada.

**SEC-TG-APPROVAL-01 — texto exacto aprobado.** El comando de Telegram /aprobar N debe corresponder al texto realmente mostrado. Vincular la aprobación a versión/huella inmutable o fallar de forma segura y volver a notificar/confirmar si cambió. Probar edición posterior del borrador, carrera entre editores y replay. La separación de ai_draft en PR #16 no resuelve por sí sola los cambios posteriores a las tres alternativas.

## Estado y exclusiones

Los acuerdos anteriores NO fijan cuotas, nombres comerciales, precios, proveedor de pagos, fórmula prorrateo, umbrales, límites demo ni cobros. No habilitan migraciones reales, despliegue ni firmas G-MIG/G-SEC. PR #16 continúa en borrador local. Voz Telegram permanece mandatoria para la próxima ronda de producto, fuera de este incremento. No modificar DEC-0018/0024/0027 históricos; crear resolución formal posterior trazable.
