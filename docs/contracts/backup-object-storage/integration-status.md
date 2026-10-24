# Estado de integración MainSpot ↔ Garage S3 (KVM 4) — 2026-10-23

Documento no normativo y publicable (sin secretos, direcciones privadas ni detalles internos de
la infraestructura). No forma parte del contrato `v1/` y no cambia su versión. La transferencia
remota sigue **desactivada**.

## Referencias

| Elemento | Valor |
|---|---|
| Contrato | 1.1.0, `0cbdfcf008ed84f9cddea399c5d49915ca24e828` (rama `contract/backup-object-storage-v1`) |
| Decisiones QS-0012 | DEC-0055..DEC-0058 (RUN-0012), publicadas en `a8d9e0f01b4fa300f261fdeff36bee0d27c0aac7` |
| Checkpoint del servicio | `hachxaan/mainspot-s3-backups@158ec59d2b323026f0ed2391c646e29987e93b3f` (estado PARTIAL), servicio probado `824a45294c769a7a2bcb88ebbb172634ec85ee81` |
| Runner de conformidad | sha256 `ae28a41a6faa188a51f508b027ebe1a72077f16e2ee526af7e01f5655553fc85`: idéntico en `0cbdfcf` (`v1/conformance/`) y en el repositorio del servicio (`contract/v1/`) |

Sustituye como estado vigente a `v1/infra-reconciliation-ab046d24.md`, que queda como histórico.

## Reconciliación con el servicio @ `158ec59`

| Requisito | Declarado por el operador del KVM 4 | Decisión | Pendiente |
|---|---|---|---|
| §9.1 retención (H-01/H-02) | Regla de ciclo de vida exacta como único borrador; vigilante horario sin `DeleteObject`; inventario por `created_at`; 26 PASS | Conforme con DEC-0057 | Comprobación externa |
| §9.2 copia protegida (H-03) | Opción B: contenedor y volumen propios, clave guard de solo lectura, sin ruta de la clave writer al volumen; caducidad local a 14 días; restauración con originales ausentes; 31 PASS | Conforme con DEC-0056 | C-21/C-22 MANUAL en el informe externo |
| §10.1 / S-08 aviso externo (H-04) | Cumplido en `03e71236c1ce1b357053239ff7f97c1f03be59a9`: `garage-alert` (`487428df`) con un bot dedicado; el propietario confirmó la recepción del mensaje de prueba (evidence/37) | Conforme con DEC-0055 y DEC-0058 §1 | — |
| §18 cita del contrato | `0cbdfcf` citado | Condición 4 cumplida | — |
| §14 conformidad | Desde el host: 20 PASS, C-21/C-22 MANUAL, `conformant=false` | No sustituye la ejecución externa | Ver abajo |

## Conformidad externa (§14)

**No ejecutada.** El host local de MainSpot no dispone de las credenciales **writer**/**restore**
ni de autorización del propietario para actuar como ejecutor externo. No hay `"conformant": true`.

Observado el 2026-10-23 desde fuera del KVM 4, sin credenciales (no sustituye a C-xx): bucket
anónimo HTTP 403; verificación TLS correcta; certificado Let's Encrypt `YE2`,
CN `s3.mainspot.canonflow.dev`, `notAfter` 2027-01-20 08:00:21 GMT; puerto 80 → 301 a HTTPS.

Procedimiento al desbloquear: checkout de `158ec59`,
`scripts/host/run-external-conformance.sh --credentials <writer.env> <restore.env> --report external-conformance.json`
(archivos 0600 fuera de cualquier repositorio), atestación de ubicación externa y commit completo
del checkout; C-21/C-22 se presentan como MANUAL con la evidencia del simulacro de la copia
protegida del servicio.

## Productor MainSpot (§8)

- `scripts/ops/backup/db-backup-remote.py` (sha256 `1079edc1…a6786a9`): sin configuración termina
  `status=DISABLED reason=no-config`; unidades `mainspot-db-backup-remote.*` no instaladas.
- `tests/ops/backup-remote`: **52 passed** contra Garage v2.4.1 de laboratorio (127.0.0.1, datos
  sintéticos): manifiesto, cifrado y MAC, integridad, reintentos, rechazo de duplicados/conflictos,
  restauración desde el bucket y desde la copia con originales borrados. No faltaba ninguna prueba
  ejecutable sin credenciales del servicio.

## Puerta de activación (§2.3)

| # | Condición | Estado |
|---|---|---|
| 1 | Certificado verificado externamente | PENDIENTE (observado; falta C-01 en el informe externo) |
| 2 | Informe externo `"conformant": true` | BLOQUEADA (credenciales y autorización del ejecutor) |
| 3 | Copia protegida implementada, aislada y probada | Hecha en el KVM 4 (evidencia del operador); C-21/C-22 MANUAL |
| 4 | Contrato reconciliado por commits | CUMPLIDA |
| 5 | Productor probado con datos sintéticos | PENDIENTE (laboratorio hecho; falta el servicio real) |
| 6 | Restauración desde el remoto y desde la copia | PENDIENTE (copia: hecha en el KVM 4; remoto: requiere credenciales) |
| P-3 | Aviso externo | CUMPLIDO en el servicio (`03e71236`); plan de conformidad: `external-conformance-plan.md` |
| 7 | Autorización del propietario en HDC | BLOQUEADA por las anteriores |

Ninguna de estas comprobaciones activa el productor ni autoriza transferir respaldos productivos
(DEC-0049 §7, DEC-0058 §4).
