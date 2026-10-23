# Evaluación técnica — runtime de publicación por tenant, proxy, DNS y TLS

**Estado:** definición técnica (DEC-0043 §1 «Evaluar LXC/LXD frente a contenedores de aplicación ligeros»). **No autoriza construcción**: la publicación real va tercera en el orden de producto (DEC-0044: alta y panel → Telegram → publicación real). Todo lo marcado **PROPUESTA** está sin decidir; lo decide el propietario vía HDC.

**Fecha de medición:** 2026-10-22, host de desarrollo local (ver §A.1). Cada número de este documento sale del Apéndice A (comando + salida cruda) o de una fuente primaria con URL.

---

## 1. Contexto (decisiones citadas)

| Registro | Qué fija para este documento |
|---|---|
| `DEC-0042` (`.canonflow/decision-records/DEC-0042.md`) | `web_en_mainspot`: MainSpot sirve el sitio publicado en el subdominio; Hostinger solo gestiona el DNS. Preview y aprobación siguen en MainSpot (FLOW-002), **cada versión publicada se conserva en la BD** para volver a publicarla, el token de Hostinger sigue fuera del repo. |
| `DEC-0043` (`.canonflow/decision-records/DEC-0043.md`, texto literal normativo) | §1 un contenedor independiente por negocio, imagen base endurecida y versionada, recursos limitados, aislamiento de red, FS de publicación protegido, **sin credenciales ni acceso directo a la BD central**; evaluar LXC/LXD vs contenedores de aplicación («no obliga a una distribución Linux completa por negocio»). §2 DNS wildcard hacia el punto de entrada, HTTPS wildcard con renovación automática «sujeto a verificación técnica». §3 proxy inverso con rutas dinámicas por hostname generadas desde el registro autorizado, sin enrutamiento entre tenants, **sin cambios manuales ni reinicios generales del proxy por alta**, preservar distribución entre nodos. §4 trabajos asíncronos, auditados, idempotentes; estados `REGISTERED, PREPARING, CONFIGURING, VERIFYING, ACTIVE, FAILED, RETRY_PENDING`; no declarar activo sin verificar HTTPS + hostname + contenido; reconciliación cada 5 min. §6 medir CPU, memoria, almacenamiento, tiempo de aprovisionamiento y costo por contenedor; «no confundir contenedorización con aislamiento absoluto»; el piloto debe demostrar que publicar/actualizar/suspender/eliminar un tenant no afecta a otros. Cierre: cualquier desviación del canon sobre tipo de contenedor, recursos o fronteras de aislamiento se reconcilia vía CanonFlow antes de implementar. |
| `DEC-0044` | Orden: alta y panel → Telegram → publicación real. |
| `DEC-0004` | Dominio real y DNS real en el piloto (sustituye `<slug>.sim.mainspot.local`). |

### 1.1 Qué es hoy un «sitio publicado»

- `src/publishing/website.ts` (`WebsitePublisher.publish`): tras aprobación humana renderiza `renderSite(data, { version })` (`src/website/template.ts`) e **inserta el HTML completo** en `website_content(version, html, …)`; actualiza `client_website.published_version`. No hay ficheros ni servidor: el «sitio» es una fila con un documento HTML autocontenido (CSS inline).
- `migrations/0005_website_domain.sql`: `client_website` (1 fila por tenant, `slug` único, `status ∈ draft|published|suspended`), `client_domain` (estado de DNS/cert, `provider ∈ simulated|hostinger`), `website_content` (snapshot por versión, `UNIQUE (website_id, version)`). El comentario de la migración ya dice «La web reside en el contenedor del cliente (DEC-017)».
- `src/domain/hostinger.ts`: adaptador real **TENTATIVA** con endpoints inventados (`/v1/dns/records`, `/v1/certificates`) que no coinciden con la API pública de Hostinger (ver §5.2). Hostinger no emite certificados en el modelo de DEC-0042.
- El sitio de prueba de este documento se generó con ese mismo `renderSite`: **1 770 bytes**, sha256 `20640fba…2207d` (§A.2).

Consecuencia: el contenedor de un tenant solo necesita servir **un árbol estático pequeño y de solo lectura** (hoy un `index.html`). Nada de runtime de aplicación, ni BD, ni secretos.

---

## 2. Qué se midió

Mismo sitio (§1.1), mismo servidor (nginx, `worker_processes 1`), mismos límites por instancia: **32 MiB RAM, 25 % de 1 CPU (`25000/100000`), 32 PIDs**. 10 instancias de cada tipo. Red solo interna / 127.0.0.1.

- **(a) LXC/LXD** — contenedor de sistema **no privilegiado**, `images:alpine/3.22` + `nginx 1.28.3` (apk), publicado como imagen local; sitio montado como `disk` `readonly=true`. Pool LXD `default` con driver `dir` (el que usa este host).
- **(b) OCI/Docker** — `nginxinc/nginx-unprivileged:1.27-alpine` (nginx 1.27.5, ya presente en el host) con `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges:true`, `--user 101:101`, `--memory 32m --memory-swap 32m --cpus 0.25 --pids-limit 32`, sitio y `nginx.conf` montados `:ro`, red `--internal`.
- Referencia: un contenedor LXD `images:debian/12` sin nginx, para el coste de «distribución completa».

Memoria = `memory.current` del cgroup v2 de cada instancia (lo que el kernel le carga); RSS sumado sobrecuenta páginas compartidas (§A.3: 7,7 MiB de RSS vs 2,0 MiB de cgroup en OCI).

---

## 3. Comparativa medida

| Métrica (por instancia salvo indicación) | LXC/LXD Alpine + nginx | OCI nginx-unprivileged endurecido | Fuente |
|---|---|---|---|
| Memoria en reposo (`memory.current`) | 3,39–3,41 MiB (3 551 232–3 571 712 B) | 2,03–2,05 MiB (2 125 824–2 150 400 B); la 1.ª instancia 4,83 MiB porque se le cargan 2,9 MB de page cache compartida | §A.3, §A.5 |
| Memoria anónima en reposo | ≈2,38 MB | ≈1,52 MB | §A.3, §A.5 |
| **10 instancias, total `memory.current`** | **35 606 528 B (33,96 MiB)** | **24 322 048 B (23,2 MiB)** | §A.3, §A.5 |
| Procesos en reposo | 7 (init, syslogd, crond, udhcpc, getty, nginx×2) | 2 (nginx master + worker) | §A.3, §A.5 |
| `memory.peak` tras 10 s de carga (32 conexiones) | 8 163 328 B (7,79 MiB) | 5 713 920 B (5,45 MiB) | §A.4, §A.6 |
| Throughput con 0,25 CPU, 32 conexiones, 10 s | 15 677 req/s; p50 0,67 ms; p99 60,45 ms | 17 752 req/s; p50 0,63 ms; p99 58,75 ms | §A.4, §A.6 |
| Imagen en disco | 4,69 MiB (imagen LXD comprimida) | 73,7 MB en disco (21 MB de contenido comprimido); compartida | §A.3, §A.5 |
| Disco por instancia | **≈13 MiB** (pool `dir`: copia completa del rootfs); `du -sh` de una: 14M; 10 instancias = 133 680 KiB (media 13,05 MiB) | **12,3 kB** (capa escribible; el rootfs es la imagen compartida) | §A.3, §A.5 |
| Arranque en frío hasta HTTP 200 (imagen local) | 3 127–4 078 ms (mediana ≈3,73 s), `init`+`device add`+`start` | 151–229 ms (mediana ≈194 ms), `docker run` | §A.3, §A.5 |
| Desglose LXC | `init` 278 ms · `device add` 117 ms · `start` 333 ms · IPv4 por DHCP a 1 269 ms · HTTP 200 a 3 338 ms | — | §A.7 |
| Re-arranque de instancia detenida → 200 | 2 105 ms (`lxc stop` tardó 3 142 ms) | 157 ms (`docker stop` 161 ms) | §A.7 |
| Sustituir base de 1 instancia | `lxc rebuild` 270 ms + arranque → 200 en 3 476 ms | `rm -f` + `run` → 200: 165–214 ms; **10 instancias en serie: 3 632 ms** | §A.8 |
| Límite de PIDs (32) | aplicado: `can't fork`, `pids.events max 1` | aplicado: `can't fork`, `pids.events max 1` | §A.4, §A.6 |
| Exceso de memoria (asignar 64 MB en un shell con límite 32 MiB) | `oom_kill 2`; nginx relanzó el worker; **el sitio siguió en 200** | `oom_kill 2`; **el contenedor terminó** (`OOMKilled=true`, sin política de reinicio → sitio caído) | §A.4, §A.6 |
| Vecino durante el OOM | 200 | 200 | §A.4, §A.6 |
| Referencia Debian 12 (systemd, sin nginx) | 28 139 520 B de memoria, 12 PIDs, 439 MiB de disco | — | §A.9 |

