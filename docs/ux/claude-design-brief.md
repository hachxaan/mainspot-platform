# Brief de diseño para Claude Design — Experiencia del propietario de MainSpot

> Documento de encargo. Solo describe qué debe diseñarse y con qué límites; no contiene código ni decisiones nuevas. Cada requisito cita su fuente: canon (`REQ-`, `RULE-`, `NFR-`, `FLOW-`, `AC-`, `FR-`, `BR-`) o registro HDC (`DEC-00xx`, `ANS-00xx`). Lo marcado como **abierto** no es requisito.

## 1. Propósito y cómo se usará

1. Claude Design produce un **prototipo navegable, móvil primero**, de la experiencia del propietario de un negocio en MainSpot.
2. El prototipo se entrega como archivos estáticos y se revisa en el **Human Decision Console (HDC)**; la aprobación queda ligada al hash de los bytes revisados (`DEC-0040`).
3. Solo tras la aprobación se implementa localmente; cualquier cambio posterior del prototipo requiere nueva revisión (`DEC-0040`).
4. El prototipo es una referencia de diseño, no una promesa comercial ni una especificación técnica adicional (`RULE-006`, `RULE-008`).

## 2. Usuario objetivo y principios

| Principio | Requisito | Fuente |
|---|---|---|
| Usuario | Propietario de un **micronegocio** (nivel 1); pymes y grandes fuera de alcance. | `DEC-0012` |
| Sin conocimientos técnicos | Toda tarea debe completarse sin instrucciones técnicas externas. | `REQ-001`, `AC-008` |
| Lenguaje cotidiano | Sin jerga (nada de "tenant", "token", "DNS", "webhook", "403", "deploy"); textos cortos; baja carga cognitiva. | `NFR-001`, `AC-008` |
| Sencillez extrema | Una acción principal clara por pantalla; acciones principales distinguibles. | `AC-008` |
| Móvil primero | Diseño base 360–414 px; escritorio secundario. | `DEC-0040` (maquetas navegables), encargo del propietario |
| Accesibilidad | Meta de diseño: WCAG 2.2 AA (contraste, foco visible, objetivos táctiles, etiquetas, no depender solo del color). El canon la tiene como `PROPOSED`; se adopta como meta, no como obligación cerrada. | `NFR-007` (PROPOSED), `AC-008` |
| Identidad | El acceso no pide el identificador interno del negocio. | `DEC-0039` |
| Roles | La interfaz muestra solo lo que el perfil permite (administración / operación / solo lectura). | `REQ-010`, `FR-0003` |

## 3. Alcance del prototipo (orden decidido)

Orden: alta y panel → Telegram → publicación real (`ANS-0009` resuelve `QS-0009` con `orden_comentario`; coincide con el comentario de `DEC-0038`; bloque situado según `DEC-0037`). Las secciones (d)–(f) completan el recorrido de punta a punta exigido para el MVP: no basta publicación simulada, Telegram solo de salida ni negocios precargados (`DEC-0038`, comentario).

### (a) Alta asistida e invitación

- **Objetivo del usuario:** activar su cuenta a partir de la invitación que le envía MainSpot y dejar su negocio listo.
- **Modelo:** un administrador de MainSpot crea el negocio y al propietario, asigna Trial y envía una invitación de un solo uso; el propietario fija su contraseña, completa sus datos y vincula Telegram (`DEC-0039`, `DEC-0018`).
- **Pantallas/estados requeridos:**
  1. Abrir invitación → bienvenida con nombre del negocio (`DEC-0039`).
  2. Crear contraseña (reglas visibles en lenguaje llano) (`DEC-0039`).
  3. Completar datos del negocio (campos: **abierto**, ver §7) (`DEC-0039`, `FLOW-005` PROPOSED).
  4. Invitación a vincular Telegram como siguiente paso (enlaza con (c)) (`DEC-0039`).
  5. Inicio de sesión posterior: solo correo/usuario y contraseña, sin identificador interno (`DEC-0039`).
