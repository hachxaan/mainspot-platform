# G-MIG / G-SEC — Endurecimiento del PR #13

Fecha: 2026-11-04.
Base: PR #13 (feat/plan-policy-catalog-impl-20261104, b1cd3df).
Rama: fix/plan-catalog-gates-hardening-20261104.
Estado: cambios propuestos; NO ejecutados ni desplegados en un entorno con PostgreSQL. No constituye aprobación humana.

## Cambios

1. Migración 0035: tabla platform_auth_attempt_gate en PostgreSQL, con huellas HMAC-SHA256 y bloqueo transaccional por fila. Login y step-up comparten límite de 5 intentos en 15 minutos entre instancias. Los errores de PostgreSQL impiden autenticar (fail-closed). Se depuran huellas vencidas en lotes acotados.
2. Auditoría de login: reemplaza el login en claro por actor identificado mediante HMAC en las denegaciones nuevas.
3. Registro heredado (R1): plan-catalog-legacy-audit-preflight.sql es solo lectura y cuenta sin divulgar IDs. plan-catalog-legacy-audit-repair.sql es una reparación DBA excepcional, NO una migración automática; exige APPLY=1 y EXPECTED_ROWS=N, restringe el UPDATE a denegaciones con rutas de tenant reconocidas, mantiene actor/acción/decisión/fecha y añade evento agregado. Aborta ante otros IDs client_ sin asociación de tenant; puede requerirse intervención manual.
4. Reversión de 0034: ahora ABORTA con SQLSTATE 55000 si existen suscripciones fijadas a revisiones SUPERSEDED. El esquema anterior no conserva derechos por revisión. Test de migración actualizado para exigir aborto sin escritura y migración explícita en BD desechable antes del rollback.
5. Preflights G-MIG: scripts/plan-catalog-gmig-preflight.sql y scripts/plan-catalog-rollback-preflight.sql, ambos READ ONLY.
6. Reversión de 0035: scripts/plan-catalog-hardening-rollback.sql; ejecutar ANTES de intentar revertir 0034, con API/workers detenidos y respaldo.
7. Test de integración: doce intentos concurrentes de login y step-up desde dos instancias PlatformAuth que comparten PostgreSQL, verificando 5 rechazos 401 y siete 429, expiración e independencia de huellas.

## Secuencia exigida para cerrar los gates

**Fase A — revisión y pruebas, en BD desechable.** Revisión independiente de migración y seguridad con un modelo flagship de máxima capacidad y esfuerzo, sin Fable, sin modelos livianos, sin fallback. Documentar identidades y modelos efectivos de los revisores. Ejecutar npx tsc --noEmit, npm run test:unit, npm run test:integration, npm run test:smoke, E2E de autenticación y consola. Registrar comandos, resultados y SHA. Añadir prueba con múltiples procesos, interrupción de PostgreSQL, intentos simultáneos, rollback y anonimización. No reportar como PASS algo no ejecutado.

**Fase B — diagnóstico destino, sin cambios.** Probar restauración del backup. Ejecutar:
- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/plan-catalog-legacy-audit-preflight.sql
- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/plan-catalog-gmig-preflight.sql (solo antes de 0034)

Si hay IDs no cubiertos, inconsistencias de cuotas o nombres duplicados, detener el cambio. La limpieza no debe ampliar expresiones SQL por conjetura.

**Fase C — reparación R1 con autorización explícita.** Parar escritores, respaldar, correr preflight y confirmar N. Solo un DBA con permisos de DDL ejecutará:
- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v APPLY=1 -v EXPECTED_ROWS=N -f scripts/plan-catalog-legacy-audit-repair.sql

Repetir diagnóstico, auditar el resultado y ensayar la anonimización de un negocio sintético representativo. No ejecutar automáticamente.

**Fase D — despliegue futuro, aún bloqueado.** Coordinar 0034→0035 con el código compatible; el código previo usa plan_limit, el nuevo usa plan_revision y platform_auth_attempt_gate. Todas las instancias deben compartir PLATFORM_JWT_SECRET. Verificar la configuración de IP confiable en el proxy. Para revertir, con escritores detenidos ejecutar el rollback 0035 y luego evaluar el de 0034, que abortará si hay clientes en revisiones anteriores. No migrar clientes solo para facilitar rollback sin decisión humana.

## Riesgos y pendientes

- R1: reparación preparada pero NO ejecutada.
- R4: no se garantiza detectar nombres, slugs o subdominios en campos libres. Exige una solución estructurada o control de retención adicional; sigue abierto.
- R6: control global implementado y prueba escrita, aún sin ejecución; requiere validar configuración multiinstancia.
- R3: previsualización masiva sin paginación, abierto.
- R5: SQL directo puede provocar deadlock 40P01, abierto.
- R7: navegación por teclado y focus trap de la consola, abierto.
- AC07: workers y contratos de IA todavía fuera del catálogo, parcial.
- AC12: en este incremento NO se ejecutaron subagentes; la revisión independiente deberá respetar la política de modelos y dejar evidencia.

## Evidencia en esta ejecución

Se leyó y modificó GitHub mediante conector. Git por HTTPS no pudo resolver github.com desde el contenedor, de modo que NO se ejecutaron tsc, unitarias, integración ni E2E, y NO se tocó una BD local. Los resultados previos 185/185, 220/220 y 5/5 son del PR #13 ANTES de estas modificaciones. No los usar para acreditar este hardening.

**G-MIG PENDING. G-SEC PENDING. NO-GO producción.**
