# MainSpot · Mapa de pantallas e interacciones (iteración 1)

Prototipo: [`index.html`](index.html). Se abre con doble clic, sin servidor ni internet. Todo es ficticio y se puede reiniciar.
Rutas con `#` para que «Atrás» del navegador funcione. El estado de la demo vive en `localStorage` (solo datos ficticios; las contraseñas nunca se guardan).

## Demostración de 2 minutos

1. **Inicio de la demo** → «Empezar el recorrido».
2. **DS-01** «Crear negocio e invitación» → «Abrir la invitación como Lupita».
3. **DS-02** «Empezar» → **DS-03** contraseña (p. ej. `pan2026dulce` dos veces) → «Guardar y continuar» → «Conectar Telegram».
4. **DS-07** «Abrir Telegram» → en el chat simulado, «Iniciar» → volver → «Ir a mi panel».
5. **DS-05** «Revisar mi primera página» → **DS-09** «Publicar mi página» → «Sí, publicar» → **DS-10** → «Ver cómo va» (**DS-11**, ~9 s acelerados).
6. En Inicio escribe «El sábado abrimos de 8 a 2» → «Sí, prepara la vista previa» → «Ver vista previa» → Antes/Después → «Publicar este cambio».
7. Abre el chat (o la columna derecha en escritorio ≥1280 px) y escribe «Agrega pan de muerto» → «Sí, prepárala» → «Publicar» → «Sí, publicar».
8. **DS-12** Avisos y **Cambios → Historial**: quién pidió, aprobó y publicó.

Errores y casos especiales: botón **«Probar estados»** (herramienta de demostración, borde punteado; no es parte del producto).

## Pantallas

| ID | Ruta | Acción principal | Estado siguiente | Alternativos y errores |
|---|---|---|---|---|
| — | `#/` | Empezar el recorrido | DS-01 | Continuar donde me quedé · Empezar de nuevo |
| DS-01 | `#/admin` | Crear negocio e invitación | Invitación lista (enlace de un solo uso) | Validación de campos · Anular invitación · Crear una nueva · Vista **solo de demo**, no backoffice real |
| DS-02 | `#/invitacion/:código` | Empezar | DS-03 | Ya usada · Caducada/anulada/enlace roto → mismo mensaje neutro, sin revelar si el negocio existe |
| DS-03 | `#/activar/contrasena` → `/negocio` → `/telegram` | Guardar contraseña → Guardar y continuar → Conectar Telegram | Cuenta activa → primera página en preparación → DS-07 | Requisitos visibles en vivo · contraseña débil · no coinciden · teléfono de 10 dígitos · elegir al menos un producto · «Lo haré después» |
| DS-04 | `#/entrar` | Entrar (correo + contraseña, **sin identificador interno**) | DS-05 | Error genérico (no revela cuentas) · «¿Olvidaste tu contraseña?» (por definir) |
| DS-05 | `#/inicio` | Revisar y decidir / Enviar un cambio | DS-09 / conversación | Negocio nuevo sin página · pendientes 0 y >0 · Trial por vencer/vencido · Operación · Solo lectura · error recuperable · cargando |
| DS-06 | `#/negocio`, `#/negocio/plan` | Pedir un cambio en estos datos | Conversación | Plan vigente/por vencer/terminado · Contactar a MainSpot · Cerrar sesión |
| DS-07 | `#/telegram`, `#/chat` | Conectar Telegram → Abrir Telegram → Iniciar | Conectado | Código caducado/usado/anulado · Generar uno nuevo · Anular · Desconectar (confirmación) · chat sin conectar recibe instrucciones · escribir el código a mano |
| DS-08 | `#/cambios`, `/historial`, `/nuevo`, `/:id` | Pedir un cambio | Propuesta → confirmación | Pedido ambiguo → aclaración con opciones · pregunta simple respondida sin aprobación · «No, corregir» · precios/redes fuera de alcance |
| DS-09 | `#/vista-previa/:id` | Publicar este cambio | Hoja de confirmación → DS-10 | Antes/Después · vencida (pedir nueva) · ya usada · descartada · enlace roto · preparando · sin permiso (Operación/Solo lectura) · Trial vencido |
| DS-10 | `#/aprobado/:id` | Ver cómo va | DS-11 | Repetir la aprobación → «Ya habías aprobado este cambio. No se publicará dos veces.» |
| DS-11 | `#/pagina`, `#/sitio` | Ver mi página | Sitio publicado simulado | Fallo → reintento automático o «Intentar ahora» · versiones · «Volver a esta versión» (pasa por vista previa y aprobación) |
| DS-12 | `#/avisos` | Abrir el aviso | Tarea relacionada | Sin avisos · Todos/Sin leer · Marcar todo como leído · espejo en Telegram |

