# F-01 — Alertas MainSpot con acuse verificable (definición funcional y técnica inicial)

**Estado:** DEFINICIÓN PARA IMPLEMENTACIÓN EN RAMA AISLADA; no desplegado, no activado.  
**Origen:** simulacro E2E 2026-10-25, reporte `docs/contracts/backup-object-storage/e2e-drill-report-2026-10-25.md`, F-01.  
**Base:** `feat/canonflow-implementation@48272cc40dc4aaef2dbfc12b8ba83cbad242e5c3`.  
**Decisiones existentes:** DEC-0064 (bot exclusivo y secretos locales), DEC-0065 (avisar en la ejecución, reintentos acotados y confirmación humana antes de producción).  
**Contrato Garage:** `contract/backup-object-storage-v1@c4f87c4aa2e875e7ad01861f5f2a809e025d638c`, sin modificar.

## 1. Problema comprobado, no inferir otra causa

El productor rechazó correctamente un objeto sintético sobredimensionado con `E-SIZE-LIMIT`, antes de cualquier S3 write, y registró `delivery=ok`. El adaptador recibió `sendMessage.ok=true` por TLS del bot correcto, pero **el propietario NO recibió el aviso** `event_id=ac931611c7ef4f279c5eef542c4d5b53`. La causa raíz sigue **indeterminada**. `message_id` no fue persistido y no puede recuperarse retroactivamente mediante este flujo.

El vigilante del KVM usa otro canal: la recepción de sus mensajes `VIGIL-RETENTION-WARN` no acredita la recepción de avisos del productor.

**Invariante semántico:** `api_accepted` y `human_acknowledged` **nunca** son sinónimos. La asignación de `message_id` indica mensaje aceptado/creado por Telegram, **no** visualización ni lectura.

## 2. Alcance funcional autorizado para DESARROLLO

1. Cada evento operativo notificable del productor tiene `event_id` único y estable; una entrega confirmada por la API almacena correlación segura `event_id` ↔ `message_id` ↔ `message_date` y un estado independiente de ACK humano.
2. En Telegram, mensajes que exigen acuse muestran un botón **«Confirmar recepción»**. Al pulsarlo, el bot responde con una confirmación visible y el servicio almacena un ACK auditable ligado al evento y al remitente autorizado. Sin botón en mensajes meramente informativos cuando no requieran ACK.
3. La falta de ACK tras un plazo *configurable* produce estado `ack_overdue`, evidencia y recordatorio acotado. El recordatorio al **mismo Telegram no garantiza entrega**. Si no existe canal secundario independiente aprobado, registrar estado `needs_operator_attention` sin fingir escalamiento confiable. No incorporar un destino alternativo sin decisión del propietario.
4. Cualquier reintento conserva `event_id`, es idempotente y no genera ACK a otro evento. Un ACK tardío queda registrado como tardío, sin borrar incumplimientos previos.
5. Operación segura tras reinicio: persistencia durable de eventos y estados, recuperación y no pérdida de ACK aun con callbacks duplicados o terminación entre escritura de estado y avance de cursor.
6. El sistema sigue enviando alertas en la ejecución que detecta el error, con timeout acotado y cola de fallos existente; el procesador de ACK es independiente. **Jamás bloquear el respaldo esperando ACK.**
7. La confirmación automática solo es posible por una acción autenticada del propietario en Telegram, **no** por HTTP 200, `ok:true`, `message_id` o `getChat`.

### Contrato de estados (conceptual)

- `created` → `api_accepted` (Telegram devolvió `ok:true`, `result.chat.id` correcto, `message_id` y fecha válidos).
- `created` → `send_failed` (rechazo, timeout, respuesta malformada, chat distinto; conservar cola/reintentos).
- `api_accepted` → `human_acknowledged` (callback válido + identidad y correlación verificadas).
- `api_accepted` → `ack_overdue` (sin callback válido al vencimiento).
- `ack_overdue` → `acknowledged_late` (acuse posterior, preservando violación temporal).
- `send_failed` no se interpreta como `ack_overdue`. ACK de usuario distinto, desactualizado o inválido nunca altera estado.

## 3. Diseño técnico propuesto (a implementar por SOL MAIN tras ajustar documentación canónica)

### A. Emisión y recibo del proveedor

- Revisar `scripts/ops/backup/remote-alert-telegram.py` y la interfaz de `db-backup-remote.py` sin romper los casos DEC-0065 existentes.
- En `sendMessage`, **exigir** `ok === true`, `result.chat.id` exactamente igual al chat configurado como identificador entero, `result.message_id` entero positivo y `result.date` válido; falla segura si falta alguno; no tratar el mero `ok:true` como éxito contractual.
- Correlación durable en almacenamiento privado del productor con escritura atómica, permisos 0700/0600, sin token, chat_id, URL autenticada ni payload sensible en logs o Git. Manejar fallos de persistencia de recibo separadamente (no marcarlo como ACK ni como éxito observable completo).
- Renderizar el `event_id` en la primera línea del mensaje, seguido de código y contexto sin secretos. Si se añade `reply_markup.inline_keyboard`, respetar tamaño Telegram (`callback_data` ≤64 bytes).
- Evitar que respuesta parcial, anomalía de JSON, respuesta de otro chat, error de TLS o caída entre aceptación y persistencia den un PASS falso. Definir comportamiento ante entrega incierta para evitar duplicados sin trazabilidad: estado `api_acceptance_uncertain` y reconciliación humana/documentada, no reenvío ilimitado.

