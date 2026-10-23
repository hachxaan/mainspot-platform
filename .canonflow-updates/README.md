# Actualizaciones pendientes de CanonFlow originadas en MainSpot

Registro versionado de los ajustes al Human Decision Console (HDC) solicitados y
aplicados en MainSpot que deben incorporarse al repositorio de CanonFlow. Objetivo:
que una instalación nueva de CanonFlow en otro repositorio ya incluya estas
soluciones y no repita el diagnóstico.

Este directorio documenta y reproduce cambios; no es configuración activa. El
despliegue vigente de MainSpot está en `scripts/deploy/`, `docs/COGNITIVE-JEV.md`
y `.canonflow/cognitive/checkpoint.json`.

## Base upstream

| Dato | Valor |
| --- | --- |
| Repositorio | `git@github-carlos:Carlos-Pinacho/canonflow-keystone.git` |
| Checkout local | `/home/administrador/codeart/canonflow-keystone` |
| Commit base (pin de MainSpot) | `5e3dc307a4089f462b9742b76fd002cf910102fa` |
| Definición normativa | `CANONFLOW_HDC_DEFINITION.md` v1 (2026-09-21) |
| `workspace.js` en la base | sha256 `d3e209cbd6925a0db1ef02e48c41b1f38cc477bff95ae9b3d78ddfdf90136497` |

MainSpot no modifica el checkout de CanonFlow: `scripts/canonflow-jev.py` exige
que `decision-console/app/canonflow_hdc` coincida con el pin y, si no, aborta con
`FRAMEWORK_PIN_MISMATCH`. Por eso los cambios de UI se sirven en MainSpot como
override de Nginx hasta que CanonFlow los integre. Desde HDC-0005 el override
abarca todo el frontend: `scripts/deploy/hdc-ui/`, resultado de la pila de parches
HDC-0003, 0004, 0005 y 0007 (HDC-0008 no toca el frontend). Los cambios de backend
de un parche, como el `web.py` de HDC-0007 o el `reconcile.py` de HDC-0008, no se
despliegan en MainSpot hasta actualizar el pin.

## Índice

| ID | Cambio | Clase | Estado | Material |
| --- | --- | --- | --- | --- |
| [HDC-0001](HDC-0001-servicio-persistente.md) | Servicio persistente con arranque automático | Contradice §12; requiere decisión | `REQUIERE_DECISION` | `artifacts/mainspot-hdc.service` |
| [HDC-0002](HDC-0002-https-proxy-inverso.md) | Acceso HTTPS por dominio mediante proxy inverso | Contradice §14; requiere decisión | `REQUIERE_DECISION` | `scripts/deploy/mainspot.hdc.com.conf` |
| [HDC-0003](HDC-0003-errores-validacion-orden-confirmado.md) | Errores de validación vigentes; orden confirmado sin reordenar | Corrección de conformidad (§6, §16 I4) | `PARCHE_LISTO` | `patches/HDC-0003-validation-errors-confirmed-order.patch` |
| [HDC-0004](HDC-0004-recuperacion-al-refrescar.md) | Restaurar elecciones y comentarios al refrescar; respuestas enviadas en lectura | Corrección de conformidad (§10, §11, §16 I4) | `PARCHE_LISTO` | `patches/HDC-0004-refresh-draft-recovery.patch` |
| [HDC-0005](HDC-0005-rediseno-ui-produccion.md) | Rediseño de la UI con calidad de producción (sistema visual, vistas, workspace, accesibilidad AA) | Corrección de conformidad y UX dentro de §11 (§6, §9, §10, §14) | `PARCHE_LISTO` | `patches/HDC-0005-ui-production-redesign.patch` |
| [HDC-0006](HDC-0006-vistas-compatibilidad-tras-ingestion.md) | `rebuild-index`, `index.json`/`latest.json` y carpeta de QS tras ingerir/archivar | Corrección de conformidad (§7.1, §7.2 paso 8, §13) en los puntos 1, 3, 4, 5 y 7; la semántica de `state` (punto 2) y la carpeta (punto 6) las decidió el propietario en ANS-0012 (DEC-0050, DEC-0051) | `PARCHE_LISTO` para los siete puntos: los puntos 2 y 6 quedaron decididos en RUN-0010 con las opciones que el parche implementa (A y A); antes de integrar, verificar el parche contra las condiciones de ANS-0012 §1 (DEC-0054), anotadas en la ficha. En MainSpot: `APLICADO_MAINSPOT` con el script general | `patches/HDC-0006-compat-views-lifecycle.patch`, `artifacts/HDC-0006-regenerate-compat-views.py` |
| [HDC-0007](HDC-0007-escritura-recuperable-solo-lectura.md) | La consola quedaba en solo lectura hasta reiniciar (`503 WRITES_DISABLED`); aviso de solo lectura y renovación del token CSRF en la UI | Corrección de conformidad (§11, §13, §14) | `PARCHE_LISTO` (UI desplegada; backend pendiente upstream, mitigación: reiniciar el servicio) | `patches/HDC-0007-writes-recovery-readonly-ux.patch` |
| [HDC-0008](HDC-0008-qs-v2-pending-declarado-no-es-conflicto.md) | Aviso falso `DECLARED_STATE_CONFLICT` («QS declares PENDING») en toda sesión v2 respondida, ingerida o archivada | Corrección de conformidad (§5.2, §8) | `PARCHE_LISTO` (backend; visible en MainSpot hasta actualizar el pin) | `patches/HDC-0008-v2-declared-state-not-a-conflict.patch` |
| [HDC-0009](HDC-0009-publish-session-generated-at.md) | `publish-session` aceptaba un `generated_at` futuro (QS-0009, `FND-0001` de RUN-0006): ahora lo sella si falta y rechaza valores futuros (más de 120 s) o que no sean RFC 3339 UTC | Corrección de conformidad (§5.2, §7.1, §7.2 paso 8, §10) | `PARCHE_LISTO` (backend; mitigación en MainSpot: wrapper) | `patches/HDC-0009-publish-session-generated-at.patch`, `artifacts/HDC-0009-publish-session-stamped.py` |

