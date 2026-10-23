/**
 * Minimal backoffice UI (AC-001 / AC-008).
 * Plain-language, keyboard-navigable, no technical jargon. Not a product UI:
 * it exists to demonstrate role/context behaviour for the pilot and can be
 * replaced by a real frontend in later increments.
 */

const SHARED_CSS = `
  :root { color-scheme: light; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  body { margin: 0; background: #f5f7fa; color: #1f2933; }
  main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.5rem; }
  .card { background: #fff; border: 1px solid #d7dde3; border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; }
  label { display: block; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 0.6rem; border: 1px solid #9aa7b3; border-radius: 8px; font-size: 1rem; }
  button { padding: 0.65rem 1rem; border: 0; border-radius: 8px; background: #0b5ba6; color: #fff; font-size: 1rem; cursor: pointer; }
  button.secondary { background: #e7ecf1; color: #1f2933; }
  a { color: #0b5ba6; }
  [role="alert"] { background: #fdecea; border: 1px solid #f5b7b1; color: #7a1f1a; padding: 0.75rem; border-radius: 8px; margin-top: 0.75rem; }
  [role="status"] { background: #e3f2e4; border: 1px solid #a8d5b0; color: #14532d; padding: 0.75rem; border-radius: 8px; margin-bottom: 0.75rem; }
  .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-weight: 600; font-size: 0.85rem; background: #e7ecf1; border: 1px solid #c3cdd6; }
  .badge.admin { background: #e3e7fd; border-color: #9aa7f0; }
  .badge.ops { background: #e0f2e8; border-color: #9ad0b5; }
  .badge.readonly { background: #f1ede2; border-color: #d3c9a3; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #e2e8ee; }
  th { background: #eef2f6; }
  code { background: #eef2f6; padding: 0.1rem 0.3rem; border-radius: 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .error-text { color: #7a1f1a; }
  footer { margin-top: 2rem; font-size: 0.85rem; color: #5b6470; text-align: center; }
`;

export function loginPageHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MainSpot — Ingreso</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Bienvenido a MainSpot</h1>
    <p>Panel interno de trabajo. Ingresa con el usuario, la contraseña y el cliente que tu administrador te haya dado.</p>
    <form id="loginForm" autocomplete="on">
      <label for="login">Usuario</label>
      <input id="login" name="login" type="text" autocomplete="username" required>
      <label for="password">Contraseña</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <label for="tenant_id">Cliente</label>
      <input id="tenant_id" name="tenant_id" type="text" autocomplete="organization" placeholder="client_a o client_b" required>
      <div style="margin-top:1rem">
        <button type="submit">Ingresar</button>
      </div>
      <div id="error" role="alert"></div>
    </form>
  </div>
  <footer>MainSpot — Piloto de pruebas interno</footer>
