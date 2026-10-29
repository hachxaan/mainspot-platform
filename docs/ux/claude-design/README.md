# MainSpot · Claude Design
## Encargo de UX/UI: experiencia navegable del propietario

**Estado:** LISTO PARA DISEÑAR · **Entorno:** DESARROLLO · **Responsable de esta etapa:** Claude Design  
**Área de trabajo:** `docs/ux/claude-design/`  
**Entregables:** `docs/ux/claude-design/deliverables/`  
**Producto:** MainSpot (plataforma para micronegocios; usuario final sin conocimientos técnicos).

> **Misión:** crear una experiencia visual de alta calidad, **interactiva y recorrible de principio a fin**, con datos ficticios, para que el propietario evalúe la UX antes de que SOL MAIN implemente el producto. **No queremos más documentación de planificación como sustituto del diseño. Queremos un prototipo que se abra y funcione.**

### Autorización operativa y persistencia en GitHub (2026-10-29)

**Autorización expresa del propietario:** Claude Design **PUEDE crear, editar, versionar, hacer commits y push** de su trabajo de diseño, prototipos, recursos visuales, versiones intermedias y reportes en el repositorio `hachxaan/mainspot-platform`, rama **`feat/canonflow-implementation`**, **exclusivamente dentro de `docs/ux/claude-design/**`**. No necesita solicitar permiso en cada commit o ajuste de UX reversible.

Este permiso comprende `working/` (iteraciones), `deliverables/` (prototipo revisable), `reports/` (avance y comprobaciones), imágenes y otros recursos de diseño. Documenta brevemente avances y problemas reales en vez de crear gates formales. **Lee [WORKFLOW.md](WORKFLOW.md)** para el procedimiento exacto, seguridad y forma de entrega.

La autorización de escritura **no concede acceso técnico por sí sola**: si Claude no tiene GitHub conectado o permisos de push, debe entregar los archivos exportables en idéntica estructura, sin afirmar que hizo push. La propiedad del repositorio y el alcance autorizado no cambian.

**Fuentes de verdad intactas:** `.canonflow/`, `docs/ux/claude-design-brief.md`, código `src/`, infraestructura, contratos y HDC son de **solo lectura** para este encargo. Nada de producción; `QS-0015` no se responde.

**Complemento de visión del producto (iteración 2):** además del flujo de páginas, Google Maps/Business Profile y Facebook, **debe mostrarse un agente activo que detecta nuevas reseñas/comentarios, clasifica, atiende automáticamente lo autorizado por políticas y escala las excepciones al panel y Telegram con respuestas sugeridas**. Leer [AUTONOMOUS-ENGAGEMENT-UX.md](AUTONOMOUS-ENGAGEMENT-UX.md) antes de ampliar el prototipo. **Hoy las respuestas públicas siguen exigiendo aprobación humana por DEC-011; el modo autónomo se representa como diseño propuesto, no como comportamiento activo aprobado.**

**Nuevo mandato de desarrollo paralelo (2026-10-29):** [ITERATION-2-E2E-HANDOFF.md](ITERATION-2-E2E-HANDOFF.md) y [contrato compartido](../../handoffs/e2e-parallel-2026-10-29/SHARED-CONTRACT.md). El propietario autorizó trabajo de frontend y backend E2E **en paralelo sin gates HDC de desarrollo**. **Cada integración (Página Web, Google Maps, Facebook) tiene su propio «Otro número» independiente**; no hay un único teléfono alternativo. El prototipo y el backend pueden avanzar sin esperar revisión intermedia; conservar los DEC como historia y registrar decisiones operativas en el handoff. No confundir esto con una puesta en producción.

### 1. Qué leer y en qué orden

Los siguientes archivos YA existen. **No reescribas el canon ni inventes políticas de negocio.** Sus enlaces son relativos a la raíz del repositorio:

| Prioridad | Fuente | Uso |
|---|---|---|
| 1 | [Brief de diseño detallado](../claude-design-brief.md) | Fuente principal: flujos (a)–(f), estados, restricciones y decisiones abiertas. |
| 2 | [DEC-0039](../../../.canonflow/decision-records/DEC-0039.md) | Alta asistida por administrador, invitación de un solo uso, login sin `tenant_id`. |
| 3 | [DEC-0040](../../../.canonflow/decision-records/DEC-0040.md) | Prototipo navegable revisado/aprobado **antes** de implementar alta/panel/Telegram. |
| 4 | [DEC-0044](../../../.canonflow/decision-records/DEC-0044.md) | Orden: **alta y panel → Telegram → publicación real**. |
| 5 | [DEC-0041](../../../.canonflow/decision-records/DEC-0041.md) · [DEC-0042](../../../.canonflow/decision-records/DEC-0042.md) · [DEC-0043](../../../.canonflow/decision-records/DEC-0043.md) | Telegram, sitios por negocio, publicación y estados. |
| 6 | [Checklist UX](../../UX-CHECKLIST.md) | Problemas previos y criterios de interfaz. |
| Consulta | `src/api/ui.ts`, `README.md` del repo | Inventario de capacidades existentes, **no** diseño visual a copiar. |

