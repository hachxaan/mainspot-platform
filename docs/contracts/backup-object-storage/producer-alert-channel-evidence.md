# Canal de avisos del productor MainSpot — evidencia de recepción real (DEC-0064, DEC-0065)

No normativo. No contiene el token del bot, el identificador del chat ni ningún otro secreto.

## Decisión

- **DEC-0064** (QS-0014 / ANS-0015, ingerida en RUN-0016): bot de Telegram exclusivo para los avisos del
  productor de respaldos remotos, con chat privado; token e identificador del chat solo en el equipo de
  MainSpot (0600).
- **DEC-0065**: condiciones literales del propietario, entre ellas la prueba sintética con confirmación
  personal de la recepción real **antes de cualquier activación productiva**.

## Prueba sintética de recepción real — ACREDITADA

| Campo | Valor |
|---|---|
| Bot | «MainSpot Backup Alerts», exclusivo; distinto del bot del KVM 4, del de CanonFlow/HDC y del comercial de MainSpot |
| Código | `TEST-SYNTHETIC` |
| Acción | `synthetic-delivery-test` |
| Fecha (UTC) | 2026-10-24T21:52:06Z |
| `event_id` | `f7b848ef95468473b7228ddd4fe37244` |
| Resultado del adaptador | `exit=0` (Telegram respondió `ok`) |
| Confirmación | El propietario confirmó haber recibido el mensaje en su chat privado del bot, con el identificador **idéntico** |
| Adaptador ejecutado | `~/.local/libexec/mainspot/remote-alert-telegram.py`, sha256 `d42fe40b86c527c94c29f298af1c54c1fff94ef54db88e69b4f74eafedf442b1`, idéntico a `scripts/ops/backup/remote-alert-telegram.py` en `mainspot-platform@5ccd4d21b01634ada05e874a6b328c4bcbf4ffb1` |
| Credenciales | `~/.config/mainspot/backup/telegram-alert.env`: modo 0600, propietario `administrador`, directorio 0700; fuera de Git. Valores no leídos ni registrados por el agente |

Con esto se cumple la condición de DEC-0065 sobre la prueba sintética con confirmación personal. Queda
acreditado que el canal dedicado entrega mensajes desde el equipo de MainSpot al chat del propietario.

## Lo que esta prueba NO acredita

- **No es una prueba E2E de avisos del productor.** El evento lo generó `--synthetic-test` del adaptador
  directamente. No hubo ejecución de `db-backup-remote.py`, ni respaldo, ni S3, ni la ruta
  `MAINSPOT_REMOTE_ALERT_COMMAND` (comprobación de sha256 y permisos, cola de pendientes, supresión de
  duplicados) con Telegram real.
- Esa ruta solo está probada en laboratorio, con un Telegram falso por HTTPS: 29 pruebas en
  `tests/ops/backup-remote/test_alert_telegram.py`.
- El productor sigue **sin conectar** al adaptador: no existe `remote.env`, y
  `MAINSPOT_REMOTE_ALERT_COMMAND` / `MAINSPOT_REMOTE_ALERT_COMMAND_SHA256` no están configurados.
- La recepción de un aviso generado por el productor (por ejemplo `E-SIZE-LIMIT` o `E-FRESHNESS`) se
  acreditará en el simulacro E2E (ver `e2e-drill-handoff.md`).
