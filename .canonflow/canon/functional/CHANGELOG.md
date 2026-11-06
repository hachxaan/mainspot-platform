# Functional Canon changelog

## 0.8.0 — 2026-11-06
- FR-0008, FR-0010, FR-0016, BR-0007 y NFR-0006 cambian y se crean FR-0020 y FR-0021 por DEC-0077 (directiva humana
  externa SRC-0017, que enumera con palabras del propietario las siete decisiones que confirmó en SRC-0016, copia byte
  a byte de SRC-006 del repositorio documental cuya única expresión literal es «Adelante»; no nueva respuesta HDC).
  Registro P1 sin QS/ANS ni APR, con el contador `dec` y su instantánea, como DEC-0073…DEC-0076.
- Precedencias: las interpretaciones G-SEM 1–5 de DEC-0076 quedan confirmadas (R1–R5); DEC-0018 prevalece para el
  Trial administrativo y C14 solo rige la demostración pública (FR-0021); DEC-0077 prevalece sobre DEC-0024/DEC-0027
  solo en el plazo (de 30 a 60 días) de la cancelación con fin efectivo del servicio y de la suspensión por impago tras
  la gracia (enlaces `SUPERSEDES` parciales); DEC-0024/DEC-0027 siguen rigiendo la anonimización verificable, la
  exportación previa, la ejecución auditada, los respaldos y la baja confirmada fuera de esos estados.
- FR-0016: SEC-CONSENT-01 (AC-16003 exige el consentimiento en la versión vigente; AC-16007, AC-16008),
  SEC-TG-APPROVAL-01 (AC-16009, AC-16010: `/aprobar <código> N` publica solo la opción del aviso y cualquier cambio
  posterior lo invalida; sustituye a `/aprobar <caso> N`; el aviso separa lo que escribe MainSpot del texto de terceros
  y el panel aprueba el texto visible o la propuesta de la revisión vista) y Facebook fuera de la cuota, con el gasto acotado por el
  presupuesto técnico y la publicación automática por el máximo por hora (AC-16011). AC-16004 aclarado por R2: la
  propuesta con IA queda aparte de las numeradas, también cuando la redacción de una respuesta automática pide revisión
  humana (la unidad se libera). La purga de contenido de Google vacía también las opciones de los avisos.
- BR-0007 (0.6.0 → 0.8.0): reconsentimiento versionado (versión mostrada, huella, actor, auditoría) antes de que una
  regla automática gaste unidades con IA; sin aceptación, solo la alternativa segura ya autorizada.
- NFR-0006 (0.5.0 → 0.8.0): Facebook y laboratorio fuera de las cuotas comerciales y nunca ilimitados (AC-6004,
  AC-6005); salvaguardas derivadas, no decisiones nuevas: sin techo configurado no hay gasto de pago y el laboratorio
  nunca se habilita con `APP_ENV=production` (AC-6006).
- FR-0008 y FR-0010: recepción sin límite comercial confirmada (`reviews_managed` solo métrica); C14 y C10/C12
  arbitrados con remisión a FR-0021 y FR-0020. Sin ACs nuevos: el comportamiento de cuotas de 0.7.0 no cambia.
- FR-0020 (nuevo): recuperación de 60 días tras cancelación o suspensión por impago; AC-20001…20006, todos BLOCKED por
  G-LEGAL o G-PAY salvo AC-20003 (baja confirmada fuera de esos estados, vigente). FR-0021 (nuevo): demostración
  pública separada del Trial administrativo; AC-21001…21003; duración, volumen y antiabuso OPEN.
