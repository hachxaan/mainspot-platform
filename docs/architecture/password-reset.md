# Recuperación de contraseña — DEV-E2E-04 P2

## Contrato

- `POST /api/auth/password/forgot` recibe `login`; respuesta neutra para cuentas existentes, inexistentes o suspendidas. No devuelve enlaces ni pertenencias a negocios.
- Token aleatorio de 32 bytes, SHA-256 en `password_reset_token`, vigencia 30 minutos, un solo uso. Solicitudes posteriores invalidan los anteriores. Un candado consultivo por correo serializa solicitudes y canjes concurrentes.
- `POST /api/auth/password/reset` recibe `token` y `password`; aplica la política compartida con el alta. El cambio y la revocación de sesiones se confirman en una transacción. Un login que comprobó la contraseña antigua no puede crear una sesión después del cambio.
- Un correo asociado a varios negocios cambia las contraseñas de sus identidades activas con un solo enlace, sin enumerar negocios en el correo. No modifica cuentas suspendidas.
- Límites independientes por IP y correo, también para direcciones inexistentes; canje limitado. La respuesta de solicitud tiene un piso temporal de 250 ms, no una promesa de tiempo constante de red.
- El enlace usa `/restablecer#TOKEN`: el fragmento no se envía al servidor. El panel lo retira del URL y conserva el token solo en memoria, no en localStorage/sessionStorage. Shell `no-store` y política de referencia restrictiva.
- Auditoría: solicitud y resultado de transporte separados; no se registran correo, token, contraseña, cuerpo del mensaje ni credenciales SMTP. Un `sent` significa aceptación por el transporte, no prueba de llegada al buzón.
- Retención general elimina tokens vencidos con más de un día. La baja definitiva elimina los del correo cuando ya no queda otra identidad con ese correo.

## Transporte real implementado

`MAIL_TRANSPORT=disabled|smtp|resend` (deshabilitado por defecto).

| Transporte | Variables requeridas | Seguridad |
|---|---|---|
| SMTP | `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | `SMTP_SECURE=implicit` (465) o `starttls` obligatorio (587); validación de certificado; `SMTP_CA_FILE` opcional |
| Resend | `MAIL_FROM`, `RESEND_API_KEY` | HTTPS, `RESEND_BASE_URL=https://api.resend.com` por defecto |

No hay entrega simulada en producción ni enlace de depuración en las respuestas. Con el transporte deshabilitado la API sigue siendo neutra y persiste `delivery=disabled`; un fallo del proveedor queda `failed`, nunca `sent`.

## Operación y evidencia

- Migración `0021_password_reset.sql`; código `src/identity/password-reset.ts`, `src/mail/`, `src/api/password-reset-routes.ts`.
- Regresiones: `tests/integration/password-reset.test.ts`, `tests/unit/mailer.test.ts`. SMTP/HTTP falsos y buzón de prueba no acreditan entrega externa.
- La prueba de navegador y los resultados de la suite se registran en `evidence/dev-e2e-04-handoff2.txt`.
- **Entrega externa: BLOCKED_EXTERNAL**. Faltan transporte autorizado, credencial, remitente/dominio verificado y destinatario de prueba autorizado. No se ha enviado correo real ni se afirma llegada a un buzón.
- Para cerrar: configurar secretos fuera de Git, solicitar el enlace desde el panel, conservar identificador de aceptación del proveedor sin el enlace y confirmar recepción en el buzón; canjear, comprobar contraseña nueva, rechazo de la anterior y de sesiones previas. No publicar el token del enlace como evidencia.
