# MainSpot — contexto persistente del agente OMP

## Entorno local oficial

- Producto: MainSpot (`hachxaan/mainspot-platform`).
- URL local HTTPS (para todas las pruebas de interfaz, enlaces y reportes): **https://app.mainspot.local.io**.
- Hostname correcto: **app.mainspot.local.io**. Cualquier indicación previa `app.mainpot.local.io` fue un error tipográfico y queda sustituida.
- Resolución local en el host: `10.209.99.101 app.mainspot.local.io` en `/etc/hosts`.
- Reverse proxy HTTPS en LXC `webserver` IP `10.209.99.101`; certificado de CA local confiable para el dominio; upstream hacia Express de MainSpot en el host (puerto interno 3100 en el entorno actual, dirección de host accesible desde el LXC definida en el bootstrap).
- `PUBLIC_BASE_URL=https://app.mainspot.local.io`; cualquier invitación/enlace generado debe respetar ese origen, sin guardar tokens activos en repositorios o issues.
- Google, Meta y Telegram son simulados en desarrollo hasta verificar sus adaptadores e integraciones reales.

## Estado instalado (bootstrap único del 2026-10-30)

- Upstream: nginx del LXC `webserver` → `http://10.209.99.1:3100` (IP del host en `lxdbr0`; `127.0.0.1` dentro del LXC NO es el host). Vhost versionado en `scripts/deploy/app.mainspot.local.io.conf`; acceso limitado al host. Se sirve en HTTP/1.1 a propósito: no activar `http2` (en nginx 1.18 afecta a todos los sitios del socket `*:443`).
- Solo ante fallo real: si Chrome falla de forma intermitente en el dominio (`net::ERR_NETWORK_CHANGED`, POST con 499 en nginx, scripts del panel sin cargar), la causa conocida son contenedores Docker en bucle de reinicio que crean y borran interfaces veth (`docker ps -a | grep Restarting`). Son servicios ajenos: pedir autorización antes de detenerlos.
- TLS: certificado emitido por la CA local mkcert del host (ya confiable en el almacén del sistema y en NSS de Chrome/Playwright); la clave solo vive en el LXC. Node confía con `--use-system-ca` o `tls.setDefaultCACertificates` (lo hace el E2E).
- Reinstalación en una máquina nueva: `scripts/dev-domain-bootstrap.sh` (comando aparte, nunca desde `scripts/dev-panel.sh`). Evidencia: `evidence/dev-domain-bootstrap.txt`.
- Arranque diario: `scripts/dev-panel.sh` (servidor + worker en el puerto 3100, `PUBLIC_BASE_URL=https://app.mainspot.local.io`).
- E2E de navegador (`tests/e2e/ui-e2e-03.test.ts`): `E2E_BASE_URL` (por defecto `https://app.mainspot.local.io`) y `E2E_UPSTREAM_PORT` (3100). La prueba arranca su propio servidor como upstream del proxy, así que necesita el puerto 3100 libre: detener `scripts/dev-panel.sh` mientras corre y volver a arrancarlo después. Si el puerto está ocupado falla con mensaje explícito, sin atajos.

## Política de ejecución

**Configuración del dominio/proxy/certificados = trabajo único.** Hacer bootstrap y validación inicial una sola vez cuando se encargue. En sesiones siguientes de OMP **asumir esta infraestructura preparada y no hacer auditorías, reconfiguraciones ni comprobaciones preventivas de que esté configurada**. Iniciar y probar MainSpot directamente mediante `https://app.mainspot.local.io`; solo depurar proxy/CA/hosts ante fallo comprobado del dominio.

Los scripts de arranque normales NO deben hacer bootstrap de hosts/proxy/TLS ni verificar sus archivos; pueden verificar que **la aplicación** está operando cuando sea relevante para el test funcional.

Para pruebas E2E, la URL base local será `https://app.mainspot.local.io` y nunca el puerto interno como vía principal. La seguridad TLS debe validarse normalmente, sin ignorar los errores de certificados.

Usar este archivo y `.omp/RULES.md` como memoria persistente de proyecto en todas las sesiones OMP iniciadas dentro del repositorio. Si OMP se lanza desde un directorio padre distinto, el agente local debe asegurar que también se cargue esta regla en el perfil OMP activo (por ejemplo, una referencia acotada a MainSpot en el archivo de reglas del perfil); preservar cualquier regla previa.

Trabajo de software en desarrollo autónomo y E2E, sin HDC intermedio, manteniendo los controles del producto y sin realizar cambios de producción. No editar ni regenerar certificados de otros dominios.
