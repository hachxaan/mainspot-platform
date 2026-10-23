# HDC-0005 — Rediseño de la UI del HDC con calidad de producción

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-21 |
| Estado | `PARCHE_LISTO` |
| Clase | Corrección de conformidad y mejora de UX dentro del contrato visual (§6, §9, §10, §11, §14) |
| Solicitud | «Se requiere de un rediseño de la ui del HDC. Debe ser de alta calidad (para producción) UI/UX.» |

## Problema observado

La UI v1 cumplía el flujo mínimo, pero no tenía calidad de producción:

- **Navegación rota:** los enlaces a registros (`#/decisions/DEC-xxxx`) abrían la
  bandeja, porque `main.js` ignoraba el argumento y `renderDecisionDetail` era
  inalcanzable.
- **Trazabilidad:** el selector de profundidad no se enviaba a la API.
- **Datos incompletos:**
  - el detalle de Historia mostraba títulos de registro vacíos, porque la API
    no los incluye;
  - Estado del proyecto truncaba el JSON a 2000 caracteres sin avisarlo.
- **Bandeja:** no tenía título visible, búsqueda ni filtros por riesgo o ciclo, ni
  el estado «En preparación» que exige §11.
- **Workspace:**
  - no tenía progreso, navegación entre preguntas ni resumen accionable;
  - `yes_no` ignoraba las etiquetas declaradas en la QS;
  - con la casilla única de `risk_acceptance`, el humano no podía expresar
    «no acepto» de forma explícita;
  - tenía cuatro textos bilingües escritos en el código, fuera de `i18n.js`.
- **Accesibilidad:**
  - textos ámbar por debajo de AA: chip T2 `#B97C10` sobre `#F8EED9` = 3,06:1,
    marca «recomendada» sobre blanco = 3,53:1, chip T3 = 3,83:1;
  - no había enlace de salto ni foco gestionado al navegar;
  - la desconexión solo se veía en una píldora del encabezado.
- **Móvil:** el rail y las tablas no se adaptaban.

## Causa raíz

El frontend v1 implementó las vistas mínimas de §11 sin sistema de componentes,
sin estados vacíos o de error por vista y con estilos sueltos. Algunas rutas y
parámetros quedaron sin conectar.

## Cambio

Aplica sobre HDC-0003 + HDC-0004. Parche:
[`patches/HDC-0005-ui-production-redesign.patch`](patches/HDC-0005-ui-production-redesign.patch).

**Sistema visual (`css/app.css`):** tokens de color, tipografía, espaciado,
radios y sombras. Se mantiene el contrato §11:

- cabecera oscura;
- tarjetas claras sobre fondo papel;
- paleta del sello (`#1F6E5C`);
- chips de riesgo T0–T4;
- rail de navegación.

Los textos de cada tono tienen variante «ink» con contraste AA. El foco es
visible, se respeta `prefers-reduced-motion` y hay estilos de impresión. Los
puntos de corte de 1180 px y 860 px convierten el rail en iconos y luego en
pestañas superiores desplazables. Se usan fuentes del sistema, sin recursos
remotos.

**Cascarón (`index.html`, `main.js`):**

- enlace de salto, marca SVG del sello y nombre del proyecto leído de
  `method-state`;
- píldora de conexión con banner de desconexión o proyección desactualizada, con
  botón Reintentar;
- selector ES/EN, contadores en el rail y pie con versión, generación y última
  sincronización.

El enrutado:

- renderiza en un contenedor oculto ya conectado y lo sustituye al terminar, sin
  parpadeo. Se mantiene `isConnected` para el autoguardado;
- en navegaciones lleva el foco al título; en la carga inicial conserva el orden
  nativo, con el enlace de salto primero;
- los re-renderizados por cambio de generación conservan scroll y foco, y siguen
  sin tocar un workspace con el mismo hash.

**Componentes (`ui.js`):** encabezado de página con migas, tarjetas, callouts,
chips (estado, riesgo con nombre del nivel, tipo, severidad), lista de filas
clicables, KPIs enlazados, rejillas de metadatos, línea de tiempo, estados
vacío/carga/error con reintento, divulgaciones, bloques de código, barra de
progreso, control segmentado, botón copiar con toast y fechas absolutas UTC o
relativas.

**Vistas:**

- **Resumen:**
  - primero «Necesita tu decisión», luego «Esperando al agente»;
  - KPIs, cada uno enlazado a su evidencia; un dato ausente muestra «—», nunca 0;
  - salud del servicio separada de la integridad del proyecto;
  - sesiones recientes con título y diagnósticos destacados.
