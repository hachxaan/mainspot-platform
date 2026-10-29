# SOL MAIN / agente local — ejecución E2E sin HDC

## Mandato de ejecución

Lee [OWNER-AUTHORIZATION.md](OWNER-AUTHORIZATION.md) y [SHARED-CONTRACT.md](SHARED-CONTRACT.md). **Empieza implementando, no proponiendo otro plan**. El propietario ya autorizó decisiones de ingeniería de desarrollo y trabajo E2E en paralelo con Claude Design. **No generar, esperar ni responder HDC**, no frenar por `DEC-0040` durante esta tanda de desarrollo; conservar registros históricos, explicar en `DECISION-LOG.md` las adaptaciones y continuar.

### Criterio de arquitectura
Extender Node/TypeScript + PostgreSQL + RBAC/tenant + audit + estado conversacional existentes. Migraciones aditivas, API siguiendo `src/api/*-routes.ts`, servicios nuevos donde faltan. **No reescribir identidad, el motor social o el de reseñas, no introducir microservicios o framework de orquestación.** Aprovechar `tests/unit/`, `tests/integration/`, `tests/e2e/`.

## Orden de ejecución (se permiten verticales paralelas)

1. **Telefonía por integración**: migración aditiva y endpoints tenant-scoped para `primary_phone` y `integration_phones[website|google_business_profile|facebook]`, cada `other_phone` distinto, selector país/prefijo, validación E.164, computar efectivo, RBAC y auditoría redactada. Conectar con ficha/configuración de negocio y previews simulados. Tests TEL-01..04.
2. **Agente/engagement**: añadir persistencia de interacciones entrantes, política versionada/opt-in, motor de decisión seguro, casos humanos y respuestas propuestas. Reutilizar `ReputationEngine` y el pipeline existente sin romper sus invariantes; habilitar autonomía en **simulación** solo cuando la política del negocio explícitamente la autorice.
3. **Google**: trabajo periódico para consumir reseñas (simulador existente, adapter), clasificar, atender con política o escalar. Completar gestión **simulada** de ficha de Google Business Profile / presencia Maps (datos básicos, estado de sincronización, previsualización). No fingir capacidad real de API Google.
4. **Facebook**: adaptar receptor simulado de comentarios entrantes por publicación, persistencia/dedupe + clasificación + respuesta simulada por política o revisión; conservar el flujo existente de crear, programar, aprobar y publicar posts/Ads básicos. No Instagram ni campañas avanzadas.
5. **Avisos unificados**: caso persistente visible en panel y notificable por Telegram ya vinculado, con enlace autorizado y tres borradores editables; sin mensajes repetidos y sin usar el número telefónico de contacto como chat de destino. Pruebas de desconexión y reintentos.
6. **E2E de producto completo**: cerrar alta asistida/one-use/login sin tenant_id, datos de negocio, panel y conectar flujo de web/Telegram/Facebook/Google; aprovechar la UI final de Claude Design al llegar. En paralelo usar UI mínima temporal solo si hace falta para validar el backend sin esperar su prototipo.
7. **Prueba y corrección:** ejecutar `npm run typecheck`, tests unit/integration/smoke/e2e y escenarios de contrato; smoke en ambiente local de desarrollo. Arreglar regresiones; commit/push de cada vertical útil hasta completar; evidencia breve final.

## Reglas de progreso autónomo

- Si un servicio requiere token, permiso externo o verificación de negocio que no está disponible, usar adaptador + simulador determinista (fail closed), probar y marcar la integración real pendiente. **No detener el trabajo restante**.
- Mantener consumidores/worker con cadencia configurable, idempotencia, backoff, locking y reanudación tras reinicio. Cuidado de rendimiento; evitar bucles infinitos, retries sin límite o publicar duplicados.
- Protección de proveedores y del cliente: contenido inseguro, no verificable o no autorizado se escala. Los modelos de IA no reciben autoridad decisoria por default; decisiones de autopublicación pasan por motor determinista de políticas explícitamente habilitado.
- No forzar push, no modificar `docs/ux/claude-design/**` (propiedad Claude), salvo integración posterior en `src/` y derivados con referencia al prototipo. Evitar tocar trabajo no relacionado.
- Una decisión material tomada: agregar 3-5 líneas a `DECISION-LOG.md`, no una sesión HDC. No pedir aprobaciones de diseño ni de ingeniería.
- Al terminar, entregar HEAD, pruebas reales, escenarios con fallos y dependencias externas. **No afirmar E2E de proveedores reales si solo probaste simuladores.**

## Contraste del backend actual (verificado al iniciar)

- `src/api/routes.ts`: login actual solicita `tenant_id`; hay que completar el nuevo flujo de invitación, evitando romper seguridad multi-tenant.
- `src/reputation/engine.ts` tiene `sync()`, plantillas, clasificación y `approveResponse`; `src/api/reputation-routes.ts` tiene sync manual y aprobación explícita. No hay observer continuo E2E ni política de respuesta automática.
- `src/social/service.ts` administra **publicaciones**, no ingesta/respuesta de comentarios.
- `src/reputation/google.ts`, `src/social/meta.ts` son parciales; mantenerlos opcionales y los providers simulados sin red como base verificable.
- `migrations/0001_schema.sql`: `client.metadata` no es modelo estable de contacto principal ni override por integración; agregar persistencia explícita compatible con esquema/operación actual.
- La UI actual no cubre todo el diseño. Incorporar iterativamente pantallas con contratos mientras Claude termina.

**Terminar E2E de desarrollo, sin HDC, sin producción y sin refactorizar innecesariamente.**
