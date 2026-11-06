# Recuperación de 60 días tras cancelación o suspensión por impago — especificación para el gate legal

- **Naturaleza:** especificación técnica para la revisión legal y de privacidad (**G-LEGAL**). **No es una
  implementación ni una decisión**: no cambia código, plazos, ejecuciones ni datos. Lo marcado «Propuesta técnica»
  necesita la aprobación del propietario.
- **Estado:** FR-0020 **BLOCKED** por G-LEGAL y G-PAY (`.canonflow/canon/functional/items/FR-0020.md`).
- **Autoridad:** DEC-0077 R7 (`.canonflow/decision-records/DEC-0077.json`), con `SUPERSEDES` parcial de DEC-0024 y
  DEC-0027 solo en el plazo y su punto de partida para los estados cubiertos (`.canonflow/traceability/links.yaml:106-107`).
- **Citas:** `ruta:línea` sobre el commit `b809510` (base de la rama `feat/commercial-governance-safeguards-20261105`)
  para todo archivo que ya existía en él; los registros nuevos de este delta (SRC-0016, SRC-0017, DEC-0077, FR-0020,
  `links.yaml`) se citan en la rama. Los archivos que la rama ya modifica se escriben `ruta@b809510:línea`, y sus
  cambios se indican aparte. Lo no observado se marca **[INFERENCE]**.

## 1. Qué decide R7 y qué deja abierto

Palabras del propietario: «Conservación recuperable de 60 días tras finalización efectiva del servicio o suspensión,
con las excepciones legales correspondientes.» (`.canonflow/sources/SRC-0017-governance-security-cycle-directive.md:60`).
El alcance lo precisan la propuesta que el propietario aceptó con «Adelante» (`SRC-0016-owner-confirmation-2026-11-05.md:24`,
resumen contextual) y `docs/handoffs/commercial-policy-2026-11-05/OWNER-RESOLUTION.md:20`.

| Decidido (DEC-0077 R7) | Fuente |
|---|---|
| 60 días de recuperación de contenido y configuración desde el fin efectivo del servicio tras una cancelación, o desde la suspensión efectiva tras impago y gracia | `OWNER-RESOLUTION.md:20`; `SRC-0016…:24` |
| Pasado el plazo, eliminación o anonimización verificable según la clase de datos, salvo conservación legal justificada | `OWNER-RESOLUTION.md:20` |
| Enmienda acotada del plazo de 30 días de DEC-0024/DEC-0027 solo para esos estados | `OWNER-RESOLUTION.md:20`; resolución en staging `RES-MSP-20261105-SEM-01` (`hachxaan/mainspot-documentation@532f2c6`, `docs/staging/RESOLUTION-2026-11-05-commercial-sem-trial-retention.md:20`) |
| Antes de aplicarse: análisis de datos, proveedores y respaldos, y revisión legal | `OWNER-RESOLUTION.md:20`; staging `:20` («privacidad, proveedores y backups requieren gate legal y técnico») |
| Sin borrado irreversible ni extensión de plazos sin revisión legal | `OWNER-RESOLUTION.md:20`; `SRC-0016…:24` |
| Se mantienen la eliminación anticipada cuando proceda, la importación/exportación y la protección entre negocios | `OWNER-RESOLUTION.md:20` |
| No extender sin análisis otras clases de datos y finalidades | staging `:20` |

| Abierto (no lo decide R7) | Fuente |
|---|---|
| Formatos de exportación e importación | DEC-0076 C12 «formatos sin definir» (`.canonflow/decision-records/DEC-0076.md:33`) |
| Proveedor de pago, cobro, gracia efectiva y cancelación al fin del periodo pagado | DEC-0076 C09/C11 (`DEC-0076.md:30,32`); `DEC-0077.json` «No decide» |
| Avisos previos (canales y umbrales) y despublicación reversible | DEC-0076 C10 (`DEC-0076.md:31`); umbrales sin decidir (`docs/architecture/commercial-quota.md:88`) |
| Qué clases se eliminan, cuáles se anonimizan y qué excepciones legales aplican | Este documento, §8 |

