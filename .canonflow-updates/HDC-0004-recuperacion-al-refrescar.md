# HDC-0004 — Restaurar elecciones y comentarios al refrescar

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-21 |
| Estado | `PARCHE_LISTO` |
| Clase | Corrección de conformidad (§10, §11, §16 I4) |
| Solicitud | «Si la página se refresca, debe cargar las elecciones y comentarios» |

## Problema observado

Al refrescar el workspace, todas las elecciones y comentarios desaparecían. Las
sesiones ya enviadas solo mostraban la referencia del ANS, no las respuestas.

## Causa raíz

1. La UI guardaba el borrador con `PUT /draft` 600 ms después del último cambio,
   pero `render()` no lo aplicaba; solo recuperaba `answered_by`.
2. El borrador se construía solo con preguntas respondidas, así que se perdía un
   comentario escrito antes de elegir opción.
3. Un cambio hecho menos de 600 ms antes de refrescar todavía no estaba en el
   servidor.
4. En `ANSWERED`, `INGESTED` y `ARCHIVED`, `renderSentOrClosed` no mostraba las
   respuestas. §11 exige que las respuestas queden en modo lectura tras el envío.

## Cambio

Aplica sobre HDC-0003. Archivo:
`decision-console/app/canonflow_hdc/frontend/js/views/workspace.js`. Parche:
[`patches/HDC-0004-refresh-draft-recovery.patch`](patches/HDC-0004-refresh-draft-recovery.patch).

Nuevas funciones: `draftStorageKey`, `readPendingDraft`, `draftPayload`,
`sameDraft` y `restoreDraft`.

**Sesión `PENDING`:**

- Restaura solo borradores con el mismo `question_session_id` y
  `question_sha256` que la QS actual. Prioridad:
  1. copia local pendiente;
  2. borrador del servidor.
- Inicializa los controles de los ocho tipos: opción, casillas, sí/no,
  aprobación, riesgo con fecha y justificación, texto libre, orden, confirmación
  y comentarios. Incluye comentarios sin respuesta.
- Restaura un orden solo si es una permutación válida. Si estaba confirmado pero
  su orden ya no es válido, la confirmación vuelve a `false`.
- Restaura el nombre y `request_id`, conforme a §5.3. La casilla de identidad
  siempre empieza sin marcar y nunca se envía automáticamente.
- Un borrador de otra versión de QS se muestra como texto en `<details>` y no se
  aplica.

**Autoguardado:**

- Cada cambio emite `draftchange` y escribe inmediatamente en `sessionStorage`
  (`hdc-pending-draft:QS-xxxx`) antes del `PUT` diferido de 600 ms.
- Un contador de revisión mantiene pendientes los cambios hechos durante un
  guardado en curso y los guarda después.
- Tras el acuse del servidor se borra la copia local.
- Si una recarga pierde el acuse, `sameDraft` reconoce que el servidor ya tiene
  el mismo contenido y borra la copia.
- Un `412` conserva la edición local, muestra `err_412` y no sobrescribe la otra
  pestaña.

**Envío:**

- Pausa el autoguardado, espera cualquier guardado en curso, renueva CSRF y
  publica.
- Si el envío falla, reanuda el autoguardado.
- Si tiene éxito, borra la copia local y detiene el autoguardado. El servidor
  elimina el borrador según §7.2 paso 9.

**Sesiones `ANSWERED`, `INGESTED` y `ARCHIVED`:**

- Lee el ANS y exige que `question_session_id` y
  `submission.question_sha256` coincidan con la QS.
- Muestra respuestas y comentarios en controles deshabilitados.
- Oculta la confirmación de orden, porque es consentimiento del envío y no se
  persiste en el ANS.
- No inicia autoguardado ni reabre la sesión.

## Contrato afectado

- §10: ETag, guardado a 600 ms e indicador. «Un borrador cuyo hash ya no coincide
  se conserva, pero no se reaplica»; por tanto, se reaplica el borrador con hash
  vigente.
- §11: «Tras envío, las respuestas quedan en lectura».
- §16 I4: recuperación de borrador y no aprobación por defaults.

## Archivos upstream

- `decision-console/app/canonflow_hdc/frontend/js/views/workspace.js`.
- Resultado de la pila HDC-0003 + HDC-0004 sobre la base: sha256
  `4744e98ed3b76a92db143a6fc1f6d425a599cf3530cc9a204c923241370b1bed`.
- Ese resultado era byte a byte igual a `scripts/deploy/hdc-workspace.js`, que
  HDC-0005 sustituyó por `scripts/deploy/hdc-ui/`.

