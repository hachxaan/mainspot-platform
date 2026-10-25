# Estado de integración MainSpot ↔ Garage S3 (KVM 4) — 2026-10-25

Documento no normativo y publicable: sin secretos, sin direcciones privadas, sin detalles internos de la
infraestructura. No forma parte del contrato `v1/` ni cambia su versión.

La transferencia remota sigue **desactivada**. Comprobado el 2026-10-25T18:36Z: `status=DISABLED
reason=no-config`, sin `remote.env`, 0 unidades ni temporizadores remotos.

Sustituye a la versión del 2026-10-23, que marcaba las condiciones 5, 6 y S-13 como pendientes.
Dossier de preautorización de la condición 7: `gate7-preauthorization-dossier.md`.

## Referencias

| Elemento | Valor |
|---|---|
| Contrato | 1.2.0, `c4f87c4aa2e875e7ad01861f5f2a809e025d638c` (pin README `2bb529054fe295bdc87ff2682c7c9c4f8044c953`) |
| MainSpot (rama `feat/canonflow-implementation`) | Base de esta conciliación `f70d655876cf88834ed8ff4d02045c54998256db`. El código del productor y del adaptador no cambia desde `92c3faaeab794670d7d529bd3ad9153d2ed625cd`, el commit que usó el simulacro (ver tabla siguiente) |
| Servicio | `hachxaan/mainspot-s3-backups@6945a6329f8e36f11a56c380ce6696ef6fae4260` (evidence/48). El código del servicio no cambia desde `2d5c807e`, el checkout de la conformidad externa |
| Coordinación | [mainspot-s3-backups#2](https://github.com/hachxaan/mainspot-s3-backups/issues/2), [mainspot-platform#2](https://github.com/hachxaan/mainspot-platform/issues/2) |

Artefactos que se activarían, con su sha256:

| Artefacto | sha256 |
|---|---|
| `db-backup-remote.py` | `b714c78300841f111317241d398cb08974c2220b226ecf4cdc91e467512bae7c` |
| `remote-alert-telegram.py` | `d42fe40b86c527c94c29f298af1c54c1fff94ef54db88e69b4f74eafedf442b1` (= el instalado en `~/.local/libexec/mainspot/`) |
| `manifest_tool.py` | `b330ddfa02809d71d761febc7c38fc88b318085f6021d8e135dd7720eac397c3` (= el del contrato) |

## Puerta de activación (§2.3): condiciones 1–6

Valores de la columna «Estado»:
- **PASS**: la condición está acreditada tal como la define §2.3.
- **EVIDENCIA PASS · ACREDITACIÓN OPEN**: la evidencia técnica es PASS, pero el plan acordado (`e2e-drill-handoff.md`, fase E) solo la da por acreditada con E1–E5 completos.

| # | Condición (DEC-0049 §7) | Estado | Evidencia (SHA / URL) | Responsable |
|---|---|---|---|---|
| 1 | Certificado HTTPS público válido, verificado externamente | **PASS** | C-01 PASS en el informe externo (`external-conformance-report-2026-10-24.md` @ `6db95cc827c75118a20d91a6a90486afe0737d67`, run `20261024T062159Z-1750b25a`). Reobservado sin credenciales el 2026-10-25T18:36Z: verificación 0, Let's Encrypt `YE2`, CN `s3.mainspot.canonflow.dev`, `notAfter` 2027-01-20T08:00:21Z | Ejecutor externo (equipo del propietario) y SOL MAIN |
| 2 | Informe de conformidad del endpoint real con `"conformant": true` | **EVIDENCIA PASS · ACREDITACIÓN OPEN** (S-13) | Ver el desglose bajo la tabla | Ejecutor externo; operador KVM 4 (S-15) |
| 3 | Copia protegida implementada, aislada y probada | **PASS** | S-16 PASS (S-15 1.2.0, `9c88046`, evidence/43, con evidence/29 y 32). §9.2.6 repetido de extremo a extremo con pares del productor real: pasos 1–7 PASS (D1–D7; E2 en `6945a63`, evidence/48; informe del simulacro) | Operador KVM 4; ejecutor MainSpot en D3/D6 |
| 4 | Contrato actualizado, versionado y reconciliado | **PASS** | Contrato 1.2.0 `c4f87c4` citado por MainSpot (pin `2bb5290`) y por el KVM 4 en `9c880469dca65420f57cad2c6193c2982433a608` (evidence/43, evidence/44) | Ambos agentes |
| 5 | Productor implementado y probado con datos sintéticos | **EVIDENCIA PASS · ACREDITACIÓN OPEN** (E4/E5) | Ver el desglose bajo la tabla | SOL MAIN |
| 6 | Restauración integral desde el remoto y desde la copia protegida | **EVIDENCIA PASS · ACREDITACIÓN OPEN** (E4/E5) | Ver el desglose bajo la tabla | SOL MAIN; operador KVM 4 (entrega de la copia) |

**Condición 2:**
- Informe externo `"conformant": true`, 20 PASS y C-21/C-22 MANUAL acreditadas con evidence/29 y 32 (`6db95cc`). El runner es idéntico en 1.2.0 (`ae28a41a…fc85`), así que el informe vale para §14 1.2.0 según evidence/43.
- S-15 1.2.0 (`9c88046`, evidence/43): S-04, S-06, S-11 y S-16 PASS; capacidad S-13 verificada para R = 1 GiB.
- S-13 completa: el simulacro aporta el máximo observado de 94 453 B y el rechazo `E-SIZE-LIMIT` sin escritura. **Falta la declaración del operador tras el simulacro (E5).**

**Condición 5:**
- Laboratorio: `tests/ops/backup-remote` 69 PASS contra Garage v2.4.1, con el límite de 1 GiB y los avisos.
- Servicio real (simulacro 2026-10-25, B1–B4):
  - `OK action=uploaded` A1/A2, `attempts=1`, §8.3;
  - `check=daily` OK `complete=2`;
  - `--check-only` OK;
  - B3 `FAIL E-SIZE-LIMIT attempts=0`;
  - datos de prueba borrados (D3a, E1: `v1/` = 0).
- Informe: `e2e-drill-report-2026-10-25.md` @ `c925e1234599d70e2ba72853b399e89329719410`; [comentario B2/B3 6396247858](https://github.com/hachxaan/mainspot-s3-backups/issues/2#issuecomment-6396247858).

**Condición 6:**
- 6a, desde `mainspot-backups` (C1–C4): `verify` `valid:true`; `pg_restore --exit-on-error` rc=0; 33 tablas iguales; `reanonymized: 1` ([6396252805](https://github.com/hachxaan/mainspot-s3-backups/issues/2#issuecomment-6396252805)).
- 6b, desde la copia con los originales ausentes (D5/D6, §11.4 opción B): sha256 = D1; `v1/` = 0; `valid:true`; 33 tablas; `reanonymized: 1` ([6396670390](https://github.com/hachxaan/mainspot-s3-backups/issues/2#issuecomment-6396670390)).

**Canal de aviso (requisito previo a pedir la condición 7, §2.3):**
- **Servicio (S-08):** PASS, con DEC-0055 y DEC-0058 §1. Evidencia: `03e7123`, evidence/37. En el simulacro, el propietario recibió `VIGIL-RETENTION-WARN` FIRING y RESOLVED (6398568655).
- **Productor (DEC-0064/DEC-0065):** PASS.
  - Recepción sintética TEST-SYNTHETIC `f7b848ef…` (`producer-alert-channel-evidence.md` @ `92c3faa`).
  - Aviso E2E `E-SIZE-LIMIT` `ac931611c7ef4f279c5eef542c4d5b53`, recibido y transcrito por el propietario ([rectificación 6401207482](https://github.com/hachxaan/mainspot-s3-backups/issues/2#issuecomment-6401207482)).

## Cierre del simulacro (E1–E5)

| Paso | Estado | Evidencia | Responsable |
|---|---|---|---|
| E1 | **PASS** | `mainspot-backups` sin objetos (`v1/` 0, `_conformance/` 0) a las 10:59Z | SOL MAIN |
| E2 | **PASS** | [6397100773](https://github.com/hachxaan/mainspot-s3-backups/issues/2#issuecomment-6397100773), `6945a63` (evidence/48): 4 `expire` solo en `synthetic-drill`, `--ack-drift`, salud 9/9, ciclo de vida §9.1 exacto, log S3 sin desviaciones | Operador KVM 4 |
| E3 | **PASS** | En el equipo de MainSpot se destruyeron credenciales, paquete, claves efímeras y bases desechables (11:23Z). Productor `DISABLED`, sin `remote.env`, 0 unidades remotas; reverificado el 2026-10-25T18:36Z | SOL MAIN |
| E4 | **OPEN** | Teardown del buzón ejecutado por el propietario, con salida de consola en [6398592957](https://github.com/hachxaan/mainspot-s3-backups/issues/2#issuecomment-6398592957). **Falta la contraverificación independiente del operador** (`docs/15` §E4, `docs/14` §5), pedida en 6401363594 y [6401548807](https://github.com/hachxaan/mainspot-s3-backups/issues/2#issuecomment-6401548807) | Propietario y operador KVM 4 |
| E5 | **OPEN** | **Lado MainSpot:** informe del simulacro (`c925e12`) y este documento. **Lado servicio:** falta el informe final con commit propio que cite 1.2.0 `c4f87c4`, S-13 tras el simulacro, S-15 vigente, §9.2.6 1–7 y la matriz PASS/OPEN | Ambos |

## Otros hechos vigentes

- **S-13.**
  - Máximo observado en el simulacro: 94 453 B.
  - Respaldos locales reales actuales: ≈ 121 KB, el 0,011 % del máximo de diseño de 1 GiB.
  - Capacidad para R = 1 GiB: margen principal 18 GiB, copia 34 GiB, disco 111 GiB (evidence/43).
- **Riesgo observado en el simulacro.** Credenciales en tmpfs con swap sin cifrar: `/swap.img` de 8 GiB y ningún volumen `crypt` en el equipo. El operador concluyó que la rotación no es obligatoria. Tratamiento en el dossier §5.
- **F-01 (acuse por botón).** Es una mejora aislada en `feat/f01-telegram-acknowledged-alerts`: sin fusionar, sin desplegar y con la auditoría AUD-01/02/03 pendiente. No forma parte de la activación base: la activación usaría el adaptador `d42fe40b`, el que pasó el simulacro.

Ninguna de estas comprobaciones activa el productor ni autoriza transferir respaldos productivos
(DEC-0049 §7, DEC-0058 §4). La condición 7 exige un registro `DEC-…` explícito del propietario, en una sesión
HDC propia; recibir un mensaje de Telegram no equivale a esa autorización.
