# S-13: decisión (QS-0013 → DEC-0059…DEC-0063), análisis normativo y plan de pruebas posterior

No normativo. **Decidido el 2026-10-24** (ANS-0014, ingerida en RUN-0014; QS-0013 `ARCHIVED`, sha256
`0f859a2094096d8b21d6dc39765f0c6ec758dde3bc38eb27f9523b45308a25d7`):

- **DEC-0059:** máximo de diseño de 1 GiB por respaldo remoto completo (objeto + manifiesto).
- **DEC-0060:** se mantiene la cuota de 50 GiB.
- **DEC-0061:** rechazo seguro con aviso (`E-SIZE-LIMIT`); el respaldo local queda intacto.
- **DEC-0062:** preparar el contrato 1.2.0 (MENOR).
- **DEC-0063:** condiciones literales del propietario.

DEC-0063 autoriza preparar 1.2.0 y desarrollar el control y sus pruebas sintéticas; S-13 **no** queda cumplida por la
decisión. No autoriza activar, instalar temporizadores, cambiar cuotas ni declarar recuperación productiva.
Productor y temporizadores siguen desactivados.

**Ejecutado el 2026-10-24:**

- Contrato 1.2.0 publicado en la rama `contract/backup-object-storage-v1`: commit
  `c4f87c4aa2e875e7ad01861f5f2a809e025d638c`, pin del README `2bb529054fe295bdc87ff2682c7c9c4f8044c953`.
- Control implementado en `scripts/ops/backup/db-backup-remote.py`.
- Pruebas T-01…T-12: 17 casos, todos PASS, más la regresión de las 52 pruebas previas, también PASS (69 en total,
  Garage v2.4.1 de laboratorio; `v1/VERIFICATION.md` §11).

Quedan pendientes:

- la reconciliación de 1.2.0 por el KVM 4;
- su nueva declaración S-15 con mediciones de S-13;
- la decisión del canal externo de los avisos del productor;
- el simulacro E2E.

S-13 sigue **NO VERIFICADO**.

Referencias: contrato 1.1.0 @ `0cbdfcf`; KVM 4 @ `09e913d3558f1d41bf5cfe2def048b0fac6349cc` (declaración S-15 en
`f478e7df`, evidence/41); evaluación `s13-capacity-assessment-2026-10-24.md` (mainspot-platform@`65f60d10`).

## 1. Requisitos normativos revisados

| Requisito | Texto (1.1.0) | Efecto |
|---|---|---|
| S-13 (§15) | Capacidad libre para 2 × 16 respaldos «del tamaño máximo observado en `mainspot-backups`» + 16 en la copia | Se mide con lo **observado**; el bucket tiene 0 objetos → NO VERIFICADO (operador, evidence/41) |
| S-15 (§15) | Informe §14 + declaración del operador sobre S-04, S-06, S-11, **S-13** y S-16 | La declaración existe, pero con S-13 sin verificar |
| §2.3 condición 2 | Informe externo `"conformant": true` + S-15 | Incompleta solo por S-13 |
| §8.2 | El productor sube cada respaldo local de menos de 24 h sin copia remota | No contempla rechazar por tamaño |
| §8.3 | Verificación por GET completo; «si un respaldo supera 1 GiB, una versión MINOR PUEDE sustituirlo» | Disparador de revisión, no un límite |
| §13 | Tabla cerrada de errores | No hay código de tamaño |
| §18 | MENOR = añadidos compatibles (nuevas comprobaciones) | Una comprobación de tamaño y un error nuevo son MENOR |

## 2. ¿Contrato nuevo o política compatible con 1.1.0?

Conclusión del agente: **la propuesta preferida exige una versión MENOR (1.2.0)**. Como política sola no basta:

- Un rechazo por tamaño contradice §8.2 y añade un error que §13 no tiene.
- «No declarar S-13 cumplida solo porque el propietario acepte el máximo» (punto 5 de la propuesta) solo se puede
  resolver si S-13 define cómo cuenta un máximo **aplicado técnicamente** antes de que haya objetos observados.
  Con el texto 1.1.0, S-13 es literalmente inverificable hasta activar, y activar exige S-13.
- 1.2.0 sería compatible: el manifiesto, las rutas, el cifrado y `contract_version 1.x.y` no cambian.

Cambios previstos para 1.2.0 si el propietario elige esa vía (Q-S13-CONTRACT-PATH):

1. §2.2: fila «Tamaño máximo de diseño por respaldo remoto (objeto + manifiesto) = X; cuota 50 GiB» → APROBADO, DEC-….
2. §8.2: paso 0, antes de cualquier escritura remota: si `tamaño del objeto + tamaño del manifiesto > X`, no subir,
   registrar `E-SIZE-LIMIT` y avisar; el respaldo local no se toca.
3. §13: `E-SIZE-LIMIT` | respaldo por encima del máximo de diseño | no | no subir; conservar local | sí.
4. §15 S-13: «capacidad libre para 2 × 16 + 16 respaldos de tamaño `max(máximo de diseño aplicado por el productor,
   máximo observado)`»; revalidación obligatoria si cambian el máximo, la cuota, la retención, o si el observado
   supera el 80 % del máximo.
