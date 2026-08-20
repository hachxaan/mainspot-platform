# Deploy local LXD — MainSpot Platform

Despliegue reproducible de la plataforma en **contenedores LXC/LXD locales**
(LXD 5.21 LTS del host, usuario con grupo `lxd`). No usa Docker: el stack
`docker-compose.yml` queda como referencia de configuración/health.

## Arquitectura (2 contenedores + proxy)

```
Host (Linux, LXD 5.21)
├── lxdbr0 (bridge LXD con NAT, 10.209.99.1/24)
│   ├── mainspot-db     Ubuntu 24.04 — PostgreSQL 16.15 (listen *; pg_hba solo 10.209.99.0/24)
│   └── mainspot-app    Ubuntu 24.04 — Node 24 (type-stripping nativo) — API Express
│                       ├── /opt/mainspot-platform  (repo, npm ci)
│                       ├── /etc/mainspot/mainspot.env (0600, secretos de la app)
│                       └── systemd: mainspot.service (enabled, Restart=on-failure)
└── device proxy LXD en mainspot-app:
    listen tcp:0.0.0.0:3000 (host) ──▶ connect tcp:127.0.0.1:3000 (contenedor)
```

- **app → db**: `DATABASE_URL=postgres://mainspot:<pw>@<IP-mainspot-db>:5432/mainspot`
  (IP interna de `lxdbr0`; el password vive en `~/.config/mainspot/mainspot-secrets.env`,
  nunca en el repo).
- **Acceso local**: http://localhost:3000 (proxy LXD). Health: http://localhost:3000/health.

## Requisitos

- Host Linux con LXD 5.x (`/snap/bin/lxc`) y usuario en el grupo `lxd`.
- Herramientas en el host: `jq`, `curl`, `openssl`.
- Acceso a Internet: descarga de imagen `ubuntu:24.04` desde el remote `ubuntu`
  y paquete Node desde NodeSource (solo primer aprovisionamiento).
- Puerto `APP_HOST_LISTEN_PORT` (default 3000) libre en el host.

## Uso

```bash
cd scripts/deploy
./deploy-lxd.sh            # idempotente: asegura contenedores, BD, app y proxy
./deploy-lxd.sh --reset    # destruye y recrea los contenedores mainspot-* desde cero
./deploy-lxd.sh --destroy  # destruye contenedores mainspot-* y el proxy (conserva secretos)
./deploy-lxd.sh --help
```

Config NO secreta overrideable: copia `mainspot-deploy.env.example` a
`~/.config/mainspot/mainspot-deploy.env` y ajusta (puerto del host, contenedores, etc.).

### Qué hace cada ejecución (convergente/idempotente)

1. Genera `~/.config/mainspot/mainspot-secrets.env` (0600) solo si no existe:
   `POSTGRES_PASSWORD` + `JWT_SECRET` (ambos `openssl rand -hex`).
2. Crea/arranca `mainspot-db` y `mainspot-app` (imagen `ubuntu:24.04`,
   `boot.autostart=true`).
3. `mainspot-db`: instala PostgreSQL 16, `listen_addresses='*'`, reescribe la línea
   gestionada en `pg_hba.conf` (`host all all <subred-lxdbr0> scram-sha-256 # mainspot-lxd-managed`),
   crea/actualiza role `mainspot` (LOGIN CREATEDB) y las bases `mainspot` y
   `mainspot_test` (idempotente).
4. `mainspot-app`: instala Node ≥ 24 (NodeSource si el apt trae una versión menor),
   copia el repo (tar excluyendo `node_modules`, `.git`, `.deploy`, `.env`), `npm ci`,
   escribe `/etc/mainspot/mainspot.env` (0600, user `mainspot`), ejecuta
   `node scripts/db-setup.ts` (migraciones 0001→0011 + seed, idempotente) y despliega
   la systemd unit `mainspot.service` (enabled + restart).
5. Añade el device proxy `proxy-http` si falta, y espera a que
   `http://127.0.0.1:3000/health` responda 200.

## Secretos (nunca en git)

| Archivo | Ubicación | Permisos | Contenido |
|---|---|---|---|
| secrets files | `~/.config/mainspot/mainspot-secrets.env` | 0600 | `POSTGRES_PASSWORD`, `JWT_SECRET` |
| env de producción (dentro del contenedor) | `mainspot-app:/etc/mainspot/mainspot.env` | 0600 (user `mainspot`) | todas las variables de la app, incluidas las secretas |
| config no secreta (opcional) | `~/.config/mainspot/mainspot-deploy.env` | 0600 | overrides documentados en `mainspot-deploy.env.example` |

La app arranca en fail-fast (IR-02): sin `JWT_SECRET` real el proceso aborta
(`src/shared/config.ts`), por lo que un deploy mal configurado nunca sirve tráfico.

## Verificar / operar

```bash
lxc list                                    # mainspot-app y mainspot-db RUNNING
curl -s http://localhost:3000/health        # {"ok":true,...}

# login real (credenciales simuladas de seed, README §3)
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin.a@example.com","password":"Simula-A-Admin-2026!","tenant_id":"client_a"}'

# logs
lxc exec mainspot-app -- journalctl -u mainspot.service -f
lxc exec mainspot-db   -- tail -f /var/log/postgresql/postgresql-16-main.log

# SQL dentro de la BD
lxc exec mainspot-db -- sudo -u postgres psql -d mainspot
```

## Regenerar / destruir

- `./deploy-lxd.sh --reset`: destruye y recrea ambos contenedores; la BD se
  migra/siembra de cero con el mismo secrets file (las credenciales simuladas de
  seed vuelven al estado inicial).
- `./deploy-lxd.sh --destroy`: elimina los contenedores `mainspot-*` (y con ellos
  el device proxy). No toca `webserver`/`chedraui-dev` ni otros proyectos. Para
  purgar además los secretos locales: `rm -rf ~/.config/mainspot`.

## Evidencia

Salidas reales capturadas en `evidence/deploy-lxd/*.txt` (00-env, 01-containers,
02-db-setup, 03-app-start, 04-health, 05-login-me, 06-proxy, 07-summary).

## Riesgos / limitaciones (despliegue local)

- **Sin TLS**: la app escucha HTTP plano; solo apta para desarrollo/piloto local.
- **Proxy 0.0.0.0**: el device escucha en todas las interfaces del host. `lxdbr0`
  tiene NAT, pero si el host tuviera ruteo externo el puerto quedaría expuesto;
  para redes con más exposición usar `listen=tcp:127.0.0.1:3000`.
- **BD limitada a lxdbr0**: Postgres escucha `*` dentro del contenedor pero
  `pg_hba.conf` solo acepta la subred de `lxdbr0` (no llega a Internet de forma
  directa; el bridge es de un solo host).
- **Integraciones reales**: Telegram/Meta/Google/Hostinger quedan en modo
  simulado (DEC-026) al estar los tokens vacíos; activarlas exige tokens reales
  y `CHANNEL_PRIMARY`/`SOCIAL_PROVIDER`/etc. adecuados.
- **Node vía NodeSource**: el instalador de apt de Ubuntu 24.04 trae Node 18
  (insuficiente); el script añade el repo NodeSource para Node 24.
- **mainspot_test**: se crea vacía (owner `mainspot`) para futuras corridas de
  test; no se migra en el deploy (los tests la recrean con `scripts/test-prep.ts`).