### 3.1 Densidad (aritmética sobre lo medido, `[INFERENCE]`)

Solo memoria de cgroup; excluye estructuras de kernel por instancia (netns, veth, conntrack), proxy, BD y SO del nodo.

| Por GiB de RAM | LXC/LXD Alpine | OCI |
|---|---|---|
| En reposo (media de las 10: 3,40 MiB vs 2,32 MiB) | ≈301 | ≈441 |
| Con el pico medido bajo carga (7,79 vs 5,45 MiB) | ≈131 | ≈188 |
| Disco para 1 000 tenants (pool `dir` / capa escribible) | ≈12,7 GiB | ≈12 MB + 1 imagen |

Con un pool LXD btrfs/zfs/LVM la creación y el almacenamiento de imagen son optimizados (CoW); con `dir` no ([LXD storage drivers, tabla «Optimized image storage / instance creation»](https://documentation.ubuntu.com/lxd/stable-5.21/reference/storage_drivers/)). No se midió otro pool (el btrfs del host pertenece a otro proyecto).

Lectura: con un sitio de 1,7 KB el coste está dominado por el runtime, no por el contenido. LXC paga un init y servicios de sistema por tenant (×1,46 de memoria, ×1 100 de disco por instancia en `dir`, ×19 de tiempo de arranque); el cuello de botella de throughput es la cuota de CPU en ambos (100 periodos throttled en 10 s en ambos).

---

## 4. Seguridad, mantenibilidad y operación

### 4.1 Controles de seguridad (medidos en §A.10–§A.13)

| Control | LXC/LXD (como se lanzó) | OCI (como se lanzó) |
|---|---|---|
| Usuario del servidor | root **dentro** del userns; en el host UID 1000000 | UID 101 sin privilegios; en el host **UID 101 real = `messagebus`** (no hay userns: `uid_map 0 0 4294967295`) |
| User namespace | sí, por defecto. Mapa **compartido** por todos los contenedores (`Hostid 1000000, range 1e9`); con `security.idmap.isolated=true` el contenedor recibió un rango propio (`Hostid 1065536, range 65536`) | no por defecto; requiere `userns-remap` o modo rootless ([Docker userns-remap](https://docs.docker.com/engine/security/userns-remap/), [rootless](https://docs.docker.com/engine/security/rootless/)) |
| Capacidades efectivas | `CapEff 000001ffffffffff` (todas, acotadas al userns) | `CapEff 0` |
| `no_new_privs` | 0 | 1 |
| seccomp | modo 2 (filtro) | modo 2 (filtro, perfil por defecto — [docs](https://docs.docker.com/engine/security/seccomp/)) |
| AppArmor | perfil `lxd-pubeval-lxc-1_…` (enforce) visto desde el host | `docker-default (enforce)` ([docs](https://docs.docker.com/engine/security/apparmor/)) |
| Rootfs | **escribible** (`touch /etc/x` funcionó); sitio `ro` vía `disk readonly=true` | `--read-only`: rootfs y sitio `Read-only file system`; solo `/tmp` tmpfs |
| Egress a Internet | en `lxdbr0`: **ALCANZABLE** (1.1.1.1:443) | red `--internal`: BLOQUEADO |
| Acceso a `mainspot-db:5432` | en `lxdbr0`: **ALCANZABLE** (misma bridge que `mainspot-app/db`) | BLOQUEADO |
| Tenant → tenant | en `lxdbr0`: **ALCANZABLE** | misma red: **ALCANZABLE**; red con `enable_icc=false`: BLOQUEADO (host → contenedor sigue en 200) |
| Con aislamiento aplicado | bridge dedicada `pubeval-br0` sin NAT + ACL (ingreso solo tcp/80 desde la IP del host, default `reject`): Internet, BD, tenant↔tenant y otra bridge → BLOQUEADO; host → 200 | `--internal` + `enable_icc=false` (opciones documentadas en [Docker bridge driver](https://docs.docker.com/engine/network/drivers/bridge/)) |
| Variables de entorno | `container HOME LANG PATH TERM USER` | solo las de la imagen (`NGINX_VERSION`, …); ningún secreto |

Hallazgos con impacto directo en DEC-0043 §1:

1. **Un contenedor LXD creado con el perfil `default` de este host llega a `mainspot-db:5432` y a Internet** (§A.11). Cualquier opción LXD exige red dedicada con ACL; en LXD 5.21 `security.acls` **no se acepta en una NIC `bridged`** (`Invalid device option "security.acls"`, §A.12), solo a nivel de red bridge ([LXD network ACLs](https://documentation.ubuntu.com/lxd/stable-5.21/howto/network_acls/)) — es decir, una bridge propia para sitios públicos.
2. **En OCI, compartir red entre tenants permite tráfico tenant↔tenant** (§A.10); hay que desactivar ICC (medido) o una red por tenant.
3. **OCI sin userns comparte UIDs con el host** (101 = `messagebus`). Mitigación: `userns-remap` o rootless (no medido aquí; Podman no está instalado).
4. LXC sin `idmap.isolated` comparte rango UID entre todos los contenedores del host (incl. `mainspot-*`); LXD lo documenta como riesgo de DoS entre contenedores ([LXD security](https://documentation.ubuntu.com/lxd/stable-5.21/explanation/security/), [idmap](https://documentation.ubuntu.com/lxd/stable-5.21/userns-idmap/)).
5. Límite de memoria: en OCI el OOM tumbó el contenedor (§A.6) → hace falta política de reinicio y monitoreo; el vecino no se vio afectado en ninguno de los dos (requisito DEC-0043 §6).
6. Ambos comparten kernel con el host; DEC-0043 §6 ya lo asume («no confundir contenedorización con aislamiento absoluto»).

### 4.2 Mantenibilidad

| Aspecto | LXC/LXD | OCI |
|---|---|---|
| Unidad versionada | imagen LXD publicada desde una instancia (`lxc publish`, alias) o construida con herramienta externa | imagen OCI por digest (`sha256:…`), construida desde un Dockerfile en CI |
| Inmutabilidad | rootfs mutable por defecto; un `apk upgrade` en caliente deriva por tenant | rootfs de solo lectura medido; el contenedor es desechable |
| Superficie por tenant | init + syslogd + crond + udhcpc + getty + nginx (7 PIDs) | nginx (2 PIDs) |
| Rollout de nueva base a N tenants | `lxc rebuild` + arranque ≈3,5 s/tenant (§A.8) | recrear contenedor ≈0,17 s/tenant; 10 en 3,6 s (§A.8) |
| Ejemplo de deriva real | — | la imagen local `nginx-unprivileged:1.27-alpine` es de 2025-06-23 (§A.5): sin pipeline de rebuild, la «imagen endurecida» envejece sin parches |
| Soporte del runtime | LXD 5.21 LTS soportado hasta junio 2029 ([Canonical](https://canonical.com/blog/lxd_5-21-0_lts)); Incus es el fork comunitario ([linuxcontainers.org](https://linuxcontainers.org/incus/news/2023_10_07_06_39.html)) | Docker Engine 29.5.2 en el host (§A.1) |

### 4.3 Operación: API de aprovisionamiento

- **LXD REST API**: operaciones asíncronas nativas ([REST API](https://documentation.ubuntu.com/lxd/latest/rest-api/)). «Local access to LXD through the Unix socket always grants full access to LXD… only give such access to users who you’d trust with root access» ([LXD security](https://documentation.ubuntu.com/lxd/stable-5.21/explanation/security/)). Remoto: TLS con certificados de cliente.
- **Docker Engine API**: el socket equivale a root del host ([Docker daemon attack surface](https://docs.docker.com/engine/security/#docker-daemon-attack-surface)). Podman ofrece un socket REST rootless ([podman system service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html)).
- Consecuencia común: **`mainspot-app` no debe tener el socket** de ninguno. El backend registra la intención (fila de trabajo) y un proceso aprovisionador separado, sin exposición pública, es el único con acceso al runtime.

---

## 5. Enrutamiento y TLS

### 5.1 Proxy con rutas dinámicas (medido, §A.14–§A.15)

Prueba: tenants OCI detrás de cada proxy (red host, solo `127.0.0.1`), ruta catch-all 404 «sitio no autorizado», 5 ciclos alta/baja de un tenant `c` mientras corre carga keep-alive (16 conexiones) contra el tenant `b`.

| | Caddy 2.11.7 (Admin API) | nginx 1.30.5 (fichero + `nginx -s reload`) | Traefik 3.1.7 (file provider `watch`) |
|---|---|---|---|
| Fuente de rutas | JSON por `PUT/DELETE /config/…`, `/id/<id>` ([Caddy API](https://caddyserver.com/docs/api)) | ficheros generados + reload ([nginx control](https://nginx.org/en/docs/control.html)); sin API dinámica en OSS ([ngx_http_api_module es NGINX Plus](https://nginx.org/en/docs/http/ngx_http_api_module.html)) | file/HTTP/Redis/etcd/Consul/Docker ([providers](https://doc.traefik.io/traefik/v3.5/reference/install-configuration/providers/overview/)) |
| Alta/baja visible | 5–7 ms | 6–112 ms | 1 840–2 169 ms |
| Errores en tráfico ajeno durante 10 cambios | **75 `ECONNRESET`** (de 39 218) | **30 `ECONNRESET`** (de 83 212) | **0** (de 39 751) |
| Proceso reiniciado | no (mismo PID, `RestartCount 0`) | no (reload: workers nuevos) | no |
| Host sin ruta | 404 | 404 | 404 |
| Memoria del proxy (`memory.current` / anon) | 29,2 MB / 27,4 MB | 9,3 MB / 2,4 MB | 171,9 MB / 66,1 MB |
| Wildcard DNS-01 | requiere build propio con módulo DNS (`xcaddy`, [docs](https://caddyserver.com/docs/build)) | cliente ACME externo | lego integrado ([ACME](https://doc.traefik.io/traefik/https/acme/)) |

Notas:
- Caddy y nginx reemplazan la configuración completa en cada cambio y cierran conexiones keep-alive inactivas; un cliente que reutiliza ese socket ve `ECONNRESET`. Traefik agrupa eventos de proveedores (`providersThrottleDuration`, [static_config.go](https://raw.githubusercontent.com/traefik/traefik/v3.1/pkg/config/static/static_config.go)) y no cortó conexiones en la prueba. Con aprovisionamiento asíncrono (DEC-0043 §4), 2 s de propagación no son un problema; las conexiones cortadas a tenants ajenos sí rozan «no afecta a otros» (DEC-0043 §6).
- Proveedor Docker de Traefik: necesita el socket Docker ([Traefik Docker](https://doc.traefik.io/traefik/v3.5/getting-started/docker/)) → descartado por §4.3.
- Lección del arnés: nginx sin `keepalive` hacia upstream agotó puertos efímeros (`connect() … (99: Address not available)`, 1 891 respuestas 502, §A.15); hay que fijar keep-alive hacia los tenants en cualquier proxy.
- Caddy Admin API es una superficie de control completa: solo en `127.0.0.1`/socket Unix.

### 5.2 Wildcard DNS y certificado wildcard

- **Wildcard solo por DNS-01**: HTTP-01 «cannot be used to issue wildcard certificates»; DNS-01 «allows you to issue wildcard certificates»; el TXT `_acme-challenge` se puede delegar por CNAME o NS a otra zona ([Let’s Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)).
- Un `*.dominio` cubre un solo nivel de etiqueta ([RFC 6125 §6.4.3](https://www.rfc-editor.org/rfc/rfc6125#section-6.4.3)): sirve para `<slug>.<zona-sitios>`, no para dominios propios de los negocios.
- Límite LE: «50 certificates can be issued per registered domain … every 7 days» ([rate limits](https://letsencrypt.org/docs/rate-limits/)). Un wildcard compartido no consume cupo por tenant; certificados por tenant sí.
- Vigencia: 90 días hoy; 64 días por defecto desde 2027-02-10 y 45 días en 2028 ([LE, «From 90 to 45»](https://letsencrypt.org/2025/12/02/from-90-to-45.html)) → renovación automatizada obligatoria.

**Hostinger como proveedor DNS-01** (solo documentación pública; no se llamó a ninguna API de cuenta):
- La [OpenAPI pública](https://developers.hostinger.com/openapi/openapi.json) (v2.1.3, §A.16) expone `GET/PUT/DELETE /api/dns/v1/zones/{domain}`, `…/validate`, `…/reset` y snapshots; tipos de registro `A, AAAA, CNAME, ALIAS, MX, TXT, NS, SOA, SRV, CAA`; autenticación `Authorization: Bearer`. **«Tokens will have same permissions as the owning user»**: no hay token acotado a una zona; la API anuncia rate limiting con `429`.
- **lego** tiene proveedor `hostinger` desde **v4.27.0** (`HOSTINGER_API_TOKEN`, [lego docs](https://go-acme.github.io/lego/dns/hostinger/)). Última versión de lego: v5.5.2 (§A.16).
- **Traefik** usa lego: v3.5.3 → lego 4.25.2 (sin Hostinger), **v3.6.0 → lego 4.28.0**, v3.7.16 → lego v5.5.2 ([go.mod v3.6.0](https://raw.githubusercontent.com/traefik/traefik/v3.6.0/go.mod), §A.16). El Traefik 3.1.7 probado aquí no lo incluye.
- **Caddy**: no existe `caddy-dns/hostinger` (GitHub 404, §A.16); hay un módulo de terceros [`sbrunk/caddy-dns-hostinger`](https://github.com/sbrunk/caddy-dns-hostinger) (2 estrellas, último push 2026-03-26) que exige build propio.
- **Certbot**: sin plugin oficial; existe uno de terceros ([certbot-dns-hostinger](https://github.com/BackBenchDevs/certbot-dns-hostinger)).

Alternativas si no se quiere el token de cuenta de Hostinger en la ruta de emisión:
1. **CNAME `_acme-challenge.<zona-sitios>` → servidor [acme-dns](https://github.com/joohoi/acme-dns)**: credencial que solo actualiza un TXT; soportado por lego (`acme-dns`, [docs](https://go-acme.github.io/lego/dns/acmedns/)) y Caddy ([caddy-dns/acmedns](https://github.com/caddy-dns/acmedns)). Requiere operar acme-dns con DNS público (puerto 53) o usar uno de terceros. El CNAME se crea una sola vez en Hostinger.
2. **Delegar por NS una subzona** de sitios a otro proveedor DNS con tokens acotados (mecanismo documentado por LE en el mismo enlace). Cambia el «Hostinger como gestor DNS» de DEC-0043 §2 para esa subzona → requiere decisión.
3. **Token Hostinger con lego, fuera del proxy**: un job de emisión (no expuesto a Internet) guarda el token; el proxy solo recibe el certificado.

---

## 6. PROPUESTA (no decidida)

> **PROPUESTA — pendiente de HDC.** Ninguna línea de esta sección está autorizada para construir (DEC-0044).

1. **Runtime: contenedor OCI por tenant** (DEC-0043 §1 lo permite: «no obliga a una distribución Linux completa»). Motivos medidos: −32 % memoria en reposo, 12,3 kB vs ≈13 MiB de disco por instancia, arranque 0,19 s vs 3,7 s, rootfs de solo lectura y `CapEff 0`/`no_new_privs` por defecto, rollout de base por recreación. Perfil por instancia: imagen MainSpot de servidor estático no-root fijada por digest, `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, `no-new-privileges`, seccomp y AppArmor por defecto, `--memory 32m --cpus 0.25 --pids-limit 32` (valores probados; ajustar por plan, ver §7), política de reinicio, sin variables de entorno de negocio.
2. **Red:** red interna sin egress y con ICC desactivado (medido); el proxy es el único que alcanza a los tenants. Nunca en `lxdbr0` junto a `mainspot-db`.
3. **Motor:** userns obligatorio (rootless Podman o Docker con `userns-remap`) para no compartir UIDs con el host. Elección abierta (no medido aquí).
4. **Contenido:** el aprovisionador materializa `website_content.html` de la versión aprobada en `/srv/mainspot/sites/<tenant_id>/v<N>/` (escritura atómica) y recrea el contenedor montando esa ruta `:ro`. Rollback = recrear apuntando a `v<N-1>` (DEC-0042: versiones en BD). El contenedor nunca toca la BD.
5. **Aprovisionador separado** (único con acceso al runtime y a la config del proxy), trabajos en Postgres idempotentes por `(tenant_id, version)`:
   `REGISTERED` (fila creada tras aprobación) → `PREPARING` (materializar ficheros + hash) → `CONFIGURING` (crear/recrear contenedor, escribir ruta) → `VERIFYING` (petición HTTPS real a `<slug>.<zona>` con SNI: certificado válido, hostname, sha256 del cuerpo = hash de la versión) → `ACTIVE` + notificación al propietario; fallo → `RETRY_PENDING` con backoff → `FAILED`. Reconciliador cada 5 min que compara registro autorizado ↔ contenedores ↔ rutas (DEC-0043 §4). Todo auditado en `audit_log` como el resto del backend.
6. **Proxy: Traefik ≥ v3.6 con file provider** escrito solo por el aprovisionador desde el registro autorizado (sin proveedor Docker, sin socket). Motivo medido: 0 errores en tráfico ajeno durante cambios; 2 s de propagación son irrelevantes en un flujo asíncrono. Alternativa: nginx (menor memoria, 9,3 MB) aceptando reloads con `ECONNRESET` aislados, o Caddy si se prefiere API.
7. **TLS:** un certificado `*.<zona-sitios>` por DNS-01, emitido y renovado por un **job separado del proxy** con lego; el proxy solo lee el certificado (file provider TLS). Credencial preferida: acme-dns por CNAME (alcance mínimo); si se usa el token de Hostinger, vive solo en ese job, fuera del repo (DEC-0042) y de cualquier componente expuesto.
8. **DNS:** un único registro `*.<zona-sitios>` A/AAAA hacia la IP pública del proxy en Hostinger; sin registros por tenant (DEC-0043 §2). Las altas no esperan propagación DNS.

Riesgos:
- Kernel compartido: un escape de contenedor afecta al nodo; mitigado por userns + seccomp + AppArmor + no-root + red sin egress, no eliminado.
- Token Hostinger con permisos de usuario completo: si se filtra, compromete toda la cuenta (no solo DNS).
- Vigencia LE bajando a 45 días (2028): el job de renovación es crítico y debe alertar.
- OOM tumba el contenedor OCI: depende de la política de reinicio y del reconciliador.
- Mediciones en estación de desarrollo con otras cargas, una sola corrida; repetir en el nodo destino antes de dimensionar (DEC-0043 §6).
- Desviación del deploy actual (LXD para `mainspot-app/db`): introduce un segundo runtime a operar → reconciliar vía CanonFlow (cierre de DEC-0043).

---

## 7. Preguntas abiertas (candidatas a HDC; no se crean sesiones)

1. **Runtime de tenants**: ¿OCI (PROPUESTA) o LXC/LXD? Si OCI, ¿en qué nodo corre (host dedicado, VM, contenedor LXD con nesting) y cómo convive con el deploy LXD actual?
2. **Motor OCI**: ¿Podman rootless o Docker con `userns-remap`?
3. **Zona de sitios**: ¿qué dominio real (DEC-0004) y qué nivel: `*.<dominio>` o `*.sitios.<dominio>`?
4. **Credencial DNS-01**: ¿token de cuenta Hostinger en un job aislado, acme-dns por CNAME, o subzona delegada a otro proveedor?
5. **Proxy**: ¿Traefik (PROPUESTA), nginx o Caddy?
6. **Límites por plan** (INC-006): ¿32 MiB / 0,25 CPU / 32 PIDs para todos o por plan?
7. **Suspensión y baja**: ¿suspender = quitar ruta (página «no disponible») o detener contenedor? ¿cuánto se retienen versiones y ficheros tras la baja (retención global §10.1)?
8. **Dominios propios del negocio** (fuera del wildcard): ¿en alcance? Implican certificados por host (HTTP-01 / on-demand) y cupos LE.
9. **Escala horizontal**: ¿cuándo pasar a varios nodos y con qué descubrimiento (proveedor HTTP/KV de Traefik)?
10. **Corrección de `src/domain/hostinger.ts`**: el adaptador TENTATIVA no coincide con la API pública (§5.2); ¿se reescribe en el ítem de publicación real?

---

## Apéndice A — Comandos y salidas crudas

Todos los recursos llevaron prefijo `pubeval-`; artefactos de trabajo en `/tmp/pubeval/` (borrados al final). Se omiten barras de progreso de `lxc`; algunas salidas de varias líneas se compactan en una (separadores `/` o `…`) y los scripts se resumen en comentarios `#` donde son repetitivos.

### A.1 Host

```text
$ lxc version ; docker version --format '{{.Server.Version}}' ; nproc ; free -m ; uname -r ; lsb_release -ds
Client version: 5.21.8 LTS / Server version: 5.21.8 LTS
29.5.2
24
Mem:  total 63997  usado 38711  libre 3298  compartido 2775  búf/caché 25459  disponible 25286
7.0.0-38-generic
Ubuntu 24.04.4 LTS
$ docker info --format '{{.Driver}} {{.CgroupVersion}} {{.SecurityOptions}} {{.DockerRootDir}}'
overlayfs 2 [name=apparmor name=seccomp,profile=builtin name=cgroupns] /var/lib/docker
$ lxc storage show default | grep -E 'driver|source'
driver: dir
  source: /var/snap/lxd/common/lxd/storage-pools/default
$ lxc query /1.0 | jq -r '.environment.firewall'
nftables
```

### A.2 Sitio de prueba

```bash
# /tmp/pubeval/render.ts
import { renderSite, normalizeWebsiteData } from '<repo>/src/website/template.ts';
const data = normalizeWebsiteData({ name: 'Panadería La Espiga', line: 'Panadería', about: 'Pan artesanal desde 1998.', phone: '+52 55 0000 0000', email: 'hola@example.com', address: 'Calle 1, CDMX', hours: 'L-S 7:00-20:00', services: ['Pan dulce','Pasteles','Pedidos'], sections: [{title:'Pedidos', content:'Haz tu pedido con 24 h.'}] });
process.stdout.write(renderSite(data, { version: 1 }));
```
```text
$ node /tmp/pubeval/render.ts > /tmp/pubeval/site/index.html && wc -c … && sha256sum …
1770 /tmp/pubeval/site/index.html
20640fba0fe627eb7b7ab2c71e2d8b93d48c96e23cc9e0678b21b856eff2207d  /tmp/pubeval/site/index.html
```

### A.3 LXC: plantilla, 10 instancias, memoria, disco

```text
$ lxc launch images:alpine/3.22 pubeval-lxc-tpl            # launch_incl_download_ms=2888
$ lxc exec pubeval-lxc-tpl -- sh -c 'cat /etc/alpine-release; apk add --no-cache nginx >/dev/null && nginx -v; rc-update add nginx default; ps -o pid,user,comm'
3.22.7
nginx version: nginx/1.28.3
 * service nginx added to runlevel default
# /etc/nginx/http.d/default.conf: listen 80; root /srv/site; access_log off; server_tokens off; try_files $uri $uri/ =404
# /etc/nginx/nginx.conf: worker_processes 1;
$ lxc stop pubeval-lxc-tpl && lxc publish pubeval-lxc-tpl --alias pubeval-alpine-nginx     # publish_ms=577
| pubeval-alpine-nginx | 0eed7520e89f | 4.69MiB | Alpinelinux 3.22 x86_64 (20261022_0103) |
```
```bash
# /tmp/pubeval/lxc-run.sh (por i en 1..10)
t0=$(date +%s%N)
lxc init pubeval-alpine-nginx pubeval-lxc-$i -q -c limits.memory=32MiB -c limits.cpu.allowance=25ms/100ms -c limits.processes=32
lxc config device add pubeval-lxc-$i site disk source=/tmp/pubeval/site path=/srv/site readonly=true
lxc start pubeval-lxc-$i
# espera IPv4 (lxc list -c4) y luego curl -f http://$ip/ hasta 200; imprime (t1-t0)
```
```text
pubeval-lxc-1 ip=10.209.99.117 init+device+start_to_http200_ms=4078
pubeval-lxc-2 ip=10.209.99.210 init+device+start_to_http200_ms=3741
pubeval-lxc-3 ip=10.209.99.112 init+device+start_to_http200_ms=3511
pubeval-lxc-4 ip=10.209.99.145 init+device+start_to_http200_ms=3953
pubeval-lxc-5 ip=10.209.99.162 init+device+start_to_http200_ms=3727
pubeval-lxc-6 ip=10.209.99.254 init+device+start_to_http200_ms=3730
pubeval-lxc-7 ip=10.209.99.56 init+device+start_to_http200_ms=3991
pubeval-lxc-8 ip=10.209.99.222 init+device+start_to_http200_ms=3427
pubeval-lxc-9 ip=10.209.99.171 init+device+start_to_http200_ms=3551
pubeval-lxc-10 ip=10.209.99.89 init+device+start_to_http200_ms=3127
```
```bash
# /tmp/pubeval/lxc-mem.sh: sleep 10; por instancia lee /sys/fs/cgroup/lxc.payload.<n>/{memory.current,memory.stat,pids.current}
```
```text
pubeval-lxc-1 memory.current=3551232 anon=2379776 file=118784 pids=7
pubeval-lxc-2 memory.current=3571712 anon=2379776 file=118784 pids=7
pubeval-lxc-3 memory.current=3559424 anon=2396160 file=118784 pids=7
pubeval-lxc-4 memory.current=3563520 anon=2383872 file=118784 pids=7
pubeval-lxc-5 memory.current=3563520 anon=2387968 file=118784 pids=7
pubeval-lxc-6 memory.current=3551232 anon=2379776 file=118784 pids=7
pubeval-lxc-7 memory.current=3563520 anon=2392064 file=118784 pids=7
pubeval-lxc-8 memory.current=3563520 anon=2387968 file=118784 pids=7
pubeval-lxc-9 memory.current=3555328 anon=2375680 file=118784 pids=7
pubeval-lxc-10 memory.current=3563520 anon=2392064 file=118784 pids=7
TOTAL memory.current=35606528 bytes (33 MiB) anon_total=23855104 bytes (22 MiB)
$ lxc exec pubeval-lxc-2 -- ps -o pid,user,rss,comm
    1 root      856 init
  284 root      944 syslogd
  312 root      876 crond
  411 root      388 udhcpc
  502 root     2032 nginx
  503 nginx    2808 nginx
  510 root      716 getty
$ curl -s http://<ip pubeval-lxc-1>/ | sha256sum
20640fba0fe627eb7b7ab2c71e2d8b93d48c96e23cc9e0678b21b856eff2207d  -
$ P=/var/snap/lxd/common/lxd/storage-pools/default/containers
$ sudo du -sh $P/pubeval-lxc-1 ; sudo du -sc $P/pubeval-lxc-{1..10} | tail -1
14M	…/pubeval-lxc-1
133680	total
```

### A.4 LXC: carga, PIDs, OOM

```bash
# /tmp/pubeval/load.mjs: N workers con http.Agent keepAlive durante S segundos; cuenta 200/no-200, p50/p99
# /tmp/pubeval/lxc-limits.sh
node /tmp/pubeval/load.mjs http://<ip pubeval-lxc-4>/ 10 32
lxc exec pubeval-lxc-6 -- sh -c 'i=0; while [ $i -lt 40 ]; do sleep 30 & i=$((i+1)); done 2>&1 | sort | uniq -c | head -3'
lxc exec pubeval-lxc-6 -- sh -c 'a=$(head -c 67108864 /dev/zero | tr "\000" a); echo len=${#a}'
```
```text
cpu.max=25000 100000 memory.max=33554432 pids.max=32
cpu.stat before: nr_throttled 10 throttled_usec 639860
{"url":"http://10.209.99.145/","secs":10,"conc":32,"ok":156767,"err":0,"rps":15677,"p50_ms":"0.67","p99_ms":"60.45"}
cpu.stat after: nr_throttled 110 throttled_usec 6588888
memory.peak=8163328 memory.current=6148096
== pids limit (pubeval-lxc-6, pids.max=32)
      1 sh: can't fork: Resource temporarily unavailable
pids.events: max 1
== memory limit (pubeval-lxc-6, 32MiB): allocate ~64MB in a shell
exec_exit=137
memory.events: low 0 high 0 max 209 oom 5 oom_kill 2 oom_group_kill 0 sock_throttled 0
pubeval-lxc-6 still serving: 200 state=RUNNING
PID   COMMAND
    1 init / 284 syslogd / 312 crond / 411 udhcpc / 502 nginx / 510 getty / 542 nginx   (worker nuevo: 542)
neighbour pubeval-lxc-7 serving: 200
```

### A.5 OCI: red, 10 instancias, memoria, disco

```text
$ docker image inspect nginxinc/nginx-unprivileged:1.27-alpine --format '{{.Id}} {{.Size}} {{.Config.User}} {{.Created}}'
sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 20986061 101 2025-06-23T02:05:40.894945483Z
$ docker run --rm --entrypoint nginx nginxinc/nginx-unprivileged:1.27-alpine -v
nginx version: nginx/1.27.5
$ docker network create --internal pubeval-net
[{"Subnet":"172.26.0.0/16","Gateway":"172.26.0.1"}] internal=true
```
```bash
# /tmp/pubeval/nginx-oci.conf: worker_processes 1; pid /tmp/nginx.pid; temp paths en /tmp; listen 8080; root /srv/site; access_log off
# /tmp/pubeval/oci-run.sh (por i en 1..10)
t0=$(date +%s%N)
docker run -d --name pubeval-oci-$i --network pubeval-net \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=8m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --user 101:101 --memory 32m --memory-swap 32m --cpus 0.25 --pids-limit 32 \
  -v /tmp/pubeval/site:/srv/site:ro -v /tmp/pubeval/nginx-oci.conf:/etc/nginx/nginx.conf:ro \
  nginxinc/nginx-unprivileged:1.27-alpine
# IP vía docker inspect; curl -f http://$ip:8080/ hasta 200; imprime (t1-t0)
```
```text
pubeval-oci-1 ip=172.26.0.2 run_to_http200_ms=187
pubeval-oci-2 ip=172.26.0.3 run_to_http200_ms=151
pubeval-oci-3 ip=172.26.0.4 run_to_http200_ms=166
pubeval-oci-4 ip=172.26.0.5 run_to_http200_ms=204
pubeval-oci-5 ip=172.26.0.6 run_to_http200_ms=162
pubeval-oci-6 ip=172.26.0.7 run_to_http200_ms=216
pubeval-oci-7 ip=172.26.0.8 run_to_http200_ms=229
pubeval-oci-8 ip=172.26.0.9 run_to_http200_ms=201
pubeval-oci-9 ip=172.26.0.10 run_to_http200_ms=210
pubeval-oci-10 ip=172.26.0.11 run_to_http200_ms=171
```
```bash
# /tmp/pubeval/oci-mem.sh: sleep 10; /sys/fs/cgroup/system.slice/docker-<id>.scope/{memory.current,memory.stat,pids.current}; suma RSS (ps) de cgroup.procs
```
```text
pubeval-oci-1 memory.current=5066752 anon=1519616 file=2932736 pids=2 sum_rss_kib=7656
pubeval-oci-2 memory.current=2138112 anon=1531904 file=16384 pids=2 sum_rss_kib=7896
pubeval-oci-3 memory.current=2150400 anon=1531904 file=16384 pids=2 sum_rss_kib=7740
pubeval-oci-4 memory.current=2138112 anon=1531904 file=16384 pids=2 sum_rss_kib=7744
pubeval-oci-5 memory.current=2129920 anon=1519616 file=16384 pids=2 sum_rss_kib=7856
pubeval-oci-6 memory.current=2125824 anon=1519616 file=16384 pids=2 sum_rss_kib=7832
pubeval-oci-7 memory.current=2146304 anon=1531904 file=16384 pids=2 sum_rss_kib=7788
pubeval-oci-8 memory.current=2134016 anon=1527808 file=20480 pids=2 sum_rss_kib=7820
pubeval-oci-9 memory.current=2142208 anon=1519616 file=16384 pids=2 sum_rss_kib=7860
pubeval-oci-10 memory.current=2150400 anon=1527808 file=16384 pids=2 sum_rss_kib=7784
TOTAL memory.current=24322048 bytes (23 MiB) anon_total=15261696 bytes (14 MiB)
$ docker stats --no-stream …   →  pubeval-oci-2 2.031MiB / 32MiB 0.00% 2  (… resto 2.02–2.043MiB; oci-1 4.625MiB)
$ curl -s http://172.26.0.2:8080/ | sha256sum
20640fba0fe627eb7b7ab2c71e2d8b93d48c96e23cc9e0678b21b856eff2207d  -
$ docker ps -a -s --filter name=pubeval-oci --format '{{.Names}} {{.Size}}'
pubeval-oci-10 12.3kB (virtual 52.7MB)        (idéntico para las 10)
$ docker image ls nginxinc/nginx-unprivileged:1.27-alpine  →  disk=73.7MB
$ docker image ls --tree  →  linux/amd64 28d91bdce70a 73.6MB 21MB
```

### A.6 OCI: carga, PIDs, OOM

```bash
# /tmp/pubeval/oci-limits.sh (mismas órdenes que A.4 sobre pubeval-oci-2 / pubeval-oci-10)
```
```text
cpu.max=25000 100000 memory.max=33554432 pids.max=32
cpu.stat before: nr_throttled 0 throttled_usec 0
{"url":"http://172.26.0.3:8080/","secs":10,"conc":32,"ok":177520,"err":0,"rps":17752,"p50_ms":"0.63","p99_ms":"58.75"}
cpu.stat after: nr_throttled 100 throttled_usec 5784297
memory.peak=5713920 memory.current=3387392
== pids limit (oci-10, pids.max=32)
      1 sh: can't fork: Resource temporarily unavailable
pids.current=2 pids.events: max 1
== memory limit (oci-10, 32MiB): allocate ~64MB in a shell
exec_exit=137
memory.events: low 0 high 0 max 148 oom 6 oom_kill 2 oom_group_kill 0 sock_throttled 0
oci-10 still serving: 000 state=exited oomkilled=true restarts=0
neighbour oci-9 serving: 200
```

### A.7 Desglose de arranque y re-arranque

```bash
# /tmp/pubeval/start-breakdown.sh: cronometra cada paso con date +%s%N
```
```text
lxc init (copia rootfs, pool dir): 278 ms
lxc config device add: 117 ms
lxc start (retorna): 333 ms
start -> IPv4 por DHCP: 1269 ms
start -> HTTP 200: 3338 ms
LXC re-start de instancia detenida -> HTTP 200: 2105 ms
lxc stop: 3142 ms
docker stop: 161 ms
OCI re-start de contenedor detenido -> HTTP 200: 157 ms
```

### A.8 Rollout de base

```bash
lxc rebuild pubeval-alpine-nginx pubeval-lxc-11 --force ; lxc start pubeval-lxc-11   # + espera 200
for i in 1..10: docker rm -f pubeval-oci-$i ; /tmp/pubeval/oci-run.sh               # recrea las 10
```
```text
lxc rebuild (instancia detenida): 270 ms
1                                   (el device site readonly=true se conserva)
rebuild+start -> HTTP 200: 3476 ms
run_to_http200_ms=169 189 165 200 205 214 180 165 170 179
rollout OCI 10 instancias (rm + run + HTTP 200 c/u): 3632 ms
```

### A.9 Referencia Debian 12

```text
$ lxc launch images:debian/12 pubeval-lxc-deb -q -c limits.memory=256MiB      # launch_ms=1307 (imagen ya en caché)
debian12 base (sin nginx) memory.current=28139520 anon=12333056 pids=12
439M	…/containers/pubeval-lxc-deb
systemd systemd-journal systemd-udevd systemd-resolve systemd-network dbus-daemon systemd-logind agetty systemd-hostnam polkitd
```

### A.10 Seguridad OCI

```bash
# /tmp/pubeval/oci-sec.sh
docker exec pubeval-oci-1 sh -c 'id; grep -E "^(CapEff|CapBnd|NoNewPrivs|Seccomp):" /proc/1/status; echo apparmor=$(cat /proc/1/attr/current); echo uid_map=$(cat /proc/self/uid_map)'
ps -o user:12,uid,pid,cmd -p <pid host>
docker exec pubeval-oci-1 sh -c 'touch /srv/site/x; touch /etc/x; echo tmp-ok > /tmp/t && cat /tmp/t'
docker exec pubeval-oci-1 sh -c 'timeout 5 nc -z -w 3 1.1.1.1 443 && echo REACHABLE || echo BLOCKED'
docker exec pubeval-oci-1 sh -c 'timeout 5 nc -z -w 3 10.209.99.172 5432 && echo REACHABLE || echo BLOCKED'
docker exec pubeval-oci-1 sh -c 'timeout 5 wget -q -O /dev/null -T 3 http://172.26.0.3:8080/ && echo REACHABLE || echo BLOCKED'
```
```text
uid=101(nginx) gid=101(nginx) groups=101(nginx)
CapEff:	0000000000000000
CapBnd:	0000000000000000
NoNewPrivs:	1
Seccomp:	2
apparmor=docker-default (enforce)
uid_map= 0 0 4294967295
USER           UID     PID CMD
messagebus     101 3233111 nginx: master process nginx -g daemon off;
touch: /srv/site/x: Read-only file system
touch: /etc/x: Read-only file system
tmp-ok
== egress internet (1.1.1.1:443)            BLOCKED
== mainspot-db 10.209.99.172:5432           BLOCKED
== tenant-to-tenant on shared network       REACHABLE
== env: DYNPKG_RELEASE HOME HOSTNAME NGINX_VERSION NJS_RELEASE NJS_VERSION PATH PKG_RELEASE
```
```bash
# /tmp/pubeval/oci-icc.sh
docker network create --internal -o com.docker.network.bridge.enable_icc=false pubeval-net-noicc
# pubeval-icc-a / pubeval-icc-b con el mismo perfil endurecido
```
```text
host -> icc-b (172.27.0.3): 200
icc-a -> icc-b: wget: download timed out → BLOCKED
```

### A.11 Seguridad LXC (perfil por defecto, `lxdbr0`)

```bash
# /tmp/pubeval/lxc-sec.sh (mismas pruebas que A.10 vía lxc exec; nginx master dentro del contenedor)
```
```text
limits.cpu.allowance: 25ms/100ms / limits.memory: 32MiB / limits.processes: "32"
volatile.idmap.current: '[{"Isuid":true,…,"Hostid":1000000,"Nsid":0,"Maprange":1000000000},{… gid …}]'
Uid:	0	0	0	0
CapEff:	000001ffffffffff
CapBnd:	000001ffffffffff
NoNewPrivs:	0
Seccomp:	2
apparmor=unconfined            (vista interna del namespace AppArmor)
uid_map= 0 1000000 1000000000
host view: 1000000  1000000  … nginx: master process …
touch: /srv/site/x: Read-only file system
etc-writable
== egress internet (1.1.1.1:443)                     REACHABLE
== mainspot-db 10.209.99.172:5432 (same lxdbr0)      REACHABLE
== tenant-to-tenant (pubeval-lxc-1 -> pubeval-lxc-2) REACHABLE
== env: container HOME LANG PATH TERM USER
$ sudo cat /proc/<pid host>/attr/current
lxd-pubeval-lxc-1_</var/snap/lxd/common/lxd>//&:lxd-pubeval-lxc-1_<var-snap-lxd-common-lxd>:unconfined (enforce)   seccomp=2
$ lxc config set pubeval-lxc-3 security.idmap.isolated=true && lxc restart pubeval-lxc-3
pubeval-lxc-3: [{"Isuid":true,…,"Hostid":1065536,"Nsid":0,"Maprange":65536},…]
pubeval-lxc-4: [{"Isuid":true,…,"Hostid":1000000,"Nsid":0,"Maprange":1000000000},…]
```

### A.12 LXC: ACL

```text
$ lxc network acl create pubeval-acl
$ lxc network acl rule add pubeval-acl ingress action=allow protocol=tcp destination_port=80 source=10.209.99.1/32
$ lxc config device override pubeval-lxc-2 eth0 security.acls=pubeval-acl security.acls.default.ingress.action=reject security.acls.default.egress.action=reject
Error: Invalid devices: Device validation failed for "eth0": Invalid device option "security.acls.default.egress.action"
$ lxc config device override pubeval-lxc-2 eth0 security.acls=pubeval-acl
Error: Invalid devices: Device validation failed for "eth0": Invalid device option "security.acls"
$ lxc query /1.0 | jq -r '.api_extensions[]' | grep -i -E 'acl|isolation'
instance_nic_bridged_port_isolation network_acl network_ovn_acl network_ovn_acl_defaults network_bridge_acl network_acl_log network_acls_all_projects
```
```bash
# /tmp/pubeval/lxc-acl.sh (ACL en una bridge propia; lxdbr0 no se tocó)
lxc network acl rule add pubeval-acl ingress action=allow protocol=tcp destination_port=80 source=10.250.99.1/32
lxc network acl rule remove pubeval-acl ingress action=allow protocol=tcp destination_port=80 source=10.209.99.1/32
lxc network create pubeval-br0 ipv4.address=10.250.99.1/24 ipv4.nat=false ipv6.address=none \
  security.acls=pubeval-acl security.acls.default.ingress.action=reject security.acls.default.egress.action=reject
for n in pubeval-lxc-2 pubeval-lxc-5; do lxc config device override $n eth0 network=pubeval-br0; lxc restart $n; done
```
```text
lxc-2=10.250.99.210 lxc-5=10.250.99.162
host(10.250.99.1) -> lxc-2:80: 200
lxc-2 -> 1.1.1.1:443: BLOCKED
lxc-2 -> mainspot-db 10.209.99.172:5432: BLOCKED
lxc-2 -> lxc-5:80: BLOCKED
lxc-1 (lxdbr0) -> lxc-2:80: BLOCKED
```

### A.13 Interpretación de máscaras

`CapEff 0000000000000000` = ninguna capacidad; `000001ffffffffff` = todas las capacidades 0–40 (dentro del userns). `Seccomp: 2` = modo filtro.

### A.14 Caddy: rutas por Admin API

```bash
docker pull -q caddy:2-alpine ; docker run --rm caddy:2-alpine caddy version
# v2.11.7 h1:yj0Y4fYZGPkSvibBJ1sTWE33xC0fxztVyXEW5iIdUT4=
# /tmp/pubeval/caddy.json: admin 127.0.0.1:2999; server "pub" listen 127.0.0.1:18080; automatic_https disable;
#   routes: [{ "@id":"catch-all", static_response 404 "sitio no autorizado" }]
docker run -d --name pubeval-caddy --network host --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true --memory 128m --pids-limit 64 \
  -v /tmp/pubeval/caddy.json:/etc/caddy/caddy.json:ro --tmpfs /data --tmpfs /config caddy:2-alpine caddy run --config /etc/caddy/caddy.json
# ruta: PUT /config/apps/http/servers/pub/routes/0 con
#   {"@id":"tenant-a","match":[{"host":["a.pubeval.test"]}],"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"<ip>:8080"}]}],"terminal":true}
# baja: DELETE /id/tenant-a
```
```text
(1.er intento sin --cap-add NET_BIND_SERVICE: "exec /usr/bin/caddy: operation not permitted" — el binario tiene file capability y no_new_privs lo impide)
PUT tenant-a: 200 (8 ms)
a.pubeval.test -> 20640fba0fe627eb code=200
b.pubeval.test (sin ruta) -> code=404
PUT tenant-b: 200 (6 ms)
b.pubeval.test -> code=200
a.pubeval.test sigue -> code=200
DELETE tenant-a: 200 (6 ms)
a.pubeval.test tras baja -> code=404 body=sitio no autorizado
b.pubeval.test sigue -> code=200
caddy pid antes=3301925 despues=3301925 restarts=0
```

### A.15 Proxies bajo cambios en caliente

```bash
# nginx: docker run -d --name pubeval-nginx-proxy --network host --read-only --tmpfs /tmp --user 101:101 --cap-drop ALL
#   --security-opt no-new-privileges:true -v …/nginx.conf:ro -v …/tenants:/etc/nginx/tenants:ro nginx:stable-alpine
#   nginx.conf: include /etc/nginx/tenants/*.conf; default_server en 127.0.0.1:18081 → return 404
# traefik: docker run -d --name pubeval-traefik --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true
#   -v …/traefik.yml:ro -v …/traefik-dyn:/dyn:ro traefik:v3.1    (entryPoint 127.0.0.1:18082; providers.file.directory=/dyn, watch=true)
# Versiones: traefik version → 3.1.7 ; nginx -v → nginx/1.30.5
# /tmp/pubeval/loadhost2.mjs HOST SEGUNDOS PUERTO: 16 conexiones keep-alive con cabecera Host; cuenta códigos y errores de socket
# /tmp/pubeval/proxy-hot2.sh: por proxy, baseline 5 s; luego 6 s de carga a b.pubeval.test mientras se hacen 5 ciclos
#   alta tenant-c (espera 200) / baja (espera 404). Antes de cada fase espera TIME_WAIT < 2000.
#   caddy: PUT/DELETE Admin API · nginx: escribir/borrar tenants/c.conf + nginx -s reload · traefik: mv c.yml / rm c.yml
```
```text
[caddy] baseline: {"http_200":33267}
ciclo1 alta=7ms baja=6ms; ciclo2 alta=7ms baja=5ms; ciclo3 alta=5ms baja=6ms; ciclo4 alta=7ms baja=6ms; ciclo5 alta=7ms baja=5ms;
[caddy] durante 5 altas/bajas: {"http_200":39143,"err_ECONNRESET":75}
[nginx] baseline: {"http_200":78881}
ciclo1 alta=60ms baja=59ms; ciclo2 alta=111ms baja=112ms; ciclo3 alta=6ms baja=6ms; ciclo4 alta=6ms baja=33ms; ciclo5 alta=59ms baja=30ms;
[nginx] durante 5 altas/bajas: {"http_200":83182,"err_ECONNRESET":30}
[traefik] baseline: {"http_200":34998}
ciclo1 alta=2072ms baja=1977ms; ciclo2 alta=1988ms baja=2107ms; ciclo3 alta=1935ms baja=2148ms; ciclo4 alta=1840ms baja=1992ms; ciclo5 alta=2019ms baja=1986ms;
[traefik] durante 5 altas/bajas: {"http_200":39751}

pubeval-caddy memory.current=29249536 anon=27389952 file=12288
pubeval-nginx-proxy memory.current=9273344 anon=2396160 file=6180864
pubeval-traefik memory.current=171876352 anon=66072576 file=102572032
```
Corrida previa descartada por el arnés (nginx sin `keepalive` a upstream): `{"http_200":6742,"err_ECONNRESET":90,"http_502":1891}` y en el log de nginx `1891 [crit] connect() to 172.26.0.3:8080 failed (99: Address not available)`; se corrigió con `upstream { keepalive 16; }` y espera de TIME_WAIT antes de la corrida válida de arriba.

### A.16 Fuentes consultadas por línea de comandos (solo documentación pública)

```text
$ curl -sS https://developers.hostinger.com/openapi/openapi.json -o hostinger-openapi.json
$ jq -r '.info.version, (.paths|keys[]|select(test("dns")))' hostinger-openapi.json
2.1.3
/api/dns/v1/snapshots/{domain}
/api/dns/v1/snapshots/{domain}/{snapshotId}
/api/dns/v1/snapshots/{domain}/{snapshotId}/restore
/api/dns/v1/zones/{domain}
/api/dns/v1/zones/{domain}/reset
/api/dns/v1/zones/{domain}/validate
$ jq -r '.paths["/api/dns/v1/zones/{domain}"]|keys[]'          → delete get put
$ jq -r '.components.securitySchemes'                           → {"apiToken":{"type":"http","scheme":"bearer"}}
$ (enum de tipos de registro)                                    → A,AAAA,CNAME,ALIAS,MX,TXT,NS,SOA,SRV,CAA
$ jq -r '.info.description'
… API tokens for individual users can be created and managed from the Account page …
Tokens will have same permissions as the owning user.
Optionally, tokens can be set to expire after a certain period of time.
# Rate Limiting … If you exceed the rate limit, you will receive a 429 Too Many Requests response.
$ curl -sS https://go-acme.github.io/lego/dns/hostinger/ | grep -o 'Since: v[0-9.]*\|HOSTINGER_[A-Z_]*\|Code: <code>[a-z]*'
Code: <code>hostinger / HOSTINGER_API_TOKEN / HOSTINGER_HTTP_TIMEOUT / HOSTINGER_POLLING_INTERVAL / HOSTINGER_PROPAGATION_TIMEOUT / HOSTINGER_TTL / Since: v4.27.0
$ curl https://api.github.com/repos/{traefik/traefik,caddyserver/caddy,go-acme/lego}/releases/latest | jq -r .tag_name
v3.7.16 / v2.11.7 / v5.5.2
$ for v in v3.5.3 v3.6.0 v3.7.16; do curl …/traefik/$v/go.mod | grep go-acme/lego; done
v3.5.3  github.com/go-acme/lego/v4 v4.25.2
v3.6.0  github.com/go-acme/lego/v4 v4.28.0
v3.7.16 github.com/go-acme/lego/v5 v5.5.2
$ curl -sS -o /dev/null -w '%{http_code}' https://api.github.com/repos/caddy-dns/hostinger   → 404
$ curl https://api.github.com/repos/sbrunk/caddy-dns-hostinger | jq -r '.full_name,.pushed_at,.stargazers_count,.archived'
sbrunk/caddy-dns-hostinger / 2026-03-26T21:54:38Z / 2 / false
$ curl https://letsencrypt.org/docs/rate-limits/        → "50 certificates can be issued per registered domain (or IPv4 address, or IPv6 /64 range) every 7 days"
$ curl https://letsencrypt.org/2025/12/02/from-90-to-45.html → "February 10, 2027: … default classic ACME profile to issuing 64-day certificates" / "cut in half to 45 days by 2028"
```

### A.17 Limpieza y verificación

```bash
# /tmp/pubeval/cleanup.sh
docker rm -f $(docker ps -a --filter name=pubeval- -q)
docker network rm pubeval-net pubeval-net-noicc
docker image rm caddy:2-alpine                     # única imagen descargada para esta evaluación
for n in $(lxc list -c n -f csv | grep '^pubeval-'); do lxc delete -f $n; done
lxc network delete pubeval-br0
lxc network acl delete pubeval-acl
lxc image delete pubeval-alpine-nginx 404623d69cf8 # imagen publicada + alpine/3.22 descargada a caché
```
```text
15                                   (contenedores docker pubeval-* eliminados)
pubeval-net
pubeval-net-noicc
caddy:2-alpine eliminada
Network pubeval-br0 deleted
Network ACL pubeval-acl deleted
== verificación
lxc list (pubeval-): 0
chedraui-dev,RUNNING
demos,RUNNING
mainspot-app,RUNNING
mainspot-db,RUNNING
pg13-rds,RUNNING
webserver,RUNNING
docker ps -a (pubeval-): 0
docker network ls (pubeval-): 0
lxc network list (pubeval-): 0
lxc network acl list (pubeval-): 0
lxc image list (pubeval-/404623d69cf8): 0
docker image caddy:2-alpine: 0
mainspot-app/db: mainspot-app,RUNNING mainspot-db,RUNNING
```
No se modificaron `mainspot-app`, `mainspot-db`, `lxdbr0`, perfiles ni pools LXD, ni contenedores/redes/imágenes Docker preexistentes (`nginx:stable-alpine`, `nginxinc/nginx-unprivileged:1.27-alpine`, `traefik:v3.1` se usaron sin modificarse y se conservan). No se leyeron `.env` ni `~/.config/mainspot`.
