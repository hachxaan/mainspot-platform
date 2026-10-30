# DEV-E2E-04 — prerequisitos externos y comprobación de capacidades

Esta checklist NO contiene secretos y NO demuestra que estén disponibles. El agente local debe completar estatus por conexión sin imprimir valores de claves, y no pedir que se peguen en prompts o issues.

| Integración | Prerequisito (sin valores) | Dónde aprovisionar | Bloqueo si falta |
|---|---|---|---|
| Google GBP | Proyecto Google Cloud con acceso aprobado a APIs GBP, cuota no cero | Google Cloud / Business Profile API access | BLOCKED_EXTERNAL_GBP_ACCESS |
| Google GBP | OAuth client, consent screen, scope business.manage, cuenta/ubicación verificada y autorización del titular | Google Cloud y Google Business Profile | BLOCKED_EXTERNAL_GBP_OAUTH / NO_LOCATION |
| Meta Pages | Meta App, usuario autorizado, Page ID/token, tasks y permisos de lectura/gestión de posts/comentarios | Meta for Developers / Page | BLOCKED_EXTERNAL_META_PERMISSIONS |
| Meta Ads básicos | Cuenta publicitaria y autorización explícita; no ejecutar gasto sin permiso adicional del titular | Meta Business/Ads | BLOCKED_EXTERNAL_AD_ACCOUNT |
| Telegram | Bot real de prueba con token seguro, chat del usuario de prueba, modo getUpdates sin webhook incompatible | Telegram @BotFather | BLOCKED_EXTERNAL_TELEGRAM_TOKEN |
| Email reset | SMTP o API transaccional con dominio/identidad remitente verificados y buzón de prueba | Proveedor de correo autorizado | BLOCKED_EXTERNAL_EMAIL_PROVIDER |
| Dominios locales | LXC webserver existente, CA local confiable y permiso acotado de provisión por hostname de cliente | Host de desarrollo / LXC | BLOCKED_LOCAL_INFRA |

## Políticas de evidencia
- IMPLEMENTED: código compilado + tests locales; **NO** presume conexión externa.
- CONNECTED: autenticación/comprobación de identidad y permisos ejecutada con proveedor real.
- REAL_VERIFIED: operación de negocio real + read-back, con consentimiento y evidencia saneada.
- BLOCKED_EXTERNAL: falta credencial/autorización/proveedor o habilitación de la plataforma.
- FAILED: prueba real ejecutada pero no cumple; arreglar o documentar antes de GO.
- SIMULATED_REGRESSION: pruebas con proveedores de mentira, no sustituyen REAL_VERIFIED.
- NOT_SUPPORTED: operación que la API/permiso vigente no puede realizar. No etiquetar como sincronizada.

## Documentación oficial de referencia
- Google acceso: https://developers.google.com/my-business/content/prereqs
- Google OAuth: https://developers.google.com/my-business/content/implement-oauth
- Google Reviews: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews
- Google políticas: https://developers.google.com/my-business/content/policies
- Meta Pages (colección oficial Meta): https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api
- Telegram Bot API: https://core.telegram.org/bots/api

**Privacidad:** no cargar archivos .env, capturas de consola con tokens ni dumps de cuenta a GitHub; si evidencia involucra contenido de clientes, sintetizar o redactar, y respetar retención legal/proveedor.
