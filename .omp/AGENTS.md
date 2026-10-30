# MainSpot · contexto persistente de entorno de desarrollo

## Convención de acceso

La URL de desarrollo para **la aplicación y las pruebas E2E en navegador** es **`https://app.mainspot.local.io`**. Usar la grafía literal `mainspot`. El hostname anterior `app.mainpot.local.io` fue un error tipográfico: no utilizarlo.

Topología: resolución local mediante `/etc/hosts` del host → `10.209.99.101` (LXC `webserver`) → proxy inverso HTTPS con CA de confianza local → proceso MainSpot Express en el host (puerto interno inicialmente 3100) → PostgreSQL y worker existentes.

## Instalación inicial: una vez, fuera del arranque normal

La **primera** configuración del host comprende, solo si aún no fue ejecutada: añadir una entrada `/etc/hosts`, crear virtual host en el servidor proxy existente del LXC sin alterar otros sitios, certificado con SAN `app.mainspot.local.io` firmado por una CA local confiada por el navegador, proxy al host realmente accesible desde el LXC, configurar `PUBLIC_BASE_URL` y actualizar pruebas de navegador a HTTPS. Durante esa única instalación se valida HTTPS, proxy, invitaciones, panel, APIs y tests E2E. La guía de instalación puede vivir en `docs/development/` y el comando one-shot independiente; **no se debe integrar el aprovisionamiento a `scripts/dev-panel.sh`**.

**Una vez completada:** no revisar si el proxy, certificado o `/etc/hosts` «ya estaban configurados» en cada arranque o sesión. La infraestructura se considera persistente y lista; iniciar MainSpot normalmente y probar el producto contra el dominio. Solo diagnosticar/reparar si ocurre un error real. El arranque del servidor no requiere renovación ni instalación de certificados, ni intervención de infraestructura.

## Enlaces y pruebas

El usuario recibe `https://app.mainspot.local.io/`, `https://app.mainspot.local.io/panel` o enlaces de invitación a través de ese dominio; en documentación pública se usa `/invitacion#<TOKEN>` como ejemplo, **nunca** un token real.

El navegador y Playwright deben probar a través del HTTPS canónico con verificación de CA activa. Pruebas unitarias o HTTP internas pueden usar loopback cuando eso sea parte de su naturaleza, pero no reemplazan los recorridos E2E oficiales a través del proxy.

Conservar la plataforma en desarrollo, sin introducir acciones de producción ni alterar servicios ajenos. Google, Meta y Telegram permanecen simulados hasta disponer de evidencia de integración externa real. 