- No decide cuotas numéricas, nombres, precios, proveedor de pago, prorrateo, umbrales de aviso, límites de la
  demostración, cobros, despliegue, firmas G-MIG/G-SEC ni migraciones reales; la voz por Telegram sigue obligatoria
  para la siguiente ronda de producto. Los registros DEC/APR, QS/ANS y SRC previos se conservan byte a byte. El canon
  técnico no cambia: no tiene ítem para el modelo del agente de atención (consentimientos, avisos de Telegram), que la
  migración 0037 amplía como la 0036 en 0.7.0; su diseño se documenta en
  `docs/architecture/commercial-governance-safeguards.md`. Ningún ítem tocado tenía la sangría YAML defectuosa.

## 0.7.0 — 2026-11-05
- FR-0010, FR-0016 y FR-0008 cambian por DEC-0076 (directiva humana externa SRC-0015 que adopta las decisiones
  comerciales C01–C14 del extracto SRC-0014, SRC-005 del repositorio documental; no nueva respuesta HDC ni
  sustitución de decisiones; G-SOURCE abierto porque el extracto no es literal).
- FR-0010: parámetro periódico nuevo `quota.ai_review_replies.max` (respuestas a reseñas redactadas con IA por ciclo
  mensual anclado al inicio de la suscripción, UTC, sin acumulación; sugerido 0 sin confirmar; ausente ⇒ deny);
  `reviews_managed` sin enforcement (recibir reseñas no consume ni se limita); AC-10006 reformulado y AC-10009…10012.
  Registro de parámetros 2 (migración 0036, reversible solo sin valores ni consumo de la capacidad nueva).
- FR-0016: la redacción con IA de respuestas a reseñas consume 1 unidad (reserva antes de invocar, commit con el
  caso, como máximo 1 por caso); las reseñas que esperan decisión ya no llevan propuesta de IA automática («Redactar
  con IA» a pedido); la respuesta automática autorizada consume 1 o usa el texto seguro sin IA; AC-16003 ajustado y
  AC-16004…16006. Facebook y el laboratorio quedan fuera de la cuota (pendiente de confirmación).
- FR-0008: recepción y respuesta manual sin cuota (AC-8001); se corrige la sangría YAML del segundo enlace.
- Completa la parte semántica de HDC-MSP-06 (ciclo, rollover, excedentes, reglas de cambio de plan). No decide precios,
  nombres, paquetes ni cantidades (Q-004, DEC-0010). C07–C14 quedan registradas sin implementar (pago, prorrateo,
  gracia, cancelación, retención de 60 días, prueba gratuita), con dos conflictos para arbitraje humano: C14 frente a
  DEC-0018 y C10/C12 frente a DEC-0024/DEC-0027. Los registros DEC/APR, QS/ANS y SRC previos se conservan byte a
  byte; el canon técnico no cambia.

## 0.6.0 — 2026-11-04
- BR-0007, FR-0010, FR-0018 y FR-0019 cambian por DEC-0075 (directiva humana externa SRC-0013: respuestas del
  propietario a siete preguntas del agente en conversación OMP; no nueva respuesta HDC ni sustitución de decisiones):
  catálogo de planes versionado en la sección Planes de Engineering con `plans.read`/`plans.edit`/`plans.publish`
  (publicar, rollback y habilitar/deshabilitar con step-up y motivo); asignar planes y migrar suscripciones solo
  `platform_admin` (autoridad de Administration); la autoasignación del negocio se retira (403) y su panel queda en
  solo lectura.
- FR-0010: revisiones inmutables, confirmación explícita de cada valor, publicar = configuración operativa sin
  aprobación comercial, suscripción fijada a su revisión con migración explícita y vista previa, ausencia ⇒ deny,
  mecanismo periódico sin activar hasta HDC-MSP-06, y bajar un límite efectivo nunca borra recursos.
  Ningún parámetro nuevo; los planes existentes pasan a la revisión 1 con sus valores vigentes.
- FR-0019 (AC-19011): salvaguarda de mínimo privilegio derivada de BR-0007, no decisión nueva: en Planes, los
  nombres de los negocios y la vista previa de migración exigen `tenants.read` (`platform_admin`,
  `platform_support`); el `ai_engineer` ve solo recuentos por revisión.
