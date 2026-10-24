# HDC-0006 — Vistas de compatibilidad y cierre de sesiones tras la ingestión

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-21 |
| Estado | `PARCHE_LISTO` para los siete puntos (`patches/HDC-0006-compat-views-lifecycle.patch`). Puntos 2 y 6: decididos por el propietario en ANS-0012 (RUN-0010): DEC-0050 (`efectivo`, opción A) y DEC-0051 (`mover`, opción A); el parche ya implementa ambas opciones. Las condiciones añadidas en el comentario de ANS-0012 §1 (DEC-0054) quedan como requisitos pendientes de verificar en el parche antes de integrar (ver «Decisiones del propietario»). En MainSpot: `APLICADO_MAINSPOT` con el script general `artifacts/HDC-0006-regenerate-compat-views.py` |
| Clase | Corrección de conformidad (§7.1 `rebuild-index`, §7.2 paso 8, §13, esquema `decision-state`) en los puntos 1, 3, 4, 5 y 7. Semántica de `state` (punto 2) y carpeta (punto 6): decididos en DEC-0050 y DEC-0051 |
| Solicitud | Ingerir ANS-0001..0003 (sesión `01a15fb7`, `RUN-0001`). No se pidió un cambio de HDC: el agente sorteó defectos del HDC y solo los anotó como `FND-0001` en `.canonflow/skill-runs/RUN-0001.skill-report.yaml`; no los registró aquí |

## Problema observado

En MainSpot, tras ingerir y archivar QS-0001..0003 y publicar QS-0004:

- `reconcile` informó `INDEX_CORRUPT`, `DECLARED_STATE_CONFLICT` y
  `QS_FOLDER_MISMATCH` en las sesiones archivadas.
- `canonflow-hdc rebuild-index` escribió `state: PENDING` en
  `decision-state/index.json` para las tres sesiones archivadas.
- La regeneración con QS-0004 sin responder falló al validar el esquema:
  `answered_at: None is not of type 'string'`.

## Reproducción con el código del pin

Se usaron un proyecto sintético temporal, la QS de ocho tipos del fixture y la
librería del pin `5e3dc307`. El flujo usado fue: envío, `publish-ingestion`,
`mark-session ARCHIVED`, `rebuild-index` y `publish-session`.

| Caso | Resultado observado |
| --- | --- |
| A. `rebuild-index` con una sesión `PENDING` sin respuesta | `INDEX_INVALID: sessions/0/answered_at: None is not of type 'string'` |
| B. Diagnósticos después de archivar | `DECLARED_STATE_CONFLICT`, `INDEX_CORRUPT`, `QS_FOLDER_MISMATCH`; la QS sigue en `pending/` |
| B. Esquema del índice antes de reconstruir | Faltan `counters.apr`, `counters.dec` y `sessions/0.generated_at` |
| B. Después de `rebuild-index` | Estado efectivo `ARCHIVED`; `index.json` dice `PENDING`; `latest.json` sigue en `ANSWERED` |
| C. Después de `publish-session` de una QS más reciente | `latest.json` sigue apuntando a `QS-0001` |
| C. `rebuild-index` posterior | `PRESERVATION_REQUIRED` |

## Causa raíz

1. `lifecycle.rebuild_index` (`lifecycle.py:445-453`) escribe
   `state: view.declared_state or view.effective_state`.
   - Toda QS v2 declara `PENDING` (§5.2), así que cualquier sesión v2 queda como
     `PENDING` tras reconstruir.
   - Su docstring dice que solo conserva el estado declarado de los casos no
     resueltos.
2. La misma función emite `answered_at: None` y el esquema exige `string`.
   Por eso `rebuild-index` no puede ejecutarse mientras exista una sesión sin
   responder.
3. Los escritores incrementales dejan el índice fuera de esquema, con
   `INDEX_CORRUPT`:
   - `_bump_counter` (`lifecycle.py:516-532`) escribe solo los contadores
     tocados;
   - `_update_compatibility_views` (`submission.py:358-386`) crea entradas sin
     `generated_at`.
4. Solo el envío actualiza `latest.json` (`submission.py:388-412`).
   - `publish-session`, `publish-ingestion`, `mark-session` y `rebuild-index` no
     lo actualizan.
   - `rebuild-index` solo escribe la clave `latest` dentro de `index.json`.