- **Contenidos:** nombre del negocio, plan Trial y fecha de vencimiento (`DEC-0018`), pasos restantes.
- **Acciones:** aceptar invitación, crear contraseña, guardar datos, continuar a Telegram.
- **Casos límite:**
  - Invitación ya usada (`DEC-0039`, un solo uso): «Esta invitación ya se usó. Si no fuiste tú, contacta a MainSpot».
  - Invitación caducada o anulada (**abierto** si caduca/revoca, ver §7): estado genérico «Esta invitación ya no es válida. Pide una nueva a MainSpot».
  - Enlace inválido: misma pantalla neutra, sin revelar si el negocio existe (`NFR-002`, `REQ-008`; anti-oráculo NFR-0002 promovido por `DEC-0015`).
- **Textos de ejemplo:** «¡Bienvenido a MainSpot, Panadería Lupita!», «Crea tu contraseña para entrar cuando quieras», «Te falta un paso: conecta tu Telegram».

### (b) Panel del propietario

- **Objetivo del usuario:** saber en un vistazo cómo está su negocio y qué tiene pendiente.
- **Pantallas/estados requeridos:**
  1. Inicio: estado del sitio (ver (e)), pendientes de aprobación (ver (d)), estado de Telegram (ver (c)), plan (`DEC-0039`, `DEC-0043`, `FLOW-002`).
  2. Mi plan: plan, estado y fecha de vencimiento del Trial (`DEC-0018`, `FR-0010`).
  3. Historial de actividad: quién pidió, aprobó y publicó cada cambio (`REQ-009`, `NFR-006`).
  4. Perfil y datos del negocio (`DEC-0039`).
- **Acciones:** revisar pendientes, abrir vista previa, ir a vincular Telegram, editar datos, cerrar sesión.
- **Casos límite:**
  - **Sin plan / Trial vencido:** puede ver y consultar, pero no crear; aviso fijo con siguiente paso «contacta a MainSpot»; sin conversión ni cobro automáticos (`DEC-0007`, `DEC-0018`, `BR-0006`).
  - **Permiso insuficiente:** acciones no permitidas no se muestran; si se intenta, mensaje llano (`REQ-010`, `FR-0003`, `AC-008`).
  - Panel vacío inicial (sin sitio publicado aún).
- **Textos de ejemplo:** «Tu prueba gratis vence el 21 de noviembre», «Tu prueba terminó. Puedes ver tu información, pero para hacer cambios contacta a MainSpot», «Tu perfil no permite esta acción. Pídele ayuda al administrador de tu negocio».

### (c) Vinculación de Telegram

- **Objetivo del usuario:** conectar su Telegram con su negocio para pedir cambios por chat.
- **Modelo:** un único bot de MainSpot para todos los negocios; el panel genera un enlace/código de un solo uso, de corta vigencia y revocable (`DEC-0041`, `DEC-0043` §5).
- **Pantallas/estados requeridos:**
  1. Sin vincular: explicación breve + botón «Conectar Telegram» (`DEC-0041`).
  2. Código/enlace generado: botón para abrir Telegram, tiempo restante visible, opción «Anular» (`DEC-0041`).
  3. Vinculado: chat conectado (nombre visible), opción «Desconectar» (`DEC-0041`).
  4. Vista del chat en Telegram (mock): mensaje de bienvenida tras vincular; chat no vinculado solo recibe instrucciones para vincularse (`DEC-0041`).
- **Casos límite:** código caducado, código ya usado, código anulado, chat que escribe sin vincular (`DEC-0041`); Trial vencido al generar código (**abierto** si generar código cuenta como "crear", ver §7).
- **Textos de ejemplo:** «Este código caducó. Genera uno nuevo desde tu panel», «Listo: tu Telegram está conectado con Panadería Lupita», (bot a chat no vinculado) «Hola. Para usar MainSpot aquí, abre tu panel y toca "Conectar Telegram"».

### (d) Solicitudes de cambio, vistas previas y aprobaciones

- **Objetivo del usuario:** pedir un cambio (por Telegram o panel), ver cómo quedaría y decidir si se publica.
- **Flujo:** propuesta → explicación de cambios → confirmación → vista previa → aprobación del propietario → publicación (`FLOW-002`, `REQ-005`, `RULE-003`, `BR-0003`).
- **Pantallas/estados requeridos** (estados de `FLOW-002`): borrador, esperando confirmación, confirmado, vista previa lista, aprobado para publicar, publicado, rechazado, expirado, fallido.
  1. Resumen del cambio en lenguaje llano ("antes / después").
  2. Vista previa: enlace seguro, de un solo uso, con caducidad y ligado a esa propuesta (`DEC-0003`).
  3. Decisión: «Publicar», «Pedir otro cambio», «Descartar» (`FLOW-002`).
  4. Confirmación de que la aprobación quedó registrada; repetir no duplica (`FLOW-002` idempotencia).
  5. Mismo recorrido en Telegram (mock de conversación) para la confirmación; el voto final es del humano (`RULE-004`, `DEC-0043` §5).
