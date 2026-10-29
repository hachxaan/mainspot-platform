# Decisiones operativas — desarrollo E2E

Este registro **no** es HDC/DEC ni pretende modificar documentos históricos. Un registro por decisión material, breve; el objetivo es dejar trazabilidad **sin bloquear implementación**.

## 2026-10-29 · Autonomía de desarrollo y trabajo paralelo

- **Fuente:** instrucción explícita del propietario en esta conversación.
- **Decisión:** SOL MAIN y Claude Design trabajan en paralelo, resuelven detalles de desarrollo conforme a buenas prácticas y pruebas, **sin sesiones ni gates HDC** para esta tanda; se conserva distinción de producción y autorizaciones de clientes.
- **Razón:** el backend ya dispone de cimientos, contratos y controles; el propietario quiere cerrar el flujo E2E sin burocracia.
- **Límites:** no tocar Gate 7 / QS-0015 / respaldos, no usar cuentas externas reales sin permisos, no manipular reseñas y no confundir automatismo seguro bajo política con aprobación universal.
- **Evidencia esperada:** tests E2E y commits de cada frente. El trabajo posterior a esta autorización aún **no** ha sido ejecutado por los agentes.

## 2026-10-29 · Número alternativo por integración

- **Fuente:** aclaración del propietario «El otro número puede ser diferente siempre. No otro número único».
- **Decisión:** un `other_phone` independiente para cada uno de **website**, **google_business_profile**, **facebook**, además de un `primary_phone` compartido para el modo `own`. No existiría un número alternativo global.
- **Razón:** cada integración puede presentar un contacto diferente.
- **Prueba obligatoria:** TEL-01 (3 overrides distintos al mismo tiempo), TEL-02 (cambiar solo uno no altera otros), TEL-03 (primario modifica solo modos `own`).

## 2026-10-29 · SOL MAIN · Teléfonos por integración (TEL-01..04)

- **Decisión:** tablas `business_contact` (principal) e `integration_phone` (una fila por `website`, `google_business_profile`, `facebook`, cada una con su `mode` y su propio `other_*`). API `GET /api/backoffice/contact/phones`, `PUT …/primary`, `PUT …/integrations/:channel` (lectura `data.read`; escritura `client.config.manage`).
- **Razón:** columnas explícitas en vez de `client.metadata`; UPSERT por `(tenant, channel)` evita pisar canales hermanos. `other→own` conserva el override; solo `other_phone: null` lo borra. Validación E.164 con `libphonenumber-js` (metadatos completos), errores por campo.
- **Web:** la vista previa y la publicación usan el teléfono efectivo de `website` (si existe configuración); sin configuración se conserva el teléfono del sitio. Límite: el cambio conversacional «cambia el teléfono» sigue editando el campo del sitio; con teléfonos configurados manda la configuración del canal.
- **Proveedores:** Google/Facebook marcan `sync.mode=simulated` sin credenciales y `not_verified` con credenciales; nunca se afirma sincronía real.
- **Evidencia:** `tests/integration/contact-phones.test.ts` (6/6 PASS). Auditoría sin dígitos.
