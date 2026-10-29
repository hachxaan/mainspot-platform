# Entregables de Claude Design

Versión navegable del flujo del propietario de MainSpot (**iteración 2**, en desarrollo): página web, Google Maps, Facebook, teléfonos independientes por canal y agente de atención. El encargo y sus criterios están en [../README.md](../README.md).

## Cómo abrirlo

- **Local:** doble clic en [`index.html`](index.html). No necesita servidor ni internet.
- **En línea:** el enlace de vista directa está en [../reports/PROGRESS.md](../reports/PROGRESS.md).
- Para empezar de cero: «Probar estados» → «Reiniciar la demo».

## Contenido

| Archivo | Qué es |
|---|---|
| `index.html` | Punto de entrada del prototipo |
| `assets/css/app.css` | Estilos y tokens visuales (`:root`) |
| `assets/js/*.js` | Pantallas, estado simulado y herramienta de demostración |
| `assets/fonts/` | Bricolage Grotesque y Atkinson Hyperlegible Next (SIL OFL 1.1, licencias incluidas) |
| `assets/js/icons.js` | Iconos Lucide como sprite local (ISC, licencia incluida) |
| `assets/vendor/libphonenumber-min.js` | Validación de teléfonos por país (libphonenumber-js, MIT, licencia incluida) |
| [`SCREEN-MAP.md`](SCREEN-MAP.md) | Pantallas DS-01…DS-17, teléfonos por canal, estados y demostraciones |
| `manifest.sha256` | Huellas SHA-256 de todos los archivos de esta carpeta, salvo el propio manifiesto |

Todo es ficticio: no hay llamadas a Telegram, Google, Meta, DNS, publicación real ni ningún servicio externo. No es código de producción ni una decisión nueva; es la referencia de UX a revisar conforme a DEC-0040.

Comprobar huellas: `cd docs/ux/claude-design/deliverables && sha256sum -c manifest.sha256`
