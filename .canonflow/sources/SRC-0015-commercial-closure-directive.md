# SRC-0015 — Directiva del propietario: cierre técnico local de las decisiones comerciales del 2026-11-05

Origen: mensaje explícito del propietario Carlos Pinacho en esta conversación OMP (2026-11-05), con el que abre la
sesión. Ordena ejecutar el cierre técnico local de las decisiones comerciales aprobadas el 2026-11-05 sin reabrirlas,
con la reconciliación canónica de `START-PROMPT.md` («Consolidar en el canon aplicable los acuerdos comerciales
aprobados»), y fija la prioridad de la semántica de cuotas (punto 5).
Registro: 2026-11-05T14:27:20Z. No procede de un nuevo QS/ANS ni altera sus respuestas históricas.
Especificación operativa que la directiva adopta (rama `docs/commercial-handoff-20261105`, PR #15, `83619f0`):
`docs/handoffs/commercial-policy-2026-11-05/START-PROMPT.md` (sha256
`1660e1e88304cfd0d3268bfa87a3e1e03b508a0b89b80ffb945be014432b91b4`) y `HANDOFF.md` (sha256
`0eafd1b88a5a9c238af209cacc72957e138ff71eed9fa227b515b61e4d443e90`). Fuente de las decisiones: extracto normalizado
SRC-005 del repositorio documental, registrado aquí como SRC-0014 (no literal; G-SOURCE abierto).
La transcripción conserva el texto recibido, incluido el guion suave (U+00AD) de «Reconcíli­alos».

## Instrucción literal

Inicia una nueva sesión de ingeniería para MainSpot.

**Modelo:** Claude Opus 5.5, o el modelo insignia más capaz disponible.  
**Esfuerzo:** máximo (`xhigh` / `max`, según soporte).  
**Restricción:** no utilizar Fable ni modelos económicos o inferiores para agentes, subagentes o revisiones.

**Objetivo:** ejecutar el cierre técnico local derivado de las decisiones comerciales aprobadas el 5 de noviembre de 2026, sin reabrir decisiones ya resueltas ni modificar producción.

1. Recupera el handoff y el prompt completo desde la rama `docs/commercial-handoff-20261105` del repositorio `hachxaan/mainspot-platform`:

   `docs/handoffs/commercial-policy-2026-11-05/HANDOFF.md`

   `docs/handoffs/commercial-policy-2026-11-05/START-PROMPT.md`

2. Recupera la fuente de decisiones `SRC-005`, el patch comercial y el backlog futuro desde la rama `docs/commercial-governance-20261105` de `hachxaan/mainspot-documentation`.

3. Consulta las reglas locales de OMP, el estado real de los PR #13, #14 y #15, y la documentación de CanonFlow. Reconcíli­alos sin sobrescribir trabajo existente.

4. Ejecuta el proceso completo definido en `START-PROMPT.md`: diagnóstico, reconciliación canónica, implementación mínima autorizada, pruebas, revisión independiente y cierre con evidencias.

5. Prioriza la corrección de la semántica de cuotas: recibir reseñas y responder manualmente no consume cuota de IA; cada respuesta generada con IA consume una unidad del periodo correspondiente.

6. Conserva los requisitos futuros, especialmente los mensajes de voz por Telegram, sin mezclarlos con este incremento.

Trabaja de forma autónoma dentro del alcance autorizado. No inventes precios, cuotas, fórmulas ni aprobaciones. No ejecutes migraciones en bases reales, cobros, despliegues ni cambios de producción.

Entrega commits, PR, pruebas reproducibles, riesgos pendientes y dictamen separado de preparación local y producción.

**Comienza leyendo íntegramente `START-PROMPT.md` y `HANDOFF.md`; estos documentos son la especificación operativa de esta sesión.**
