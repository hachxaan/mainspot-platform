# Manifiesto de agentes y modelos efectivos (AC12)

- Fuente: transcripts de la sesión OMP `~/.omp/agent/sessions/-codeart-mainspoot-mainspot-platform/2026-11-04T16-51-16-322Z_01a1a778-d4e2-71e4-8d2f-1d4690c85af3{.jsonl,/*.jsonl}`, que incluyen al agente principal, cada subagente y al asesor del arnés.
- Método:
  - **modelo efectivo:** el campo `model`/`provider` de cada mensaje `assistant`;
  - **esfuerzo:** los eventos `thinking_level_change`;
  - **llamadas auxiliares del arnés:** los eventos `model_usage`.
- Fecha de corte: el cierre del 2026-11-04, antes del commit. El recuento del agente principal sigue creciendo hasta el final de la sesión.
- Perfil de los subagentes: `opus-max` (`.omp/agents/opus-max.md`, fuera de Git): `model: anthropic/claude-opus-5-5`, `thinking-level: max`. Se usó el mismo perfil en todas las delegaciones, y antes de cada una se comprobó que el perfil no había cambiado.
- Configuración del arnés en esta sesión (solo esta sesión, por decisión del propietario):
  - `task.perCallModel: off`, `task.agentModelOverrides: {}`, `retry.modelFallback: false`;
  - desde ~16:53Z: `advisor.enabled=false` y `ttsr.judge=off`;
  - más tarde: `features.unexpectedStopDetection=mechanical`;
  - roles `smol`/`tiny`/`widget`/`commit`/`memory` asignados a `anthropic/claude-opus-5-5`.

| Agente | Rol | Modelos de respuesta (proveedor/modelo × mensajes) | Esfuerzo | Llamadas auxiliares (propósito → modelo) |
|---|---|---|---|---|
| Agente principal (sesión 01a1a778) | principal | anthropic/claude-opus-5-5 × 475 | medium × 1; xhigh × 1 | cache-warm → anthropic/claude-opus-5-5 × 2; job-caption → anthropic/claude-opus-5-5 × 6; job-widget → anthropic/claude-opus-5-5 × 7; ttsr → typesafe/jev-latest × 7 |
| CanonRegistration | subagente opus-max | anthropic/claude-opus-5-5 × 97 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| FixMigrationFindings | subagente opus-max | anthropic/claude-opus-5-5 × 73 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 4 |
| FixServerFindings | subagente opus-max | anthropic/claude-opus-5-5 × 140 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| InvVerifyAI | subagente opus-max | anthropic/claude-opus-5-5 × 187 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| InvVerifyCanon | subagente opus-max | anthropic/claude-opus-5-5 × 203 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 4 |
| InvVerifyEngageSocial | subagente opus-max | anthropic/claude-opus-5-5 × 201 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| InvVerifyPlatformCore | subagente opus-max | anthropic/claude-opus-5-5 × 179 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| InvVerifyWebMediaBrand | subagente opus-max | anthropic/claude-opus-5-5 × 143 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| InventoryConsolidation | subagente opus-max | anthropic/claude-opus-5-5 × 127 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| ModelCanary | subagente opus-max | anthropic/claude-opus-5-5 × 2 | max × 1 | unexpected-stop → typesafe/jev-latest × 1 |
| PlanCatalogApiTests | subagente opus-max | anthropic/claude-opus-5-5 × 117 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| QuotaSemanticsAndMigrationTests | subagente opus-max | anthropic/claude-opus-5-5 × 98 | max × 1 | find → typesafe/jev-latest × 8; task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| ReviewArchitectureMigration | subagente opus-max | anthropic/claude-opus-5-5 × 93 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 4 |
| ReviewFixesDelta | subagente opus-max | anthropic/claude-opus-5-5 × 78 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 3 |
| ReviewSecurityAuthz | subagente opus-max | anthropic/claude-opus-5-5 × 107 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 4 |
| ReviewUxAccessibility | subagente opus-max | anthropic/claude-opus-5-5 × 83 | max × 1 | task-completion-probe → anthropic/claude-opus-5-5 × 4 |
| __advisor | asesor del arnés | google-antigravity/gpt-oss-120b × 9 | — | — |

## Excepciones (no flagship o no máximo)

| Quién | Qué | Cuándo (UTC) | Alcance |
|---|---|---|---|
| Agente principal | Esfuerzo `xhigh` (antes `medium` 12 s, sin mensajes) | Toda la sesión desde 16:51:28 | Configuración de la sesión del propietario; todos sus mensajes son Opus 5.5 |
| Agente principal | 7 llamadas `ttsr` → `typesafe/jev-latest` | 16:51:39–16:52:56 | Juez TTSR del arnés, antes de apagarlo |
| Asesor del arnés | 9 respuestas `google-antigravity/gpt-oss-120b` | 16:51:45–16:53:25 | Asesor automático, antes de apagarlo |
| ModelCanary | 1 llamada `unexpected-stop` → `typesafe/jev-latest` | 17:28:32 | Detector de paradas del arnés, antes de pasarlo a `mechanical` |
| QuotaSemanticsAndMigrationTests | 8 llamadas `find` → `typesafe/jev-latest` | 18:52:44–18:52:45 | Herramienta `find`, usada una vez a pesar de la instrucción de no usarla |

Las 25 llamadas auxiliares a modelos no flagship son llamadas del arnés (juez, asesor, detector y búsqueda), no razonamiento de los agentes. Ningún mensaje de respuesta de ningún agente usó Fable ni un modelo distinto de `anthropic/claude-opus-5-5`.