</main>
<script>
const form = document.getElementById('loginForm');
const error = document.getElementById('error');
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  error.textContent = '';
  const body = {
    login: document.getElementById('login').value,
    password: document.getElementById('password').value,
    tenant_id: document.getElementById('tenant_id').value,
  };
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      error.textContent = data.error && data.error.message ? data.error.message : 'No se pudo ingresar. Inténtalo de nuevo.';
      return;
    }
    sessionStorage.setItem('mainspot.token', data.token);
    sessionStorage.setItem('mainspot.tenant', body.tenant_id);
    window.location.href = '/panel';
  } catch (err) {
    error.textContent = 'No se pudo conectar con el servidor. Inténtalo de nuevo.';
  }
});
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function panelPageHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MainSpot — Panel</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <div class="card">
    <h1 id="welcome">Panel de MainSpot</h1>
    <p id="whoami"></p>
    <button class="secondary" id="logoutBtn">Salir del panel</button>
  </div>
  <div id="denied" role="alert" hidden></div>
  <div id="notice" role="status" hidden></div>
  <div class="card" id="roleCard" hidden>
    <h2>Tu perfil</h2>
    <p id="roleDesc"></p>
    <p><strong>Lo que puedes hacer:</strong></p>
    <div class="actions" id="permissionChips"></div>
  </div>
  <div class="card" id="actionsCard" hidden>
    <h2>Acciones rápidas</h2>
    <div class="actions" id="actionsButtons"></div>
    <div id="registerDataBlock" hidden>
      <h3>Registrar un dato del cliente</h3>
      <form id="registerDataForm">
        <label for="rd_kind">Tipo de dato</label>
        <input id="rd_kind" name="kind" value="client.asset">
        <label for="rd_payload">Detalle (texto o JSON entre llaves)</label>
        <input id="rd_payload" name="payload" placeholder='Por ejemplo: {"name":"Horario","value":"9:00-18:00"}'>
        <div style="margin-top:0.75rem"><button type="submit">Guardar dato</button></div>
      </form>
    </div>
    <div id="newActionBlock" hidden>
      <h3>Crear una operación de prueba</h3>
      <form id="newActionForm">
        <label for="na_title">Nombre de la operación</label>
        <input id="na_title" name="title" required>
        <div style="margin-top:0.75rem"><button type="submit">Crear operación</button></div>
      </form>
    </div>
    <div id="actionsListBlock" hidden>
      <h3>Operaciones del cliente</h3>
      <table>
        <thead><tr><th>Nombre</th><th>Estado</th><th>Creada por</th><th>Acciones</th></tr></thead>
        <tbody id="actionsListBody"></tbody>
      </table>
      <p id="actionsListNote"></p>
    </div>
    <div id="usersBlock" hidden>
      <h3>Usuarios del cliente</h3>
      <table>
        <thead><tr><th>Nombre</th><th>Estado</th></tr></thead>
        <tbody id="usersBody"></tbody>
      </table>
      <h3>Crear un usuario</h3>
      <form id="createUserForm">
        <label for="cu_name">Nombre visible</label>
        <input id="cu_name" name="display_name" required>
        <label for="cu_login">Usuario para ingresar</label>
        <input id="cu_login" name="login" required autocomplete="off">
        <label for="cu_password">Contraseña (mínimo 8 caracteres)</label>
        <input id="cu_password" name="password" type="password" minlength="8" required autocomplete="new-password">
        <label for="cu_role">Perfil</label>
        <select id="cu_role" name="role">
          <option value="administration">Administración</option>
          <option value="operation">Operación</option>
          <option value="read_only">Solo lectura</option>
        </select>
        <div style="margin-top:0.75rem"><button type="submit">Crear usuario</button></div>
      </form>
    </div>
  </div>
  <div class="card" id="websiteCard" hidden>
    <h2>Página web del cliente</h2>
    <div id="websiteBody"></div>
  </div>
  <div class="card" id="socialCard" hidden>
    <h2>Redes sociales</h2>
    <div id="socialBody"></div>
  </div>
  <div class="card" id="reputationCard" hidden>
    <h2>Reseñas y reputación</h2>
    <div id="reputationBody"></div>
  </div>
  <div class="card" id="subscriptionCard" hidden>
    <h2>Plan y límites</h2>
    <div id="subscriptionBody"></div>
  </div>
  <div class="card" id="dataCard" hidden>
    <h2>Datos del cliente</h2>
    <p id="dataEmpty"></p>
    <table id="dataTable"><thead><tr><th>Nombre / tipo</th><th>Detalle</th></tr></thead><tbody id="dataBody"></tbody></table>
  </div>
  <div class="card" id="auditCard" hidden>
    <h2>Registro de actividad</h2>
    <p>Muestra las últimas acciones registradas de tu cliente.</p>
    <table><thead><tr><th>Fecha</th><th>Quién</th><th>Qué se hizo</th><th>Resultado</th></tr></thead><tbody id="auditBody"></tbody></table>
  </div>
  <footer>MainSpot — Piloto de pruebas interno</footer>
</main>
<script>
const token = sessionStorage.getItem('mainspot.token');
if (!token) { window.location.href = '/'; }
const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
const S = {};
const els = {
  denied: document.getElementById('denied'),
  notice: document.getElementById('notice'),
  welcome: document.getElementById('welcome'),
  whoami: document.getElementById('whoami'),
  roleCard: document.getElementById('roleCard'),
  roleDesc: document.getElementById('roleDesc'),
  permissionChips: document.getElementById('permissionChips'),
  actionsCard: document.getElementById('actionsCard'),
  actionsButtons: document.getElementById('actionsButtons'),
  registerDataBlock: document.getElementById('registerDataBlock'),
  newActionBlock: document.getElementById('newActionBlock'),
  actionsListBlock: document.getElementById('actionsListBlock'),
  actionsListBody: document.getElementById('actionsListBody'),
  actionsListNote: document.getElementById('actionsListNote'),
  usersBlock: document.getElementById('usersBlock'),
  usersBody: document.getElementById('usersBody'),
  websiteCard: document.getElementById('websiteCard'),
  websiteBody: document.getElementById('websiteBody'),
  socialCard: document.getElementById('socialCard'),
  socialBody: document.getElementById('socialBody'),
  reputationCard: document.getElementById('reputationCard'),
  reputationBody: document.getElementById('reputationBody'),
  subscriptionCard: document.getElementById('subscriptionCard'),
  subscriptionBody: document.getElementById('subscriptionBody'),
  dataCard: document.getElementById('dataCard'),
  dataBody: document.getElementById('dataBody'),
  dataEmpty: document.getElementById('dataEmpty'),
  auditCard: document.getElementById('auditCard'),
  auditBody: document.getElementById('auditBody'),
};