**Jerarquía:** decisiones DEC aprobadas > brief (que las sintetiza) > este encargo (que organiza la entrega) > preferencias estéticas. Si encuentras una contradicción concreta, anótala en una sola línea y conserva el comportamiento aprobado. Los temas marcados **ABIERTO / PROPUESTO** no pasan a ser política definitiva porque aparezcan en la maqueta.

### 2. Resultado esperado: un recorrido completo, no pantallas aisladas

Elige **un negocio ficticio mexicano**, p. ej. «Panadería Lupita», con datos demostrativos coherentes durante todo el recorrido. La interfaz es para una persona que no es técnica, quizá usando únicamente su celular. La experiencia debe mostrar claramente **qué puede hacer, qué falta y qué pasó después de cada acción**.

Desarrolla las seis partes siguientes. Cada una debe ser navegable y tener estados alternativos demostrables:

#### A — Alta asistida e invitación
1. Vista **de demostración** del administrador de MainSpot: registrar negocio y propietario, asignar Trial y emitir invitación de un solo uso. No construir el backoffice administrativo real.
2. Propietario abre invitación, ve bienvenida con nombre del negocio, crea contraseña (requisitos comprensibles) y completa información básica del negocio.
3. Continuación hacia Telegram; sesión posterior mediante correo/usuario y contraseña **sin pedir identificador interno de negocio**.
4. Demostrar invitación utilizada, inválida, caducada/anulada (sin revelar existencia de cuentas) y validaciones de formulario.

#### B — Panel del propietario
1. Inicio con nombre del negocio, estado de sitio, pendientes, conexión Telegram, plan Trial, próximos pasos y actividad.
2. Perfil del negocio, Mi plan (estado y vencimiento) e historial de solicitudes/publicaciones.
3. Estados: negocio nuevo/sin sitio, pendientes 0 y >0, Trial vencido, permisos de solo lectura, error recuperable.
4. Diferenciar **ver / aprobar / ejecutar** según perfil, sin mostrar controles que el usuario no tiene permiso de utilizar.

#### C — Vinculación de Telegram (simulada)
1. Sin vincular → «Conectar Telegram» → código o enlace temporal ficticio con tiempo restante → conectado; opción desconectar.
2. Simular mensajes del bot y solicitud hecha desde Telegram, pero **sin llamadas reales** a Telegram.
3. Estados: código usado, expirado, revocado, chat no vinculado; posibilidad de regenerar un código.
4. Un solo bot de MainSpot para múltiples negocios; no ofrecer un bot propio por empresa.

#### D — Solicitar cambio, revisar y aprobar
1. Una solicitud de cambio concreta (p. ej. horario del sábado) iniciada por panel **y otra ilustrada desde Telegram**.
2. Explicación sencilla del cambio → confirmación → vista previa con **antes / después** → propietario **aprueba o rechaza**.
3. Mostrar publicación solo tras aprobación humana; incluir historial y confirmación de la acción.
4. Casos alternativos: solicitud ambigua (pedir aclaración), preview caducada/de un solo uso, rechazo, operación repetida (idempotencia conceptual), fallo recuperable, permiso insuficiente.
5. Jev/IA **puede proponer**, pero **nunca aprueba ni publica**.

#### E — Publicación y presencia web
1. Ver recorrido de estados **REGISTERED → PREPARING → CONFIGURING → VERIFYING → ACTIVE** con traducción al español cotidiano.
2. Mostrar **FAILED / RETRY_PENDING**, reintento y feedback. No presentar `ACTIVE` antes de representar una comprobación exitosa.
3. «Ver mi sitio», URL de demostración claramente ficticia y versión publicada anterior a la que podría regresarse; solo una **simulación de UX**, no DNS, HTTPS ni aprovisionamiento real.
4. El sitio se sirve en subdominio de MainSpot según la decisión aprobada; no ofrecer dominio propio o proveedores alternativos.

#### F — Avisos claros
1. Aviso de pendiente de aprobación, sitio disponible, publicación fallida y Trial próximo a vencer.
2. Bandeja en el panel y representación simulada de los mensajes de Telegram.
3. Estados sin avisos, leído / pendiente; acciones que llevan a la tarea relevante.

### 3. Mapa mínimo de vistas y demostraciones

