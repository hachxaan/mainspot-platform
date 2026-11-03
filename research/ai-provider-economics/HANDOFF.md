# HANDOFF — MainSpot AI Core: investigación de proveedores, modelos y economía unitaria

Fecha de inicio: 2026-11-03
Repositorio: hachxaan/mainspot-platform
Rama de trabajo exclusiva: research/ai-provider-economics-2026-11
Commit de partida: 73271a29d777cd010e8833b92e25360fddecc4f0
Responsable: segundo agente OMP de investigación, separado de SOL MAIN.
Naturaleza: investigación y propuesta; NO implementación, NO activación de proveedores, NO cambio de decisiones aprobadas.

## 1. Objetivo real

Determinar, con evidencia comprobable, qué proveedores, cuentas API y modelos convienen para operar el MainSpot AI Core en producción **por caso de uso**. Medir calidad, costo de tareas exitosas, latencia, fiabilidad, integración, privacidad y sostenibilidad económica del negocio. Conectar los costos de IA con el precio de suscripción y el margen por cliente; no optimizar solo precio/token.

El producto atiende microempresas y pymes: páginas web, presencia digital, publicaciones y atención de redes sociales, reputación, campañas, asistente del propietario y funciones operativas. No presupongas que todos los casos requieren el mismo modelo. La comparación de proveedores no compromete por sí sola a MainSpot con ninguno.

## 2. Distinción crítica: desarrollo vs producto

OMP es el entorno del agente que escribe y prueba MainSpot. MainSpot AI Core debe invocar APIs de proveedores por sí mismo sin depender de OMP cuando opera el producto. Un modelo visible en OMP, cuota de conversación, suscripción o autenticación Codex **no prueba** disponibilidad de API productiva, ni cuota gratuita, ni derecho de reutilización en backend. Comprueba nombre, acceso, modalidad, facturación y condiciones aplicables para cada opción.

Como referencia inicial, el repositorio en el commit de partida implementa dispatcher, rutas, consolas, evaluaciones, presupuestos y conectores TypeSafe/Jev y OpenRouter. Las integraciones directas Anthropic/OpenAI corresponden a un trabajo paralelo de SOL MAIN y pueden no estar presentes en este snapshot. Los resultados del laboratorio no deben presentarse como producción.

## 3. Inventario obligatorio de CASOS DE USO

Estudiar separadamente cada actividad, incluso si comparten modelo o backend. Contrastar con los identificadores reales del catálogo src/ai/catalog.ts y clasificar capacidades faltantes como propuestas.

| Familia | Trabajo específico a medir | Factores particulares |
| --- | --- | --- |
| **Generación de imágenes** | Imágenes originales para páginas web, publicaciones y piezas de campaña | costo por imagen, resolución, calidad y consistencia, formatos, derechos/seguridad, almacenamiento y reintentos |
| **Edición/adaptación visual** | Cambios a imágenes existentes, variaciones para canales y assets | capacidad real de edición, costo adicional, fidelidad a marca, preservación de elementos |
| **Diseño de páginas web** | Generar estructura/layout, copy y componentes permitidos del sitio de un negocio | precisión del esquema/DSL, originalidad, accesibilidad, calidad visual, tokens de salida, reparaciones |
| **Edición de páginas web** | Cambios simples (color, texto, horario) y complejos (secciones, estructura, contenido) solicitados en lenguaje natural | seguir exactamente instrucciones, no hacer cambios colaterales, costo y tasa de parche válido |
| **Publicaciones sociales** | Redactar posts de Facebook y futuras plataformas, variantes, títulos, CTA, hashtags y calendarios | tono natural, hechos reales, política de cada red, volumen mensual, revisiones |
| **Atención a clientes** | Redactar respuestas a comentarios y mensajes públicos, gestionar quejas, sugerir respuestas a reseñas | calidad/seguridad de respuesta, necesidad de intervención humana, costo por evento |
| **Clasificación semántica** | Jev: intención, sentimiento, categoría, urgencia, riesgos, alcance de ediciones, reseñas y comentarios | precisión/recall por clase, falsos negativos, riesgo, p95, costo por evento |
| **Asistente del negocio** | Conversaciones del propietario con herramientas de solo lectura sobre el negocio | calidad y grounding, tool calls, contexto, duración de conversación, costo por interacción |
| **Marketing y campañas** | Brief, propuestas de campaña, copys, creatividades y planificación sin gasto publicitario | generación de alternativas, calidad del plan, volumen y límites de autorización |
| **Análisis de negocio** | Resúmenes, insights, reportes y recomendaciones con datos verificables | prohibición de cifras inventadas, frecuencia, tamaño de contexto, costo por informe |
| **Orquestación/selección** | Enrutamiento por intención, elección granular de skills/capacidades y reparación de salidas inválidas | overhead, latencia, fallbacks, retries, costo adicional |

