# MSP-JEV-CLASSIFIER-MODES v1 — Jev como clasificador semántico de MainSpot

| Campo | Valor |
| --- | --- |
| Estado | PROPUESTA. No autoriza nada hasta que se ingiera su aprobación en el HDC (QS-0007) |
| Preparada por | Agente, RUN-0002, 2026-10-21 |
| Solicitada en | DEC-0019 (QS-0004 / ANS-0004, Q-JEV-DATA) |
| Relacionada | DEC-0001, APR-0001 (comentario), DEC-0019 |

## 1. Lo que pidió el humano (DEC-0019, literal resumido)

- Jev debe ser el clasificador semántico principal de MainSpot, no quedarse
  siempre en sombra.
- Se piden modos explícitos `disabled`, `shadow` y `primary`, sin que el
  clasificador determinista tenga prioridad obligatoria en la interpretación
  semántica.
- **Jev determina la clasificación.** El backend conserva el control de
  identidad, permisos, cuotas y autorización de operaciones.
- Uso habitual en desarrollo y pruebas con datos sintéticos, con medición y
  presupuestos.
- Los mensajes reales de clientes necesitan antes políticas de datos personales,
  minimización, retención y límites de consumo, con una autorización separada.
- No modificar DEC-0001 ni habilitar el modo primario sin la autorización
  canónica correspondiente.

## 2. Contrato actual verificado (código del repositorio, 2026-10-21)

| Aspecto | Hoy |
| --- | --- |
| Variables | `JEV_ENABLED` (por defecto `false`); `JEV_PROVIDER`, que solo admite `typesafe`; `TYPESAFE_API_KEY`, obligatoria si está habilitado; `JEV_MODEL`, que vacía equivale a `jev-latest`; `JEV_SHADOW_MODE` (por defecto `true`; con `false` el arranque falla). Fuente: `src/shared/config.ts` |
| Quién decide | `classifyIntent` (`src/conversation/classifier.ts`), determinista por reglas. Produce `intent`, `actionClass`, `capabilityTarget`, `proposalType`, `confidence` y `reason`, y el enrutado del pipeline usa todos esos campos |
| Jev | Solo en sombra (`src/conversation/jev-shadow.ts`). Responde una pregunta Choice sobre las 5 `ActionClass`, en segundo plano, y nunca cambia el resultado |
| Datos enviados | Solo el texto del mensaje (máximo 8 KiB) y la pregunta fija. Sin IDs de tenant ni de actor |
| Límites | 1 intento, sin reintentos, 10 s y 16 evaluaciones simultáneas por proceso |
| Evidencia | Tabla `jev_shadow_evaluation` (migración 0012) por tenant, con clases, probabilidades, modelos, uso, coste si se informa, latencia y cuerpos JSON |
| Estado operativo | `.env` con `JEV_ENABLED=false` desde DEC-0019. API `mainspot-app` detenida |

Intents actuales y su clase (tabla de `classifier.ts`):

| Intent | ActionClass |
| --- | --- |
| `query.read_only` | `read_only` |
| `content.suggestion` | `draft` |
| `request.needs_clarification` | `draft` |
| `website.edit` | `preview_required` |
| `change.ambiguous` | `preview_required` |
| `sensitive.business_decision` | `human_approval_required` |
| `rule.prohibited_commercial` | `prohibited` |
| `capability.unsupported` | `prohibited` |

## 3. Arquitectura propuesta

### 3.1 Configuración (corte limpio)

| Variable | Valores | Por defecto |
| --- | --- | --- |
| `JEV_MODE` | `disabled` \| `shadow` \| `primary` | `disabled` |
| `JEV_PROVIDER` | `typesafe` | — |
| `TYPESAFE_API_KEY` | secreto | — |
| `JEV_MODEL` | ID de modelo; se recomienda uno versionado | alias del proveedor |
| `JEV_DATA_SCOPE` | `synthetic`; es el único valor válido mientras no exista la decisión de datos reales | `synthetic` |
| `JEV_SYNTHETIC_TENANTS` | lista de tenants sintéticos autorizados, por ejemplo `client_a,client_b` | vacía |
| `JEV_DAILY_BUDGET_USD` | importe diario máximo (punto D5) | — |

`JEV_ENABLED` y `JEV_SHADOW_MODE` desaparecen. Se actualizan `.env.example`,
`docker-compose.yml` y el README. Cualquier valor fuera de contrato hace fallar
el arranque y el mensaje nunca incluye la clave.

### 3.2 Modos

- **`disabled`:** no se construye el cliente, no sale nada y decide el
  clasificador determinista. Es lo que hace hoy `JEV_ENABLED=false`.
- **`shadow`:** el comportamiento actual. Decide el determinista y Jev se
  registra como evidencia.
