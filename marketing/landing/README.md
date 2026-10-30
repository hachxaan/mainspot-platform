# MainSpot · Landing comercial (desarrollo)

Landing comercial independiente para micronegocios en México. No modifica ni depende del backend, panel, Claude Design o CanonFlow.

## Ejecutar

```bash
cd marketing/landing
python3 -m http.server 8080
# Abrir http://localhost:8080
```

También abre `index.html` directamente para revisar los ejemplos básicos (el comportamiento del portapapeles depende del navegador y de un contexto seguro).

## Contenido y diseño

- Mensaje: **«Tu negocio, en todas partes. Sin que tengas que estar en todo.»**
- Marca: familia cromática del producto actual (magenta, cálidos y lila); composición editorial de comercialización propia.
- Páginas, Google, Facebook y atención de comentarios explicados como experiencias **en desarrollo** y sujetos a disponibilidad.
- Ejemplos de conversación y reseñas funcionan **localmente** con datos ficticios y nunca ejecutan acciones externas.
- El formulario valida los cuatro campos y prepara un texto para copiar. **No transmite, registra ni guarda datos**: falta un canal comercial verificado.
- Planes, precios, testimonios, clientes, métricas y resultados reales deliberadamente ausentes.
- Recursos visuales propios SVG; sin recursos externos, fuentes remotas, cookies, analytics ni tracking.

## Estado de publicación

`index.html` incluye `robots=noindex,nofollow` porque aún no hay autorización de publicación comercial ni se verificó el dominio definitivo. Antes del lanzamiento: acordar dominio/canonical, correo o backend comercial de contacto, privacidad, validación de integraciones, alcance contractual y precios; retirar el `noindex` después de verificar todo.

## Validación básica

- HTML semántico y secciones con destinos de navegación.
- Estados controlados para menú móvil, vista previa de cambios, escenarios de reseñas y solicitud de información.
- `aria-expanded`, `aria-pressed`, estados `role=status`, navegación de teclado y reducción de movimiento.
- Mobile-first progresivo; puntos de adaptación 1100, 800 y 560 px.
- QA con Chromium/Playwright en escritorio y móvil (ver `QA.md`).

## Limitaciones conocidas

- No hay integración comercial real con Google/Meta/Telegram ni base de datos de leads; la landing **no afirma lo contrario**.
- El formulario no constituye un servicio de captación hasta conectar un endpoint verificado.
- El soporte `navigator.clipboard` requiere HTTPS o localhost; fuera de eso se selecciona el texto para copiar manualmente.
- Los recursos OG son SVG; algunos distribuidores sociales requieren PNG/JPEG al publicar. Preparar entonces una versión rasterizada y un dominio absoluto.