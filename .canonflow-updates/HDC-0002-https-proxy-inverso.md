# HDC-0002 — Acceso HTTPS por dominio mediante proxy inverso

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-20 |
| Estado | `REQUIERE_DECISION` (aplicado en MainSpot sin modificar HDC) |
| Clase | Contradice `CANONFLOW_HDC_DEFINITION.md` §14 |
| Solicitud | Abrir HDC como `https://mainspot.hdc.com` |

## Problema observado

HDC solo acepta solicitudes dirigidas a loopback:

- `web.py:116-122`, `_check_host`: el `Host` debe ser `127.0.0.1` o
  `127.0.0.1:<puerto>`. Otro valor produce `403 HOST_REJECTED`.
- `web.py:308-320`, `_check_mutation_guard`: las mutaciones exigen
  `Origin` igual a `http://127.0.0.1:<puerto>`. Otro valor produce
  `403 ORIGIN_REJECTED`.

Si un dominio o proxy HTTPS reenvía sin traducir esas cabeceras, HDC devuelve
`403`.

## Causa raíz

Es comportamiento definido: §14 acepta solo `Host` exactamente
`127.0.0.1:<puerto>` y rechaza dominios alternativos, cabeceras `Forwarded` y
proxies no configurados. CanonFlow no permite declarar un origen público.

## Cambio en MainSpot

Sin cambios en el código de HDC:

- `/etc/hosts` resuelve `mainspot.hdc.com` a `10.209.99.101`, el LXC `webserver`.
- El vhost de Nginx es
  [`scripts/deploy/mainspot.hdc.com.conf`](../scripts/deploy/mainspot.hdc.com.conf).
  - Redirige HTTP a HTTPS.
  - Permite solo `10.209.99.1` y loopback.
  - Bloquea `/_control/` con `404`.
- El dispositivo LXD `mainspot-hdc` usa `bind=container`: el loopback `:8765` del
  contenedor apunta al loopback `:8765` del host. HDC no escucha en interfaces
  LAN ni VPN.
- Nginx reescribe `Host` a `127.0.0.1:8765`.
- Para `Origin`:
  - traduce solo `https://mainspot.hdc.com` a `http://127.0.0.1:8765`;
  - rechaza con `403` cualquier otro origen no vacío;
  - deja pasar sin origen las peticiones GET de navegación.
- HDC conserva sus comprobaciones de `Host`, `Origin` y CSRF.
- Certificado autofirmado:
  - SAN exacto `mainspot.hdc.com`, `CA:FALSE`, uso `serverAuth`;
  - clave privada con permisos `0600` solo dentro del LXC;
  - confianza instalada en el sistema y en NSS del usuario.

## Contrato afectado

- §14: `Host` exacto, rechazo de dominios alternativos y proxies no configurados.
- §1.3 y §12: la escucha sigue en `127.0.0.1` y no cambia.
- §14: el modelo de confianza sin login no autoriza acceso remoto.

## Verificación ejecutada

Registrada en el checkpoint (`hdc.https_proxy`):

- TLS válido sin `--insecure`; readiness `200`.
- Workspace verificado en navegador y redirección HTTP verificada.
- Origen ajeno: `403`; cliente no permitido: `403`; petición sin CSRF: `403`.
- Respuesta inválida tras superar las guardas: `422`. No se crearon respuestas ni
  aprobaciones.

Repetido el 2026-10-21: `ready_http=200 ssl_verify=0`.

## Propuesta para CanonFlow

Requiere que el propietario enmiende §14:

1. Añadir una variable opcional `CANONFLOW_HDC_PUBLIC_ORIGIN`, por ejemplo
   `https://mainspot.hdc.com`.
   - Debe ser un único origen `https`, sin ruta.
   - Debe validarse al arrancar y mostrarse en Diagnostics.
2. Si está definida:
   - `_check_host` acepta también ese host;
   - `_check_mutation_guard` acepta también ese `Origin`;
   - todo lo demás sigue rechazándose;
   - `Forwarded` y `X-Forwarded-*` nunca autorizan nada.
3. La escucha sigue sin poder configurarse y permanece en `127.0.0.1`. El proxy
   debe ejecutarse en el mismo equipo o reenviar a ese loopback.
4. Documentar una receta de proxy:
   - TLS;
   - lista de clientes permitidos;
   - bloqueo de `/_control/`;
   - no cachear la API.
5. Añadir pruebas de seguridad para `Host` y `Origin` maliciosos con y sin la
   variable configurada.

Alternativa sin código: documentar como despliegue soportado la traducción de
cabeceras usada en MainSpot. Es más débil, porque HDC no distingue el origen real
y delega toda la política de origen en el proxy.

## Riesgos y límites

- HDC no tiene login. Cualquier cliente admitido por el proxy puede responder
  sesiones. MainSpot lo limita a la dirección del bridge del host y a loopback.
- Instalar un certificado autofirmado modifica los almacenes de confianza locales.
- Las `location = /`, `^~ /css/` y `^~ /js/` de este vhost sirven el frontend de
  la pila HDC-0003..HDC-0005 y se retiran al integrarla. Antes, desde
  HDC-0003/HDC-0004, solo existía `location = /js/views/workspace.js`.