### B. ACK seguro en Telegram

- Preferir inicialmente **long polling `getUpdates`** con único consumidor bloqueado por `flock`, sin puerto público ni webhook; esta elección se revisa contra restricciones del host. Bot privado exclusivo existente.
- Proteger `callback_data` contra falsificación mediante HMAC con secreto local exclusivo de ACK, aleatorio y 0600 (NO utilizar el token Telegram como clave de firma). Versión, `event_id` y firma truncada ajustadas a 64 bytes. Ejemplo de forma, **no token real**: `a1:<32 hex>:<16 hex HMAC>`.
- Para aceptar ACK verificar HMAC con `hmac.compare_digest`, que el usuario que pulsó coincide con el usuario/chat esperado, que `callback_query.message.chat.id` coincide con el chat autorizado, que `message.message_id` coincide con el recibo guardado, y que el evento existe en estado apto.
- No usar `getUpdates` para consultar el historial de mensajes enviados: no ofrece esa capacidad. `answerCallbackQuery` es confirmación de interfaz para quien pulsó, no reemplaza la persistencia del ACK.
- Persistir el ACK de forma atómica **antes** de avanzar el `update_id` / offset. Redelivery por crash y doble pulsación deben ser idempotentes. Probar clicks falsificados, repetidos, ajenos, antiguos y fuera de orden.
- Si el proceso está desactivado, los mensajes pueden aparecer pero no se procesan ACKs: marcar el servicio no disponible en health; no declarar `human_acknowledged`.

### C. Plazos y recordatorios

- Plazos de ACK configurables y bajo un único reloj UTC. Para pruebas, reloj inyectable; **no fijar ni activar cadencia de producción durante este desarrollo**.
- Estado duradero `ack_overdue` y reporte de exposición para operaciones; recordatorios acotados para evitar inundaciones y loops; alerta secundaria solo si hay canal aprobado e independiente.
- No considerar el mismo bot como redundancia/escala garantizada.
- Si se requiere persistencia en PostgreSQL existente, justificar dependencia con degradación segura cuando la BD esté caída, dado que precisamente alertamos problemas de respaldos. Se prefiere estado mínimo durable local separado, con respaldo/retención e idempotencia, sin dependencia de la BD que podría estar fallando.

## 4. Pruebas y evidencia mínimas (sin red externa ni S3)

Base actual: `tests/ops/backup-remote/test_alert_telegram.py`, servidor Telegram falso HTTPS. Actualizar el falso para devolver `result.message_id`, `result.date`, `result.chat.id`; probar respuesta inválida/otro chat/ID ausente/no entero.

- Envío aceptado ≠ ACK; envío válido persiste recibo en permisos seguros y no filtra secretos en stdout/stderr/archivo/issue.
- Callback válido del usuario autorizado sobre el mensaje correcto → `human_acknowledged`, con idempotencia y un único evento de auditoría.
- Callback con actor distinto, chat distinto, HMAC inválido, mensaje distinto, evento inexistente o manipulaciones de fecha → rechazado sin transición.
- Callback duplicado, desordenado y crash antes/después de persistir ACK → ningún falso éxito, sin pérdida.
- Timeout ACK y recordatorios: reloj simulado, sin spam, `ack_overdue`; ACK tardío conserva historial de vencimiento.
- Ausencia de `TELEGRAM_BOT_TOKEN`, archivo con permisos inseguros, múltiples pollers, respuesta 429/5xx, webhook ajeno, caducidad del cursor: detención segura/observabilidad sin pérdida ni secret leakage.
- El productor mantiene su lógica `E-SIZE-LIMIT` pre-S3, sin acceso real a Garage y sin activar timers. Pruebas de regresión del productor y del adaptador deben pasar.
- Incluir **caso específico F-01**: `api_accepted=true`, sin callback → `human_acknowledged=false` y vencimiento documentado.

## 5. Gates y autoridad

**Autorizado en este turno:** definición, implementación en rama aislada y **pruebas completamente locales con Telegram falso**; evidencia y revisión. Sin mensajes a Telegram real todavía.

**Prohibido sin una autorización posterior y explícita:** enviar `TEST-SYNTHETIC` o `E-SIZE-LIMIT` real, ejecutar pruebas en Garage, crear/reabrir buzón SFTP, modificar credenciales, activar timers/servicio ACK productivo, desplegar código en host o habilitar condición 7 HDC.

Para levantar F-01 se requerirá (a) código revisado y tests, (b) prueba local generada por **productor**, sin S3 y con mensaje al bot real **tras aprobación de la prueba**, (c) propietario pulsa botón y el sistema registra `human_acknowledged` con IDs correlacionados, (d) verificación independiente de E4 pendiente por OMP KVM 4. **No reinterpretar automáticamente el evento histórico como recibido.**

## 6. Secuencia para el agente

1. Actualizar definición funcional canónica → técnica canónica → implementación; proponer nuevos IDs/decisiones solo donde sean necesarios, sin reescribir DEC-0064/0065.
2. Implementar en esta rama por commits pequeños: recibo del proveedor + tests; callback ACK y estado durable + tests; vencimiento/recordatorio + tests.
3. Ejecutar regresiones, auditoría de secretos y controles de integridad; publicar comandos/salida, SHAs, diseño final y NO-GO/GO del código.
4. Publicar informe F-01 como **remediación implementada y probada offline**, dejando claramente **recepción humana original FAIL** hasta nueva prueba aprobada y verificada.