async function api(path, opts) {
  opts = opts || {};
  const res = await fetch('/api/backoffice' + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(function () { return {}; });
  return { res: res, data: data };
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function has(p) { return (S.permissions || []).includes(p); }
function labelOf(map, key) { return (map && map[key]) ? map[key] : key; }
function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}
function showError(msg) { els.denied.hidden = false; els.denied.textContent = msg; }
function clearError() { els.denied.hidden = true; els.denied.textContent = ''; }
function showNotice(msg) {
  els.notice.hidden = false;
  els.notice.textContent = msg;
  window.setTimeout(function () { els.notice.hidden = true; }, 6000);
}
function toggle(block) { block.hidden = !block.hidden; }
function addLi(ul, text) { const li = document.createElement('li'); li.textContent = text; ul.appendChild(li); }

const STATUS = {
  website: { draft: 'Borrador', published: 'Publicada', suspended: 'Suspendida' },
  domain: { pending: 'Pendiente', dns_provisioned: 'DNS listo', cert_issued: 'Certificado emitido', active: 'Activa', failed: 'Con errores' },
  post: { draft: 'Borrador', awaiting_approval: 'Esperando aprobación', scheduled: 'Programada', published: 'Publicada', rejected: 'Rechazada', failed: 'Con errores' },
  review: { detected: 'Detectada', suggested: 'Con sugerencia', awaiting_human: 'En revisión humana', approved: 'Aprobada', published: 'Respondida', rejected: 'Rechazada', edited: 'Editada', acknowledged: 'Reconocida' },
  action: { created: 'Creada', approved: 'Aprobada', rejected: 'Rechazada', executed: 'Ejecutada' },
  content: { post: 'Publicación', ad: 'Anuncio' },
};
const ROLE_BADGES = {
  administration: ['admin', 'Administración'],
  operation: ['ops', 'Operación'],
  read_only: ['readonly', 'Solo lectura'],
};
const CAP_LABELS = {
  website: 'Páginas web',
  social_posts: 'Publicaciones en redes',
  social_ads: 'Anuncios en redes',
  reviews_managed: 'Reseñas gestionadas',
  agents: 'Usuarios del panel',
  conversations: 'Conversaciones',
};
const ACTION_LABELS = {
  'user.manage': 'Gestionar usuarios y roles',
  'client.config.manage': 'Configurar el cliente',
  'audit.read': 'Ver el registro de auditoría',
  'audit.export': 'Exportar el registro de auditoría',
  'operation.create': 'Crear una operación de prueba',
  'operation.execute': 'Ejecutar operaciones',
  'operation.approve': 'Aprobar operaciones',
  'operation.reject': 'Rechazar operaciones',
  'data.read': 'Ver los datos del cliente',
  'data.write': 'Registrar datos del cliente',
  'conversation.read': 'Ver solicitudes y propuestas del cliente',
  'conversation.send': 'Enviar y recibir mensajes del canal',
  'conversation.confirm': 'Confirmar una propuesta y preparar su vista previa',
  'website.publish': 'Publicar la web del cliente',
  'website.provision': 'Aprovisionar el subdominio del cliente',
  'reputation.read': 'Ver reseñas y casos de reputación',
  'reputation.respond': 'Redactar respuestas públicas',
  'reputation.escalate': 'Escalar casos sensibles a revisión humana',
  'reputation.approve': 'Aprobar respuestas públicas',
  'social.read': 'Ver publicaciones y contenido social',
  'social.create': 'Crear borradores de publicaciones',
  'social.schedule': 'Programar publicaciones con aprobación',
  'social.approve': 'Aprobar publicaciones para revisión',
  'subscription.admin': 'Asignar el plan de suscripción',
  'subscription.read': 'Ver el plan y los límites del cliente',
  'analytics.read': 'Ver resúmenes de actividad del cliente',
  'analytics.export': 'Exportar eventos de auditoría del cliente',
  'analytics.retention': 'Ver qué datos purgará la retención automática',
};

async function init() {
  const r = await api('/me');
  if (!r.res.ok) { showError('No se pudo cargar tu sesión. Vuelve a ingresar.'); return; }
  Object.assign(S, r.data.session || {});
  els.welcome.textContent = 'Hola, ' + (S.display_name || S.user_id);
  const from = (S.tenant && S.tenant.business_name) ? S.tenant.business_name : S.tenant_id;
  els.whoami.textContent = 'Trabajas con el cliente ' + from + '.';
  renderRole();
  renderActions();
  if (has('website.publish') || has('website.provision')) loadWebsite();
  if (has('social.read')) loadSocial();
  if (has('reputation.read')) loadReputation();
  if (has('subscription.read')) loadSubscription();
  if (has('data.read')) loadData();
  if (has('audit.read')) loadAudit();
}

function renderRole() {
  const badge = ROLE_BADGES[S.role_id] || ['readonly', S.role_label || S.role_id];
  els.roleCard.hidden = false;
  els.roleDesc.innerHTML = '<span class="badge ' + esc(badge[0]) + '">' + esc(badge[1]) + '</span> ' +
    (S.role_description ? esc(S.role_description) : '');
  els.permissionChips.innerHTML = '';
  const perms = S.permissions || [];
  for (let i = 0; i < perms.length; i++) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = ACTION_LABELS[perms[i]] || perms[i];
    els.permissionChips.appendChild(span);
  }
}

