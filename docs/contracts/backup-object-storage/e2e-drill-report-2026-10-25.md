# Informe del simulacro E2E contra Garage S3 real — 2026-10-25

No normativo, sin secretos.

- **Plan:** `e2e-drill-handoff.md` @ `aa9919fae52658d0846c47a9bef3f3ca28c835b1` (K1–K7).
- **Procedimiento del operador:** `hachxaan/mainspot-s3-backups` `docs/15`. Servicio en la ventana: `ec7cb72a`;
  código desplegado sin cambios desde `9c880469`.
- **Contrato:** 1.2.0 `c4f87c4aa2e875e7ad01861f5f2a809e025d638c`.
- **Autorización:** mandato 6390217275 y ventana 6395613646 (08:50–13:00 UTC).
- **Coordinación:** issue #2 del servicio.
- **Datos y producción:** solo sintéticos (`deployment_id=synthetic-drill`, base demo `postgres:16`
  desechable, clave sintética). Productor y temporizadores sin activar.

## Resultado por objetivo

| Objetivo | Estado | Evidencia |
|---|---|---|
| **Condición 5** (productor contra el servicio real, datos de prueba borrados al terminar) | **PASS** | B2: `OK action=uploaded` A1/A2, `attempts=1`, verificación §8.3, `check=daily` OK `complete=2`, `lifecycle=ok`; `--check-only` OK. Objetos borrados (D3a) y `v1/` = 0 en E1 |
| **Rechazo por tamaño (1.2.0 §8.2 paso 0)** | **PASS** | B3: `FAIL E-SIZE-LIMIT action=size-rejected attempts=0` (101 062 B > 95 453 B de laboratorio); B nunca llegó a S3; archivos locales de B intactos; A1/A2 `already-complete` |
| **Aviso E2E generado por el productor (DEC-0065)** | **Entrega técnica PASS; confirmación humana PENDIENTE** | `status=ALERT error=E-SIZE-LIMIT event_id=ac931611c7ef4f279c5eef542c4d5b53 delivery=ok` en la misma ejecución, por `MAINSPOT_REMOTE_ALERT_COMMAND` (sha256 y permisos verificados) hacia el bot exclusivo. Falta que el propietario confirme ese `event_id` en su chat; el aviso `VIGIL-RETENTION-WARN` que confirmó (6397003033) es del canal del KVM 4, no este |
| **Condición 6a** (restauración desde `mainspot-backups`) | **PASS** | C: `verify` `valid:true` (objeto, MAC y clave de almacenamiento); `pg_restore --exit-on-error` rc=0; recuento exacto de las 33 tablas igual al origen; §11.3 `--reapply-exits` → `reanonymized: 1` |
| **Condición 6b** (copia protegida con originales ausentes, §11.4 B) | **PASS** | D5/D6: archivos de la copia de A2 con sha256 = D1 = los del productor; `v1/` = 0 con restore; `verify` `valid:true` con la clave relativa; descifrado en el equipo de MainSpot; 33 tablas iguales; `reanonymized: 1` |
| **§9.2.6 pasos 1–6** | **PASS** | 1: dos pares del productor. 2: D1, 2 copias con sha256 = manifiestos. 3: D3a borrado de 4 claves exactas (204 ×4); D3b `DeleteBucketLifecycle` 204 (**T0 = 10:44:22Z**); D3c regla `synthetic-drill-1d` 200. 4: D4a `copies_orphaned=2`, `verify_failed=0`, `anomalies=0`, sin `expire`; D4b writer `HeadBucket` guard → 404, `ListBuckets` solo `mainspot-backups`. 5: D6. 6: el vigilante restauró §9.1 a las 10:58:43Z (restore 10:58:53Z, T0 + 14 min 31 s), `lifecycle_drift restored=true`, sin intervención K3 |
| **§9.2.6 paso 7 / E2** (limpieza de la copia, `--ack-drift`, salud 9/9) | **PENDIENTE** | A cargo del operador del KVM 4 (K6) |
| **S-13** | **Evidencia del simulacro PASS; cierre pendiente de E2 y E4** | Máximo observado en `mainspot-backups` durante el simulacro: **94 453 B** (objeto 93 440 + manifiesto 1 013), muy por debajo del máximo de diseño de 1 GiB; rechazo por encima del límite sin escritura; capacidad medida por el operador (S-15 1.2.0, evidence/43) |

## Cronología (UTC)

| Hora | Hecho |
|---|---|
| 08:53 | A2 (SOL MAIN) y A3 (KVM) PASS → GO técnico mutuo |
| 09:57–10:00 | Configuración del buzón por el propietario (18 PASS); `handoff-pub.asc` subida; paquete sha256 `09478997…e7e6` recibido y verificado; descifrado en tmpfs |
| 09:59–10:01 | B1, B2, B3, C1–C4 |
| 10:38:44 | D1 (operador, K1): 2 copias verificadas |
| 10:44:21–22 | D3a, D3b (T0) y D3c; D4b |
| 10:45 | D4a y D5 (operador) |
| 10:46 | D6 |
| 10:58:43 | El vigilante restaura §9.1 (D7) |
| 10:59 | E1: `v1/` 0, `_conformance/` 0 |
| 11:23 | E3 en el equipo de MainSpot: credenciales, paquete, claves efímeras (GPG en tmpfs y SSH) y bases desechables destruidos |

## Limpieza

- **E1:** `mainspot-backups` sin objetos.
- **E3:** sin credenciales, claves efímeras, bases ni espacio de trabajo en el equipo de MainSpot; productor
  `DISABLED`, sin `remote.env`, 0 unidades remotas.
- **Pendientes:** E2 (operador), E4 (teardown del buzón por el propietario y cierre según docs/14 §5) y la
  confirmación del `event_id` en Telegram.

## Riesgo residual observado

Entre la recepción y E3 (≈ 1 h 25 min), las credenciales writer/restore estuvieron en tmpfs (0700/0600)
fuera de un scope sin swap: el descifrado inicial sí se hizo con `MemorySwapMax=0`, pero el archivo
permaneció en tmpfs, y el swap del equipo es un archivo sin cifrar. No hay evidencia de que se paginaran.
La rotación no es obligatoria según docs/14 §5 si el operador no detecta desviaciones; el propietario puede
pedirla.
