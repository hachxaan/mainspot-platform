# DEV-E2E-04 — Handoff 2: resultados y GO/NO-GO

Fecha: 2026-10-30. Rama: `feat/canonflow-implementation`. Continuación realizada exclusivamente con GPT-6.1 Sol, preservando la implementación local de los ejecutores previos.

Fuentes obligatorias leídas completas: [handoff en issue #6](https://github.com/hachxaan/mainspot-platform/issues/6#issuecomment-6518029471), [infraestructura issue #8](https://github.com/hachxaan/mainspot-platform/issues/8), `.omp/RULES.md`, `.omp/AGENTS.md`.

## Preservación y sincronización

- Se conservó `498e1a8`. La divergencia documental remota se integró mediante merge `26489d1368e12656d3987c76959e7aa0ecc7d1ae`, sin reset/rebase ni force push.
- `653873f`: custodia compartida de conexiones/tokens. `bb8774d`: herramienta de registro/status del webhook con guardas, no un registro real en Telegram.
- `c2dd5df`: implementación adicional y contratos; `d4b8c55`: regresión que impide rehidratar contenido de Google purgado y corte de variables globales en el lanzador LXD. La última suite completa pasó sobre ese contenido antes de confirmar el segundo commit; los reportes imprimen el HEAD de arranque más los cambios pendientes, no atribuyen esos cambios al HEAD anterior.

## Matriz de capacidades

| Capacidad | Estado real | Evidencia / límite |
|---|---|---|
| WEB-RESTORE | **REAL_VERIFIED local** | Chrome por el dominio HTTPS: publicar v1, cambiar v2, pedir restauración de v1, comparar, aprobar v3; historial intacto, nada en vivo antes de aprobar, persistencia tras reinicio |
| WEB-LOCAL | **REAL_VERIFIED local** | Dos negocios en `mainspot.local.io`, certificados mkcert confiables sin bypass, contenido aislado, API/health no expuestas bajo su Host |
| AUTH-RESET API/panel | **REAL_VERIFIED local** | Navegador HTTPS, enlace en memoria, cambio y login nuevo, contraseña/sesión antiguas y reuso rechazados. Transporte de esta prueba: `TestMailer`, no correo externo |
| AUTH-RESET entrega externa | **BLOCKED_EXTERNAL** | SMTP TLS obligatorio y Resend implementados; faltan proveedor/credencial/remitente y buzón autorizados. Aceptación por SMTP tampoco prueba llegada al buzón |
| Google conexión/ficha/reseñas/respuesta | **BLOCKED_EXTERNAL** | Adaptador OAuth offline/PKCE, ficha parcial/read-back, paginación, respuestas y retención implementados; regresiones HTTP falsas. Faltan cliente OAuth/proyecto con acceso GBP, negocio/ubicación y titular autorizados |
| Meta conexión/Page/posts/comentarios | **BLOCKED_EXTERNAL** | Graph v26.0, selección por negocio, tokens cifrados, read-back y ledger implementados; regresiones HTTP falsas. Faltan app/permisos efectivos, Page/token y titular autorizados |
| Meta Ads básicos | **BLOCKED_EXTERNAL separado** | Sin cuenta/configuración/alcance de gasto autorizados. Solo comprobación opcional de acceso en lectura; no campañas creadas, no gasto |
| Scheduler | **REAL_VERIFIED proceso local / proveedor simulado** | Proceso CLI detenido antes del vencimiento y reiniciado; dos procesos publican automáticamente con un solo claim/efecto/auditoría. Pruebas adicionales de crash/lease, incertidumbre, backoff, aprobación y cancelación; no acredita Facebook real |
| Telegram receptor local | **LOCAL_VERIFIED**, no extremo a extremo real | Trabajo preservado; secreto obligatorio, dedupe y recuperación probados localmente; no se reconstruyó la infraestructura |
| HTTP desde KVM autorizado → WireGuard → Express | **BLOCKED_EXTERNAL** | Un intento por el alias SSH autorizado `work.canonflow.dev` devolvió `Permission denied (publickey)`. No se adivinaron cuentas/claves ni se modificó KVM |
| Webhook Telegram auténtico | **BLOCKED_EXTERNAL** | Falta bot/token autorizado y completar la prueba desde KVM. No `setWebhook` real, no mensajes auténticos, no long polling |
| Reinicio completo del host / corte real de Starlink | **NOT_VERIFIED** | No hay ventana autorizada sin trabajo ajeno. No se reinició el host ni se cortó conectividad |

Sitios realmente disponibles **en el host de desarrollo**:

- https://cafe-brisa-sol.mainspot.local.io/
- https://taqueria-faro-sol.mainspot.local.io/
- Panel: https://app.mainspot.local.io/panel

No son DNS público. Otro dispositivo requiere resolución local y confianza en la CA. Límite medido: hostname desconocido sin entrada hosts no resuelve; forzar un Host arbitrario al proxy puede seleccionar el vhost por defecto (200). No se afirma un 404 universal de nginx; no se cambió su sitio por defecto ajeno. Express sí cubre el 404 del slug inexistente.

## P5 — hardening aplicado y verificado

- Custodia AES-256-GCM con AAD tenant/proveedor/propósito; sin tokens en respuestas de estado/exportaciones. OAuth state de un uso, expiración, proveedor/redirect fijo y autoridad activa comprobada al volver.
- Desconexión invalida states; renovación CAS no resucita credenciales revocadas ni pisa una renovación más nueva. La presencia de credenciales no se interpreta como autorización o verificación real.
- Administración conecta/selecciona/verifica/desconecta; Operación/Solo lectura reciben 403. Una Page o reseña de otro tenant no usa su token ni revela su recurso.
- Reset: SHA-256, vencimiento, un uso, serialización por correo, límites, respuesta neutra, revocación de sesiones y defensa frente a login concurrente con hash antiguo. No token de recuperación persistido en el navegador.
- Scheduler: outbox antes de red, aprobación en cada intento, claim de una fila, lease y fencing. No se adopta un post por texto coincidente. No se reenvía un resultado incierto porque un listado esté vacío. Cancelación antes de claim; publicación en curso/incierta no se anuncia cancelada. Un fallo de auditoría no se anuncia como tick exitoso.
- Fechas imposibles y horas DST inexistentes/ambiguas se rechazan, sin normalización silenciosa. El panel muestra la zona configurada; el navegador no reinterpreta `publish_local` con su zona.
- Google: purga operacional a 29 días, sin promedios sobre reseñas reales ni borrado/manipulación de opiniones; conserva respuestas propias y hechos operativos. Una reingesta no vuelve a guardar respuestas externas de una reseña ya purgada (regresión falló antes y pasó después). Exportar primero aplica retención. Baja elimina secretos/cursores y tokens de recuperación del último usuario de ese correo.
- Sitios: contenido publicado congelado, tenant activo, sin rutas administrativas; operación privilegiada fuera de Express; registro de provisión solo tras HTTPS validado.

### Decisión

**GO para pruebas locales controladas**, con proveedores simulados claramente identificados y los sitios HTTPS indicados.

**NO-GO para declarar DEV-E2E-04 externo completo o para producción.** Requiere cerrar los bloqueos auténticos de credenciales/consentimiento/proveedores, KVM, webhook y ventana de persistencia; revisar el ciclo de respaldos y la reaplicación de retención antes de ingresar contenido real de Google. No se modificaron respaldos, Gate 7, QS-0015 ni el pin de CanonFlow. Esta revisión local no es pentest ni certificación de proveedores.

## Evidencia reproducible

- `evidence/dev-e2e-04-handoff2.txt`: comandos, resultados y alcance de las suites.
- `evidence/website-restore-local-sites.txt`, `evidence/website-local-site/`: flujo real local de restauración, TLS y aislamiento.
- `evidence/password-reset-browser.txt`, `evidence/password-reset/`: navegador real con transporte de prueba y prerrequisitos visibles de proveedores.
- `evidence/social-scheduler-process.txt`: proceso CLI real, reinicio y dos workers con proveedor simulado.
- `evidence/social-scheduler-browser.txt`, `evidence/social-scheduler/`: Chrome en Tokio programa en la zona Nueva York, confirma UTC y rechaza una hora DST repetida.
- `evidence/security-handoff2-smoke.txt`: arranque fail-closed, RBAC, aislamiento/no exposición de secretos y callbacks inválidos.
- `docs/architecture/password-reset.md`, `real-provider-connectors.md`, `website-restore-local-sites.md`: contratos y operación.
- `docs/architecture/telegram-webhook-starlink.md`: pasos exactos para desbloquear KVM y webhook sin reconstruir nada.
- Scripts shell: `bash -n` para lanzador, provisión de sitio y despliegue LXD; `deploy-lxd.sh --help` ejecutado. **No se ejecutó un despliegue LXD**, no se reconstruyó ni se reinició infraestructura ajena.

Los scripts temporales de smoke se retiran después de ejercitarse; los reportes no incluyen tokens, contraseñas ni enlaces de invitación/recuperación activos. Las invitaciones se entregan solo al operador por el canal de la conversación, nunca en Git ni en las issues.