Esta ronda solo especifica: «Retención 60 días: solo especificación y validación técnica/legal antes de tareas
irreversibles. Importación/exportación y respaldos requieren incremento propio.»
(`docs/handoffs/commercial-policy-2026-11-05/NEXT-LOCAL-ROUND.md:20`).

## 2. Estados cubiertos y disparadores

Estados que existen hoy:

- `client.status` ∈ {`active`, `suspended`, `exiting`, `anonymized`} (`migrations/0015_retention_policy.sql:51-53`);
  `subscription.status` ∈ {`active`, `suspended`, `cancelled`} (`migrations/0009_subscriptions_plans.sql:34`).
- Entrar exige `client.status = 'active'` (`src/identity/repository.ts:55,67,125`).
- La suspensión administrativa solo alterna `active`/`suspended`, con motivo y auditoría
  (`src/api/platform-routes.ts:141-152`).
- La baja confirmada (`RetentionService.confirmExit`, `src/retention/service.ts@b809510:303-336`) exige negocio
  `active` o `suspended` (`:308-310`), exporta antes (`:311-318`), registra `tenant_exit` con
  `anonymize_after = now() + exitGrace` (`:319-323`), deja el negocio `exiting` (`:324`), cancela la suscripción
  (`:326`) y audita `tenant.exit_confirmed` (`:328-332`). La base exige `anonymize_after >= confirmed_at + 30 días`
  (`migrations/0015_retention_policy.sql:55-62`).
- No hay estados de pago: `git grep -iE 'past_due|grace|unpaid|impago|period_end|paid_until|cancel_at' b809510 -- src`
  solo encuentra `ai_insight.period_end` (`src/ai/business.ts:309`) y `exitGrace` (el plazo de la baja,
  `src/retention/service.ts@b809510:40,323`); el pago es `SimulatedPaymentProvider`, «siempre ok»
  (`README.md:341`). Ningún código pasa un negocio de `exiting` a `active` (`exiting` solo aparece en
  `src/retention/service.ts@b809510:300,324`).

| Estado | Inicio de los 60 días | ¿Existe? | Régimen |
|---|---|---|---|
| Cancelación con fin efectivo del servicio | Fin del periodo pagado tras cancelar (C11: «efectiva al terminar el periodo pagado», `DEC-0076.json:6`) | **No**: sin periodo pagado, cobro ni cancelación por el negocio | DEC-0077 R7, **BLOCKED (G-PAY, G-LEGAL)** |
| Suspensión efectiva por impago tras la gracia | Fin de la gracia (C09: siete días, `DEC-0076.json:6`) | **No**: sin impago ni gracia | DEC-0077 R7, **BLOCKED (G-PAY, G-LEGAL)** |
| Baja confirmada por un operador fuera de esos estados | `confirmed_at` (+30 días) | Sí (`service.ts@b809510:303-336`) | DEC-0024/DEC-0027, sin cambio |
| Suspensión administrativa con motivo (FR-0018) | No inicia plazo | Sí (`platform-routes.ts:141-152`) | Lectura literal de R7: no es suspensión por impago |
| Vencimiento del Trial administrativo | No inicia plazo: «El vencimiento del Trial no constituye una baja» (`DEC-0027.md:41`) | Trial sin implementar (`FR-0010.md`, notas) | DEC-0018/DEC-0027 |

**Propuesta técnica (no decisión; requiere G-PAY y G-LEGAL).** Registrar por negocio el inicio de la ventana, su
causa (`cancellation` o `non_payment`), el estado comercial verificable que la originó y el fin calculado (inicio + 60
días), con auditoría en la misma transacción (NFR-0001). Mientras dure: sin acceso operativo, sitio despublicado de
forma reversible (C10), reactivación y exportación disponibles. Al vencer, la ejecución diaria (DEC-0025) aplica el
destino por clase aprobado en G-LEGAL con la verificación de §3.1. Reactivar dentro de la ventana la cierra sin
pérdida ni reinicio de cuotas (C13). Un negocio no puede estar a la vez en la ventana y en una baja de DEC-0024.

