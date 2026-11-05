# Bootstrap de revisión independiente — PR #14 (G-MIG / G-SEC)

Mandato: revisión crítica, adversarial y REPRODUCIBLE de hachxaan/mainspot-platform PR #14 (fix/plan-catalog-gates-hardening-20261104), basado en PR #13 (feat/plan-policy-catalog-impl-20261104). No desplegar ni modificar datos reales.

## Política de modelos — obligatoria
- Modelo principal y TODOS los revisores/subagentes: únicamente flagship de máxima capacidad de razonamiento y esfuerzo disponible, con model ID efectivo verificado.
- Prohibidos Fable, Haiku, Flash, mini, nano, fast, modelos económicos y sustituciones/fallback automáticos. Verificar también funciones auxiliares del arnés.
- Si no puede demostrarse la identidad del modelo en una delegación, no delegar; si no puede garantizarse la calidad del principal, reportar BLOCKED.
- Registrar evidencia de modelos efectivos y esfuerzo; nunca simular revisión independiente.

## Trabajo

1. Leer el PR #13, su canon DEC-0075 y evidence/plan-catalog/CIERRE.md. Leer completamente docs/architecture/plan-catalog-gates-hardening.md y todos los archivos modificados por PR #14.
2. Analizar migración 0035 y src/platform/auth.ts para serialización transaccional de intentos; concurrencia de 2 o más PROCESOS reales y de 12+ peticiones; login y TOTP; invalidez/caducidad de códigos; éxito que limpia la ventana; errores de DB; ataques distribuibles por IP/usuario; filtración de PII; replay, exclusión y recuperación tras reinicio.
3. Ejecución real con PostgreSQL descartable: npx tsc --noEmit, npm run test:unit, npm run test:integration, npm run test:smoke y E2E relevantes. Registrar comandos, códigos, versiones, logs y SHA. No llamar PASS al test nuevo si solo se inspeccionó el texto.
4. G-MIG: ensayar 0034 seguida de 0035 en BD con datos realistas, check de idempotencia, restore, reversión 0035 y reversión 0034. Intentar rollback de 0034 con suscripciones fijadas a SUPERSEDED: DEBE ABORTAR sin cambiar datos. Verificar bloqueo con migraciones posteriores y capacidad desconocida.
5. R1/G-SEC: auditar el uso de psql -v APPLY y EXPECTED_ROWS. En BD sintética insertar denegaciones legacy con resource /api/platform/tenants/client_X/plan y otras filas con IDs en actor, reason o result. El preflight debe listar recuentos SIN IDs, repair debe negarse cuando haya casos fuera de contrato, y con autorización explícita reparar solo rutas permitidas. Verificar que event_id, actor, at, action, decision y result se conservan; que el trigger queda habilitado; y que la anonimización E2E vuelve a funcionar. No reparar jamás una base real como parte de la prueba.
6. Evaluar límites del enfoque: nombres comerciales, logins, slugs y subdominios en motivos; referencias de usuarios en otras columnas; el límite que aplica por login+IP; rotación del secreto HMAC; retención del gate; evolución multiinstancia. Mantener hallazgos abiertos si no hay prueba.
7. Comprobar que PR #14 no rompe permisos plans.read/edit/publish, subscriptions.assign, tenants.read, step-up, la aplicación ni CanonFlow; ningún precio/paquete nuevo, ninguna publicación de negocio sin autorización, ningún cambio de cuotas existente.
8. Emitir informe de revisión independiente con severidad, file:line, reproducciones y pruebas. Diferenciar hechos, inferencias y riesgos. Corregir en commits acotados sobre la rama solo si el propietario autorizó la implementación; no autoaprobar G-MIG ni G-SEC.
9. Gate: PASS solo si no quedan bloqueadores verificados, la suite se ejecutó y los requisitos externos (backup/restauración, datos legacy reales, firma humana y ventana de despliegue) están satisfechos. De lo contrario BLOCKED y NO-GO producción.

## Criterio final

Entregar enlace al PR, SHA de revisión, informe de calidad independiente y matriz explícita G-MIG / G-SEC. El resultado del PR #13 no sustituye las pruebas de PR #14. El agente no puede decir que el despliegue o una aprobación humana ocurrieron si no tiene evidencia.
