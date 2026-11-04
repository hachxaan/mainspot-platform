# Cierre — catálogo de planes versionado y parámetros por plan (DEC-0075)

- Fecha: 2026-11-04.
- Rama: `feat/plan-policy-catalog-impl-20261104`, base `feat/canonflow-implementation` @ `95f9436084fccd4c3ae83b0dbde62bcdbaa1274b` (verificada en `origin` antes del commit).
- Mandato: `docs/handoffs/plan-policy-catalog-2026-11-04/{BOOTSTRAP-PROMPT,HANDOFF}.md` (rama `docs/handoff-plan-policy-catalog-20261104` @ `585017b`).
- Estado: **implementado y verificado en desarrollo**.
  - No es READY de producción.
  - No hay despliegue.
  - No aprueba precios, cobros ni paquetes comerciales.
  - Faltan las aprobaciones humanas del §6.

## 1. Decisiones del propietario

Las tomó el propietario en esta sesión (preguntas `ask`), quedan registradas como SRC-0013 y se aplican en DEC-0075 (canon delta 0.6.0: BR-0007, FR-0010, FR-0018, FR-0019).

| Tema | Respuesta | Aplicación |
|---|---|---|
| Autoridad del catálogo | Ingeniería con permisos explícitos | `plans.read/edit/publish`, `subscriptions.assign`, `tenants.read` en `src/platform/permissions.ts` |
| Publicar | Configuración operativa | Etiqueta «Sin aprobación comercial»; sin precios ni cobro |
| Revisiones | Fijadas a su revisión | `subscription.plan_revision_id` y migración explícita con vista previa |
| Cuotas periódicas | Mecanismo sin activar | Semánticas probadas; el catálogo solo usa `cumulative` hasta HDC-MSP-06 |
| Autoasignación del negocio | Retirarla | 403 auditado; el panel queda en solo lectura |
| Parámetros nuevos | Ninguno (`scope=[]`) | El registro tiene las 6 capacidades existentes |
| Registro | SRC + DEC | SRC-0013 y DEC-0075, sin QS/ANS ni APR |
| Ajustes del arnés | Solo esta sesión | No se persistió ninguna configuración |

Salvaguardas derivadas, anotadas como tales y no como decisiones nuevas:
- **FR-0019 AC-19011.** Las identidades de negocios en Planes exigen `tenants.read` (mínimo privilegio, BR-0007).
- **Nombre y descripción del plan.** Exigen `plans.publish`, porque los negocios los ven al instante.

## 2. Entregables

| Entregable | Ruta |
|---|---|
| Inventario verificado (783 definiciones, 8990 referencias, 0 rotas; 314 archivos del universo: 256 leídos completos, 33 en parte y 25 no cubiertos, listados) | `docs/research/plan-parameters-inventory.{md,json,csv}`, `docs/research/plan-parameters-inventory/{slices/*.json,merge.py}` |
| Diseño y operación | `docs/architecture/plan-catalog.md`, `README.md` §9 y §14 |
| Canon | `.canonflow/sources/SRC-0013-plan-catalog-directive.md`, `.canonflow/decision-records/DEC-0075.{json,md}`, BR-0007, FR-0010, FR-0018, FR-0019, CHANGELOG, índices y estados |
| Migración y reversión | `migrations/0034_plan_policy_catalog.sql`, `scripts/plan-catalog-rollback.sql` |
| Backend | `src/plans/{registry,policy,catalog,assignment}.ts`, `src/platform/{permissions,auth}.ts`, `src/api/{plan-catalog-routes,platform-routes,subscription-routes}.ts`, `src/subscriptions/{quota,entitlements}.ts`, `src/identity/onboarding.ts`, `src/retention/service.ts`, `src/rbac/matrix.ts`, `src/audit/event.ts` |
| UI | `src/web/platform/assets/console.{js,css}` (Planes en `/ingenieria`; «Plan y consumo» y «Asignar plan» en `/plataforma`), `src/web/panel/assets/js/{store,views-app,main}.js` («Mi plan», solo lectura) |
| Pruebas | `tests/integration/{plan-catalog,plan-catalog-migration,quota-semantics}.test.ts`, `tests/unit/plan-policy.test.ts`, `tests/e2e/plan-catalog-ui.test.ts`; actualizadas: `subscriptions-inc006`, `nfr-0001-atomicity`, `tests/unit/subscriptions.test.ts`, `tests/e2e/inc004-inc006-e2e.test.ts`, `tests/helpers/{plans,tenants}.ts` |
| Evidencia | `evidence/plan-catalog/{test-runs.txt,e2e-ui.txt,ui/*.png,agent-model-manifest.md}` |

## 3. Matriz de aceptación

