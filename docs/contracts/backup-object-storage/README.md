# Contrato de respaldos en almacenamiento de objetos (MainSpot ↔ S3)

Contrato entre el trabajo de respaldo de MainSpot (productor) y el servicio S3 de
respaldos (Garage en Hostinger KVM 4, `https://s3.mainspot.canonflow.dev`, bucket
`mainspot-backups`).

| Versión | Ruta | Estado |
|---|---|---|
| 1.0.0 | [`v1/CONTRACT.md`](v1/CONTRACT.md) | Publicado; aprobación parcial (ver §2 del contrato); transferencia remota **no activada** |

Contenido de `v1/`:

| Archivo | Para qué |
|---|---|
| `CONTRACT.md` | Contrato normativo: formatos, rutas, cifrado, identificadores, integridad, operaciones, autenticación, retención, verificación, reintentos, recuperación, errores, obligaciones y riesgos |
| `manifest.schema.json` | JSON Schema 2020-12 del manifiesto de cada respaldo |
| `examples/manifest.example.json` | Manifiesto válido generado con el vector de prueba público (§7.5) |
| `reference/manifest_tool.py` | Implementación de referencia del manifiesto, `key_id` y MAC (solo biblioteca estándar); `selftest` comprueba el vector |
| `conformance/check_s3_backup_contract.py` | Prueba de conformidad del servicio (§14), con `boto3` ≥ 1.36 |
| `VERIFICATION.md` | Lo comprobado al redactar el contrato (cifrado, vector, Garage v1.2.0 y v2.4.1 en laboratorio) |

## Cómo citarlo y recuperarlo

Se cita siempre por **commit**, no por rama. Con un commit `<SHA>`:

```sh
git clone --no-checkout https://github.com/hachxaan/mainspot-platform.git mainspot-contract
cd mainspot-contract
git fetch --depth 1 origin <SHA>
git checkout <SHA> -- docs/contracts/backup-object-storage
python3 docs/contracts/backup-object-storage/v1/reference/manifest_tool.py selftest
```

O un archivo suelto: `https://raw.githubusercontent.com/hachxaan/mainspot-platform/<SHA>/docs/contracts/backup-object-storage/v1/CONTRACT.md`.

Las versiones nuevas se publican en este directorio (`v<MAYOR>/`) con su propio
commit. Ningún archivo de aquí contiene secretos: las credenciales del servicio y la
clave de descifrado se entregan y se guardan fuera de Git.
