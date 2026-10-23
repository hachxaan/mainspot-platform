# HDC-0003 — Errores de validación vigentes y orden confirmado sin reordenar

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-21 |
| Estado | `PARCHE_LISTO` |
| Clase | Corrección de conformidad (§6, §10, §16 I4) |
| Solicitud | El envío de QS-0001 seguía devolviendo `422`, con el comentario de `Q-LIMITS` escrito |

## Problema observado

El formulario mostraba bajo `Q-LIMITS` «question requires a non-blank comment on
any included answer», aunque el payload incluía un comentario no vacío.

La validación offline del mismo payload aceptó `Q-LIMITS`. El error real era
`REQUIRED_MISSING` para `Q-APPROVALS`, `Q-NFR` y `Q-PRIORITY`.

## Causa raíz

1. Los errores por pregunta (`[data-error]`) nunca se limpiaban. Quedaba visible
   el mensaje de un envío anterior aunque el campo ya estuviera corregido.
2. El resumen solo mostraba el texto genérico de `err_422`.
   `REQUIRED_MISSING` usa `path: "answers"`, sin ID de pregunta, así que no se
   asociaba a ninguna pregunta y quedaba invisible.
3. En `ordered_priority`, marcar «Confirmo este orden» solo guardaba
   `confirmations[qid]`. El valor solo se guardaba si se movían filas. El payload
   llevaba la confirmación sin respuesta y fallaba por `REQUIRED_MISSING`.

## Cambio

Archivo: `decision-console/app/canonflow_hdc/frontend/js/views/workspace.js`.
Parche: [`patches/HDC-0003-validation-errors-confirmed-order.patch`](patches/HDC-0003-validation-errors-confirmed-order.patch).

- Cada pregunta borra su error al editarse.
- Cada envío limpia todos los errores por pregunta antes de llamar a la API.
- El resumen muestra la traducción del estado, `error.message` y cada
  `field_errors[].message`.
- Confirmar un orden sin moverlo guarda la permutación mostrada como respuesta.
  Nunca se preselecciona: requiere la confirmación explícita.

## Contrato afectado

- §6: `ordered_priority` exige una permutación completa y confirmación explícita.
  La UI impedía responder correctamente el orden mostrado inicialmente.
- §10: error uniforme con `field_errors`.
- §16 I4: errores accesibles.

## Archivos upstream

- `decision-console/app/canonflow_hdc/frontend/js/views/workspace.js`.
- Resultado tras aplicar este parche sobre la base: sha256
  `e1de21da64282ccdcb485fbddde96a6217aa87ee706904f620532cb797eda014`.

## Despliegue en MainSpot

Se desplegó en `scripts/deploy/hdc-workspace.js`, junto con HDC-0004. Nginx lo
servía solo por HTTPS como `/js/views/workspace.js`; el loopback directo sigue
usando el asset del pin. Desde HDC-0005 queda incluido en el frontend completo
`scripts/deploy/hdc-ui/`, y `hdc-workspace.js` se eliminó.

La primera versión desplegada equivale byte a byte a este parche sin el salto de
línea final: sha256
`c67e4e58a78ca0624ec841440fc037e7314793d8b69f469db20bfc1c728ff2f9`.

## Verificación ejecutada

Se usó Chromium real con el backend Python existente sobre un proyecto
sintético temporal:

- Un override sin comentario se rechaza y el error aparece en su pregunta.
- Al editar, el error se borra. El envío siguiente no conserva errores antiguos y
  muestra los `REQUIRED_MISSING` actuales.
- El override con comentario y el orden confirmado sin mover filas se publican
  en un ANS temporal. Resultado: `overridden_default: true` y orden
  `stage_1, stage_2, stage_3`.

No se envió ninguna respuesta real de MainSpot.

## Ajustes al integrar en CanonFlow

1. §10 indica que la UI traduce los mensajes por código. Mapear
   `field_errors[].code` a claves de `i18n.js`; hoy el resumen muestra el texto
   del backend, en inglés.
2. Hacer que el backend emita `REQUIRED_MISSING` con
   `path: "answers(Q-…)"` para asociarlo a su pregunta, o resolver el ID desde el
   mensaje. Actualizar `tests/test_validation.py` si cambia `path`.
3. Añadir pruebas Playwright de los tres escenarios verificados.

## Riesgos y límites

El resumen puede repetir dos mensajes si el backend emite dos `field_errors` para
el mismo campo, por ejemplo override sin comentario más `requires_comment`.