- **Decisiones:**
  - bandeja con filtros por condición, búsqueda (`q`), riesgo y ciclo;
  - el filtro se refleja en la URL (`#/decisions/answerable`);
  - las sesiones `PENDING` con borrador muestran «En preparación».
- **Historia:**
  - tabla de sesiones y tabla de registros con su título;
  - detalle con contexto, registros, opciones rechazadas solo cuando el registro
    las declara (con nota), archivos de evidencia con hash copiable,
    diagnósticos y relaciones;
  - línea de tiempo que separa generación, respuesta humana, ingestión y archivo;
  - botón para ver las respuestas en modo lectura.
- **Registro** (`#/decisions/DEC-xxxx`, ahora alcanzable):
  - decisión, comentario literal, opciones rechazadas y elementos afectados;
  - solo los IDs de QS, ANS, DEC, APR y RSK son enlaces;
  - metadatos, binding del artefacto y relaciones.
- **Trazabilidad:**
  - formulario con autocompletado de IDs; la profundidad ya se envía;
  - grafo SVG concéntrico con flechas, colores por tipo de nodo y leyenda;
  - estilos distintos para enlaces declarados e inferidos;
  - nodos operables con teclado que recentran el grafo;
  - tabla accesible y aviso de truncado con «continuar».
- **Estado del proyecto:** campos de primer nivel resumidos, documento completo
  en una divulgación y punteros no disponibles agrupados.
- **Diagnósticos:**
  - tarjetas de servicio y de versiones de contrato;
  - hallazgos filtrables por severidad;
  - ámbito enlazado y fuentes visibles.
- **Workspace:**
  - siguen las ocho secciones en orden;
  - columna lateral fija con progreso, obligatorias pendientes, estado del
    borrador, «Revisar y enviar» y navegación por pregunta con estado; en móvil,
    barra inferior;
  - cada pregunta es una tarjeta con tipo, obligatoriedad, riesgo, explicación
    desplegable y «Por qué importa»;
  - las opciones son tarjetas seleccionables con descripción,
    impacto/riesgo/compromiso y chips «Recomendada»/«Por defecto», nunca
    preseleccionados;
  - `yes_no` usa las etiquetas de la QS;
  - aprobación con descripciones y panel del artefacto: referencia, archivo y
    SHA-256 copiable;
  - `risk_acceptance` con dos opciones explícitas; la fecha (mínimo mañana UTC) y
    la justificación aparecen al aceptar;
  - orden con flechas accesibles, el foco se mantiene en el elemento movido, el
    cambio se anuncia y la confirmación sigue siendo explícita;
  - comentario etiquetado como obligatorio u opcional según la respuesta;
  - resumen con estado por pregunta y «Editar»;
  - lista de verificación informativa: el servidor sigue validando;
  - un 422 deja errores en línea y un resumen enlazado, y mueve el foco al primer
    control inválido;
  - tras enviar, éxito con ANS, ruta y «Copiar referencia», y foco en la sección 8.
- **Autoguardado:** se conserva íntegra la lógica de HDC-0004. Añade un
  reintento cada 5 s ante fallos transitorios (red, 423, 5xx); nunca reintenta un
  `412`.

**Conservado sin cambios de contrato:** payloads de envío y borrador,
`draftPayload`, `sameDraft`, `restoreDraft`, prioridad de copia local frente al
servidor, borrador de otra versión en lectura, identidad nunca restaurada y
errores de HDC-0003.

## Contrato afectado

- §6: sin preselección. La recomendación se muestra sin activarla. El orden
  inicial no cuenta y exige confirmación. Aceptar un riesgo exige fecha y
  justificación; rechazarlo es una respuesta explícita.
- §9: los re-renderizados por generación son suaves; el workspace con el hash
  vigente no se re-renderiza.
- §10: borradores con ETag a 600 ms; reintento ante fallos transitorios.
- §11:
  - navegación fija y ocho secciones;
  - «En preparación», «Esperando al agente», «Procesada» y «Archivada»;
  - historia en lectura y aceptación, ingestión y efecto como eventos distintos;
  - en trazabilidad, declarados frente a inferidos; los `affected_items` sin ID
    resoluble quedan como texto;
  - teclado, etiquetas, foco al primer error, AA, anuncios, movimiento reducido y
    estados vacío/carga/desconexión/error.
- §14: sin scripts ni estilos en línea; solo CSSOM para el ancho de la barra de
  progreso. Sin recursos remotos ni `innerHTML` de contenido gobernado.

## Archivos upstream

`decision-console/app/canonflow_hdc/frontend/`:

