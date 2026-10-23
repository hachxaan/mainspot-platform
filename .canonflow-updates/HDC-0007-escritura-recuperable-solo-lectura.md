# HDC-0007 — Escritura recuperable y modo de solo lectura explícito

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-21 |
| Estado | `PARCHE_LISTO` (UI desplegada en MainSpot; corrección del backend pendiente de integrar upstream) |
| Clase | Corrección de conformidad (§11 estados explícitos, §13 preservación, §14 token anti-CSRF) |
| Solicitud | El propietario reportó el envío de QS-0004 rechazado: `POST /api/v1/sessions/QS-0004/answers` → `503 WRITES_DISABLED` «the console is in read-only mode» |

## Problema observado

Al enviar QS-0004 por `https://mainspot.hdc.com`, el backend respondió `503
WRITES_DISABLED`. No se guardó ningún ANS ni borrador: `GET …/QS-0004/draft`
devolvía `404`. La UI no avisaba del modo de solo lectura antes del envío; el
humano redactó y envió respuestas largas sin saber que no podían guardarse.

`/api/v1/ready` ya devolvía `writes_enabled: false` a las 19:26Z. En ese momento
`index.json` y `latest.json` sí estaban preservados en `decision-state/legacy/`,
es decir, `preservation_complete()` era verdadero.

## Causa raíz

1. **Backend:** el estado de escritura nunca se recupera.
   `ProjectionManager.refresh()` (`web.py`) preserva los índices y, después de
   reconciliar y reconstruir, comprueba `preservation_complete()`. Si otro
   escritor reescribe `index.json` o `latest.json` en ese intervalo, la
   comprobación falla y `writes_enabled` pasa a `False`. Ningún camino lo vuelve
   a `True`: el siguiente sondeo preserva los bytes nuevos, pero la consola queda
   en solo lectura hasta reiniciar el proceso.
2. **Disparador en MainSpot:** la ingestión RUN-0001 (18:41Z–18:57Z) ejecutó
   `canonflow-hdc rebuild-index` y `publish-session`, y regeneró `index.json` y
   `latest.json` con `mainspot-hdc.service` en marcha. Esa regeneración es la
   solución temporal de HDC-0006 (`artifacts/HDC-0006-regenerate-compat-views.py`).
   Cada escritor preserva los bytes previos, no los nuevos, así que coincidió con
   la ventana del sondeo.
3. **UI:** el estado `writes_enabled` se mostraba solo en Diagnósticos y en
   Resumen. El workspace permitía redactar y enviar, y el error se veía únicamente
   después del envío.
4. **UI, al reiniciar:** el token anti-CSRF cambia en cada proceso. Una pestaña
   abierta conserva el token anterior y sus `PUT` o `POST` reciben `403
   CSRF_TOKEN_INVALID` sin reintento.

## Cambio

Aplica sobre HDC-0003 + HDC-0004 + HDC-0005; HDC-0006 no tiene parche. Parche:
[`patches/HDC-0007-writes-recovery-readonly-ux.patch`](patches/HDC-0007-writes-recovery-readonly-ux.patch).

**Backend (`web.py`):** `refresh()` recalcula `writes_enabled` en cada sondeo:

```python
self.writes_enabled = preserved and preservation_complete(self.project_root)
```

Una captura fallida o unos bytes sin preservar siguen bloqueando la escritura
(§13). Los bloqueos transitorios se levantan en el siguiente sondeo, a unos 2 s.

**Prueba de regresión:**
`tests/test_reconciliation_projection.py::test_writes_reenabled_once_external_index_write_is_preserved`.
Simula una reescritura de `index.json` posterior a la captura, exige
`writes_enabled is False` en ese sondeo y `True` en el siguiente.

**UI:**

- `main.js` publica `writes_enabled` de `/api/v1/ready` en `html[data-writes]` y
  en el evento `hdc:writes`. Muestra un banner persistente: «La consola está en
  modo de solo lectura: … Lo que escribas se conserva en esta pestaña; envía
  cuando desaparezca este aviso.»
- `workspace.js`:
  - pausa el botón de envío mientras no haya escritura, con el motivo visible;
  - el indicador de guardado dice «Borrador solo en esta pestaña (consola en solo
    lectura)»;
  - al volver la escritura, el reintento de HDC-0005 guarda el borrador y el
    envío se reactiva solo.
- `api.js`: ante `403 CSRF_TOKEN_INVALID` en una mutación, pide el token actual y
  reintenta una vez. El rechazo por token ocurre antes de escribir nada y
  `request_id` mantiene la idempotencia del envío.
- `ui.js`: `errorMessage()` usa primero el mensaje específico del código
  (`err_WRITES_DISABLED`).
- `i18n.js`: añade `banner_readonly`, `err_WRITES_DISABLED`, `ws_writes_disabled`
  y `ws_draft_local_only` (en y es).
- `app.css`: los banners se apilan.

## Contrato afectado

- §11: «desconexión y error son estados explícitos». El solo lectura pasa a ser
  un estado visible antes de responder.
- §13: la escritura se bloquea mientras haya bytes de índice sin preservar, sin
  volverse permanente.
- §14: el token anti-CSRF es efímero por proceso. El cliente lo renueva y no
  relaja ninguna comprobación (`Origin`, `Content-Type` y token siguen
  obligatorios).

## Archivos upstream

Resultado de la pila de parches HDC-0003, 0004, 0005 y 0007 sobre el pin:

| Archivo | sha256 |
| --- | --- |
| `decision-console/app/canonflow_hdc/web.py` | `fce49d4f9342be6c4841bd13f3355df93ec6dea605130728a16fb0efbf0048bd` |
| `frontend/js/api.js` | `2262f9ef4c114e26c94f56ca88db93821e0822ac67001bae6b0de82f9ad14781` |
| `frontend/js/main.js` | `4d8e1b6e9f41e2f48384d708f11d11eb95d36c15f5a6c0874ea8d88e8814d090` |
| `frontend/js/ui.js` | `8d20c04eee353051152f72b2c59b5fbc2411344b00e09458aa453f0bb6728b43` |
| `frontend/js/i18n.js` | `5ab5ee6b72053777accace3589e8f82989c75894ffbf15ed4694929438923d63` |
| `frontend/js/views/workspace.js` | `43842daa58136f30e0eefbacf26de3e56dd1ac3c5b7e2bbc90415d8f8a33cbb1` |
| `frontend/css/app.css` | `ac5710759473091bef363788f2ce35d62d0d7a43950d9fda9487964a26026a8f` |
| `decision-console/app/tests/test_reconciliation_projection.py` | prueba nueva (ver arriba) |

`index.html`, `js/views/overview.js` y `js/views/history.js` no cambian respecto
de HDC-0005.

## Despliegue en MainSpot

- **UI:** `scripts/deploy/hdc-ui/` se actualizó al resultado de la pila
  HDC-0003/0004/0005/0007, byte a byte, y se instaló en
  `/var/www/mainspot-hdc-ui/`. Hay respaldo previo en
  `/root/mainspot-hdc-ui.pre-HDC-0007.20261021T204733Z` en el
  LXC.
- **Backend:** no se puede desplegar en MainSpot. El servicio usa el checkout
  fijado al pin, y `scripts/canonflow-jev.py` exige que coincida.
- **Mitigación operativa hasta integrarlo upstream:**
  - si `GET /api/v1/ready` muestra `writes_enabled: false` con los índices ya
    preservados, ejecutar `systemctl --user restart mainspot-hdc.service`;
  - los agentes deben comprobar `/ready` después de cualquier escritura de
    `decision-state/` por CLI (`publish-session`, `rebuild-index`) con el servicio
    en marcha.
- **Aplicado el 2026-10-21:** reinicio a las 20:41:55Z. `/ready` (loopback y
  HTTPS) volvió a `writes_enabled: true`. QS-0004 siguió `PENDING`, sin ANS y sin
  borrador de servidor.
- **Mitigación preventiva en `RUN-0002`** (2026-10-21, 22:23Z):
  - servicio detenido mientras `publish-session` y la regeneración de HDC-0006
    escribían `index.json`/`latest.json`, y arrancado después;
  - `/ready` devolvió `writes_enabled: true` al arrancar y 4 s después;
  - evidencia: `.canonflow/skill-runs/RUN-0002/evidence/EV-0005` y `EV-0006`.

## Verificación ejecutada

- **Reproducción del defecto:** la prueba nueva falló sobre la pila
  HDC-0003..0005 (`assert False is True`: la consola quedaba en solo lectura)
  y pasa con el cambio.
- **Suite upstream completa:** `pytest tests/` en un venv temporal con
  `requirements-lock.txt` y los `schemas/` del pin: **95 passed**.
- **Solo lectura en la UI** (Chromium real, servidor de desarrollo con proyecto
  sintético, `/ready` y `PUT /draft` simulados con `writes_enabled:false` y
  `503 WRITES_DISABLED`):
  - se mostró el banner;
  - envío deshabilitado con «Envío en pausa: la consola está en modo de solo
    lectura.»;
  - indicador «Borrador solo en esta pestaña…»;
  - copia en `sessionStorage` presente.
  - Al retirar la simulación, el banner desapareció, el envío se reactivó y el
    reintento guardó el borrador («Borrador guardado»).
- **Token renovado:** se reinició el servidor de desarrollo con el workspace
  abierto, se respondió una pregunta y el `PUT` del borrador con el token
  anterior terminó en «Borrador guardado». El envío posterior publicó `ANS-0004`
  en el proyecto sintético.
- **Pila y despliegue:**
  - `git apply` de HDC-0003, 0004, 0005 y 0007 sobre el pin extraído con `git archive`:
    correcto, y `diff -r` idéntico al árbol de desarrollo (paquete y pruebas);
  - HTTPS sirve los 9 archivos del frontend con sha256 igual a
    `scripts/deploy/hdc-ui/`.

No se enviaron ni reescribieron respuestas reales; QS-0004 sigue `PENDING`.

## Ajustes al integrar en CanonFlow

1. Integrar el cambio de `web.py` y la prueba. Regenerar el wheel y el manifiesto
   (§12).
2. Valorar que `canonflow-hdc publish-session` y `rebuild-index` preserven
   también los bytes que escriben, para cerrar la ventana en origen.
3. Añadir una prueba Playwright del banner de solo lectura y de la renovación del
   token.

## Riesgos y límites

- **Sin el cambio de backend:** MainSpot depende del reinicio manual si vuelve a
  producirse la carrera. La UI ahora lo hace visible antes de responder.
- **Ventana breve:** con el cambio, un bloqueo transitorio dura hasta el
  siguiente sondeo (2 s). Un envío en ese instante recibe `503` con el mensaje
  específico y puede repetirse.
- **Lo escrito durante el bloqueo** vive solo en `sessionStorage` de esa pestaña,
  hasta que la escritura vuelve. Cerrar la pestaña antes lo pierde.