5. §10.1: aviso cuando el respaldo observado supere el 80 % del máximo.
6. CHANGELOG 1.2.0, publicación por commit en la rama del contrato y reconciliación de ambos agentes (condición 4).

## 3. Acreditación de S-13 antes de activar

S-13 pasa a **PASS** solo si se cumplen **todos** estos puntos; aceptar el máximo no basta:

1. DEC de QS-0013 ingerido (máximo X, cuota, política del productor, vía contractual).
2. Si se elige 1.2.0: contrato publicado y citado por commit por MainSpot y por el KVM 4.
3. Control del productor implementado; pruebas T-01…T-10 (§4) en PASS en el laboratorio Garage.
4. El operador del KVM 4 vuelve a declarar S-13 con mediciones fechadas:
   - libre en el bucket ≥ 32 × X;
   - copia protegida: `GUARD_MAX_BYTES` ≥ 16 × X y que se respete `GUARD_MIN_FREE_BYTES`;
   - disco hasta el nivel crítico de garage-health ≥ 48 × X.
   Con X = 1 GiB y cuota de 50 GiB: 32/50 GiB, 16/50 GiB y 48/≈158,9 GiB.
5. Simulacro E2E sintético (§5) con aceptación por debajo de X y rechazo por encima, sin escritura remota.
6. Tras activar: nueva verificación con el máximo observado real y revalidación según los disparadores.

## 4. Pruebas mínimas (tras el DEC; laboratorio Garage v2.4.1, datos sintéticos)

Se añaden a `tests/ops/backup-remote/`, con el mismo arnés (Docker 127.0.0.1, proxy que registra operaciones). El
límite se inyecta por configuración de laboratorio para no generar archivos de 1 GiB.

| Id | Caso | Esperado |
|---|---|---|
| T-01 | objeto + manifiesto = X − 1 B | sube y verifica (§8.3); manifiesto escrito |
| T-02 | = X exactamente | sube (el límite es inclusivo; se fija en la redacción) |
| T-03 | = X + 1 B | 0 operaciones de escritura en el proxy (ni `PutObject` ni multiparte); `E-SIZE-LIMIT` en el registro §16.3; código de salida 1 |
| T-04 | rechazo con multiparte (objeto > `SINGLE_PART_MAX` y > X) | no se inicia `CreateMultipartUpload` |
| T-05 | respaldo local tras el rechazo | el archivo `.dump.enc` y su `.sha256` siguen ahí y con el mismo sha256; el productor no borra nada |
| T-06 | aviso | evento de aviso emitido (mismo canal que los demás errores del productor), sin secretos ni contenido |
| T-07 | siguiente respaldo dentro de X | se sube con normalidad en la ejecución siguiente |
| T-08 | reintento del respaldo grande | no se reintenta en bucle; sin escrituras; la ventana de 24 h termina en `E-UPLOAD-WINDOW` |
| T-09 | frescura | sin respaldo remoto en 26 h → `E-FRESHNESS` en `--check-only` |
| T-10 | configuración | límite ausente o no válido → falla de forma segura (no sube) y lo indica; sin secretos en los registros |
| T-11 | un rechazo nunca cuenta como éxito (DEC-0063) | estado distinto de `OK`, sin manifiesto remoto; no satisface la comprobación de frescura de §10.1 |
| T-12 | aviso inmediato (DEC-0063) | el aviso se emite en la misma ejecución que el rechazo, no al cabo de 26 h |

Más el pase de regresión completo de las suites actuales (52 casos).

## 5. Alcance del siguiente simulacro E2E (preparado, no ejecutado)

Requiere el DEC, el control implementado y un mandato aparte con un handoff nuevo de la credencial writer (y de
restore para la restauración), igual que en la conformidad.

- **Destino:** `mainspot-backups`, `deployment_id = synthetic-drill`, clave sintética de §7.5; nunca respaldos
  reales.
- **Pasos:**
  1. Respaldo sintético por debajo de X (volcado de una base desechable): `--dry-run`, ejecución real y
     `--check-only`.
  2. Respaldo sintético por encima de un X de laboratorio reducido en la configuración temporal: rechazo,
     `E-SIZE-LIMIT`, aviso y 0 escrituras.
  3. Restauración con restore desde `mainspot-backups` (condición 6a): `manifest_tool.py verify` → `valid: true`,
     descifrado en streaming y `pg_restore` en una base desechable.
  4. Verificación de la copia protegida del par sintético (≤ 1 h) por parte del operador.
- **Limpieza:** se coordina con el operador. Por defecto se deja expirar por la regla de 14 días: borrar originales
  dispara la auditoría de desapariciones del guard.
- **Fuera de alcance:** activar el temporizador, `remote.env` en la ruta por defecto, cambios de cuota y datos
  reales.
- **Evidencia:** informe sin secretos con commits (MainSpot, servicio, contrato), salidas del productor y
  confirmación de la limpieza.