## 3. Inventario de clases de datos

### 3.1 Mecanismo actual (baja confirmada, 30 días)

La anonimización ocurre en una sola transacción por negocio (`src/retention/service.ts@b809510:354-417`):

1. Crea un cliente `anon_<uuid>` «Negocio anonimizado» (`:358-361`).
2. Re-etiqueta los agregados de analítica (`:362`); la auditoría del negocio con actores y `request_id` aleatorios,
   `resource` reducido a su tipo y `evidence_ref` nulo (`:363-375`); `ai_invocation` conserva costo y uso, sin
   contenido, actores, claves ni trazas (`:376-382`); la auditoría de plataforma, sin motivo ni `request_id`
   (`:383-388`).
3. Borra las filas de las tablas de `TENANT_TABLES` en orden de FK (`:390-395`; lista en `:57-120`), los tokens de
   recuperación de contraseña de logins no compartidos (`:396-399`) y el cliente (`:400`).
4. Registra la huella sha256 del id en `anonymized_tenant` (`:401-404`) y verifica, antes de confirmar, que ningún
   identificador fuerte aparece en ninguna columna de texto de la base y ningún nombre en lo conservado (`:413`,
   `:568-601`); si algo aparece, revierte. Hay ensayo con reversión obligatoria (`:338-352`;
   `scripts/anonymization-dry-run.ts`).

Pruebas existentes de ese camino: `tests/integration/retention.test.ts:195` (exportación, acceso retirado,
anonimización solo a los 30 días), `:251` (reversión si queda un identificador) y `:271` (restauración y registro).

### 3.2 Clases por tabla (estado en `b809510`)

Salvo indicación, las tablas son de `TENANT_TABLES` (`src/retention/service.ts@b809510:57-120`) y la anonimización las
**borra**. «Export» = `exportTenant` (`:513-527`), que excluye las columnas de `exportSkip` y aplica antes la purga
de Google (`:514-515`).