function renderActions() {
  const box = els.actionsButtons;
  box.innerHTML = '';
  const buttons = [];
  if (has('data.write')) buttons.push(['actDataWrite', 'Registrar un dato del cliente', function () { toggle(els.registerDataBlock); }]);
  if (has('operation.create')) buttons.push(['actOpsCreate', 'Crear una operación de prueba', function () { toggle(els.newActionBlock); }]);
  if (has('operation.approve') || has('operation.reject') || has('operation.execute')) buttons.push(['actOpsList', 'Ver operaciones y responder', loadActions]);
  if (has('audit.export')) buttons.push(['actAuditExport', 'Exportar el registro de actividad', exportAudit]);
  if (has('user.manage')) buttons.push(['actUsers', 'Gestionar usuarios del cliente', loadUsers]);
  if (buttons.length === 0) { els.actionsCard.hidden = true; return; }
  els.actionsCard.hidden = false;
  for (let i = 0; i < buttons.length; i++) {
    const b = document.createElement('button');
    b.className = 'secondary';
    b.type = 'button';
    b.textContent = buttons[i][1];
    b.addEventListener('click', buttons[i][2]);
    box.appendChild(b);
  }
  if (has('client.config.manage')) {
    const p = document.createElement('p');
    p.textContent = 'Configurar el cliente: esta función estará disponible en una próxima versión.';
    box.appendChild(p);
  }
}

function makePostButton(labelEl, path, refresh) {
  const b = document.createElement('button');
  b.className = 'secondary';
  b.type = 'button';
  b.textContent = labelEl;
  b.addEventListener('click', async function () {
    clearError();
    const r = await api(path, { method: 'POST', body: {} });
    if (!r.res.ok) {
      showError((r.data.error && r.data.error.message) || 'No se pudo completar la acción. Revisa los datos e inténtalo de nuevo.');
      return;
    }
    showNotice((r.data.message) || 'Listo.');
    refresh();
  });
  return b;
}

async function loadActions() {
  clearError();
  const r = await api('/actions');
  if (r.res.status === 403) { showError((r.data.error && r.data.error.message) || 'Tu perfil no permite ver las operaciones.'); return; }
  if (!r.res.ok) { showError((r.data.error && r.data.error.message) || 'No se pudieron cargar las operaciones.'); return; }
  els.actionsListBlock.hidden = false;
  const rows = r.data.actions || [];
  els.actionsListBody.innerHTML = '';
  if (rows.length === 0) { els.actionsListNote.textContent = 'Todavía no hay operaciones de prueba para este cliente.'; return; }
  els.actionsListNote.textContent = '';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = row.title;
    const td2 = document.createElement('td'); td2.textContent = labelOf(STATUS.action, row.status);
    const td3 = document.createElement('td'); td3.textContent = row.created_by;
    const td4 = document.createElement('td');
    if (row.status === 'created' && has('operation.approve')) td4.appendChild(makePostButton('Aprobar', '/actions/' + row.action_id + '/approve', loadActions));
    if (row.status === 'created' && has('operation.reject')) td4.appendChild(makePostButton('Rechazar', '/actions/' + row.action_id + '/reject', loadActions));
    if (row.status === 'approved' && has('operation.execute')) td4.appendChild(makePostButton('Ejecutar', '/actions/' + row.action_id + '/execute', loadActions));
    if (td4.childNodes.length === 0) td4.textContent = '—';
    tr.append(td1, td2, td3, td4);
    els.actionsListBody.appendChild(tr);
  }
}

