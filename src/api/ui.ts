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
  input, select { width: 100%; box-sizing: border-box; padding: 0.6rem; border: 1px solid #9aa7b3; border-radius: 8px; font-size: 1rem; }
  button { padding: 0.65rem 1rem; border: 0; border-radius: 8px; background: #0b5ba6; color: #fff; font-size: 1rem; cursor: pointer; }
  button.secondary { background: #e7ecf1; color: #1f2933; }
  a { color: #0b5ba6; }
  [role="alert"] { background: #fdecea; border: 1px solid #f5b7b1; color: #7a1f1a; padding: 0.75rem; border-radius: 8px; margin-top: 0.75rem; }
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
  <div class="card" id="actionsCard" hidden>
    <h2>Lo que puedes hacer</h2>
    <div class="actions" id="actions"></div>
  </div>
  <div class="card" id="dataCard" hidden>
    <h2>Datos del cliente</h2>
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
const els = { denied: document.getElementById('denied') };

async function api(path, opts = {}) {
  const res = await fetch('/api/backoffice' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}
function showError(msg) { els.denied.hidden = false; els.denied.textContent = msg; }

async function init() {
  const { res, data } = await api('/me');
  if (!res.ok) { showError('No se pudo cargar tu sesión. Vuelve a ingresar.'); return; }
  const s = data.session || data;
  document.getElementById('welcome').textContent = 'Hola, ' + (s.display_name || s.user_id);
  const from = s.tenant?.business_name || s.tenant_id;
  const role = s.role?.label || s.role_id;
  const cls = (s.role_id || s.role).includes('admin') ? 'admin' : (s.role_id || s.role).includes('operation') ? 'ops' : 'readonly';
  document.getElementById('whoami').innerHTML = 'Trabajas con el cliente <strong>' + esc(from || '') + '</strong> · Perfil <span class="badge ' + cls + '">' + esc(role) + '</span>';
  renderActions(s.permissions || []);
  await loadData();
  if ((s.permissions || []).includes('audit.read')) loadAudit();
}
const LABELS = {
  'user.manage': 'Gestionar usuarios y roles',
  'client.config.manage': 'Configurar el cliente',
  'audit.read': 'Ver registro de actividad',
  'audit.export': 'Exportar registro',
  'operation.create': 'Crear una operación de prueba',
  'operation.execute': 'Ejecutar operaciones',
  'operation.approve': 'Aprobar operaciones',
  'operation.reject': 'Rechazar operaciones',
  'data.read': 'Ver datos del cliente',
  'data.write': 'Registrar datos',
};
const ACTION_ORDER = ['data.read','data.write','operation.create','operation.execute','operation.approve','operation.reject','audit.read','audit.export','user.manage','client.config.manage'];
function renderActions(permissions) {
  const card = document.getElementById('actionsCard');
  const box = document.getElementById('actions');
  box.innerHTML = '';
  const shown = ACTION_ORDER.filter((a) => permissions.includes(a));
  if (shown.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  for (const a of shown) {
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = LABELS[a] || a;
    box.appendChild(b);
  }
}
async function loadData() {
  const { res, data } = await api('/data');
  if (res.status === 403) { showError(data.error && data.error.message ? data.error.message : 'No tienes permiso para ver los datos.'); return; }
  if (!res.ok) return;
  const card = document.getElementById('dataCard');
  const tbody = document.getElementById('dataBody');
  tbody.innerHTML = '';
  card.hidden = false;
  for (const row of (data.data || data || [])) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = row.kind || 'dato';
    const td2 = document.createElement('td'); td2.textContent = JSON.stringify(row.payload || {});
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
}
async function loadAudit() {
  const { res, data } = await api('/audit');
  if (res.status === 403) { showError(data.error && data.error.message ? data.error.message : 'No tienes permiso para ver el registro de actividad.'); return; }
  if (!res.ok) return;
  const card = document.getElementById('auditCard');
  const tbody = document.getElementById('auditBody');
  tbody.innerHTML = '';
  card.hidden = false;
  const events = (data.events || (Array.isArray(data) ? data : []));
  for (const ev of events.slice(0, 20)) {
    const tr = document.createElement('tr');
    const d = new Date(ev.ts).toLocaleString('es');
    const t1 = document.createElement('td'); t1.textContent = d;
    const t2 = document.createElement('td'); t2.textContent = ev.actor_id;
    const t3 = document.createElement('td'); t3.textContent = ev.action + (ev.resource ? ' (' + ev.resource + ')' : '');
    const t4 = document.createElement('td'); t4.textContent = ev.decision + ' / ' + ev.result;
    tr.append(t1, t2, t3, t4);
    tbody.appendChild(tr);
  }
}
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
