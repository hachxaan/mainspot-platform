# Contrato de respaldos en almacenamiento de objetos (MainSpot ↔ S3)

Contrato entre el trabajo de respaldo de MainSpot (productor) y el servicio S3 de
respaldos (Garage en Hostinger KVM 4, `https://s3.mainspot.canonflow.dev`, bucket
`mainspot-backups`).

| Versión | Ruta | Commit | Estado |
|---|---|---|---|
| 1.1.0 | [`v1/CONTRACT.md`](v1/CONTRACT.md) | `0cbdfcf008ed84f9cddea399c5d49915ca24e828` (rama `contract/backup-object-storage-v1`) | Publicado; aprobado con condiciones por el propietario (DEC-0045…DEC-0054; §2 del contrato); copia protegida exigida antes de activar; transferencia remota **no activada** (puerta de activación en §2.3) |
| 1.0.0 | [`v1/CONTRACT.md`](v1/CONTRACT.md) en ese commit | `21537dee08bd439df823f350c87d17d754da17a6` (rama `contract/backup-object-storage-v1`) | Publicado; aprobación parcial; sustituido por 1.1.0 |

Cambios entre versiones: [`v1/CHANGELOG.md`](v1/CHANGELOG.md). El manifiesto no ha
cambiado entre 1.0.0 y 1.1.0.

Contenido de `v1/`:

| Archivo | Para qué |
|---|---|
| `CONTRACT.md` | Contrato normativo: formatos, rutas, cifrado, identificadores, integridad, operaciones, autenticación, retención y copia protegida, verificación, reintentos, recuperación, errores, obligaciones y riesgos |
| `CHANGELOG.md` | Cambios por sección entre versiones |
| `manifest.schema.json` | JSON Schema 2020-12 del manifiesto de cada respaldo |
| `examples/manifest.example.json` | Manifiesto válido generado con el vector de prueba público (§7.5) |
| `reference/manifest_tool.py` | Implementación de referencia del manifiesto, `key_id` y MAC (solo biblioteca estándar); `selftest` comprueba el vector |
| `conformance/check_s3_backup_contract.py` | Prueba de conformidad del servicio (§14, C-01…C-22), con `boto3` ≥ 1.36 |
| `VERIFICATION.md` | Lo comprobado al redactar el contrato (cifrado, vector, Garage v1.2.0 y v2.4.1 en laboratorio; v1.1: C-21/C-22 y prueba sintética de la copia protegida) |
| `infra-reconciliation-ab046d24.md` | Informe (no normativo) de reconciliación con la infraestructura del servicio @ `ab046d24`, en versión publicable (sin detalles internos de la infraestructura) |

## Cómo citarlo y recuperarlo

Se cita siempre por **commit**, no por rama (DEC-0049 §6). El commit de cada versión
está en la tabla de arriba; el de `1.1.0` se rellena en el mismo commit que la publica
o en el siguiente. Con un commit `<SHA>`:

```sh
git clone --no-checkout https://github.com/hachxaan/mainspot-platform.git mainspot-contract
cd mainspot-contract
git fetch --depth 1 origin <SHA>
git checkout <SHA> -- docs/contracts/backup-object-storage
python3 docs/contracts/backup-object-storage/v1/reference/manifest_tool.py selftest
grep -m1 '^| Versión' docs/contracts/backup-object-storage/v1/CONTRACT.md   # confirma la versión recuperada
```

O un archivo suelto: `https://raw.githubusercontent.com/hachxaan/mainspot-platform/<SHA>/docs/contracts/backup-object-storage/v1/CONTRACT.md`.

El informe de conformidad del servicio (§14) y su evidencia citan el `<SHA>` del
contrato usado (`contract_version` en el informe) y el commit del repositorio del
servicio contra el que se ejecutaron.

Las versiones nuevas se publican en este directorio (`v<MAYOR>/`) con su propio
commit. Ningún archivo de aquí contiene secretos ni detalles internos de la
infraestructura del servicio (direcciones privadas, contenedores, rutas de sistema,
usuarios): las credenciales del servicio y la clave de descifrado se entregan y se
guardan fuera de Git, y la versión íntegra del informe de reconciliación queda fuera
del repositorio público.