| Archivo | sha256 tras la pila HDC-0003..0005 |
| --- | --- |
| `index.html` | `774d63e2173efe81d5a3228e40cdcb906478df4b8461cee8217c67c6695bab02` |
| `css/app.css` | `d2182c2b9016de93cf9690e1147d83067caa1edf40dc7b3315a5570520474789` |
| `js/api.js` (sin cambios) | `1a01eeba46913848781c4f20775b3191ff304118312df01edc2eee686262aae5` |
| `js/i18n.js` | `502f0e9308842bb6efb89bab6f3cf8486c4007bbbe1879a93fa7265e35fc61d0` |
| `js/main.js` | `67aa2dbe7c8e5223ddc31fa1632b348abb6918dee4f7e933dd2c3be3dc0e168b` |
| `js/ui.js` | `fb1ce96f76c03dbd1fc4d689f308258cb20dfab2b71a4087807f65f40bfa0e91` |
| `js/views/history.js` | `abe395a1bf0c4ea660c9303e00c48da2fb6c22ac3b624cc0c7d978767a8b3b68` |
| `js/views/overview.js` | `bec6ca3b91ce45ea2644ca2cc9ba77744a0cb70e3ca819cf6a41f25bc15cd848` |
| `js/views/workspace.js` | `b81ca8b1d1efce85a6afed362a296bfbc2fcf870dfd8a4124d3f98fece0c3223` |

`i18n.js` tiene 362 claves en `en` y 362 en `es`, sin claves huérfanas.

## Despliegue en MainSpot

- **Material:** `scripts/deploy/hdc-ui/` es el frontend completo resultante de la
  pila, byte a byte. Sustituye a `scripts/deploy/hdc-workspace.js`, que se
  elimina.
- **Instalación:** en el LXC `webserver` se instala como `/var/www/mainspot-hdc-ui/`.
- **Vhost** (`scripts/deploy/mainspot.hdc.com.conf`):
  - sirve `location = /`, `^~ /css/` y `^~ /js/` desde ese directorio con
    `Cache-Control: no-cache`;
  - el `index.html` lleva la misma CSP y las cabeceras de seguridad que el backend;
  - `/api` sigue yendo al backend fijado al pin.
- **Respaldo previo:** `/root/mainspot.hdc.com.conf.pre-HDC-0005.20261021T201019Z`
  y `/root/mainspot-hdc-ui.pre-HDC-0005.20261021T201019Z` en el LXC.
- **Alcance:** el loopback `127.0.0.1:8765` conserva la UI empaquetada del pin.

## Verificación ejecutada

Copia aislada del paquete del pin con HDC-0003 y HDC-0004 aplicados, en
`/tmp/hdc-redesign`, servida en `127.0.0.1:8799`. El proyecto sintético contenía
una copia de `.canonflow` de MainSpot y la QS de ocho tipos del fixture. No se
modificó el checkout de CanonFlow.

**Ocho tipos, de principio a fin**, sobre la copia QS-0009 del fixture, con
Chromium real y el backend Python:

- **Sin preselección:** 0 controles marcados al abrir.
- **Respuestas guardadas:** se respondieron los ocho tipos: orden movido y
  confirmado con comentario, riesgo aceptado con fecha y justificación, y
  override sin comentario. La columna lateral mostró 8/9 y «Borrador guardado».
- **Recarga:** se restauraron todos los valores, el orden, la confirmación, el
  comentario, la fecha y la justificación. El nombre se restauró, la identidad
  quedó sin marcar, el envío quedó deshabilitado y apareció el aviso de borrador
  recuperado.
- **Envío con error:** `422`, error en línea en `Q-CONFIRM`, resumen enlazado,
  `aria-invalid` en el comentario y foco en `TEXTAREA#Q-CONFIRM-comment`. Al
  escribir el comentario, error y resumen desaparecieron.
- **Envío correcto:** sección 8 con «Answers saved; waiting for the agent»,
  `ANS-0006` y ruta, con el foco en la sección 8; 0 controles editables.
- **Recarga tras el envío:** respuestas en lectura y confirmación de orden
  oculta; no quedó borrador local.

**Otros escenarios:**

- QS-0001 archivada, en lectura: 9 valores y 5 comentarios. El idioma `es` se
  tomó de la QS.
- «En preparación» en la bandeja tras crear un borrador en QS-0008.
- Sin conexión al detener el servidor: píldora «Sin conexión» y banner con
  Reintentar. Al reiniciarlo, estado `ok` y banner oculto.
