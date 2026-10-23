# HDC-0009 — `publish-session` acepta un `generated_at` futuro

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-22 |
| Estado | `PARCHE_LISTO` (backend; mitigación en MainSpot con `artifacts/HDC-0009-publish-session-stamped.py` hasta actualizar el pin) |
| Clase | Corrección de conformidad (§5.2, §7.1, §7.2 paso 8, §10) |
| Solicitud | Corregir de raíz `FND-0001` de `SRP-0006` (`.canonflow/skill-runs/RUN-0006.skill-report.yaml`): QS-0009 declara una hora de generación posterior a su publicación |

## Problema observado

- QS-0009 declara `generated_at: 2026-10-22T04:50:00Z`
  (`.canonflow/decision-sessions/archived/QS-0009.questions.json`).
- Se publicó durante la ventana que empezó a las 04:47:35Z
  (`RUN-0006/evidence/EV-0002…txt`: `stopped_at 2026-10-22T04:47:35Z`), es
  decir, 2 min 25 s antes de la hora que declara. El agente preparó la marca de
  tiempo y no la actualizó al publicar.
- `publish-session` del pin lo aceptó sin aviso. La QS es inmutable (§5.2), así
  que el valor queda para siempre.

## Causa raíz

- `lifecycle.publish_session` (`lifecycle.py:365-390` en el pin) solo valida el
  esquema y las reglas cruzadas. `generated_at` lo declara el agente y no se
  contrasta con el reloj de publicación.
- El esquema solo exige `type: string` («Legacy precision preserved; new sessions
  use RFC 3339 UTC»), así que tampoco se comprueba el formato.
- Si falta `generated_at`, el pin rechaza la QS (`SESSION_INVALID`) en lugar de
  sellarla, lo que empuja al agente a inventar la hora.
- `latest` se elige por el mayor `generated_at` válido (§7.2 paso 8, también en
  `rebuild-index` y en el workaround de HDC-0006), y la API ordena y filtra por
  esa fecha (§10). Una hora futura puede adelantar una QS a otra publicada
  después, y desordenar listas y filtros.

## Cambio

`publish_session` (`lifecycle.py`):

- **Sella** `generated_at` con el reloj de publicación, en RFC 3339 UTC con
  segundos, si la entrada no lo trae.
- **Rechaza** con `LifecycleError` 422, antes de escribir nada:
  - `GENERATED_AT_INVALID`: el valor no es RFC 3339 UTC (`Z` o `+00:00`) o no
    es una fecha real;
  - `GENERATED_AT_FUTURE`: el valor supera el reloj de publicación en más de
    `GENERATED_AT_FUTURE_TOLERANCE_S = 120` segundos (desfase de reloj tolerado).
- Un valor pasado válido se respeta tal cual.
- La CLI no cambia: imprime `{"error": {"code", "message"}}` y sale con 1.

Pruebas nuevas en `tests/test_submission_lifecycle.py`:

- `test_publish_session_stamps_missing_generated_at`;
- `test_publish_session_accepts_past_and_skewed_generated_at[-86400|0|60]`;
- `test_publish_session_rejects_future_generated_at` (caso QS-0009, +145 s; no
  escribe nada);
- `test_publish_session_rejects_non_rfc3339_utc_generated_at[…]` (5 valores:
  sin `T`/zona, `+02:00`, fecha imposible, formato local y número).

## Contrato afectado

- §5.2: `generated_at` es campo de la QS; el esquema dice que las sesiones
  nuevas usan RFC 3339 UTC.
- §7.1: `publish-session` «publica una QS validada».
- §7.2 paso 8: «`latest` sigue siendo la QS de mayor `generated_at` válido».
- §10: filtro temporal y orden por `generated_at`.
- No cambia la definición: el código pasa a cumplirla. Las QS heredadas no se
  validan de nuevo; la regla solo se aplica al publicar.

## Archivos upstream

Resultado de la pila HDC-0003, 0004, 0005, 0007, 0008 y 0009 sobre el pin:

