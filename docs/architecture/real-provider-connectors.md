# Conectores por negocio y scheduler — DEV-E2E-04 P1/P4

## Estado de este trabajo

Implementaciones reales, pero **sin verificación autenticada contra Google ni Meta**: faltan proyectos/apps y negocios/Páginas autorizados. Las regresiones inyectan HTTP falso; PostgreSQL y el scheduler sí ejecutan su código normal. La matriz y los resultados observados están en `docs/handoffs/e2e-parallel-2026-10-29/HANDOFF-2-RESULTS.md` y `evidence/dev-e2e-04-handoff2.txt`.

No existe fallback de un conector real fallido a simulación. `REPUTATION_PROVIDER=simulated` y `SOCIAL_PROVIDER=simulated` son selecciones explícitas. El lanzador local usa `MAINSPOT_DEV_GOOGLE=real` / `MAINSPOT_DEV_META=real` para activarlos deliberadamente; requiere `CONNECTOR_TOKEN_KEY`. No habilitarlos por detectar una credencial.

## Custodia y autorización compartidas

- `0020_provider_connection.sql`: conexiones por `(tenant_id, provider)` y OAuth state SHA-256, con vencimiento y consumo único. El callback vuelve a comprobar usuario, negocio y rol Administración activos; una sesión OAuth de alguien suspendido no autoriza el negocio.
- `src/connectors/secret-box.ts`: AES-256-GCM, AAD de tenant/proveedor/propósito. `CONNECTOR_TOKEN_KEY`: base64 de 32 bytes, fuera de Git; `token_key_id` es una huella SHA-256 truncada derivada, no una variable adicional ni la clave. No se exportan tokens ni verificadores.
- Los callbacks solo redirigen al panel configurado. No incluyen tokens en URL, HTML, auditoría ni errores. La API de estado entrega metadatos de conexión, no el secreto.
- Desconectar borra el token cifrado e invalida los states pendientes. La renovación usa compare-and-swap del ciphertext: una respuesta tardía no recupera una conexión revocada ni pisa otra renovación. Comprobaciones tardías no cambian `disconnected` a `connected`.
- `src/api/google-connection-routes.ts` y `meta-connection-routes.ts`: acceso de lectura protegido y mutaciones solo de Administración, bajo el tenant de la sesión.

## Google Business Profile

Código: `src/google/{oauth,client,connection,location,reviews,integration,retention}.ts`. Migración `0024_google_business_profile.sql`.

1. OAuth web con `business.manage`, acceso offline y PKCE S256. Variables `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (por defecto `PUBLIC_BASE_URL/api/connections/google/callback`). Se requiere proyecto con acceso aprobado a GBP, APIs habilitadas y usuario autorizado.
2. Account Management `accounts.list`; Business Information `accounts/{id}/locations` y `locations/{id}`. Sin identificadores inventados. El administrador elige una ubicación si hay varias; se lee antes de marcar conexión utilizable.
3. Ficha: PATCH con `updateMask` limitado a nombre, descripción, teléfono, web y horario; GET posterior compara campo por campo. Categoría, dirección y coordenadas restringidas permanecen pendientes explícitos. Google puede rechazar o exigir verificación adicional: no se anuncia sincronización por haber enviado el PATCH. El panel muestra aparte la lectura actual de Google.
4. Reseñas: My Business v4 `accounts/{id}/locations/{id}/reviews`, paginación completa, detección de cursor repetido, solapamiento e ingesta por identificador. El cursor solo avanza al persistir todo el lote. No se modifica ni oculta ninguna reseña.
5. Respuestas: GET previo → PUT `.../reviews/{id}/reply` → GET de confirmación. No se sobreescribe una respuesta externa automáticamente; la aprobación humana es explícita. Un recurso de otra ubicación se rechaza antes de llamar.
6. 401 renueva una sola vez; revocación exige reconexión. 403, cuota/429, timeout y fallos de lectura no se convierten en éxito.
7. Retención: purga a los 29 días (margen respecto al máximo oficial de 30), al arranque y cada 15 minutos, además de `RetentionService.run` y antes de exportar datos. Borra texto, autor y borradores copiados a casos/propuestas/conversaciones; mantiene hechos operativos y respuestas propias. No calcula promedios sobre reseñas reales. La baja elimina conexiones, states y cursores. Una copia de respaldo restaurada debe volver a aplicar las políticas antes de volver a servir/exportar datos.

Prueba: `tests/integration/google-connector.test.ts` (HTTP falso; OAuth/state/PKCE, cifrado, renovación, desconexión concurrente, usuario suspendido, ficha parcial/read-back, paginación, respuesta, aislamiento, errores, purga).

Provisionar un token de laboratorio mediante `scripts/google-provision-lab-token.ts` es una alternativa de operación, no un sustituto de consentimiento ni evidencia de OAuth real. El token entra por archivo 0600 del mismo usuario o stdin, nunca por entorno, argumentos o salida.

Fuentes oficiales consultadas:

- [OAuth para aplicaciones web](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Business Information locations.patch](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/patch)
- [My Business v4 reviews](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews)
- [Políticas GBP y almacenamiento](https://developers.google.com/my-business/content/policies)

## Meta Pages y comentarios

Código: `src/social/meta-graph.ts`, `meta-engagement.ts`, `src/api/meta-connection-routes.ts`.

- Graph API versionada: `META_GRAPH_VERSION=v26.0`; `META_APP_ID`, `META_APP_SECRET`. OAuth code flow y state de un uso; intercambio a token de usuario de larga duración, `me/accounts` paginado y selección de una Page autorizada con tarea de publicación. El Page token se cifra por negocio. Verificación de permisos y lectura de Page; un token que solo permite leer no se llama conectado para publicar.
- Permisos: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`; App Review/Business Verification y autorización del dueño dependen del modo de la app y del uso real. No prometer acceso público con una app de desarrollo.
- Posts: POST `/{page-id}/feed`, luego GET `/{post-id}` compara id y mensaje. Una escritura con timeout o lectura posterior fallida queda incierta, nunca publicada por suposición.
- Comentarios: lectura paginada de los posts publicados del negocio, sin avanzar el cursor tras un lote incompleto; se excluyen comentarios propios. El caso debe pertenecer al tenant antes de responder. Libro durable `provider_reply_ledger` evita dos envíos concurrentes; un resultado incierto se reconcilia o requiere revisión humana, no se reenvía porque un listado esté vacío.
- `scripts/meta-provision-page-token.ts`: alternativa explícita para una Page de laboratorio autorizada. No se rastrean respaldos buscando credenciales.
- **Ads básicos: BLOCKED_EXTERNAL separado**. `META_ADS_CHECK=on` añade únicamente `ads_read` y permite comprobar cuentas en modo lectura. No crea campañas ni autoriza gasto. No hay cuenta publicitaria/configuración/alcance de gasto autorizados en este entorno; no se hicieron escrituras publicitarias. Campañas avanzadas e Instagram siguen fuera del alcance.