Puedes unir pantallas si mejora la simplicidad; **no omitas flujos**. Usa identificadores de vista estables para que SOL MAIN pueda implementarlos:

| ID sugerido | Vista o flujo |
|---|---|
| `DS-01` | Alta administrada (demo) |
| `DS-02` | Invitación y bienvenida |
| `DS-03` | Contraseña y datos del negocio |
| `DS-04` | Login del propietario |
| `DS-05` | Dashboard / inicio |
| `DS-06` | Negocio, plan e historial |
| `DS-07` | Telegram: vincular/desvincular |
| `DS-08` | Solicitudes, aclaración y pendientes |
| `DS-09` | Comparación antes/después y vista previa |
| `DS-10` | Aprobar/rechazar y confirmación |
| `DS-11` | Publicación, verificación, fallo y reintento |
| `DS-12` | Bandeja de avisos y estados especiales |

Además del recorrido principal, construye una forma **visible y fácil** de recorrer los casos alternativos (por ejemplo, «Probar estados» dentro del prototipo), identificada como **herramienta de demostración**, jamás como parte del producto final.

### 4. Dirección UX y diseño visual

- **Mobile-first real:** diseñar y comprobar a 360, 390 y 414 px; adaptar a escritorio (p. ej. 1280/1440 px). No simplemente comprimir un dashboard de escritorio.
- **Impresión buscada:** producto profesional, humano, confiable, moderno y muy fácil de usar; sin sensación de software empresarial complicado. Jerarquía clara, espaciado generoso, navegación breve, tarjetas sobrias y estados legibles.
- **Idioma:** español mexicano natural y sencillo; frases cortas, verbos concretos y errores que expliquen qué hacer. **No** escribir «tenant», «token», «webhook», «DNS», «deploy», «403», «RBAC» al usuario final.
- **Una acción principal por vista**, con acciones secundarias discretas; etiquetas comprensibles; no depender solo de iconos, colores o animaciones.
- **Accesibilidad:** meta WCAG 2.2 AA; contraste, foco de teclado, campos etiquetados, errores junto al campo, controles táctiles cómodos, estados anunciables y movimiento reducido. Ninguna acción importante debe depender de pasar el mouse.
- **Criterio creativo:** Claude Design decide tipografía, paleta, componentes y microinteracciones. No extrapolar un sistema visual no aprobado de la UI interna actual. No necesitas pedir autorización para decisiones estéticas reversibles.
- **Contenido ilustrativo, no promesas:** no inventar nombres/precios de paquetes, límites, plazos, políticas de seguridad, integración con Google Business/WhatsApp, opciones de pago ni automatizaciones comerciales fuera del MVP. `Trial` y avisos de vencimiento solo según el brief, y cualquier fecha o duración mostrada se etiqueta como **dato ficticio**.
- **Estados consistentes:** loading, vacío, éxito, error, deshabilitado, expirado, pendiente y confirmación. Evitar acciones visualmente activas que no hagan nada.

### 5. Requisitos técnicos del prototipo (NO del producto)

Crear un **prototipo HTML/CSS/JS realmente navegable**, ejecutable en navegador sin iniciar backend. Puede usarse un único `index.html` autocontenido o archivos estáticos locales. Debe funcionar **sin dependencias externas ni llamadas a Internet en tiempo de ejecución**. Todos los datos, mensajes y eventos son ficticios.

- Los botones y formularios deben tener comportamiento simulado coherente; pantalla y estado se actualizan, volver funciona, se puede reiniciar la demo.
- Simular flujo de invitación one-use, creación de contraseña (nunca guardar contraseñas reales), vínculo con Telegram, aprobaciones y ciclo de publicación; **no** usar APIs reales, cuentas ni credenciales.
- Simular estado, temporizadores y errores sin presentar garantías de backend que todavía no existen. Cualquier persistencia local (si la usas) contiene **solo datos ficticios** y debe ser reiniciable.
- Si trabajas con una herramienta de diseño que no puede escribir archivos directamente, exporta un **paquete HTML estático** con la estructura de la §6 para que pueda incorporarse tal cual al repositorio. No uses capturas como único entregable.
- Para revisión, deja una ruta feliz completa y al menos un camino de error/recuperación que una persona pueda ejecutar sin instrucciones técnicas.

### 6. Ubicación, versiones y entrega

**Toda la producción de Claude Design se guarda exclusivamente en `docs/ux/claude-design/`**, conforme a la autorización operativa al inicio. No se limita a los archivos finales: puede persistir el proceso completo, decisiones de diseño reversibles, recursos visuales, evidencias y reportes.