Estados: PASS (ejecutado y comprobado), PARCIAL (comprobado solo en parte; el motivo se indica), FAIL, BLOCKED (depende de una decisión o aprobación humana).

| AC | Estado | Evidencia ejecutada | Límite |
|---|---|---|---|
| AC01 Migración exacta, sin beneficios inventados | PASS | `plan-catalog-migration`: «0034: backfill exacto…» (mismas decisiones de cuota antes y después); abortos sin pérdida ante una capacidad o un valor fuera del registro; tabla de valores en `plan-catalog.md` §2 | Lo ausente pasa a 0 explícito (`backfill_absent_deny`), con el mismo efecto que antes |
| AC02 Tipo, unidad, ámbito, enforcement, default y techo | PASS | `registry.ts` con espejo en BD (503 si difiere: prueba «espejo del registro»); `GET /plan-catalog/parameters`; tabla del registro en la UI; inventario completo | `agents` se muestra «No se aplica hoy» (DEC-0006/DEC-0017) |
| AC03 Crear o clonar exige confirmar cada valor | PASS | Integración «crear plan…»; trigger de BD; E2E checks 5–10 y 13 (nace deshabilitado, copiados sin confirmar, publicar deshabilitado, validación en línea, cambiar desmarca, confirmado por la persona) | — |
| AC04 Revisión nueva, diff, motivo, confirmación, step-up, auditoría y vuelta atrás | PASS | Integración «edición…», «rollback…», «BD: publicadas y reemplazadas inmutables…», «concurrencia…»; E2E 11–19 (step-up caducado, publicar, v2), 30–32 (rollback a v4, eventos con motivo y diff) y 37–41 (conflicto de edición, descartar con confirmación) | — |
| AC05 Ingeniería con permisos; soporte, negocios y roles no autorizados denegados | PASS | Integración «autorización…», «mínimo privilegio (BR-0007)…»; E2E 1–4 (soporte solo lee y solo ve la pestaña Planes) y 23 (autoasignación 403) | — |
| AC06 Semánticas de cuota, sin carreras ni doble consumo | PASS (mecanismo) | `quota-semantics` (15): acumulada, periódica, ventana móvil, stock y elegibilidad; concurrencia en 12 conexiones; replay; aislamiento; `plan-policy` (ciclo mensual sin deriva ni DST) | Por decisión del propietario, el catálogo solo activa `cumulative`; el resto no está activado (HDC-MSP-06) |
| AC07 API, frontend, workers y contratos de IA consumen límites compatibles y con errores adecuados | PARCIAL | API: `limit_exceeded` con el texto del registro (E2E 22). Administration y panel: uso frente al límite de la revisión fijada (E2E 33–34), con «Completo» o «Por encima del límite». La reconciliación informa del uso por encima del límite fijado (integración) | Workers y contratos de IA no consumen parámetros de plan: los presupuestos de IA quedan fuera por AC08 y DEC-0074. Las 66 derivas `drift` del inventario (constantes fuera del plan) no se normalizaron por `scope=[]`; quedan documentadas |
| AC08 Ninguna cuota comercial toca seguridad, retención, consentimiento, autorización humana ni techos de proveedor | PASS | Registro limitado a las 6 capacidades comerciales; `effectiveValue` nunca eleva ni supera el techo de sistema (unitarias); `plan-catalog.md` §5 | — |
| AC09 Ausencia ⇒ deny; borrador no asignable; downgrade sin destruir | PASS | `quota-semantics` «sin suscripción activa…», «elegibilidad… ausente ⇒ deny»; trigger de suscripción (solo publicada y habilitada); E2E 24 (v3 no mueve al negocio) y 27–29 (migrado a v3 conserva sus publicaciones, con historial) | — |
| AC10 Pruebas reproducibles; backfill y reversión | PASS | `evidence/plan-catalog/test-runs.txt`: tsc 0; unitarias 185/185; integración 220/220; smoke 5/5; E2E 5/5 (Planes: 42 checks). Ida y vuelta de la reversión y re-ejecución idempotente de 0034 (`plan-catalog-migration`) | — |
| AC11 Canon y gobierno coherentes, sin aprobar lo reservado al humano | PASS (documentación) · BLOCKED (aprobaciones) | SRC-0013 y DEC-0075 registrados. Validadores de `canonflow-keystone/scripts`, ejecutados por el subagente CanonRegistration: `validate_schemas_v2` 85/85; `validate_traceability` con los mismos 5 fallos previos (5/99); G-EPI PASS; G-TRACE solo +1 referencia colgante, la del enlace nuevo. Tras la última edición de FR-0019 (texto), `validate_traceability` (5/99, los mismos) y G-EPI (PASS) se volvieron a ejecutar | No aprueba Q-004, HDC-MSP-06, Trial (DEC-0018) ni precios. Las aprobaciones de §6 son del propietario |
| AC12 Manifiesto de agentes con modelos flagship, sin Fable ni degradaciones | PARCIAL | `agent-model-manifest.md`: todos los mensajes de respuesta del agente principal y de los 16 subagentes son `anthropic/claude-opus-5-5`; subagentes con esfuerzo `max`; ninguna llamada a Fable | Excepciones en la tabla del manifiesto: esfuerzo `xhigh` del agente principal (configuración de la sesión) y 25 llamadas auxiliares del arnés a modelos no flagship |