Estados:

- `APLICADO_MAINSPOT`: funciona en MainSpot; falta material para upstream.
- `PARCHE_LISTO`: parche verificado contra la base; pendiente de integrar.
- `REQUIERE_DECISION`: contradice la definición; el propietario debe enmendarla
  antes de implementar en CanonFlow.
- `INTEGRADO_UPSTREAM <commit>`: incorporado en CanonFlow.
- `RETIRADO_DE_MAINSPOT`: workaround local eliminado tras actualizar el pin.

## Integrar los parches en CanonFlow

Los parches están apilados. Se aplican sobre la base en este orden:

1. HDC-0003, HDC-0004, HDC-0005, HDC-0007, HDC-0008 y HDC-0009, en orden
   numérico;
2. **HDC-0006 al final**, porque se generó sobre HDC-0009 (los dos cambian
   `lifecycle.py` y las pruebas).

HDC-0001 y HDC-0002 no tienen parche. Los puntos 2 y 6 de HDC-0006 ya están
decididos (QS-0010/ANS-0012, ingerida en RUN-0010: DEC-0050 `efectivo` y DEC-0051
`mover`, las opciones que el parche implementa); antes de integrarlo, verificar el
parche contra las condiciones de ANS-0012 §1 (DEC-0054) anotadas en la ficha. Si se
integra todo menos HDC-0006, se omite su última línea; el resto de la pila no
depende de él.

```sh
cd /home/administrador/codeart/canonflow-keystone
git switch -c hdc/mainspot-updates 5e3dc307a4089f462b9742b76fd002cf910102fa
U=/home/administrador/codeart/mainspoot/mainspot-platform/.canonflow-updates/patches
git apply --check "$U/HDC-0003-validation-errors-confirmed-order.patch"
git apply "$U/HDC-0003-validation-errors-confirmed-order.patch"
git apply "$U/HDC-0004-refresh-draft-recovery.patch"
git apply "$U/HDC-0005-ui-production-redesign.patch"
git apply "$U/HDC-0007-writes-recovery-readonly-ux.patch"
git apply "$U/HDC-0008-v2-declared-state-not-a-conflict.patch"
git apply "$U/HDC-0009-publish-session-generated-at.patch"
git apply "$U/HDC-0006-compat-views-lifecycle.patch"
sha256sum decision-console/app/canonflow_hdc/frontend/js/views/workspace.js
# esperado: 43842daa58136f30e0eefbacf26de3e56dd1ac3c5b7e2bbc90415d8f8a33cbb1
# (HDC-0008, HDC-0009 y HDC-0006 no tocan el frontend)
# resto de archivos: tablas «Archivos upstream» de HDC-0005, 0007, 0008, 0009 y 0006
```