- Teclado: el primer Tab va al enlace de salto y Enter enfoca `main`; las
  flechas seleccionan radios con foco visible.
- Móvil a 390 px: sin desbordamiento horizontal (`scrollWidth = 390`); barra
  inferior en el workspace.

**Auditorías y pruebas:**

- **axe-core 4.10.2**, reglas WCAG 2.0/2.1/2.2 A/AA y best-practice: 60
  auditorías (15 rutas × es/en × 1440/390 px) con 0 violaciones. La primera
  pasada detectó `--ink-mute` a 4,32:1 sobre el papel; se corrigió a `#616A76`
  (5,01:1).
- `node --check` correcto en los seis módulos. No hay `innerHTML` ni atributos
  `style`.
- **Suite upstream:** `pytest tests/` en un venv temporal con
  `requirements-lock.txt` y los `schemas/` del pin: **94 passed**. Incluye
  `test_frontend.py`: assets servidos y texto «Human Decision Console» presente.
- **Versión final**, idéntica a la desplegada: repetición sobre la copia
  QS-0010.
  - Sin preselección; la recarga restauró las respuestas y la identidad quedó sin
    marcar.
  - Rechazar sin comentario dio `422`, con el foco en `Q-APPROVE-comment`.
  - Al corregirlo se envió `ANS-0007`; después, lectura con 0 controles
    editables.
  - axe repetido: 44 auditorías (11 rutas × es/en × 1440/390 px), 0 violaciones
    y 0 errores de página.

**Pila y despliegue:**

- `git apply` de HDC-0003, HDC-0004 y HDC-0005 sobre el pin extraído con
  `git archive`: correcto, y `diff -r` idéntico al árbol de desarrollo.
- HTTPS `https://mainspot.hdc.com`: los 9 archivos coinciden por sha256 con
  `scripts/deploy/hdc-ui/`. Las cabeceras CSP, `nosniff`, `no-referrer`,
  `DENY` y `no-cache` están presentes en `/`.
- Sobre el HDC real de MainSpot, solo navegación, en Resumen, Decisiones,
  QS-0004, QS-0001, Historia QS-0003 y APR-0001: sin errores de página y estado
  `ok`.
- Después, `GET /api/v1/sessions/QS-0004/draft` devolvió `404` y el sha256 del
  ANS de QS-0001 siguió siendo `fbc6ffd3…5291`. No se hizo ningún envío real.

Los proyectos sintéticos crearon solo ANS temporales; ninguno creó DEC, APR o RSK.

## Ajustes al integrar en CanonFlow

1. Regenerar el wheel y el manifiesto con hashes (§12).
2. Añadir pruebas Playwright de los escenarios verificados, incluido el foco al
   primer error y la ausencia de preselección.
3. **API:**
   - exponer `has_draft` en `GET /api/v1/sessions`, para que «En preparación»
     no requiera pedir el detalle de cada sesión `PENDING`;
   - incluir `title` y `decision` en `/decisions/<id>` y en `records[]` del
     detalle de sesión; hoy la UI lee el artefacto.
4. Siguen abiertos los ajustes 1, 3, 4, 5 y 6 de HDC-0004. El ajuste 2 queda
   resuelto aquí: los textos están en `i18n.js` como `ws_draft_restored`,
   `ws_draft_other_version`, `ws_answers_readonly` y `ws_answers_unavailable`.
5. Opcional: adoptar los tokens y el vocabulario de clases en
   `decision-console/TEMPLATE_CONTRACT.md` para la plantilla HTML estática de
   sesiones.

## Riesgos y límites

- **Despliegue de MainSpot:** el override abarca todo el frontend, solo por
  HTTPS; el loopback sigue con la UI del pin. Al actualizar el pin hay que
  reconciliar los nueve archivos, no solo `workspace.js`.
- **Peticiones:**
  - la bandeja hace una petición de detalle por cada sesión `PENDING` mostrada;
  - el Resumen hace cinco peticiones;
  - la lista de registros de Historia pide cada registro para su título, con
    caché por ruta.
- **Navegadores:** se usa `:has()` (Chromium 105+, Firefox 121+, Safari 15.4+).
  Sin soporte, la tarjeta no se resalta, pero el control nativo sigue marcado.
- **Fuentes:** son del sistema, así que la tipografía varía entre sistemas
  operativos.
- **Grafo:** el diseño concéntrico es legible hasta unas decenas de nodos; las
  etiquetas de las aristas se ocultan con más de 6 enlaces y la tabla conserva el
  detalle.
- **Reintento del autoguardado:** cada 5 s mientras persista el fallo y la vista
  siga abierta.
