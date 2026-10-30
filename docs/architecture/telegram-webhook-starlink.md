# Telegram — receptor persistente Starlink

## Estados de aceptación

- **`INFRASTRUCTURE_READY`: no acreditado.** WireGuard conectado y receptor local instalado. Falta ejecutar HTTP desde el lado autorizado del KVM y comprobar recuperación tras reinicio completo del host. SSH no interactivo como `administrador` y `root` a `89.116.170.99` rechazó las claves disponibles. No se cambió la autenticación del KVM.
- **`TELEGRAM_WEBHOOK_REAL_VERIFIED`: `BLOCKED_EXTERNAL`.** No hay token de bot en el entorno de MainSpot ni en sus archivos protegidos inspeccionados. No se ejecutaron `getMe`, `getWebhookInfo`, `setWebhook` ni long polling. Falta un bot de prueba identificado/autorizado y una entrega auténtica desde Telegram, seguida de vinculación, aviso y resolución persistidos.
- El reinicio físico del host y el corte general de Starlink no se ejecutan mientras haya trabajo ajeno activo. La pérdida controlada de UDP del túnel no equivale a esa prueba.

La instalación no es prueba de entrega real. Una petición local, un update sintético o el 403 público esperado no cierran los niveles C/D.

## Recorrido y límites

```text
Telegram → HTTPS tg.mainspot.io/telegram/webhook
 → KVM 89.116.170.99 / LXC webserver
 → LXC wireguard-telegram 10.13.247.77:8080
 → WireGuard 10.77.0.1 → 10.77.0.2
 → Nginx local 10.77.0.2:8080/telegram/webhook
 → Express 127.0.0.1:3100/api/telegram/webhook
 → PostgreSQL + TelegramLinkService
```

El cliente usa la configuración ya existente, sin regenerar claves:

| Parámetro | Valor |
|---|---|
| Interfaz / dirección | `wg-telegram` / `10.77.0.2/32` |
| Endpoint | `89.116.170.99:51820/UDP` |
| AllowedIPs | `10.77.0.1/32` |
| PersistentKeepalive | `25` segundos |
| Configuración activa | `/etc/wireguard/wg-telegram.conf`, root:root 0600 |
| Recuperación autorizada | `~/wireguard-telegram/client/wg-telegram.conf`, 0600, directorio raíz 0700 |

Internet no usa este túnel. En la verificación la ruta hacia `1.1.1.1` siguió por el VPN preexistente `tun0`, vía `192.168.239.1`, no por WireGuard. No se modificó ese VPN ni la infraestructura independiente de `https://app.mainspot.local.io`.

## Servicios y configuración reproducible

| Componente | Persistencia y alcance |
|---|---|
| WireGuard | `wg-quick@wg-telegram.service`, habilitado al arranque |
| Proxy HTTP | `mainspot-telegram-proxy.service`, instancia dedicada del binario Nginx existente |
| Express y worker | `mainspot-local.service`, un único proceso Node con worker integrado |
| PostgreSQL | Contenedor existente `mainspot-platform-postgres-1`, `restart: unless-stopped`; Docker habilitado |

Los templates sanitizados están en `scripts/deploy/`. El proxy no incluye `/etc/nginx/sites-enabled` ni habilita el Nginx global del host: esos sitios son ajenos. Usa `/etc/mainspot/telegram-proxy/nginx.conf`, `BindsTo`/`After`/`PartOf` de WireGuard y enlaces de arranque tanto en `multi-user.target` como en la unidad del túnel. Se detiene con WireGuard y vuelve a arrancar con él. `Restart=on-failure` recupera un fallo del proceso.

El servicio de MainSpot reutiliza `scripts/dev-panel.sh`, la base `mainspot_dev` y el PostgreSQL existentes; no levanta el servicio Docker `app` ni un segundo worker. Instalación/cutover: [README-mainspot-local](../../scripts/deploy/README-mainspot-local.md). No arrancar otro `scripts/dev-panel.sh` mientras el servicio esté activo. Para E2E que ocupan 3100, detener el servicio y restaurarlo al terminar.

Solo para una instalación o recuperación explícita, nunca por rutina de sesión:

```bash
sudo install -d -m 750 /etc/mainspot/telegram-proxy
sudo install -m 644 scripts/deploy/mainspot-telegram-proxy.nginx.conf /etc/mainspot/telegram-proxy/nginx.conf
sudo install -m 644 scripts/deploy/mainspot-telegram-proxy.service /etc/systemd/system/mainspot-telegram-proxy.service
sudo systemctl daemon-reload
sudo systemctl enable --now mainspot-telegram-proxy.service
```

## Seguridad

- Solo `10.77.0.2:8080`, nunca `0.0.0.0`, `[::]`, LAN ni loopback. Únicamente el peer `10.77.0.1` puede reenviar `POST /telegram/webhook`. Otros orígenes reciben 403; otro método, 405; otra ruta, 404.
- Máximo 100 KiB y 16 conexiones simultáneas por peer. Timeouts de cabecera/cuerpo 5 s, conexión upstream 3 s y envío/lectura 10 s. No se reenvían automáticamente POST ambiguos.
- La cabecera `X-Telegram-Bot-Api-Secret-Token` llega a Express. `timingSafeEqual` compara el secreto: 401 si falta/no coincide; 503 si no está configurado, también en desarrollo.
- Secreto generado de 256 bits: `~/.config/mainspot/telegram-webhook.env`, 0600 dentro de directorio 0700. `.env` local también se restringió a 0600. Ninguno va a Git ni se imprime.
- Token, secreto y `MAINSPOT_DEV_TELEGRAM` solo se cargan del archivo protegido para `dev-panel.sh`. El modo por defecto es `simulated`; `real` exige token y secreto y autorización previa del bot. Google/Meta/dominios/pagos permanecen simulados.
- El access log del proxy registra fecha, IP del peer, método, estado y duración, nunca URI/query, cabeceras o cuerpos. El error log de solicitudes se deshabilita para evitar reflejar entradas sensibles.
- No copiar `~/wireguard-telegram` al repositorio. No se crearon copias temporales de claves; se conserva el origen necesario para recuperación. El borrado con `shred` no demuestra borrado físico en SSD/COW/snapshots.

### Reentregas y límite de exactamente una vez

La migración `0019_telegram_update_dedup.sql` añade `telegram_update`: solo identificador, reclamo, resultado y fechas, sin cuerpo o chat. Una entrega ya terminada devuelve `duplicate`; otra aún en curso devuelve 409 para que Telegram reintente. El reclamo es autocommit y no retiene una conexión del pool durante el procesamiento; la lease abandonada vence a los 120 s. Las sondas vacías no escriben en el ledger.

Las decisiones/publicaciones usan además los controles idempotentes existentes por caso. Se probaron entregas concurrentes, un pool de una conexión, error y reentrega, lease vencida y reinicio real del proceso. Esto no garantiza exactamente una respuesta de Bot API ante una caída entre `sendMessage` y el registro `done`: esa confirmación puede repetirse. Tampoco debe interpretarse el vencimiento de una lease como prueba de que un envío externo terminó. El ledger conserva los IDs sin purga automática; cambiar de bot exige una migración explícita de su ámbito, no reutilizar silenciosamente esta instalación con otro bot.

## Evidencia y significado de las pruebas

Pruebas ejecutadas y resultados finales: [`evidence/telegram-webhook-starlink.txt`](../../evidence/telegram-webhook-starlink.txt). La configuración de Nginx se valida y prueba sin cambiar la ACL de la instancia activa. Una prueba de forwarding en una instancia temporal de loopback se identifica como tal; no equivale al salto real desde el KVM.

Observado durante la instalación:

- Handshake auténtico, tráfico WireGuard bidireccional y ping 3/3 al peer.
- Reinicio y parada/arranque del túnel: proxy detenido cuando falta la IP y recuperado automáticamente al regresar.
- Fallo forzado del master Nginx: reinicio automático de su unidad.
- Bloqueo temporal únicamente de UDP/51820 hacia el KVM: ping 0/3; retirada de la regla temporal: 3/3, sin reiniciar el túnel. Regla eliminada al terminar.
- Origen local no autorizado 403, GET 405, ruta ajena 404; conexión a loopback:8080 rechazada.
- `https://tg.mainspot.io/telegram/webhook` desde el origen no Telegram devuelve 403, con TLS válido. Es el filtro público esperado, no evidencia de entrega ni de fallo del upstream.
- MainSpot: reinicio explícito y `SIGKILL` recuperados por systemd; PostgreSQL: contenedor reiniciado y conexión SQL recuperada. Estado final con un único servidor y ningún worker independiente.
- Forwarding en instancia temporal de loopback hacia Express real: secreto correcto 200 `ignored`, ausente/incorrecto 401, GET 405, ruta ajena 404 y exceso de tamaño 413; Express detenido 502 y restaurado 200. Se retiró esa instancia sin cambiar la ACL activa. **No prueba KVM → Express.**
- TypeScript, 117 unitarias y 120 de integración aprobados; E2E DEV-E2E-02 con 31 comprobaciones, incluyendo reentrega tras reinicio. Verificación final del archivo de integración afectado: 11/11 con IDs reservados sin colisiones aleatorias.

## Cerrar la prueba HTTP del KVM sin exponer el secreto

Requisito externo: acceso SSH autorizado al KVM con permiso para `lxc exec wireguard-telegram`. No cambiar sus servicios para probar. Una vez disponible, enviar el secreto **por stdin**, nunca como argumento, URL, archivo temporal o salida. Ejemplo operativo pendiente de ejecutar en el KVM:

```python
from pathlib import Path
import os, re, subprocess

secret = next(line.split('=', 1)[1] for line in
    (Path.home() / '.config/mainspot/telegram-webhook.env').read_text().splitlines()
    if line.startswith('TELEGRAM_WEBHOOK_SECRET='))
assert re.fullmatch(r'[a-f0-9]{64}', secret)
config = '\n'.join([
    'url = "http://10.77.0.2:8080/telegram/webhook"',
    'request = "POST"',
    'header = "Content-Type: application/json"',
    f'header = "X-Telegram-Bot-Api-Secret-Token: {secret}"',
    'data = "{}"',
    'write-out = "\\nHTTP %{http_code}\\n"',
]) + '\n'
result = subprocess.run([
    'ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    os.environ.get('MAINSPOT_KVM_SSH_TARGET', 'administrador@89.116.170.99'),
    'sudo', '-n', 'lxc', 'exec', 'wireguard-telegram', '--',
    'curl', '--silent', '--show-error', '--max-time', '12', '--config', '-',
], input=config, text=True, capture_output=True)
print('exit', result.returncode)
print(result.stdout)  # Solo respuesta al cuerpo inocuo {} y estado HTTP.
```

Esperado: 200 `handled=ignored` con secreto correcto, 401 al omitirlo/cambiarlo; sin decisiones, vínculos ni publicaciones. Repetir desde el host KVM hacia el dominio público para cerrar además los proxies/TLS externos. Confirmar sin cabecera 401 y recuperar 200 tras un reinicio controlado. No usar un mensaje sintético accionable contra datos reales.

## Bot real y recuperación pendiente

1. Obtener credencial por almacén seguro e identidad autorizada del bot de prueba.
2. Consultar `getMe` y `getWebhookInfo` antes de modificar. Si existe otro webhook, detenerse y coordinar el traslado; nunca iniciar long polling en paralelo.
3. Llamar `setWebhook` con la URL pública y el secreto leído dentro del proceso. No pasar token/secreto en argumentos ni imprimir respuestas con datos personales. No usar `drop_pending_updates=true` sin decisión explícita.
4. Confirmar `getWebhookInfo`: URL correcta, sin errores de entrega ni cola pendiente sin explicar.
5. Enviar mensaje real desde Telegram; observar entrega y persistencia. Vincular chat y resolver un caso de prueba autorizado, verificando que los repetidos no duplican respuesta/decisión/publicación.
6. Cuando no afecte trabajo ajeno: reiniciar el host, verificar arranque automático de los componentes y repetir entrega real. Hacer también una pérdida/restauración real de Starlink en ventana segura. No reiniciar el KVM.

Ante fallo observable: `systemctl status` de las tres unidades locales, `journalctl -u mainspot-local -u mainspot-telegram-proxy`, handshake/transfer y rutas específicas. Nunca mostrar `wg showconf`, `.env`, claves o encabezados del webhook. Corregir la causa y reiniciar únicamente la unidad afectada. No reinstalar WireGuard, certificados ni bootstrap del panel como primer paso.