- **`primary`:** para mensajes dentro del alcance de datos (§3.4), **Jev
  determina la clasificación**:
  - una sola llamada con dos preguntas Choice: `intent` (los 8 intents de la
    tabla, más `other`) y `capability_target` (`website`, `social`,
    `reputation`, `domain`, `unknown`);
  - `actionClass` se deriva en código desde el intent con la tabla anterior, para
    que el modelo no elija directamente el nivel de autonomía;
  - un `other` se trata como baja confianza (D3).
  - **Papel del determinista:** se ejecuta en paralelo y queda registrado como
    comparación. Solo interviene según D1 (seguridad) y D2 (respaldo), nunca como
    prioridad general.

### 3.3 Lo que sigue siendo del backend, en cualquier modo

- Identidad y tenant: sesión y canal (RULE-001 / BR-0001).
- RBAC: matriz de permisos.
- Cuotas y entitlements: DEC-0007, DEC-0018 y el consumo atómico de DEC-0005.
- Gates humanos:
  - preview y confirmación de cambios visibles (BR-0003);
  - aprobación humana de decisiones sensibles (BR-0004);
  - bloqueo de lo prohibido (BR-0005).
- Auditoría con `request_id` y rate limiting.
- La extracción determinista de cambios de la web (`website/edit-mapper`):
  interpreta el contenido del cambio, no lo clasifica.

Jev nunca ejecuta, aprueba, publica ni escribe estado.

### 3.4 Alcance de datos (separado de esta aprobación)

- En los modos `shadow` y `primary`, con `JEV_DATA_SCOPE=synthetic`, solo se
  envía a TypeSafe el texto de mensajes de tenants listados en
  `JEV_SYNTHETIC_TENANTS`.
- El resto de tenants se procesa como en `disabled` y queda auditado como
  `jev_skipped:data_scope`.
- Enviar mensajes reales exige una decisión HDC específica (DEC-0019) y un valor
  de alcance nuevo, que esta propuesta no crea.

### 3.5 Medición y presupuesto

- Coste por llamada: `usage` × precio público observado (USD 0,042 por millón de
  tokens de entrada; salida gratuita, observación del 2026-10-20). Se registra
  junto al resultado, y el coste informado por el proveedor prevalece si existe.
- **[ESTIMACIÓN]** Con unos 600 tokens de entrada por llamada, cuesta unos
  USD 0,000025, es decir, unas 40.000 llamadas por USD. No se ha medido con el
  modelo real.
- **Libro diario por proceso y día UTC:** al alcanzar `JEV_DAILY_BUDGET_USD`, Jev
  se trata como no disponible (D2) hasta el día siguiente.
- **Métricas:** acuerdo con el determinista y con las etiquetas esperadas,
  latencia, disponibilidad, coste diario y decisiones tomadas en respaldo.

### 3.6 Persistencia y auditoría

- Migración nueva sobre `jev_shadow_evaluation`, que se renombra a
  `jev_classification`. Añade `mode` (`shadow` | `primary`), `decision_source`
  (`jev` | `deterministic_fallback` | `human_escalation`), `jev_intent`,
  `jev_capability_target`, `budget_day` y `cost_usd`.
- `conversation.classified` añade a su `result` el origen de la decisión.

### 3.7 Calibración y activación

- **Conjunto de evaluación:** sintético, etiquetado y versionado en el
  repositorio, con un mínimo de 200 mensajes en español. Cubre los 8 intents y
  casos límite de RULE-004 y RULE-005, y no contiene datos de clientes.
- La activación de `primary` en desarrollo y pruebas sigue el punto D4.

### 3.8 Plan de implementación (tras la aprobación)

1. Configuración `JEV_MODE` y alcance de datos, con validación y pruebas de
   configuración.
2. Decisión Jev ampliada (`intent` + `capability_target`), con una política pura
   por punto de decisión y pruebas offline con `fetch` simulado.
3. Pipeline: rama `primary`, con respaldo (D2), suelo de seguridad (D1) y baja
   confianza (D3), y la misma auditoría.
4. Presupuesto diario y métricas.
5. Migración y repositorio.
6. Conjunto de evaluación sintético y comando de evaluación offline/live; el
   modo live necesita el presupuesto aprobado.
7. Documentación: README, `.env.example` y `docs/COGNITIVE-JEV.md`.

**Verificación:** typecheck, pruebas unitarias e integración, y una prueba de
humo del arranque en cada modo. No se hace ninguna llamada real hasta que exista
la aprobación y el presupuesto.

### 3.9 Fuera de alcance

- Mensajes reales de clientes.
- Canal Telegram real.
- CJL.
- Despliegue a producción.
- Cambios en DEC-0001, que es inmutable. La autorización de `primary` la darán
  los registros que salgan de QS-0007.

## 4. Puntos de decisión (respondidos en QS-0007)

| Punto | Pregunta |
| --- | --- |
| D1 | Suelo de seguridad: discrepancias en lo prohibido o sensible entre Jev y las reglas |
| D2 | Respaldo cuando Jev no está disponible, tarda demasiado o agota el presupuesto |
| D3 | Baja confianza o `other` |
| D4 | Condición para activar `primary` en desarrollo y pruebas |
| D5 | Presupuesto diario |