Verificación ejecutada el 2026-10-22, sin tocar el checkout. Se extrajo la base
con `git archive 5e3dc307` en `/tmp/cf-verify` y se aplicaron los siete parches
en ese orden, cada uno con `git apply --check` y `git apply`; todos dieron `OK`.
El resultado coincide con la copia de trabajo `/tmp/cf-hdc`
(`diff -r`: solo difieren los `__pycache__`), y `workspace.js` = `43842daa…`.
Pruebas de `decision-console/app`, con el Python 3.12.3 del venv de Jev y pytest
en `/tmp/pt-lib`:

| Pila | Resultado |
| --- | --- |
| HDC-0003..0008 | `99 passed` |
| + HDC-0009 | `109 passed` |
| + HDC-0006 | `115 passed in 5.42s` |

`git -C canonflow-keystone status --porcelain` dio la misma salida antes y
después (16 líneas, `cmp` idéntico).

Si la rama destino ya cambió algún archivo de `frontend/`, usar `git apply --3way`
y repetir los escenarios de verificación de cada ficha. Después:

1. Ejecutar los ajustes de integración listados en cada ficha (i18n, campo
   `auto_reapplied`, pruebas).
2. Regenerar el wheel y el manifiesto con hashes (§12): la app sirve solo recursos
   empaquetados. `decision-console/app/build/lib/` es una copia de build antigua;
   no editarla a mano.
3. Marcar la ficha como `INTEGRADO_UPSTREAM <commit>`.

## Retirar los workarounds de MainSpot tras integrar

1. Actualizar `PIN` en `scripts/canonflow-jev.py` al commit integrado.
   **Efecto:** la propuesta de activación de Jev exige `framework_sha == PIN`;
   cambiar el pin invalida la propuesta vigente y requiere una nueva aprobación
   HDC vinculada por hash.
2. Quitar de `scripts/deploy/mainspot.hdc.com.conf` las `location = /`,
   `^~ /css/` y `^~ /js/`, borrar `/var/www/mainspot-hdc-ui/` en el LXC
   `webserver` y eliminar `scripts/deploy/hdc-ui/`.
3. `lxc exec webserver -- nginx -t` y `systemctl reload nginx`; comprobar que
   loopback y HTTPS sirven el mismo frontend empaquetado.
4. Dejar de usar `artifacts/HDC-0009-publish-session-stamped.py` y
   `artifacts/HDC-0006-regenerate-compat-views.py`, y el `mv` manual a
   `archived/`, cuando el pin incluya sus parches: `publish-session`,
   `mark-session` y `rebuild-index` lo hacen.
5. Actualizar `docs/COGNITIVE-JEV.md`, el checkpoint y el estado de la ficha a
   `RETIRADO_DE_MAINSPOT`.

## Registrar un cambio nuevo de HDC (obligatorio)

Todo cambio de HDC pedido en MainSpot se registra aquí en el mismo trabajo que lo
implementa. También se registra todo defecto de HDC o de sus instrumentos (CLI,
índices, ciclo de vida) que un agente sortee en MainSpot, aunque no modifique
código de HDC: anotarlo solo en un skill-report no basta.

1. Crear `HDC-NNNN-<slug>.md` con el siguiente número y la plantilla inferior.
2. Si cambia código de CanonFlow, añadir `patches/HDC-NNNN-<slug>.patch`:
   - rutas relativas a la raíz de CanonFlow, cabeceras `a/` y `b/`;
   - generado sobre el resultado de la pila anterior, no solo sobre la base;
   - verificado con `git apply` sobre la base más todos los parches previos;
   - el asset desplegado en MainSpot debe ser byte a byte igual al resultado de
     la pila; registrar su sha256.
3. Citar la sección de `CANONFLOW_HDC_DEFINITION.md` afectada y clasificar el
   cambio como corrección de conformidad o como cambio que requiere decisión.
4. Registrar solo verificaciones ejecutadas. Usar proyectos sintéticos temporales;
   no enviar ni reescribir respuestas humanas reales.
5. Actualizar el índice y, si cambia el despliegue, `docs/COGNITIVE-JEV.md` y el
   checkpoint.

### Plantilla de ficha

```markdown
# HDC-NNNN — Título

| Campo | Valor |
| --- | --- |
| Fecha | AAAA-MM-DD |
| Estado | APLICADO_MAINSPOT / PARCHE_LISTO / REQUIERE_DECISION |
| Clase | Corrección de conformidad (§…) / Contradice §… |
| Solicitud | Qué pidió el propietario |

## Problema observado
## Causa raíz
## Cambio
## Contrato afectado
## Archivos upstream
## Despliegue en MainSpot
## Verificación ejecutada
## Ajustes al integrar en CanonFlow
## Riesgos y límites
```
