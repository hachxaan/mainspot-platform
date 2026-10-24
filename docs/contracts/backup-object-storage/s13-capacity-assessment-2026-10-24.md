# Evaluación de capacidad S-13 — Garage S3 v1.1.0 — 2026-10-24

Evaluación de solo lectura. No se generaron respaldos, no se leyó contenido de la base de datos,
no se transfirió nada a Garage y no se cambiaron cuotas ni configuración. Productor remoto sin
configuración (`status=DISABLED reason=no-config`) y sin unidades instaladas.

Referencias: contrato 1.1.0 @ `0cbdfcf` (§15 S-13, §8.3); declaración S-15 del operador
`hachxaan/mainspot-s3-backups@f478e7df82d4cf4f8693440f415861022763854b`, `evidence/41` (S-13
**NO VERIFICADO**: 0 objetos en `mainspot-backups`).

## Dictamen

**NO DETERMINABLE.** S-13 sigue **NO VERIFICADO**, no PASS. La cuota actual alcanza de sobra
para los respaldos observados, pero nada documenta el respaldo más grande esperado.

- S-13 mide «el tamaño máximo observado **en `mainspot-backups`**», y ahí no hay objetos. Los
  respaldos locales sirven como referencia, no como la medida del contrato.
- Con los respaldos locales observados, la cuota de 50 GiB queda unas 13 870 veces por encima de
  lo necesario.
- Esos respaldos vienen de una base de piloto prácticamente vacía. No representan el máximo
  esperado y no hay ninguna proyección ni límite documentado que lo sustituya.

## 1–2. Respaldos locales observados (solo tamaños)

Formato (`scripts/ops/backup/db-backup.sh`): respaldo **completo**
`pg_dump -Fc` (formato custom con compresión interna) → `openssl enc` AES-256-CBC con salt, en
streaming. Cada archivo `mainspot-db-<UTC>.dump.enc` es un respaldo completo, comprimido y
cifrado. No hay respaldos incrementales ni archivos sin cifrar. Directorio por defecto
`~/.local/share/mainspot/backups`, con retención local de 14 días.

| Respaldo (UTC) | Bytes |
|---|---:|
| 20261022T060051Z | 114 768 |
| 20261022T060318Z | 114 768 |
| 20261022T061641Z | 114 768 |
| 20261022T061743Z | 120 912 |
| 20261022T061958Z | 120 912 |
| 20261022T081536Z | 120 912 |
| 20261023T081522Z (más reciente) | **120 960** |

**Máximo observado: 120 960 B (≈ 118 KiB)**, 7 respaldos en 2 días (`backup.log`, `status=OK`).

Métrica de capacidad de solo lectura de la base (`pg_database_size`, `pg_stat_user_tables`;
sin leer filas): PostgreSQL 16.15, base `mainspot` de 10 215 kB en disco, 33 tablas, unas 60
filas vivas en total, no está en recuperación.

## 3. Representatividad

**No representa el mayor respaldo esperado.** Es una base de piloto sin datos de producción. El
crecimiento observado (114 768 → 120 960 B, +5,4 % en 2 días) refleja cambios de esquema o de
prueba y no sirve para extrapolar. No hay tenants reales ni una proyección de volumen
documentada.

## 4–5. Cálculo

Bytes por respaldo en S3: B = objeto cifrado S + manifiesto M. M es de unos 1,1 kB (ejemplo del
contrato); el guard admite como mucho 64 KiB, que es la cota usada aquí. Sobrecarga del cifrado:
16 B de cabecera `Salted__` más ≤ 16 B de relleno (despreciable); la compresión ya va incluida en
`-Fc`.

| Restricción | Fórmula | Cota de B | Con S observado (B = 186 496 B) |
|---|---|---:|---:|
| Cuota `mainspot-backups` 50 GiB (aplicada por Garage; `maxObjects` sin límite) | 32 × B ≤ 50 GiB | **1 677 721 600 B (1,5625 GiB)**, la más restrictiva | 5,97 MB (0,011 %) |
| Copia protegida `GUARD_MAX_BYTES` 50 GiB, `GUARD_MIN_FREE_BYTES` 10 GiB | 16 × B ≤ 50 GiB | 3,125 GiB | 2,98 MB |
| Disco compartido del KVM 4 (operador: ≈ 158,9 GiB hasta `crit`) | 48 × B ≤ 158,9 GiB | 3,31 GiB | 8,95 MB |

Margen operativo adicional en el bucket: los objetos `_conformance/` (≈ 9 MiB por ejecución,
expiran a 1 día) y la multiparte incompleta (se aborta a 1 día) son temporales y no cambian la
cota. Las alertas `bucket_quota` saltan al 80 y al 95 % de 50 GiB. El disco se comparte con el
resto del host, sin cuota por volumen; es un riesgo declarado por el operador.

Condición de cumplimiento con la configuración actual: **el mayor objeto cifrado ≤ 1 677 656 064 B**
(1,5625 GiB menos 64 KiB de manifiesto).

## 6. ¿Hay un límite de tamaño de respaldo exigible y documentado?

**No.**

- El contrato no fija ningún tamaño máximo. §8.3 solo dice que «si un respaldo supera 1 GiB, una
  versión MINOR PUEDE sustituir» la verificación por GET completo: es un disparador de revisión,
  no un límite.
- El productor no rechaza respaldos por tamaño. A partir de 256 MiB usa multiparte con partes
  de 64 MiB.
- `client_max_body_size 5g` de Nginx limita cada petición, no el objeto, que se sube por partes.
- El único tope que se aplica de verdad es la cuota del bucket (50 GiB en total). Cuando se agota,
  la subida falla; no hay un límite por respaldo.

## 8. Opciones (no ejecutadas)

| Opción | Efecto | Implicaciones |
|---|---|---|
| **A. El propietario declara un tamaño máximo de diseño ≤ 1 GiB** (coherente con §8.3) | 32 × (1 GiB + 64 KiB) = 32,0 GiB ≤ 50; guard 16,0 GiB ≤ 50; disco 48,0 GiB ≤ 158,9. Permite declarar S-13 sobre una base **declarada** | Sin cambios de infraestructura. Hay que volver a medir con el tamaño observado tras la activación y revisar en cuanto un respaldo pase de 1 GiB (lo exige además §8.3). Lo decide el propietario (registro HDC) |
| B. Hacer exigible el límite en el productor (avisar o rechazar por encima de un umbral) | Convierte A en un control técnico | Cambio de código en MainSpot y posible versión MINOR del contrato; no altera la cuota |
| C. Ampliar la cuota (p. ej. 100 GiB → cota de B de 3,125 GiB) | Más margen | Cambio material en el KVM 4 que requiere autorización. Hay que revisar `GUARD_MAX_BYTES` y el disco compartido: 48 × 3,125 GiB = 150 GiB, cerca del margen de 158,9 GiB |
| D. Esperar al tamaño observado tras activar | Medida exacta del contrato | **Circular**: activar exige la condición 2, que a su vez exige S-13 (vía S-15) |

Recomendación técnica: **A**, con **B** como refuerzo opcional. C solo si el propietario espera
respaldos de más de 1,5 GiB a medio plazo.

## Decisión pendiente

El propietario debe declarar el tamaño máximo esperado de un respaldo cifrado, o aceptar ≤ 1 GiB
como tamaño de diseño. Con esa declaración, S-13 pasa a verificable: el operador o MainSpot lo
contrastan con las cotas de arriba y vuelven a verificarlo con el tamaño observado tras la
activación.