## Estados de publicación (DEC-0043)

| Interno | Texto para el propietario |
|---|---|
| REGISTERED | Recibimos tu página (en actualizaciones: «Recibimos tu cambio») |
| PREPARING | Estamos preparando tu página |
| CONFIGURING | Estamos configurando tu dirección web (solo primera publicación) |
| VERIFYING | Comprobando que todo funcione |
| ACTIVE | Tu página ya está en internet + dirección (solo después de VERIFYING) |
| FAILED | No pudimos publicar tu página. Ya estamos revisándolo. |
| RETRY_PENDING | Lo intentaremos de nuevo en unos minutos (contador + «Intentar ahora») |

Durante una actualización se avisa que la página sigue mostrando la versión anterior.

## Solicitud (FLOW-002)

`awaiting_confirm` «Espera tu confirmación» → `preparing` «Preparando vista previa» → `preview_ready` «Lista para revisar» → `approved` «Aprobado, publicando» → `published` «Publicado». También `rejected` «Descartado», `expired` «Vista previa vencida», `cancelled` «Corregido».
El asistente propone y explica; **solo una persona con perfil de Administración aprueba**. En Telegram la aprobación pide un segundo toque («Sí, publicar»).

## Perfiles (REQ-010, matriz RBAC)

| Acción | Administración | Operación | Solo lectura |
|---|---|---|---|
| Ver página, cambios, avisos, plan | Sí | Sí | Sí |
| Pedir cambios y preparar vista previa | Sí | Sí | No (no se muestra el campo) |
| Aprobar / descartar / publicar | Sí | No (aviso: «Le avisamos a Guadalupe Ramírez») | No |

## Decisiones abiertas mostradas como «Prototipo:»

Campos mínimos del alta (FLOW-005) · vigencia de invitación · canal de envío de la invitación (REQ-003) · vigencia del código de Telegram (10 min de ejemplo) · vigencia de la vista previa (60 min de ejemplo, DEC-0003) · qué pasa con la página al vencer el Trial · si generar código con Trial vencido cuenta como «crear» · dominio de la dirección (`.mainspot.ejemplo`, DEC-0004) · recuperación de contraseña · canal de contacto · planes y precios. Se ocultan desde «Probar estados → Mostrar notas».

## Notas para SOL MAIN

- Código del prototipo (no es código de producción): `assets/js/store.js` (estado y datos), `assistant.js` (simulación de interpretación, ciclo de solicitud, publicación y Telegram), `views-*.js` (pantallas), `ui.js` (componentes), `main.js` (rutas y acciones), `demo.js` (herramienta de demo, no implementar).
- Tokens visuales: `assets/css/app.css` (`:root`). Fuentes locales OFL: Bricolage Grotesque (títulos) y Atkinson Hyperlegible Next (texto). Iconos: Lucide (ISC).
- Atributo `data-screen="DS-xx"` en la raíz de cada vista para ubicarla.
- La plantilla del sitio de la panadería es ilustrativa; el contenido sigue los campos de `src/website/template.ts`.