| Archivo | sha256 |
| --- | --- |
| `decision-console/app/canonflow_hdc/lifecycle.py` | `05f3cccaf88289f27d1678f8624602e7918796b76a0f135dffbe9fc91e972309` |
| `decision-console/app/tests/test_submission_lifecycle.py` | `275c59f7c7e2ac26d162e76534d97a38fa07c6945dcdfe4b44e752fdf9dcdde9` |
| `patches/HDC-0009-publish-session-generated-at.patch` | `889500d40224a195ca797e56c0551a8c0f05c071acbf3d3bcf15ee325b8316f8` |

HDC-0006 se apila después y vuelve a cambiar ambos archivos (sha256 finales en
su ficha). El frontend no cambia.

## Despliegue en MainSpot

- **Backend:** no se despliega hasta actualizar el pin (README, «Retirar los
  workarounds»).
- **Mitigación:** publicar las QS con
  [`artifacts/HDC-0009-publish-session-stamped.py`](artifacts/HDC-0009-publish-session-stamped.py)
  en lugar de `canonflow_hdc.cli publish-session`, con el servicio detenido como
  exige HDC-0007:

  ```sh
  PYTHONPATH=/home/administrador/codeart/canonflow-keystone/decision-console/app \
    python .canonflow-updates/artifacts/HDC-0009-publish-session-stamped.py \
    --project . --input <qs.json>
  ```

  - Mismos argumentos, salida JSON y códigos de salida que la CLI del pin.
  - Si el `generated_at` de la entrada supera ahora + 120 s, responde
    `GENERATED_AT_FUTURE` (salida 1) y no publica.
  - En otro caso sustituye `generated_at` por la hora UTC actual (con segundos)
    y llama a `canonflow_hdc.lifecycle.publish_session` del pin. Un valor
    ilegible también se sustituye. El archivo de entrada no se modifica.
- QS-0009 se queda como está: es inmutable, está archivada y su hora futura ya
  no afecta a `latest`, que depende de QS posteriores.

## Verificación ejecutada

Pruebas, en la copia `/tmp/cf-verify` (pin + pila completa, incluida HDC-0006),
con Python 3.12.3 del venv de Jev y pytest instalado aparte en `/tmp/pt-lib`:

```text
$ PYTHONPATH=$PWD:/tmp/pt-lib python -m pytest -p no:cacheprovider -o addopts="" -q
115 passed in 5.42s
```

- Pila hasta HDC-0008: 99 pasan. Con HDC-0009: 109 (99 + 10 nuevas).
- `git apply --check` de toda la pila sobre una base limpia: ver README.

Wrapper en un proyecto sintético `/tmp/synth/a`, con la librería del pin
(`git archive 5e3dc307`, `PYTHONDONTWRITEBYTECODE=1`). Reloj al preparar las
entradas: `2026-10-22T05:46:19Z`.

| Entrada `generated_at` | CLI del pin | Wrapper |
| --- | --- | --- |
| `05:48:44Z` (+145 s, el caso QS-0009) | Publica QS-0005 con `05:48:44Z` (defecto reproducido) | `{"error": {"code": "GENERATED_AT_FUTURE", …"publication clock (2026-10-22T05:46:20Z, tolerance 120s); nothing was published"}}`, salida 1, nada escrito |
| `2026-10-21T00:00:00Z` | — | Publica QS-0005 con `2026-10-22T05:46:20Z`, salida 0 |
| `05:47:19Z` (+60 s) | — | Publica QS-0006 con `2026-10-22T05:46:20Z`, salida 0 |
| ausente | `SESSION_INVALID: 'generated_at' is a required property` | Publica QS-0007 con `2026-10-22T05:46:20Z`, salida 0 |

- El sha256 de cada archivo de entrada es igual antes y después.
- `--project /tmp/synth/nope`: `error: project root does not exist`, salida 2
  (igual que la CLI).

## Ajustes al integrar en CanonFlow

- Opcional: documentar en `prompts/12-question-session-generator.md` que
  `generated_at` puede omitirse y lo sella `publish-session`.
- Regenerar wheel y manifiesto (§12).

## Riesgos y límites

- La tolerancia de 120 s es una constante. Un reloj del agente adelantado más de
  eso obliga a omitir `generated_at` o corregir el reloj.
- El wrapper siempre sustituye la hora por la de publicación, aunque la entrada
  traiga una hora pasada válida. El parche upstream sí la respeta. Para MainSpot
  la hora de publicación es la que ordena `latest`.
- No corrige QS ya publicadas: son inmutables (§5.2).
