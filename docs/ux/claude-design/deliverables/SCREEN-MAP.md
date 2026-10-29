# MainSpot · Mapa de pantallas e interacciones (iteración 2)

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

## Demostración de iteración 2 (≈3 minutos)

1. Termina el alta (pasos 1–5 de arriba). En «Revisa los datos de tu negocio» el teléfono ya tiene **país + número**: será tu número principal.
2. **Mi página → Teléfono en Página web** → «Otro número» → `983 111 1111` → Guardar. Se crea la vista previa para publicarlo en la página.
3. **Google** → «Conectar mi ficha de Google» → «Sí, es mi negocio» → Teléfono en Google Maps → «Otro número» → `983 222 2222` → Guardar.
4. **Facebook** → conectar → «Otro número» → `983 333 3333` → Guardar. **Mi negocio → Qué número ve cada canal** muestra los tres distintos.
5. **Atención → Qué puede responder MainSpot por mí** → encender respuestas automáticas → «Agradecimientos: Responder por mí» → Guardar → marcar «Lo autorizo».
6. En Atención, bloque de demostración: «Reseña de 5★» → la atiende MainSpot sola (simulado, con versión de regla).
7. «Reseña de 2★ con queja» → caso para ti, aviso en Telegram con 3 propuestas → responde desde Telegram («Usar opción 2» → «Sí, publicar») o desde el panel; ambos ven la misma resolución.
8. **Facebook → Nueva publicación** → «Ya tenemos pan de muerto» → Preparar → Publicar o Programar.
9. **Mi página** → revisar la vista previa del teléfono nuevo → Publicar → historial y versiones.

## Navegación

Móvil: **Inicio · Mi página · Google · Facebook · Atención** (abajo); **Mi negocio** y **Avisos** arriba. Escritorio: barra lateral con los siete destinos y, desde 1280 px, el chat de Telegram simulado a la derecha.

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
| DS-13 | `#/google` | Conectar mi ficha de Google → Sí, es mi negocio | Ficha simulada: mapa ilustrativo, dirección y horario comparados con tu página, teléfono propio de Google, resumen de reseñas | Buscando · ¿Es tu negocio? · Google no responde · falta permiso · desconectar |
| DS-14 | `#/facebook`, `/nueva`, `/post/:id` | Nueva publicación → Preparar → Publicar / Programar | Publicada o programada (simulado) con comentarios ligados | Operación → «Enviar a aprobación» · fecha pasada · Facebook no responde → reintentar · cancelar programación · publicación previa intacta |
| DS-15 | `#/atencion` (`canal`, `estado`) | Abrir el caso | DS-16 | Vigilando / en pausa (recupera lo pendiente) / sin canales · filtros por canal y estado · Telegram sin conectar · bloque de demostración «simula que llega…» |
| DS-16 | `#/caso/:id` | Elegir una de 3 respuestas → editar → Publicar respuesta | Respondido (simulado) con autor, canal de decisión y fecha | Atendido por MainSpot (regla vN) · No responder · Atendido fuera · reintento/fallo sin «publicado» falso · duplicado ignorado · resuelto desde Telegram · Operación propone y espera aprobación · aviso si el texto ofrece descuento |
| DS-17 | `#/atencion/reglas` | Guardar reglas → «Lo autorizo» | Nueva versión de reglas en el historial | Por defecto todo se revisa · quejas y temas delicados nunca automáticos · alcance Google/Facebook · solo Administración edita |
| Tel. | Tarjeta en Mi página, Google y Facebook; principal en Mi negocio | Usar mi número / Otro número → país + número → Guardar | Número efectivo por canal | Número inválido o de otro país · sin número principal (pide capturarlo) · otro→mío→otro conserva el número · «Borrarlo» · sincronización simulada pendiente/fallida |

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

## Teléfonos (contrato compartido §A)

- Estado: `primary` `{iso, nat}` y `phones.{website|google|facebook}.{mode: own|other, other}`. **No existe un «otro número» global.**
- `effective(ch)` = principal si `own`; si no, `other` de ese canal. Validación E.164 con libphonenumber-js (local).
- Guardar un canal solo toca ese canal. Cambiar el principal actualiza solo los canales `own` y el aviso dice cuáles cambiaron y cuáles no.
- `other→own` conserva `other` (se muestra «lo guardamos por si vuelves a usarlo»); «Borrarlo» lo elimina de forma explícita.
- Página web: el número nuevo pasa por vista previa y aprobación antes de publicarse. Google/Facebook: sincronización **simulada**.
- El teléfono público no es el chat de Telegram de avisos.

## Agente de atención (contrato §B)

Estados del caso: `received → classifying → responding → responded` (solo con regla autorizada) o `needs_human` (3 propuestas) → `awaiting_approval` (Operación) → `responding → responded`, `rejected`, `handled_outside`; fallos `retry_pending` (contador) → `failed` tras 3 intentos. Respuesta idempotente (`case.id:r1`), duplicados por `ext` ignorados, vigilancia en pausa encola y recupera. Telegram: un mensaje por caso o un resumen cuando llegan varios; mismo `case_id` y una sola resolución.

## Notas para SOL MAIN

- Código del prototipo (no es código de producción): `assets/js/store.js` (estado y datos), `phones.js` (teléfonos por canal), `agent.js` (agente de atención), `assistant.js` (cambios a la página, publicación y Telegram), `views-*.js` (pantallas), `ui.js` (componentes), `main.js` (rutas y acciones), `demo.js` (herramienta de demo, no implementar).
- `assets/vendor/libphonenumber-min.js`: libphonenumber-js (MIT), licencia incluida.
- Tokens visuales: `assets/css/app.css` (`:root`). Fuentes locales OFL: Bricolage Grotesque (títulos) y Atkinson Hyperlegible Next (texto). Iconos: Lucide (ISC).
- Atributo `data-screen="DS-xx"` en la raíz de cada vista para ubicarla.
- La plantilla del sitio de la panadería es ilustrativa; el contenido sigue los campos de `src/website/template.ts`.