Fuentes oficiales: [changelog v26.0](https://developers.facebook.com/docs/graph-api/changelog/version26.0/) (29-07-2026), [Pages API](https://developers.facebook.com/docs/pages-api/), [Page feed](https://developers.facebook.com/docs/graph-api/reference/page/feed/), [permisos](https://developers.facebook.com/docs/permissions/).

## Scheduler automático y recuperación

Migración `0023_social_scheduler.sql`; `src/social/scheduler.ts`.

- El servidor arranca el bucle con `SOCIAL_SCHEDULER=on` (por defecto), `SOCIAL_SCHEDULER_INTERVAL_MS=15000`. Puede operarse aparte con `node scripts/social-scheduler.ts`; múltiples workers coordinan en PostgreSQL.
- Tiempos almacenados en UTC; `SOCIAL_SCHEDULER_TIMEZONE=America/Cancun`. `publish_local` se interpreta en esa zona, no en la del navegador; horas ambiguas/inexistentes por DST se rechazan. `publish_at` admite ISO con zona.
- La aprobación humana materializa la cola. Para Meta, también la publicación inmediata entra en la cola durable **antes** de cualquier llamada externa. Una propuesta aprobada no significa que el post ya esté publicado: el estado del post y su referencia externa son la evidencia de entrega.
- Claim de una fila justo antes de procesarla: `FOR UPDATE SKIP LOCKED`, lease y `claim_token`. Cada intento comprueba evidencia de aprobación. Sin ella, `blocked` y ninguna llamada al proveedor.
- Errores inequívocos reintentables usan backoff acotado y Retry-After; autenticación/permisos definitivos fallan sin bucle de reenvío. Un lease real vencido pasa a `uncertain`, no a la cola de escritura.
- La reconciliación adopta únicamente el id externo conocido y su contenido confirmado. Un post con el mismo texto no prueba que sea nuestro envío. Sin id o con resultado no observable: revisión humana (`uncertain_needs_review`), no reenvío automático.
- La finalización está cercada por claim: un dueño tardío no pisa al nuevo. Caída del proceso recuperable con la cola persistida, sin dependencia de una pestaña abierta ni del endpoint manual `process-due`.

Prueba: `tests/integration/meta-scheduler.test.ts`: temporizador automático, dos workers, aprobación, leases, timeout/read-back, cuota/auth, aislamiento, comentarios concurrentes y outbox de publicación inmediata. Proveedor falso: no constituye publicación real en Facebook.