| Clase | Tablas (línea en `service.ts@b809510`) | Purga por plazo antes de la baja | Al anonimizar | Para G-LEGAL |
|---|---|---|---|---|
| A. Identidad y acceso del negocio | `client` (borrado `:400`), `internal_user` (`:115`, sin `password_hash` en export), `user_role` (`:114`), `session_context` (`:113`), `owner_invitation` (`:93`, sin `token_hash`), `telegram_link` (`:88`), `telegram_link_code` (`:87`, sin `code_hash`), `platform_support_access` (`:62`); `password_reset_token` (fuera de la lista; `:396-399`) | Tokens de contraseña vencidos, a 1 día (`:214`) | Borrado | ¿Qué conservar durante la ventana para reactivar sin conservar credenciales activas? |
| B. Contenido y configuración del negocio | `client_data` (`:116`), `tenant_context` (`:118`), `client_website` (`:108`), `client_domain` (`:107`), `website_content` (`:99`), `publication` (`:100`), `scheduled_post` (`:98`), `social_post` (`:104`), `approval` (`:101`), `preview_session` (`:102`), `demo_action` (`:117`), `business_contact` (`:96`), `integration_phone` (`:95`), `gbp_profile` (`:92`), `brand_profile` (`:73`), `brand_fact` (`:72`), `media_asset`/`media_variant` (`:70-71`, bytes fuera del JSON), `editorial_suggestion` (`:64`), `marketing_campaign` (`:65`), `ai_insight` (`:66`) | No | Borrado | Es lo que R7 llama «contenido y configuración»: núcleo de la ventana |
| C. Conversaciones con el asistente | `conversation_request` (`:106`), `action_proposal` (`:105`), `jev_classification` (`:97`) | Contenido redactado a los 90 días (DEC-0021; `:453-497`) | Borrado | ¿La ventana suspende o no la purga de 90 días? (propuesta: no la suspende, como hoy) |
| D. Contenido de terceros: reseñas y comentarios | `review` (`:103`), `engagement_case` (`:84`), `engagement_notification` (`:83`), `engagement_policy` (`:85`, texto del consentimiento), `engagement_cursor` (`:86`), `google_review_cursor` (`:79`), `provider_reply_ledger` (`:80`), `response_ledger` (`:63`); simulador `sim_provider_*` (`:89-91`) | Contenido real de Google a los 29 días (`src/google/retention.ts@b809510:24-28,82-116`); los comentarios de Facebook no tienen purga por plazo: la de Google filtra `origin = 'google_review'` (`:91-96`) y `purgeTenant` no toca `engagement_case` (`service.ts@b809510:453-497`) | Borrado | Datos de personas ajenas al negocio (reseñantes, comentaristas): ¿base y plazo durante la ventana? |
| E. Credenciales de conectores | `provider_connection` (`:78`, sin `token_box`/`token_key_id`), `provider_oauth_state` (`:77`, sin `state_hash`/`verifier_box`) | No | Borrado | ¿Revocar o borrar al iniciar la ventana en vez de al final? |
| F. Plan, suscripción y consumo | `subscription` (`:112`), `subscription_history` (`:111`), `quota_reservation` (`:109`), `ai_budget` (`:74`), `ai_job` (`:67`, sin `claim_token`), `ai_lab_grant`, `ai_lab_grant_route` (`:68-69`) | No | Borrado | Con cobro real (G-PAY), ¿obligación de conservar datos de facturación? |
| G. Registros que se conservan re-etiquetados | `audit_event` (2 años, DEC-0022), `analytics_daily_summary` (2 años, DEC-0023), `ai_invocation` (trazas a 90 días, `:499-510`), `platform_audit_event` | Auditoría y agregados a 2 años (`:485-487`) | Re-etiquetado (`:362-388`) | ¿Basta el re-etiquetado verificado como anonimización (DEC-0027)? |
| H. Registro de bajas | `tenant_exit` (`:119`), `anonymized_tenant` (huella sha256; poda a 30 días, `:41-42,256-258`), `retention_run` (`:204-207`) | Poda del registro a 30 días | Huella conservada 30 días | Ninguna nueva; la ventana precede a la anonimización |

**Cambios de esta rama (contrato del ciclo; diff de trabajo frente a `b809510`, verificar al integrar):** la migración
0037 añade `engagement_approval_offer` (instantánea por aviso de Telegram: chat, persona, código, revisión, opciones,
sha256), que se incorpora a `TENANT_TABLES` antes de `engagement_notification`, y la purga de Google vacía también
`engagement_case.ai_draft` y las opciones de esas instantáneas, conservando su huella. En `b809510` la purga de Google
no vaciaba `ai_draft` (`src/google/retention.ts@b809510:92-96`).

### 3.3 Copias fuera de la base de MainSpot

| Copia | Contenido | Retención observada |
|---|---|---|
| Exportación previa a la baja | JSON 0600 `mainspot-tenant-export/v1` en `MAINSPOT_EXPORT_DIR` o `/var/lib/mainspot/exports` (`service.ts@b809510:311-318,517`; `scripts/tenant-exit.ts:10-11,53`) | Ningún código la borra: `exportDir`/`MAINSPOT_EXPORT_DIR` solo aparecen al escribirla y configurarla |
| Avisos de Telegram | Autor, extracto de hasta 300 caracteres de la reseña o comentario y las opciones numeradas (`src/engagement/service.ts@b809510:795-810`), enviados al chat vinculado (`:845`) | MainSpot no borra mensajes enviados (sin `deleteMessage` en `src/`); entrega real no verificada (`docs/architecture/telegram-webhook-starlink.md:5`) |
| Respaldos | Volcado completo cifrado | §5 |
| Proveedores | Peticiones de IA, correo, conectores | §4 |

## 4. Encargados y terceros con datos del negocio

MainSpot se describe como encargado de los negocios y a los proveedores de IA como subencargados, calificación a
confirmar por el asesor legal (`docs/architecture/ai-providers-data-terms.md:30-36`).

