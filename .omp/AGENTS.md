# MainSpot — contexto persistente del agente OMP

## Entorno local oficial

- Producto: MainSpot (`hachxaan/mainspot-platform`).
- URL local HTTPS (para todas las pruebas de interfaz, enlaces y reportes): **https://app.mainspot.local.io**.
- Hostname correcto: **app.mainspot.local.io**. Cualquier indicación previa `app.mainpot.local.io` fue un error tipográfico y queda sustituida.
- Resolución local en el host: `10.209.99.101 app.mainspot.local.io` en `/etc/hosts`.
- Reverse proxy HTTPS en LXC `webserver` IP `10.209.99.101`; certificado de CA local confiable para el dominio; upstream hacia Express de MainSpot en el host (puerto interno 3100 en el entorno actual, dirección de host accesible desde el LXC definida en el bootstrap).
- `PUBLIC_BASE_URL=https://app.mainspot.local.io`; cualquier invitación/enlace generado debe respetar ese origen, sin guardar tokens activos en repositorios o issues.
- Google, Meta y Telegram son simulados en desarrollo hasta verificar sus adaptadores e integraciones reales.

## Política de ejecución

**Configuración del dominio/proxy/certificados = trabajo único.** Hacer bootstrap y validación inicial una sola vez cuando se encargue. En sesiones siguientes de OMP **asumir esta infraestructura preparada y no hacer auditorías, reconfiguraciones ni comprobaciones preventivas de que esté configurada**. Iniciar y probar MainSpot directamente mediante `https://app.mainspot.local.io`; solo depurar proxy/CA/hosts ante fallo comprobado del dominio.

Los scripts de arranque normales NO deben hacer bootstrap de hosts/proxy/TLS ni verificar sus archivos; pueden verificar que **la aplicación** está operando cuando sea relevante para el test funcional.

Para pruebas E2E, la URL base local será `https://app.mainspot.local.io` y nunca el puerto interno como vía principal. La seguridad TLS debe validarse normalmente, sin ignorar los errores de certificados.

Usar este archivo y `.omp/RULES.md` como memoria persistente de proyecto en todas las sesiones OMP iniciadas dentro del repositorio. Si OMP se lanza desde un directorio padre distinto, el agente local debe asegurar que también se cargue esta regla en el perfil OMP activo (por ejemplo, una referencia acotada a MainSpot en el archivo de reglas del perfil); preservar cualquier regla previa.

Trabajo de software en desarrollo autónomo y E2E, sin HDC intermedio, manteniendo los controles del producto y sin realizar cambios de producción. No editar ni regenerar certificados de otros dominios.