- **Casos límite:** vista previa caducada o ya usada (`DEC-0003`); sin permiso para aprobar (`REQ-007`, `FR-0003`); Trial vencido (`DEC-0018`); fallo de la vista previa o de la publicación (`FLOW-002`); solicitud ambigua → pedir aclaración (`FLOW-001` PROPOSED, ilustrativo); pregunta simple respondida sin aprobación (`FLOW-003`, `RULE-002`).
- **Textos de ejemplo:** «Cambiaremos tu horario de sábado a 8:00–14:00. ¿Lo preparo?», «Así se vería tu página. Nada cambia hasta que tú lo apruebes», «Este enlace de vista previa ya no funciona. Pide uno nuevo desde tu panel».

### (e) Estados de publicación y del sitio

- **Objetivo del usuario:** saber si su página ya está en internet y qué pasa si algo falla.
- **Modelo:** MainSpot sirve el sitio en un subdominio real; Hostinger solo gestiona el DNS (`DEC-0004`, `DEC-0042`, `REQ-018`). La primera publicación también la aprueba el propietario (`DEC-0043` §4).
- **Estados a representar** (`DEC-0043` §4) con traducción a lenguaje cotidiano:

| Estado interno | Texto sugerido para el propietario |
|---|---|
| REGISTERED | «Recibimos tu página» |
| PREPARING | «Estamos preparando tu página» |
| CONFIGURING | «Estamos configurando tu dirección web» |
| VERIFYING | «Comprobando que todo funcione» |
| ACTIVE | «Tu página ya está en internet» + dirección |
| FAILED | «No pudimos publicar tu página. Ya estamos revisándolo» |
| RETRY_PENDING | «Lo intentaremos de nuevo en unos minutos» |

- **Requisitos:** nunca mostrar "activo" antes de verificar (`DEC-0043` §4); proceso asíncrono con progreso sin bloquear al usuario (`DEC-0043` §4); historial de versiones publicadas (`DEC-0042`, `DEC-0043` §4).
- **Casos límite:** fallo, reintento pendiente, Trial vencido con sitio ya publicado (los datos no se borran, `DEC-0018`; qué ocurre con el sitio público: **abierto**, §7).

### (f) Avisos al propietario

- **Requisitos:** avisar cuando el sitio esté realmente disponible (`DEC-0043` §4); avisar de pendientes de aprobación y de fallos de publicación (`FLOW-002`); aviso de vencimiento del Trial (`DEC-0018`, ver §7 para canal/antelación).
- **Canales:** panel y Telegram (`DEC-0041`, `DEC-0043` §5). Correo: **abierto** (`REQ-003` PROPOSED).
- **Pantallas:** bandeja/indicador de avisos en el panel; mensajes de ejemplo en Telegram.
- **Textos de ejemplo:** «¡Tu página ya está en internet! panaderialupita.<dominio>», «Tienes un cambio esperando tu aprobación».

## 4. Lo que el prototipo NO debe hacer ni prometer

- Jev (el asistente) nunca aprueba ni publica; solo clasifica y propone. Las decisiones quedan en el humano (`DEC-0019` comentario, `DEC-0043` §5, `RULE-004`, `BR-0004`).
- No publicar ni mostrar cambios visibles sin vista previa y aprobación (`RULE-003`, `REQ-005`).
- No inventar precios, descuentos, nombres comerciales de planes, límites ni políticas; usar marcadores tipo «[precio por definir]» (`RULE-005`, `RULE-006`, `REQ-019` OPEN, `BR-0005`).
- No mostrar cobros, pasarelas de pago ni conversión automática a plan de pago (`BR-0006`, `DEC-0018`).
- No usar datos reales de clientes; solo datos ficticios (`DEC-0019`).
- El bot de Telegram es de MainSpot, no del negocio; no ofrecer "crear tu propio bot" (`DEC-0041`).
- No ofrecer dominio propio ni elegir proveedor de hospedaje (`REQ-018`, `DEC-0042`).
- No mostrar datos de otros negocios ni confirmar su existencia (`REQ-008`, `NFR-002`).
- No incluir Google Business, WhatsApp, correo ni funciones para pymes/grandes (`REQ-013`, `DEC-0012`, `REQ-003`).
- No exponer jerga técnica ni estados internos sin traducir (`NFR-001`).