5. `rebuild_index` exige que los bytes actuales estén preservados
   (`legacy.preservation_complete`). Las escrituras del propio HDC dejan bytes nuevos
   sin preservar, y no hay comando CLI para preservarlos. Tras `publish-session`,
   `rebuild-index` se niega.
6. `mark-session ARCHIVED` no mueve la QS. `reconcile` (`reconcile.py:346`) avisa
   `QS_FOLDER_MISMATCH`, pero ningún instrumento la mueve y el paso 6 de
   `prompts/13-answer-session-ingestion.md` no lo indica.

Tensión de contrato:

- El esquema `decision-state` define `state` como «Declared state …
  diagnosed, not silently reconciled» y prohíbe degradar a `PENDING` un estado
  histórico declarado.
- §5.2 dice que el `PENDING` de una QS v2 es inicial, no operacional.
- El envío escribe `ANSWERED`, el estado efectivo, en el índice.

## Solución temporal aplicada en MainSpot

Se aplicó en `RUN-0001`, el 2026-10-21 a las 18:54 UTC:

- QS-0001 y QS-0002 se movieron con `git mv`, y QS-0003 con `mv`, de `pending/`
  a `archived/`. Sus bytes y hashes no cambiaron.
- Un script temporal, copiado en
  [`artifacts/HDC-0006-regenerate-compat-views.py`](artifacts/HDC-0006-regenerate-compat-views.py),
  usa la librería HDC del pin:
  1. `preserve_legacy_indexes`;
  2. `reconcile`;
  3. genera `index.json` con el estado efectivo, exigiendo evidencia
     confirmada salvo en `PENDING`;
  4. omite `answered_at` cuando no existe y recalcula contadores;
  5. elige como `latest` la QS de mayor `generated_at`;
  6. escribe `latest.json` con su estado efectivo;
  7. valida el resultado contra `decision-state`.
- La copia se reconstruyó desde el transcript de la sesión `01a15fb7`, aplicando
  su heredoc y la corrección posterior; el original estaba en `/tmp/msp-ingest` y
  se borró. Se usó sin cambios de RUN-0002 a RUN-0006.
- El 2026-10-22 se convirtió en instrumento general (sección «Script de
  MainSpot»): `--run` obligatorio, sin la línea de QS-0004 y con errores
  explícitos. La derivación no cambia.

Estado vigente, actualizado el 2026-10-24 tras RUN-0015:

- **Reaplicación en `RUN-0002`** (ingestión de ANS-0004), a las 22:23Z:
  1. QS-0004 se movió con `mv` a `archived/`.
  2. Con `mainspot-hdc.service` detenido (HDC-0007), se publicaron QS-0005..0007
     con `publish-session` y se ejecutó el script versionado sin cambios.
  3. Se volvió a arrancar el servicio.
  - **Resultado:** QS-0001..0004 `ARCHIVED`, QS-0005..0007 `PENDING`,
    `latest` = QS-0007 `PENDING`, contadores `qs 7 · ans 4 · dec 19 · apr 1`.
    Tras arrancar, `writes_enabled: true`.
  - **Evidencia:**
    `.canonflow/skill-runs/RUN-0002/evidence/EV-0003..EV-0006`.
- **Reaplicación en `RUN-0003`** (ingestión de ANS-0005 y ANS-0006), entre
  23:16:55Z y 23:16:57Z, con el servicio detenido durante toda la ventana:
  1. `publish-ingestion` y `mark-session ARCHIVED` de QS-0005 y QS-0006.
  2. `mv` de ambas a `archived/` y script versionado sin cambios.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0006 `ARCHIVED`, QS-0007 `PENDING` (`latest`),
    contadores `qs 7 · ans 6 · dec 27 · apr 1`. Tras arrancar,
    `writes_enabled: true`.
  - **Evidencia:** `.canonflow/skill-runs/RUN-0003/evidence/EV-0002..EV-0005`.
- **Reaplicación en `RUN-0004`** (ingestión de ANS-0007), entre 00:51:36Z y
  00:51:38Z, con el mismo procedimiento que en RUN-0003.
  - **Resultado:** QS-0001..0007 `ARCHIVED`, `latest` = QS-0007 `ARCHIVED`,
    contadores `qs 7 · ans 7 · dec 32 · apr 2`. Tras arrancar,
    `writes_enabled: true`.
  - **Evidencia:** `.canonflow/skill-runs/RUN-0004/evidence/EV-0002..EV-0005`.