| Tercero | Qué recibe | Retención declarada por el tercero o en el código | Efecto de R7 |
|---|---|---|---|
| TypeSafe (Jev, clasificación) | Texto mínimo de mensajes, reseñas y comentarios | Sin plazo numérico público; respaldos propios; ZDR solo enterprise (`ai-providers-data-terms.md:86-103`) | Borrar en MainSpot no borra en TypeSafe; instrumento contractual y ZDR pendientes (`:423`) |
| Anthropic (texto) | Peticiones de redacción | 30 días; hasta 2 años si se marca; borrado a los 30 días de terminar el contrato (`:205-212,225-226`) | Ídem |
| OpenAI (solo imágenes) | Prompts de imagen | Registros de abuso 30 días; borrado a los 30 días de terminar (`:329-334,350-351`) | Ídem |
| Google Business Profile | Fuente de las reseñas; recibe las respuestas publicadas (`docs/architecture/real-provider-connectors.md:24-25`) | Contenido recibido: máximo 30 días por política de Google (`src/google/retention.ts@b809510:4-6,24-28`) | **No cambia**: la ventana de 60 días no amplía el límite de Google |
| Meta (Páginas de Facebook) | Fuente de los comentarios; recibe publicaciones y respuestas (`real-provider-connectors.md:44-47`) | Comentario guardado hasta 4 000 caracteres (`src/engagement/worker.ts@b809510:191-193`); sin purga por plazo en MainSpot (§3.2 D); términos de Meta sobre almacenamiento no documentados en el repositorio [INFERENCE] | Pregunta abierta (§8) |
| Telegram | Avisos con extractos y nombres (§3.3) | Fuera del control de MainSpot [INFERENCE] | Pregunta abierta (§8) |
| Correo transaccional (Resend o SMTP; deshabilitado por defecto) | Destinatario y enlace de recuperación de contraseña | Registros sin destinatarios ni cuerpos en MainSpot (`src/mail/mailer.ts:1-13`); la del proveedor no consta [INFERENCE] | Pregunta abierta (§8) |
| Respaldo remoto (Garage S3 en Hostinger KVM 4) | Volcado cifrado; el servicio nunca recibe la clave | 14 días, nunca más de 16 (`docs/contracts/backup-object-storage/v1/CONTRACT.md:10-12,36-39,564-569`); transferencia **desactivada** (`docs/contracts/backup-object-storage/integration-status.md:6-7`) | §5 |
| Alojamiento de la aplicación y la base | Toda la base | Topología LXD del piloto (`.canonflow/sources/source-register.yaml:85-93`); no consta en el repositorio un contrato de alojamiento tercero [INFERENCE] | Pregunta abierta (§8) |

## 5. Respaldos

- Locales: diarios, cifrados, borrados a los 14 días solo tras un respaldo correcto (DEC-0026;
  `scripts/ops/backup/db-backup.sh:12-13,41,129-135`; `CONTRACT.md:231-238`). La prueba mensual restaura en una base
  desechable y vuelve a anonimizar las bajas (`CONTRACT.md:237-238`; `scripts/ops/backup/db-restore-test.sh:11-12,187-188`).
- Remotos y copia protegida: 14 días, nunca más de 16 desde `created_at`, sin retenciones indefinidas
  (`CONTRACT.md:564-569,717-725`); hoy desactivados (`integration-status.md:6-7`).
- No reintroducción (DEC-0027): el registro de huellas dura 30 días y los respaldos como máximo 16, así que una
  restauración vuelve a anonimizar toda baja posterior al respaldo (`CONTRACT.md:861-874`;
  `src/retention/service.ts@b809510:41-42,419-444`; `README.md:364`).
- Análisis para R7: la ventana de 60 días ocurre **antes** de la anonimización, con los datos vivos en la base;
  cuando vence y se anonimiza, el registro de 30 días sigue durando más que cualquier respaldo (16 días). No hace falta
  cambiar plazos de respaldo ni del registro. Una restauración durante la ventana devuelve el negocio en su estado de
  ventana, por lo que el inicio y la causa de la ventana deben vivir en la base (Propuesta técnica de §2).
