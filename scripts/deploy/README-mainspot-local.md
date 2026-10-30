# MainSpot local persistente — `mainspot-local.service`

Servicio de **sistema** que mantiene el panel local (https://app.mainspot.local.io)
arrancado tras reinicios, ejecutando `scripts/dev-panel.sh serve` como el usuario del
repo (un solo proceso `node` con API + worker integrado; PostgreSQL del
`docker-compose.yml` del repo en `127.0.0.1:55432`). No sustituye al deploy LXD
(`mainspot.service`) ni toca la unidad de usuario `mainspot-hdc`.

Archivos:

| Archivo | Qué es |
|---|---|
| `scripts/deploy/mainspot-local.service` | unidad systemd de sistema (sin secretos) |
| `scripts/deploy/telegram-webhook.env.example` | plantilla del archivo protegido `~/.config/mainspot/telegram-webhook.env` |
| `scripts/dev-panel.sh` | arranque diario y `ExecStart` del servicio |

## Telegram: simulado por defecto, real solo explícito

- Sin archivo protegido, o con `MAINSPOT_DEV_TELEGRAM=simulated` (default): canal
  simulado, `TELEGRAM_BOT_TOKEN` forzado vacío aunque el archivo lo contenga.
- `MAINSPOT_DEV_TELEGRAM=real`: `CHANNEL_PRIMARY=telegram`; si falta
  `TELEGRAM_BOT_TOKEN` **o** `TELEGRAM_WEBHOOK_SECRET` el script aborta con exit 78
  (`RestartPreventExitStatus=78`: systemd no entra en bucle; corregir y `systemctl restart`).
- `TELEGRAM_WEBHOOK_SECRET` del archivo protegido se exporta en **ambos** modos.
  `/api/telegram/webhook` devuelve 503 sin secreto configurado y 401 si la cabecera
  `X-Telegram-Bot-Api-Secret-Token` falta o no coincide, incluso en desarrollo.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` y `MAINSPOT_DEV_TELEGRAM` de `.env`
  o del entorno del llamador se **ignoran**: su única fuente es el archivo protegido
  (0600; permisos laxos ⇒ exit 78).
- Google/Meta/dominios/pagos siguen simulados; `JEV_MODE=disabled`.

## Instalación (una vez, como root)

```bash
sudo install -m 0644 scripts/deploy/mainspot-local.service /etc/systemd/system/mainspot-local.service
sudo systemctl daemon-reload
sudo systemctl enable mainspot-local.service        # multi-user.target; NO arrancar todavía
```

Si el repo o Node cambian de ruta, ajustar `WorkingDirectory`, `ExecStart`,
`Environment=PATH=…` y `MAINSPOT_TELEGRAM_ENV_FILE` en la unidad instalada (o un
drop-in `systemctl edit mainspot-local`).

## Cutover seguro desde el proceso manual

El servicio escucha en el mismo puerto 3100 que el `scripts/dev-panel.sh` lanzado a
mano; dos procesos a la vez fallarían por `EADDRINUSE` (y duplicarían el worker).

```bash
scripts/dev-panel.sh env                          # revisar variables (secretos enmascarados)
# 1. detener el proceso manual (el PID del `node src/api/server.ts` arrancado por dev-panel.sh)
kill <PID>; sleep 2
# 2. arrancar el servicio y comprobar
sudo systemctl start mainspot-local.service
systemctl status mainspot-local.service --no-pager
journalctl -u mainspot-local.service -n 50 --no-pager
curl -s https://app.mainspot.local.io/health
```

Operación diaria: `sudo systemctl {status|restart|stop} mainspot-local`;
`journalctl -u mainspot-local -f`. Para volver al modo manual: `sudo systemctl stop
mainspot-local` y `scripts/dev-panel.sh` (mismo script, mismas variables).

## PostgreSQL

`docker-compose.yml` declara `restart: unless-stopped` en `postgres`. En un contenedor
ya existente se aplica sin recrearlo con
`docker update --restart unless-stopped mainspot-platform-postgres-1`. Nota: la
próxima vez que `docker compose up -d postgres` corra (el script solo lo hace si
`pg_isready` falla) compose recreará el contenedor una vez por cambio de
configuración; los datos viven en el volumen `mainspot_pgdata`. Si se lanza a mano,
pasar `POSTGRES_PORT=127.0.0.1:55432` como hace el script (de lo contrario publicaría
`5432` en todas las interfaces).

## Verificaciones recomendadas tras instalar

- `systemd-analyze verify /etc/systemd/system/mainspot-local.service`
- `systemctl show mainspot-local -p SupplementaryGroups -p User -p Restart -p RestartPreventExitStatus`
- Prueba de fail-closed (sin tocar el archivo real): `MAINSPOT_TELEGRAM_ENV_FILE=/tmp/x.env`
  con `MAINSPOT_DEV_TELEGRAM=real` y sin token ⇒ `scripts/dev-panel.sh env` sale con 78.
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.mainspot.local.io/api/telegram/webhook -H 'Content-Type: application/json' -d '{}'`
  ⇒ `401` con el secreto cargado.

## Proxy y verificación de Telegram

El receptor aislado de Nginx, la dependencia de WireGuard y los estados pendientes
se documentan en [el runbook](../../docs/architecture/telegram-webhook-starlink.md).
Instalar los servicios no demuestra entrega real desde Telegram.