async function exportAudit() {
  clearError();
  const res = await fetch('/api/backoffice/audit/export', { method: 'GET', headers: headers });
  if (!res.ok) {
    const d = await res.json().catch(function () { return {}; });
    showError((d.error && d.error.message) || 'No se pudo exportar el registro.');
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'registro-de-actividad.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showNotice('Exportación lista. Revisa tu carpeta de descargas.');
}

async function loadUsers() {
  clearError();
  const r = await api('/users');
  if (r.res.status === 403) { showError((r.data.error && r.data.error.message) || 'Tu perfil no permite gestionar usuarios.'); return; }
  if (!r.res.ok) { showError((r.data.error && r.data.error.message) || 'No se pudieron cargar los usuarios.'); return; }
  els.usersBlock.hidden = false;
  els.usersBody.innerHTML = '';
  const rows = r.data.users || [];
  for (let i = 0; i < rows.length; i++) {
    const u = rows[i];
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = u.display_name;
    const td2 = document.createElement('td'); td2.textContent = u.status;
    tr.append(td1, td2);
    els.usersBody.appendChild(tr);
  }
}

async function loadWebsite() {
  const r = await api('/website');
  els.websiteCard.hidden = false;
  const body = els.websiteBody;
  body.innerHTML = '';
  if (!r.res.ok) {
    const p = document.createElement('p');
    p.setAttribute('role', 'alert');
    p.textContent = 'No se pudo cargar la página web: ' + ((r.data.error && r.data.error.message) || 'inténtalo de nuevo.');
    body.appendChild(p);
    return;
  }
  const site = r.data.website;
  const domain = r.data.domain;
  if (!site) {
    const p = document.createElement('p');
    p.textContent = 'Este cliente todavía no tiene página web.';
    body.appendChild(p);
    if (has('website.provision')) {
      const form = document.createElement('form');
      form.innerHTML = '<label for="web_site_name">Nombre del sitio</label>' +
        '<input id="web_site_name" name="site_name" required>' +
        '<label for="web_slug">Subdominio deseado (letras minúsculas, números y guiones, sin espacios)</label>' +
        '<input id="web_slug" name="slug" pattern="[a-z0-9-]{2,63}" required>' +
        '<div style="margin-top:0.75rem"><button type="submit">Crear página web</button></div>';
      body.appendChild(form);
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        clearError();
        const siteName = document.getElementById('web_site_name').value.trim();
        const slug = document.getElementById('web_slug').value.trim().toLowerCase();
        const rr = await api('/website', { method: 'POST', body: { site_name: siteName, slug: slug } });
        if (!rr.res.ok) { showError((rr.data.error && rr.data.error.message) || 'No se pudo crear la página web.'); return; }
        showNotice('Página web creada.');
        loadWebsite();
      });
    }
    return;
  }
  const ul = document.createElement('ul');
  addLi(ul, 'Estado: ' + labelOf(STATUS.website, site.status));
  addLi(ul, 'Nombre: ' + site.site_name);
  addLi(ul, 'Subdominio: ' + site.slug + '.sim.mainspot.local (simulado)');
  addLi(ul, 'Versión publicada: ' + String(site.published_version));
  body.appendChild(ul);
  if (domain) {
    const dP = document.createElement('p');
    dP.textContent = 'Subdominio aprovisionado: ' + domain.subdomain + ' (estado: ' + labelOf(STATUS.domain, domain.status) + ')';
    body.appendChild(dP);
  } else if (has('website.provision')) {
    body.appendChild(makePostButton('Aprovisionar subdominio', '/website/provision', loadWebsite));
  }
}

