# Mandato de autonomía E2E — autorización expresa del propietario

**Fecha:** 2026-10-29. **Alcance:** solo DESARROLLO MainSpot, incluyendo diseño, backend, frontend, migraciones, pruebas y entornos de integración. **No producción.**

El propietario autorizó explícitamente a **SOL MAIN (agente local)** y **Claude Design** a terminar su trabajo E2E en paralelo sin pedir aprobaciones intermedias, aun cuando el método de desarrollo local entrase normalmente en un gate de CanonFlow.

## Regla operativa vinculante para esta tanda

1. **NO crear, publicar, responder, ingerir ni esperar HDC/QS/ANS/DEC** para decisiones de ingeniería, UX, implementación o pruebas de este desarrollo. No solicitar confirmación paso a paso.
2. Elegir la **solución más simple y probada** compatible con el negocio, el contrato compartido y las fronteras de seguridad; decidir, implementar, probar, corregir y hacer commit/push. No refactorizar extensamente lo que ya funciona; evitar infraestructura y frameworks adicionales.
3. Si una decisión de desarrollo cambia cómo se materializa un DEC previo, **no borrar ni reescribir el DEC**. Anotar en `DECISION-LOG.md` el alcance de la delegación actual, elección/justificación, pruebas y cualquier reconciliación canónica pendiente para una futura fase productiva; **continuar desarrollando**.
4. La aprobación previa de diseño indicada en `DEC-0040` **no bloquea el desarrollo en paralelo en este ciclo**. Se podrá revisar el diseño final al concluir, sin interrumpir la construcción y prueba E2E ahora; conservar el registro histórico de DEC-0040.
5. En `INC-004/DEC-011` hoy se exige aprobación humana para responder públicamente. **Se autoriza en desarrollo** añadir un modo automático mediante política del propietario del negocio habilitada de manera explícita para categorías seguras, con registro de dicha delegación. Si no hay política aplicable o hay riesgo, responder **solo tras decisión del cliente**. Esto **no autoriza** nuevas publicaciones reales en cuentas Google/Meta ni inventa consentimiento de clientes.
6. Desarrollo autónomo de agentes **no significa** que el agente de atención del negocio tenga autoridad ilimitada. Son dos fronteras diferentes: *dueño del proyecto* delega las decisiones de implementación; *dueño del micronegocio* elige sus políticas de atención y aprueba excepciones.

## Límites que siguen vigentes

- Mantener aislamiento tenant, RBAC, idempotencia, auditoría, protección de datos, controles básicos de seguridad, políticas de proveedores y prohibición de ocultar/manipular reseñas.
- No introducir datos/credenciales reales en Git ni realizar gastos, cambios irreversibles o acciones de producción.
- No tocar respaldos, Garage/KVM 4, Gate 7 ni `QS-0015`. No anunciar un despliegue de desarrollo como producción.
- Google/Meta reales: si no existe conexión validada, credenciales o permisos del proveedor, completar **automáticamente en simulación**, documentar la dependencia externa y seguir. No pedir HDC para desbloquearla.
- Si surge un paso externo materialmente riesgoso no autorizado, **no ejecutarlo**: completar todos los demás casos y registrarlo al entregar. No se detiene todo el trabajo.

## Registro de decisiones sin fricción

`DECISION-LOG.md`: solo decisiones técnicas relevantes, una entrada breve con problema, decisión, razón, test/evidencia y límites. No recrear un sistema de gobernanza dentro de este handoff.

Esta autorización es para **completar** un flujo E2E implementado y validado en desarrollo, no para producir otra ronda de documentos ni para modificar los registros históricos.
