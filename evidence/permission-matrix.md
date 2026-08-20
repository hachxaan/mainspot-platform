# Matriz de permisos del backoffice (INC-001)

> Generado el 2026-08-20T05:36:32.586Z desde `src/rbac/matrix.ts` (fuente de verdad).
> Regla fail-closed: toda acción no listada es **deny**; el contexto de cliente siempre aplica sobre el rol.

| Acción (recurso \* = contexto general) | Administración | Operación | Solo lectura |
|---|---|---|---|
| `user.manage` — Gestionar usuarios y roles | allow | deny | deny |
| `client.config.manage` — Configurar el cliente | allow | deny | deny |
| `audit.read` — Ver el registro de auditoría | allow | deny | deny |
| `audit.export` — Exportar el registro de auditoría | allow | deny | deny |
| `operation.create` — Crear una operación de prueba | allow | allow | deny |
| `operation.execute` — Ejecutar operaciones | allow | allow | deny |
| `operation.approve` — Aprobar operaciones | allow | deny | deny |
| `operation.reject` — Rechazar operaciones | allow | deny | deny |
| `data.read` — Ver los datos del cliente | allow | allow | allow |
| `data.write` — Registrar datos del cliente | allow | allow | deny |

## Vista por rol (lenguaje claro, AC-008)

- **Administración**: todas las acciones del panel
- **Operación**: `operation.create`, `operation.execute`, `data.read`, `data.write`
- **Solo lectura**: `data.read`

Total entradas: 15

