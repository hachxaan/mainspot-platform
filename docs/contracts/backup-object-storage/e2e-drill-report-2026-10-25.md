# Informe del simulacro E2E contra Garage S3 real — 2026-10-25

No normativo, sin secretos.

- **Plan:** `e2e-drill-handoff.md` @ `aa9919fae52658d0846c47a9bef3f3ca28c835b1` (K1–K7).
- **Procedimiento del operador:** `hachxaan/mainspot-s3-backups` `docs/15`. Servicio en la ventana: `ec7cb72a`;
  código desplegado sin cambios desde `9c880469`.
- **Contrato:** 1.2.0 `c4f87c4aa2e875e7ad01861f5f2a809e025d638c`.
- **Autorización:** mandato 6390217275 y ventana 6395613646 (08:50–13:00 UTC).
- **Coordinación:** issue #2 del servicio.
- **Datos y producción:** solo sintéticos (`deployment_id=synthetic-drill`, base demo `postgres:16`
  desechable, clave sintética). Productor y temporizadores sin activar.

## Resultado por objetivo

| Objetivo | Estado | Evidencia |
|---|---|---|
| **Condición 5** (productor contra el servicio real, datos de prueba borrados al terminar) | **PASS** | B2: `OK action=uploaded` A1/A2, `attempts=1`, verificación §8.3, `check=daily` OK `complete=2`, `lifecycle=ok`; `--check-only` OK. Objetos borrados (D3a) y `v1/` = 0 en E1 |
| **Rechazo por tamaño (1.2.0 §8.2 paso 0)** | **PASS** | B3: `FAIL E-SIZE-LIMIT action=size-rejected attempts=0` (101 062 B > 95 453 B de laboratorio); B nunca llegó a S3; archivos locales de B intactos; A1/A2 `already-complete` |
| **Aviso E2E generado por el productor (DEC-0065)** | **Envío técnico aceptado por la API; recepción humana FAIL (no recibido)** | Productor: `status=ALERT error=E-SIZE-LIMIT event_id=ac931611c7ef4f279c5eef542c4d5b53 delivery=ok` a las 10:00:22Z, en la misma ejecución, por `MAINSPOT_REMOTE_ALERT_COMMAND` (sha256 y permisos verificados). `delivery=ok` solo es posible si el adaptador terminó con 0, es decir, si Telegram respondió `ok: true`. **El propietario no recibió el mensaje** (6398619807): solo vio `VIGIL-RETENTION-WARN` FIRING/RESOLVED del canal del KVM 4. Ver hallazgo **F-01** |
| **Condición 6a** (restauración desde `mainspot-backups`) | **PASS** | C: `verify` `valid:true` (objeto, MAC y clave de almacenamiento); `pg_restore --exit-on-error` rc=0; recuento exacto de las 33 tablas igual al origen; §11.3 `--reapply-exits` → `reanonymized: 1` |
| **Condición 6b** (copia protegida con originales ausentes, §11.4 B) | **PASS** | D5/D6: archivos de la copia de A2 con sha256 = D1 = los del productor; `v1/` = 0 con restore; `verify` `valid:true` con la clave relativa; descifrado en el equipo de MainSpot; 33 tablas iguales; `reanonymized: 1` |
| **§9.2.6 pasos 1–6** | **PASS** | 1: dos pares del productor. 2: D1, 2 copias con sha256 = manifiestos. 3: D3a borrado de 4 claves exactas (204 ×4); D3b `DeleteBucketLifecycle` 204 (**T0 = 10:44:22Z**); D3c regla `synthetic-drill-1d` 200. 4: D4a `copies_orphaned=2`, `verify_failed=0`, `anomalies=0`, sin `expire`; D4b writer `HeadBucket` guard → 404, `ListBuckets` solo `mainspot-backups`. 5: D6. 6: el vigilante restauró §9.1 a las 10:58:43Z (restore 10:58:53Z, T0 + 14 min 31 s), `lifecycle_drift restored=true`, sin intervención K3 |
| **§9.2.6 paso 7 / E2** (limpieza de la copia, `--ack-drift`, salud 9/9) | **PASS (operador)** | 6397100773, `hachxaan/mainspot-s3-backups@6945a6329f8e36f11a56c380ce6696ef6fae4260` (evidence/48): 4 `expire` solo en `synthetic-drill`, 0 copias ajenas antes y después, `--ack-drift` 11:31:05Z, salud 9/9, bucket 0 objetos, ciclo de vida §9.1 exacto, buzón vacío; log S3 de la ventana sin desviaciones (rotación no requerida) |
| **S-13** | **Evidencia del simulacro PASS** | Máximo observado en `mainspot-backups` durante el simulacro: **94 453 B** (objeto 93 440 + manifiesto 1 013), muy por debajo del máximo de diseño de 1 GiB; rechazo por encima del límite sin escritura; capacidad medida por el operador (S-15 1.2.0, evidence/43); E2 cerrado. Queda la verificación independiente de E4 por el operador |