async function loadSocial() {
  const r = await api('/social/posts');
  els.socialCard.hidden = false;
  const body = els.socialBody;
  body.innerHTML = '';
  if (!r.res.ok) {
    const p = document.createElement('p');
    p.setAttribute('role', 'alert');
    p.textContent = 'No se pudo cargar el contenido social: ' + ((r.data.error && r.data.error.message) || 'inténtalo de nuevo.');
    body.appendChild(p);
    return;
  }
  const rows = r.data.posts || [];
  if (has('social.create')) {
    const form = document.createElement('form');
    form.innerHTML = '<label for="soc_text">Nuevo borrador</label>' +
      '<textarea id="soc_text" rows="3" required></textarea>' +
      '<div style="margin-top:0.75rem"><button type="submit">Crear borrador</button></div>';
    body.appendChild(form);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      clearError();
      const text = document.getElementById('soc_text').value.trim();
      const rr = await api('/social/posts', { method: 'POST', body: { text: text } });
      if (!rr.res.ok) { showError((rr.data.error && rr.data.error.message) || 'No se pudo crear el borrador.'); return; }
      showNotice('Borrador creado. Para publicarlo debe pasar por aprobación.');
      document.getElementById('soc_text').value = '';
      loadSocial();
    });
  }
  if (rows.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Todavía no hay publicaciones para este cliente.';
    body.appendChild(p);
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Texto</th><th>Tipo</th><th>Estado</th><th>Programada para</th><th>Acciones</th></tr></thead>';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = truncate(row.text || '', 90);
    const td2 = document.createElement('td'); td2.textContent = labelOf(STATUS.content, row.content_type);
    const td3 = document.createElement('td'); td3.textContent = labelOf(STATUS.post, row.status);
    const td4 = document.createElement('td');
    td4.textContent = row.scheduled_at ? new Date(row.scheduled_at).toLocaleString('es') : '—';
    const td5 = document.createElement('td');
    if ((row.status === 'draft' || row.status === 'rejected') && has('social.schedule')) {
      const mini = document.createElement('span');
      mini.innerHTML = '<input type="datetime-local" aria-label="Fecha y hora de publicación"> ';
      const b = document.createElement('button');
      b.className = 'secondary';
      b.type = 'button';
      b.textContent = 'Programar';
      b.addEventListener('click', async function () {
        const when = mini.getElementsByTagName('input')[0].value;
        if (!when) { showError('Elige fecha y hora para programar la publicación.'); return; }
        clearError();
        const rr = await api('/social/posts/' + row.post_id + '/schedule', { method: 'POST', body: { publish_at: new Date(when).toISOString() } });
        if (!rr.res.ok) { showError((rr.data.error && rr.data.error.message) || 'No se pudo programar la publicación.'); return; }
        showNotice('Publicación programada. Requiere aprobación antes de publicarse.');
        loadSocial();
      });
      mini.appendChild(b);
      td5.appendChild(mini);
    }
    if ((row.status === 'draft' || row.status === 'awaiting_approval') && has('social.approve')) {
      td5.appendChild(makePostButton('Aprobar', '/social/posts/' + row.post_id + '/approve', loadSocial));
    }
    if ((row.status === 'awaiting_approval' || row.status === 'scheduled') && has('social.schedule')) {
      td5.appendChild(makePostButton('Rechazar', '/social/posts/' + row.post_id + '/reject', loadSocial));
    }
    if (td5.childNodes.length === 0) td5.textContent = '—';
    tr.append(td1, td2, td3, td4, td5);
    tbody.appendChild(tr);
  }
  body.appendChild(table);
}

async function loadReputation() {
  const r = await api('/reputation/reviews');
  els.reputationCard.hidden = false;
  const body = els.reputationBody;
  body.innerHTML = '';
  if (!r.res.ok) {
    const p = document.createElement('p');
    p.setAttribute('role', 'alert');
    p.textContent = 'No se pudieron cargar las reseñas: ' + ((r.data.error && r.data.error.message) || 'inténtalo de nuevo.');
    body.appendChild(p);
    return;
  }
  if (has('reputation.respond')) {
    const sync = document.createElement('button');
    sync.className = 'secondary';
    sync.type = 'button';
    sync.textContent = 'Sincronizar reseñas del simulador';
    sync.addEventListener('click', async function () {
      clearError();
      const rr = await api('/reputation/reviews/sync', { method: 'POST', body: {} });
      if (!rr.res.ok) { showError((rr.data.error && rr.data.error.message) || 'No se pudieron sincronizar las reseñas.'); return; }
      showNotice('Reseñas sincronizadas. Revisa la lista.');
      loadReputation();
    });
    body.appendChild(sync);
  }
  const rows = r.data.reviews || [];
  if (rows.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Todavía no hay reseñas para este cliente.';
    body.appendChild(p);
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Autor</th><th>Puntaje</th><th>Reseña</th><th>Estado</th><th>Acciones</th></tr></thead>';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = row.author_name || 'Anónimo';
    const td2 = document.createElement('td'); td2.textContent = '★ ' + String(row.star_rating);
    const td3 = document.createElement('td'); td3.textContent = truncate(row.review_text || '', 90);
    const td4 = document.createElement('td'); td4.textContent = labelOf(STATUS.review, row.state);
    const td5 = document.createElement('td');
    if (has('reputation.respond')) {
      const mini = document.createElement('span');
      mini.innerHTML = '<textarea rows="2" placeholder="Redacta aquí el borrador de respuesta pública (aún no se publica)" aria-label="Borrador de respuesta"></textarea> ';
      const b = document.createElement('button');
      b.className = 'secondary';
      b.type = 'button';
      b.textContent = 'Guardar borrador';
      b.addEventListener('click', async function () {
        const text = mini.getElementsByTagName('textarea')[0].value;
        clearError();
        const rr = await api('/reputation/reviews/' + row.review_id + '/response', { method: 'POST', body: { text: text } });
        if (!rr.res.ok) { showError((rr.data.error && rr.data.error.message) || 'No se pudo guardar el borrador.'); return; }
        showNotice('Borrador de respuesta guardado. Aún no se publica nada.');
        loadReputation();
      });
      mini.appendChild(b);
      td5.appendChild(mini);
    }
    if ((row.state === 'suggested' || row.state === 'awaiting_human') && has('reputation.escalate')) {
      td5.appendChild(makePostButton('Escalar a revisión humana', '/reputation/reviews/' + row.review_id + '/escalate', loadReputation));
    }
    if (row.response_text && row.state !== 'approved' && row.state !== 'published' && row.state !== 'rejected' && has('reputation.approve')) {
      td5.appendChild(makePostButton('Aprobar respuesta', '/reputation/reviews/' + row.review_id + '/approve', loadReputation));
    }
    if (td5.childNodes.length === 0) td5.textContent = '—';
    tr.append(td1, td2, td3, td4, td5);
    tbody.appendChild(tr);
  }
  body.appendChild(table);
}

