# Restauración de versiones de la página web y sitios locales HTTPS por negocio (DEV-E2E-04 · P3)

Estado: ver matriz al final. Alcance: desarrollo/piloto controlado; **ningún DNS público**, nada en Internet.

## 1. Restaurar una versión («Restaurar esta versión»)

### Modelo

- `website_content` conserva un snapshot por versión publicada. P3 añade (migración `0022_website_restore_local_site.sql`):
  - `data JSONB`: los datos de negocio con los que se renderizó la versión (antes solo se guardaba el HTML). Backfill para versiones previas desde `action_proposal.detail.after` de la propuesta que las publicó.
  - `restored_from_version INT`, `restored_from_content_id TEXT` (FK a `website_content`): referencia a la versión origen cuando la versión nació de una restauración.
- **Nunca se reescribe ni se borra una versión.** Restaurar la versión N crea la versión M+1 (M = publicada) con el contenido de N. El historial sigue siendo lineal, auditado y completo.

### Flujo (mismo pipeline que cualquier cambio: propuesta → vista previa → aprobación humana → publicación)

1. `POST /api/backoffice/website/versions/:version/restore` con `{ "expected_current_version": M }` y cabecera `Idempotency-Key` (opcional; sin ella se usa el `request_id`). Permiso `conversation.confirm` (Administración y Operación pueden *pedir* la restauración; Solo lectura no).
   - Crea una propuesta `website.restore` (`capability_target = website`, `action_class = preview_required`) con `detail = { after, diff_sentences, patches, restore: { source_version, source_content_id, current_version, idempotency_key } }` y la deja en `preview_ready` (vista previa lista), igual que `website.initial` / `website.phone` (`src/website/site-proposals.ts`, `prepareRestore`).
   - `after` = datos de la versión N con el **teléfono efectivo actual** del canal Página web (una sola fuente del número, igual que al publicar cualquier versión). `patches` = diff «actual vs solicitada» campo a campo (nombre, frase, descripción, horario, dirección, correo, lo que vendes, secciones) en los mismos `field` que ya entiende el panel.
   - Auditoría: `website.proposal.prepared` (result `website.restore`) y `website.restore.requested` (resource `website_content/<content_id origen>`, result `v<N>_over_v<M>`, `evidence_ref` = proposal_id).
2. Vista previa en el panel (`#/vista-previa/<id>`): «Esto es lo que cambia» (diff) y comparador **Antes / Después** (actual vs solicitada), reutilizando la pantalla existente. Nada cambia en la página.
3. Aprobación: `POST /conversation/proposals/:id/approve` exige `operation.approve` (**solo Administración**). Publica mediante `WebsitePublisher` como versión nueva; `website_content` guarda `data`, `restored_from_version` y `restored_from_content_id`; `client_website.data/published_version` avanzan. El sitio local sirve la nueva versión de inmediato.

### Protecciones

| Riesgo | Protección | Respuesta |
|---|---|---|
| El cliente mira una lista desactualizada (otra persona publicó) | Guard optimista al pedir: `expected_current_version` ≠ `published_version` real | `409 stale_version`, no se crea propuesta |
| La versión en vivo cambia entre la vista previa y la aprobación | Comprobación en `approveAndPublish` (`detail.restore.current_version` vs real) antes de tocar estado | `409 stale_version`; la propuesta sigue `preview_ready` (descartar y pedir de nuevo) |
| Carrera entre esa comprobación y la escritura | `WebsitePublisher` bloquea la fila del sitio con `FOR UPDATE` y repite el guard dentro de la transacción | `409 stale_version`, rollback sin fila nueva ni éxito ficticio |
| Doble clic / reintento de red | `Idempotency-Key` guardada en `detail.restore.idempotency_key`: la misma clave devuelve la misma propuesta (en cualquier estado, incluso ya publicada); una abierta para la misma versión se reutiliza; una abierta para otra versión se descarta antes de crear la nueva (candado consultivo por tenant) | 200 `replayed: true`; nunca dos propuestas ni dos versiones |
| Doble aprobación | Idempotencia ya existente de `approveAndPublish` (`already_published`) | 200 `already_published` |
| Restaurar la versión publicada o una inexistente | Validación | `409 validation_error` / `404 not_found` |
| Versión antigua sin datos (ni `data` ni propuesta) | `restorable=false` en la lista; el botón no aparece | `409 version_not_restorable` |
| RBAC | Operación: pide pero no aprueba (`403`); Solo lectura: ni pide ni aprueba (`403`) | auditado por `requirePermission` |
| Aislamiento | Todas las consultas por `tenant_id` + `website_id`; la propuesta de otro negocio es `404` anti-oráculo | sin filtración cross-tenant |

### Panel («Mi página»)

- Lista «Versiones publicadas» (`GET /website` → `versions[]` con `restored_from_version` y `restorable`). Cada versión no publicada muestra **«Restaurar esta versión»** (si el perfil puede confirmar y la página está publicada). La versión restaurada indica «(restaurada de la versión N)».
- Confirmación (`UI.sheet`) → `POST …/restore` con `Idempotency-Key` y `expected_current_version` = versión que el panel muestra → vista previa «actual vs solicitada» → aprobación por Administración → `#/aprobado/<id>`.

## 2. Sitio local REAL por negocio: `https://<slug>.mainspot.local.io`

### Diseño