- **Reaplicación en `RUN-0005`** (publicación de QS-0008), entre 02:04:20Z y
  02:04:21Z, con el servicio detenido durante toda la ventana:
  1. `publish-session` de QS-0008.
  2. Script versionado sin cambios y `update_state.py pending … add QS-0008`.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0007 `ARCHIVED`, QS-0008 `PENDING` (`latest`),
    contadores `qs 8 · ans 7 · dec 32 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0005/evidence/EV-0004..EV-0007`.
- **Reaplicación en `RUN-0006`** (ingestión de ANS-0008 y publicación de QS-0009),
  entre 04:47:35Z y 04:47:36Z, con el servicio detenido durante toda la ventana:
  1. `publish-ingestion` y `mark-session ARCHIVED` de QS-0008; `mv` a `archived/`.
  2. `publish-session` de QS-0009.
  3. Script versionado sin cambios y `update_state.py pending` (quita QS-0008,
     añade QS-0009).
  4. Arranque del servicio.
  - **Resultado:** QS-0001..0008 `ARCHIVED`, QS-0009 `PENDING` (`latest`),
    contadores `qs 9 · ans 8 · dec 43 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0006/evidence/EV-0002..EV-0006`.
- **Reaplicación en `RUN-0007`** (ingestión de ANS-0009), entre 05:36:12Z y
  05:36:13Z, con el servicio detenido durante toda la ventana:
  1. `publish-ingestion` (DEC-0044) y `mark-session ARCHIVED` de QS-0009; `mv` a
     `archived/`.
  2. Script general con `--run RUN-0007` y `update_state.py pending … remove QS-0009`.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0009 `ARCHIVED`, `latest` = QS-0009 `ARCHIVED`,
    contadores `qs 9 · ans 9 · dec 44 · apr 2`. Tras arrancar,
    `writes_enabled: true`.
  - **Evidencia:** `.canonflow/skill-runs/RUN-0007/evidence/EV-0002..EV-0005`.
- **Reaplicación en `RUN-0008`** (publicación de QS-0010), entre 06:23:24Z y
  06:23:25Z, con el servicio detenido durante toda la ventana:
  1. `publish-session` de QS-0010 con el envoltorio de HDC-0009.
  2. Script general con `--run RUN-0008` y `update_state.py pending … add QS-0010`.
  3. Arranque del servicio. Después se corrigió la etiqueta `reconstructed.by`
     del script (ver «Script de MainSpot») y se regeneraron las vistas otra vez
     con el servicio detenido.
  - **Resultado:** QS-0001..0009 `ARCHIVED`, QS-0010 `PENDING` (`latest`),
    contadores `qs 10 · ans 9 · dec 44 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0008/evidence/EV-0002..EV-0006`.
- **Reaplicación en `RUN-0009`** (publicación de QS-0011), entre 08:29:33Z y
  08:29:35Z, con el servicio detenido durante toda la ventana:
  1. `publish-session` de QS-0011 con el envoltorio de HDC-0009.
  2. Script general con `--run RUN-0009` y `update_state.py pending … add QS-0011`.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0009 `ARCHIVED`, QS-0010 y QS-0011 `PENDING`
    (`latest` = QS-0011), contadores `qs 11 · ans 9 · dec 44 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0009/evidence/EV-0001..EV-0005`.
