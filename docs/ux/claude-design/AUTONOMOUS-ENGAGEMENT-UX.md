# MainSpot — Agente activo de reputación y atención de conversaciones
## Complemento funcional de UX/UI · Iteración 2 · DESARROLLO

**Objetivo:** que Claude Design represente el valor real de MainSpot: **un agente de IA observa y atiende de forma continua las conversaciones públicas del negocio**, responde automáticamente lo que está **dentro de políticas previamente autorizadas**, y **escala a MainSpot + Telegram** lo que requiere criterio humano. No se trata solo de un panel para redactar respuestas manuales.

**Origen de la visión:** lluvia de ideas del proyecto (2026-06-04), especialmente conversación de 1:08:25–1:10:22: atención a comentarios de redes, análisis de sentimiento, respuestas autónomas en casos sencillos y tres opciones para los incidentes delicados; el propietario puede revisar y modificar la respuesta. La experiencia se diseñará para micronegocios y seguirá siendo sencilla.

**Estado y limitaciones verificadas (2026-10-29):**
- `INC-004` ya contiene ingesta/clasificación de reseñas simuladas, umbral configurable, sugerencias de respuesta, escalamiento y publicación **solo tras preview/aprobación humana** (`src/reputation/`, DEC-011, DEC-023).
- `INC-005` contiene borradores, programación y publicación simulada de **publicaciones de Facebook**, con aprobación humana (`src/social/`). No equivale a moderar o responder comentarios entrantes de Facebook: **eso aún no está implementado**.
- La lectura continua automática (webhooks/polling), la clasificación semántica de comentarios entrantes de Facebook y las **respuestas automáticas por políticas** no están acreditadas en el backend actual.
- **Diseñar esta visión no modifica por sí solo DEC-011 ni autoriza activar respuestas públicas sin aprobación humana**. Mostrar la opción de automatización como **propuesta UX / simulación futura**, con estado claramente etiquetado. El comportamiento actual aprobado exige aprobación humana de las respuestas públicas. Antes de implementarlo, el propietario deberá autorizar un modelo de políticas y delegación compatible con el canon.
- `Google Maps` es la superficie pública del negocio; la gestión de ficha y reseñas se realiza a través de las capacidades autorizadas de Google Business Profile. La administración completa de la ficha (horarios, categorías, etc.) también está pendiente de implementación y se simula.

## Qué debe sentir el propietario

> «MainSpot está pendiente de mis clientes. Resuelve lo cotidiano y solo me llama cuando realmente necesita mi decisión».

No agregar un centro de control técnico. Un **resumen entendible de trabajo delegado** con acciones claras y una bandeja de excepciones.

### Flujo A: vigilancia activa, sin depender de tener la pantalla abierta

El prototipo simula que el agente:
1. Recibe una reseña de Google o un comentario nuevo de una publicación en Facebook.
2. Muestra el origen, publicación o ficha, autor ficticio, texto, fecha y estado de atención.
3. Detecta intención (agradecimiento, pregunta, queja, información faltante, abuso u otro), sentimiento y nivel de confianza; el sentimiento **no es la única condición de decisión**.
4. Aplica las **políticas del negocio que el propietario aprobó** y las restricciones generales del producto.
5. Produce un resultado trazable: respuesta automática **solo si está autorizada**, derivación a humano, solicitud de aclaración, error/reintento o atención registrada.

Todo esto se ejecuta en modo simulación dentro del navegador; no integrar servicios externos ni dar la impresión de que un agente real está trabajando.

### Flujo B: atención automática autorizada (SIMULACIÓN / PROPUESTA)

Ejemplo: comentario «¡Qué rico su pan!», sin condiciones comerciales ni riesgos, con política ilustrativa de agradecimientos aprobados. El agente puede responder con texto sencillo, respetuoso, contextual y compatible con el tono del negocio. Registrar **qué se recibió, qué política permitió actuar, qué se respondió, cuándo y en qué canal**. Dejar claro que en el backend actual la respuesta pública exige revisión humana; el modo autónomo es una **capacidad objetivo no activada**.

No responder automáticamente si: exige datos no verificados, descuentos/cupones, compromisos económicos, compensaciones, acusaciones graves, disputas, información personal, temas legales/sensibles, amenazas, emergencias, contenido ambiguo o política insuficiente. No prometer acciones que no estén autorizadas.

