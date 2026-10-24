# Plan de conformidad externa C-01…C-22 y prueba del productor — checkpoint 2026-10-23

No normativo. **Preparado, no ejecutado.** No se transfirió ninguna credencial ni se hizo
ninguna operación S3 autenticada. Productor y temporizadores remotos siguen desactivados.
Requisito para ejecutar: autorización explícita del propietario que nombre a este host como
ejecutor externo (precondición 1 de `docs/14-handoff-conformidad.md` del servicio).

## 1. Servicio y runner

| Elemento | Valor verificado |
|---|---|
| Último commit del servicio | `hachxaan/mainspot-s3-backups@03e71236c1ce1b357053239ff7f97c1f03be59a9` (checkpoint 38: S-08 cerrado, handoff preparado; código del servicio `824a4529`, `garage-alert` `487428df`) |
| Runner | `contract/v1/check_s3_backup_contract.py`, sha256 `ae28a41a6faa188a51f508b027ebe1a72077f16e2ee526af7e01f5655553fc85`: igual al pin de `scripts/host/run-external-conformance.sh` y al runner del contrato en `0cbdfcf` (`v1/conformance/`) |
| Procedimiento del servicio | `docs/14-handoff-conformidad.md` (sha256 `19c28977…a063`) |

## 2. Ubicación del ejecutor

Portátil físico (`systemd-detect-virt` = `none`, Ubuntu 24.04.4), no es el KVM 4 ni un
contenedor suyo. La ruta al endpoint sale por un túnel VPN (`tun0`) cuya IP pública de salida es
distinta de la del endpoint. El helper vuelve a comprobarlo en cada ejecución y aborta si
coinciden. El informe registrará solo el /24 de salida.

## 3. Entorno

- Python 3.12.3, GnuPG 2.4.4, git 2.43.0, `shred`.
- venv aislado `~/.cache/mainspot-conformance-v1.1.0`: `boto3==1.43.117`, `botocore==1.43.117`
  (más `s3transfer 0.19.3`, `urllib3 2.8.0`, `jmespath 1.1.0`, `python-dateutil 2.9.0.post0`,
  `six 1.17.0`), la ruta y versiones que exige el wrapper del servicio.
- Checkout del servicio fuera de Git de MainSpot: `~/.local/share/mainspot-conformance/mainspot-s3-backups`.
- Helper local (no versionado) `~/.local/share/mainspot-conformance/bin/conformance-session.sh`
  (sha256 `43d29b08336dde9626dd2a795f1a8e2e41c7ae21cd7d432b25135eea01a6d73a`):
  `preflight`, `keygen`, `run`, `cleanup`. `preflight --sha 03e71236…` ejecutado: ubicación,
  checkout limpio, sha256 del runner y versiones correctos.

## 4. Credenciales temporales

- Directorio `$XDG_RUNTIME_DIR/mainspot-conformance/` (tmpfs, 0700, se borra al cerrar sesión
  o reiniciar), creado solo durante `run`; `writer.env`/`restore.env` en `creds/` con 0600. Nunca
  en Git, en `~/.config/mainspot/` ni en argv.
- Recepción según docs/14 del servicio: clave GnuPG efímera de 2 días generada aquí (`keygen`),
  huella confirmada por un segundo canal, paquete `.tar.gpg` por canal privado directo.
- El descifrado y la ejecución corren en un scope de systemd con `MemorySwapMax=0` (el swap del
  host es un archivo sin cifrar; así las páginas tmpfs de las credenciales no van a swap).

## 5. Limpieza

`run` instala `trap cleanup EXIT INT TERM`. `cleanup` (idempotente, también manual):
`shred -u` de `creds/*.env` y del paquete `.gpg`, `gpgconf --kill gpg-agent`, `shred -u` del
keyring efímero y `rm -rf` del directorio de sesión. La credencial **restore** no se conserva
en este host tras la ejecución; la prueba del productor (§7) exige un handoff nuevo. Comprobado
con un archivo ficticio: no queda nada. Cualquier desviación obliga a rotar según
`07-credenciales.md` del servicio.

