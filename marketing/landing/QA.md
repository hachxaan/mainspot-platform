# MainSpot Landing · QA de desarrollo

Fecha: 2026-10-29/30 · Entorno: Chromium headless con Playwright, assets inyectados desde archivos locales.

## Resultados observados

| Caso | Escritorio (1440 px) | Móvil (390 px) |
|---|---|---|
| Render sin excepciones JS | PASS | PASS |
| Un solo h1 | PASS | PASS |
| CSS cargado | PASS | PASS |
| Menú móvil abre/cierra | No aplica | PASS |
| Vista previa de cambio | PASS | PASS |
| Reseña negativa -> 3 respuestas | PASS | PASS |
| Elegir tercera respuesta | PASS | PASS |
| Acción demostrativa sin publicación | PASS | PASS |
| Validación y preparación de solicitud | PASS | PASS |
| Ausencia de scroll horizontal | PASS | PASS |

Se verificó ausencia de scroll horizontal en 320, 360, 375, 390, 414, 768, 1024 y 1440 px. Se corrigió un desbordamiento de elementos decorativos en móvil antes de registrar PASS.

## Límites de prueba

El entorno de Chromium bloqueó por política la navegación directa a `localhost` y `file://`. Para las pruebas visuales se usó `page.set_content` y se inyectaron exactamente los archivos CSS y JS generados. **Esto prueba render e interacciones en el navegador, pero no equivale a una prueba HTTP E2E.** No se ejecutaron Lighthouse, axe-core ni auditoría completa WCAG 2.2 AA. Las capturas son evidencia de render, no de integración con servicios reales.

## Pendientes para salida comercial

1. Confirmar canal de contacto/endpoint para almacenar leads con consentimiento y aviso de privacidad.
2. Validar estados efectivos de integración de Google, Meta y Telegram; revisar todos los claims.
3. Definir planes y precios autorizados.
4. Aprobar dominio y publicar Open Graph de formato PNG/JPEG con URL absoluta.
5. Ejecutar auditoría externa de accesibilidad, Lighthouse y QA HTTP/HTTPS en staging.
6. Retirar `noindex` exclusivamente en el lanzamiento autorizado.

## Riesgo de promesas comerciales

La demo solo simula casos con nombres ficticios. No hay respuesta automática real, publicaciones ni captación en backend. El formulario no incluye `fetch()`, `XMLHttpRequest` ni almacenamiento persistente. El usuario recibe una declaración clara antes y después de usarlo.