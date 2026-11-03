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
- Arranque persistente: `mainspot-local.service` ejecuta `scripts/dev-panel.sh` (servidor + un único worker integrado en el puerto 3100, `PUBLIC_BASE_URL=https://app.mainspot.local.io`). Usar `sudo systemctl restart mainspot-local`; no lanzar una segunda instancia manual.
- E2E de navegador (`tests/e2e/ui-e2e-03.test.ts`): `E2E_BASE_URL` (por defecto `https://app.mainspot.local.io`) y `E2E_UPSTREAM_PORT` (3100). La prueba arranca su propio servidor como upstream del proxy, así que necesita el puerto 3100 libre: detener `mainspot-local.service` mientras corre y volver a arrancarlo después. Si el puerto está ocupado falla con mensaje explícito, sin atajos.

## Política de ejecución

**Configuración del dominio/proxy/certificados = trabajo único.** Hacer bootstrap y validación inicial una sola vez cuando se encargue. En sesiones siguientes de OMP **asumir esta infraestructura preparada y no hacer auditorías, reconfiguraciones ni comprobaciones preventivas de que esté configurada**. Iniciar y probar MainSpot directamente mediante `https://app.mainspot.local.io`; solo depurar proxy/CA/hosts ante fallo comprobado del dominio.

Los scripts de arranque normales NO deben hacer bootstrap de hosts/proxy/TLS ni verificar sus archivos; pueden verificar que **la aplicación** está operando cuando sea relevante para el test funcional.

Para pruebas E2E, la URL base local será `https://app.mainspot.local.io` y nunca el puerto interno como vía principal. La seguridad TLS debe validarse normalmente, sin ignorar los errores de certificados.

Usar este archivo y `.omp/RULES.md` como memoria persistente de proyecto en todas las sesiones OMP iniciadas dentro del repositorio. Si OMP se lanza desde un directorio padre distinto, el agente local debe asegurar que también se cargue esta regla en el perfil OMP activo (por ejemplo, una referencia acotada a MainSpot en el archivo de reglas del perfil); preservar cualquier regla previa.

Trabajo de software en desarrollo autónomo y E2E, sin HDC intermedio, manteniendo los controles del producto y sin realizar cambios de producción. No editar ni regenerar certificados de otros dominios.

## Telegram — instalación persistente Starlink

MainSpot recibe los webhooks reales de Telegram mediante `https://tg.mainspot.io/telegram/webhook`, transportados por el KVM y WireGuard hasta el cliente persistente Starlink `10.77.0.2`, donde un proxy local los entrega al backend Express. Esta es la arquitectura instalada; la entrega real no se considera validada sin evidencia de Telegram.

- KVM `89.116.170.99`, peer `10.77.0.1`; cliente `wg-telegram` (`10.77.0.2/32`, `AllowedIPs=10.77.0.1/32`, keepalive 25 s). Configuración activa `/etc/wireguard/wg-telegram.conf`, root:root 0600; no imprimir claves.
- `mainspot-telegram-proxy.service` reutiliza el binario Nginx en una instancia aislada, con `/etc/mainspot/telegram-proxy/nginx.conf`. No habilita el Nginx global ni incluye sitios ajenos. Escucha únicamente `10.77.0.2:8080`, autoriza el peer y traduce `POST /telegram/webhook` a `http://127.0.0.1:3100/api/telegram/webhook`.
- El proxy depende de WireGuard, se detiene con él y vuelve al arrancarlo; ambos están habilitados. Express y worker comparten `mainspot-local.service`; PostgreSQL es el contenedor `mainspot-platform-postgres-1` con `restart: unless-stopped`.
- Fuente protegida de Telegram: `~/.config/mainspot/telegram-webhook.env` (0600); secreto obligatorio para el webhook incluso en desarrollo. `MAINSPOT_DEV_TELEGRAM=real` requiere bot y secreto explícitos en ese archivo. Por defecto las respuestas siguen simuladas; Google y Meta no se activan.
- Configuración de WireGuard, proxy y certificados persistente: **no reinstalar ni inspeccionar preventivamente al abrir una sesión**. Utilizar directamente los servicios; investigar solo ante un fallo observable o para ejecutar una verificación pendiente expresamente encargada. No tocar el bootstrap independiente de `app.mainspot.local.io`.
- Documentación y estados de aceptación: `docs/architecture/telegram-webhook-starlink.md`. `~/wireguard-telegram/README.md` conserva el procedimiento local y las referencias privadas; no subir ese directorio. No sustituir una prueba HTTP local por KVM → Express ni una simulación por un update auténtico.

## AI Core (issue #9) — laboratorio con proveedores reales