## Despliegue en MainSpot

Hasta HDC-0005, `scripts/deploy/hdc-workspace.js` se instalaba como
`/var/www/mainspot-hdc-ui/workspace.js` en el LXC `webserver` y lo servía la
`location = /js/views/workspace.js` del vhost con `Cache-Control: no-cache`. Solo
se aplicaba por HTTPS. El backend y los contratos no cambian. Desde HDC-0005 esta
lógica se conserva en el `workspace.js` rediseñado del frontend completo
(`scripts/deploy/hdc-ui/`).

## Verificación ejecutada

Se usó Chromium real con el backend Python existente, sobre proyectos sintéticos
temporales:

- **Ocho tipos y comentarios:** tras recargar se restauraron los ocho tipos y un
  comentario sin respuesta. El nombre se restauró, pero la identidad quedó sin
  confirmar y el envío deshabilitado.
- **Guardado y recarga:**
  - Recarga antes de existir borrador en el servidor (`404`): se restauró la
    copia local sin inventar opciones.
  - Acuse retrasado 1,5 s y recarga: se restauró el contenido ya confirmado y se
    reconcilió la copia.
  - Edición durante un guardado lento: se persistió la última edición.
- **Conflictos y versiones:**
  - Borrador con otro hash: visible como texto, no aplicado y conservado en el
    servidor.
  - Dos pestañas: `412`, sin sobrescribir la otra; la edición local se conservó y
    se restauró tras recargar.
- **Envío y lectura:**
  - Envío explícito inmediatamente después de editar: el ANS contenía la última
    edición, el orden y los comentarios. Después, el borrador del servidor dio
    `404` y se borró la copia local.
  - Recarga de la sesión enviada: valores y comentarios en lectura, sin botón de
    envío ni borrador nuevo.

Los proyectos sintéticos solo crearon ANS temporales; ninguno creó DEC, APR o RSK.

Sobre QS-0001 real de MainSpot, ya `ANSWERED`, se mostraron en lectura **9
valores y 5 comentarios** guardados. Los resultados fueron:

- sha256 del ANS `fbc6ffd3c0a2fab599d84410edcaaa0798b8d0ae70c04c6d0592f4bd29815291`,
  sin cambios tras recargar;
- cero envíos reales.

El 2026-10-21 se redesplegó el resultado de la pila. HTTPS sirve sha256
`4744e98e…1bed`, la vista se renderiza sin errores de página y la sintaxis del
módulo ES se comprobó con el transpilador de Bun.

## Ajustes al integrar en CanonFlow

1. `web.py:231` fija siempre `auto_reapplied: False`. Con este cambio debe ser
   `not draft_view["stale"]`.
   - Actualizar `tests/test_frontend.py:64`, que hoy espera `False` para un
     borrador vigente.
   - Añadir un caso con hash obsoleto que espere `False`.
   - No está desplegado en MainSpot porque la UI no lee ese campo.
2. Mover a `i18n.js` las cuatro cadenas bilingües escritas en `workspace.js`
   (**resuelto en HDC-0005**).
   Claves propuestas:
   - `ws_draft_restored`;
   - `ws_draft_other_version`;
   - `ws_answers_readonly`;
   - `ws_answers_unavailable`.
3. `ws_source_changed` ya no se usa en `workspace.js`. Decidir si se elimina de
   `i18n.js` o si se implementa el bloqueo de envío que describe; `sourceChanged`
   nunca pasa a `true`, ni en la base ni con el parche.
4. §14 exige permisos privados para borradores. La copia en `sessionStorage`
   guarda el texto en el navegador, solo para el mismo origen y pestaña, hasta el
   acuse o cierre. El propietario debe aceptar ese almacenamiento o sustituirlo,
   por ejemplo con `fetch(..., {keepalive: true})` en `pagehide`.
5. Ajustar la redacción de §10 y del docstring de `local_data.py`: el borrador
   con hash vigente se reaplica.
6. Añadir pruebas Playwright de los escenarios verificados.

## Riesgos y límites

- `sessionStorage` es por pestaña. Cerrar la pestaña menos de 600 ms después de
  editar pierde esa edición, y otra pestaña nueva no ve cambios aún no guardados.
- `[INFERENCIA]` Según el código, un ANS heredado sin
  `submission.question_sha256` muestra el aviso `ws_answers_unavailable` en lugar
  de las respuestas. No se ejecutó con una cadena heredada.
- No se cubre un cambio de versión de QS mientras la página está abierta; sigue
  la lógica existente de `main.js`.
