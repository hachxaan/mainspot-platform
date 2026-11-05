# HANDOFF — MainSpot / Política comercial y ciclo local

Fecha: 2026-11-05. Estado: **preparación documental, no implementación ni despliegue**.

## Fuentes y estado real
- Registro de acuerdos: [SRC-005](https://github.com/hachxaan/mainspot-documentation/blob/docs/commercial-governance-20261105/sources/normalized/SRC-005-commercial-voice-decisions-2026-11-05.md).
- [Patch en staging](https://github.com/hachxaan/mainspot-documentation/blob/docs/commercial-governance-20261105/docs/staging/PATCH-2026-11-05-commercial-closure.md). El staging documental **no es canon publicado**.
- [PR #13](https://github.com/hachxaan/mainspot-platform/pull/13): catálogo de planes, `feat/plan-policy-catalog-impl-20261104`, SHA `b1cd3df`, draft.
- [PR #14](https://github.com/hachxaan/mainspot-platform/pull/14): endurecimiento G-MIG/G-SEC, rama `fix/plan-catalog-gates-hardening-20261104`, SHA observado `f68746b`, draft apilado sobre #13. **Producción NO-GO** por bloqueos y aprobaciones pendientes.
- La plataforma dispone de canon `.canonflow` con DEC-0075; el repositorio documental mantiene canon 0.0.0/INITIALIZED. **Reconciliar autoridad, versiones y decisiones** antes de promover cambios.

## Objetivo del agente local
Convertir los acuerdos comerciales **ACTUAL** en especificación trazable y, tras reconciliación canónica, implementar únicamente diferencias mínimas comprobadas. No abrir otro ciclo de exploración ni rehacer código probado. Producir evidencia reproducible; jamás declarar que un documento en staging es autorización de producción.

## Decisiones funcionales aprobadas
1. Recibir/sincronizar reseñas y responder manualmente **no consumen cuota de respuestas IA**. Cada respuesta generada con IA consume una unidad mensual. Agotar IA no detiene recepción ni respuesta manual.
2. Cuotas iguales por plan, independientemente del giro. Número de planes comerciales iniciales sujeto a investigación; nombres, precios y cantidades no aprobados.
3. Ciclos individuales desde la activación con periodo vigente. Cuotas mensuales **no acumulables**.
4. Sin excedentes ni cargos automáticos por defecto; avisar límite y ofrecer opciones realmente disponibles.
5. Upgrade tras pago, downgrade próximo ciclo. Sin reiniciar uso. Upgrade a medio ciclo: **prorratear precio adicional y capacidad incremental**.
6. Impago: siete días naturales de gracia con sitio publicado, panel y operación manual disponibles, pero IA suspendida y sin generar nuevas cuotas; después suspender y despublicar reversiblemente. Mantener datos 60 días. Avisos en plataforma, correo y Telegram según canal disponible.
7. Cancelación voluntaria libre al final del periodo pagado, sin nueva renovación; 60 días de recuperación posterior, con exportación, **importación**, reactivación y posibilidad de eliminación anticipada bajo obligaciones legales.
8. Reactivación sin penalización, sin regalar cuotas ni duplicar cobros de tiempo ya pagado.
9. Demo/trial limitado sin tarjeta ni cobros automáticos ni publicación real antes de contratar. Duración, límites y precios siguen abiertos.

## Incompatibilidad crítica a analizar
`docs/architecture/plan-catalog.md` declara seis capacidades acumuladas: `website`, `social_posts`, `social_ads`, `reviews_managed`, `conversations`, `agents`. `reviews_managed` se aplica en sincronización. **No equivale a respuestas con IA**. Investigar punto de enforcement, revisar si se requiere parámetro nuevo, migración y revisión de planes. No cambiar semántica heredada por inferencia. El mecanismo de cuotas periódicas existe, pero está sin activar en planes reales.

## Ruta de trabajo
**F0 Diagnóstico sin cambios.** Leer PR #13/#14, DEC-0075, HDC-MSP-06, Q-004, DEC-0018, SRC-005 y patch. Confirmar HEAD, revisar código, permisos, contratos y tests reales. Clasificar cada requisito `IMPLEMENTED / PARTIAL / OPEN / BLOCKED`.

**F1 Reconciliación.** Resolver autoridad documental, formalizar unidades de consumo, ciclos, transiciones y criterios de aceptación del incremento mínimo. Si una fórmula comercial o proveedor externo no está definido, separar solo ese punto.

**F2 Implementación local acotada.** Crear rama a partir de HEAD verificado; no tocar otros PR ni `master`. Reutilizar catálogo versionado, ledger e idempotencia; cambios aditivos y reversibles donde proceda. No crear precios ni cobros automáticos.

**F3 Verificación y cierre.** Typecheck, pruebas unitarias, integración con BD desechable, smoke y navegador E2E en `https://app.mainspot.local.io`. Registrar SHA, comandos, resultados, rutas, pruebas fallidas, riesgos y estados diferenciados. No repetir bootstrap LXC/TLS/hosts/WireGuard sin fallo observable.

## Matriz mínima de aceptación
- **AC01** N reseñas recibidas no consumen cuota IA, incluso al llegar a cero.
- **AC02** Respuesta manual libre y respuesta IA consume exactamente una unidad.
- **AC03** Replay y concurrencia no descuentan doble ni sobrepasan el límite.
- **AC04** Ciclo mensual propio, renovaciones no acumulables y activación dependiente de pago.
- **AC05** Al agotar IA, se bloquea solamente esa operación, sin cargo implícito.
- **AC06** Upgrade conserva uso y prorratea doble; downgrade diferido.
- **AC07** Gracia de siete días y despublicación reversible posteriores; operaciones manuales siguen autorizadas durante gracia.
- **AC08** Cancelación, retención de 60 días, reactivación, import/export y borrado sujetos a política y ley, con aislamiento entre negocios.
- **AC09** Avisos en los canales aprobados; reportar entrega no verificada en vez de inventarla.
- **AC10** Trial sin tarjeta, sin publicación real y con límites verificables.
- **AC11** Ningún cambio involuntario en PR #13/#14, permisos ni producción.

No se fijan fórmulas de redondeo, precios, unidades, umbrales 80/100 o cobros reales. Estos son puntos abiertos, no autorización para elegir valores arbitrariamente.

## Fuera del ciclo de cierre comercial
**FUTURO MANDATORIO para próxima ronda de producto:** instrucciones por **audio en Telegram** con transcripción, manejo de ambigüedad, confirmaciones sensibles y la misma gobernanza que texto. Otros futuros: imagen/caption de publicación en Telegram, captura web desde preview real, addons puntuales/recurrentes, recomendaciones, recargas automáticas prepagadas opt-in y limitadas, WhatsApp y chatbot web. No desarrollarlos anticipadamente durante este cierre.

## Entrega
Emitir matriz requisito → evidencia en código → delta → tests → gates, contrato actualizado, commits/PR y conclusión **GO/NO-GO para entorno local** separada de **NO-GO producción**, conservando bloqueos externos y aprobaciones humanas pendientes.
