# Informe de conformidad externa — Garage S3 v1.1.0 — 2026-10-24

## Dictamen

**`"conformant": true`** según el runner contractual: **20 PASS, 0 FAIL, 0 SKIP y 2 MANUAL (C-21, C-22)**,
ejecutado desde fuera del KVM 4 contra el endpoint real. C-21/C-22 siguen en **MANUAL**. Con la
opción B no hay bucket guard en S3 (`HeadBucket` 404); se acreditan con la evidencia del
operador de §9.2.5 (más abajo), no con este runner. Esto no autoriza activar el productor.

Informe íntegro del runner: `external-conformance-20261024T062159Z.json`
(sha256 `80fa627ec15399c82232d552f7fd2bb9b3da287f7f62c1db3e6bde6af62c7709`), sin secretos
(0 coincidencias de `GK[0-9a-f]{24}`, de hex de 64 caracteres y de cadenas tipo secreto de 40
caracteres; el único hash del informe es el ETag MD5 de un objeto sintético).

## Identidad de la ejecución

| Elemento | Valor |
|---|---|
| Contrato | `mainspot-backup-object-storage` 1.1.0, `hachxaan/mainspot-platform@0cbdfcf008ed84f9cddea399c5d49915ca24e828` |
| Checkout del servicio usado | `hachxaan/mainspot-s3-backups@2d5c807e4da82aa00610ec61dc519ff68930183f` (respecto a `03e71236` solo añade `scripts/host/handoff-drop.sh`; runner y wrapper idénticos) |
| Código del servicio desplegado y probado | `824a45294c769a7a2bcb88ebbb172634ec85ee81` (binding `evidence/32-review-fix-binding.json`); `garage-alert` `487428df` |
| Runner | `contract/v1/check_s3_backup_contract.py` sha256 `ae28a41a6faa188a51f508b027ebe1a72077f16e2ee526af7e01f5655553fc85` (= pin del wrapper = `0cbdfcf`) |
| Entorno | Python 3.12.3, boto3/botocore 1.43.117 (venv aislado) |
| Run | `20261024T062159Z-1750b25a`, 2026-10-24T06:21:59Z → 06:22:46Z UTC |
| Endpoint / bucket | `https://s3.mainspot.canonflow.dev`, región `garage`, `mainspot-backups` |
| Ejecutor | SOL MAIN (OMP, Claude Opus 5.5) en el equipo físico local del propietario, autorizado explícitamente por el propietario el 2026-10-24 |
| Ubicación | Portátil físico (`systemd-detect-virt` = `none`); salida por túnel VPN, /24 de salida `3.93.114.0/24`, distinta de la IP del endpoint (C-20 lo confirma: puertos 3900–3903 inalcanzables) |

## Resultados

| Id | Estado | Resumen |
|---|---|---|
| C-01 | PASS | TLS 1.3, certificado de confianza pública, 88 días de vigencia |
| C-02 | PASS | Desfase de reloj de 1 s |
| C-03 / C-04 | PASS | `HeadBucket` con writer y restore (SigV4, path-style) |
| C-05 / C-06 | PASS | Content-MD5 correcto aceptado; incorrecto rechazado (400 InvalidDigest), nada almacenado |
| C-07 / C-08 | PASS | `HeadObject` conserva tamaño y `x-amz-meta-sha256`; bytes idénticos |
| C-09 | PASS | `ListObjectsV2` con prefijo, `MaxKeys` y paginación |
| C-10 / C-11 | PASS | Multiparte completo idéntico; `AbortMultipartUpload` elimina el pendiente |
| C-12 / C-13 / C-14 | PASS | Restore: `PutObject`, `DeleteObject` y `PutBucketLifecycleConfiguration` denegados (403) |
| C-15 | PASS | Ciclo de vida exacto de §9.1 (`v1/` 14 d, `_conformance/` 1 d, multiparte incompleto 1 d) |
| C-16 | PASS | Limpieza: 6 objetos de conformidad borrados, 0 restantes bajo `_conformance/20261024T062159Z-1750b25a/` |
| C-17 | PASS | GET anónimo denegado (403) |
| C-18 | PASS | HTTP → 301 a HTTPS sin servir S3 |
| C-19 | PASS | `x-amz-checksum-sha256` verificado al subir y devuelto |
| C-20 | PASS | Puertos 3900–3903 no accesibles desde fuera |
| C-21 | **MANUAL** | Sin bucket guard en S3 (404), opción B |
| C-22 | **MANUAL** | Ídem; la correspondencia se acredita con la evidencia del servicio |

## Evidencia de C-21/C-22 (opción B, aportada por el operador del KVM 4)

`hachxaan/mainspot-s3-backups@2d5c807e` (idéntica a la de `03e71236`):
`evidence/29-guard-drill-review-fixes.txt` (sha256 `4332ac3493005534163ce47d5e6f86b2faa796c0fe44bf37c662f9a802485af2`,
31 PASS / 0 FAIL: G07a–d sin ruta de writer a la copia; G02, `sha256sum -c`, G06b y G08 para la
correspondencia y la restauración con los originales ausentes) y `evidence/32-review-fix-binding.json`
(sha256 `1ab028fe530fe013725a011e4a00f83a0685d44763296bfdeaebd91ba2938ba0`). Desde fuera solo se
observa de forma independiente el 404 del bucket guard; el resto depende del simulacro del
operador del 2026-10-22.

## Handoff y limpieza

- Clave GPG efímera ed25519/cv25519 (huella `2711 0560 F08B 5903 87C5  BFA0 0D27 EAF5 2803 76AF`),
  confirmada por el propietario. Paquete recibido por SFTP restringido con la clave de host
  verificada; sha256 `a17440881c4eab8e7dbb961f13a292efb4af46333f62f772e18689805dc9c4d1` coincidente;
  destinatario único: keyid `979ECB7FDA372B30`.
- Descifrado solo en tmpfs (`$XDG_RUNTIME_DIR`, 0700), archivos 0600, dentro de un scope systemd
  con `MemorySwapMax=0`.
- Al terminar, el `trap` hizo `shred -u` de las dos `.env`, del paquete y del keyring efímero,
  detuvo gpg-agent y borró el directorio de sesión. Verificado: 0 directorios de sesión, 0
  procesos gpg-agent de la sesión, 0 archivos `*.tar.gpg` o `mainspot-backup-*.env` en `$HOME`,
  `/tmp` y tmpfs. También se destruyeron la clave SSH dedicada (`shred -u`) y la clave pública
  local.
- Limitaciones del borrado físico: en tmpfs, `shred` no garantiza borrar las páginas de RAM ya
  liberadas (se pierden al reiniciar). No se escribió nada en disco persistente y el scope
  impidió el swap a `/swap.img`, que no está cifrado. Las credenciales estuvieron en memoria del
  proceso Python unos 47 s.

## Pendiente para la condición 2 de §2.3

- S-15: declaración del operador del KVM 4 sobre S-04, S-06, S-11, S-13 y S-16 (lo que la
  conformidad no puede medir). No se encontró publicada en `2d5c807e`.
- Teardown del buzón `mainspot-drop` en el KVM 4 y su cierre según `docs/14` §5 (revisión de uso de
  las claves en la ventana; no se requiere rotación si no hubo desviación).
