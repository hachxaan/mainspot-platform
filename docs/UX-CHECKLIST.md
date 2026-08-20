# Checklist UX y accesibilidad — INC-001 (evidencia AC-008)

Aplicado sobre la UX mínima de backoffice (`src/api/ui.ts`): página de ingreso `/` y panel `/panel`.

Checklist del plan `PLAN-INC-001` §9. Marcado: `PASS` / `N/A` / `PENDIENTE`.

| # | Ítem (plan §9) | Estado | Cómo se verifica |
|---|---|---|---|
| 1 | Lenguaje claro, sin jerga técnica (REQ-001, NFR-001) — "cliente", "usuario", "operación" visibles | PASS | Textos: "Bienvenido a MainSpot", "Ingresa con el usuario, la contraseña y el cliente...", etiquetas de acciones en español llano (`ACTION_LABELS`) |
| 2 | Acciones principales distinguibles por perfil (administración/operación/lectura) | PASS | `/api/backoffice/me` entrega `permissions`; el panel renderiza solo las acciones del perfil; badge de rol con texto + estilo (no solo color) |
| 3 | Flujo completo sin instrucciones técnicas externas (AC-008) | PASS | Ingreso → panel → ver datos / registrar / ver auditoría según perfil (smoke `AC-008` verifica HTML) |
| 4 | Estados de error comprensibles (denegación, contexto ausente, rol inválido) | PASS | Mensajes emitidos por `errors.ts` y rutas (p. ej. "Tu perfil no permite esta acción. Si crees que es un error, comunícate con el administrador.") con `role="alert"` |
| 5 | WCAG aplicables al piloto (NFR-007, PROPOSED): contraste, teclado, labels | PARCIAL | Labels con `for`, navegación por teclado nativa (botones/inputs), `lang="es"`, `autocomplete`; falta auditoría visual completa (PENDIENTE captura con navegador) |
| 6 | Roles visualmente distinguibles sin depender solo de color | PASS | Badge de texto + clase (`admin`/`ops`/`readonly`): "Administración", "Operación", "Solo lectura" |

## Hallazgos y pendientes

- No hay navegador disponible en el entorno de implementación, por lo que las capturas de pantalla por rol (`AC-008` del contrato) quedan **PENDIENTES** de captura; los tests de smoke verifican las señales estructurales (labels, botones, mensajes, ausencia de jerga/secretos).
- Se recomienda una revisión de accesibilidad visual (con contraste y zoom) antes de exponer el backoffice a operadores reales.