## 4. Revisiones independientes y correcciones

1. **Revisiones.** Tres revisiones `opus-max` de solo lectura: arquitectura y migración, seguridad y autorización, UX y accesibilidad.
2. **Correcciones.** Las aplicaron dos agentes `opus-max` (servidor y migración) y el agente principal (UI).
3. **Verificación independiente** (`ReviewFixesDelta`) de 46 hallazgos: 30 corregidos, 15 parciales y 1 sin corregir. Detectó además 7 defectos nuevos (N1–N7).
4. **Última ronda**, sin revisión independiente posterior.
   - Corregido y cubierto por el E2E final:
     - N1: un 409 ya no conserva una confirmación de un valor que cambió (check 38);
     - N7: el transcript E2E registra la huella de los assets.
   - Corregido solo por lectura de código:
     - N2: tras un 409, el formulario, su error y su motivo siguen en pantalla;
     - N3: el diálogo de step-up no admite doble envío y un código incorrecto no cierra la sesión;
     - N4 y N5: foco al cerrar el step-up y `inflight` ante un fallo de red;
     - N6: `data-server` en nombre y descripción;
     - pestañas de Administration por permiso;
     - unidades en el diff y el historial;
     - `plan_id` en el selector de asignación;
     - aviso «todavía no se aplica» en el panel.
   - Riesgo 1 de la verificación, corregido: el motivo de la asignación rechaza correos e ids `client_…`, con prueba de integración.

## 5. Riesgos residuales y pendientes (no bloquean el desarrollo)

| # | Riesgo o pendiente | Origen |
|---|---|---|
| R1 | Las denegaciones escritas antes de este cambio con `/tenants/<id>/…` en `resource` siguen bloqueando la anonimización de esos negocios. Requiere una migración de limpieza acotada | Preexistente (A1) |
| R2 | `GET /subscriptions/plans` muestra a cualquier negocio los planes asignables | Preexistente (B5) |
| R3 | La vista previa de migración no tiene límite ni paginación y repite consultas por negocio | L2/B10 |
| R4 | `TENANT_DATA` no detecta slugs, subdominios ni logins que no sean correo. Un motivo así bloquearía la anonimización. Otros motivos de plataforma (estado, clasificación, soporte) no filtran datos de negocio | Verificación, riesgos 1–2 |
| R5 | Una escritura SQL directa de valores simultánea a una publicación puede dar 40P01; si el abortado es la publicación, responde 500 | Migración |
| R6 | Los límites de intentos (login y step-up) viven en memoria de cada proceso; el login conserva la carrera de ráfagas | Preexistente / verificación |
| R7 | UX pendiente: tabla de límites origen→destino en la vista previa; jerga técnica en ayudas (texto del techo); actores crudos; foco atrapado en el diálogo; el E2E no prueba teclado ni foco | Verificación |
| R8 | Trial (DEC-0018) sigue sin implementar; el alta del piloto no crea trial (CF-07/CF-16) | Fuera de alcance |
| R9 | Una `conversation_request` se crea sin cuota, y en medios queda un TOCTOU | Preexistente (inventario) |
| R10 | 66 derivas y 135 huecos de enforcement del inventario, sin normalizar | `scope=[]` |
| R11 | El nombre del plan no se compara con NFKC (posibles homógrafos) | B6 parcial |

## 6. Aprobaciones humanas pendientes

- Revisión y aprobación del PR (borrador) contra `feat/canonflow-implementation`, en especial:
  - G-MIG: la migración 0034 y su reversión;
  - G-SEC: los permisos de plataforma, el límite de step-up y la auditoría sin datos de negocio.
- Antes de aplicar 0034 fuera de desarrollo: decidir la limpieza de las filas de R1.
- Decisiones reservadas, no tomadas: precios y paquetes (Q-004), ciclo, rollover, excedentes y cambios de plan (HDC-MSP-06), Trial (DEC-0018), `agents` (DEC-0006/DEC-0017).

## 7. Commits

Los commits lógicos y sus SHA están en el PR de esta rama. La evidencia E2E se generó con el árbol de trabajo, antes del commit; `e2e-ui.txt` registra la huella sha256 de cada asset probado.
