# Claude Design · Flujo operativo de trabajo y GitHub

**Área de escritura autorizada:** `docs/ux/claude-design/**` en la rama `feat/canonflow-implementation` del repositorio `hachxaan/mainspot-platform`. Esta autorización proviene del propietario (2026-10-29) y permite **crear, modificar, versionar, commitear y hacer push directamente** de prototipos, trabajo en progreso, imágenes/recursos, reportes, evidencias y entregables. **No exige una aprobación por commit.**

## 1. Arrancar y trabajar

1. Leer `README.md` y `../claude-design-brief.md`; respetar las decisiones DEC aprobadas allí citadas.
2. Consultar la rama remota `feat/canonflow-implementation` y su HEAD. Trabajar sobre el último HEAD; **no rebasar ni sobrescribir trabajo ajeno**.
3. Construir primero el recorrido **navegable E2E** con datos ficticios: alta → panel → Telegram → solicitud → preview → aprobación → publicación simulada verificada.
4. Guardar borradores, exploraciones y avances parciales en `working/`. Probar interacciones en un navegador en móvil y escritorio.
5. Preparar la versión revisable bajo `deliverables/`. Actualizar `reports/PROGRESS.md` con evidencia compacta y siguientes pasos.
6. Hacer commit y push del trabajo útil a **la misma rama**. Entregar rutas y URLs de GitHub que puedan abrirse sin el entorno local. No anunciar push ni pruebas exitosas sin comprobarlos.

## 2. Dónde guardar cada cosa

| Directorio | Tipo de archivo permitido |
|---|---|
| `working/` | Exploraciones visuales, variantes de componentes, prototipos intermedios, tokens visuales, notas de interacción. |
| `deliverables/` | Prototipo HTML/CSS/JS estático y navegable, assets locales, SCREEN-MAP y manifest.sha256 final. |
| `reports/` | PROGRESS.md, comprobaciones UX y de accesibilidad, screenshots de prueba, reportes de recorrido, handoff a SOL MAIN. |

Se permiten otros archivos auxiliares **dentro de esta carpeta** si agregan valor al diseño. Mantener el paquete liviano y fácil de revisar: no versionar dependencias instaladas, cachés, secretos, credenciales, datos de usuarios, videos enormes ni volcados de depuración. Las capturas deben usar **solo datos ficticios**.

`manifest.sha256` describe únicamente el conjunto final aprobado: computar hashes de los bytes finales, incluyendo recursos estáticos necesarios, **sin incluirse a sí mismo**. Antes de aprobar por `DEC-0040` debe ser idéntico al prototipo revisado; mientras esté en desarrollo se pueden rehacer versiones sin sesiones HDC nuevas.

## 3. Permisos y límites

**Permitido:** modificar, crear y borrar **tus propios archivos** de diseño dentro de `docs/ux/claude-design/`; iterar con autonomía estética y técnica sobre el prototipo; hacer commits y pushes no forzados; actualizar progreso; documentar pruebas y recomendaciones; informar en el issue [#3](https://github.com/hachxaan/mainspot-platform/issues/3) avances del prototipo si el acceso a GitHub lo permite.

**Solo lectura / prohibido editar con este encargo:** `.canonflow/`, `.canonflow-updates/`, `src/`, `scripts/`, `docs/contracts/`, `docs/ux/claude-design-brief.md`, README raíz, infraestructura, decisiones HDC, otros directorios del repositorio. Tampoco responder `QS-0015`, emitir DEC ni activar respaldos, cambiar credenciales, llamar APIs reales de Telegram/DNS o publicar sitios comerciales.

No forzar pushes ni alterar el historial Git. Si otra persona avanzó la rama, incorporar el HEAD actual conservando sus cambios. Si hay conflicto en tus archivos, resolver sin borrar trabajo ajeno; escalar únicamente cuando el conflicto cambie una decisión aprobada.

La autorización **no instala ni conecta GitHub por sí misma**. Si la integración no permite escribir, exportar un paquete exacto y explicar qué no fue publicado. No inventar confirmaciones.

## 4. Ritmo de entrega, sin burocracia

- **Primera prioridad:** que el usuario pueda abrir y recorrer el prototipo.
- Reportar por hito útil, no por microdecisión. Una entrada corta en `reports/PROGRESS.md` basta.
- Para cada iteración: qué se ve, qué funciona, qué probaste realmente, qué queda. Distinguir **probado** de **simulado** y **pendiente**.
- No iniciar una investigación prolongada, rediseñar el método o solicitar un HDC por decisiones estéticas reversibles.
- El diseño puede evolucionar libremente hasta revisión final. La **aprobación de referencia** exigida por `DEC-0040` sucede al cerrar el prototipo, antes de construir el frontend integrado con backend.

## 5. Handoff listo para ingeniería

Entregar:
- Enlace al `deliverables/index.html` y método comprobado para abrirlo.
- `SCREEN-MAP.md` con estados y rutas.
- `manifest.sha256` y SHA del commit.
- Reporte breve de funcionalidad, pruebas de móvil/escritorio, accesibilidad básica, limitaciones verdaderas.
- Notas suficientes para que SOL MAIN reproduzca la UX, sin rediseñarla.

**MainSpot está en desarrollo, no en producción.** Este permiso abarca exclusivamente diseño y persistencia en GitHub.