- **Reaplicación en `RUN-0010`** (ingestión de ANS-0011 y ANS-0012), entre
  11:40:28Z y 11:40:37Z, con el servicio detenido durante toda la ventana:
  1. `publish-ingestion` (DEC-0045..DEC-0049) y `mark-session ARCHIVED` de
     QS-0011; `mv` a `archived/`.
  2. `publish-ingestion` (DEC-0050..DEC-0054) y `mark-session ARCHIVED` de
     QS-0010; `mv` a `archived/`.
  3. Script general con `--run RUN-0010` y `update_state.py pending … remove
     QS-0011` y `… remove QS-0010`.
  4. Arranque del servicio.
  - **Resultado:** QS-0001..0011 `ARCHIVED`, `latest` = QS-0011 `ARCHIVED`,
    contadores `qs 11 · ans 12 · dec 54 · apr 2` (`ans` es el mayor ID asignado:
    la consola asignó ANS-0011 a QS-0011 y ANS-0012 a QS-0010; véase
    `FND-0002` de `RUN-0010.skill-report.yaml`). Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0010/evidence/EV-0002..EV-0007`.
- **Reaplicación en `RUN-0011`** (publicación de QS-0012), entre 17:04:02Z y
  17:04:03Z, con el servicio detenido durante toda la ventana:
  1. `publish-session` de QS-0012 con el envoltorio de HDC-0009.
  2. Script general con `--run RUN-0011` y `update_state.py pending … add QS-0012`.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0011 `ARCHIVED`, QS-0012 `PENDING` (`latest`),
    contadores `qs 12 · ans 12 · dec 54 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS, `generation` 73).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0011/evidence/EV-0001..EV-0005`.
- **Reaplicación en `RUN-0012`** (ingestión de ANS-0013), entre 09:59:51Z y
  09:59:55Z, con el servicio detenido durante toda la ventana:
  1. `publish-ingestion` (DEC-0055..DEC-0058) y `mark-session ARCHIVED` de
     QS-0012; `mv` a `archived/`.
  2. Script general con `--run RUN-0012` y `update_state.py pending … remove QS-0012`.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0012 `ARCHIVED`, `latest` = QS-0012 `ARCHIVED`,
    contadores `qs 12 · ans 13 · dec 58 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS, `generation` 78).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0012/evidence/EV-0001..EV-0006`.
- **Reaplicación en `RUN-0013`** (publicación de QS-0013), entre 07:21:05Z y
  07:21:07Z, con el servicio detenido durante toda la ventana:
  1. `publish-session` de QS-0013 con el envoltorio de HDC-0009.
  2. Script general con `--run RUN-0013` y `update_state.py pending … add QS-0013`.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0012 `ARCHIVED`, QS-0013 `PENDING` (`latest`),
    contadores `qs 13 · ans 13 · dec 58 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS, `generation` 80).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0013/evidence/EV-0001..EV-0005`.
  - El código de HDC del checkout de `canonflow-keystone` (HEAD `70ff6015`,
    divergente del pin `5e3dc307`) tiene el árbol `decision-console/app`
    idéntico al del pin (`9865e5ef`), igual que `scripts/update_state.py`.
- **Reaplicación en `RUN-0014`** (ingestión de ANS-0014), entre 07:52:43Z y
  07:52:45Z, con el servicio detenido durante toda la ventana:
  1. `publish-ingestion` (DEC-0059..DEC-0063) y `mark-session ARCHIVED` de
     QS-0013; `mv` a `archived/`.
  2. Script general con `--run RUN-0014` y `update_state.py pending … remove QS-0013`.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0013 `ARCHIVED`, `latest` = QS-0013 `ARCHIVED`,
    contadores `qs 13 · ans 14 · dec 63 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS, `generation` 84).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0014/evidence/EV-0001..EV-0005`.
- **Reaplicación en `RUN-0015`** (publicación de QS-0014), entre 20:17:11Z y
  20:17:13Z, con el servicio detenido durante toda la ventana:
  1. `publish-session` de QS-0014 con el envoltorio de HDC-0009.
  2. Script general con `--run RUN-0015` y `update_state.py pending … add QS-0014`.
  3. Arranque del servicio.
  - **Resultado:** QS-0001..0013 `ARCHIVED`, QS-0014 `PENDING` (`latest`),
    contadores `qs 14 · ans 14 · dec 63 · apr 2`. Tras arrancar,
    `writes_enabled: true` (loopback y HTTPS, `generation` 86).
  - **Evidencia:** `.canonflow/skill-runs/RUN-0015/evidence/EV-0001..EV-0005`.
- `index.json` registra en `reconstructed.by` la ejecución que lo regeneró (`--run`).
- La API HTTPS muestra los mismos estados.
- Persisten trece `DECLARED_STATE_CONFLICT` WARN (QS-0001..0013).
  `FND-0002` los dio por buenos como diseño, pero es un defecto
  de `reconcile`: está corregido en
  [HDC-0008](HDC-0008-qs-v2-pending-declarado-no-es-conflicto.md) y seguirá
  visible hasta actualizar el pin.

## Contrato afectado

- §7.1: `rebuild-index` regenera las vistas de compatibilidad.
- §13 y §4: vistas reconstruibles tras preservar; «ubicación no determina
  estado».
- §5.2: estado inicial de una QS v2.
- §8: diagnósticos de `reconcile`.
- Esquema `decision-state.schema.yaml`.
- Paso 6 de `prompts/13-answer-session-ingestion.md`: actualizar vistas tras
  archivar.

## Decisiones del propietario (puntos 2 y 6)

Decididas el 2026-10-22 en ANS-0012 (QS-0010, `Q-HDC-INDEX-STATE` y
`Q-HDC-ARCHIVE`), ingerida en `RUN-0010`:

- **Punto 2 → DEC-0050:** `efectivo` — «Estado efectivo (resultado de la
  evidencia); se corrige la descripción del esquema». Es la opción A, la que el
  parche implementa.
- **Punto 6 → DEC-0051:** `mover` — «Sí: mark-session ARCHIVED mueve el archivo a
  archived/ sin cambiar sus bytes». Es la opción A, la que el parche implementa.
- **DEC-0054** transcribe íntegro el comentario de ANS-0012. Su §1 añade
  condiciones a estas dos opciones; se copian aquí literalmente como requisitos
  que hay que verificar en el parche antes de integrarlo (el parche **no** se
  ha modificado ni revisado contra ellas en RUN-0010):
  - «El campo `state` representa el estado operativo efectivo derivado de
    evidencia verificable. El esquema deberá reflejar expresamente este
    contrato.»
  - «La reconstrucción del índice no debe degradar sesiones respondidas o
    archivadas a PENDING cuando existe evidencia suficiente de su estado
    posterior.»
  - «Ante evidencia contradictoria, ausente o corrupta, registrar un diagnóstico
    explícito; no fabricar transiciones.»
  - «`mark-session ARCHIVED` moverá automáticamente los archivos a `archived/`,
    preservando sus bytes y hashes.»
  - «El movimiento deberá ser seguro ante concurrencia, interrupciones y
    destinos existentes, con recuperación sin sobrescrituras.»
  - «Integrar HDC-0006 mediante la gobernanza de CanonFlow y retirar
    posteriormente la solución temporal de MainSpot, una vez verificada la
    corrección.»

  Pendiente de verificar en el parche, sin cambiarlo: comportamiento del
  movimiento ante concurrencia e interrupciones (hoy: enlace duro + `unlink`
  bajo el candado de gobernanza; `ARCHIVE_DESTINATION_EXISTS` 409 si el destino
  difiere) y los diagnósticos explícitos ante evidencia contradictoria, ausente
  o corrupta. La retirada de la solución temporal de MainSpot (script,
  `mv` manual) se hará al actualizar el pin (README, «Retirar los workarounds»).

Las dos alternativas, tal como se plantearon antes de la decisión:

El parche implementa la opción **recomendada** de ambas (A y A, las elegidas).

**Punto 2. ¿Qué significa `state` en `decision-state/index.json`?**

- **A (recomendada, en el parche):** el estado efectivo cuando la cadena de
  evidencia lo resuelve (`confirmed` o `derived`). En casos no resueltos se
  conserva el estado que el índice ya declaraba; nunca se degrada a `PENDING`.
  Se actualiza la descripción del esquema. Ya es lo que escribe el envío
  (`ANSWERED`) y lo que espera la UI.
- **B:** «estado declarado», como dice hoy el esquema. Entonces el envío no
  debe escribir `ANSWERED`, el índice nunca reflejaría el avance de una sesión
  v2 (todas declaran `PENDING`, §5.2) y habría que quitar ese uso de la UI y de
  los consumidores.

**Punto 6. ¿Cómo se resuelve `QS_FOLDER_MISMATCH` de una sesión archivada?**

- **A (recomendada, en el parche):** `mark-session ARCHIVED` mueve la QS de
  `pending/` a `archived/` de forma atómica (enlace duro + `unlink`, nunca
  sobrescribe) y sin cambiar sus bytes. Por tanto, los hashes de ANS y del ciclo
  de vida siguen válidos. Coincide con la tarjeta del skill HDC («move ingested
  sessions to archived/») y con lo que MainSpot hace a mano.
- **B:** no mover nada y que `reconcile` deje de avisar `QS_FOLDER_MISMATCH` en
  sesiones v2 (§4: la ubicación no determina el estado). La carpeta `archived/`
  dejaría de usarse en v2.

## Cambio (parche upstream)

[`patches/HDC-0006-compat-views-lifecycle.patch`](patches/HDC-0006-compat-views-lifecycle.patch),
apilado después de HDC-0009 (orden en el README).

1. **Punto 1.** Nuevo módulo `canonflow_hdc/compat_views.py`, que comparten
   todos los escritores. Calcula cada entrada así:
   - `state`: el estado efectivo si `evidence_status` es `confirmed` o
     `derived`; en otro caso, el que ya declaraba el índice; si no lo hay, el
     declarado por la QS;
   - `answered_at`, `session_label`, `answer_session_id` y `diagnostics` solo
     cuando existen;
   - se conservan las claves heredadas desconocidas, y `paths` se actualiza con
     las rutas reales.
2. **Punto 2 (opción A).** Se cambia la descripción de `state` en
   `schemas/decision-state.schema.yaml` y en su copia empaquetada.
3. **Punto 3.** `rebuild_index` pasa a llamar a `compat_views.regenerate`:
   - primero preserva los bytes actuales (`preserve_legacy_indexes`) en lugar de
     responder `PRESERVATION_REQUIRED`;
   - regenera `index.json` y `latest.json`;
   - `latest` es la QS de mayor `generated_at` válido, con el ID como desempate
     (antes se usaba el puntero viejo de `latest.json`);
   - los contadores nunca bajan de los que el índice ya declaraba;
   - devuelve también `latest`.
4. **Punto 4.** `compat_views.update_entry` sustituye a `_bump_counter`
   (eliminado) y al cuerpo de `submission._update_compatibility_views`:
   - escribe solo la entrada afectada (§13), con todos los campos del esquema;
   - incluye los cinco contadores.
5. **Punto 5.** `publish-session`, `import-answer`, `publish-ingestion` (bajo el
   lock de gobernanza) y `mark-session` llaman a `update_entry`, que:
   - recalcula `latest` y reescribe `latest.json` con el estado de la entrada;
   - si falla la preservación, responde `PRESERVATION_FAILED` 500 indicando
     que el artefacto canónico sí se escribió.
6. **Punto 6 (opción A).** `mark_session` con `ARCHIVED`:
   - antes de escribir el evento, comprueba si en `archived/` ya hay un archivo
     con ese nombre y bytes distintos; en ese caso responde
     `ARCHIVE_DESTINATION_EXISTS` 409 y no escribe nada;
   - después del evento, mueve la QS sin cambiar bytes;
   - devuelve `path`.

   El paso 6 de `prompts/13-answer-session-ingestion.md` lo documenta.
7. **Punto 7.** Pruebas nuevas en `tests/test_submission_lifecycle.py`:

   | Caso | Prueba |
   | --- | --- |
   | A | `test_rebuild_index_with_an_unanswered_session` |
   | B | `test_views_follow_ingestion_and_archive` |
   | C | `test_publish_session_moves_latest_and_rebuild_needs_no_manual_preservation` |
   | Contadores | `test_rebuild_index_never_lowers_preserved_counters` |
   | Carpeta | `test_mark_session_archived_moves_qs_bytes_unchanged` |
   | Carpeta | `test_mark_session_archived_refuses_a_different_archived_copy` |

   Las seis fallan con el código de la pila hasta HDC-0009 y pasan con el
   parche.

## Archivos upstream

Resultado de la pila HDC-0003, 0004, 0005, 0007, 0008, 0009 y 0006 sobre el pin:

| Archivo | sha256 |
| --- | --- |
| `decision-console/app/canonflow_hdc/compat_views.py` (nuevo) | `46e48bcc30915f6d42c4168cfe6801c98ca2843e5aaf08ffec391bcd41404c3d` |
| `decision-console/app/canonflow_hdc/lifecycle.py` | `81f6033d4732614c7dbf9e84099d63913cf769a534e18c4ec6eb29db86b0eff8` |
| `decision-console/app/canonflow_hdc/submission.py` | `aebd9dd3de20a2aed792d3115b8a1d13272d0b17add8932053c1cca537be90fd` |
| `decision-console/app/canonflow_hdc/schemas/decision-state.schema.yaml` | `f4aea3a4f286b1ce80e08816938b158f73abab1405c3308134f4d864f6eae842` |
| `schemas/decision-state.schema.yaml` | `f4aea3a4f286b1ce80e08816938b158f73abab1405c3308134f4d864f6eae842` |
| `prompts/13-answer-session-ingestion.md` | `2c9d82bc1f592c148e4975e631a99d33661225bf56ebcd0da94b9d6b968fb376` |
| `decision-console/app/tests/test_submission_lifecycle.py` | `856d6e7ed39d861555ef12d63aa3f118d69b460ffc433d37748705257549b58e` |
| `patches/HDC-0006-compat-views-lifecycle.patch` | `aa838fd856997e736694d2e86f123f7f2bc4cc84b41d02050496e96a69e22e9f` |

El frontend no cambia (`workspace.js` sigue en `43842daa…`).

## Script de MainSpot (hasta actualizar el pin)

[`artifacts/HDC-0006-regenerate-compat-views.py`](artifacts/HDC-0006-regenerate-compat-views.py)
es ya un instrumento general. Se usa con el servicio detenido (HDC-0007),
después de mover a mano a `archived/` las QS archivadas:

```sh
PYTHONPATH=/home/administrador/codeart/canonflow-keystone/decision-console/app \
  python .canonflow-updates/artifacts/HDC-0006-regenerate-compat-views.py \
  --run RUN-NNNN [--project <raíz>]   # por defecto, el directorio actual