Para CADA fila: definir entrada representativa, salida esperada, métricas de calidad, modelos candidatos, tokens o unidades consumidas, p50/p95, costo unitario observado o estimado identificado como tal, número de ejecuciones por cliente/mes, cotas de uso, fallbacks, y resultado de negocio.

Separar **diseño de una página web** (modelos de texto/razonamiento/código o schema) de **generación de imágenes**. Separar **clasificar el comentario** (Jev) de **redactar su respuesta** (modelo generativo). No agrupar costos heterogéneos en una cifra opaca de 'una llamada de IA'.

## 4. Proveedores a investigar sin sesgo de confirmación

- TypeSafe/Jev directo para clasificación semántica, tal como está definido en desarrollo.
- Anthropic API directa para texto, redacción, razonamiento, diseño web, edición y demás tareas compatibles.
- OpenAI API directa para imágenes y, como candidato investigativo, tareas de texto cuando sea relevante.
- OpenRouter como alternativa de **estudio** para comparar precio, cobertura, latencia, confiabilidad, condiciones y posibles ventajas/desventajas respecto a los proveedores directos.
- Otros proveedores directos solo cuando un caso de uso y evidencia justifiquen añadirlos.

**Política vigente de desarrollo, distinta a la investigación:** QS-0017 respondió la preferencia TypeSafe/Jev directo, Anthropic directo para texto y OpenAI para imágenes, sin nuevas ejecuciones vía OpenRouter. No modificar rutas activas, presupuesto ni DEC/APR. Comparar OpenRouter en papel o con evidencia histórica **no autoriza usarlo**. Si el mejor resultado de la investigación contradice una política vigente, formular una propuesta trazable para decisión posterior; no reactivar automáticamente.

Verificar en fuentes primarias fechadas el nombre y disponibilidad API de cada modelo, incluyendo la designación 'gpt-image-2' usada en el encargo actual: no suponer que un nombre visible en OMP corresponde a un endpoint API productivo. Verificar precios y límites de tarifas/token, imagen, caché, batch, tool use, ventana de contexto, estructuras JSON, límites de concurrencia, retención, data usage y políticas empresariales.

## 5. Método y evidencia

1. Leer estado real del repositorio y documentación canónica sin alterar nada. Archivos clave: docs/architecture/ai-core.md; docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-RESULTS.md; docs/handoffs/mainspot-ai-core-2026-10-30/AI-CORE-CANON-PROPOSAL.md; src/ai/catalog.ts; src/ai/registry.ts; src/ai/dispatcher.ts; src/ai/providers/; src/jev/client.ts; evidence/ai-core/.
2. Validar fuentes oficiales actuales de precios, disponibilidad, contrato, seguridad y términos; registrar URL, fecha consultada, moneda, unidad facturada y restricciones. Diferenciar información pública de términos de un contrato privado NO revisado.
3. Reutilizar evaluaciones y trazas disponibles. Proponer un benchmark controlado por cada caso de uso con datos sintéticos, mismas entradas/rúbricas y criterios de fallo seguro. Reportar calidad, precisión, latencia, tasa de reparaciones, costo por éxito; evitar conclusiones de comparaciones no equivalentes.
4. Si pruebas reales requieren presupuesto o claves no comprobablemente autorizadas, dejarlas como plan y marcar NO MEDIDO. No disparar gasto, no leer/imprimir secretos, no usar datos personales ni cuentas reales de clientes.
5. Separar HECHO VERIFICADO / MEDICIÓN PROPIA / ESTIMACIÓN / HIPÓTESIS / DESCONOCIDO en cada conclusión relevante. Revisar datos históricos de OpenRouter sin ejecutar nuevas llamadas mediante ese proveedor.

