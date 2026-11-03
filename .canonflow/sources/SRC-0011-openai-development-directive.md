# SRC-0011 — Directiva del propietario: OpenAI generativo en desarrollo

Origen: mensaje explícito del propietario Carlos Pinacho en esta conversación.
Registro: 2026-11-03T08:06:53.691164Z. No procede de un nuevo QS/ANS ni altera sus respuestas históricas.

## Instrucción literal

Continúa el desarrollo de MainSpot en `feat/canonflow-implementation`.

**Nueva decisión explícita del propietario:** sustituir Anthropic por OpenAI como proveedor de todas las capacidades generativas de MainSpot, manteniendo TypeSafe/Jev como clasificador semántico primario.

Alcance:

1. Configurar OpenAI directo para diseño y edición web, redacción de publicaciones, respuestas a clientes, asistente, campañas, análisis de negocio y demás capacidades generativas de texto.
2. Mantener OpenAI para generación de imágenes.
3. Mantener TypeSafe/Jev para clasificación semántica, intención, sentimiento y riesgo.
4. Utilizar el Model Registry y Dispatcher existentes. Evitar acoplamientos entre lógica de negocio y proveedor.
5. Seleccionar modelos OpenAI apropiados por capacidad, verificando previamente su disponibilidad real en la API, compatibilidad con esquemas, herramientas, calidad y costo.
6. Crear y evaluar las rutas correspondientes. Activarlas únicamente cuando cumplan los criterios de aceptación existentes.
7. Conservar el adaptador Anthropic como alternativa técnica disponible, pero sin rutas activas ni fallback automático.
8. Mantener OpenRouter deshabilitado.
9. Registrar trazablemente esta nueva decisión del propietario y actualizar el canon y la configuración correspondiente, respetando el historial de QS-0017.
10. Mantener los presupuestos y controles vigentes. No ampliar gastos ni activar rutas generativas sin una evaluación satisfactoria.

**Importante:** el modelo GPT 6.1 Sol utilizado actualmente por OMP para desarrollar no implica que esa misma denominación o acceso esté disponible en la API productiva. Selecciona modelos mediante el catálogo autenticado de la API de MainSpot.

Si continúa el bloqueo de saldo/cuota de OpenAI API, completa todo lo que pueda verificarse localmente, deja preparadas las evaluaciones reales y continúa con otras tareas aprobadas. No presentes mocks como E2E generativo satisfactorio.

No reconstruyas el AI Core. Esta transición debe utilizar la arquitectura existente de selección de proveedores y modelos.

La investigación comercial de proveedores continúa de forma independiente en su propia rama. Esta decisión es la configuración de desarrollo actual, no una selección comercial irreversible para producción.

**Avanza autónomamente y reporta únicamente bloqueos materiales.**