- Hostname = `client_website.slug` (UNIQUE) + `LOCAL_SITE_DOMAIN` (`mainspot.local.io` por defecto; `src/shared/config.ts`). Slug válido: etiqueta DNS `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`; `app`, `www`, `api`, `panel`, `admin` reservados.
- **Routing en Express** (`src/website/local-site.ts`, montado tras `requestContext()` y antes de `/api/auth`): si `Host` es `<slug>.<dominio>` (nunca el host de `PUBLIC_BASE_URL`) sirve `GET|HEAD /` con el HTML **congelado** de `website_content.version = client_website.published_version` (`status = 'published'`). Otra ruta, método, slug desconocido, sitio sin publicar o suspendido ⇒ `404` (misma página; sin oráculo). Cabeceras de seguridad comunes (`CSP`, `HSTS`, `nosniff`, `X-Frame-Options`, `Referrer-Policy`) + `Cache-Control: no-store`. Bajo el host del sitio no existen ni API ni panel.
- **Provisión de infraestructura** = comando de OPERACIÓN privilegiado e idempotente, **nunca desde el proceso web**: `scripts/client-site-provision.sh <slug> [--renew|--remove]`:
  0. El negocio debe existir en `mainspot_dev` (`scripts/client-site-register.ts lookup`).
  1. `/etc/hosts` del host: línea explícita `10.209.99.101 <slug>.mainspot.local.io` (sudo, copia `/etc/hosts.bak-mainspot-site-<ts>`, nunca borra otras líneas; `/etc/hosts` no admite comodines).
  2. Certificado para ese hostname exacto con la CA local mkcert (ya confiable en el sistema y en NSS de Chrome). Se copia al LXC `webserver` por `lxc exec … sh -c 'cat > …'` (snap lxc no lee /tmp); clave `0600` solo en el LXC; la copia local se destruye con `shred`.
  3. Vhost propio desde `scripts/deploy/client-site.conf.template` (HTTP/1.1, **sin `http2`**, `allow 10.209.99.1/127.0.0.1/::1; deny all`, `proxy_pass http://10.209.99.1:3100`, `proxy_set_header Host <slug>.mainspot.local.io`), `nginx -t` y `systemctl reload nginx`.
  4. Comprobación HTTPS con TLS verificado (sin `-k`); reintenta brevemente mientras nginx termina la recarga. Si falla, no registra una provisión exitosa.
  5. Registro en BD solo después: `client_website.local_site_status = 'provisioned'`, `local_site_hostname`, `local_site_provisioned_at`, `local_site_cert_not_after` + auditoría `website.local_site.provisioned` (actor `operator:cli`). El proceso web **solo lee** estas columnas y las muestra en «Mi página». Sin sudo en el proceso web.
  - `--remove`: baja controlada SOLO de ese sitio (línea exacta de hosts con copia de seguridad, vhost, cert/clave con shred, reload, `local_site_status = 'removed'`).
- El bootstrap de `app.mainspot.local.io` no se toca; cada sitio es una provisión de negocio independiente. No hay DNS público ni se modifican otros sitios del LXC.

### Seguridad y datos

- Solo se sirve contenido ya aprobado y publicado; los borradores y vistas previas nunca salen por el hostname del sitio.
- Aislamiento: slug UNIQUE + join por `website_id` y `tenant_id`.
- Certificados: CA local únicamente; claves privadas fuera de Git y fuera del host (solo en el LXC).
- Resolución únicamente en el host de pruebas (`/etc/hosts`); otros dispositivos necesitarían su propia entrada y la CA local (no se afirma lo contrario).

## 3. Estados

| Capacidad | Estado | Evidencia |
|---|---|---|
| WEB-RESTORE (API + panel + aprobación + historial intacto + guard + idempotencia + RBAC + tenant) | **REAL_VERIFIED local** | Chrome por el dominio del panel; v1→v2→restaurar v1 como v3; diff, aprobación, historial y reinicio; `evidence/website-restore-local-sites.txt` y capturas `evidence/website-local-site/` |
| WEB-LOCAL (`https://<slug>.mainspot.local.io`, TLS válido, aislamiento, persistencia) | **REAL_VERIFIED local** | `https://cafe-brisa-sol.mainspot.local.io/` y `https://taqueria-faro-sol.mainspot.local.io/`, Chrome sin bypass y Node/curl con CA local |

Límite observado: un hostname desconocido sin `/etc/hosts` no resuelve; forzándolo a la IP, nginx puede seleccionar su vhost por defecto (HTTP 200). No se afirma un 404 de proxy para hosts arbitrarios. Express sí responde 404 a un slug de negocio inexistente cuando recibe ese Host, cubierto por integración. No se cambió el vhost por defecto ajeno a esta provisión.

## 4. Operación

```
scripts/client-site-provision.sh <slug>            # alta idempotente
scripts/client-site-provision.sh <slug> --renew    # reemitir certificado
scripts/client-site-provision.sh <slug> --remove   # baja controlada de ese sitio
```

Requisitos del operador: `sudo` (hosts), `lxc` sobre el LXC `webserver`, `mkcert` con la CA local instalada, `.env` con `DATABASE_URL` (BD `mainspot_dev` por `MAINSPOT_DEV_PG_PORT`/`MAINSPOT_DEV_DB`). El script admite únicamente `LOCAL_SITE_DOMAIN=mainspot.local.io`; variables de destino: `MAINSPOT_SITE_LXC`, `MAINSPOT_SITE_LXC_IP`.