- Operación y estado: `docs/architecture/ai-core.md`; `AI-CORE-RESULTS.md` del handoff 30-oct es histórico, no certifica la configuración actual.
- `~/.config/mainspot/ai-core.env` (0600, lo carga `scripts/dev-panel.sh`): `AI_ENVIRONMENT=lab`, `AI_REAL_PROVIDERS=on`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY` vigente (la de `.env` dio 403), `PLATFORM_MFA_KEY`. Nunca credenciales de consumidor/OMP; no imprimir ni copiar valores; no comprobar saldos/créditos desde el repositorio.
- Consolas: `https://app.mainspot.local.io/plataforma` (Administration) y `/ingenieria` (Engineering Console). Credenciales de laboratorio (contraseña + secreto TOTP) en `~/.config/mainspot/platform-{lab-admin,lab-ingenieria,carlos}.txt` (0600). Crear más con `scripts/platform-user.ts`.
- Historia QS-0017/ANS-0017: APR-0003 y DEC-0066…0072 permanecen intactos. DEC-0073 (SRC-0011) es historia conservada. **DEC-0074** deriva de la directiva humana externa SRC-0012, no nueva sesión HDC: en DESARROLLO **Anthropic directo** genera todo texto/razonamiento (`claude-haiku-5-5` eficiente, `claude-sonnet-5-5` complejas), **OpenAI directo solo imágenes** (`gpt-image-2`); TypeSafe/Jev sigue primario con gate y `jev-1.14.0`. Modelos de texto OpenAI deshabilitados y rutas RETIRED; ambos adaptadores disponibles sin fallback; OpenRouter deshabilitado. Canon delta 0.5.0. Datos reales bajo cobertura verificada por proveedor; sin autorización por mensaje. USD 25 generativos acumulados con historia; TypeSafe USD 1/día aparte; créditos declarados por el propietario no amplían nada ni se registran como verificados. No es elección irreversible para producción.
- **Prohibido al agente bajo DEC-0074:** ejecutar evaluaciones generativas pagadas, suites de calidad, `scripts/ai-eval.ts`, `scripts/ai-core-lab-e2e.ts` con proveedores reales, llamadas API de prueba o repetir los 50 casos. Validación local permitida solo cuando sea necesaria y sin red: typecheck, unitarias e integración con proveedor falso. Las pruebas en runtime las hace el propietario desde `https://app.mainspot.local.io`.
- Laboratorio manual (DEC-0074, `src/ai/lab.ts`, migración 0031): rutas DRAFT solo con grant de laboratorio (`/ingenieria#/laboratorio` pestaña «Laboratorio»: «Seleccionar últimas candidatas» → «Emitir autorización»; «Revocar» por fila; step-up. `/panel#/ia/laboratorio` tarjeta «Laboratorio de IA» → «Usar rutas de laboratorio»; «Dejar de usar»/«Salir del laboratorio»; cabecera `X-AI-Lab-Grant`, `sessionStorage` `mainspot.lab.grant` solo id, revalidada en servidor, nunca permiso por sí sola; sin reintento sin cabecera tras 403). Aceptación manual en el detalle del caso de uso (botón «Evidencia manual» por ruta: invocaciones + «Aceptar»/«Rechazar» + 4 casillas + «Notas (10–2000)» → «Registrar revisión» con step-up) marca DRAFT→TESTED en `ai_manual_review` (etiqueta «revisión manual» vs «suite»), **nunca crea `ai_eval_run` ni PASS**, no aprueba ni activa; aprobar/activar separados (`APPROVED` es global) y el despliegue con evidencia solo manual únicamente en `lab`; producción exige suite PASS. Fuera de `lab` toda petición con grant se rechaza (`lab_grant_invalid`), sin fallback ni cabecera ignorada; la clasificación Jev recibe el grant solo como contexto y siempre resuelve su ruta normal TypeSafe. Formularios de prueba «Imagen independiente» («Generar imagen de prueba») y «Respuesta propuesta a un comentario o reseña» («Proponer respuesta»): solo medios/borradores con «ID de invocación». No simular éxito ni etiquetar mocks como evidencia.
- Candidatas vigentes: `claude-haiku-5-5`, `claude-sonnet-5-5`, `gpt-image-2`; todas DRAFT, ninguna TESTED/aprobada/activa; ninguna invocación generativa ejecutada por el agente. Historia DEC-0073: `gpt-6-luna`/`gpt-6.1-sol` deshabilitados; 20 suites/50 casos rechazados por saldo/cuota (`insufficient_credit`), evidencia `evidence/ai-core/openai-development-*-2026-11-03.*` (no certifica la configuración actual). TypeSafe primary verificado; cero invocaciones nuevas OpenRouter.
