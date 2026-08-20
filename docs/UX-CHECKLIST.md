# Checklist UX y accesibilidad — INC-001/INC-002/INC-003 (evidencia AC-008)

Aplicado sobre la UX mínima de backoffice (`src/api/ui.ts`), el flujo conversacional (mensajes del canal simulado) y la vista previa pública (`GET /preview/:token`). Marcado: `PASS` / `N/A` / `PARCIAL` / `PENDIENTE`.

## INC-001 (backoffice)

| # | Ítem | Estado | Cómo se verifica |
|---|---|---|---|
| 1 | Lenguaje claro, sin jerga técnica (REQ-001, NFR-001) | PASS | Textos de login/panel, `ACTION_LABELS` en español llano |
| 2 | Acciones distinguibles por perfil | PASS | `/me` entrega `permissions`; el panel renderiza solo acciones del perfil + badge de rol |
| 3 | Flujo completo sin instrucciones técnicas externas | PASS | Ingreso → panel → ver/registrar/auditar según perfil (smoke) |
| 4 | Estados de error comprensibles | PASS | Mensajes plain de `errors.ts` y rutas con `role="alert"` |
| 5 | WCAG aplicables al piloto (contraste, teclado, labels) | PARCIAL | Labels con `for`, navegación por teclado nativa, `lang="es"`; falta auditoría visual con navegador |
| 6 | Roles distinguibles sin depender solo de color | PASS | Badge de texto + clase |

## Panel ampliado (INC-001 backoffice — sección por rol y módulos)

| # | Ítem | Estado | Cómo se verifica |
|---|---|---|---|
| 7 | Sección clara por rol con badges (Administración/Operación/Solo lectura) | PASS | Card "Tu perfil": badge + descripción + chips de permisos reales en lenguaje llano (`renderRole`) |
| 8 | Acciones rápidas reales y funcionales | PASS | Formularios `data.write`/`operation.create`, lista de operaciones con Aprobar/Rechazar/Ejecutar, export de auditoría descargable, gestión de usuarios (admin) |
| 9 | Módulo website por permiso `website.*` | PASS | Card "Página web del cliente": estado, subdominio simulado, "Crear página web" si no existe, "Aprovisionar subdominio", enlaces de preview (usa `GET/POST /website(?:/provision)?`) |
| 10 | Módulo social por permiso `social.*` | PASS | Card "Redes sociales": listado de posts, crear borrador, programar/aprobar/rechazar (usa `GET/POST /social/posts` y verbos) |
| 11 | Módulo reputación por permiso `reputation.*` | PASS | Card "Reseñas y reputación": listado de reseñas + estado, sincronizar simulador, borrador de respuesta, escalar, aprobar (usa `GET /reputation/reviews` y verbos) |
| 12 | Módulo suscripción por permiso `subscription.*` | PASS | Card "Plan y límites": plan, estado y límites por capacidad (usa `GET /subscriptions/entitlements`); 404 sin plan se explica sin alerta |
| 13 | Errores visibles 403/API (fail visible) | PASS | Bloques con `role="alert"` por cada sección; confirmaciones con `role="status"` |
| 14 | Contrato `/me` consumido de forma fiable | PASS | El panel usa `display_name`/`tenant.business_name`/`role_label`/`permissions` del contrato estandarizado (test `me-contract`) |

## INC-002 (flujo conversacional / aprobaciones)

| # | Ítem | Estado | Cómo se verifica |
|---|---|---|---|
| 15 | Respuesta de consulta sin jerga (AC-005) | PASS | `read-answers.ts`: "El teléfono de contacto de … es …" |
| 16 | Confirmación detallada de cambios visibles (AC-006) | PASS | `confirmationText`: "Para continuar necesito que confirmes estos cambios: - Cambiar el teléfono de … a …" |
| 17 | Aviso claro en decisiones sensibles y bloqueos (AC-004/RULE-005) | PASS | Mensajes de escalamiento y de "No puedo inventar precios…" |
| 18 | Errores de estado/expiración comprensibles | PASS | "El enlace de vista previa expiró. Pide una nueva vista previa." (410) |
| 19 | Rate limiting con mensaje claro + `Retry-After` | PASS | "Hubo demasiados intentos de aprobación. Espera un momento…" |

## INC-003 (vista previa pública + sitio)

| # | Ítem | Estado | Cómo se verifica |
|---|---|---|---|
| 20 | Vista previa en lenguaje claro y botón único "Aplicar cambios" (AC-007) | PASS | `previewPageHtml`: resumen de cambios + botón + banner "aún no publicada" |
| 21 | Preview sin versión publicada ni marca de producción | PASS | `renderSite` sin `versión N` en preview; banner "Vista previa" |
| 22 | Páginas de enlace no válido / ya publicado / expirado | PASS | `previewNotFoundPageHtml` / `previewExpiredPageHtml` |
| 23 | Sitio del cliente accesible estructuralmente (encabezados, listas) | PASS | Template con `h1/h2`, `ul`, secciones semánticas |

## Hallazgos y pendientes

- Sin navegador en el entorno: las **capturas de pantalla** quedan PENDIENTES; los tests de smoke/E2E verifican señales estructurales y transcripts.
- El formulario de preview usa POST simple (sin JS): es accesible por teclado; si se convierte en SPA, mantener esta ruta accesible.
- Revisión visual de contraste y zoom recomendada antes de exponer a operadores reales.
- El panel ampliado depende de las APIs reales de los módulos; si una sección devuelve 403/error, muestra `role="alert"` visible sin romper el resto de la página.