- La cola de respaldos tras anonimizar (hasta 16 días) es la de hoy para la baja de DEC-0024; G-LEGAL debe aceptarla
  también para los estados de R7 (§8).

## 6. Divergencia actual del código frente a R7 y por qué no se cambia en este incremento

| Hecho | Evidencia |
|---|---|
| El único plazo de baja es `exitGrace = '30 days'` (DEC-0024) | `src/retention/service.ts@b809510:40,319-323` |
| La base exige al menos 30 días entre la baja y la anonimización | `migrations/0015_retention_policy.sql:61` |
| La ejecución diaria automática (DEC-0025) anonimiza las bajas vencidas sin intervención | `src/retention/service.ts@b809510:241-255,277-295` (desde las 03:00 UTC, `:48`); comprobación cada 15 min (`src/api/server.ts:384,399-410`) |
| La baja la confirma una persona con un comando de operación | `scripts/tenant-exit.ts:1-11,49-54` |
| No existen cancelación con fin de periodo, impago, gracia, reactivación desde `exiting` ni importación | §2 |

**Por qué no se cambia ahora:**

1. R7 exige revisión legal antes de aplicarse y prohíbe extender plazos sin ella (`OWNER-RESOLUTION.md:20`;
   FR-0020, G-LEGAL).
2. Los estados cubiertos no existen (G-PAY): no hay a qué aplicar los 60 días.
3. Subir `exitGrace` a 60 días alargaría el plazo de **toda** baja confirmada, también las que siguen bajo
   DEC-0024/DEC-0027 (precedencias de `DEC-0077.md`), y sería una extensión sin revisión legal.
4. Esta ronda es de especificación (`NEXT-LOCAL-ROUND.md:20`).

**Riesgo residual:** si un operador usa `npm run tenant:exit -- confirm` para lo que comercialmente sea una cancelación
voluntaria, el negocio se anonimiza a los 30 días y no a los 60 de R7. La frontera entre «baja confirmada» y
«cancelación» en un piloto sin cobro es la pregunta Q-L10.

## 7. Qué falta para aplicar R7

1. **G-PAY:** proveedor de pago aprobado y estados verificables de periodo pagado, cancelación al fin del periodo
   (C11), impago, gracia (C09), suspensión por impago y reactivación sin cobros duplicados ni cuotas reiniciadas (C13).
   Hoy el pago es simulado (`README.md:341`) y `subscription.status` no tiene fin de periodo
   (`migrations/0009_subscriptions_plans.sql:34`).
2. **G-LEGAL:** respuestas a §8, con el destino de cada clase de §3.2 y §3.3 y las excepciones de conservación.
3. Modelo de la ventana (Propuesta técnica de §2) con migración reversible y G-MIG propios.
4. Reactivación desde la ventana (hoy no hay camino de `exiting` a `active`).
5. Importación (no existe; la exportación `mainspot-tenant-export/v1` solo se genera al confirmar la baja,
   `service.ts@b809510:311-318,517`) y formatos (DEC-0076 C12).
6. Despublicación reversible del sitio, sin apropiarse de dominios, y avisos previos (C10; canales y umbrales sin
   decidir): no hay código de despublicación (búsqueda `unpublish|despublic` en `src/` sin resultados aplicables).
7. Destino de la exportación previa, de las copias en Telegram y de las copias en proveedores (§3.3, §4).
8. Pruebas e instrumentación de §9.

## 8. Preguntas abiertas para la revisión legal (sin responder)

- **Q-L1.** ¿Qué marco legal rige la conservación durante la ventana y el papel de MainSpot (encargado) frente al
  negocio (responsable)? (`ai-providers-data-terms.md:30-36,424`).
- **Q-L2.** Por cada clase de §3.2: ¿se conserva durante la ventana, se elimina antes o se anonimiza al vencer?
  ¿Qué clases no admiten anonimización confiable y deben eliminarse (DEC-0027, `DEC-0027.md:37`)?
