# Handoff del simulacro E2E contra Garage S3 real (preparado, NO ejecutado)

No normativo. Para ejecutarlo hace falta un **mandato explícito del propietario** y una entrega nueva y
temporal de las credenciales **writer** y **restore** (procedimiento GPG de `docs/14-handoff-conformidad.md`
del servicio, como en la conformidad externa). Ningún paso activa el productor, instala temporizadores ni
transfiere respaldos reales.

## Referencias

| Elemento | Valor |
|---|---|
| Contrato | 1.2.0, `c4f87c4aa2e875e7ad01861f5f2a809e025d638c` (pin `2bb529054fe295bdc87ff2682c7c9c4f8044c953`) |
| Servicio | `hachxaan/mainspot-s3-backups@9c880469dca65420f57cad2c6193c2982433a608` (S-15 1.2.0 en evidence/43; capacidad S-13 medida para 1 GiB) |
| Productor | `scripts/ops/backup/db-backup-remote.py` en el commit de MainSpot que se cite al ejecutar (hoy contiene el límite de 1 GiB y los avisos) |
| Adaptador de avisos | `~/.local/libexec/mainspot/remote-alert-telegram.py`, sha256 `d42fe40b86c527c94c29f298af1c54c1fff94ef54db88e69b4f74eafedf442b1`. Recepción real sintética acreditada (`producer-alert-channel-evidence.md`) |
| Decisiones | DEC-0049 §7, DEC-0058 §4, DEC-0059…DEC-0065 |

## Qué acredita

| Objetivo | Criterio |
|---|---|
| S-13 (DEC-0063) | Último requisito pendiente tras la S-15 1.2.0: simulacro con un respaldo por debajo del límite (subido y verificado) y otro por encima (rechazado sin ninguna escritura); el máximo observado en `mainspot-backups` queda registrado |
| Condición 5 de §2.3 | Productor probado con datos sintéticos contra el servicio real |
| Condición 6 (a) | Restauración desde `mainspot-backups` con **restore** en una base desechable |
| Avisos E2E (DEC-0065) | Un aviso generado por el productor (`E-SIZE-LIMIT`) llega al chat del bot exclusivo por la ruta `MAINSPOT_REMOTE_ALERT_COMMAND`, en la misma ejecución, y el propietario confirma su `event_id` |

## Procedimiento previsto

0. **Comprobaciones previas:**
   - ubicación fuera del KVM 4;
   - checkout limpio del commit citado;
   - sha256 del productor y del adaptador;
   - `status=DISABLED` sin configuración;
   - 0 unidades `mainspot-db-backup-remote*`;
   - salud del servicio confirmada por el operador.
1. **Entrega de credenciales:**
   - clave GPG efímera de 2 días en tmpfs;
   - buzón SFTP temporal del KVM 4 (`handoff-drop.sh`);
   - paquete con solo `writer.env` y `reader.env`, descifrado en tmpfs con `MemorySwapMax=0`.
2. **Configuración temporal** en tmpfs (`MAINSPOT_REMOTE_CONFIG=<tmpfs>/remote.env`; nunca la ruta por
   defecto):
   - `MAINSPOT_REMOTE_BACKUP_ENABLED=1` solo en ese archivo;
   - `DEPLOYMENT_ID=synthetic-drill`;
   - credencial writer;
   - `MAINSPOT_BACKUP_DIR` temporal;
   - `MAINSPOT_BACKUP_KEY` con una clave sintética desechable;
   - `MAINSPOT_REMOTE_ALERT_COMMAND` + `MAINSPOT_REMOTE_ALERT_COMMAND_SHA256` del adaptador instalado.
3. **Respaldo sintético A** (por debajo del límite):
   - base desechable en `postgres:16` (imagen local) con datos sintéticos;
   - `pg_dump -Fc` cifrado con los argumentos de §4.2 y su `.sha256`;
   - nunca `db-backup.sh`, que vuelca la base real;
   - ejecutar `--dry-run`, una ejecución real y `--check-only`;
   - esperado: `OK action=uploaded`, verificación §8.3 y `check=daily`.
4. **Respaldo sintético B** (por encima del límite, con `MAINSPOT_REMOTE_LAB_MAX_BACKUP_BYTES` reducido solo
   en esa ejecución):
   - esperado: `FAIL E-SIZE-LIMIT attempts=0`, 0 escrituras S3 de ese respaldo y `status=ALERT delivery=ok`;
   - el propietario confirma en Telegram el `event_id` del aviso.
5. **Restauración (condición 6a)** con **restore**:
   - descargar el par de A;
   - `manifest_tool.py verify` → `"valid": true`;
   - descifrado en streaming y `pg_restore` en otra base desechable;
   - comparar el recuento de filas con el origen sintético.
6. **Operador del KVM 4:**
   - copia protegida del par de A en ≤ 1 h, con su evidencia de §9.2.5;
   - `garage-health` antes y después;
   - registro del máximo observado para S-13.
7. **Limpieza:**
   - `shred` de credenciales y clave efímera en tmpfs;
   - borrado de la configuración y los directorios temporales;
   - los objetos sintéticos expiran por la regla de 14 días, salvo que el operador pida otra cosa (borrar
     originales dispara la auditoría de desapariciones del guard);
   - teardown del buzón.
8. **Informe sin secretos:**
   - commits (MainSpot, servicio, contrato);
   - líneas del productor;
   - `event_id` confirmado;
   - resultado de la restauración;
   - confirmación de la limpieza.

## Fuera de alcance

- Temporizadores.
- `~/.config/mainspot/backup/remote.env`.
- Respaldos o datos reales.
- Cambios de cuota, de infraestructura o del contrato.
- La sesión de autorización de activación, que sigue siendo independiente (condición 7).