## 6. Unit economics y pricing

Construir un modelo reproducible por cliente/mes, no solo costo por millón de tokens. Para cada capacidad calcular: frecuencia de uso × unidades facturadas por acción × tarifa del proveedor × factor de reintento/fallo/fallback. Incorporar costo de imágenes y variantes, ediciones repetidas, conversaciones con múltiples turnos y eventos de reputación de alto volumen.

Escenarios de uso BAJO, MEDIO, ALTO, y caso extremo/abuso. Usar MXN $500, $1,000 y al menos otro plan más alto como **ejemplos hipotéticos, no precios aprobados**. Estimar contribución y margen bruto con distinción de costos variables IA, infraestructura/almacenamiento/egress, integraciones de terceros, operaciones y soporte; tipo de cambio fechado y sensibilidad a tarifas, mix de uso, calidad, retries y volumen de imágenes. Calcular cuántas publicaciones, imágenes, rediseños y respuestas puede financiar cada plan de forma sostenible, con cuotas o uso extra cuando convenga.

Decidir por calidad/costo de trabajo correctamente realizado, no por costo nominal de entrada. Formular qué capacidad conviene modelar con modelo barato, cuál requiere modelo superior, y qué fallbacks son seguros. No ocultar costos o riesgos de operación y mantenimiento.

## 7. Entregables (solo en esta rama)

Guardar todos los resultados bajo research/ai-provider-economics/:

- 01-inventory.md — capacidades y estado técnico real con referencias a commit/archivo.
- 02-provider-comparison.md — modelos, cuentas, disponibilidad, precios, restricciones y fuentes oficiales fechadas.
- 03-quality-benchmarks.md — método, evidencia existente, mediciones vs propuestas y huecos de información.
- 04-unit-economics.md + 04-unit-economics.csv (o script reproducible equivalente) — fórmulas, escenarios y sensibilidad.
- 05-recommendation.md — selección recomendada **por caso de uso**, alternativas, tradeoffs, márgenes y condiciones de cambio.
- sources.md — trazabilidad a documentación primaria y fechas.
- README.md — índice ejecutivo y estado: RESULTADO VERIFICADO / PENDIENTE / NO MEDIDO.

Entregar una recomendación accionable, no un ranking superficial de modelos. Identificar únicamente decisiones nuevas que requieran propietario: por ejemplo habilitar otro proveedor, presupuesto adicional, cambio de cuentas o límites comerciales. No presentar recomendaciones como aprobaciones vigentes.

## 8. Aislamiento y coordinación con SOL MAIN

El agente debe operar en un **Git worktree diferente** del directorio usado por SOL MAIN. En la máquina de desarrollo, desde el clon actual:

    git fetch origin research/ai-provider-economics-2026-11
    git worktree add ../mainspot-ai-research -b local/ai-provider-research origin/research/ai-provider-economics-2026-11
    cd ../mainspot-ai-research

Antes de ejecutar, verificar 'git worktree list' y 'git status' y adaptar el nombre de la rama local si ya existe. El worktree sigue conectado al mismo repositorio Git pero con working directory y HEAD separados. No asumir que abrir una terminal extra basta para aislar sesiones. No iniciar servers/workers ni compartir puertos, procesos o archivos de estado con la sesión SOL MAIN.

**Escrituras permitidas:** solamente research/ai-provider-economics/ en esta rama. No modificar src/, tests/, migrations/, .canonflow/, configuración ni documentación canónica; no merges, cherry-picks, rebases de la rama productiva ni commits en master o feat/canonflow-implementation. Si SOL MAIN avanza durante la investigación, reconocerlo como snapshot externo y reconciliar en el informe por referencias SHA, sin modificar su rama.

## 9. Primer paso automático

Lee el handoff completo, inspecciona inventario del AI Core y precios/fuentes oficiales, registra el snapshot y comienza la investigación de forma autónoma; reporta en README avances y limitaciones. Solo escalar gasto no cubierto, necesidad de datos/credenciales no autorizados o decisiones fuera de alcance. No preguntar nuevamente por autorizaciones ya fijadas para investigar sin costo.

**Definición de terminado:** evidencia verificable, resultados por capacidad, modelo económico reproducible, recomendación defendible y riesgos/incertidumbres explícitos. No implementar ni cambiar selección productiva.
