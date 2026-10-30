# MainSpot — Handoff E2E: cliente persistente y entrada pública exclusiva para webhooks

**Fase:** INFRA-WEBHOOK-01 · **Previo** a actualizar DEV-E2E-04.
**Objetivo:** habilitar un endpoint HTTPS público, estable y seguro para la recepción de webhooks, reenviado a la aplicación LOCAL mediante un cliente persistente independiente de OMP y de las sesiones de terminal.
**Entorno:** desarrollo local solamente. **No** implica despliegue público del panel ni de las páginas de clientes.

## 1. Topología obligatoria

\`\`\`text
Telegram / Meta / Google Cloud Pub/Sub
      │
      ▼  HTTPS público (URL estable del proveedor de túnel)
  PROVEEDOR TÚNEL
      │
      ▼ conexión saliente persistente, sin abrir puertos públicos locales
  CLIENTE TÚNEL en LXC webserver (o host, si ya existe funcionando allí)
      │
      ▼  ingress exclusivo para webhooks, allowlist de rutas
  REVERSE PROXY LOCAL  →  MainSpot Express (API webhook handlers)
\`\`\`

**No exponer** \`/panel\`, \`/\` (login), \`/invitacion\`, \`/api/backoffice/**\`, \`/preview/**\`, administración de LXC ni bases de datos al túnel. El proxy permite SOLAMENTE:
- \`POST /api/telegram/webhook\`
- \`GET /api/meta/webhook\` (challenge de verificación)
- \`POST /api/meta/webhook\` (eventos firmados)
- \`POST /api/google/pubsub/webhook\` (Google Cloud Pub/Sub push autenticado)

Los nombres Meta/Google son **contratos propuestos** para DEV-E2E-04: si el código actual aún no los tiene, pueden devolver 404/501 durante esta fase de infraestructura; la prueba de conectividad se realiza con un receiver *temporal y controlado* que luego se elimina, no con endpoints falsamente declarados funcionales.

**Dominio del panel inalterable:** \`https://app.mainspot.local.io\`, LXC \`webserver\` en \`10.209.99.101\`, SSL de confianza local (bootstrap propio ya encargado en otro trabajo). **No volver a inspeccionar/reconfigurar ese dominio salvo error real**. No se cambia \`PUBLIC_BASE_URL\`.

**URL pública de webhook**: URL HTTPS *diferente*, estable y de certificado público válido, por ejemplo **el subdominio asignado a la cuenta del proveedor**; NO asumir cuál es antes de configurarlo. Guardar solo el URL confirmado como \`WEBHOOK_PUBLIC_BASE_URL\`. El dominio de túnel público es únicamente para callbacks, no es un dominio público comercial de MainSpot ni de las páginas de clientes.

## 2. Elección del cliente (no reinventar ni duplicar)

**Primera regla:** si en la máquina o el LXC ya hay un cliente de túnel *realmente aprovisionado* con endpoint fijo (ngrok, cloudflared/named tunnel, Hookdeck u otro) **reutilizar ese mismo proveedor**. No crear una segunda cuenta ni un segundo túnel por costumbre.

**Si NO existe proveedor definido:** preferir **ngrok agent v3 + dominio de desarrollo fijo asignado a la cuenta** y su servicio en segundo plano, siempre que el plan permita tráfico y el endpoint estable esté disponible. Según documentación oficial, un dev domain gratuito queda asociado a la cuenta y no cambia al reiniciar; el CLI permite \`ngrok service install --config <archivo>\` seguido de \`ngrok service start\` para operarlo como servicio. No utilizar un túnel efímero que cambie URL en cada inicio. Ver:
- https://ngrok.com/download/linux
- https://ngrok.com/docs/gateway/agent/config
- https://ngrok.com/docs/gateway/agent/cli
- https://ngrok.com/docs/pricing-limits/free-plan-limits

**Requisitos del relay:** soportar GET+POST, challenge síncrono de Meta, headers originales y payload sin reescribir (especialmente \`X-Hub-Signature-256\` y \`Authorization\`), HTTP status/headers devueltos al proveedor, y una conexión persistente saliente. Si un servicio intermedio retiene/reintenta eventos, documentar su semántica de at-least-once y sus límites de privacidad.

Nunca bajar seguridad TLS para acomodar un proxy o CA local (\`--insecure\`, \`ignoreHTTPSErrors\`, \`curl -k\` prohibidos en la verificación de aceptación). Si la conexión al ingress local usa HTTP sobre loopback dentro del LXC puede ser aceptable **solo** cuando no abandona el límite de confianza. Si cruza host↔LXC, usar la conexión de red confiable con ACL mínima y TLS cuando sea necesario.

## 3. Instalación inicial — UNA SOLA VEZ

El agente que reciba este handoff puede tomar decisiones de ingeniería y ejecutar sin HDC ni aprobaciones intermedias de desarrollo. La instalación se hace una vez, y solo se repite para reparación motivada por fallo real.

1. Identificar infraestructura **existente** una sola vez: dónde corre el cliente de túnel, qué servidor/proxy reside en el LXC, desde qué dirección alcanza Express y si la cuenta del proveedor tiene dev domain estable. Proteger configuraciones previas.
2. Definir un ingress dedicado **solo para webhooks**. Preferencia: servidor HTTP separado dentro del LXC con listener privado para el cliente, reglas de rutas/métodos, límites de tamaño, timeouts, cabeceras proxy y 404/405 para todo lo ajeno. Verificar que \`/panel\`, \`/api/backoffice/\`, \`/invitacion\`, \`/health\` y \`/preview/\` NO son públicos por el túnel. Si comparte Nginx, usar una configuración aislada sin reescribir virtual hosts existentes.
3. Configurar cliente con URL pública fija y upstream hacia **solo** el ingress anterior, nunca hacia el puerto general del panel. No publicar directamente Express 3100.
4. Dejarlo como **servicio persistente** (systemd o mecanismo nativo equivalente del proveedor) bajo identidad dedicada y mínima, **habilitado al arranque**, \`Restart=on-failure\` o equivalente, límites razonables, backoff, secretos protegidos por archivos/permisos o gestor local. Usar **un solo supervisor** (no mezclar ngrok service con un systemd personalizado duplicado).
5. Conservar token de túnel fuera del repo, commits, shell history y capturas; no imprimir su valor ni exponer el panel de administración del túnel o API local de inspección. Deshabilitar la retención/captura de cuerpos sensibles en el servicio de túnel si el proveedor ofrece ese control. Los eventos pueden contener datos personales.
6. Mantener \`PUBLIC_BASE_URL=https://app.mainspot.local.io\`. **Añadir** \`WEBHOOK_PUBLIC_BASE_URL=<URL_PUBLICA_CONFIRMADA>\` en el entorno de desarrollo local y documentar solo el **nombre** en \`.env.example\`; los tokens de Telegram/Meta/Google serán del backend, no del cliente de túnel.
7. Usar un receptor de prueba temporal de GET/POST bajo la allowlist para verificar passthrough y respuestas; retirarlo tras la prueba. La siguiente fase implementará/controlará los handlers de Meta/Google. Telegram ya expone \`POST /api/telegram/webhook\`, pero no usar esa ruta para una prueba falsa de recepción real.
8. Habilitar arranque con LXC/host (según ubicación concreta), independiente de cerrar una terminal o sesión OMP. Guardar en memoria persistente de OMP, de forma **acotada a MainSpot**, ubicación del servicio, nombre de la unidad, URL pública estable, rutas soportadas, comando de operación y **regla de no reinstalación/no reverificación preventiva en nuevas sesiones**. Actualizar \`.omp/RULES.md\` y \`.omp/AGENTS.md\` al completar, **sin sobrescribir reglas previas**. No almacenar secretos.
9. No tocar la infraestructura de \`app.mainspot.local.io\` ni su certificado por un bootstrap de webhooks, salvo necesidad provocada por fallo demostrado. Este tunnel es un componente nuevo y aislado.

**Autonomía autorizada:** modificar solamente proxy ingress dedicado, servicio del túnel, configuración local, scripts de instalación inicial y documentación/secret placeholders en MainSpot. No exponer servicios adicionales ni incurrir en costos de nuevos planes/cuentas sin que la elección de proveedor ya contemple ese costo. No tocar QS-0015, Gate 7, productor de backups ni producción.

## 4. Distinción entre webhooks de Telegram, Meta y Google

**Telegram Bot API**
- Webhook POST HTTPS público con \`setWebhook\` y \`secret_token\` que viaja en \`X-Telegram-Bot-Api-Secret-Token\`.
- \`getUpdates\` y webhook son mutuamente excluyentes: **al migrar a webhook, debe apagarse el long polling del MISMO bot**; no crear dos consumidores concurrentes. No eliminar el webhook de un bot ajeno o productivo.
- La fase INFRA prepara transporte; el registro real con \`setWebhook\`, seguridad e idempotencia debe realizarse en DEV-E2E-04 con bot de prueba autorizado.
- Oficial: https://core.telegram.org/bots/api

**Meta Facebook Webhooks**
- **GET de verificación síncrono** con \`hub.mode\`, \`hub.verify_token\`, \`hub.challenge\`: el handler compara verify_token en servidor y devuelve el challenge exacto (200, sin wrapper JSON).
- **POST con \`X-Hub-Signature-256\`**: calcular HMAC-SHA256 usando el **raw body sin modificar**, verificar timing-safe, deduplicar y confirmar solo cuando el evento quedó aceptado duraderamente. No validar firmas sobre JSON reserializado.
- No aceptar secret token de Meta como query en eventos; sólo el GET challenge usa el token de verificación. La app debe suscribir Page/fields con permisos reales.
- Referencia: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/

**Google Business Profile**
- GBP no emite un webhook HTTP genérico directo. Su **Notifications API → Cloud Pub/Sub**, suscrito a \`NEW_REVIEW\` y \`UPDATED_REVIEW\` (y otros eventos aprobados).
- En DEV-E2E-04 configurar Pub/Sub **push HTTPS autenticado** al endpoint público, usando token OIDC firmado por cuenta de servicio. El backend valida firma, issuer, audience, identidad, expiración, dedupe messageId y recurso cuenta/location; el evento dispara **fetch autorizado del detalle** desde Business Profile antes de responder.
- No aceptar POST cualquiera solo porque llegó del túnel; el relay NO reemplaza la autenticación Pub/Sub. Reconocer evento 2xx solo si fue aceptado durablemente; ante fallo permitir retry.
- Referencias: https://developers.google.com/my-business/content/notification-setup y https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions

**Nota de seguridad:** proveedor de túnel = transporte, **nunca fuente de identidad o permiso del cliente**. Seguir multi-tenant y política de publicación/autorización del producto en handlers.

## 5. Pruebas de aceptación — infraestructura persistente E2E

Completar y documentar **resultados REALES, no supuestos**:

| ID | Prueba | Evidencia |
|---|---|---|
| WH-01 | URL HTTPS pública estática asignada al servicio y válida por CA pública | URL saneada, certificado validado, sin bypass |
| WH-02 | GET con querystring y POST con bytes/headers atraviesan túnel → ingress → receiver temporal y regresan status correcto | captura redactada de request/response, challenge preservado |
| WH-03 | URLs no autorizadas \`/\`, \`/panel\`, \`/invitacion\`, \`/api/backoffice/*\`, \`/preview/*\` NO accesibles por túnel | 403/404 |
| WH-04 | Servicio activo sin terminal/OMP, habilitado en systemd y con reinicio/reconexión tras caída controlada | \`systemctl is-enabled/is-active\`, estado antes/después, sin token visible |
| WH-05 | Reinicio controlado del servicio del túnel conserva **el mismo URL público** | URL antes/después igual; sin editar callback en proveedores |
| WH-06 | App caído no produce falsa confirmación 200 de eventos no guardados (502/503 o cola duradera verificada) | fallo recuperable probado |
| WH-07 | Payload y header de firma Meta no cambian; Authorization OIDC de Pub/Sub y secret header Telegram llegan intactos | prueba sintética de transporte |
| WH-08 | \`https://app.mainspot.local.io\` sigue funcionando como antes, sin exponerse públicamente | comprobación funcional normal; bootstrap no repetido |
| WH-09 | Memoria OMP y runbook quedan persistentes; siguiente sesión conoce URL, unidad, rutas y **no vuelve a configurar** | referencia versionada sin secretos |

No realizar reinicio host completo si perjudica trabajo concurrente; comprobar enabled al boot, reinicio del cliente y recuperación. El daemon permanece corriendo sin depender de OMP.

## 6. Entregables de esta PRIMERA fase

1. Cliente funcionando como servicio persistente con nombre de unidad real y URL HTTPS pública estable.
2. Ingress aislado con allowlist y certificado público en edge, sin exponer panel ni dominios comerciales de clientes.
3. Pruebas WH-01..09 con resultados honestos.
4. \`WEBHOOK_PUBLIC_BASE_URL\` registrado localmente, separado de \`PUBLIC_BASE_URL\`.
5. Actualización de memoria persistente OMP con datos **no secretos** de la infraestructura ya comprobada y su regla de bootstrap único.
6. Script/runbook de recuperación limitada, sin reinicializar cada nueva sesión.
7. Commit/push solo de archivos del repo relacionados, sin archivos secretos.
8. Reportar **READY / PARTIAL / BLOCKED**, los URLs efectivos, nombres de servicio y limitaciones.

**IMPORTANTE — frontera de etapas:** este handoff instala y prueba **TRANSPORTE PERSISTENTE**; NO modifica todavía el handoff DEV-E2E-04 para reemplazar long polling por webhook ni afirma que Google/Meta/Telegram ya están conectados. La actualización de DEV-E2E-04 se hará **después de recibir evidencia de WH-01..09**, preservando las demás prioridades y cambiando sus mecanismos entrantes conforme a los servicios disponibles.