## Cronología (UTC)

| Hora | Hecho |
|---|---|
| 08:53 | A2 (SOL MAIN) y A3 (KVM) PASS → GO técnico mutuo |
| 09:57–10:00 | Configuración del buzón por el propietario (18 PASS); `handoff-pub.asc` subida; paquete sha256 `09478997…e7e6` recibido y verificado; descifrado en tmpfs |
| 09:59–10:01 | B1, B2, B3, C1–C4 |
| 10:38:44 | D1 (operador, K1): 2 copias verificadas |
| 10:44:21–22 | D3a, D3b (T0) y D3c; D4b |
| 10:45 | D4a y D5 (operador) |
| 10:46 | D6 |
| 10:58:43 | El vigilante restaura §9.1 (D7) |
| 10:59 | E1: `v1/` 0, `_conformance/` 0 |
| 11:23 | E3 en el equipo de MainSpot: credenciales, paquete, claves efímeras (GPG en tmpfs y SSH) y bases desechables destruidos |

## Limpieza

- **E1:** `mainspot-backups` sin objetos.
- **E3:** sin credenciales, claves efímeras, bases ni espacio de trabajo en el equipo de MainSpot; productor
  `DISABLED`, sin `remote.env`, 0 unidades remotas.
- **E2:** PASS del operador (arriba).
- **E4:** el propietario ejecutó el teardown; salida `OK usuario eliminado`, `OK sin drop-in, claves ni buzón`,
  `forcecommand none`, `chrootdirectory none` (6398592957). Falta la verificación independiente del
  operador.

## Hallazgo F-01 — aviso del productor aceptado por la API pero no recibido por el propietario

**Estado: ABIERTO.** El criterio de recepción humana de DEC-0065 para avisos generados por el productor
queda en **FAIL** hasta una nueva entrega observada.

### Evidencia (solo lectura, 2026-10-25 ≈14:10Z, sin enviar mensajes)

| Comprobación | Resultado |
|---|---|
| Correlación del `event_id` | `ac931611c7ef4f279c5eef542c4d5b53` figura en la salida del productor, en `backup-remote.log` y en `remote-alerts.jsonl` (10:00:22Z) con `outbox=ok delivery=ok`; sin evento pendiente |
| Adaptador ejecutado | `~/.local/libexec/mainspot/remote-alert-telegram.py`, sha256 `d42fe40b…` (= repo `5ccd4d21`), sin cambios desde 2026-10-24T21:06Z; verificado por el productor antes de ejecutarlo |
| Significado de `delivery=ok` | Código de salida 0 del adaptador. El adaptador solo devuelve 0 si la respuesta HTTPS de `sendMessage` trae `ok: true` (TLS verificado, `api.telegram.org`, sin `TELEGRAM_API_BASE` ni CA alternativa configurados) |
| Configuración efectiva | `~/.config/mainspot/backup/telegram-alert.env`: 0600 y propietario `administrador`, directorio 0700; exactamente 1 `TELEGRAM_BOT_TOKEN` y 1 `TELEGRAM_CHAT_ID`, sin claves extra, comillas ni espacios. **Última modificación: 2026-10-24T21:51:38Z**, 28 s antes de la prueba TEST-SYNTHETIC confirmada (21:52:06Z), sin cambios después. El productor pasó al adaptador `HOME=/home/administrador`, el mismo directorio de configuración |
| Identidad del bot (`getMe`) | `is_bot: true`, nombre **«MainSpot Backup Alerts»**; el prefijo del token coincide con el id del bot. Es el bot exclusivo, no el del KVM 4 |
| Destino (`getChat`) | Chat **privado** de un usuario humano, distinto del bot; el id coincide con el configurado |
| Quién abrió el chat (`getUpdates` sin confirmar actualizaciones) | Única actualización pendiente: un `/start` del **mismo usuario configurado**, el 2026-10-24T21:51:23Z, 15 s antes de crear la configuración |
| Webhook | No configurado |
| Respuesta del proveedor conservada | **Ninguna.** El adaptador no guarda `message_id` ni el `chat.id` devuelto, así que no se puede demostrar qué mensaje se creó |