async function loadSubscription() {
  const r = await api('/subscriptions/entitlements');
  els.subscriptionCard.hidden = false;
  const body = els.subscriptionBody;
  body.innerHTML = '';
  if (r.res.status === 404) {
    const p = document.createElement('p');
    p.textContent = 'Este cliente todavía no tiene un plan asignado. Consulta con el administrador de MainSpot.';
    body.appendChild(p);
    return;
  }
  if (!r.res.ok) {
    const p = document.createElement('p');
    p.setAttribute('role', 'alert');
    p.textContent = 'No se pudo cargar el plan: ' + ((r.data.error && r.data.error.message) || 'inténtalo de nuevo.');
    body.appendChild(p);
    return;
  }
  const e = r.data.entitlements || {};
  const plan = e.plan || {};
  const status = (e.subscription && e.subscription.status) || '';
  const h3 = document.createElement('h3');
  h3.textContent = (plan.name || 'Plan') + (status ? ' (' + status + ')' : '');
  body.appendChild(h3);
  if (plan.description) {
    const p = document.createElement('p');
    p.textContent = plan.description;
    body.appendChild(p);
  }
  const limitRows = Object.keys(e.limits || {});
  if (limitRows.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Este plan no tiene límites configurados.';
    body.appendChild(p);
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Área</th><th>Límite del plan</th></tr></thead>';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  for (let i = 0; i < limitRows.length; i++) {
    const cap = limitRows[i];
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = CAP_LABELS[cap] || cap;
    const td2 = document.createElement('td'); td2.textContent = String(e.limits[cap]);
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
  body.appendChild(table);
}

async function loadData() {
  const r = await api('/data');
  if (r.res.status === 403) { showError((r.data.error && r.data.error.message) || 'No tienes permiso para ver los datos del cliente.'); return; }
  if (!r.res.ok) return;
  els.dataCard.hidden = false;
  const rows = (r.data && r.data.data) || [];
  const tbody = els.dataBody;
  tbody.innerHTML = '';
  els.dataEmpty.textContent = rows.length ? '' : 'Todavía no hay datos registrados para este cliente.';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = row.kind || 'dato';
    const td2 = document.createElement('td'); td2.textContent = JSON.stringify(row.payload || {});
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
}

async function loadAudit() {
  const r = await api('/audit');
  if (r.res.status === 403) { showError((r.data.error && r.data.error.message) || 'No tienes permiso para ver el registro de actividad.'); return; }
  if (!r.res.ok) return;
  els.auditCard.hidden = false;
  const tbody = els.auditBody;
  tbody.innerHTML = '';
  const events = r.data.events || (Array.isArray(r.data) ? r.data : []);
  for (let i = 0; i < Math.min(events.length, 20); i++) {
    const ev = events[i];
    const tr = document.createElement('tr');
    const t1 = document.createElement('td'); t1.textContent = new Date(ev.ts).toLocaleString('es');
    const t2 = document.createElement('td'); t2.textContent = ev.actor_id;
    const t3 = document.createElement('td'); t3.textContent = ev.action + (ev.resource ? ' (' + ev.resource + ')' : '');
    const t4 = document.createElement('td'); t4.textContent = ev.decision + ' / ' + ev.result;
    tr.append(t1, t2, t3, t4);
    tbody.appendChild(tr);
  }
}

document.getElementById('registerDataForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  clearError();
  const kind = document.getElementById('rd_kind').value.trim() || 'client.asset';
  const payloadRaw = document.getElementById('rd_payload').value.trim();
  let payload = { value: payloadRaw };
  if (payloadRaw) {
    try {
      payload = JSON.parse(payloadRaw);
    } catch (err) { payload = { value: payloadRaw }; }
  }
  const r = await api('/data', { method: 'POST', body: { kind: kind, payload: payload } });
  if (!r.res.ok) { showError((r.data.error && r.data.error.message) || 'No se pudo guardar el dato.'); return; }
  showNotice('Dato guardado.');
  els.registerDataBlock.hidden = true;
  loadData();
});