## 5. Entregables pedidos a Claude Design

1. **Mapa de flujos** (a)–(f), con ramas de error.
2. **Maquetas navegables en HTML estático**, móvil 360–414 px como principal y escritorio secundario; sin dependencias externas en tiempo de ejecución (`DEC-0040`).
3. **Inventario de pantallas y estados**: tabla pantalla × estado (incluidos todos los casos límite de §3) con ID estable por pantalla.
4. **Textos** finales en español cotidiano, en un archivo aparte.
5. **Tokens visuales básicos**: color (con contraste AA verificado), tipografía, espaciado, radios, estados de foco/error.
6. **Formato de revisión HDC**: carpeta de archivos estáticos con manifiesto (ruta + SHA-256 por archivo), sin recursos remotos, para que la aprobación quede ligada a los bytes (`DEC-0040`).

## 6. Criterios de aceptación para la revisión en HDC

- [ ] Cubre (a)–(f) en el orden decidido (`ANS-0009`) con todos los estados y casos límite de §3.
- [ ] Una persona sin conocimientos técnicos completa cada tarea sin ayuda externa (`AC-008`, `REQ-001`).
- [ ] Ningún texto contiene jerga técnica (`NFR-001`).
- [ ] Todo cambio visible pasa por vista previa y aprobación humana (`FLOW-002`, `RULE-003`, `RULE-004`).
- [ ] Estados de `DEC-0043` representados; "activo" solo tras verificación.
- [ ] Trial vigente/vencido y sin plan representados conforme a `DEC-0007`/`DEC-0018`.
- [ ] Ninguna promesa de §4 se incumple (precios, cobros, datos reales, Jev, bot).
- [ ] Contraste, foco visible, etiquetas y objetivos táctiles conformes a la meta WCAG 2.2 AA (`NFR-007`, meta).
- [ ] Entrega con manifiesto de hashes y sin recursos remotos (`DEC-0040`).

## 7. Decisiones abiertas y supuestos

**Abiertas (no diseñar como definitivas; mostrar como variante o marcador):**

| Tema | Fuente |
|---|---|
| Datos mínimos del alta, validación manual y consentimiento. | `FLOW-005` / `REQ-017` (PROPOSED) |
| Vigencia/revocación de la invitación (solo está decidido "un solo uso"). | `DEC-0039` |
| Duración exacta del código de Telegram ("corta vigencia"). | `DEC-0041`, `DEC-0043` |
| Caducidad concreta de la vista previa (configurable); audiencia y revocación masiva pendientes. | `DEC-0003` |
| Qué pasa con el sitio publicado al vencer el Trial; si generar código de Telegram cuenta como creación. | `DEC-0018` (conservación según políticas) |
| Canal y antelación del aviso de vencimiento; correo como canal. | `DEC-0018`, `REQ-003` (PROPOSED) |
| Nombres comerciales, precios y límites de planes. | `REQ-019` (OPEN), `RULE-006` |
| Accesibilidad como obligación formal. | `NFR-007` (PROPOSED) |
| Clarificación de intención en conversación. | `FLOW-001`, `REQ-004` (PROPOSED) |
| Dominio principal visible en la dirección del sitio. | `DEC-0004` (dominio real, nombre no fijado) |

**Supuestos explícitos:** datos ficticios (negocio de ejemplo «Panadería Lupita»); el propietario tiene perfil de administración de su negocio (`FR-0003`); vigencia Trial de 30 días como ejemplo (`DEC-0018`, "propuesta").

## 8. Estado actual (baseline; no reutilizar como diseño)

Existe una UI mínima de backoffice en `src/api/ui.ts` (login que pide identificador interno del negocio, panel por tarjetas: perfil, acciones rápidas, página web con subdominio simulado, redes, reseñas, plan y límites, actividad; vista previa pública). `docs/UX-CHECKLIST.md` registra lenguaje llano y WCAG en estado parcial. Es de escritorio, orientada a operación y no cubre invitación, Telegram bidireccional ni publicación real; sirve solo como referencia de contenidos.
