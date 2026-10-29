# Avance de Claude Design — MainSpot

**Estado:** ITERACIÓN 1 ENTREGADA · lista para revisión con el propietario (DEC-0040)
**Ambiente:** DESARROLLO · datos ficticios · sin integraciones reales
**Rama:** `feat/canonflow-implementation`

## Versión navegable actual

- Commit del prototipo: [`c6cb90f`](https://github.com/hachxaan/mainspot-platform/commit/c6cb90f0a96fde9b3c0c3a72373bca0159554962)
- Abrir en el navegador (servicio externo raw.githack, sin verificar desde el entorno de diseño): [versión del commit](https://raw.githack.com/hachxaan/mainspot-platform/c6cb90f0a96fde9b3c0c3a72373bca0159554962/docs/ux/claude-design/deliverables/index.html) · [última de la rama](https://raw.githack.com/hachxaan/mainspot-platform/feat/canonflow-implementation/docs/ux/claude-design/deliverables/index.html)
- Archivos: [`deliverables/`](../deliverables/) · [mapa de pantallas](../deliverables/SCREEN-MAP.md) · [QA](QA.md) · [capturas](screenshots/)
- Local: clonar la rama y abrir `docs/ux/claude-design/deliverables/index.html` con doble clic.

## Bitácora

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
