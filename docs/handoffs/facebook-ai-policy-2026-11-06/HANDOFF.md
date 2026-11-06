# MainSpot — Handoff de política de sugerencias Facebook (FB-1/2/3, TS-1)

**Fecha:** 2026-11-06. **Estado:** reglas aprobadas por el propietario, **implementación pendiente**. Este documento no es una nueva DEC canónica, no acredita ejecución ni modifica aplicación.

## Autoridad y dependencia
- Propietario: [SRC-007](https://github.com/hachxaan/mainspot-documentation/blob/docs/facebook-ai-approval-20261106/sources/normalized/SRC-007-facebook-ai-owner-approval-2026-11-06.md).
- [Resolución staged](https://github.com/hachxaan/mainspot-documentation/blob/docs/facebook-ai-approval-20261106/docs/staging/RESOLUTION-2026-11-06-facebook-ai-policy.md).
- Código base: [PR #18](https://github.com/hachxaan/mainspot-platform/pull/18) (HEAD verificado al preparar este handoff: 7bbea3d); cadena anterior #17 → #16 → #15 → #14 → #13. Confirmar HEAD al iniciar, no sobrescribir trabajo local ajeno.
- Canon vigente: DEC-0077, en el PR #18. Promover la nueva confirmación mediante registro DEC posterior y delta de FR/AC sin alterar registros anteriores.
- Reglas OMP existentes, presupuestos IA, seguridad multitenant, SEC-CONSENT-01, SEC-TG-APPROVAL-01 y decisiones de proveedores siguen vigentes.

## Definiciones comerciales aprobadas

**FB-1 — Tres modalidades por negocio.** (1) DESACTIVADO: no preparar sugerencias IA; siempre puede escribir manualmente. (2) BAJO_DEMANDA: predeterminado para nuevas configuraciones; IA solo por petición explícita. (3) AUTO_SUGERENCIAS: opt-in informado; preparar sugerencias para comentarios elegibles, para revisión humana, sin que el usuario pulse «generar» cada vez. La aceptación debe explicar que generar puede descontar créditos aunque no se publique, mostrar estado/límite y permitir apagar. No cambiar políticas heredadas silenciosamente.

**Diferencia fundamental:** generar propuesta no es publicar. Las respuestas automáticas que sí se publican utilizan otro permiso y otra política; configurar AUTO_SUGERENCIAS jamás concede ese permiso. Si ambos flujos están autorizados, deduplicar por comentario/tarea para no generar/cobrar dos veces.

**FB-2 — Evitar generación inútil.** Antes de generar para **publicación automática**, comprobar habilitación, condición de política y límite horario de publicación. Si no podrá publicarse, no invocar el modelo para ese objetivo. AUTO_SUGERENCIAS puede seguir generando contenido revisable dentro del límite propio y presupuesto, incluso si no cabe una publicación automática, pero no publicar sin aprobación. Evaluar spam, duplicados y elegibilidad antes de gastar.

**FB-3 — Presupuestos.** Conservar techo total estricto y presupuestos por negocio; atribuir consumo por canal/caso de uso y aislar el gasto experimental del laboratorio del presupuesto comercial operativo. Ambos permanecen bajo techo global. Controles fail-closed cuando faltan presupuestos. No imponer particiones fijas innecesarias entre canales sin observar costos reales. Cifras y límites de canal NO aprobados; no generarlos por inferencia.

**TS-1 — TypeSafe/Jev.** Aplicar reserva atómica idempotente previa a invocación, confirmación del consumo al resultado, liberación/reconciliación de reservas, protección ante proceso caído y pruebas de concurrencia/TOCTOU. Diseñar según unidades y facturación real del proveedor, no asumir que un error del proveedor es siempre gratuito.

## Conflictos, fronteras y condiciones para habilitar

1. Facebook no consume quota.ai_review_replies.max, **que aplica a reseñas Google**. Definir formalmente la unidad/comportamiento de créditos comercial de Facebook antes de activar descuentos o vender capacidad; NO se aprobaron cantidades, precios, reposiciones ni cuotas por plan. No activar sugerencias automáticas pagadas si esa semántica no está cerrada. Avanzar independientemente con modos, consentimiento y controles técnicos, reportando el bloqueo específico.
2. SEC-CONSENT-01 exige versión/huella y consentimiento cuando cambia el costo; no registrar aceptación tácita. Mantener autorización independiente de auto-publicación.
3. SEC-TG-APPROVAL-01: opciones numeradas deben atarse al código/versión exactos del aviso. Dos commits locales ajenos a la cadena (0cf90bf, 2f91053) utilizan aprobación por índice: analizar/adaptar antes de combinar.
4. No existe aún entorno IA productivo con techo decidido. No usar lab para producción ni llamar proveedores reales sin autorización.
5. No se modifican los 60 días de retención, trial público, pagos ni roadmap de voz Telegram durante este incremento.

## Aceptación mínima del ciclo local

- **AC-FB01** Modo off: cero invocaciones generativas automáticas para sugerencias. La recepción/manual funciona.
- **AC-FB02** Modo on_demand: llegada de comentario sin generación; petición explícita genera una propuesta bajo permisos, presupuesto y política.
- **AC-FB03** Modo auto_suggest_opt_in: consentimiento previo, genera sugerencia para comentario elegible sin pulsar, para REVISIÓN; sin autorización de publicar, no publica.
- **AC-FB04** Texto y costo informados antes de opt-in; modo configurable/desactivable. Si la cuota/crédito o presupuesto no existe, denegar invocaciones de pago y explicar sin ofrecer consumo ilimitado.
- **AC-FB05** Reintentos, webhook replay, concurrencia, duplicados y cambios de modo no generan doble cobro ni publicación ajena; aislado por tenant.
- **AC-FB06** Cuando publicación automática está limitada por hora, no generar para su publicación; cuando auto_suggest_opt_in está vigente, se permite sugerencia revisable con límites independientes.
- **AC-FB07** Presupuesto global + tenant efectivo en concurrencia; etiquetar costos por canal, laboratorio segregado y contabilizado bajo techo global.
- **AC-TS01** Con dos unidades libres y 4 llamadas paralelas, máximo 2 reservas activas; confirmación, expiración y rollback ante fallo y caída.
- **AC-FB08** Aviso/Telegram vincula aprobación al texto mostrado; integración con commits ajenos identificada y resuelta antes de fusionar. No publicación externa durante tests.
- **AC-FB09** Documento canónico y pruebas trazables con estados IMPLEMENTED/BLOCKED/OPEN y GO local separado de NO-GO producción.

## Plan de ejecución local
F0 verificar estado fresco de PR #13–#18 y worktrees, leer DEC-0077, SOURCE y arquitectura Facebook; trazar rutas de generación, automática/solicitada, presupuestos y TypeSafe. F1 crear decisión canónica posterior, FR/AC y modelo de estados compatible. F2 implementar solo cambio seguro y autorizado en rama apilada, sin fijar cuotas/precios. F3 ejecutar tsc, unitarias, integración PG desechable, smoke, navegador E2E por HTTPS local, sondas adversariales e inspección de costo/consentimiento/Telegram. F4 revisión independiente, evidencia con SHA y gates diferenciados.

**Límites:** nunca modificar PR históricos, master, producción, BD reales, proveedores, DNS, secretos ni migraciones reales; no aprobar G-MIG/G-SEC ni desplegar. Si falta el contrato monetario, cerrar el delta técnico posible y marcar únicamente la activación comercial como BLOCKED.
