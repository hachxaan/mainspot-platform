# Claude Design — Iteración 2 E2E en paralelo con SOL MAIN

**Autoridad:** el propietario autorizó continuar autónomamente diseño, prototipo, pruebas, reportes, commits y push **solo** bajo `docs/ux/claude-design/**` sobre `feat/canonflow-implementation`. **No HDC ni espera de aprobación durante esta tanda de desarrollo**; no tocar canon histórico, backend o migraciones. Leer [mandato de dueño](../../handoffs/e2e-parallel-2026-10-29/OWNER-AUTHORIZATION.md), [contrato compartido](../../handoffs/e2e-parallel-2026-10-29/SHARED-CONTRACT.md) y [visión agente](AUTONOMOUS-ENGAGEMENT-UX.md).

## Resultado final

**Un solo producto** con navegación clara y sencilla para propietarias/os de micronegocios: Página Web, Google Maps/Perfil del Negocio, Facebook, Reseñas y un único agente conversacional que trabaja permanentemente en segundo plano. No tres mini-dashboards aislados. Conservar lo construido en la iteración 1; sumar sin rehacer todo.

### A. Teléfono configurable INDEPENDIENTE en las tres integraciones

Implementar UX completa en **cada** integración:
- Radio **«Usar mi número»** (teléfono primario editable en «Mi negocio»).
- Radio **«Otro número»** que muestra selector país/código + campo de número, validación y Guardar.
- La Página Web puede usar un número distinto del de Google y otro distinto del de Facebook. **NO existe un único «otro número» global**. Al seleccionar `other` para las tres, se pueden mostrar **tres valores diferentes a la vez**.
- Si cambias el teléfono de Google **no** cambia Facebook ni Página Web; si cambias el primario, se actualizan **solo** los canales `own`.
- Vista previa de qué número se verá o se guardará en cada canal; los cambios externos Google/Meta son **simulados** y señalados.
- Volver `other→own→other` conserva el override del canal para evitar pérdida accidental. Un estado sin primario solicita capturarlo, no completa un número inventado.
- **TEL-01..TEL-04 son pruebas obligatorias** de interfaz, incluyendo tres números distintos. Internacionalización razonable (país/prefijo), sin suponer que todos son +52. Las alertas Telegram no se envían por este teléfono.

### B. Agente de atención y reputación ACTIVO

La UX muestra agente observando nuevas **reseñas Google** y **comentarios Facebook**, sin depender de tener el navegador abierto (simulado); filtros por canal, estado, trabajo atendido automáticamente, excepciones, histórico y causa de cada decisión.

- Caso permitido por política habilitada explícitamente por el propietario del negocio → respuesta automática **simulada** con registro («Atendido por MainSpot», política aplicada, fecha, texto).
- Caso ambiguo/sensible/sin política → pendiente de decisión en panel **y Telegram simulado**; hasta 3 respuestas sugeridas, editar/aprobar/descartar, una sola resolución compartida.
- Política fácil de entender «Qué puede responder MainSpot por mí», con configuración de categorías seguras, interruptor, alcance, resumen de riesgos, confirmación explícita. Por defecto respuestas públicas **en revisión**. El modo autónomo es **objetivo autorizado para pruebas de desarrollo** mediante opt-in ficticio, no integración real ya activa.
- Problemas: Telegram sin conectar, proveedor caído, respuesta fallida, reintento, duplicado, falta de permiso; estados coherentes, sin falsear publicación real ni suplantar autorización del cliente.
- Respetar política: no ocultar/borrar opiniones, no persuadir selectivamente a dejar 5 estrellas, no ofrecer descuentos ni promesas no verificadas.

### C. Página web, Google, Facebook y recorrido completo

- **Página Web**: conservar alta, editor conversacional, preview y aprobación, estado publicado, historial y número telefónico específico.
- **Google Maps / Perfil del Negocio**: pantalla de ficha (datos básicos y número específico, ubicación y horarios) con simulación de configuración/sincronización; reseñas y agente de respuesta; no presentar APIs de edición reales como conectadas.
- **Facebook**: publicar/programar posts con preview/approval, gestión y respuesta a comentarios entrantes mediante el agente, número específico de integración; no presentar Ads avanzados, Instagram ni conectores reales.
- **Telegram**: vínculo del chat para notificaciones y solicitudes; panel y Telegram ven el mismo caso.

### D. Calidad, pruebas y entrega

Prototipo HTML/CSS/JS realmente navegable, solo con datos sintéticos, offline, móvil 360/390/414 y escritorio 1280/1440, estados alternativos, teclado y contraste; evitar navegación de menú abultada y sobrecarga visual. «Probar estados» permite recorrer casos complejos sin backend.

Persistir `working/`, `deliverables/`, `reports/` por commit/push en GitHub sin forzar. Actualizar `SCREEN-MAP.md`, `manifest.sha256` y `QA.md` (tests realmente ejecutados), `PROGRESS.md` con entregable. No esperar HDC ni aprobaciones de diseño intermedias.

**La tarea está completa cuando** el usuario puede recorrer: alta → configuración de tres números **independientes** → Google/Facebook → agente automático autorizado simulado → caso delicado con Telegram y tres propuestas → publicación web/estado e historial; con evidencia de pruebas en móvil y escritorio.