### Flujo C: intervención humana por excepción

Ejemplo: reseña «Mi pedido llegó mal y nadie me atendió».

1. El agente **no publica una respuesta por su cuenta**.
2. Crea un **pendiente de atención** visible en el dashboard y en una bandeja unificada de casos.
3. Envía una **notificación a Telegram** (simulada) con resumen, enlace a la ficha/caso y motivo del escalamiento.
4. Propone **hasta tres respuestas alternativas**, con tono y propósito diferentes y **sin inventar descuentos, hechos ni promesas**.
5. El dueño puede **aprobar, editar o rechazar**; solo después se simula la publicación.
6. El caso pasa a atendido, con historial de decisión, responsable y resultado. Si no puede responderse, se mantiene pendiente; se puede marcar que se atendió fuera de la plataforma.

Evitar spam de avisos duplicados y mostrar cómo se manejarían varios pendientes con un resumen único. No simular aprobación sin intervención explícita.

### Flujo D: política en lenguaje sencillo

Diseñar una sección breve y entendible: **«Qué puede responder MainSpot por mí»**. Proponer opciones *demostrativas, no políticas definitivas*:
- Agradecimientos sin compromisos: permitir respuesta autónoma / revisar primero.
- Preguntas sobre información verificada del negocio: permitir / revisar.
- Quejas y solicitudes de solución: avisarme y proponer respuestas.
- Promociones, reembolsos, descuentos y situaciones delicadas: nunca comprometer al negocio sin autorización.

Mostrar siempre **qué está activo, qué necesita permiso y qué queda fuera del alcance**. Por defecto de la **implementación actual**, las respuestas públicas se envían a aprobación; el modo autónomo solo es visualización de diseño propuesto.

### Flujos de negocio y pruebas obligatorias del diseño

1. Reseña positiva sencilla → se ve cómo sería una respuesta automática **si una política futura la autoriza**; sin confundirlo con lo aprobado actualmente.
2. Reseña de 2 estrellas → llega a «Necesita tu atención» + aviso de Telegram + tres propuestas → humano modifica/aprueba.
3. Comentario sencillo en publicación de Facebook → clasificado y registrado; simular atención según políticas, sin afirmar integración implementada.
4. Comentario de Facebook con promesa de descuento que el agente no puede conceder → bloqueo y escalamiento.
5. Respuesta intentada pero falla el proveedor → estado recuperable, reintento controlado, sin duplicados ni falso «publicado».
6. Sin conexión / permiso / política → pendiente o modo revisión, nunca respuesta no autorizada.
7. El dashboard refleja **atendidas por el agente, necesitan tu decisión, errores de atención**, separadas por canal y con historial verificable.
8. Telegram y el panel muestran el **mismo caso y la misma decisión**, sin mantener dos bandejas inconexas.

### Integración con la iteración UX existente

- Mantener la calidad visual y el flujo de la iteración 1. No rediseñar alta, panel, publicación de web ni Telegram innecesariamente.
- Integrar la visión en la navegación **Mi página / Google / Redes sociales / Reseñas**, con **un solo asistente** y una bandeja común de pendientes.
- Facebook: además de crear/programar publicaciones, mostrar atención a los **comentarios que reciben esas publicaciones**.
- Google: ficha del negocio en Maps **y** atención de reseñas, diferenciando información administrable, datos simulados e integración pendiente.
- La autonomía se presenta como objetivo sujeto a políticas aprobadas, **no** como permiso vigente para que el prototipo realice actos externos.
- Todos los casos deben ser **navegables en HTML/CSS/JS local con datos ficticios**, incluido «Probar estados». No inventar funcionamiento de las APIs de Meta o Google.

### Entrega y evidencia

Claude Design tiene autorización de crear/modificar/hacer commit y push **solo** bajo `docs/ux/claude-design/**`, rama `feat/canonflow-implementation`, sin force-push.

Actualizar `deliverables/` (prototipo + mapa + hashes) y `reports/` (QA y avance). Incluir en QA escenarios A–D y pruebas mobile/desktop. Mantener breve la documentación adicional.

**Criterio UX de éxito:** el propietario entiende en segundos **qué resolvió MainSpot por él**, **qué requiere su intervención** y **cómo responder desde el panel o Telegram**; nunca se simula como autorizada una respuesta real que hoy exige aprobación.
