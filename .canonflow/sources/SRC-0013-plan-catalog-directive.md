# SRC-0013 — Directiva del propietario: catálogo de planes versionado

Origen: respuestas explícitas del propietario Carlos Pinacho en esta conversación OMP (2026-11-04) a siete
preguntas que formuló el agente con la herramienta `ask`. El texto de las preguntas y de las opciones es del
agente; cada RESPUESTA es la selección del propietario. En la respuesta 6, el paréntesis final es la anotación
del agente sobre el efecto de no seleccionar ninguna opción.
Registro: 2026-11-04T19:04:34Z. No procede de un nuevo QS/ANS ni altera sus respuestas históricas.
No sustituye ninguna decisión: DEC-0005, DEC-0006, DEC-0007, DEC-0010, DEC-0017, DEC-0018, DEC-0039,
SRC-0011/DEC-0073 y SRC-0012/DEC-0074 se conservan íntegros.
Contexto: handoff `docs/handoffs/plan-policy-catalog-2026-11-04/HANDOFF.md` (rama
`docs/handoff-plan-policy-catalog-20261104`), propuesta de implementación que no es una decisión canónica por sí
sola. Una octava pregunta de la misma conversación (`harness`, configuración del arnés OMP) no es de producto y
no se transcribe.

## Transcripción literal

Preguntas enviadas por el agente (herramienta `ask`) y respuestas del propietario:

1. id `authority` — «¿Quién mantiene el catálogo de planes y dónde? (modifica la matriz de roles de BR-0007)»
   - Opciones: «Ingeniería con permisos explícitos» (Pestaña Planes en /ingenieria. plans.read: ai_engineer, platform_admin, platform_support. plans.edit (crear/clonar/editar borrador/confirmar valores): ai_engineer, platform_admin. plans.publish (publicar, rollback, habilitar/deshabilitar; step-up + motivo): ai_engineer, platform_admin. Asignar planes a negocios sigue solo en /plataforma (platform_admin).) · «Igual, con cuatro ojos» (Como la anterior, pero quien publica no puede ser quien editó por última vez el borrador. Más seguro; con pocos operadores puede bloquear publicaciones.) · «Solo platform_admin» (platform_admin edita y publica; ai_engineer y soporte solo lectura. Contradice el handoff.)
   - RESPUESTA: **Ingeniería con permisos explícitos**
2. id `publish_meaning` — «¿Qué significa publicar una revisión de plan frente a Q-004 (DEC-0010: nombres, precios y límites comprometidos con clientes siguen pospuestos)?»
   - Opciones: «Configuración operativa» (Publicar aplica los límites al enforcement, pero no aprueba nombres, precios ni paquetes comerciales; cada plan muestra «Sin aprobación comercial» y sigue sin precio ni cobro.) · «Requiere DEC por publicación» (Toda publicación que cambie límites queda pendiente hasta una decisión explícita del propietario registrada en canon.)
   - RESPUESTA: **Configuración operativa**
3. id `revision_policy` — «Al publicar una revisión nueva de un plan, ¿qué pasa con las suscripciones vigentes?»
   - Opciones: «Fijadas a su revisión» (Cada suscripción queda fijada a la revisión con la que se asignó; publicar no cambia a clientes vigentes. Migrarlas es una acción explícita con vista previa de afectados, step-up y motivo. Los tenants actuales quedan en la revisión 1 (valores actuales).) · «Siguen la publicada» (Las suscripciones usan siempre la revisión publicada; al publicar se muestra el impacto (negocios afectados y por encima del nuevo límite) y hay que reconocerlo.)
   - RESPUESTA: **Fijadas a su revisión**
4. id `periodic` — «Cuotas periódicas (DEC-0010 reserva ciclo, rollover y excedentes a HDC-MSP-06): ¿qué hago ahora?»
   - Opciones: «Mecanismo sin activar» (Implemento y pruebo el mecanismo periódico (ciclo mensual anclado al inicio de la suscripción, UTC, reserva/commit/liberación, sin rollover), pero ningún plan real lo usa hasta HDC-MSP-06. Las 6 capacidades conservan su semántica actual (acumulada).) · «Decidir ciclo ahora» (Ciclo mensual anclado al inicio de la suscripción, en UTC, sin rollover ni excedentes (al agotarse ⇒ 403). Disponible para parámetros nuevos; las 6 capacidades no cambian.)
   - RESPUESTA: **Mecanismo sin activar**
5. id `self_assign` — «Hoy el rol de negocio administration puede autoasignarse cualquier plan (POST /api/backoffice/subscriptions/assign). ¿Qué hago?»
   - Opciones: «Retirarla» (La ruta del negocio responde 403; asignar queda exclusivo de platform_admin en /plataforma con step-up, motivo e historial. El panel conserva plan y consumo en solo lectura. Ajusto los tests que la usan.) · «Mantener restringida» (Se conserva, pero solo hacia planes habilitados con revisión publicada y con historial.)
   - RESPUESTA: **Retirarla**
6. id `scope` (selección múltiple) — «¿Qué parámetros nuevos entran en este incremento? Todos con los valores vigentes actuales, sin beneficios nuevos.»
   - Opciones: «Biblioteca de medios» · «Elegibilidad de IA» · «Plan Trial (DEC-0018)» · «Techo de autorrespuestas»
   - RESPUESTA: **ninguna opción seleccionada** (selección vacía ⇒ ningún parámetro nuevo en este incremento).
7. id `registration` — «¿Cómo se registran tus respuestas en el canon?»
   - Opciones: «SRC + DEC» (Directiva explícita del propietario: SRC-0013 literal con sha256, DEC-0075 y deltas de BR-0007/FR-0010/FR-0018/FR-0019, mismo precedente que DEC-0073/DEC-0074.) · «Sesión HDC» (Preparo una sesión HDC (QS) y dejo el canon sin cambios hasta su ingesta; el código queda tras esas decisiones.)
   - RESPUESTA: **SRC + DEC**
