# Reporte de rollback simulado — INC-001 (AC-009)

> Fecha: 2026-08-20T05:36:38.740Z
> Procedimiento del contrato INC-001 §Rollback y PLAN-INC-001 §11.

## 0. Estado previo (snapshot)

- base de datos objetivo: mainspot_test
- eventos de auditoría: 15
- sesiones activas: 4
- filas role_permission: 15

## 1. Deshabilitar nuevos paths de acceso

- sesiones revocadas: 4
- ningún token emitido con anterioridad sigue siendo válido (fail-closed por sesión).

## 2. Revertir configuración de roles/permisos

- role_permission re-sincronizado desde la matriz de código (15 entradas).
- filas role_permission tras revertir: 15 (esperado 15).

## 3. Preservar datos de auditoría

- eventos antes: 15; después: 15
- resultado: PRESERVADO (no se borró ningún evento)

## 4. Verificar que no queda acceso cruzado

- request sin token -> no_token (fail-closed: OK)
- token inválido/revocado -> invalid_token (fail-closed: OK)
- lectura de dato de otro cliente con contexto A -> found=true, in_tenant=false (esperado found=true, in_tenant=false => deny) OK: deny, sin exponer datos

## 4b. Revocación real de sesión válida (IR-12)

- sesión creada y firmada: resolvible OK (antes de revocar)
- tras revocar la misma sesión (token intacto): reason=session_revoked, session=null -> OK: revocación efectiva (equivalente HTTP 401)

## 5. Estado documentado post-rollback

- clientes activos en seed: 2 de 2
- sesiones: TODAS revocadas; los usuarios deben volver a ingresar (las nuevas sesiones crean contexto válido).
- auditoría: intacta; sirve de evidencia de lo ocurrido antes y durante el rollback.
- acceso cruzado: negado por sesión (revocada) y por capa de datos (scope tenant_id).
- observación: si un path nuevo que INC-002 ya usara se deshabilita aquí, debe coordinarse con ese incremento (nota Reviewer).
