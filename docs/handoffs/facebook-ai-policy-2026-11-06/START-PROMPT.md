# Prompt de arranque OMP — Sugerencias Facebook y costos

**Modelo principal y subagentes:** Claude Opus 5.5, esfuerzo MAX para razonamiento, implementación y revisión independiente. No hacer fallback automático a modelos menores.

> MAINSPOT / CICLO LOCAL FB AI POLICY 2026-11-06
>
> Objetivo: cerrar la ejecución local de la política de Facebook aprobada por el propietario (FB-1/FB-2/FB-3) y la protección de concurrencia TypeSafe (TS-1). No desplegar en producción.
>
> Lee primero y por completo:
> - .omp/AGENTS.md y reglas vigentes;
> - docs/handoffs/facebook-ai-policy-2026-11-06/HANDOFF.md en la rama docs/facebook-ai-policy-20261106;
> - SRC-007 y RESOLUTION-2026-11-06-facebook-ai-policy.md en hachxaan/mainspot-documentation rama docs/facebook-ai-approval-20261106;
> - PR #18 y documentación DEC-0077 / safeguards, luego la cadena #17 → #13.
>
> Inspecciona HEAD, worktrees y commits ajenos antes de trabajar. Formaliza decisión canónica trazable posterior a DEC-0077 con precedencia explícita sin reescribir historia.
>
> Implementa tres modos de GENERACIÓN DE SUGERENCIAS, no de publicación: IA desactivada, bajo demanda (default) y sugerencias automáticas opt-in para REVISIÓN humana. Mantén publicación automática como permiso separado. Las sugerencias automáticas tienen costo informado y límite técnico; no se ejecutan sin consentimiento/budget. Controla replays, duplicados, carreras, comentarios poco relevantes y aislación de tenants.
>
> FB-2: antes de gastar para publicación automática, comprueba elegibilidad y límite de publicaciones. No gastar para publicar si ya no se puede. Una sugerencia automática opt-in para revisión sí puede generarse con presupuesto aunque auto-publicación esté limitada, pero nunca publica por sí sola.
>
> FB-3: techo global y por tenant, atribución por canal y laboratorio segregado sin eludir el techo global; sin presupuestos, fail-closed. No inventes números o particiones fijas de canal sin aprobación.
>
> TS-1: usa patrón de reservas atómicas e idempotentes antes de TypeSafe/Jev; commit/release/reconcile ante fallo; verifica concurrencia y contratos de medición del proveedor.
>
> IMPORTANTE: Facebook no consume actualmente cuota de IA Google. Aún NO existe cifra/crédito comercial aprobado para sugerencias Facebook. Diseña contrato extensible sin cobrar ni activar un valor inventado; bloquea solo activación de cobro si depende de decisión económica, no toda la implementación independiente.
>
> Compatibiliza consentimiento informado de SEC-CONSENT-01, aprobación vinculada al aviso de SEC-TG-APPROVAL-01 y los commits locales 0cf90bf/2f91053 antes de combinarlos. No ejecutes proveedores reales, pagos, migraciones en BD reales ni despliegues.
>
> Prueba con PostgreSQL descartable, tsc, unitarias, integración, smoke, E2E HTTPS local y revisión adversarial independiente. Entrega matriz DEC/FR/AC→código→tests→gates, evidencia y commits/PR apilado. Distingue GO local de NO-GO producción.
>
> Trabaja autónomamente dentro del alcance; pregunta al propietario solo ante decisiones genuinamente bloqueantes. No reabras contratos o precios ya clasificados como pendientes.