### Diagnóstico

- **Igual entre TEST-SYNTHETIC (recibida) y B3 (no recibida):** bot, chat, archivo de configuración,
  adaptador y endpoint. **Distinto:** el origen del evento (`--synthetic-test` manual frente a invocación
  por el productor con entorno mínimo) y el contenido del texto.
- Ninguna diferencia explica una entrega a otro destino. Con la evidencia disponible, Telegram **aceptó** el
  mensaje para el chat configurado, que pertenece al usuario que hizo `/start` en el bot correcto.
- **Causa raíz: no determinada.** No se puede distinguir entre:
  - (H1) el mensaje llegó al chat, pero no se vio (cliente o dispositivo, chat silenciado o archivado,
    historial borrado);
  - (H2) la API aceptó el mensaje y no lo entregó (muy improbable).

  Falta la prueba decisiva porque el adaptador **no conserva el recibo** del proveedor.
- **Defecto confirmado (instrumentación):** `send()` da por buena cualquier respuesta `ok: true`. No
  comprueba que `result.chat.id` sea el destino configurado ni registra un `message_id`, así que «API
  aceptó» y «propietario confirmó» no se pueden correlacionar. Es una carencia frente a DEC-0065, que pide
  seguimiento y no registrar como éxito lo que no se puede verificar.

### Remediación propuesta (no aplicada; requiere autorización)

1. **Comprobación humana sin nuevos envíos:** el propietario abre el chat «MainSpot Backup Alerts» en todos
   sus dispositivos (incluidos los chats archivados y silenciados) y busca `ac931611` / `E-SIZE-LIMIT`
   (≈05:00:22 hora de Cancún del 25/10) y el TEST-SYNTHETIC `f7b848ef…` (21:52:06Z del 24/10).
   - Si TEST-SYNTHETIC sigue y E-SIZE-LIMIT no aparece → H2, o borrado selectivo.
   - Si ninguno aparece → historial borrado o chat distinto.
   - Si aparece → H1.
2. **Instrumentación del adaptador:**
   - exigir `result.chat.id` = destino configurado (si no, código distinto de 0);
   - devolver al productor un recibo no secreto (`message_id` y fecha de Telegram) y registrarlo en la
     línea `status=ALERT` y en `remote-alerts.jsonl`;
   - incluir el `event_id` en la primera línea del mensaje para facilitar la búsqueda;
   - pruebas nuevas con el Telegram falso.
3. **Nueva prueba E2E de recepción, con autorización expresa:** un aviso generado por el productor (por
   ejemplo `E-SIZE-LIMIT` local, sin S3 ni credenciales del servicio), confirmado por el propietario con el
   `event_id` **y** el `message_id` registrado.
4. Mantener el criterio en FAIL y no pedir la condición 7 hasta que 2 y 3 estén hechos.

### Estado de la remediación (rama `feat/f01-telegram-acknowledged-alerts`)

**Implementado y probado solo offline**, con un Telegram falso en `127.0.0.1`: sin mensajes reales, sin
despliegue, sin Garage y sin temporizadores. Informe completo: `f01-remediation-report.md`.

- **Punto 2 cubierto y ampliado:**
  - recibo verificable (`chat.id`, `message_id`, `date`) persistido;
  - `event_id` en la primera línea;
  - botón «Confirmar recepción» con firma HMAC;
  - consumidor único de callbacks;
  - vencimiento y recordatorios acotados.
- **Punto 3 sin ejecutar:** procedimiento preparado en `f01-ack-mini-bootstrap.md`, pendiente de autorización expresa.
- **El evento histórico `ac931611…` no se reinterpreta.** Sigue sin `message_id` y la recepción humana DEC-0065 se mantiene en **FAIL**. F-01 queda ABIERTO hasta una prueba real autorizada con acuse por el botón (`human_acknowledged`) y la confirmación nueva del propietario en el issue.

## Riesgo residual observado

Entre la recepción y E3 (≈ 1 h 25 min), las credenciales writer/restore estuvieron en tmpfs (0700/0600)
fuera de un scope sin swap: el descifrado inicial sí se hizo con `MemorySwapMax=0`, pero el archivo
permaneció en tmpfs, y el swap del equipo es un archivo sin cifrar. No hay evidencia de que se paginaran.
La rotación no es obligatoria según docs/14 §5 si el operador no detecta desviaciones; el propietario puede
pedirla.
