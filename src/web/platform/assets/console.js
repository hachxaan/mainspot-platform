/* =========================================================================
   MainSpot · Consolas de plataforma (FR-0018 Administration, FR-0019 Engineering Console)
   - Sesión propia (token de plataforma en sessionStorage, distinto del panel del negocio).
   - Acciones con efecto piden step-up TOTP cuando el servidor responde step_up_required.
   - Nunca muestra secretos, tokens ni contenido de conversaciones (el servidor no los envía).
   ========================================================================= */
(function () {
  'use strict';
  var KEY = 'mainspot.platform.token';
  var app;
  var S = { session: null, env: null, real: false, data: {}, loading: {}, pending: null, flash: null, ev: null };

  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function icon(n) { return '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"></use></svg>'; }
  function token() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } }
  function setToken(t) { try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch (e) { /* sin almacenamiento */ } }
  function toast(t) { var w = document.getElementById('toasts'); if (!w) return; w.innerHTML = '<div class="toast">' + esc(t) + '</div>'; setTimeout(function () { w.innerHTML = ''; }, 4000); }
  function money(v) { var n = Number(v || 0); return 'USD ' + (n < 0.01 && n > 0 ? n.toFixed(6) : n.toFixed(4)); }
  function when(v) { if (!v) return '—'; var d = new Date(v); return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }); }
  function tag(t, tone) { return '<span class="tag tag-' + (tone || 'neutral') + '">' + esc(t) + '</span>'; }
  function btn(label, o) {
    o = o || {};
    var cls = 'btn btn-' + (o.style || 'primary') + (o.sm ? ' btn-sm' : '');
    var attrs = (o.action ? ' data-action="' + o.action + '"' : '') + (o.arg != null ? ' data-arg="' + esc(o.arg) + '"' : '') + (o.id ? ' id="' + o.id + '"' : '');
    if (o.href) return '<a class="' + cls + '" href="' + esc(o.href) + '"' + attrs + '><span>' + esc(label) + '</span></a>';
    return '<button type="' + (o.type || 'button') + '" class="' + cls + '"' + attrs + '><span>' + esc(label) + '</span></button>';
  }

  function api(method, path, body) {
    var h = { Accept: 'application/json' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    var t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    return fetch('/api/platform' + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
          var out = { ok: res.ok, status: res.status, data: data, error: res.ok ? null : ((data && data.error) || { code: 'http_' + res.status, message: 'No se pudo completar.' }) };
          if (res.status === 401 && path !== '/auth/login' && S.session) { S.session = null; setToken(null); render(); }
          return out;
        });
      }, function () { return { ok: false, status: 0, data: null, error: { code: 'network', message: 'Sin conexión con el servidor.' } }; });
  }
  /** Acción con efecto: si el servidor pide step-up, se guarda y se pide el código TOTP. */
  function act(method, path, body, done) {
    return api(method, path, body).then(function (r) {
      if (!r.ok && r.error && r.error.code === 'step_up_required') { S.pending = { method: method, path: path, body: body, done: done }; render(); var f = document.getElementById('su-code'); if (f) f.focus(); return; }
      done(r);
    });
  }

  function load(key, path, force) {
    if (!force && (S.data[key] || S.loading[key])) return S.data[key] || null;
    S.loading[key] = true;
    api('GET', path).then(function (r) { S.loading[key] = false; S.data[key] = r.ok ? r.data : { error: r.error.message }; render(); });
    return S.data[key] || null;
  }
  function reload(key, path) { delete S.data[key]; load(key, path, true); }
  function has(role) { return !!(S.session && S.session.roles.indexOf(role) >= 0); }

  /* ------------------------------------------------------------------ vistas */
  function loginView() {
    return '<div class="ob"><div class="ob-wrap"><main class="ob-body" id="main"><h1 tabindex="-1" data-focus>Consola de plataforma</h1><p>Acceso solo para el equipo de MainSpot. Usa tu contraseña y el código de tu app de autenticación.</p>' +
      '<form class="stack" data-form="login" style="margin-top:16px"><div class="field"><label for="pl-login">Usuario</label><input class="input" id="pl-login" autocomplete="username" required></div>' +
      '<div class="field"><label for="pl-pass">Contraseña</label><input class="input" id="pl-pass" type="password" autocomplete="current-password" required></div>' +
      '<div class="field"><label for="pl-code">Código de verificación (6 dígitos)</label><input class="input" id="pl-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>' +
      '<div class="field-error" id="pl-error" role="alert"' + (S.flash ? '' : ' hidden') + '>' + esc(S.flash || '') + '</div>' +
      '<div class="btn-row">' + btn('Entrar', { type: 'submit', id: 'pl-submit' }) + '</div></form></main></div></div>';
  }

  function stepUpView() {
    if (!S.pending) return '';
    return '<div class="sheet-wrap" role="dialog" aria-modal="true" aria-labelledby="su-t" style="position:fixed;inset:0;background:#0006;display:grid;place-items:center;z-index:50"><form class="card stack" data-form="step-up" style="max-width:420px;width:92%"><h2 id="su-t">Confirma con tu código</h2><p>Esta acción cambia la operación de MainSpot. Escribe el código de tu app de autenticación.</p>' +
      '<div class="field"><label for="su-code">Código (6 dígitos)</label><input class="input" id="su-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>' +
      '<div class="field-error" id="su-error" role="alert" hidden></div><div class="btn-row">' + btn('Confirmar', { type: 'submit', id: 'su-submit' }) + btn('Cancelar', { action: 'step-up-cancel', style: 'secondary' }) + '</div></form></div>';
  }

  function tenantsView() {
    var d = load('tenants', '/tenants');
    var html = '<h1 tabindex="-1" data-focus>Negocios</h1><p class="muted">Actividad, consumo y salud por negocio. Sin contenido de conversaciones.</p>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    html += '<div class="pc-scroll card card-flush"><table class="pc-table"><caption class="sr-only">Negocios</caption><thead><tr><th scope="col">Negocio</th><th scope="col">Estado</th><th scope="col">Datos</th><th scope="col">Plan</th><th scope="col">Página</th><th scope="col">IA 30 d</th><th scope="col">Fallos 7 d</th><th scope="col">Casos</th><th scope="col">Última actividad</th></tr></thead><tbody>' +
      d.tenants.map(function (t) {
        return '<tr><td><a href="#/negocio/' + encodeURIComponent(t.client_id) + '">' + esc(t.business_name) + '</a><div class="pc-mono muted">' + esc(t.client_id) + '</div></td><td>' + tag(t.status, t.status === 'active' ? 'nopal' : 'alerta') + '</td><td>' + tag(t.data_classification === 'synthetic' ? 'Sintético' : 'Real', t.data_classification === 'synthetic' ? 'lila' : 'neutral') + '</td><td>' + esc(t.plan || '—') + '</td><td>' + (t.published_version ? 'v' + esc(t.published_version) : 'sin publicar') + '</td><td>' + esc(t.ai_calls_30d) + ' · ' + money(t.ai_cost_30d) + '</td><td>' + esc(Number(t.ai_failures_7d) + Number(t.jobs_failed_7d)) + '</td><td>' + esc(t.cases_pending) + '</td><td>' + esc(when(t.last_activity)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    return html;
  }

  function tenantView(id) {
    var d = load('tenant:' + id, '/tenants/' + encodeURIComponent(id));
    var html = '<p><a href="#/negocios">← Negocios</a></p>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    var t = d.tenant;
    html += '<h1 tabindex="-1" data-focus>' + esc(t.business_name) + '</h1><div class="pc-grid">' +
      '<section class="card stack"><h2>Cuenta</h2><dl class="pc-kv"><dt>Id</dt><dd class="pc-mono">' + esc(t.client_id) + '</dd><dt>Estado</dt><dd>' + esc(t.status) + '</dd><dt>Datos</dt><dd>' + esc(t.data_classification) + '</dd><dt>Plan</dt><dd>' + esc(t.plan || '—') + ' (' + esc(t.subscription_status || '—') + ')</dd><dt>Alta</dt><dd>' + esc(when(t.created_at)) + '</dd></dl></section>' +
      '<section class="card stack"><h2>Consumo del mes</h2>' + (d.usage_month.length ? '<ul>' + d.usage_month.map(function (u) { return '<li>' + esc(u.capability) + ': ' + esc(u.units) + '</li>'; }).join('') + '</ul>' : '<p class="muted">Sin consumo.</p>') + '</section>' +
      '<section class="card stack"><h2>IA (30 días)</h2>' + (d.ai_30d.length ? '<ul>' + d.ai_30d.map(function (u) { return '<li><span class="pc-mono">' + esc(u.use_case_id) + '</span>: ' + esc(u.calls) + ' llamadas, ' + esc(u.failed) + ' fallidas, ' + money(u.cost_usd) + '</li>'; }).join('') + '</ul>' : '<p class="muted">Sin uso.</p>') + '</section>' +
      '<section class="card stack"><h2>Conexiones</h2>' + (d.connections.length ? '<ul>' + d.connections.map(function (c) { return '<li>' + esc(c.provider) + ': ' + esc(c.status) + (c.last_error_code ? ' (' + esc(c.last_error_code) + ')' : '') + '</li>'; }).join('') + '</ul>' : '<p class="muted">Sin conexiones reales.</p>') + '</section>' +
      '</div>';
    if (has('platform_admin')) {
      html += '<section class="card stack" style="margin-top:16px"><h2>Acciones de administración</h2><p class="tiny">Cada acción pide motivo y código de verificación, y queda en la auditoría de plataforma y del negocio.</p>' +
        '<form class="stack" data-form="tenant-admin" data-id="' + esc(t.client_id) + '"><div class="field"><label for="ta-op">Acción</label><select class="select" id="ta-op" required><option value="">Elige una acción</option><option value="status:suspended">Suspender</option><option value="status:active">Reactivar</option><option value="class:synthetic">Marcar datos como sintéticos (laboratorio)</option><option value="class:real">Marcar datos como reales</option></select></div>' +
        '<div class="field"><label for="ta-reason">Motivo</label><input class="input" id="ta-reason" minlength="10" maxlength="500" required></div><div class="btn-row">' + btn('Aplicar', { type: 'submit', id: 'ta-submit', style: 'secondary' }) + '</div></form></section>';
    }
    html += '<section class="card stack" style="margin-top:16px"><h2>Acceso de soporte</h2><p class="tiny">Temporal, con motivo, visible para el negocio en su auditoría. Muestra solo un resumen operativo.</p>' +
      '<form class="stack" data-form="support" data-id="' + esc(t.client_id) + '"><div class="field"><label for="sp-reason">Motivo</label><input class="input" id="sp-reason" minlength="10" maxlength="500" required></div><div class="field"><label for="sp-min">Minutos</label><input class="input" id="sp-min" type="number" min="5" max="120" value="30"></div><div class="btn-row">' + btn('Solicitar acceso', { type: 'submit', style: 'secondary' }) + btn('Ver resumen de soporte', { action: 'support-view', arg: t.client_id, style: 'ghost' }) + '</div></form>' +
      (S.data['support:' + id] ? '<div class="pc-pre">' + esc(JSON.stringify(S.data['support:' + id], null, 2)) + '</div>' : '') +
      (d.support_access.length ? '<ul>' + d.support_access.map(function (a) { return '<li>' + esc(a.login) + ' · ' + esc(a.reason) + ' · hasta ' + esc(when(a.expires_at)) + '</li>'; }).join('') + '</ul>' : '') + '</section>';
    return html;
  }

  function healthView() {
    var d = load('health', '/health');
    var html = '<h1 tabindex="-1" data-focus>Salud y presupuesto</h1>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    html += '<div class="pc-grid">' +
      '<section class="card stack"><h2>Gasto de IA generativa</h2><p class="tiny">Anthropic y OpenAI directos más el historial de OpenRouter (DEC-0068). TypeSafe tiene su propio límite diario (DEC-0032).</p><dl class="pc-kv"><dt>Hoy</dt><dd>' + money(d.spend.today) + '</dd><dt>Mes</dt><dd>' + money(d.spend.month) + '</dd><dt>Laboratorio acumulado</dt><dd>' + money(d.spend.lab_total) + '</dd></dl>' +
        '<ul>' + d.budgets.map(function (b) { return '<li>' + esc(b.scope) + (b.tenant_id ? ' (' + esc(b.tenant_id) + ')' : '') + ': USD ' + esc(b.limit_usd) + ' <span class="tiny">' + esc(b.source) + '</span></li>'; }).join('') + '</ul></section>' +
      '<section class="card stack"><h2>Jobs (24 h)</h2><ul>' + d.jobs.map(function (j) { return '<li>' + esc(j.status) + ': ' + esc(j.n) + '</li>'; }).join('') + '</ul><p>Atascados (lease vencido): ' + esc(d.jobs_stuck.n) + '</p></section>' +
      '<section class="card stack"><h2>Atención y publicaciones</h2><dl class="pc-kv"><dt>Por clasificar</dt><dd>' + esc(d.engagement_backlog.received) + '</dd><dt>Reintentos</dt><dd>' + esc(d.engagement_backlog.retry) + '</dd><dt>Humanos</dt><dd>' + esc(d.engagement_backlog.human) + '</dd><dt>Publicaciones vencidas</dt><dd>' + esc(d.scheduler_backlog.overdue) + '</dd><dt>Inciertas</dt><dd>' + esc(d.scheduler_backlog.uncertain) + '</dd></dl></section>' +
      '</div><section class="card stack" style="margin-top:16px"><h2>Invocaciones (24 h)</h2><div class="pc-scroll"><table class="pc-table"><thead><tr><th>Proveedor</th><th>Estado</th><th>N</th><th>Promedio ms</th></tr></thead><tbody>' +
      d.invocations_24h.map(function (i) { return '<tr><td>' + esc(i.provider_id) + '</td><td>' + esc(i.status) + '</td><td>' + esc(i.n) + '</td><td>' + esc(i.avg_ms) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
    var SOURCE = { reported: 'cargo informado', estimated: 'estimado (uso × precio)', unknown: 'sin precio', none: 'sin costo' };
    html += '<section class="card stack" style="margin-top:16px"><h2>Proveedores</h2><div class="pc-scroll"><table class="pc-table"><thead><tr><th>Proveedor</th><th>Estado</th><th>Datos de negocios reales</th><th>Base</th></tr></thead><tbody>' +
      d.providers.map(function (p) { return '<tr><td>' + esc(p.display_name) + '<div class="pc-mono muted">' + esc(p.provider_id) + '</div></td><td>' + tag(p.status === 'active' ? 'activo' : 'retirado', p.status === 'active' ? 'nopal' : 'alerta') + '</td><td>' + (p.real_data === 'allowed' ? tag('permitidos', 'nopal') : tag('bloqueados', 'ocre')) + '</td><td class="tiny">' + esc(p.real_data_basis || '—') + (p.terms_verified_at ? ' · verificado ' + esc(when(p.terms_verified_at)) : '') + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
    html += '<section class="card stack" style="margin-top:16px"><h2>Costo acumulado por proveedor</h2><div class="pc-scroll"><table class="pc-table"><thead><tr><th>Proveedor</th><th>Procedencia</th><th>Llamadas</th><th>USD</th></tr></thead><tbody>' +
      d.spend_by_provider.map(function (s) { return '<tr><td>' + esc(s.display_name) + (s.status !== 'active' ? ' <span class="tiny">(historial)</span>' : '') + '</td><td>' + esc(SOURCE[s.cost_source] || s.cost_source) + '</td><td>' + esc(s.n) + '</td><td>' + money(s.usd) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
    return html;
  }

  function auditView() {
    var d = load('audit', '/audit');
    var html = '<h1 tabindex="-1" data-focus>Auditoría de plataforma</h1>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    return html + '<div class="pc-scroll card card-flush"><table class="pc-table"><thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Recurso</th><th>Decisión</th><th>Resultado</th><th>Motivo</th></tr></thead><tbody>' +
      d.events.map(function (e) { return '<tr><td>' + esc(when(e.at)) + '</td><td class="pc-mono">' + esc(e.actor_id) + '</td><td>' + esc(e.action) + '</td><td class="pc-mono">' + esc(e.resource || '') + '</td><td>' + tag(e.decision, e.decision === 'allow' ? 'nopal' : 'alerta') + '</td><td>' + esc(e.result || '') + '</td><td>' + esc(e.reason || '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }

  /* ---------- Engineering Console ---------- */
  function useCasesView() {
    var d = load('ucs', '/ai/use-cases');
    var html = '<h1 tabindex="-1" data-focus>Casos de uso de IA</h1><p class="muted">Entorno <strong>' + esc(S.env) + '</strong>. Cambiar modelo, prompt o ruta no requiere código: versión nueva → evaluación → aprobación → rollout.</p>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    return html + '<div class="pc-scroll card card-flush"><table class="pc-table"><thead><tr><th>Caso de uso</th><th>Riesgo</th><th>Activa</th><th>Canary</th><th>Llamadas 7 d</th><th>Fallos</th><th>Costo</th><th>p95 ms</th></tr></thead><tbody>' +
      d.use_cases.map(function (u) {
        var st = u.stats || {};
        return '<tr><td><a href="#/caso/' + encodeURIComponent(u.use_case_id) + '">' + esc(u.title) + '</a><div class="pc-mono muted">' + esc(u.use_case_id) + '</div></td><td>' + esc(u.risk_level) + '</td><td>' + (u.active ? esc(u.active.model.display_name) + ' <span class="tiny">r' + esc(u.active.route.version) + '/p' + esc(u.active.prompt.version) + '</span>' : tag('sin ruta', 'alerta')) + '</td><td>' + (u.canary ? esc(u.canary.model.display_name) + ' ' + esc(u.rollout.canary_percent) + '%' : '—') + '</td><td>' + esc(st.n || 0) + '</td><td>' + esc(st.failed || 0) + '</td><td>' + money(st.cost) + '</td><td>' + (st.p95 != null ? esc(Math.round(Number(st.p95))) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function useCaseView(uc) {
    var d = load('uc:' + uc, '/ai/use-cases/' + encodeURIComponent(uc));
    var models = load('models', '/ai/models');
    var html = '<p><a href="#/casos">← Casos de uso</a></p>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    var ro = d.rollout || {};
    var eng = has('ai_engineer');
    html += '<h1 tabindex="-1" data-focus>' + esc(d.use_case.title) + '</h1><p class="pc-mono">' + esc(d.use_case.use_case_id) + ' · esquema ' + esc(d.use_case.output_schema) + ' · riesgo ' + esc(d.use_case.risk_level) + '</p>';
    var byRoute = {};
    d.routes.forEach(function (r) { byRoute[r.route_id] = r; });
    var rl = function (id) { var r = byRoute[id]; return r ? 'v' + r.version + ' · ' + r.model.display_name : (id || '—'); };
    var metricsText = function (m) {
      if (!m || m.cases == null) return JSON.stringify(m || {});
      return m.passed + '/' + m.cases + ' casos · ' + Math.round(Number(m.pass_rate) * 100) + ' %' + (m.latency_p95_ms != null ? ' · p95 ' + Math.round(m.latency_p95_ms) + ' ms' : '') + (m.cost_usd != null ? ' · USD ' + Number(m.cost_usd).toFixed(6) : '') +
        Object.keys(m).filter(function (k) { return ['cases', 'passed', 'pass_rate', 'latency_p50_ms', 'latency_p95_ms', 'cost_usd', 'cost_per_case_usd'].indexOf(k) < 0; }).map(function (k) { return ' · ' + k + ' ' + (typeof m[k] === 'number' ? Math.round(m[k] * 1000) / 1000 : JSON.stringify(m[k])); }).join('');
    };
    html += '<section class="card stack"><h2>Rollout (' + esc(S.env) + ')</h2><dl class="pc-kv"><dt>Activa</dt><dd>' + esc(ro.active_route_id ? rl(ro.active_route_id) : '—') + '</dd><dt>Canary</dt><dd>' + esc(ro.canary_route_id ? rl(ro.canary_route_id) : '—') + (ro.canary_route_id ? ' (' + esc(ro.canary_percent) + '%)' : '') + '</dd><dt>Versión del rollout</dt><dd>' + esc(ro.version || 0) + '</dd></dl>' +
      (eng ? '<form class="stack" data-form="rollout" data-uc="' + esc(uc) + '"><div class="pc-grid"><div class="field"><label for="ro-act">Acción</label><select class="select" id="ro-act"><option value="activate">Activar ruta al 100 %</option><option value="canary">Canary</option><option value="promote">Promover canary</option><option value="clear_canary">Quitar canary</option><option value="rollback">Rollback a la anterior</option></select></div>' +
        '<div class="field"><label for="ro-route">Ruta</label><select class="select" id="ro-route">' + d.routes.filter(function (r) { return r.status === 'APPROVED' || r.status === 'ACTIVE' || r.status === 'CANARY'; }).map(function (r) { return '<option value="' + esc(r.route_id) + '">v' + esc(r.version) + ' · ' + esc(r.model.display_name) + ' · ' + esc(r.status) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="ro-pct">Canary %</label><input class="input" id="ro-pct" type="number" min="1" max="99" value="10"></div></div>' +
        '<div class="field"><label for="ro-reason">Motivo</label><input class="input" id="ro-reason" minlength="10" maxlength="500" required></div><div class="btn-row">' + btn('Aplicar rollout', { type: 'submit', id: 'ro-submit' }) + '</div></form>' : '') + '</section>';
    html += '<section class="card stack" style="margin-top:16px"><h2>Rutas</h2><div class="pc-scroll"><table class="pc-table"><thead><tr><th>Versión</th><th>Modelo</th><th>Prompt</th><th>Parámetros</th><th>Máx USD</th><th>Estado</th><th>Última evaluación</th><th>Acciones</th></tr></thead><tbody>' +
      d.routes.map(function (r) {
        var ev = r.last_eval || null, m = ev && ev.metrics ? ev.metrics : {};
        var evTxt = ev ? tag(ev.status, ev.status === 'passed' ? 'nopal' : ev.status === 'running' ? 'ocre' : 'alerta') + ' ' + (m.pass_rate != null ? Math.round(m.pass_rate * 100) + '%' : '') + (m.sentiment_accuracy != null ? ' · sent. ' + Math.round(m.sentiment_accuracy * 100) + '%' : '') + (m.latency_p95_ms != null ? ' · p95 ' + m.latency_p95_ms + ' ms' : '') + (m.cost_usd != null ? ' · ' + money(m.cost_usd) : '') + (ev.real_provider ? '' : ' ' + tag('simulado', 'lila')) : '—';
        // «Evidencia manual» abre la revisión de trazas de laboratorio; Aprobar/rollout siguen siendo pasos separados con step-up.
        var acts = eng ? [r.status === 'DRAFT' || r.status === 'TESTED' ? btn('Evaluar', { action: 'eval', arg: r.route_id, sm: true, style: 'secondary' }) : '', ['DRAFT', 'TESTED', 'APPROVED'].indexOf(r.status) >= 0 ? btn('Evidencia manual', { action: 'lab-evidence', arg: r.route_id, sm: true, style: 'secondary' }) : '', r.status === 'TESTED' ? btn('Aprobar', { action: 'approve', arg: r.route_id, sm: true }) : '', ['DRAFT', 'TESTED', 'APPROVED'].indexOf(r.status) >= 0 ? btn('Retirar', { action: 'retire', arg: r.route_id, sm: true, style: 'ghost' }) : ''].join(' ') : '';
        var lmr = r.last_manual_review || null;
        var tested = (r.tested_manual_review_id ? ' ' + tag('revisión manual', 'lila') : (r.tested_eval_run_id ? ' ' + tag('suite', 'neutral') : '')) +
          (lmr ? '<div class="tiny">última revisión: ' + esc(lmr.decision === 'accept' ? 'aceptada' : 'rechazada') + ' · ' + esc(when(lmr.created_at)) + ' · ' + esc(lmr.invocations) + ' inv.</div>' : '');
        return '<tr><td>v' + esc(r.version) + '<div class="pc-mono muted">' + esc(r.route_id) + '</div></td><td>' + esc(r.model.display_name) + '<div class="pc-mono muted">' + esc(r.model.provider_model) + '</div></td><td>v' + esc(r.prompt_version) + '</td><td class="pc-mono">' + esc(JSON.stringify(r.params)) + '</td><td>' + esc(r.max_cost_usd) + '</td><td>' + tag(r.status, r.status === 'ACTIVE' ? 'nopal' : r.status === 'RETIRED' ? 'neutral' : 'ocre') + tested + '</td><td>' + evTxt + '</td><td>' + acts + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      (eng && models && models.models ? '<form class="stack" data-form="new-route" data-uc="' + esc(uc) + '" style="margin-top:12px"><h3>Nueva ruta (borrador)</h3><div class="pc-grid"><div class="field"><label for="nr-model">Modelo</label><select class="select" id="nr-model">' + models.models.filter(function (m) { return m.modality === d.use_case.modality && m.status === 'active'; }).map(function (m) { return '<option value="' + esc(m.model_id) + '">' + esc(m.display_name) + ' (' + esc(m.provider.display_name) + ')</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="nr-prompt">Versión de prompt</label><select class="select" id="nr-prompt">' + d.prompts.filter(function (p) { return !p.retired_at; }).map(function (p) { return '<option value="' + esc(p.revision_id) + '">v' + esc(p.version) + ' · ' + esc(p.change_note) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="nr-params">Parámetros (JSON)</label><input class="input pc-mono" id="nr-params" value="{&quot;timeout_ms&quot;:30000,&quot;max_tokens&quot;:2000}"></div><div class="field"><label for="nr-cost">Costo máximo por llamada (USD)</label><input class="input" id="nr-cost" type="number" step="0.001" min="0" value="0.02"></div></div>' +
        '<div class="field"><label for="nr-note">Nota de cambio</label><input class="input" id="nr-note" maxlength="500" required></div><div class="btn-row">' + btn('Crear ruta', { type: 'submit', style: 'secondary' }) + '</div></form>' : '') + '</section>';
    html += '<section class="card stack" style="margin-top:16px"><h2>Prompt Studio</h2>' + d.prompts.map(function (p) {
      return '<details><summary>v' + esc(p.version) + ' · ' + esc(p.change_note) + ' · ' + esc(when(p.created_at)) + ' <span class="pc-mono">' + esc(String(p.sha256).slice(0, 12)) + '</span></summary><p><strong>Sistema</strong></p><div class="pc-pre">' + esc(p.system_text) + '</div><p><strong>Tarea</strong></p><div class="pc-pre">' + esc(p.task_template) + '</div><p class="tiny">Variables: ' + esc((p.variables || []).map(function (v) { return v.name + (v.untrusted ? ' (no confiable)' : ''); }).join(', ')) + '</p></details>';
    }).join('') +
      (eng && d.prompts[0] ? '<form class="stack" data-form="new-prompt" data-uc="' + esc(uc) + '"><h3>Nueva versión de prompt (inmutable)</h3><div class="field"><label for="np-system">Sistema</label><textarea class="textarea pc-mono" id="np-system" rows="8">' + esc(d.prompts[0].system_text) + '</textarea></div><div class="field"><label for="np-task">Tarea</label><textarea class="textarea pc-mono" id="np-task" rows="4">' + esc(d.prompts[0].task_template) + '</textarea></div><input type="hidden" id="np-vars" value="' + esc(JSON.stringify(d.prompts[0].variables)) + '"><div class="field"><label for="np-note">Nota de cambio</label><input class="input" id="np-note" maxlength="500" required></div><div class="btn-row">' + btn('Guardar versión', { type: 'submit', style: 'secondary' }) + '</div></form>' : '') + '</section>';
    html += evidenceSection(uc, byRoute, eng);
    html += '<section class="card stack" style="margin-top:16px"><h2>Evaluaciones</h2><div class="pc-scroll"><table class="pc-table"><thead><tr><th>Cuándo</th><th>Suite</th><th>Ruta</th><th>Estado</th><th>Métricas</th><th>Real</th></tr></thead><tbody>' +
      d.eval_runs.map(function (e) { return '<tr><td>' + esc(when(e.started_at)) + '</td><td>' + esc(e.suite) + '</td><td>' + esc(rl(e.route_id)) + '</td><td>' + tag(e.status, e.status === 'passed' ? 'nopal' : e.status === 'running' ? 'ocre' : 'alerta') + '</td><td>' + esc(metricsText(e.metrics)) + '</td><td>' + (e.real_provider ? 'sí' : 'simulado') + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
    html += '<section class="card stack" style="margin-top:16px"><h2>Historial de rollout</h2><ul>' + d.history.map(function (h) { return '<li>' + esc(when(h.at)) + ' · ' + esc(h.action) + ' · ' + esc(h.actor_id) + ' · ' + esc(h.to_route_id ? rl(h.to_route_id) : '') + (h.canary_percent ? ' (' + esc(h.canary_percent) + '%)' : '') + ' · ' + esc(h.reason || '') + '</li>'; }).join('') + '</ul></section>';
    return html;
  }

  /** Evidencia manual (laboratorio) de una ruta: trazas saneadas + revisión con checklist. Aceptar marca DRAFT→TESTED; no crea evaluaciones ni aprueba. */
  function evidenceSection(uc, byRoute, eng) {
    var id = S.ev, r = id && byRoute[id];
    if (!r) return '';
    var ev = load('ev:' + id, '/ai/routes/' + encodeURIComponent(id) + '/manual-evidence');
    var html = '<section class="card stack" style="margin-top:16px" id="ev-section"><h2>Evidencia manual · v' + esc(r.version) + ' · ' + esc(r.model.display_name) + '</h2><p class="tiny">Trazas de laboratorio de esta ruta (sin texto de clientes ni salidas; hashes, costo y latencia). Solo cuentan invocaciones exitosas, reales y con asignación <code>manual_lab</code>. Aceptar deja la ruta como TESTED; aprobar y activar siguen siendo pasos separados.</p>' +
      btn('Actualizar', { action: 'lab-evidence', arg: id, sm: true, style: 'secondary' }) + ' ' + btn('Cerrar', { action: 'lab-evidence-close', sm: true, style: 'ghost' });
    if (!ev) return html + '<div class="skeleton" style="height:120px"></div></section>';
    if (ev.error) return html + '<div class="banner banner-alerta">' + esc(ev.error) + '</div></section>';
    var eligible = function (i) { return i.status === 'succeeded' && i.assignment === 'manual_lab' && i.lab_grant_id; };
    html += '<form class="stack" data-form="manual-review" data-route="' + esc(id) + '" data-uc="' + esc(uc) + '"><div class="pc-scroll"><table class="pc-table"><thead><tr><th></th><th>Cuándo</th><th>Estado</th><th>Negocio / actor</th><th>Proveedor / modelo</th><th>Costo</th><th>ms</th><th>Salida (sha256)</th><th>Autorización</th><th>Revisiones</th></tr></thead><tbody>' +
      (ev.invocations.length ? ev.invocations.map(function (i) {
        var ok = eligible(i);
        return '<tr><td><input type="checkbox" id="ev-' + esc(i.invocation_id) + '" name="ev-pick" value="' + esc(i.invocation_id) + '"' + (ok ? '' : ' disabled') + ' aria-label="Incluir invocación ' + esc(i.invocation_id) + '"></td><td>' + esc(when(i.created_at)) + '<div class="pc-mono muted">' + esc(i.invocation_id) + '</div></td>' +
          '<td>' + tag(i.status, i.status === 'succeeded' ? 'nopal' : 'alerta') + ' <span class="tiny">' + esc(i.assignment) + (i.error_code ? ' · ' + esc(i.error_code) : '') + (i.job_id ? ' · job ' + esc(i.job_id) : '') + '</span></td>' +
          '<td class="pc-mono tiny">' + esc(i.tenant_id) + '<br>' + esc(i.actor_kind || '') + ' ' + esc(i.actor_id) + '</td><td>' + esc(i.provider_kind || i.provider_id) + '<div class="pc-mono muted">' + esc(i.provider_model) + '</div></td>' +
          '<td>' + money(i.cost_usd) + ' <span class="tiny">' + esc(i.cost_source || '') + '</span></td><td>' + esc(i.latency_ms) + '</td><td class="pc-mono tiny">' + esc(i.output_sha256 || '—') + (i.media_asset_id ? '<br>media ' + esc(i.media_asset_id) : '') + '</td><td class="pc-mono tiny">' + esc(i.lab_grant_id || '—') + '</td><td class="pc-mono tiny">' + esc((i.review_ids || []).join(', ') || '—') + '</td></tr>';
      }).join('') : '<tr><td colspan="10" class="muted">Sin invocaciones de laboratorio para esta ruta.</td></tr>') + '</tbody></table></div>';
    if (eng) {
      html += '<fieldset class="fieldset"><legend>Decisión</legend><label class="row"><input type="radio" name="mr-decision" id="mr-accept" value="accept"> <span>Aceptar: la evidencia seleccionada demuestra que la ruta funciona (DRAFT → TESTED)</span></label><label class="row"><input type="radio" name="mr-decision" id="mr-reject" value="reject" checked> <span>Rechazar: queda registrado, la ruta no avanza</span></label></fieldset>' +
        '<fieldset class="fieldset"><legend>Lista de comprobación (todas para aceptar)</legend>' +
        '<label class="row"><input type="checkbox" id="mr-c1"> <span>Revisé el resultado en el panel del negocio (vista previa, borrador o imagen).</span></label>' +
        '<label class="row"><input type="checkbox" id="mr-c2"> <span>El resultado cumple la tarea del caso de uso.</span></label>' +
        '<label class="row"><input type="checkbox" id="mr-c3"> <span>Sin problemas de seguridad ni de privacidad (datos de clientes, hechos inventados).</span></label>' +
        '<label class="row"><input type="checkbox" id="mr-c4"> <span>El costo por llamada es aceptable para operar.</span></label></fieldset>' +
        '<div class="field"><label for="mr-notes">Notas (10–2000)</label><textarea class="textarea" id="mr-notes" rows="3" minlength="10" maxlength="2000" required placeholder="Qué se probó y qué se observó. Sin nombres ni textos de clientes: referencia los IDs de invocación."></textarea></div>' +
        '<div class="btn-row">' + btn('Registrar revisión', { type: 'submit', id: 'mr-submit' }) + '</div><p class="tiny">Pide código de verificación. No ejecuta la suite ni crea evaluaciones; no aprueba ni despliega.</p>';
    }
    html += '</form>';
    html += '<h3>Revisiones</h3>' + (ev.reviews.length ? '<ul>' + ev.reviews.map(function (v) {
      var c = v.checklist || {};
      return '<li>' + esc(when(v.created_at)) + ' · ' + tag(v.decision === 'accept' ? 'aceptada' : 'rechazada', v.decision === 'accept' ? 'nopal' : 'alerta') + ' · ' + esc(v.actor_id) + ' · ' + esc((v.invocation_ids || []).length) + ' invocación(es) · ' + esc(v.notes) + ' <span class="pc-mono tiny">' + esc(v.review_id) + ' · ' + esc(String(v.snapshot_sha256 || '').slice(0, 12)) + '</span><div class="tiny">' + ['result_reviewed', 'task_fit', 'safety_privacy', 'cost_acceptable'].map(function (k) { return k + ': ' + (c[k] ? 'sí' : 'no'); }).join(' · ') + '</div></li>';
    }).join('') + '</ul>' : '<p class="muted">Sin revisiones.</p>') + '</section>';
    return html;
  }

  function modelsView() {
    var d = load('models', '/ai/models');
    var html = '<h1 tabindex="-1" data-focus>Modelos y proveedores</h1>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    html += '<section class="card stack"><h2>Proveedores</h2><ul>' + d.providers.map(function (p) { return '<li><strong>' + esc(p.display_name) + '</strong> (' + esc(p.kind) + ') · ' + esc(p.status) + ' · secreto ' + (p.kind === 'simulated' ? 'n/a' : p.secret_configured ? 'configurado' : tag('falta', 'alerta')) + ' · <span class="tiny">' + esc(p.data_policy) + '</span></li>'; }).join('') + '</ul></section>';
    return html + '<section class="card card-flush" style="margin-top:16px"><div class="pc-scroll"><table class="pc-table"><thead><tr><th>Modelo</th><th>Modalidad</th><th>Precio</th><th>Fuente / fecha</th><th>Capacidades</th></tr></thead><tbody>' +
      d.models.map(function (m) { return '<tr><td>' + esc(m.display_name) + '<div class="pc-mono muted">' + esc(m.provider_model) + '</div></td><td>' + esc(m.modality) + '</td><td class="pc-mono">' + esc(JSON.stringify(m.pricing)) + '</td><td class="tiny">' + esc(m.price_source) + '<br>' + esc(when(m.price_observed_at)) + '</td><td class="pc-mono">' + esc(JSON.stringify(m.capabilities)) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
  }

  function tracesView() {
    var d = load('traces', '/ai/invocations');
    var html = '<h1 tabindex="-1" data-focus>Trazas</h1><p class="muted">Saneadas: sin texto de clientes ni salidas; hashes, ruta, costo y latencia.</p>' + btn('Actualizar', { action: 'reload', arg: 'traces|/ai/invocations', sm: true, style: 'secondary' });
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    return html + '<div class="pc-scroll card card-flush" style="margin-top:12px"><table class="pc-table"><thead><tr><th>Cuándo</th><th>Caso de uso</th><th>Modelo / ruta</th><th>Origen</th><th>Estado</th><th>ms</th><th>Costo</th><th>Tokens</th></tr></thead><tbody>' +
      d.invocations.map(function (i) { var u = i.usage || {}; return '<tr><td>' + esc(when(i.created_at)) + '</td><td class="pc-mono">' + esc(i.use_case_id) + '</td><td>' + esc(i.model_id) + '<div class="pc-mono muted">' + esc(i.route_id) + ' · ' + esc(i.assignment) + '</div></td><td>' + esc(i.origin) + (i.tenant_id ? '<div class="pc-mono muted">' + esc(i.tenant_id) + '</div>' : '') + '</td><td>' + tag(i.status, i.status === 'succeeded' ? 'nopal' : 'alerta') + (i.error_code ? ' <span class="tiny">' + esc(i.error_code) + '</span>' : '') + '</td><td>' + esc(i.latency_ms) + '</td><td>' + money(i.cost_usd) + ' <span class="tiny">' + esc(i.cost_source) + '</span></td><td>' + esc((u.inputTokens || 0) + '/' + (u.outputTokens || 0)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }

  function costsView() {
    var d = load('costs', '/ai/costs');
    var html = '<h1 tabindex="-1" data-focus>Costos</h1>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    return html + '<section class="card stack"><h2>Presupuestos</h2><ul>' + d.budgets.map(function (b) { return '<li>' + esc(b.scope) + ': USD ' + esc(b.limit_usd) + ' <span class="tiny">' + esc(b.source) + '</span></li>'; }).join('') + '</ul></section>' +
      '<section class="card card-flush" style="margin-top:16px"><div class="pc-scroll"><table class="pc-table"><caption class="sr-only">Costo por caso de uso</caption><thead><tr><th>Caso de uso</th><th>Modelo</th><th>Llamadas</th><th>Costo</th><th>Promedio ms</th><th>p95 ms</th></tr></thead><tbody>' +
      d.by_use_case.map(function (r) { return '<tr><td class="pc-mono">' + esc(r.use_case_id) + '</td><td>' + esc(r.model_id) + '</td><td>' + esc(r.calls) + '</td><td>' + money(r.cost_usd) + '</td><td>' + esc(r.avg_ms) + '</td><td>' + esc(r.p95_ms) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
  }

  function jobsView() {
    var d = load('jobs', '/ai/jobs');
    var html = '<h1 tabindex="-1" data-focus>Jobs de IA</h1>' + btn('Actualizar', { action: 'reload', arg: 'jobs|/ai/jobs', sm: true, style: 'secondary' });
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    return html + '<div class="pc-scroll card card-flush" style="margin-top:12px"><table class="pc-table"><thead><tr><th>Creado</th><th>Tipo</th><th>Negocio</th><th>Estado</th><th>Intentos</th><th>Rutas fijadas</th><th></th></tr></thead><tbody>' +
      d.jobs.map(function (j) { return '<tr><td>' + esc(when(j.created_at)) + '</td><td>' + esc(j.kind) + '</td><td class="pc-mono">' + esc(j.tenant_id) + '</td><td>' + tag(j.status, j.status === 'succeeded' ? 'nopal' : j.status === 'failed' ? 'alerta' : 'ocre') + (j.error_code ? ' <span class="tiny">' + esc(j.error_code) + '</span>' : '') + '</td><td>' + esc(j.attempts) + '</td><td class="pc-mono">' + esc(JSON.stringify(j.pinned)) + '</td><td>' + (j.status === 'queued' && has('ai_engineer') ? btn('Cancelar', { action: 'cancel-job', arg: j.job_id, sm: true, style: 'ghost' }) : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }

  /* ---------- Laboratorio manual (DEC-0074): autorizaciones explícitas para rutas DRAFT en entorno lab ---------- */
  function grantState(g) {
    if (g.status === 'revoked' || g.revoked_at) return ['revocada', 'alerta'];
    if (g.status === 'expired' || (g.expires_at && new Date(g.expires_at).getTime() <= Date.now())) return ['caducada', 'neutral'];
    return ['vigente', 'nopal'];
  }
  /** Última candidata por caso de uso: la versión más alta entre las rutas elegibles que devuelve el servidor (nunca IDs fijos). */
  function latestByUseCase(routes) {
    var out = {};
    routes.forEach(function (r) { if (!out[r.use_case_id] || Number(r.version) > Number(out[r.use_case_id].version)) out[r.use_case_id] = r; });
    return out;
  }
  function labView() {
    var d = load('lab', '/ai/lab');
    var costs = load('costs', '/ai/costs');
    var html = '<h1 tabindex="-1" data-focus>Laboratorio manual</h1><p class="muted">Autoriza a una persona concreta de un negocio a usar rutas en borrador (Anthropic texto, OpenAI imágenes) desde su panel, por un plazo corto y con motivo. Las rutas normales no cambian; la clasificación sigue por TypeSafe. Cada emisión y revocación pide código de verificación y queda en auditoría.</p>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    var canIssue = has('platform_admin') || has('ai_engineer');
    var panelLink = location.origin + '/panel#/ia/laboratorio';
    if (d.enabled === false || d.environment !== 'lab') html += '<div class="banner banner-ocre">Este entorno es <strong>' + esc(d.environment) + '</strong>: las autorizaciones de laboratorio solo existen en <code>lab</code>. Aquí solo se consultan.</div>';
    var byTenant = {};
    d.tenants.forEach(function (t) { byTenant[t.tenant_id] = t; });
    var byRoute = {};
    d.routes.forEach(function (r) { byRoute[r.route_id] = r; });
    var latest = latestByUseCase(d.routes);
    // Controles y costos: lo que la persona debe saber antes de autorizar.
    html += '<div class="pc-grid"><section class="card stack"><h2>Controles</h2><ul class="tiny">' +
      '<li>Solo entorno <code>lab</code>; solo platform_admin o ai_engineer con verificación reciente; motivo de 10 a 500 caracteres.</li>' +
      '<li>Plazo de 5 a 120 minutos (60 por omisión). Revocable en cualquier momento. El ID no es un permiso por sí mismo: el servidor revalida tenant, usuario, emisor, ruta y vigencia en cada llamada.</li>' +
      '<li>La persona debe entrar a su panel y pulsar «Usar rutas de laboratorio» en <a href="' + esc(panelLink) + '" target="_blank" rel="noopener">' + esc(panelLink) + '</a>. Nada se activa solo ni se publica.</li>' +
      '<li>Cada prueba se cobra al proveedor real y se registra con ID de invocación; la aceptación se hace en el caso de uso (Evidencia manual).</li></ul></section>' +
      '<section class="card stack"><h2>Presupuestos</h2>' + (costs && costs.budgets ? '<ul>' + costs.budgets.map(function (b) { return '<li>' + esc(b.scope) + ': USD ' + esc(b.limit_usd) + ' <span class="tiny">' + esc(b.source) + '</span></li>'; }).join('') + '</ul>' : (costs && costs.error ? '<p class="tiny">' + esc(costs.error) + '</p>' : '<div class="skeleton" style="height:60px"></div>')) + '<p class="tiny">Costo máximo por llamada según cada ruta (tabla de abajo). El gasto acumulado se ve en <a href="#/costos">Costos</a>.</p></section></div>';
    // Emisión
    if (canIssue) {
      var t0 = d.tenants[0];
      html += '<section class="card stack" style="margin-top:16px"><h2>Emitir autorización</h2>' +
        '<form class="stack" data-form="lab-grant"><div class="pc-grid"><div class="field"><label for="lg-tenant">Negocio</label><select class="select" id="lg-tenant" required>' + d.tenants.map(function (t) { return '<option value="' + esc(t.tenant_id) + '">' + esc(t.business_name) + (t.status !== 'active' ? ' (' + esc(t.status) + ')' : '') + (t.data_classification ? ' · ' + esc(t.data_classification) : '') + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="lg-user">Usuario</label><select class="select" id="lg-user" required>' + userOptions(t0) + '</select></div>' +
        '<div class="field"><label for="lg-min">Minutos (5–120)</label><input class="input" id="lg-min" type="number" min="5" max="120" value="60" required></div></div>' +
        '<fieldset class="fieldset"><legend>Rutas autorizadas (una por capacidad)</legend><div class="btn-row">' + btn('Seleccionar últimas candidatas', { action: 'lab-pick', arg: 'latest', sm: true, style: 'secondary' }) + btn('Ninguna', { action: 'lab-pick', arg: 'none', sm: true, style: 'ghost' }) + '</div>' +
        '<div class="pc-scroll"><table class="pc-table"><thead><tr><th>Caso de uso</th><th>Ruta</th></tr></thead><tbody>' + Object.keys(latest).sort().map(function (uc) {
          var rs = d.routes.filter(function (r) { return r.use_case_id === uc; }).sort(function (a, b) { return Number(b.version) - Number(a.version); });
          var name = 'lg-uc-' + uc;
          return '<tr><td>' + esc(rs[0].use_case_title || uc) + '<div class="pc-mono muted">' + esc(uc) + ' · ' + esc(rs[0].modality) + '</div></td><td>' +
            '<label class="row"><input type="radio" name="' + esc(name) + '" id="' + esc(name) + '-none" value=""> <span>Ninguna</span></label>' +
            rs.map(function (r) { return '<label class="row"><input type="radio" name="' + esc(name) + '" id="lg-r-' + esc(r.route_id) + '" value="' + esc(r.route_id) + '"' + (latest[uc].route_id === r.route_id ? ' checked' : '') + '> <span>v' + esc(r.version) + ' · ' + esc(r.model.display_name) + ' (' + esc(r.provider ? r.provider.display_name : r.model.provider_id) + ') · ' + tag(r.status, r.status === 'ACTIVE' ? 'nopal' : 'ocre') + ' · máx. ' + money(r.max_cost_usd) + '/llamada' + (r.tested_manual_review_id ? ' · ' + tag('revisión manual', 'lila') : '') + ' <span class="pc-mono muted">' + esc(r.route_id) + '</span></span></label>'; }).join('') + '</td></tr>';
        }).join('') + '</tbody></table></div></fieldset>' +
        '<div class="field"><label for="lg-reason">Motivo</label><input class="input" id="lg-reason" minlength="10" maxlength="500" required placeholder="Prueba manual de la ruta de publicaciones con el negocio piloto (sin datos personales)"></div>' +
        '<div class="btn-row">' + btn('Emitir autorización', { type: 'submit', id: 'lg-submit' }) + '</div><p class="tiny">Confirmarás con tu código de verificación. Emitir no ejecuta ninguna llamada a proveedores.</p></form></section>';
    }
    // Autorizaciones existentes
    html += '<section class="card stack" style="margin-top:16px"><h2>Autorizaciones</h2>' + btn('Actualizar', { action: 'reload', arg: 'lab|/ai/lab', sm: true, style: 'secondary' });
    if (!d.grants.length) html += '<p class="muted">Todavía no hay autorizaciones.</p>';
    else html += '<div class="pc-scroll"><table class="pc-table"><thead><tr><th>Autorización</th><th>Negocio / usuario</th><th>Rutas</th><th>Vigencia</th><th>Emitida por</th><th>Motivo</th><th></th></tr></thead><tbody>' + d.grants.map(function (g) {
      var st = grantState(g), t = byTenant[g.tenant_id], u = t && t.users.filter(function (x) { return x.user_id === g.user_id; })[0];
      return '<tr><td>' + tag(st[0], st[1]) + '<div class="pc-mono muted">' + esc(g.grant_id) + '</div></td><td>' + esc(t ? t.business_name : g.tenant_id) + '<div class="muted">' + esc(u ? u.display_name + ' · ' + u.email + ' · ' + u.role : g.user_id) + '</div></td>' +
        '<td><ul class="tiny">' + (g.routes || []).map(function (r) { return '<li>' + esc(r.use_case_title || r.use_case_id) + ': v' + esc(r.route_version) + ' ' + esc(r.model_name) + ' (' + esc(r.provider_kind || r.provider_id) + ') ' + esc(r.route_status) + '</li>'; }).join('') + '</ul></td>' +
        '<td>' + esc(when(g.created_at)) + ' → ' + esc(when(g.expires_at)) + (g.revoked_at ? '<div class="tiny">revocada ' + esc(when(g.revoked_at)) + ' · ' + esc(g.revoke_reason || '') + '</div>' : '') + '</td><td class="pc-mono">' + esc(g.issued_by) + '</td><td>' + esc(g.reason) + '</td>' +
        '<td>' + (st[0] === 'vigente' && canIssue ? '<form class="stack" data-form="lab-revoke" data-id="' + esc(g.grant_id) + '"><input class="input" id="lv-' + esc(g.grant_id) + '" minlength="10" maxlength="500" required placeholder="Motivo de la revocación" aria-label="Motivo de la revocación">' + btn('Revocar', { type: 'submit', sm: true, style: 'ghost' }) + '</form>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    html += '</section>';
    return html;
  }
  function userOptions(t) {
    if (!t) return '<option value="">Sin usuarios</option>';
    return t.users.map(function (u) { return '<option value="' + esc(u.user_id) + '">' + esc(u.display_name) + ' · ' + esc(u.email) + ' · ' + esc(u.role) + (u.status && u.status !== 'active' ? ' (' + esc(u.status) + ')' : '') + '</option>'; }).join('');
  }

  /* ------------------------------------------------------------------ router */
  function route() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var parts = h.split('/').filter(Boolean).map(decodeURIComponent);
    var eng = location.pathname === '/ingenieria';
    var def = eng ? 'casos' : (has('platform_admin') || has('platform_support') ? 'negocios' : 'salud');
    return { area: eng ? 'eng' : 'admin', page: parts[0] || def, arg: parts[1] };
  }
  function shell(body) {
    var r = route();
    var tabs = r.area === 'eng'
      ? [['casos', 'Casos de uso'], ['laboratorio', 'Laboratorio'], ['modelos', 'Modelos'], ['trazas', 'Trazas'], ['costos', 'Costos'], ['jobs', 'Jobs']]
      : [['negocios', 'Negocios'], ['salud', 'Salud'], ['auditoria', 'Auditoría']];
    return '<a class="skip-link" href="#main">Saltar al contenido</a><div class="pc"><header class="pc-top"><strong>MainSpot ' + (r.area === 'eng' ? 'Engineering Console' : 'Administration') + '</strong>' +
      '<span class="pc-env">' + esc(S.env) + (S.real ? ' · API directas habilitadas · datos según cobertura' : ' · proveedores reales apagados') + '</span>' +
      '<nav aria-label="Secciones" class="pc-tabs">' + tabs.map(function (t) { return '<a href="#/' + t[0] + '"' + (r.page === t[0] || (t[0] === 'negocios' && r.page === 'negocio') || (t[0] === 'casos' && r.page === 'caso') ? ' aria-current="page"' : '') + '>' + esc(t[1]) + '</a>'; }).join('') + '</nav><span class="grow"></span>' +
      '<a href="' + (r.area === 'eng' ? '/plataforma' : '/ingenieria') + '">' + (r.area === 'eng' ? 'Ir a Administration' : 'Ir a Engineering') + '</a>' +
      '<span>' + esc(S.session.display_name) + ' · ' + esc(S.session.roles.join(', ')) + '</span>' + btn('Salir', { action: 'logout', sm: true, style: 'ghost' }) + '</header><main id="main">' + body + '</main></div>' + stepUpView();
  }
  function view() {
    var r = route();
    switch (r.page) {
      case 'negocios': return tenantsView();
      case 'negocio': return tenantView(r.arg);
      case 'salud': return healthView();
      case 'auditoria': return auditView();
      case 'casos': return useCasesView();
      case 'caso': return useCaseView(r.arg);
      case 'laboratorio': return labView();
      case 'modelos': return modelsView();
      case 'trazas': return tracesView();
      case 'costos': return costsView();
      case 'jobs': return jobsView();
      default: return '<h1 tabindex="-1" data-focus>No encontrado</h1>';
    }
  }
  var lastRoute = '';
  function render() {
    if (!app) return;
    var key = location.pathname + location.hash;
    var changed = key !== lastRoute;
    lastRoute = key;
    var focusId = document.activeElement && document.activeElement.id;
    var vals = {};
    app.querySelectorAll('input[id], textarea[id], select[id]').forEach(function (el) { if (el.type !== 'hidden') vals[el.id] = el.type === 'checkbox' || el.type === 'radio' ? { checked: el.checked } : el.value; });
    app.innerHTML = S.session ? shell(view()) : loginView();
    document.title = 'MainSpot · ' + (location.pathname === '/ingenieria' ? 'Engineering Console' : 'Administration');
    // Un redibujo (datos que llegan) nunca debe cambiar lo que la persona eligió: también los <select> y las casillas.
    if (!changed) Object.keys(vals).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!vals[id].checked;
      else if (el.tagName === 'SELECT') { if (Array.prototype.some.call(el.options, function (o) { return o.value === vals[id]; })) el.value = vals[id]; }
      else el.value = vals[id];
    });
    var t = changed ? app.querySelector('[data-focus]') : (focusId && document.getElementById(focusId));
    if (t) t.focus({ preventScroll: !changed });
  }

  /* ------------------------------------------------------------------ eventos */
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function refreshCurrent() { var r = route(); if (r.page === 'caso') reload('uc:' + r.arg, '/ai/use-cases/' + encodeURIComponent(r.arg)); if (r.page === 'negocio') reload('tenant:' + r.arg, '/tenants/' + encodeURIComponent(r.arg)); delete S.data.ucs; delete S.data.tenants; }

  var FORMS = {
    login: function () {
      var b = document.getElementById('pl-submit');
      b.disabled = true;
      api('POST', '/auth/login', { login: val('pl-login'), password: document.getElementById('pl-pass').value, code: val('pl-code') }).then(function (r) {
        b.disabled = false;
        if (!r.ok) { S.flash = r.error.message; render(); return; }
        S.flash = null;
        setToken(r.data.token);
        boot();
      });
    },
    'step-up': function () {
      var p = S.pending;
      api('POST', '/auth/step-up', { code: val('su-code') }).then(function (r) {
        if (!r.ok) { var e = document.getElementById('su-error'); e.hidden = false; e.textContent = r.error.message; return; }
        S.pending = null;
        render();
        if (p) act(p.method, p.path, p.body, p.done);
      });
    },
    rollout: function (form) {
      act('POST', '/ai/use-cases/' + encodeURIComponent(form.dataset.uc) + '/rollout', { action: val('ro-act'), route_id: val('ro-route'), percent: Number(val('ro-pct')), reason: val('ro-reason') }, function (r) {
        if (!r.ok) { toast(r.error.message); return; }
        toast('Rollout aplicado'); refreshCurrent();
      });
    },
    'new-route': function (form) {
      var params;
      try { params = JSON.parse(val('nr-params') || '{}'); } catch (e) { toast('Parámetros: JSON inválido'); return; }
      act('POST', '/ai/use-cases/' + encodeURIComponent(form.dataset.uc) + '/routes', { model_id: val('nr-model'), prompt_revision_id: val('nr-prompt'), params: params, max_cost_usd: Number(val('nr-cost')), change_note: val('nr-note') }, function (r) {
        if (!r.ok) { toast(r.error.message); return; }
        toast('Ruta creada en borrador. Evalúala antes de aprobarla.'); refreshCurrent();
      });
    },
    'new-prompt': function (form) {
      var vars;
      try { vars = JSON.parse(document.getElementById('np-vars').value); } catch (e) { vars = []; }
      act('POST', '/ai/use-cases/' + encodeURIComponent(form.dataset.uc) + '/prompts', { content: { system_text: document.getElementById('np-system').value, task_template: document.getElementById('np-task').value, variables: vars }, change_note: val('np-note') }, function (r) {
        if (!r.ok) { toast(r.error.message); return; }
        toast('Versión de prompt v' + r.data.prompt.version + ' guardada'); refreshCurrent();
      });
    },
    'tenant-admin': function (form) {
      if (!val('ta-op')) { toast('Elige una acción'); document.getElementById('ta-op').focus(); return; }
      var op = val('ta-op').split(':');
      var path = '/tenants/' + encodeURIComponent(form.dataset.id) + (op[0] === 'status' ? '/status' : '/data-classification');
      var body = op[0] === 'status' ? { status: op[1], reason: val('ta-reason') } : { classification: op[1], reason: val('ta-reason') };
      act('POST', path, body, function (r) { if (!r.ok) { toast(r.error.message); return; } toast('Cambio aplicado'); refreshCurrent(); });
    },
    support: function (form) {
      act('POST', '/tenants/' + encodeURIComponent(form.dataset.id) + '/support-access', { reason: val('sp-reason'), minutes: Number(val('sp-min')) }, function (r) {
        if (!r.ok) { toast(r.error.message); return; }
        toast('Acceso concedido por ' + r.data.minutes + ' minutos (visible para el negocio)'); refreshCurrent();
      });
    },
    /* ---------- Laboratorio manual ---------- */
    'lab-grant': function (form) {
      var routeIds = [];
      form.querySelectorAll('input[type="radio"][name^="lg-uc-"]:checked').forEach(function (el) { if (el.value) routeIds.push(el.value); });
      if (!val('lg-tenant') || !val('lg-user')) { toast('Elige negocio y usuario'); return; }
      if (!routeIds.length) { toast('Selecciona al menos una ruta'); return; }
      var minutes = Number(val('lg-min'));
      if (!(minutes >= 5 && minutes <= 120)) { toast('Minutos entre 5 y 120'); document.getElementById('lg-min').focus(); return; }
      act('POST', '/ai/lab/grants', { tenant_id: val('lg-tenant'), user_id: val('lg-user'), route_ids: routeIds, minutes: minutes, reason: val('lg-reason') }, function (r) {
        if (!r.ok) { toast(r.error.message); return; }
        var g = r.data.grant || {};
        toast('Autorización ' + (g.grant_id || '') + ' emitida hasta ' + when(g.expires_at) + '. La persona la elige en ' + location.origin + '/panel#/ia/laboratorio');
        reload('lab', '/ai/lab');
      });
    },
    'lab-revoke': function (form) {
      var input = form.querySelector('input');
      var reason = input ? input.value.trim() : '';
      if (reason.length < 10) { toast('Escribe el motivo (10 caracteres como mínimo)'); if (input) input.focus(); return; }
      act('POST', '/ai/lab/grants/' + encodeURIComponent(form.dataset.id) + '/revoke', { reason: reason }, function (r) {
        if (!r.ok) { toast(r.error.message); return; }
        toast('Autorización revocada'); reload('lab', '/ai/lab');
      });
    },
    'manual-review': function (form) {
      var ids = [];
      form.querySelectorAll('input[name="ev-pick"]:checked').forEach(function (el) { ids.push(el.value); });
      var decision = (form.querySelector('input[name="mr-decision"]:checked') || {}).value;
      var checklist = { result_reviewed: !!document.getElementById('mr-c1').checked, task_fit: !!document.getElementById('mr-c2').checked, safety_privacy: !!document.getElementById('mr-c3').checked, cost_acceptable: !!document.getElementById('mr-c4').checked };
      if (!ids.length) { toast('Selecciona al menos una invocación'); return; }
      if (!decision) { toast('Elige aceptar o rechazar'); return; }
      if (decision === 'accept' && !(checklist.result_reviewed && checklist.task_fit && checklist.safety_privacy && checklist.cost_acceptable)) { toast('Para aceptar, marca toda la lista de comprobación'); return; }
      if (val('mr-notes').length < 10) { toast('Notas: 10 caracteres como mínimo'); document.getElementById('mr-notes').focus(); return; }
      act('POST', '/ai/routes/' + encodeURIComponent(form.dataset.route) + '/manual-review', { invocation_ids: ids, decision: decision, notes: val('mr-notes'), checklist: checklist }, function (r) {
        if (!r.ok) { toast(r.error.message); return; }
        var route = r.data.route || {};
        toast(decision === 'accept' ? 'Revisión aceptada: la ruta queda ' + (route.status || 'TESTED') + '. Aprobar y activar son pasos separados.' : 'Revisión registrada como rechazo; la ruta no avanza.');
        reload('ev:' + form.dataset.route, '/ai/routes/' + encodeURIComponent(form.dataset.route) + '/manual-evidence');
        refreshCurrent();
      });
    }
  };
  var ACTIONS = {
    logout: function () { api('POST', '/auth/logout', {}).then(function () { setToken(null); S.session = null; S.data = {}; render(); }); },
    'step-up-cancel': function () { S.pending = null; render(); },
    reload: function (el) { var p = el.dataset.arg.split('|'); reload(p[0], p[1]); },
    eval: function (el) { act('POST', '/ai/routes/' + encodeURIComponent(el.dataset.arg) + '/evaluate', {}, function (r) { if (!r.ok) { toast(r.error.message); return; } toast('Evaluación en curso; actualiza en un momento.'); setTimeout(refreshCurrent, 4000); }); },
    approve: function (el) { act('POST', '/ai/routes/' + encodeURIComponent(el.dataset.arg) + '/approve', {}, function (r) { if (!r.ok) { toast(r.error.message); return; } toast('Ruta aprobada'); refreshCurrent(); }); },
    retire: function (el) { act('POST', '/ai/routes/' + encodeURIComponent(el.dataset.arg) + '/retire', {}, function (r) { if (!r.ok) { toast(r.error.message); return; } toast('Ruta retirada'); refreshCurrent(); }); },
    'cancel-job': function (el) { act('POST', '/ai/jobs/' + encodeURIComponent(el.dataset.arg) + '/cancel', {}, function (r) { if (!r.ok) { toast(r.error.message); return; } reload('jobs', '/ai/jobs'); }); },
    'support-view': function (el) { api('GET', '/tenants/' + encodeURIComponent(el.dataset.arg) + '/support-view').then(function (r) { S.data['support:' + el.dataset.arg] = r.ok ? r.data : { error: r.error.message }; render(); }); },
    /* Laboratorio: la evidencia se carga solo al pedirla (ninguna llamada a proveedores). */
    'lab-evidence': function (el) { S.ev = el.dataset.arg; reload('ev:' + S.ev, '/ai/routes/' + encodeURIComponent(S.ev) + '/manual-evidence'); render(); var s = document.getElementById('ev-section'); if (s) s.scrollIntoView({ block: 'start' }); },
    'lab-evidence-close': function () { S.ev = null; render(); },
    'lab-pick': function (el) {
      var d = S.data.lab;
      if (!d || !d.routes) return;
      var latest = latestByUseCase(d.routes);
      Object.keys(latest).forEach(function (uc) {
        var target = document.getElementById(el.dataset.arg === 'latest' ? 'lg-r-' + latest[uc].route_id : 'lg-uc-' + uc + '-none');
        if (target) target.checked = true;
      });
    }
  };
  // El usuario depende del negocio elegido; se rellena sin redibujar para no perder la selección de rutas.
  document.addEventListener('change', function (e) {
    if (!e.target || e.target.id !== 'lg-tenant') return;
    var d = S.data.lab, u = document.getElementById('lg-user');
    if (!d || !u) return;
    u.innerHTML = userOptions(d.tenants.filter(function (t) { return t.tenant_id === e.target.value; })[0]);
  });

  document.addEventListener('submit', function (e) { var f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault(); var fn = FORMS[f.dataset.form]; if (fn) fn(f); });
  document.addEventListener('click', function (e) { var el = e.target.closest('[data-action]'); if (!el) return; var fn = ACTIONS[el.dataset.action]; if (fn) { e.preventDefault(); fn(el); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.pending) { S.pending = null; render(); } });

  function boot() {
    if (!token()) { S.session = null; render(); return; }
    api('GET', '/me').then(function (r) {
      if (!r.ok) { setToken(null); S.session = null; render(); return; }
      S.session = r.data.session; S.env = r.data.environment; S.real = r.data.real_providers;
      render();
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    app = document.getElementById('app');
    // Cada pantalla se abre con datos frescos (consumo, rutas y salud cambian mientras se opera).
    window.addEventListener('hashchange', function () { S.data = {}; S.loading = {}; S.ev = null; render(); });
    boot();
  });
})();
