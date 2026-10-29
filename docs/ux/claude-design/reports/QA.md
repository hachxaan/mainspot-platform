# QA del prototipo · iteración 1 (2026-10-29)

Pruebas ejecutadas de verdad en **Chromium 153 headless (Playwright)** abriendo `deliverables/index.html` como archivo local (`file://`), sin servidor ni red. Datos ficticios.

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
