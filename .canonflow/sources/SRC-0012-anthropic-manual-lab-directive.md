# SRC-0012 — Directiva del propietario: Anthropic texto, OpenAI imágenes, pruebas manuales en runtime

Origen: mensaje explícito del propietario Carlos Pinacho en esta conversación.
Registro: 2026-11-03T09:16:52Z. No procede de un nuevo QS/ANS ni altera sus respuestas históricas.
Sustituye, solo para la configuración actual de desarrollo, la asignación generativa de SRC-0011/DEC-0073;
QS-0017, ANS-0017, DEC-0066…0073 y SRC-0011 se conservan íntegros.

## Instrucción literal

Continúa el desarrollo de MainSpot en `feat/canonflow-implementation`.

**Nueva instrucción del propietario:**

Configura el AI Core con la siguiente distribución:

- **TypeSafe/Jev:** clasificador semántico primario.
- **Anthropic API directa:** todas las capacidades generativas de texto y razonamiento (diseño y edición web, publicaciones, respuestas, asistente, campañas, análisis, etc.).
- **OpenAI API directa:** generación de imágenes para web y redes sociales.

Anthropic dispone de USD 100 en créditos promocionales API y OpenAI ya tiene créditos cargados. No ampliar los presupuestos internos autorizados.

### Prioridad 1 — Cambiar proveedores

Reutiliza los adaptadores, Registry, Dispatcher, prompts y rutas existentes.

Desactiva las rutas generativas de texto OpenAI y configura las correspondientes rutas Anthropic. Conserva OpenAI para imágenes.

Mantén ambos adaptadores disponibles, sin fallbacks automáticos ni OpenRouter operativo.

Registra la nueva decisión con trazabilidad, preservando QS-0017 y DEC-0073.

### Prioridad 2 — Pruebas manuales en runtime

**No ejecutes evaluaciones generativas pagadas, suites de calidad ni llamadas API de prueba.**

Yo realizaré personalmente las pruebas de las funcionalidades de MainSpot desde su interfaz.

Permite ejecutar rutas generativas DRAFT en el entorno de laboratorio mediante un mecanismo explícito, restringido a usuarios autorizados, auditable y sujeto a presupuestos.

No actives rutas DRAFT para tráfico normal, no simules evaluaciones aprobadas y no eludas controles de autorización.

Establece un procedimiento de aceptación manual para que pueda revisar resultados reales y aprobar posteriormente las rutas, con evidencia y trazabilidad.

### Prioridad 3 — Validaciones técnicas sin gasto

Ejecuta typecheck, unitarias e integración local sin llamadas externas pagadas, únicamente cuando sean necesarias para verificar los cambios.

No repitas los 50 casos de evaluación ni otras baterías generativas.

Conserva los mecanismos de seguridad, aislamiento, idempotencia, control de costos y gobernanza existentes.

### Entrega

Deja MainSpot listo para que yo pueda probar desde el navegador:

- Diseño y edición de páginas web.
- Generación de imágenes.
- Publicaciones de Facebook.
- Respuestas y asistente.
- Campañas y demás capacidades aprobadas.

Publica los cambios en tu rama y proporciona la URL, instrucciones mínimas de uso y cualquier bloqueo técnico concreto.

**Avanza autónomamente. No ejecutes pruebas de calidad con proveedores reales: esa validación la realizará el propietario en runtime.**
