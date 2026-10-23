# HDC-0008 — El `PENDING` declarado de una QS v2 no es un conflicto de estado

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-22 |
| Estado | `PARCHE_LISTO` (backend). No se puede desplegar en MainSpot hasta actualizar el pin |
| Clase | Corrección de conformidad (§5.2, §8) |
| Solicitud | El propietario preguntó por qué la consola muestra `PENDING` en sesiones `ARCHIVED` y si eso es un error. Lo es: esta ficha corrige la clasificación anterior de «aceptado como diseño» (`FND-0002` en RUN-0001..0003 y la ficha HDC-0006) |

## Problema observado

- **Aviso en cada sesión archivada:** en MainSpot, QS-0001..0006 muestran
  `DECLARED_STATE_CONFLICT` WARN: «QS declares PENDING; effective state is
  ARCHIVED (evidence chain prevails)».
- **Dónde se ve:**
  - insignia de anomalía en las listas;
  - contador de avisos del panel y de la barra lateral (6);
  - detalle e historial de la sesión;
  - página de diagnósticos.
- **El estado efectivo es correcto:** `ARCHIVED`, con evidencia confirmada. El
  aviso es falso.
- **No solo al archivar:** sale en cuanto la sesión pasa a `ANSWERED`, y con cada
  sesión nueva hay un aviso falso más. Los avisos reales acaban quedando ocultos
  entre ellos.

## Causa raíz

- `reconcile.py:341` compara `declared_state` (el campo `state` de la QS) con el
  estado efectivo en todos los perfiles.
- En v2 eso nunca puede coincidir:
  - el esquema de QS exige `state=PENDING`;
  - §5.2 dice que es el estado inicial, no el operacional;
  - la QS es inmutable, porque su hash liga el formulario y la respuesta.
- Así, toda sesión v2 que avanza genera el aviso.
- §8 solo prevé avisar en el caso histórico (cadena legacy con índice `INGESTED`:
  «avisar si QS o carpeta siguen pendientes»). Ahí `state` sí pretendía describir
  el estado actual.
- Es la misma confusión que el punto 1 de [HDC-0006](HDC-0006-vistas-compatibilidad-tras-ingestion.md):
  `rebuild_index` escribe en el índice el `PENDING` declarado.

## Cambio

- **`reconcile.py`:** no emitir `DECLARED_STATE_CONFLICT` cuando una QS v2
  declara `PENDING`, su estado inicial obligatorio.
  - Siguen avisando las QS legacy (§8) y una QS v2 que declare otro estado, lo
    que incumple §5.2.
  - `declared_state` se sigue proyectando y exponiendo en la API sin cambios.
- **Pruebas** en `tests/test_submission_lifecycle.py`:
  - `test_v2_initial_pending_declaration_is_not_a_state_conflict[ANSWERED|INGESTED|ARCHIVED]`
    recorre el ciclo real con `publish_ingestion` y `mark_session`;
  - `test_v2_declaring_a_non_initial_state_still_warns` fija el límite: una v2
    que declara `ARCHIVED` y está `ANSWERED` sigue avisando;
  - la prueba existente `test_qs0028_shows_ingested_with_folder_warning` sigue
    exigiendo el aviso en la cadena legacy.

## Contrato afectado

- §5.2: estado inicial de una QS v2.
- §8: tabla de reconciliación, que solo pide el aviso en el caso histórico.
- La descripción de `state` en `question-session.schema.yaml` ya dice lo mismo.
- No cambia la definición: el código pasa a cumplirla.

## Archivos upstream

Resultado de la pila HDC-0003, 0004, 0005, 0007 y 0008 sobre el pin:

| Archivo | sha256 |
| --- | --- |
| `decision-console/app/canonflow_hdc/reconcile.py` | `055657b57f1c9b97193d9d11f295b79932c686fb4c1068951a9afb81a17d18bd` |
| `decision-console/app/tests/test_submission_lifecycle.py` | `9d43f5a80e08b05f4478454646f854a316efb690f33b6685944e9f1f4ef52b96` |
| `patches/HDC-0008-v2-declared-state-not-a-conflict.patch` | `e87649908e45aa57d65367b23935819fdd201ab7bf0b99ac4c331c40f1beb9c2` |

El frontend no cambia.

## Despliegue en MainSpot

- **Backend:** no se puede desplegar. El servicio usa el checkout fijado al pin
  (igual que el `web.py` de HDC-0007). El aviso seguirá visible en MainSpot hasta
  integrar el parche en CanonFlow y actualizar el pin (README, «Retirar los
  workarounds»). Eso invalida la propuesta de activación de Jev y exige una nueva
  aprobación HDC ligada por hash.
- **Sin mitigación en la UI:**
  - ocultarlo en el frontend obligaría a recalcular en el cliente los contadores
    del panel y de la barra lateral, que calcula el backend, en seis vistas;
  - la UI y la API dejarían de coincidir.
- **Mientras tanto:** en una sesión v2, `DECLARED_STATE_CONFLICT` con
  «QS declares PENDING» es ruido conocido. El estado efectivo mostrado es el
  correcto.
- No hay nada que reaplicar en cada ingestión.

## Verificación ejecutada

- **Reproducción:** en la pila HDC-0003..0007, los tres casos de la prueba nueva
  fallan con `'DECLARED_STATE_CONFLICT' not in {'DECLARED_STATE_CONFLICT',
  'QS_FOLDER_MISMATCH'}`, y la prueba de límite pasa. Con el cambio pasan las
  cuatro.
- **Suite upstream completa:** venv temporal con `requirements-lock.txt` y pytest
  9.1.1 (Python 3.12.3), con los `schemas/` del pin. JUnit: `tests="99"
  failures="0" errors="0"`.
- **Pila:** `git apply --check` y `git apply` de HDC-0003, 0004, 0005, 0007 y
  0008 sobre el pin extraído con `git archive`. `diff -r` sale idéntico al árbol
  de desarrollo.
- **Prueba de humo sobre MainSpot real:** `reconcile()` en solo lectura sobre
  `.canonflow`. Con el pin salen 6 avisos `DECLARED_STATE_CONFLICT`; con el
  parche, ninguno, y los estados efectivos no cambian (QS-0001..0006 `ARCHIVED`,
  QS-0007 `PENDING`). Salida en
  `artifacts/HDC-0008-mainspot-reconcile-before-after.txt`.
- **Checkout de CanonFlow:** `decision-console/app/canonflow_hdc` sigue idéntico
  al pin.

## Ajustes al integrar en CanonFlow

1. Integrarlo junto al punto 1 de HDC-0006 (`rebuild_index` con el estado
   efectivo), porque tienen la misma causa.
2. Regenerar el wheel y el manifiesto (§12). `build/lib/` no se toca.
3. Valorar aplicar el mismo criterio a `QS_FOLDER_MISMATCH` en sesiones v2, que
   es el punto 6 de HDC-0006 y requiere decisión. Con el pin, una sesión v2
   `ANSWERED` en `pending/` también avisa, aunque esa es su ubicación normal
   según §5.2.

## Riesgos y límites

- Si una QS v2 declara un estado distinto de `PENDING` y no hay evidencia, el
  estado efectivo sale `INDETERMINATE` con el motivo bloqueante «session does not
  declare PENDING…». Este cambio no altera ese caso.
- Los informes `SRP-0001..0003` son inmutables y conservan `FND-0002` como
  «diseño». Esta ficha es la corrección.