```text
docs/ux/claude-design/
├── README.md                     # Este encargo y fuentes: conservar
├── WORKFLOW.md                   # Reglas para trabajar, commit y push
├── working/
│   └── README.md                 # Borradores, iteraciones y exploraciones
├── reports/
│   ├── README.md                 # Formato mínimo de reportes
│   └── PROGRESS.md               # Estado actual, avances y bloqueos
└── deliverables/
    ├── README.md                 # Instrucciones de entrega (ya existe)
    ├── index.html                # Prototipo navegable, punto de entrada
    ├── SCREEN-MAP.md             # IDs de pantallas, acciones y estados
    ├── manifest.sha256           # SHA-256 de cada archivo final
    └── assets/                   # Recursos locales, solo si se necesitan
```

- Los directorios `working/` y `reports/` pueden contener archivos adicionales conforme evolucionen los prototipos; mantener nombres claros y evitar duplicación innecesaria.
- `deliverables/index.html`: debe poder abrirse con doble clic o documentar la necesidad de un servidor estático local; **sin llamadas externas en tiempo de ejecución**.
- `SCREEN-MAP.md`: tabla breve de vista → acciones → estado siguiente → errores, más una demostración de máximo dos minutos.
- `manifest.sha256`: incluir los archivos finales (HTML, mapa, assets) calculando los hashes **sobre los bytes finales**, no incluirse a sí mismo ni materiales de trabajo.
- Hacer commit y **push directo a `feat/canonflow-implementation`**, verificando el HEAD previo y sin force-push. Esta acción queda autorizada dentro de la carpeta propia, sin aprobación por commit.
- Al terminar cada iteración útil, actualizar `reports/PROGRESS.md` y señalar el commit y los enlaces de la versión navegable; no generar reportes extensos.
- **No cambiar este documento de requisitos** durante la producción del diseño, salvo correcciones operativas sin impacto en el canon. No modificar fuera de esta carpeta.
- Si GitHub está disponible solo en lectura o falla el push, exportar todos los archivos conservando esta estructura y comunicar claramente que quedaron pendientes de publicar.
- Si debes priorizar una sola salida: **`deliverables/index.html` plenamente navegable**; después mapa, manifiesto y reporte breve.

### 7. Criterios de aceptación: demostrar, no solo declarar

El diseño está listo para revisión cuando:

- [ ] Una persona puede recorrer **alta → primer dashboard → Telegram → petición → preview → aprobación → publicación verificada** desde un navegador.
- [ ] La primera publicación se realiza solo tras aprobación simulada del propietario, y `ACTIVE` solo tras verificación simulada.
- [ ] Se puede repetir el recorrido con datos ficticios, reiniciar la demo y abrir variantes de error sin modificar código.
- [ ] Invitación expirada, código de Telegram inválido, permiso insuficiente, Trial vencido, preview vencida y fallo/reintento de publicación están representados.
- [ ] No hay controles principales inertes, navegación rota o texto técnico innecesario.
- [ ] Comprobado en móvil y escritorio, con navegación de teclado básica y contraste legible.
- [ ] `index.html` y mapa están disponibles para abrir, y las huellas se calcularon sobre los **bytes finales entregados**.

**Ciclo recomendado:** crear una primera versión navegable completa → revisarla visualmente con el propietario → iterar sobre esa versión → entregar archivos y hashes finales. **Una aprobación de diseño** conforme a DEC-0040 cuando el propietario quede satisfecho, no una decisión HDC por ajuste visual.

### 8. Lo que NO está autorizado ni bloquea el diseño

- No implementar backend, login real, bot real, DNS, certificados, publicación comercial ni tocar ambientes.
- No mover datos de clientes, llamar APIs externas, pagar servicios ni publicar sitios productivos.
- No modificar `.canonflow/`, `.canonflow-updates/`, `src/`, `scripts/`, contratos, DEC aprobadas o estado de respaldo.
- **QS-0015 sigue PENDING** y los respaldos remotos siguen desactivados; Gate 7 no bloquea esta tarea de UX.
- Desarrollo no es producción. **El propietario declarará explícitamente la transición a producción.**
- No crear nuevos gates por decisiones de estilo; solo escalar conflictos con una decisión existente o acciones fuera del alcance.

### 9. Handoff directo a SOL MAIN, tras aprobación del propietario

Entrega un prototipo estable y navegable + inventario de pantallas/estados + manifesto SHA-256. SOL MAIN implementará verticalmente **alta/panel → Telegram → publicación real de desarrollo**, reutilizando backend y contratos existentes donde aplique. El prototipo es la referencia de UX aprobada, no un reemplazo de la documentación canónica ni una autorización de puesta en producción.

**Definición de éxito:** que el propietario pueda decir «así quiero que funcione MainSpot» **viendo y utilizando** la interfaz, no interpretando documentos.