- **Q-L3.** ¿Qué obligaciones legales de conservación existen (por ejemplo, facturación cuando haya cobro) y con qué
  plazo y finalidad?
- **Q-L4.** ¿Quién puede pedir la eliminación anticipada (negocio, sus usuarios, reseñantes o comentaristas), por qué
  vía y con qué verificación?
- **Q-L5.** Datos de terceros (nombres y textos de reseñantes y comentaristas): ¿pueden conservarse los 60 días? ¿Qué
  plazo aplica a los comentarios de Facebook, que hoy no tienen purga por plazo?
- **Q-L6.** ¿Hay que pedir el borrado a los proveedores de IA o basta su retención contractual (§4)? ¿Qué falta en
  el instrumento de TypeSafe?
- **Q-L7.** ¿Es aceptable que los respaldos conserven hasta 16 días los datos de un negocio ya anonimizado (§5)?
- **Q-L8.** ¿Cuánto se conserva el archivo de exportación previa y quién lo custodia (§3.3)?
- **Q-L9.** ¿Se requieren avisos al negocio antes de vencer la ventana, por qué canal y con qué antelación (C10)?
- **Q-L10.** En el piloto sin cobro, ¿una baja voluntaria pedida por el negocio es una «cancelación» cubierta por R7
  (60 días) o una «baja confirmada» de DEC-0024 (30 días)?
- **Q-L11.** ¿Una suspensión administrativa por otros motivos (FR-0018) puede tener efectos de retención?
- **Q-L12.** ¿Qué hacer con los avisos ya entregados en chats de Telegram (§3.3)?
- **Q-L13.** ¿Basta el re-etiquetado verificado de auditoría, agregados y costos de IA (§3.2 G) como anonimización
  para conservarlos dos años (DEC-0022, DEC-0023, DEC-0027)?
- **Q-L14.** Alojamiento, correo y Meta: ¿qué contratos o términos fijan su retención (§4)?

## 9. Criterios de aceptación propuestos (para cuando se desbloquee)

Propuesta técnica; complementan AC-20001…AC-20006 de FR-0020.

1. Cada tabla con datos de un negocio tiene clase y destino aprobados en G-LEGAL; una tabla nueva sin clasificar
   hace fallar la anonimización (como hoy `assertNoTraces`, `service.ts@b809510:568-601`).
2. El inicio de la ventana es un instante persistido y auditado que nace de un estado comercial verificable (G-PAY);
   nunca de una suspensión administrativa ni del vencimiento del Trial.
3. Durante la ventana: ninguna anonimización por plazo; aislamiento entre negocios probado; la purga de Google a los
   30 días sigue; reactivación y exportación disponibles.
4. Al vencer: anonimización o eliminación por clase en una transacción por negocio, con la verificación de §3.1, ensayo
   previo (`scripts/anonymization-dry-run.ts`) e informe auditado de la ejecución diaria (DEC-0025).
5. La eliminación anticipada y la conservación legal quedan auditadas, con finalidad y plazo.
6. Una restauración de respaldo antes de abrir tráfico vuelve a anonimizar las bajas vencidas (prueba mensual).
7. Las bajas fuera de los estados cubiertos conservan los 30 días (regresión de `tests/integration/retention.test.ts:195`).
8. Concurrencia: reactivación frente a anonimización y dos ejecuciones simultáneas no producen pérdida ni doble efecto.
9. Evidencia solo con PostgreSQL desechable y datos sintéticos; ninguna ejecución sobre datos reales ni producción sin
   G-MIG/G-SEC.

## 10. Trazabilidad

DEC-0077 (R7) → FR-0020 (AC-20001…20006) → este documento → G-LEGAL y G-PAY. Registros que siguen vigentes:
DEC-0021…DEC-0027 (QS-0006), DEC-0018 (Trial) y el contrato de respaldos
`docs/contracts/backup-object-storage/v1/CONTRACT.md` (v1.2.0). Antecedentes: C09–C13 de DEC-0076 y
`docs/architecture/commercial-quota.md:76-77`.