document.getElementById('newActionForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  clearError();
  const title = document.getElementById('na_title').value.trim();
  const r = await api('/actions', { method: 'POST', body: { title: title } });
  if (!r.res.ok) { showError((r.data.error && r.data.error.message) || 'No se pudo crear la operación.'); return; }
  showNotice('Operación creada.');
  document.getElementById('na_title').value = '';
  loadActions();
});

document.getElementById('createUserForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  clearError();
  const body = {
    display_name: document.getElementById('cu_name').value.trim(),
    login: document.getElementById('cu_login').value.trim(),
    password: document.getElementById('cu_password').value,
    role: document.getElementById('cu_role').value,
  };
  const r = await api('/users', { method: 'POST', body: body });
  if (!r.res.ok) { showError((r.data.error && r.data.error.message) || 'No se pudo crear el usuario.'); return; }
  showNotice('Usuario creado.');
  document.getElementById('createUserForm').reset();
  loadUsers();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  // IR-04: the UI must call the real logout route (revokes the session).
  await fetch('/api/auth/logout', { method: 'POST', headers }).catch(() => undefined);
  sessionStorage.removeItem('mainspot.token');
  window.location.href = '/';
});
init();
</script>
</body>
</html>`;
}

export function errorPageHtml(message: string, status: number): string {
  const title = status >= 500 ? 'Ocurrió un problema en el servidor' : 'No se pudo completar la operación';
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>MainSpot — ${esc(title)}</title><style>${SHARED_CSS}</style></head>
<body><main><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Volver al inicio</a></p></div></main></body>
</html>`;
}

// --- INC-002/INC-003: páginas públicas de preview/sandbox (CAP-008, AC-007) ---

function detailToHuman(detail: unknown): string[] {
  if (!detail || typeof detail !== 'object') return [];
  const sentences = (detail as { diff_sentences?: unknown }).diff_sentences;
  if (Array.isArray(sentences)) return sentences.filter((s): s is string => typeof s === 'string');
  return [];
}

export interface PreviewPageInput {
  token: string;
  summary: string;
  detail: unknown;
  previewHtml: string | null;
  expiresAt?: string | null;
}

export function previewPageHtml(input: PreviewPageInput): string {
  const sentences = detailToHuman(input.detail);
  const diffList = (sentences.length ? sentences : [input.summary]).map((s) => `<li>${esc(s)}</li>`).join('\n');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MainSpot — Vista previa</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Vista previa de tus cambios</h1>
    <p>Revisa los cambios que se aplicarían a tu página web. Nada se publica hasta que tú lo apruebes.</p>
    ${input.expiresAt ? `<p class="error-text">Este enlace expira en su momento programado.</p>` : ''}
    <h2>Resumen de cambios</h2>
    <ul>${diffList}</ul>
    <form method="post" action="/preview/${esc(input.token)}/apply">
      <p><button type="submit">Aplicar cambios</button></p>
      <p class="error-text">Al presionar el botón autorizas la publicación de estos cambios.</p>
    </form>
  </div>
  ${input.previewHtml ? `<div class="card"><h2>Así se vería tu página</h2><div style="border:1px solid #c3cdd6;border-radius:8px;overflow:auto">${input.previewHtml}</div></div>` : ''}
  <footer>MainSpot — Vista previa (aún no publicada)</footer>
</main>
</body>
</html>`;
}

export function previewExpiredPageHtml(alreadyPublished = false): string {
  const title = alreadyPublished ? 'Estos cambios ya fueron publicados' : 'El enlace expiró';
  const body = alreadyPublished
    ? 'Los cambios de este enlace ya se aplicaron y publicaron antes. No se duplicó nada.'
    : 'El enlace de vista previa expiró y ya no permite aplicar cambios. Pide una nueva vista previa en tu panel de MainSpot.';
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>MainSpot — ${esc(title)}</title><style>${SHARED_CSS}</style></head>
<body><main><div class="card"><h1>${esc(title)}</h1><p>${esc(body)}</p><p><a href="/">Volver al inicio</a></p></div></main></body>
</html>`;
}

export function previewNotFoundPageHtml(): string {
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>MainSpot — Enlace no válido</title><style>${SHARED_CSS}</style></head>
<body><main><div class="card"><h1>Enlace no válido</h1><p>Este enlace de vista previa no existe o ya no es válido.</p><p><a href="/">Volver al inicio</a></p></div></main></body>
</html>`;
}
