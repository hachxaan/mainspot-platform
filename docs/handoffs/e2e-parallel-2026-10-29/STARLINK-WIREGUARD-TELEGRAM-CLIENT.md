# Starlink — cliente WireGuard y receptor Telegram persistentes (trabajo previo a DEV-E2E-04)

**Objetivo:** preparar en la máquina Linux de Starlink, una sola vez, el peer de WireGuard y el receptor privado HTTP que conectan el webhook Telegram público del KVM con MainSpot. No depende de OMP ni de SSH abiertos. **Estado actual: PENDIENTE en Starlink, no validado E2E.**

## Infraestructura informada, no reconstruir

- Webhook externo: **https://tg.mainspot.io/telegram/webhook** (certificado público Let's Encrypt, gateway KVM previamente configurado).
- Host público KVM: 89.116.170.99, DNAT UDP 51820 al LXC wireguard-telegram (10.13.247.77).
- VPN lado KVM 10.77.0.1; peer Starlink **wg-telegram 10.77.0.2**.
- Config cliente privada del KVM: wireguard-telegram/client/wg-telegram.conf. Endpoint 89.116.170.99:51820, AllowedIPs 10.77.0.1/32, PersistentKeepalive 25, claves/PSK protegidas.
- El KVM reenvía al receptor HTTP **10.77.0.2:8080**. Ruta recibida: POST /telegram/webhook.
- Backend actual MainSpot: POST **/api/telegram/webhook** en Express (puerto interno de desarrollo 3100). El receptor debe **reescribir explícitamente el path**, conservar método, cuerpo y cabecera X-Telegram-Bot-Api-Secret-Token.
- Documento operativo maestro: **~/wireguard-telegram/README.md del KVM**, leer por SSH autorizado antes de instalar. Contiene configuraciones/secretos, no copiarlo al repo.
- El 502 público es coherente con un túnel sin cliente; las pruebas temporales del KVM no demuestran handshake real con Starlink ni entrega real Telegram.
- El panel del dueño sigue en **https://app.mainspot.local.io**, proxy HTTPS local en LXC webserver 10.209.99.101. Es OTRA infraestructura, con bootstrap único ya encargado: no modificarla.

## Ejecución inicial (una sola vez)

1. Con acceso legítimo instalar wireguard-tools si falta; copiar de forma privada el fichero de cliente desde KVM. Instalarlo root:root 0600 en /etc/wireguard/wg-telegram.conf. Nunca imprimir claves, incluirlas en comandos de logging ni versionarlas. Evitar copias temporales en directorios expuestos. Borrar temporales tras comprobar instalación; purgar copia adicional en KVM **después** de validar enlace y conforme al README.
2. systemctl enable --now wg-quick@wg-telegram. Confirmar handshake real (wg show), RX/TX, ping a 10.77.0.1 y rutas: hacia 10.77.0.1 por wg-telegram, hacia 1.1.1.1 por salida ordinaria, jamás por WG. No alterar rutas por defecto ni otras VPN.
3. Instalar/reutilizar un receptor HTTP pequeño (reverse proxy local preferido si ya existe) escuchando **solamente en 10.77.0.2:8080**. Aceptar únicamente POST /telegram/webhook desde 10.77.0.1 a través de wg-telegram y reenviar internamente a http://127.0.0.1:3100/api/telegram/webhook (ajustar si el puerto de Express es otro). Denegar otras rutas, métodos e interfaces; limitación de cuerpo y timeouts.
4. Mantener la validación del secret_token en MainSpot mediante comparación constante (Node timingSafeEqual). El relay debe preservar el encabezado X-Telegram-Bot-Api-Secret-Token sin loguearlo. Secret inválido → 403; backend inaccesible → 502/503, **nunca 200 falso**. Si la app responde 200 antes de persistir/encolar de forma durable el update, corregirlo en el frente DEV-E2E-04. No confiar únicamente en el filtro de IP del KVM.
5. Persistir receptor/relay con systemd: servicio habilitado al boot, privilegios mínimos, Restart=on-failure, dependencias wg-quick razonables y recuperación de bind después de reconexión. Si MainSpot aún corre desde una shell, dotarlo de servicio systemd seguro que mantenga Express + worker con BD actual, sin duplicar instancias. No añadir infraestructura nueva innecesaria.
6. Bootstrap inicial idempotente separado de scripts de arranque cotidiano. Nunca volver a reinstalar claves, firewall o proxy durante nuevas sesiones OMP. No tocar el KVM, sus otros sitios, firewall global, QS-0015, Gate 7 o backups.

## Validación E2E de la etapa Starlink

| ID | Esperado |
|---|---|
| WG-01 | handshake de la máquina Starlink con wg0 KVM, transferencia y ping |
| WG-02 | split route: 10.77.0.1 por túnel, default Internet fuera del túnel |
| WEB-01 | bind SOLO 10.77.0.2:8080, accesible solo desde origen WireGuard autorizado |
| WEB-02 | petición de prueba autorizada cruza ruta /telegram/webhook → /api/telegram/webhook, conserva header/JSON |
| WEB-03 | secret inválido, GET y rutas ajenas rechazados; sin registros secretos |
| WEB-04 | MainSpot apagado → 5xx; reanudado → receptor operativo |
| PERSIST-01 | servicios reiniciados/reinicio Starlink permitido → WireGuard + receptor + MainSpot sin OMP |
| PERSIST-02 | desconexión breve de Starlink → recuperación de túnel y recepción, sin ruta por defecto alterada |

**No ejecutar setWebhook todavía ni borrar un webhook previo.** Un curl externo desde IP ajena debe fallar con 403 por filtro Telegram del gateway; ese 403 NO es prueba de que Telegram pueda entregar. El E2E desde Telegram exige registro posterior y mensaje real.

## Estado de entrega a DEV-E2E-04

Declarar **READY_FOR_WEBHOOK_REGISTRATION** únicamente si las pruebas locales WG/WEB/PERSIST pertinentes pasan, con evidencia redactada y nombres de servicios. Luego el frente de implementación integrará bot real: getMe, setWebhook a la URL pública exacta con secret_token generado/protegido, getWebhookInfo, mensaje /start real, alerta y respuesta real con read-back en panel.

Todos los secretos y credenciales deben permanecer fuera de GitHub, logs y prompts. No afirmar que el registro del webhook o su entrega real se han probado si aún no ocurrió.

**Autonomía:** tomar decisiones de ingeniería en Starlink sin HDC, dentro del alcance. Si falta acceso SSH o permisos del sistema, reportar el bloqueo concreto sin modificar otro sistema.
