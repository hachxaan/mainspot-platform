# F-01 · Mini-bootstrap para la prueba real de acuse (preparado, no ejecutado)

Estado: **PREPARADO, NO AUTORIZADO.** Este procedimiento no se ha ejecutado. Hace falta un permiso nuevo y
explícito del propietario en el issue #1 para la ventana, el tipo de evento y las condiciones. Hasta
entonces están prohibidos: los mensajes reales, el despliegue, los temporizadores, el acceso a Garage y la
condición 7 del HDC.

Canon de referencia (0.2.0-staging): FR-0013, FR-0014, FR-0015, API-0005 … API-0009.

## 0. Precondiciones (todas)

- Permiso del propietario en el issue #1 que fije:
  - la ventana UTC;
  - el evento (`TEST-SYNTHETIC` del adaptador o E2E sintético generado por el productor en local);
  - la política de acuse de la prueba.
- El commit de la rama F-01 está auditado: la suite offline pasa y el veredicto técnico es GO.
- Productor desactivado, sin `~/.config/mainspot/backup/remote.env` activo, sin unidades ni temporizadores.
- Sin webhook en el bot. Se comprueba de forma pasiva en el paso 3, porque `--ack-poll` termina con salida 17 si hay uno.

## 1. Instalación privada del adaptador (sin red)

```bash
install -m 0700 -D scripts/ops/backup/remote-alert-telegram.py ~/.local/libexec/mainspot/remote-alert-telegram.py
sha256sum ~/.local/libexec/mainspot/remote-alert-telegram.py   # debe coincidir con el blob del commit autorizado
```

Si después se usa el productor, ese sha256 sustituye a `MAINSPOT_REMOTE_ALERT_COMMAND_SHA256` en la
configuración local del productor. Nunca se publica la configuración.

## 2. Clave de acuse y política (sin red; secretos solo en el equipo)

```bash
umask 077
python3 -c 'import secrets; print(secrets.token_hex(32))' > ~/.config/mainspot/backup/telegram-ack.key
chmod 0600 ~/.config/mainspot/backup/telegram-ack.key
```

Se añade a `~/.config/mainspot/backup/telegram-alert.env` la política de acuse que fije el permiso. Los
valores de abajo son solo un ejemplo para la prueba, no la cadencia de producción:

```
ACK_DEADLINE_SECONDS=900
ACK_REMINDER_INTERVAL_SECONDS=600
ACK_MAX_REMINDERS=1
```

Comprobación local, sin red: `--status` termina con 0 o 18 y no imprime secretos.

## 3. Prueba (requiere el permiso del paso 0)

**Variante A: evento sintético del adaptador.**

1. `~/.local/libexec/mainspot/remote-alert-telegram.py --synthetic-test`
   - Se espera la salida 0 y, en stdout, `{"receipt": {"api_accepted": true, "human_acknowledged": false, "ack": "pending", "message_id": …}}`.
   - Se anotan solo `event_id` y `message_id`.
2. El propietario confirma que ve el mensaje: primera línea `ID: <event_id>` y el botón «Confirmar recepción».
3. El propietario pulsa el botón.
4. `~/.local/libexec/mainspot/remote-alert-telegram.py --ack-poll --max-seconds 120`
   - Se espera `{"ack_poll": {"accepted": 1, …}}`, el aviso «Recepción confirmada» en Telegram y el botón retirado.
5. `~/.local/libexec/mainspot/remote-alert-telegram.py --status`
   - Se espera el evento en `human_acknowledged` y la salida 0.

**Variante B: E2E sintético generado por el productor en local.**

Se usa un `MAINSPOT_BACKUP_DIR` temporal con un único respaldo cifrado sintético. El límite se baja con
`MAINSPOT_REMOTE_LAB_MAX_BACKUP_BYTES=1`, que fuerza E-SIZE-LIMIT antes de cualquier operación S3. El
endpoint S3 apunta a `127.0.0.1` sin servicio (nunca a Garage).

- Antes de la prueba real se ensaya con el Telegram falso de `tests/ops/backup-remote/test_alert_telegram.py`, para conocer el número exacto de avisos que emitirá la ejecución.
- Después se repiten los pasos 2–5 con el `event_id` de E-SIZE-LIMIT.

**Rama sin acuse.** Si no hay acuse dentro del plazo:
- `--check-overdue` envía como mucho `ACK_MAX_REMINDERS` recordatorios y deja el evento en `ack_overdue` o `needs_operator_attention`;
- el resultado se registra como FAIL de recepción;
- **no** se reintenta con otro canal.

## 4. Evidencia (saneada)

Solo se registran:
- `event_id` y `message_id`;
- los estados y transiciones de `--status` y del registro (`history`);
- `actor_ref` (HMAC, no reversible);
- los códigos de salida;
- el sha256 del adaptador.

Nunca se registran el token, el chat, el usuario ni la clave.

F-01 solo se cierra como PASS con una confirmación humana nueva del propietario en el issue, además del estado
`human_acknowledged` registrado.

## 5. Retirada

Si el permiso no continúa hacia la producción:
- se borran `telegram-ack.key` y las claves `ACK_*`;
- se conserva el registro `~/.local/state/mainspot/alerts/` como evidencia local (0700/0600);
- no queda ningún proceso ni temporizador activo.