## 6. Alcance de las operaciones del runner (revisado en el código)

| Operación | Alcance |
|---|---|
| `PutObject`, multiparte, `AbortMultipartUpload` (writer) | Solo claves bajo `_conformance/<run>/` (`run` = fecha UTC + 8 hex aleatorios) |
| Limpieza C-16 | Lista y borra solo `_conformance/<run>/`; falla si queda algo. Si se interrumpe antes, la regla `_conformance/` de 1 día los expira |
| C-12/C-13/C-14 (restore) | Intentos que deben ser denegados; C-14 envía exactamente el ciclo de vida de §9.1, así que aunque se aceptara no cambiaría la configuración contractual |
| C-15, C-22 | Solo lectura (`GetBucketLifecycleConfiguration`, `ListObjectsV2`, `HeadObject`, `GetObject` sobre `v1/`) |
| C-21 | Con opción B, `HeadBucket` sobre `mainspot-backups-guard` da 404 y la comprobación termina en MANUAL sin más sondas |

No toca objetos `v1/` ni el ciclo de vida del bucket (salvo el envío idéntico de C-14). La
ejecución no genera respaldos reales.

## 7. Comandos preparados

Tras la autorización:

```bash
H=~/.local/share/mainspot-conformance/bin/conformance-session.sh
$H preflight --sha 03e71236c1ce1b357053239ff7f97c1f03be59a9   # o el SHA vigente, actualizando el checkout
$H keygen                       # enviar handoff-pub.asc; dictar la huella por otro canal
$H run --sha 03e71236c1ce1b357053239ff7f97c1f03be59a9 \
       --authorized-ref '<registro de autorización>' --bundle <ruta>/conformance-creds.tar.gpg
```

Informe en `~/.local/share/mainspot-conformance/reports/` (fuera de Git); se publica sin
secretos con el commit, la fecha, el /24 de salida, las versiones y una declaración de destrucción.

Prueba posterior del productor contra el servicio real (condiciones 5 y 6a), con un handoff aparte:

1. Configuración en tmpfs con `MAINSPOT_REMOTE_CONFIG=<tmpfs>/remote.env` (nunca la ruta por
   defecto), `MAINSPOT_REMOTE_BACKUP_ENABLED=1` solo en ese archivo,
   `DEPLOYMENT_ID=synthetic-drill`, credencial writer, `MAINSPOT_BACKUP_DIR` temporal con un
   volcado de una base sintética y `MAINSPOT_BACKUP_KEY` = la clave sintética de §7.5.
2. `db-backup-remote.py --dry-run`, luego la ejecución real una vez y `--check-only`. Se espera
   el aviso de frescura/cantidad de la comprobación diaria con un solo respaldo sintético.
3. Restaurar con **restore**: descargar el par, `manifest_tool.py verify` → `"valid": true`,
   descifrar en streaming y `pg_restore` en una base desechable; comparar el resumen de filas.
4. Limpieza: se avisa antes al operador del KVM 4, porque el borrado de originales lo audita el
   vigilante/guard. Luego se borran con writer solo las claves exactas subidas (o se dejan
   expirar por la regla de 14 días si el operador lo prefiere). `cleanup` del tmpfs.
   **Nunca** se instala ni activa `mainspot-db-backup-remote.timer`.

## 8. C-21/C-22: evidencia MANUAL del servicio (no se convierte en PASS)

En el informe externo quedarán en **MANUAL** (opción B: sin bucket guard en S3). Se adjunta como
acreditación, citada por hash en `03e71236`:

| Comprobación | Evidencia del operador | Lo que acredita |
|---|---|---|
| C-21 (writer sin ruta a la copia) | `evidence/29-guard-drill-review-fixes.txt` (sha256 `4332ac34…5af2`): G07a sin bucket guard (404), G07b sin montaje de la copia en Garage, G07c estado de solo lectura, G07d sin ruta de red desde Garage ni desde el servidor web, G01d clave guard de solo lectura (403) | Ausencia de ruta S3/FS/red de writer a la copia |
| C-22 (correspondencia copia↔original) | El mismo archivo: G02 dos pares verificados, `sha256sum -c` OK de objetos y manifiestos, G06b hashes sin cambios con los originales borrados, `manifest_tool verify` `"valid": true`, G08 restauración PostgreSQL | Correspondencia por SHA-256 y restauración desde la copia |
| Binding | `evidence/32-review-fix-binding.json` (sha256 `1ab028fe…ba0`) → código `824a4529` | El código probado es el instalado |
| Host-only previo | `evidence/23-conformance-host-only-v1.1.0.json` (sha256 `6bc80b90…8317`): 20 PASS, C-21/C-22 MANUAL | Referencia; no cuenta como externa |

Límite: desde fuera solo se puede observar el 404 del bucket guard. La ausencia de rutas por el
sistema de archivos y la red, y la correspondencia en el volumen, dependen de la evidencia del
operador (simulacro del 2026-10-22). Ese simulacro se repite si cambia el copiador.

## 9. Estado de la puerta de activación tras este checkpoint

- P-3/S-08: **cumplido** en el servicio (`03e71236`, evidence/37: el propietario confirmó la
  recepción del mensaje de prueba).
- 1, 2: listos para ejecutarse; bloqueados solo por la autorización del ejecutor y el handoff.
- 5, 6a: preparados (§7); requieren handoff y autorización.
- 7: sin cambios; ningún paso de este plan activa nada.

## 10. Checkpoint fase 1 — recepción GPG preparada (2026-10-24)

- Autorización: el propietario autorizó (2026-10-24, en la sesión de OMP) a SOL MAIN, en su
  equipo físico local, a ejecutar C-01…C-22 con writer/restore temporales cifradas con GPG; solo
  pruebas sintéticas contractuales.
- Preflight **PASS** con el checkout `03e71236`, que sigue siendo `origin/main`; `preflight`
  del helper sin cambios.
- Clave efímera: ed25519 [SC] + cv25519 [E], creada el 2026-10-24T03:35Z; caducan **ambas** el
  2026-10-26T03:35Z. Huella primaria **`2711 0560 F08B 5903 87C5  BFA0 0D27 EAF5 2803 76AF`**,
  subclave de cifrado `EE18 3A98 A313 E176 FBAA  1FC9 979E CB7F DA37 2B30`. La clave privada
  está solo en el tmpfs del equipo local (0700); un reinicio la destruye y obliga a regenerarla.
  Defecto corregido: con GnuPG 2.4.4, `--quick-gen-key … default default 2d` deja la subclave
  de cifrado sin caducidad; el helper ahora aplica `--quick-set-expire <fpr> 2d '*'`
  (sha256 `d02f7d3c531ecb5ac21a95228792d2c04c940f4539745b885233cf0a389f2c60`).
- Público exportado: `handoff-pub.asc` (sha256 `6eeb80c5…9c9dbd`), sin material secreto.
- Transferencia: solo saliente desde el equipo local por SSH/SFTP hacia el KVM 4. No se abren
  puertos ni servicios en el equipo local. Clave SSH dedicada `mainspot-conformance-handoff-20261024`
  (ed25519, `SHA256:Fxc84HVA7mmGIFtRXQkwUYeih3xr2tHZQAV60ivHaM8`); la clave de host del KVM 4 ya
  está fijada en `known_hosts`. El KVM 4 la autoriza en un usuario buzón sin privilegios con
  `restrict,expiry-time,command=sftp-server`. El equipo local sube `handoff-pub.asc` y descarga
  `conformance-creds.tar.gpg` directamente al tmpfs. Nunca GitHub ni chats.
- No se solicitó ni recibió ninguna credencial; C-01…C-22 no se ejecutaron.
