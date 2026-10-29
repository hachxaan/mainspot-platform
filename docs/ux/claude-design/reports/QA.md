# QA del prototipo

Pruebas ejecutadas de verdad en **Chromium 153 headless (Playwright)** abriendo `deliverables/index.html` como archivo local (`file://`), sin servidor ni red. Datos ficticios. Las integraciones con Google, Meta y Telegram son **simuladas** en todos los escenarios: ninguna prueba es «PASS real Google/Meta».

## Iteración 2 (2026-10-29) · teléfonos por canal, Google, Facebook y agente

Recorrido automatizado: alta → contraseña → datos del negocio con teléfono país + número → Telegram → primera página publicada → tres números independientes → Google y Facebook conectados → regla automática autorizada → reseña positiva atendida sola → reseña de 2★ resuelta desde Telegram con 3 propuestas → comentarios de Facebook → fallo y reintento → publicación en Facebook → teléfono nuevo de la página publicado tras vista previa.

| Prueba | Resultado | Tipo | Qué se comprobó |
|---|---|---|---|
| TEL-01 | PASS | simulated | Web `+529831111111`, Google `+529832222222`, Facebook `+529833333333` guardados y leídos sin cruces |
| TEL-02 | PASS | simulated | Cambiar solo Facebook a `+529834444444` no altera web ni Google |
| TEL-03 | PASS | simulated | Web en «Usar mi número», Google y Facebook en «Otro número»: cambiar el principal solo cambia la web |
| TEL-04 | PASS | simulated | otro→mío→otro recupera `9831111111`; número inválido rechazado con error en el campo y valor anterior intacto; número de EE. UU. (`+12025550143`) aceptado sin afectar Google. *Tenant cruzado: no aplica a la interfaz; queda para el backend (not_verified aquí)* |
| AG-01 | PASS | simulated | Reseña 5★ con regla autorizada → una respuesta automática con versión de regla 2 y evidencia en el historial |
| AG-02 | PASS | simulated | Reseña 2★ → caso humano con 3 propuestas → aviso Telegram → «Usar opción 2» → «Sí, publicar» → resuelto `via: tg`; un segundo intento desde el panel se rechaza |
| AG-03 | PASS | simulated | Comentario simple atendido solo; pedido de descuento escalado; propuestas sin descuentos; respuesta editada publicada; la publicación previa no cambia |
| AG-04 | PASS | simulated | Duplicado ignorado (casos iguales, contador de duplicados = 1); Google caído → `retry_pending` sin respuesta publicada → al volver, «Intentar ahora» publica una sola vez (2 intentos) |
| FLOW-01 | PASS | simulated | Alta y entrada sin identificador interno → panel → web/Google/Facebook → agente |
| FLOW-02 | PASS | simulated | Teléfono nuevo de la página → vista previa → aprobación → publicación (versión 2), sin regresiones |
| Consentimiento | PASS | simulated | Guardar una regla automática exige marcar «Lo autorizo»; sin la casilla, no se guarda |

| Viewport | Resultado |
|---|---|
| 360 × 760 | 24/24 comprobaciones PASS, 0 errores de consola |
| 390 × 844 | 24/24 PASS, 0 errores |
| 1440 × 900 | 24/24 PASS, 0 errores (panel y chat de Telegram lado a lado muestran el mismo caso) |

- **Regresión de la iteración 1** a 390 px: recorrido completo (alta → Telegram → primera página → cambio por panel y por Telegram) y casos alternativos de «Probar estados», 0 errores.
- **Sin desplazamiento horizontal** en 22 rutas a 360, 390, 414, 768, 1024, 1280 y 1440 px.
- **axe-core** (WCAG 2.0/2.1/2.2 A y AA) en **23 pantallas** a 390 px, incluidas Google, Facebook, Atención, Caso y Reglas: **0 infracciones**.
- **Casos alternativos de la iteración 2** (390 px, 15/15 PASS, 0 errores): sin número principal (pide capturarlo, no inventa uno, no guarda «Usar mi número») · atajo TEL-01 · Operación propone y queda «Espera aprobación» sin publicar, Administración aprueba · Facebook sin permiso bloquea la respuesta sin publicar · vigilancia en pausa encola y al reanudar recupera una sola vez · 3 llegadas a la vez generan un solo resumen en Telegram · Facebook caído: la publicación queda «No se publicó» y el reintento publica · programar y publicar a la hora · Solo lectura no puede cambiar reglas ni teléfonos.

### Limitaciones verdaderas
- Solo Chromium; falta Safari iOS, Firefox y lector de pantalla real.
- La clasificación, las propuestas y la vigilancia son reglas deterministas del prototipo; no hay IA ni proveedores reales.
- Las fechas, tiempos y datos de la ficha de Google son ficticios.

---

## Iteración 1 (2026-10-29)

## Recorrido completo automatizado

Alta (DS-01) → invitación (DS-02) → contraseña con error y corrección → datos del negocio → Telegram (código, «Iniciar», conectado) → panel → aprobar y publicar la primera página → cambio por panel («El sábado abrimos de 8 a 2») → vista previa Antes/Después → aprobar → publicar → cambio por Telegram («Agrega pan de muerto») → aprobar en el chat → publicar → avisos, historial, versiones, sitio, mi negocio.

| Viewport | Resultado |
|---|---|
| 360 × 760 | Completo, 3 versiones publicadas, 0 errores de consola |
| 390 × 844 | Completo, 0 errores |
| 1440 × 900 | Completo, 0 errores (chat en columna derecha) |

## Casos alternativos (vía «Probar estados»)

Probados a 390 y 414 px, 0 errores: invitación usada / caducada / enlace roto · contraseña débil y no coincidente · login con error genérico y correcto · código de Telegram caducado / anulado · chat sin conectar · pedido ambiguo con aclaración · pregunta simple sin aprobación · vista previa vencida → nueva · perfiles Operación y Solo lectura (sin controles de aprobación) · Trial por vencer y terminado (solo lectura, «Contactar a MainSpot») · fallo de publicación → FAILED → RETRY_PENDING → «Intentar ahora» → ACTIVE · aprobación repetida (no duplica) · vista previa ya usada · error al cargar el panel → reintento · sin avisos.

## Diseño adaptable

Sin desplazamiento horizontal en 16 rutas a **360, 390, 414, 768, 1024, 1280 y 1440 px**.

## Accesibilidad (meta WCAG 2.2 AA)

- **axe-core 4.x** (reglas wcag2a/aa, 21a/aa, 22aa) en 17 pantallas a 390 px: **0 infracciones** tras corregir una etiqueta del chat simulado con contraste bajo.
- Contraste calculado de la paleta: texto principal 16.6:1, secundario 7.1:1, botón rosa con texto blanco 5.3:1, estados ≥ 6:1.
- Teclado: recorrido con Tab por el inicio con foco visible (contorno de 3 px); hoja de confirmación abre con el foco en «Sí, publicar», Esc la cierra y devuelve el foco al botón; aprobación completa solo con teclado.
- Controles táctiles ≥ 48 px; errores junto al campo con `aria-invalid` y `aria-describedby`; estados con texto e icono además del color; `prefers-reduced-motion` desactiva animaciones.

## Limitaciones verdaderas

- Probado solo en Chromium; falta Safari iOS y Firefox, y lector de pantalla real.
- Las fechas, vigencias y tiempos de publicación son ficticios y acelerados.
- La interpretación del lenguaje es una simulación por reglas: entiende horario, teléfono, dirección y productos; otras frases piden aclaración.