```

- `--run` es obligatorio (formato `RUN-NNNN`) y se registra en
  `reconstructed.by` como `"RUN-NNNN (canonflow-human-decision-console)"`. Hasta
  RUN-0008 añadía siempre ` ingest`, también en ejecuciones `generate`; el modo
  real está en `.canonflow/skill-runs/index.yaml`.
- Se quitó la línea `can_answer QS-0004`. La salida es la línea JSON de
  resumen más una línea `DIAG` por diagnóstico.
- La derivación y la validación no cambian. Las aserciones pasan a ser
  errores explícitos:
  - salida 2: argumentos inválidos o raíz sin `.canonflow/`;
  - salida 1: sin sesiones, evidencia no confirmada en una sesión no `PENDING`,
    índice fuera de esquema o fallo de escritura; mensaje `error: …` en stderr;
  - la validación es previa a la escritura, así que `index.json` y
    `latest.json` no cambian si falla.

## Verificación ejecutada

- Reproducción sintética con el código del pin: tabla anterior. El checkout de
  CanonFlow sigue idéntico al pin.
- Lectura de `index.json`, `latest.json` y `GET /api/v1/sessions` de MainSpot por
  HTTPS.
- El script versionado anterior era byte a byte igual al reconstruido desde el
  transcript.

Verificación del 2026-10-22 (HDC-0009 y punto B):

- **Pila y pruebas.** Ver README: `git apply --check` de toda la pila sobre una
  base limpia y `115 passed` en `/tmp/cf-verify`. Hasta HDC-0008 pasaban 99;
  HDC-0009 añade 10 y este parche 6.
- **Regresión.** Con las pruebas nuevas sobre el código hasta HDC-0009:
  `6 failed, 32 passed`, y las 6 que fallan son las nuevas:
  - caso A y contadores: `PRESERVATION_REQUIRED`;
  - caso B: falta `latest.json`;
  - caso C: `counters: 'ans' is a required property`;
  - carpeta: la QS sigue en `pending/`, y el destino distinto no se rechaza.
- **Flujo por CLI.** Proyecto sintético `/tmp/synth`, generado por
  `build.py` con la QS de ocho tipos y los instrumentos de la librería
  probada: QS-0001 respondida, ingerida y archivada; QS-0002..0004 publicadas.

  | Paso | Pin `5e3dc307` | Pila con HDC-0006 |
  | --- | --- | --- |
  | Tras ingerir y archivar | `index.json` solo con `{"counters": {"qs": 4}}`, fuera de esquema; sin `latest.json`; `INDEX_CORRUPT` y `DECLARED_STATE_CONFLICT`; la QS en `archived/` solo por `mv` manual | `index.json` válido: QS-0001 `ARCHIVED`, QS-0002..0004 `PENDING`, contadores `qs 4 · ans 1 · dec 1`; `latest.json` = QS-0004 `PENDING`; sin diagnósticos; QS-0001 movida por `mark-session` |
  | `rebuild-index` | `PRESERVATION_REQUIRED` | `{"sessions":4,…,"latest":"QS-0004"}` |
  | `publish-session` sin `generated_at` | `SESSION_INVALID` (falta `generated_at`) | QS-0005; `index.latest` y `latest.json` = QS-0005 `PENDING`; `qs 5` |
  | `rebuild-index` | `PRESERVATION_REQUIRED` | `{"sessions":5,…,"latest":"QS-0005"}`; índice válido |

- **Script general frente al anterior.** Proyecto sintético `/tmp/synth/base`,
  con la librería del pin y QS-0001 movida a mano. El script anterior se
  ejecutó desde una copia en `/tmp/synth/old.py`, recreada del texto
  versionado; el archivo no estaba confirmado en Git.
  - Ambos escriben `QS-0001 ARCHIVED`, `QS-0002..0004 PENDING`, contadores
    `qs 4 · ans 1 · dec 1 · apr 0 · rsk 0` y `latest` = QS-0004 `PENDING`.
  - Comparando los JSON sin `reconstructed.at` ni `updated_at`, los índices y
    `latest.json` son iguales salvo `reconstructed.by`:
    `index_equal_except_by_at True latest_equal_except_updated_at True`.
  - `by`: antes `RUN-0001 (canonflow-human-decision-console ingest)`; con
    `--run RUN-0042`, `RUN-0042 (canonflow-human-decision-console ingest)` (desde
    RUN-0008, sin ` ingest`).
  - Sin `--run`: uso de argparse, salida 2. `--run run-1`: `error: --run must
    look like RUN-NNNN`, salida 2.
  - Proyecto sin sesiones: `error: compatibility views not regenerated:
    RegenerationError: no question sessions found`, salida 1.
  - QS-0002 con un evento `ARCHIVED` sin `INGESTED`: `error: … QS-0002:
    effective state INDETERMINATE has evidence_status 'ambiguous'`, salida 1;
    el sha256 de `index.json` no cambia (`b8a6a22d…`).

## Ajustes al integrar en CanonFlow

- Puntos 2 y 6 decididos (DEC-0050 y DEC-0051, opción A en ambos): no hay que
  rehacer ninguna parte. Antes de integrar, verificar el parche contra las
  condiciones de ANS-0012 §1 (DEC-0054) listadas en «Decisiones del
  propietario»: movimiento seguro ante concurrencia, interrupciones y destinos
  existentes sin sobrescrituras; diagnóstico explícito ante evidencia
  contradictoria, ausente o corrupta; nunca degradar a `PENDING` con evidencia
  suficiente.
- Después de integrar y actualizar el pin, retirar la solución temporal de
  MainSpot (script y `mv` manual), como pide ANS-0012 §1 y describe el README
  en «Retirar los workarounds de MainSpot tras integrar».
- Revisar las tarjetas de skill: ya dicen que la sesión se mueve a `archived/`.
- Regenerar wheel y manifiesto (§12).

## Riesgos y límites

- Hasta integrar la corrección, cada ingestión, archivo o publicación de QS en
  MainSpot exige el `mv` manual y el script. `rebuild-index` del pin no sirve:
  - responde `PRESERVATION_REQUIRED` tras cualquier escritura del HDC
    (reproducido);
  - con una sesión pendiente falla con `answered_at: None` (caso A);
  - sin sesiones pendientes, volvería a escribir `PENDING` en las archivadas.
- El script mantiene la derivación anterior, con sus límites:
  - toma el puntero `latest` comparando cadenas;
  - no conserva contadores mayores que los de la evidencia;
  - con dos ANS para la misma QS (`MULTIPLE_ANSWERS` BLOCK) sigue escribiendo
    `ARCHIVED` y `ans 0` (reproducido en `/tmp/synth`). Revisar los `DIAG BLOCK`
    de la salida antes de arrancar el servicio.
- Con el parche, las sesiones v2 `ANSWERED` o `INGESTED` que siguen en
  `pending/` mantienen el aviso `QS_FOLDER_MISMATCH` de `reconcile`, que no
  cambia. Solo `ARCHIVED` mueve la QS.
- `update_entry` no repara entradas ajenas inválidas heredadas (§13: solo la
  afectada). En ese caso el índice sigue con `INDEX_CORRUPT` hasta ejecutar
  `rebuild-index`.
- Ejecutar el script, `rebuild-index` o `publish-session` del pin con
  `mainspot-hdc.service` en marcha puede dejar el backend en solo lectura
  (`503 WRITES_DISABLED`) hasta reiniciarlo. Le ocurrió a QS-0004 el 2026-10-21
  (ver [HDC-0007](HDC-0007-escritura-recuperable-solo-lectura.md)). Después de
  usarlo, comprobar `GET /api/v1/ready`; si `writes_enabled` es `false`,
  ejecutar `systemctl --user restart mainspot-hdc.service`.
  - `[INFERENCIA]` Con el parche, los instrumentos preservan los bytes antes de
    escribir, así que este bloqueo no debería repetirse. No se probó con el
    servicio.