- FR-0019: cambiar nombre o descripción de un plan exige `plans.publish` + step-up, igual que publicar, porque los
  negocios lo ven al instante. Es una aplicación de «publicar = configuración operativa» (DEC-0075), no una decisión nueva.
- No decide precios, nombres ni paquetes comerciales (Q-004, DEC-0010), ciclo/rollover/excedentes/cambios de plan
  (HDC-MSP-06), Trial (DEC-0018, pendiente de implementación) ni `agents` (DEC-0006/DEC-0017). Se conservan byte a
  byte los registros DEC/APR, QS/ANS y SRC previos; el canon técnico no cambia. En FR-0010 se corrige además la
  sangría del segundo enlace del front matter (YAML válido), sin cambio de contenido.

## 0.5.0 — 2026-11-03
- FR-0012, FR-0019, NFR-0006 y BR-0007 cambian por DEC-0074 (directiva humana externa SRC-0012, no nueva
  respuesta HDC; sustituye solo la asignación generativa de desarrollo de DEC-0073, que se conserva como historia):
  Anthropic directo para texto/razonamiento, OpenAI directo solo imágenes, Jev primario; ambos adaptadores sin
  fallback; OpenRouter deshabilitado. No decide proveedor comercial de producción.
- Ejecución de rutas DRAFT solo en laboratorio con grant explícito (emisor con step-up, tenant+usuario, allowlist
  de rutas, caducidad, revocación, auditoría, presupuestos vigentes). Aceptación manual del propietario con
  evidencia real por invocación y checklist marca DRAFT→TESTED en un registro propio, distinto de la suite;
  aprobar y activar siguen separados; producción exige suite PASS. El agente no ejecuta pruebas generativas.
- Se conservan byte a byte QS/ANS-0017, DEC-0066..0073, SRC-0011 y el artefacto aprobado. Presupuestos,
  permisos y gates no se relajan; créditos declarados por el propietario no se registran como verificados.

## 0.4.0 — 2026-11-03
- Solo BR-0007 cambia por DEC-0073 (directiva humana externa SRC-0011, no nueva respuesta HDC):
  OpenAI directo para todo texto/imágenes en DESARROLLO, Jev primario; Anthropic técnico no operativo
  sin rutas activas/canary ni fallback; OpenRouter deshabilitado. No decide proveedor comercial de producción.
- Se conservan byte a byte los registros QS/ANS-0017, DEC-0066..0072 y el artefacto aprobado.
  Los restantes items mantienen su versión; presupuestos, permisos y gates no se relajan.

## 0.3.0 — 2026-11-03
- AI Core aprobado: FR-0012..FR-0019, NFR-0006..NFR-0008 y BR-0007 pasan a DECIDED por APR-0003 (QS-0017/ANS-0017;
  canon 0.2.0 ligado por sha256 en el artefacto aprobado). Se incorporan las decisiones de la misma sesión sin
  alterar registros previos: DEC-0066 (Jev primario en todo texto; FR-0012 AC-12001), DEC-0067 (datos reales hacia
  TypeSafe tras verificar la cobertura una vez; sustituye a DEC-0019; FR-0012 AC-12002, BR-0007), DEC-0071 (mismas
  condiciones para Anthropic y OpenAI; BR-0007), DEC-0069 (solo proveedores directos, OpenRouter retirado; BR-0007),
  DEC-0068 (USD 25 acumulado incluido el historial; procedencia del costo; NFR-0006).

## 0.2.0-proposed — 2026-10-30
- AI Core (issue #9): FR-0012..FR-0019, NFR-0006..NFR-0008 y BR-0007 en estado PROPOSED. Fuente: definición
  del propietario en issue #9 y handoff `docs/handoffs/mainspot-ai-core-2026-10-30/`. Aprobación pedida en QS-0016.
  No modifica ítems DECIDED/INFERRED previos ni registros de decisión.
