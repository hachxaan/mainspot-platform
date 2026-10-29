# Avance de Claude Design — MainSpot

**Estado:** ITERACIÓN 2 ENTREGADA · E2E navegable en paralelo con SOL MAIN (sin HDC, por mandato del propietario)
**Ambiente:** DESARROLLO · datos ficticios · sin integraciones reales
**Rama:** `feat/canonflow-implementation`

## Versión navegable actual

- Commit del prototipo: [`c27a930`](https://github.com/hachxaan/mainspot-platform/commit/c27a93089c4e6e5e192acf6e32aa884a6304f012)
- Abrir en el navegador (servicio externo raw.githack, sin verificar desde el entorno de diseño): [versión del commit](https://raw.githack.com/hachxaan/mainspot-platform/c27a93089c4e6e5e192acf6e32aa884a6304f012/docs/ux/claude-design/deliverables/index.html) · [última de la rama](https://raw.githack.com/hachxaan/mainspot-platform/feat/canonflow-implementation/docs/ux/claude-design/deliverables/index.html)
- Archivos: [`deliverables/`](../deliverables/) · [mapa de pantallas](../deliverables/SCREEN-MAP.md) · [QA](QA.md) · [capturas](screenshots/)
- Local: clonar la rama y abrir `docs/ux/claude-design/deliverables/index.html` con doble clic.

## Bitácora

### 2026-10-29 · Iteración 2 · `c27a930`

**Completado.** Un solo producto con navegación Inicio · Mi página · Google · Facebook · Atención. Teléfono principal y **«Usar mi número» / «Otro número» independiente en cada canal** con país/prefijo, validación E.164, número efectivo y sincronización simulada; la web publica el número nuevo tras vista previa y aprobación. Google Maps y Facebook simulados (ficha, publicaciones con aprobación y programación, comentarios). Agente de atención con bandeja única, reglas «Qué puede responder MainSpot por mí» con opt-in explícito y versiones, respuestas automáticas simuladas, casos humanos con 3 propuestas resueltos desde panel o Telegram con una sola resolución, duplicados, reintentos, pausa y permisos.

**Probado realmente** (Chromium headless, `file://`): TEL-01..04, AG-01..04, FLOW-01/02 en 24/24 comprobaciones a 360, 390 y 1440 px; 15 casos alternativos; regresión de la iteración 1; sin desplazamiento horizontal de 360 a 1440 px; axe-core sin infracciones en 23 pantallas. Todo `simulated`, ningún PASS real de Google/Meta. Detalle en [QA.md](QA.md).

**Alineación con SOL MAIN** (`ba1b8fc`, `73b4413`): mismo modelo de teléfonos (`mode` + `other` por canal, `other→own` conserva) y mismo flujo del agente (opt-in con consentimiento, 3 propuestas, mismo caso en panel y Telegram). Diferencia de UX propuesta: en el prototipo «cambia mi teléfono» por chat lleva a la tarjeta del canal en vez de editar el campo del sitio, para que nunca haya dos fuentes del número. Las decisiones de UX quedan aquí y en [SCREEN-MAP](../deliverables/SCREEN-MAP.md); el `DECISION-LOG` está fuera de mi carpeta autorizada.

**Pendiente.** Safari iOS, Firefox y lector de pantalla; afinar 1024–1279 px; textos finales y hoja de tokens; conectar con los datos reales de la API de SOL MAIN cuando se implemente el frontend.

### 2026-10-29 · Iteración 1 · `c6cb90f`

**Completado.** Recorrido de punta a punta DS-01…DS-12: alta administrada (demo) → invitación de un solo uso → contraseña y datos → Telegram simulado (código con vigencia, anular, conectar, desconectar) → panel → primera página aprobada y publicada → cambio por panel y por Telegram → vista previa Antes/Después → aprobación humana → publicación con estados DEC-0043, fallo y reintento → avisos, historial y versiones. Herramienta «Probar estados» para perfiles, Trial, invitación, Telegram, vistas previas, fallos y errores. Dirección visual propia ([working/DESIGN-DIRECTION.md](../working/DESIGN-DIRECTION.md)).

**Probado realmente** (Chromium headless, `file://`): recorrido completo a 360, 390 y 1440 px sin errores; más de 25 casos alternativos a 390 y 414 px; sin desplazamiento horizontal de 360 a 1440 px; axe-core sin infracciones WCAG A/AA en 17 pantallas; teclado en flujo de aprobación. Detalle en [QA.md](QA.md).

**Simulado.** Interpretación del lenguaje (reglas), Telegram, publicación, tiempos (acelerados), fechas y vigencias.

**Pendiente / siguiente iteración.**
1. Revisión con el propietario y ajustes de lo que no le convenza.
2. Probar en Safari iOS, Firefox y con lector de pantalla.
3. Archivo de textos finales y hoja de tokens (brief §5.4–5.5); hoy los tokens viven en `assets/css/app.css`.
4. Aprovechar mejor el escritorio de 1024–1279 px (sin chat lateral) y afinar transiciones entre pantallas.
5. Decisiones abiertas que siguen como «Prototipo:» (campos del alta, vigencias, dominio, Trial vencido, recuperación de contraseña, canal de contacto).

**Contradicciones con decisiones aprobadas:** ninguna detectada.
