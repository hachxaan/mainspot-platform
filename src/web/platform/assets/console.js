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
  // Cada aviso dura 4 s desde que aparece: el temporizador del aviso anterior no puede borrar uno nuevo.
  var toastTimer = null;
  function toast(t) { var w = document.getElementById('toasts'); if (!w) return; w.innerHTML = '<div class="toast">' + esc(t) + '</div>'; clearTimeout(toastTimer); toastTimer = setTimeout(function () { w.innerHTML = ''; }, 4000); }
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
          // Un código de verificación incorrecto (401 invalid_credentials en /auth/step-up) no invalida la sesión: el
          // diálogo muestra el error. Cualquier otro 401 sí la cierra.
          var badStepUpCode = path === '/auth/step-up' && out.error && out.error.code === 'invalid_credentials';
          if (res.status === 401 && path !== '/auth/login' && !badStepUpCode && S.session) { S.session = null; setToken(null); render(); }
          return out;
        });
      }).catch(function () { return { ok: false, status: 0, data: null, error: { code: 'network', message: 'Sin conexión con el servidor.' } }; });
  }
  /** Acción con efecto: si el servidor pide step-up, se guarda y se pide el código TOTP. */
  function act(method, path, body, done) {
    // Se recuerda quién inició la acción para devolverle el foco si se cierra el diálogo de verificación (WCAG 2.4.3).
    // Si fue el botón (sin id), el primer campo del formulario.
    var a = document.activeElement, f0 = a && a.closest && a.closest('form');
    var origin = (a && a.id) || (f0 && (f0.querySelector('input[id]:not([type="hidden"]), select[id], textarea[id]') || {}).id) || null;
    S.inflight = true;
    return api(method, path, body).then(function (r) {
      S.inflight = false;
      if (!r.ok && r.error && r.error.code === 'step_up_required') {
        S.pending = { method: method, path: path, body: body, done: done, focus: origin }; render(); var f = document.getElementById('su-code'); if (f) f.focus(); return;
      }
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
      '<section class="card stack"><h2>Cuenta</h2><dl class="pc-kv"><dt>Id</dt><dd class="pc-mono">' + esc(t.client_id) + '</dd><dt>Estado</dt><dd>' + esc(t.status) + '</dd><dt>Datos</dt><dd>' + esc(t.data_classification) + '</dd><dt>Plan</dt><dd>' + esc(t.plan || '—') + (t.plan_revision_version ? ' v' + esc(t.plan_revision_version) + (t.plan_revision_status === 'SUPERSEDED' ? ' ' + tag('revisión anterior', 'ocre') : '') : '') + ' (' + esc(t.subscription_status || '—') + ')</dd><dt>Alta</dt><dd>' + esc(when(t.created_at)) + '</dd></dl></section>' +
      '<section class="card stack"><h2>Plan y consumo</h2><p class="tiny">Uso que cuenta para cada límite de su revisión fijada (misma cuenta que aplica MainSpot).</p>' + (t.plan_revision_id
        ? '<ul>' + d.plan_usage.map(function (u) { return '<li>' + esc(u.label) + ': <strong>' + esc(fmtVal(u.usage)) + ' de ' + esc(fmtVal(u.limit)) + '</strong> ' + esc(u.unit) + ' <span class="tiny">' + esc(u.period) + '</span>' + (u.enforced ? '' : ' ' + tag('No se aplica hoy', 'ocre')) + (u.limit !== null && u.usage !== null && u.usage > u.limit ? ' ' + tag('por encima del límite', 'alerta') : '') + '</li>'; }).join('') + '</ul>'
        : '<p class="muted">Sin plan asignado.</p>') + '</section>' +
      '<section class="card stack"><h2>IA (30 días)</h2>' + (d.ai_30d.length ? '<ul>' + d.ai_30d.map(function (u) { return '<li><span class="pc-mono">' + esc(u.use_case_id) + '</span>: ' + esc(u.calls) + ' llamadas, ' + esc(u.failed) + ' fallidas, ' + money(u.cost_usd) + '</li>'; }).join('') + '</ul>' : '<p class="muted">Sin uso.</p>') + '</section>' +
      '<section class="card stack"><h2>Conexiones</h2>' + (d.connections.length ? '<ul>' + d.connections.map(function (c) { return '<li>' + esc(c.provider) + ': ' + esc(c.status) + (c.last_error_code ? ' (' + esc(c.last_error_code) + ')' : '') + '</li>'; }).join('') + '</ul>' : '<p class="muted">Sin conexiones reales.</p>') + '</section>' +
      '</div>';
    if (has('platform_admin')) {
      html += '<section class="card stack" style="margin-top:16px"><h2>Acciones de administración</h2><p class="tiny">Cada acción pide motivo y código de verificación, y queda en la auditoría de plataforma y del negocio.</p>' +
        '<form class="stack" data-form="tenant-admin" data-id="' + esc(t.client_id) + '"><div class="field"><label for="ta-op">Acción</label><select class="select" id="ta-op" required><option value="">Elige una acción</option><option value="status:suspended">Suspender</option><option value="status:active">Reactivar</option><option value="class:synthetic">Marcar datos como sintéticos (laboratorio)</option><option value="class:real">Marcar datos como reales</option></select></div>' +
        '<div class="field"><label for="ta-reason">Motivo</label><input class="input" id="ta-reason" minlength="10" maxlength="500" required></div><div class="btn-row">' + btn('Aplicar', { type: 'submit', id: 'ta-submit', style: 'secondary' }) + '</div></form></section>';
    }
    if (t.plan_revision_status === 'SUPERSEDED' && t.plan_id) {
      html += '<p class="banner banner-ocre" style="margin-top:12px"><span>Este negocio sigue en una revisión anterior de su plan. Para ver qué cambiaría y migrarlo, abre el plan en <a href="/ingenieria#/plan/' + encodeURIComponent(t.plan_id) + '">Engineering Console › Planes</a>.</span></p>';
    }
    if (can('subscriptions.assign')) {
      var plans = load('assignable', '/plans');
      var SHORT = { website: 'páginas', social_posts: 'publicaciones', social_ads: 'anuncios', reviews_managed: 'reseñas', ai_review_replies: 'respuestas con IA/mes', conversations: 'solicitudes', agents: 'usuarios' };
      html += '<section class="card stack" style="margin-top:16px" aria-labelledby="as-t"><h2 id="as-t" tabindex="-1">Asignar plan</h2>' + commercialNote() + '<p class="tiny">Se fija la revisión publicada vigente del plan; sus límites no cambian si luego se publica otra revisión. Para pasar a este negocio a una revisión nueva de su mismo plan se usa la migración con vista previa (Planes). Pide motivo y código de verificación; el negocio ve la asignación en su auditoría.</p>' +
        (!plans ? '<div class="skeleton" style="height:60px"></div>' : plans.error ? '<div class="banner banner-alerta" role="alert">' + esc(plans.error) + '</div>'
          : '<form class="stack" data-form="tenant-plan" data-id="' + esc(t.client_id) + '" novalidate>' + formError() + '<div class="field"><label for="tp-plan">Plan</label><select class="select" id="tp-plan" required><option value="">Elige un plan habilitado</option>' + plans.plans.map(function (pl) {
            var summary = (pl.values || []).map(function (v) { return (SHORT[v.capability] || v.key) + ' ' + fmtVal(Number(v.value)); }).join(' · ');
            return '<option value="' + esc(pl.plan_id) + '">' + esc(pl.name) + ' (v' + esc(pl.version) + ', ' + esc(pl.plan_id) + ') — ' + esc(summary) + '</option>';
          }).join('') + '</select></div>' +
            reasonField('tp-reason', 'Motivo') + '<div class="btn-row">' + btn('Asignar plan', { type: 'submit', style: 'secondary' }) + '</div></form>') + '</section>';
    }
    html += '<section class="card stack" style="margin-top:16px"><h2>Acceso de soporte</h2><p class="tiny">Temporal, con motivo, visible para el negocio en su auditoría. Muestra solo un resumen operativo.</p>' +
      '<form class="stack" data-form="support" data-id="' + esc(t.client_id) + '"><div class="field"><label for="sp-reason">Motivo</label><input class="input" id="sp-reason" minlength="10" maxlength="500" required></div><div class="field"><label for="sp-min">Minutos</label><input class="input" id="sp-min" type="number" min="5" max="120" value="30"></div><div class="btn-row">' + btn('Solicitar acceso', { type: 'submit', style: 'secondary' }) + btn('Ver resumen de soporte', { action: 'support-view', arg: t.client_id, style: 'ghost' }) + '</div></form>' +
      (S.data['support:' + id] ? '<div class="pc-pre">' + esc(JSON.stringify(S.data['support:' + id], null, 2)) + '</div>' : '') +
      (d.support_access.length ? '<ul>' + d.support_access.map(function (a) { return '<li>' + esc(a.login) + ' · ' + esc(a.reason) + ' · hasta ' + esc(when(a.expires_at)) + '</li>'; }).join('') + '</ul>' : '') + '</section>';
    return html;
  }

  /* ---------- Presupuestos de IA (DEC-0068; FB-3): techo global y, debajo, operación y laboratorio por separado ---------- */
  var SCOPE_LABEL = { lab_total: 'Techo global de IA de pago', platform_month: 'Mensual de plataforma', tenant_day: 'Diario por negocio (operación)', lab_experiment: 'Laboratorio experimental' };
  var SCOPE_COUNTS = { all: 'todo el gasto de pago', operational: 'solo operación (sin grant ni evaluación)', lab: 'solo pruebas con grant y evaluaciones de rutas' };
  var SCOPE_WINDOW = { accumulated: 'acumulado, sin reinicio', utc_month: 'mes UTC', utc_day: 'día UTC' };
  var SCOPE_MISSING = { lab_total: 'Sin configurar: ninguna IA de pago puede gastar', platform_month: 'Sin configurar (opcional): no se aplica', tenant_day: 'Sin configurar: un negocio sin límite propio no puede gastar', lab_experiment: 'Sin configurar: ni el laboratorio ni las evaluaciones de rutas pueden gastar' };
  var PURPOSE_LABEL = { operational: 'Operación comercial', lab: 'Laboratorio y evaluaciones (experimental)' };
  var CHANNEL_LABEL = { owner_intent: 'Intención del dueño', assistant: 'Asistente del dueño', website: 'Página web', facebook_posts: 'Publicaciones de Facebook', facebook_comments: 'Comentarios de Facebook', google_reviews: 'Reseñas de Google', campaigns: 'Campañas', insights: 'Resumen del negocio', editorial: 'Calendario editorial' };
  /** Estado de cada ámbito tal como lo calcula la reserva: un ámbito sin fila se muestra y explica (sin fila no hay gasto). */
  function budgetTable(statuses) {
    return '<div class="pc-scroll"><table class="pc-table"><caption class="sr-only">Presupuestos de IA</caption><thead><tr><th scope="col">Ámbito</th><th scope="col">Cuenta</th><th scope="col">Ventana</th><th scope="col">Límite</th><th scope="col">Gastado</th><th scope="col">Disponible</th><th scope="col">Estado</th></tr></thead><tbody>' +
      statuses.map(function (b) {
        var state = b.missing ? tag(SCOPE_MISSING[b.scope] || 'Sin configurar', b.required ? 'alerta' : 'ocre')
          : b.remaining_usd === null ? '<span class="tiny">margen por negocio</span>' : b.remaining_usd <= 0 ? tag('Agotado', 'alerta') : tag('Con margen', 'nopal');
        return '<tr><td>' + esc(SCOPE_LABEL[b.scope] || b.scope) + '<div class="pc-mono muted">' + esc(b.scope) + '</div></td><td>' + esc(SCOPE_COUNTS[b.counts] || b.counts) + '</td><td>' + esc(SCOPE_WINDOW[b.window] || b.window) + '</td>' +
          '<td>' + (b.missing ? '—' : money(b.limit_usd)) + '</td><td>' + money(b.spent_usd) + '</td><td>' + (b.remaining_usd === null ? '—' : money(b.remaining_usd)) + '</td><td>' + state + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  /** Solo platform_admin; el servidor pide el código de verificación (step-up) y deja la auditoría. Sin valores sugeridos. */
  function budgetForm(statuses) {
    var cap = statuses.filter(function (b) { return b.scope === 'lab_total'; })[0];
    return '<form class="stack" data-form="budget" novalidate style="margin-top:12px"><h3>Cambiar un presupuesto</h3>' + formError() +
      '<p class="tiny">El laboratorio experimental no puede superar el techo global' + (cap && !cap.missing ? ' (hoy ' + money(cap.limit_usd) + ')' : '') + '. Laboratorio y mensual se crean si faltan; el diario por negocio cambia solo el valor por defecto; el techo global no se sube por encima de lo que fijó el propietario.</p>' +
      '<div class="pc-grid"><div class="field"><label for="bud-scope">Ámbito</label><select class="select" id="bud-scope" required><option value="">Elige un ámbito</option>' +
      ['lab_experiment', 'lab_total', 'platform_month', 'tenant_day'].map(function (s) { return '<option value="' + s + '">' + esc(SCOPE_LABEL[s]) + ' (' + s + ')</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="bud-limit">Límite (USD)</label><input class="input" id="bud-limit" type="number" min="0" step="0.0001" inputmode="decimal" required></div></div>' +
      reasonField('bud-reason', 'Motivo') + '<div class="btn-row">' + btn('Guardar presupuesto', { type: 'submit' }) + '</div></form>';
  }
  /** Gasto de pago por propósito › canal › caso de uso (hoy y mes UTC, acumulado). Solo atribución: no hay límites por canal. */
  function spendTable(sp) {
    var cells = function (x) { return '<td>' + money(x.today_usd) + '</td><td>' + money(x.month_usd) + '</td><td>' + money(x.total_usd) + '</td><td>' + esc(x.calls_today + ' / ' + x.calls_month + ' / ' + x.calls_total) + '</td>'; };
    var rows = sp.by_purpose.map(function (p) {
      return '<tr><th scope="row" colspan="3">' + esc(PURPOSE_LABEL[p.purpose] || p.purpose) + '</th>' + cells(p) + '</tr>' + sp.by_channel.filter(function (c) { return c.purpose === p.purpose; }).map(function (c) {
        return '<tr><td></td><td colspan="2">' + esc(CHANNEL_LABEL[c.channel] || c.channel) + '</td>' + cells(c) + '</tr>' + sp.by_use_case.filter(function (u) { return u.purpose === p.purpose && u.channel === c.channel; }).map(function (u) {
          return '<tr><td></td><td></td><td class="pc-mono">' + esc(u.use_case_id) + '</td>' + cells(u) + '</tr>';
        }).join('');
      }).join('');
    }).join('');
    return '<div class="pc-scroll"><table class="pc-table"><caption class="sr-only">Gasto de IA de pago por propósito y canal</caption><thead><tr><th scope="col">Propósito</th><th scope="col">Canal</th><th scope="col">Caso de uso</th><th scope="col">Hoy</th><th scope="col">Mes</th><th scope="col">Acumulado</th><th scope="col">Llamadas (hoy / mes / total)</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7" class="muted">Sin gasto de pago registrado.</td></tr>') + '<tr><th scope="row" colspan="3">Total (techo global)</th>' + cells(sp.total) + '</tr></tbody></table></div>';
  }
  function tenantDayTable(list) {
    if (!list.length) return '<p class="muted">Ningún negocio con gasto operativo hoy ni con límite propio.</p>';
    return '<div class="pc-scroll"><table class="pc-table"><caption class="sr-only">Presupuesto diario por negocio</caption><thead><tr><th scope="col">Negocio</th><th scope="col">Límite</th><th scope="col">Gastado hoy</th><th scope="col">Disponible</th></tr></thead><tbody>' +
      list.map(function (t) { return '<tr><td class="pc-mono">' + esc(t.tenant_id) + '</td><td>' + (t.missing ? tag(SCOPE_MISSING.tenant_day, 'alerta') : money(t.limit_usd) + ' <span class="tiny">' + (t.own_limit ? 'propio' : 'por defecto') + '</span>') + '</td><td>' + money(t.spent_usd) + '</td><td>' + (t.remaining_usd === null ? '—' : t.remaining_usd <= 0 ? tag('Agotado', 'alerta') : money(t.remaining_usd)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }

  function healthView() {
    var d = load('health', '/health');
    // El informe por canal es de quien puede leer costos (platform_admin o ai_engineer); soporte ve el resto.
    var sp = has('platform_admin') ? load('spend', '/ai/spend') : null;
    var html = '<h1 tabindex="-1" data-focus>Salud y presupuesto</h1>';
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    var byPurpose = {};
    d.spend.by_purpose.forEach(function (p) { byPurpose[p.purpose] = p; });
    var split = function (key) { return ' <span class="tiny">(operación ' + money((byPurpose.operational || {})[key]) + ' · laboratorio ' + money((byPurpose.lab || {})[key]) + ')</span>'; };
    html += '<div class="pc-grid">' +
      '<section class="card stack"><h2>Gasto de IA de pago</h2><p class="tiny">Anthropic y OpenAI directos más el historial de OpenRouter, todo bajo el techo global (DEC-0068). Día y mes en UTC. TypeSafe tiene su propio límite diario (DEC-0032).</p><dl class="pc-kv"><dt>Hoy</dt><dd>' + money(d.spend.today) + split('today_usd') + '</dd><dt>Mes</dt><dd>' + money(d.spend.month) + split('month_usd') + '</dd><dt>Acumulado (techo global)</dt><dd>' + money(d.spend.lab_total) + split('total_usd') + '</dd></dl></section>' +
      '<section class="card stack"><h2>Jobs (24 h)</h2><ul>' + d.jobs.map(function (j) { return '<li>' + esc(j.status) + ': ' + esc(j.n) + '</li>'; }).join('') + '</ul><p>Atascados (lease vencido): ' + esc(d.jobs_stuck.n) + '</p></section>' +
      '<section class="card stack"><h2>Atención y publicaciones</h2><dl class="pc-kv"><dt>Por clasificar</dt><dd>' + esc(d.engagement_backlog.received) + '</dd><dt>Reintentos</dt><dd>' + esc(d.engagement_backlog.retry) + '</dd><dt>Humanos</dt><dd>' + esc(d.engagement_backlog.human) + '</dd><dt>Publicaciones vencidas</dt><dd>' + esc(d.scheduler_backlog.overdue) + '</dd><dt>Inciertas</dt><dd>' + esc(d.scheduler_backlog.uncertain) + '</dd></dl></section>' +
      '</div>';
    html += '<section class="card stack" style="margin-top:16px" aria-labelledby="bud-t"><h2 id="bud-t" tabindex="-1">Presupuestos de IA</h2><p class="tiny">El techo global cuenta todo el gasto de pago. Debajo, la operación de cada negocio responde ante su presupuesto diario, y las pruebas con grant y las evaluaciones de rutas ante el presupuesto experimental del laboratorio; ninguna consume el del otro. Un ámbito obligatorio sin configurar bloquea el gasto (fail-closed).</p>' +
      budgetTable(d.budget_status) +
      '<ul class="tiny">' + d.budgets.map(function (b) { return '<li>' + esc(b.scope) + (b.tenant_id ? ' (' + esc(b.tenant_id) + ')' : '') + ': USD ' + esc(b.limit_usd) + ' · ' + esc(b.source) + ' · ' + esc(when(b.updated_at)) + '</li>'; }).join('') + '</ul>' +
      (has('platform_admin') ? budgetForm(d.budget_status) : '') + '</section>';
    if (sp) {
      html += '<section class="card stack" style="margin-top:16px"><h2>Gasto por propósito y canal</h2>' + (sp.error ? '<div class="banner banner-alerta">' + esc(sp.error) + '</div>' : spendTable(sp.spend)) + '</section>';
    }
    html += '<section class="card stack" style="margin-top:16px"><h2>Invocaciones (24 h)</h2><div class="pc-scroll"><table class="pc-table"><thead><tr><th>Proveedor</th><th>Estado</th><th>N</th><th>Promedio ms</th></tr></thead><tbody>' +
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
    html += '<h1 tabindex="-1" data-focus>' + esc(d.use_case.title) + '</h1><p class="pc-mono">' + esc(d.use_case.use_case_id) + ' · esquema ' + esc(d.use_case.output_schema) + ' · riesgo ' + esc(d.use_case.risk_level) + ' · canal de gasto ' + esc(CHANNEL_LABEL[d.use_case.channel] || d.use_case.channel) + '</p>';
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
    var sp = load('spend', '/ai/spend');
    var html = '<h1 tabindex="-1" data-focus>Costos</h1>';
    if (!d || !sp) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error || sp.error) return html + '<div class="banner banner-alerta">' + esc(d.error || sp.error) + '</div>';
    return html + '<section class="card stack"><h2>Presupuestos</h2><p class="tiny">Mismo cálculo que la reserva previa a cada llamada de pago. Los cambios se hacen en Administration › Salud (platform_admin con código de verificación).</p>' + budgetTable(sp.budgets) +
      '<p class="tiny">TypeSafe (DEC-0032) tiene su propio tope diario, fuera de estos presupuestos: ' + money(sp.typesafe.spent_usd) + ' el ' + esc(sp.typesafe.day) + ' (UTC).</p></section>' +
      '<section class="card stack" style="margin-top:16px"><h2>Presupuesto diario por negocio (operación, hoy UTC)</h2>' + tenantDayTable(sp.tenant_day) + '</section>' +
      '<section class="card stack" style="margin-top:16px"><h2>Gasto de pago por propósito y canal</h2><p class="tiny">Atribución para calibrar con datos reales; ningún canal tiene límite propio. Incluye lo reservado en curso y los costos desconocidos (cuentan su reserva).</p>' + spendTable(sp.spend) + '</section>' +
      '<section class="card card-flush" style="margin-top:16px"><div class="pc-scroll"><table class="pc-table"><caption class="sr-only">Costo registrado por caso de uso (30 días)</caption><thead><tr><th>Caso de uso</th><th>Canal</th><th>Propósito</th><th>Modelo</th><th>Llamadas</th><th>Costo registrado</th><th>Promedio ms</th><th>p95 ms</th></tr></thead><tbody>' +
      d.by_use_case.map(function (r) { return '<tr><td class="pc-mono">' + esc(r.use_case_id) + '</td><td>' + esc(CHANNEL_LABEL[r.channel] || r.channel) + '</td><td>' + esc(PURPOSE_LABEL[r.purpose] || r.purpose) + '</td><td>' + esc(r.model_id) + '</td><td>' + esc(r.calls) + '</td><td>' + money(r.cost_usd) + '</td><td>' + esc(r.avg_ms) + '</td><td>' + esc(r.p95_ms) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
  }

  function jobsView() {
    var d = load('jobs', '/ai/jobs');
    var html = '<h1 tabindex="-1" data-focus>Jobs de IA</h1>' + btn('Actualizar', { action: 'reload', arg: 'jobs|/ai/jobs', sm: true, style: 'secondary' });
    if (!d) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error) return html + '<div class="banner banner-alerta">' + esc(d.error) + '</div>';
    return html + '<div class="pc-scroll card card-flush" style="margin-top:12px"><table class="pc-table"><thead><tr><th>Creado</th><th>Tipo</th><th>Negocio</th><th>Estado</th><th>Intentos</th><th>Rutas fijadas</th><th></th></tr></thead><tbody>' +
      d.jobs.map(function (j) { return '<tr><td>' + esc(when(j.created_at)) + '</td><td>' + esc(j.kind) + '</td><td class="pc-mono">' + esc(j.tenant_id) + '</td><td>' + tag(j.status, j.status === 'succeeded' ? 'nopal' : j.status === 'failed' ? 'alerta' : 'ocre') + (j.error_code ? ' <span class="tiny">' + esc(j.error_code) + '</span>' : '') + '</td><td>' + esc(j.attempts) + '</td><td class="pc-mono">' + esc(JSON.stringify(j.pinned)) + '</td><td>' + (j.status === 'queued' && has('ai_engineer') ? btn('Cancelar', { action: 'cancel-job', arg: j.job_id, sm: true, style: 'ghost' }) : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }

  /* ---------- Planes (FR-0019 «Planes», FR-0010, DEC-0075): catálogo versionado ----------
     Publicar aplica límites (configuración operativa); no aprueba precios ni paquetes comerciales.
     Los clientes vigentes quedan fijados a su revisión hasta que un platform_admin los migra. */
  function can(p) { return !!(S.session && (S.session.permissions || []).indexOf(p) >= 0); }
  var PLAN_STATE = { enabled: ['Habilitado', 'nopal'], disabled: ['Deshabilitado', 'ocre'], draft_only: ['Sin publicar', 'lila'] };
  var REV_STATE = { DRAFT: ['Borrador', 'lila'], PUBLISHED: ['Publicada', 'nopal'], SUPERSEDED: ['Reemplazada', 'neutral'], DISCARDED: ['Descartada', 'neutral'] };
  var REV_ORIGIN = { backfill: 'valores iniciales del catálogo', create: 'creación', clone: 'copia de otro plan', edit: 'edición', rollback: 'restauración de una revisión anterior' };
  var VALUE_SOURCE = { suggested: ['Sugerido', 'ocre'], copied: ['Copiado', 'neutral'], explicit: ['Cambiado', 'lila'], backfill: ['Valor inicial', 'neutral'], backfill_absent_deny: ['Valor inicial (no tenía límite ⇒ 0)', 'neutral'], rollback: ['Restaurado', 'neutral'] };
  var PLAN_ACTION = { 'plans.plan.create': 'Plan creado', 'plans.plan.clone': 'Plan creado como copia', 'plans.plan.update': 'Nombre o descripción', 'plans.revision.draft': 'Borrador abierto', 'plans.revision.update': 'Borrador guardado', 'plans.revision.publish': 'Revisión publicada', 'plans.revision.discard': 'Borrador descartado', 'plans.revision.rollback': 'Revisión anterior restaurada', 'plans.plan.enable': 'Plan habilitado', 'plans.plan.disable': 'Plan deshabilitado', 'plans.subscriptions.migrate': 'Suscripciones migradas' };
  var REASON_HINT = '10 a 500 caracteres. No incluyas datos de clientes (correos ni ids de negocio): queda en la auditoría de plataforma.';
  function fmtVal(v) { return v === null || v === undefined ? '—' : v === true ? 'Sí' : v === false ? 'No' : Number(v).toLocaleString('es-MX'); }
  function fieldId(prefix, key) { return prefix + '-' + String(key).replace(/[^a-z0-9]+/gi, '-'); }
  function commercialNote() { return '<p class="tiny">' + tag('Sin aprobación comercial', 'ocre') + ' Publicar aplica los límites a los negocios de esa revisión. No aprueba nombres, precios ni paquetes comerciales, y no hay cobro (DEC-024).</p>'; }
  /** Campo de motivo con su pista: cada acción tiene su propio id, para que un motivo nunca pase a otra acción. */
  function reasonField(id, label) { return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><input class="input" id="' + id + '" data-reason minlength="10" maxlength="500" required aria-describedby="' + id + '-h"><span class="hint" id="' + id + '-h">' + esc(REASON_HINT) + '</span></div>'; }
  /** Hueco de error de un formulario: visible, anunciado y con el foco en el campo afectado (no solo un aviso de 4 s). */
  function formError() { return '<p class="field-error" role="alert" data-form-error hidden></p>'; }
  /** <details> que conserva si estaba abierto al redibujar (llegada de datos, diálogo de verificación). */
  function openAttr(key) { return ' data-details="' + esc(key) + '"' + (S.openDetails && S.openDetails[key] ? ' open' : ''); }
  /** Identidad estable de un formulario entre redibujos (el DOM se reconstruye en cada render). */
  function formKey(form) { return form.dataset.form + '|' + (form.dataset.rev || form.dataset.plan || form.dataset.id || ''); }
  /** El formulario equivalente que está en pantalla ahora (el original pudo quedar fuera del DOM tras un redibujo). */
  function live(form) {
    if (document.body.contains(form)) return form;
    var key = formKey(form), found = null;
    document.querySelectorAll('form[data-form]').forEach(function (f) { if (!found && formKey(f) === key) found = f; });
    return found || form;
  }
  /** Muestra el error en el formulario, marca el campo (si hay) y le pasa el foco. No toca las marcas que pone la
   *  validación por campo del editor (cada valor inválido conserva su aria-invalid). El mensaje queda guardado por
   *  identidad del formulario y render() lo vuelve a pintar tras cualquier redibujo o recarga. */
  function showFormError(form, message, fieldEl) {
    form = live(form);
    S.formErrors = S.formErrors || {};
    S.formErrors[formKey(form)] = message;
    var box = form.querySelector('[data-form-error]');
    if (box) { box.hidden = false; box.textContent = message; }
    if (fieldEl) { fieldEl.setAttribute('aria-invalid', 'true'); fieldEl.setAttribute('data-form-invalid', ''); fieldEl.focus(); } else if (box) { box.setAttribute('tabindex', '-1'); box.focus(); }
  }
  function clearFormError(form) {
    form = live(form);
    if (S.formErrors) delete S.formErrors[formKey(form)];
    var box = form.querySelector('[data-form-error]');
    if (box) { box.hidden = true; box.textContent = ''; }
    form.querySelectorAll('[data-form-invalid]').forEach(function (el) { el.setAttribute('aria-invalid', 'false'); el.removeAttribute('data-form-invalid'); });
  }
  /** Motivo 10..500 caracteres reales (puntos de código), igual que el servidor. */
  function reasonOk(form, id) {
    var el = document.getElementById(id), v = el ? el.value.trim() : '', n = Array.from(v).length;
    if (n >= 10 && n <= 500) return v;
    showFormError(form, 'Escribe el motivo (10 a 500 caracteres).', el);
    return null;
  }
  /** Evita el doble envío: deshabilita los botones del formulario mientras la petición está en curso. */
  function busy(form, on) { form = live(form); form.setAttribute('aria-busy', on ? 'true' : 'false'); form.querySelectorAll('button[type="submit"]').forEach(function (b) { b.disabled = on; }); }
  /** Tras un éxito: vacía los motivos (nunca pasan a la acción siguiente) y lleva el foco al encabezado afectado. */
  function succeeded(form, focusId) { busy(form, false); clearFormError(form); live(form).querySelectorAll('input[data-reason]').forEach(function (el) { el.value = ''; }); S.focusAfter = focusId || null; }
  /** Error de una acción: queda escrito en su formulario (se conserva al redibujar) y se anuncia. Un 409 significa
   *  que el estado cambió (otra persona, versión vieja): se recarga. Un 400 no recarga, para no perder lo escrito. */
  function failed(form, r) {
    busy(form, false);
    showFormError(form, r.error.message);
    toast(r.error.message);
    // Tras recargar, el foco vuelve al error de este formulario (que sigue en pantalla con su motivo escrito).
    if (r.status === 409) { S.focusFormError = formKey(live(form)); refreshCurrent(); }
  }
  function paramLabels() { var out = {}; var p = S.data.params; if (p && p.parameters) p.parameters.forEach(function (d) { out[d.key] = d.label; if (d.capability) out[d.capability] = d.label; }); return out; }
  /** Valor con su unidad («3 publicaciones»), para diffs e historial. */
  function withUnit(key, v) { var p = S.data.params, d = p && p.parameters && p.parameters.filter(function (x) { return x.key === key; })[0]; return fmtVal(v) + (d && v !== null && v !== undefined ? ' ' + d.unit : ''); }
  function registryBanner(p) {
    return p && p.registry && !p.registry.consistent
      ? '<div class="banner banner-alerta"><div><strong>El registro de parámetros no coincide con la base de datos.</strong> Las escrituras del catálogo están bloqueadas; los límites publicados se siguen aplicando.<ul>' + p.registry.differences.map(function (x) { return '<li class="pc-mono">' + esc(x) + '</li>'; }).join('') + '</ul></div></div>'
      : '';
  }

  function plansView() {
    var d = load('plans', '/plan-catalog/plans');
    var p = load('params', '/plan-catalog/parameters');
    var html = '<h1 tabindex="-1" data-focus id="pl-h1">Planes</h1><p class="muted">Catálogo de planes y sus límites por revisión. Cada negocio queda en la revisión con la que se le asignó el plan; publicar una revisión nueva no le cambia nada hasta que un platform_admin lo migra.</p>' + commercialNote();
    if (!d || !p) return html + '<div class="skeleton" style="height:240px"></div>';
    if (d.error || p.error) return html + '<div class="banner banner-alerta" role="alert">' + esc(d.error || p.error) + '</div>';
    html += registryBanner(p);
    html += '<div class="pc-scroll card card-flush" style="margin-top:12px"><table class="pc-table"><caption class="sr-only">Planes del catálogo</caption><thead><tr><th scope="col">Plan</th><th scope="col">Estado</th><th scope="col">Publicada</th><th scope="col">Borrador</th><th scope="col">Negocios</th><th scope="col">Actualizado</th></tr></thead><tbody>' +
      d.plans.map(function (pl) {
        var st = PLAN_STATE[pl.state] || [pl.state, 'neutral'];
        return '<tr><td><a href="#/plan/' + encodeURIComponent(pl.plan_id) + '">' + esc(pl.name) + '</a><div class="pc-mono muted">' + esc(pl.plan_id) + '</div></td><td>' + tag(st[0], st[1]) + (pl.is_pilot ? ' ' + tag('Piloto', 'neutral') : '') + '</td>' +
          '<td>' + (pl.published_version ? 'v' + esc(pl.published_version) + '<div class="tiny">' + esc(when(pl.published_at)) + '</div>' : '—') + '</td><td>' + (pl.draft_version ? tag('v' + pl.draft_version + ' en edición', 'lila') : '—') + '</td>' +
          '<td>' + esc(pl.subscriptions) + (pl.subscriptions_on_older ? '<div class="tiny">' + esc(pl.subscriptions_on_older) + ' en revisiones anteriores</div>' : '') + '</td><td>' + esc(when(pl.updated_at)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    if (can('plans.edit')) {
      var sources = d.plans.filter(function (pl) { return pl.published_revision_id; });
      html += '<section class="card stack" style="margin-top:16px" aria-labelledby="np-t"><h2 id="np-t" tabindex="-1">Crear plan</h2><p class="tiny">El plan nace deshabilitado, con un borrador cuyos valores son sugerencias o copias <strong>sin confirmar</strong>. Hay que confirmar cada valor antes de publicar. Pide tu código de verificación.</p>' +
        '<form class="stack" data-form="plan-create" novalidate>' + formError() + '<div class="pc-grid"><div class="field"><label for="npl-name">Nombre</label><input class="input" id="npl-name" minlength="3" maxlength="60" required></div>' +
        '<div class="field"><label for="npl-clone">Partir de</label><select class="select" id="npl-clone"><option value="">Valores sugeridos del registro</option>' + sources.map(function (pl) { return '<option value="' + esc(pl.plan_id) + '">Copiar ' + esc(pl.name) + ' (v' + esc(pl.published_version) + ')</option>'; }).join('') + '</select></div></div>' +
        '<div class="field"><label for="npl-desc">Descripción (opcional)</label><input class="input" id="npl-desc" maxlength="300"></div>' +
        reasonField('npl-reason', 'Motivo') + '<div class="btn-row">' + btn('Crear borrador del plan', { type: 'submit' }) + '</div></form></section>';
    }
    html += '<details class="card" style="margin-top:16px"' + openAttr('registry') + '><summary><strong>Parámetros del registro</strong> (tipo, unidad, periodo y techo de sistema)</summary><div class="pc-scroll"><table class="pc-table"><thead><tr><th scope="col">Parámetro</th><th scope="col">Unidad · periodo</th><th scope="col">Rango</th><th scope="col">Techo de sistema</th><th scope="col">¿Se aplica?</th></tr></thead><tbody>' +
      p.parameters.map(function (def) { return '<tr><td><strong>' + esc(def.label) + '</strong><div class="tiny">' + esc(def.description) + '</div><div class="pc-mono muted">' + esc(def.key) + '</div></td><td>' + esc(def.unit) + ' · ' + esc(def.period_label) + '</td><td>' + esc(def.min) + '–' + esc(fmtVal(def.max)) + '</td><td class="tiny">' + esc(def.ceilingReason) + '</td><td>' + (def.enforcement.state === 'enforced' ? tag('Se aplica', 'nopal') : tag('No se aplica hoy', 'ocre')) + '<div class="tiny">' + esc(def.enforcement.note) + '</div></td></tr>'; }).join('') +
      '</tbody></table></div></details>';
    return html;
  }

  function planView(id) {
    var d = load('plan:' + id, '/plan-catalog/plans/' + encodeURIComponent(id));
    var p = load('params', '/plan-catalog/parameters');
    var html = '<p><a href="#/planes">← Planes</a></p>';
    // El h1 existe también mientras carga: el foco de la navegación no se pierde (WCAG 2.4.3).
    if (!d || !p) return html + '<h1 tabindex="-1" data-focus id="pl-h1">Plan</h1><div class="skeleton" style="height:240px"></div>';
    if (d.error || p.error) return html + '<h1 tabindex="-1" data-focus id="pl-h1">Plan</h1><div class="banner banner-alerta" role="alert">' + esc(d.error || p.error) + '</div>';
    var plan = d.plan;
    var draft = d.revisions.filter(function (r) { return r.status === 'DRAFT'; })[0] || null;
    var published = d.revisions.filter(function (r) { return r.status === 'PUBLISHED'; })[0] || null;
    var state = published ? (plan.active ? 'enabled' : 'disabled') : 'draft_only';
    var st = PLAN_STATE[state];
    html += '<h1 tabindex="-1" data-focus id="pl-h1">' + esc(plan.name) + '</h1><p>' + tag(st[0], st[1]) + ' ' + (published ? tag('Publicada v' + published.version, 'nopal') : '') + ' <span class="pc-mono muted">' + esc(plan.plan_id) + '</span></p>' +
      (plan.description ? '<p>' + esc(plan.description) + '</p>' : '') + commercialNote() + registryBanner(p) + (plan.price_cents == null ? '' : '<div class="banner banner-alerta">Este plan tiene un precio registrado fuera de esta consola; aquí no se gestionan precios.</div>') +
      (can('plans.edit') ? '' : '<div class="banner banner-lila"><span>Solo lectura: tu rol consulta el catálogo pero no crea, edita ni publica planes.</span></div>');
    html += '<div class="pc-grid" style="margin-top:12px">';
    if (can('plans.edit') && published && !draft) {
      html += '<section class="card stack" aria-labelledby="pd-t"><h2 id="pd-t" tabindex="-1">Editar valores</h2><p class="tiny">Se crea una revisión nueva en borrador con los valores publicados, sin confirmar. La publicada no cambia.</p><form class="stack" data-form="plan-new-draft" data-plan="' + esc(plan.plan_id) + '" novalidate>' + formError() + reasonField('pnd-reason', 'Motivo') + '<div class="btn-row">' + btn('Crear borrador v' + (Math.max.apply(null, d.revisions.map(function (r) { return r.version; })) + 1), { type: 'submit', style: 'secondary' }) + '</div></form></section>';
    }
    if (can('plans.publish') && published) {
      var rid = plan.active ? 'pst-off-reason' : 'pst-on-reason';
      html += '<section class="card stack" aria-labelledby="pe-t"><h2 id="pe-t" tabindex="-1">' + (plan.active ? 'Deshabilitar' : 'Habilitar') + ' el plan</h2><p class="tiny">' + (plan.active ? 'Deja de poder asignarse a negocios nuevos. Las suscripciones vigentes no cambian.' : 'Podrá asignarse a negocios desde MainSpot Administration con la revisión publicada.') + '</p><form class="stack" data-form="plan-status" data-plan="' + esc(plan.plan_id) + '" data-enabled="' + (plan.active ? 'false' : 'true') + '" data-reason-id="' + rid + '" novalidate>' + formError() + reasonField(rid, 'Motivo') + '<div class="btn-row">' + btn(plan.active ? 'Deshabilitar' : 'Habilitar', { type: 'submit', style: plan.active ? 'ghost' : 'secondary' }) + '</div></form></section>';
    }
    html += '</div>';
    if (draft) html += draftEditor(plan, draft, published, p.parameters);
    html += historySection(plan, d.revisions, draft, published, p.parameters) + subscriptionsSection(plan, d.subscriptions, d.subscriptions_by_revision || [], published) + eventsSection(d.events);
    // Nombre y descripción los ve el negocio al instante: se tratan como publicación (plans.publish + step-up).
    if (can('plans.publish')) {
      html += '<details class="card" style="margin-top:16px"' + openAttr('meta') + '><summary><strong>Nombre y descripción del plan</strong> <span class="tiny">(los negocios lo ven al instante)</span></summary><form class="stack" data-form="plan-meta" data-plan="' + esc(plan.plan_id) + '" style="margin-top:12px" novalidate>' + formError() + '<div class="field"><label for="pm-name">Nombre</label><input class="input" id="pm-name" minlength="3" maxlength="60" required value="' + esc(plan.name) + '" data-server="' + esc(plan.name) + '"></div><div class="field"><label for="pm-desc">Descripción</label><input class="input" id="pm-desc" maxlength="300" value="' + esc(plan.description || '') + '" data-server="' + esc(plan.description || '') + '"></div>' + reasonField('pm-reason', 'Motivo') + '<div class="btn-row">' + btn('Guardar', { type: 'submit', style: 'ghost' }) + '</div></form></details>';
    }
    return html;
  }

  function draftEditor(plan, draft, published, defs) {
    var review = load('review:' + draft.revision_id, '/plan-catalog/revisions/' + encodeURIComponent(draft.revision_id) + '/review');
    var byKey = {};
    draft.values.forEach(function (v) { byKey[v.parameter_key] = v; });
    var base = {};
    if (published) published.values.forEach(function (v) { base[v.parameter_key] = v.value; });
    var problems = {};
    if (review && review.items) review.items.forEach(function (i) { problems[i.key] = i.problem; });
    var editable = can('plans.edit');
    var categories = [];
    defs.forEach(function (def) { if (categories.indexOf(def.category) < 0) categories.push(def.category); });
    var conflict = S.draftConflict && S.draftConflict[draft.revision_id];
    var labels = paramLabels();
    var html = '<section class="card stack" style="margin-top:16px" aria-labelledby="dr-t"><h2 id="dr-t" tabindex="-1">Borrador v' + esc(draft.version) + ' · ' + esc(REV_ORIGIN[draft.origin] || draft.origin) + '</h2>' +
      (editable ? '<p class="tiny">Revisa cada valor, su unidad y su periodo, y marca «Confirmo este valor». Guardar no confirma nada por ti; cambiar un valor quita su confirmación. Para publicar, todos los valores deben estar confirmados.</p>' : '') +
      (conflict ? '<div class="banner banner-ocre" role="alert"><div><strong>Otra persona guardó este borrador mientras lo editabas.</strong> Se cargaron sus valores actuales y tus cambios no se guardaron. Revisa y vuelve a aplicar lo que necesites:<ul>' + conflict.map(function (c) { return '<li>' + esc(labels[c.key] || c.key) + ': tu valor ' + esc(c.value === undefined ? '(sin cambio)' : fmtVal(c.value)) + (c.confirmed === undefined ? '' : (c.confirmed ? ', confirmado' : ', sin confirmar')) + '</li>'; }).join('') + '</ul></div></div>' : '');
    if (!editable) {
      html += '<ul>' + defs.map(function (def) { var row = byKey[def.key] || {}; return '<li>' + esc(def.label) + ': <strong>' + esc(fmtVal(row.value)) + '</strong> ' + esc(def.unit) + ' <span class="tiny">' + esc(def.period_label) + '</span> · ' + (row.confirmed_at ? tag('Confirmado', 'nopal') : tag('Sin confirmar', 'ocre')) + '</li>'; }).join('') + '</ul></section>';
      return html + reviewSection(plan, draft, review);
    }
    html += '<form class="stack" data-form="plan-draft" data-rev="' + esc(draft.revision_id) + '" data-lock="' + esc(draft.lock_version) + '" data-plan="' + esc(plan.plan_id) + '" novalidate><div class="field-error" id="pdr-error" role="alert" data-form-error hidden></div>';
    categories.forEach(function (cat) {
      html += '<fieldset class="pc-fieldset"><legend>' + esc(cat) + '</legend>';
      defs.filter(function (def) { return def.category === cat; }).forEach(function (def) {
        var row = byKey[def.key] || {};
        var vid = fieldId('pv', def.key), cid = fieldId('pc', def.key), hid = fieldId('ph', def.key), eid = fieldId('pe', def.key);
        var src = VALUE_SOURCE[row.source] || [row.source || '—', 'neutral'];
        var changed = published && base[def.key] !== undefined && base[def.key] !== row.value;
        var server = row.value == null ? '' : String(row.value);
        html += '<div class="pc-param"><div class="pc-param-head"><label for="' + vid + '"><strong>' + esc(def.label) + '</strong></label> ' + tag(src[0], src[1]) + (changed ? ' ' + tag('Cambia: v' + published.version + ' = ' + fmtVal(base[def.key]), 'lila') : '') + (def.enforcement.state !== 'enforced' ? ' ' + tag('No se aplica hoy', 'ocre') : '') + '</div>' +
          '<p class="tiny" id="' + hid + '">' + esc(def.description) + ' <strong>Unidad:</strong> ' + esc(def.unit) + '. <strong>Periodo:</strong> ' + esc(def.period_label) + '. <strong>Rango:</strong> ' + esc(def.min) + ' a ' + esc(fmtVal(def.max)) + ', escrito solo con dígitos (' + esc(def.ceilingReason) + ')</p>' +
          // Texto con dígitos y validación estricta: un <input type=number> convierte «1,000» en 1 sin avisar.
          '<div class="pc-param-inputs"><input class="input" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-min="' + esc(def.min) + '" data-max="' + esc(def.max) + '" id="' + vid + '" data-key="' + esc(def.key) + '" data-server="' + esc(server) + '" value="' + esc(server) + '" aria-describedby="' + hid + ' ' + eid + '">' +
          '<label class="check"><input type="checkbox" id="' + cid + '" data-key="' + esc(def.key) + '" data-server="' + (row.confirmed_at ? '1' : '0') + '"' + (row.confirmed_at ? ' checked' : '') + ' aria-describedby="' + eid + '"><span>Confirmo este valor<span class="sr-only">: ' + esc(def.label) + '</span></span></label>' +
          (row.confirmed_at ? '<span class="tiny">Confirmado por <span class="pc-mono">' + esc(row.confirmed_by) + '</span> · ' + esc(when(row.confirmed_at)) + '</span>' : '') + '</div>' +
          '<p class="field-error" id="' + eid + '"' + (problems[def.key] ? '' : ' hidden') + '>' + esc(problems[def.key] || '') + '</p></div>';
      });
      html += '</fieldset>';
    });
    html += reasonField('pdr-reason', 'Motivo del cambio') + '<div class="btn-row">' + btn('Guardar borrador', { type: 'submit' }) + '</div></form>';
    // Descartar es destructivo: motivo propio y confirmación explícita, separado de Guardar. No se ofrece si el plan
    // nunca se publicó (lo dejaría sin forma de editarse; el servidor responde 409).
    if (published) {
      html += '<details class="pc-danger"' + openAttr('discard') + '><summary>Descartar el borrador v' + esc(draft.version) + '</summary><form class="stack" data-form="plan-discard" data-rev="' + esc(draft.revision_id) + '" data-lock="' + esc(draft.lock_version) + '" novalidate>' + formError() + reasonField('pdx-reason', 'Motivo del descarte') +
        '<label class="check"><input type="checkbox" id="pdx-ok" required><span>Entiendo que el borrador v' + esc(draft.version) + ' se descarta y no se puede recuperar.</span></label><div class="btn-row">' + btn('Descartar borrador', { type: 'submit', style: 'danger' }) + '</div></form></details>';
    }
    html += '</section>';
    return html + reviewSection(plan, draft, review);
  }

  function reviewSection(plan, draft, review) {
    var html = '<section class="card stack" style="margin-top:16px" aria-labelledby="rv-t"><h2 id="rv-t" tabindex="-1">Revisar y publicar v' + esc(draft.version) + '</h2>';
    if (!review) return html + '<div class="skeleton" style="height:120px"></div></section>';
    if (review.error) return html + '<div class="banner banner-alerta" role="alert">' + esc(review.error) + '</div></section>';
    var pending = review.items.filter(function (i) { return i.problem; });
    html += review.ready
      ? '<div class="banner banner-nopal"><span>Todos los valores guardados están presentes, son válidos y están confirmados.</span></div>'
      : '<div class="banner banner-ocre"><div><strong>Falta confirmar o completar ' + pending.length + ' de ' + review.items.length + ' valores:</strong><ul>' + pending.map(function (i) { return '<li>' + esc(i.label) + ': ' + esc(i.problem) + '</li>'; }).join('') + '</ul>Esta revisión refleja lo guardado: guarda el borrador para actualizarla.</div></div>';
    if (review.published_revision) {
      html += '<h3>Diferencias con la publicada v' + esc(review.published_revision.version) + '</h3>' + (review.diff.length
        ? '<div class="pc-scroll"><table class="pc-table"><thead><tr><th scope="col">Parámetro</th><th scope="col">Publicada</th><th scope="col">Borrador</th></tr></thead><tbody>' + review.diff.map(function (x) { return '<tr><td>' + esc(x.label) + '</td><td>' + esc(withUnit(x.key, x.from)) + '</td><td><strong>' + esc(withUnit(x.key, x.to)) + '</strong></td></tr>'; }).join('') + '</tbody></table></div>'
        : '<p class="muted">Sin diferencias de valores.</p>');
    } else {
      html += '<p class="muted">Primera publicación de este plan.</p>';
    }
    html += '<h3>Impacto</h3><p class="tiny">' + esc(review.impact.note) + '</p>' + (review.impact.subscriptions_by_revision.length
      ? '<ul>' + review.impact.subscriptions_by_revision.map(function (s) { return '<li>' + esc(s.n) + ' negocio(s) en v' + esc(s.version) + (review.published_revision && s.revision_id !== review.published_revision.revision_id ? ' ' + tag('anterior', 'ocre') : '') + '</li>'; }).join('') + '</ul>' : '<p class="muted">Ningún negocio tiene este plan.</p>');
    if (can('plans.publish')) {
      html += '<form class="stack" data-form="plan-publish" data-rev="' + esc(draft.revision_id) + '" data-lock="' + esc(draft.lock_version) + '" data-plan="' + esc(plan.plan_id) + '" novalidate>' + formError() +
        '<p class="banner banner-ocre" id="pp-dirty" hidden>Tienes cambios sin guardar en el borrador: guárdalos antes de publicar.</p>' + reasonField('pp-reason', 'Motivo de la publicación') +
        (review.checksum_preview ? '<p class="tiny">Huella de los valores guardados: <span class="pc-mono">' + esc(review.checksum_preview.slice(0, 16)) + '…</span></p>' : '') +
        '<div class="btn-row">' + (review.ready ? btn('Publicar v' + draft.version, { type: 'submit' }) : '<button type="submit" class="btn btn-primary" disabled aria-disabled="true"><span>Publicar v' + esc(draft.version) + '</span></button>') + '</div></form>';
    }
    return html + '</section>';
  }

  function historySection(plan, revisions, draft, published, defs) {
    var labels = {};
    defs.forEach(function (def) { labels[def.key] = def.label; });
    var current = {};
    if (published) published.values.forEach(function (v) { current[v.parameter_key] = v.value; });
    var html = '<section class="card stack" style="margin-top:16px" aria-labelledby="hi-t"><h2 id="hi-t" tabindex="-1">Historial de revisiones</h2><p class="tiny">Las revisiones publicadas nunca se modifican. Volver a una anterior crea una revisión nueva publicada con esos valores.</p>';
    revisions.forEach(function (r) {
      var rs = REV_STATE[r.status] || [r.status, 'neutral'];
      html += '<details' + openAttr('rev:' + r.revision_id) + '><summary>v' + esc(r.version) + ' ' + tag(rs[0], rs[1]) + ' · ' + esc(REV_ORIGIN[r.origin] || r.origin) + ' · ' + esc(when(r.published_at || r.created_at)) + (r.checksum ? ' <span class="pc-mono">' + esc(r.checksum.slice(0, 12)) + '</span>' : '') + '</summary>' +
        '<dl class="pc-kv"><dt>Motivo</dt><dd>' + esc(r.reason) + '</dd><dt>Creada por</dt><dd class="pc-mono">' + esc(r.created_by) + '</dd>' + (r.published_by ? '<dt>Publicada por</dt><dd class="pc-mono">' + esc(r.published_by) + '</dd><dt>Motivo de publicación</dt><dd>' + esc(r.publish_reason) + '</dd>' : '') + '</dl>' +
        '<ul>' + r.values.map(function (v) { return '<li>' + esc(labels[v.parameter_key] || v.parameter_key) + ': <strong>' + esc(withUnit(v.parameter_key, v.value)) + '</strong>' + (v.confirmed_at ? '' : ' <span class="tiny">(sin confirmar)</span>') + '</li>'; }).join('') + '</ul>';
      if (r.status === 'SUPERSEDED' && can('plans.publish') && !draft) {
        var changes = r.values.filter(function (v) { return current[v.parameter_key] !== undefined && current[v.parameter_key] !== v.value; });
        var rbId = fieldId('rb', r.revision_id);
        html += '<form class="stack" data-form="plan-rollback" data-plan="' + esc(plan.plan_id) + '" data-rev="' + esc(r.revision_id) + '" data-reason-id="' + rbId + '" novalidate>' + formError() +
          '<p class="tiny"><strong>Si vuelves a v' + esc(r.version) + ':</strong> ' + (changes.length ? changes.map(function (v) { return esc(labels[v.parameter_key] || v.parameter_key) + ' ' + esc(fmtVal(current[v.parameter_key])) + ' → ' + esc(fmtVal(v.value)); }).join('; ') : 'mismos valores que la publicada') + '. Los negocios no cambian hasta migrarlos.</p>' +
          reasonField(rbId, 'Motivo para volver a v' + r.version) + '<div class="btn-row">' + btn('Publicar de nuevo los valores de v' + r.version, { type: 'submit', style: 'secondary' }) + '</div></form>';
      }
      html += '</details>';
    });
    return html + '</section>';
  }

  function subscriptionsSection(plan, subs, byRevision, published) {
    var html = '<section class="card stack" style="margin-top:16px" aria-labelledby="su2-t"><h2 id="su2-t" tabindex="-1">Negocios con este plan</h2>';
    // Sin `tenants.read` (p. ej. ai_engineer, BR-0007) el servidor solo envía recuentos por revisión, sin identidades.
    if (!can('tenants.read')) {
      return html + (byRevision.length
        ? '<ul>' + byRevision.map(function (r) { return '<li>' + esc(r.n) + ' negocio(s) en v' + esc(r.version) + (published && r.revision_id !== published.revision_id ? ' ' + tag('anterior', 'ocre') : '') + '</li>'; }).join('') + '</ul><p class="tiny">Los nombres de los negocios, la vista previa y la migración son de MainSpot Administration (platform_admin y soporte).</p>'
        : '<p class="muted">Ningún negocio tiene este plan.</p>') + '</section>';
    }
    if (!subs.length) return html + '<p class="muted">Ningún negocio tiene este plan.</p></section>';
    var older = published ? subs.filter(function (s) { return s.plan_revision_id !== published.revision_id; }) : [];
    var labels = paramLabels();
    html += '<div class="pc-scroll"><table class="pc-table"><thead><tr><th scope="col">Negocio</th><th scope="col">Revisión fijada</th><th scope="col">Suscripción</th></tr></thead><tbody>' +
      subs.map(function (s) { return '<tr><td>' + esc(s.business_name) + '<div class="pc-mono muted">' + esc(s.tenant_id) + '</div></td><td>v' + esc(s.revision_version) + (published && s.plan_revision_id !== published.revision_id ? ' ' + tag('anterior', 'ocre') : '') + '</td><td>' + esc(s.status === 'active' ? 'activa' : s.status === 'suspended' ? 'suspendida' : s.status === 'cancelled' ? 'cancelada' : s.status) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    if (published && older.length) {
      // Solo la vista previa pedida contra la publicada vigente (si se publicó otra después, hay que volver a pedirla).
      var pv = S.migrTo && S.migrTo[plan.plan_id] === published.revision_id ? S.data['migr:' + plan.plan_id] : null;
      html += '<p>' + esc(older.length) + ' negocio(s) siguen en revisiones anteriores. ' + btn('Ver qué cambiaría al migrarlos a v' + published.version, { action: 'plan-migration-preview', arg: plan.plan_id + '|' + published.revision_id, sm: true, style: 'secondary' }) + '</p>';
      if (pv && pv.error) html += '<div class="banner banner-alerta" role="alert">' + esc(pv.error) + '</div>';
      if (pv && pv.subscriptions) {
        html += '<div class="pc-scroll"><table class="pc-table"><caption class="sr-only">Vista previa de migración</caption><thead><tr><th scope="col">Negocio</th><th scope="col">Desde</th><th scope="col">Uso por encima del nuevo límite</th></tr></thead><tbody>' +
          pv.subscriptions.map(function (s) { return '<tr><td>' + esc(s.business_name) + '</td><td>v' + esc(s.from_version) + '</td><td>' + (s.over_limit.length ? s.over_limit.map(function (o) { return tag((labels[o.capability] || o.capability) + ': usa ' + fmtVal(o.usage) + '; nuevo límite ' + fmtVal(o.new_limit), 'alerta'); }).join(' ') + '<div class="tiny">No se borra nada: lo existente se conserva y solo se bloquean nuevas creaciones.</div>' : 'Ninguno') + '</td></tr>'; }).join('') + '</tbody></table></div>';
        if (can('subscriptions.assign') && pv.subscriptions.length) {
          html += '<form class="stack" data-form="plan-migrate" data-plan="' + esc(plan.plan_id) + '" data-rev="' + esc(published.revision_id) + '" data-count="' + esc(pv.subscriptions.length) + '" novalidate>' + formError() + reasonField('pmg-reason', 'Motivo de la migración') + '<div class="btn-row">' + btn('Migrar ' + pv.subscriptions.length + ' negocio(s) a v' + published.version, { type: 'submit' }) + '</div></form>';
        } else if (pv.subscriptions.length) {
          html += '<p class="tiny">La migración la realiza un platform_admin.</p>';
        }
      }
    }
    return html + '</section>';
  }

  function eventsSection(events) {
    return '<section class="card stack" style="margin-top:16px" aria-labelledby="ev2-t"><h2 id="ev2-t" tabindex="-1">Auditoría del plan</h2>' + (events.length
      ? '<div class="pc-scroll"><table class="pc-table pc-wrap"><thead><tr><th scope="col">Cuándo</th><th scope="col">Quién</th><th scope="col">Acción</th><th scope="col">Motivo</th><th scope="col">Detalle técnico</th></tr></thead><tbody>' +
        events.map(function (e) { return '<tr><td>' + esc(when(e.at)) + '</td><td class="pc-mono">' + esc(e.actor_id) + '</td><td>' + esc(PLAN_ACTION[e.action] || e.action) + '</td><td>' + esc(e.reason || '') + '</td><td><details><summary>ver</summary><div class="pc-pre">' + esc(JSON.stringify(e.diff, null, 2)) + '</div></details></td></tr>'; }).join('') + '</tbody></table></div>'
      : '<p class="muted">Sin eventos.</p>') + '</section>';
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
      '<section class="card stack"><h2>Presupuestos</h2>' + (costs && costs.budget_status ? budgetTable(costs.budget_status.filter(function (b) { return b.scope === 'lab_experiment' || b.scope === 'lab_total'; })) : (costs && costs.error ? '<p class="tiny">' + esc(costs.error) + '</p>' : '<div class="skeleton" style="height:60px"></div>')) + '<p class="tiny">Cada prueba con grant y cada evaluación de una ruta de pago reservan del presupuesto experimental del laboratorio (día UTC) y del techo global; nunca del presupuesto diario del negocio. Sin presupuesto experimental configurado, ni el laboratorio ni las evaluaciones pueden gastar: lo fija un platform_admin en Administration › Salud. Costo máximo por llamada según cada ruta (tabla de abajo); el gasto por canal se ve en <a href="#/costos">Costos</a>.</p></section></div>';
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
    var def = eng ? (has('ai_engineer') || has('platform_admin') || !can('plans.read') ? 'casos' : 'planes') : (has('platform_admin') || has('platform_support') ? 'negocios' : 'salud');
    return { area: eng ? 'eng' : 'admin', page: parts[0] || def, arg: parts[1] };
  }
  function shell(body) {
    var r = route();
    // Solo las pestañas que el rol puede usar (el servidor rechazaría las demás).
    var aiStaff = has('ai_engineer') || has('platform_admin');
    var tabs = r.area === 'eng'
      ? (aiStaff ? [['casos', 'Casos de uso'], ['laboratorio', 'Laboratorio'], ['modelos', 'Modelos'], ['trazas', 'Trazas'], ['costos', 'Costos'], ['jobs', 'Jobs']] : []).concat(can('plans.read') ? [['planes', 'Planes']] : [])
      : (can('tenants.read') ? [['negocios', 'Negocios']] : []).concat([['salud', 'Salud']], has('platform_admin') ? [['auditoria', 'Auditoría']] : []);
    return '<a class="skip-link" href="#main">Saltar al contenido</a><div class="pc"><header class="pc-top"><strong>MainSpot ' + (r.area === 'eng' ? 'Engineering Console' : 'Administration') + '</strong>' +
      '<span class="pc-env">' + esc(S.env) + (S.real ? ' · API directas habilitadas · datos según cobertura' : ' · proveedores reales apagados') + '</span>' +
      '<nav aria-label="Secciones" class="pc-tabs">' + tabs.map(function (t) { return '<a href="#/' + t[0] + '"' + (r.page === t[0] || (t[0] === 'negocios' && r.page === 'negocio') || (t[0] === 'casos' && r.page === 'caso') || (t[0] === 'planes' && r.page === 'plan') ? ' aria-current="page"' : '') + '>' + esc(t[1]) + '</a>'; }).join('') + '</nav><span class="grow"></span>' +
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
      case 'planes': return plansView();
      case 'plan': return planView(r.arg);
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
    // Se recuerda también el valor del servidor (data-server) con el que se pintó cada control.
    app.querySelectorAll('input[id], textarea[id], select[id]').forEach(function (el) { if (el.type !== 'hidden') vals[el.id] = { v: el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value, server: el.getAttribute('data-server') }; });
    S.openDetails = changed ? {} : (function () { var o = {}; app.querySelectorAll('details[data-details]').forEach(function (d) { if (d.open) o[d.getAttribute('data-details')] = true; }); return o; })();
    if (changed) S.formErrors = {};
    app.innerHTML = S.session ? shell(view()) : loginView();
    // Errores de formulario guardados por identidad: sobreviven a redibujos y recargas (también tras un 409).
    var errFocus = null;
    app.querySelectorAll('form[data-form]').forEach(function (f) {
      var k = formKey(f), m = S.formErrors && S.formErrors[k], b = f.querySelector('[data-form-error]');
      if (!b || !m) return;
      b.hidden = false; b.textContent = m;
      if (S.focusFormError === k) { errFocus = b; b.setAttribute('tabindex', '-1'); S.focusFormError = null; }
    });
    document.title = 'MainSpot · ' + (location.pathname === '/ingenieria' ? 'Engineering Console' : 'Administration');
    // Un redibujo (datos que llegan) nunca debe cambiar lo que la persona eligió: también los <select> y las casillas.
    // Excepción: si el valor del servidor de ese control cambió (otra persona guardó), manda el servidor; así nunca se
    // reenvía un valor viejo ni una confirmación que esta persona no dio.
    if (!changed) {
      var moved = function (id) { var el = document.getElementById(id); return !!(el && vals[id] && el.getAttribute('data-server') !== vals[id].server); };
      var ids = Object.keys(vals);
      ids.filter(function (id) { return id.indexOf('pc-') !== 0; }).forEach(function (id) {
        var el = document.getElementById(id);
        if (!el || moved(id)) return;
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!vals[id].v;
        else if (el.tagName === 'SELECT') { if (Array.prototype.some.call(el.options, function (o) { return o.value === vals[id].v; })) el.value = vals[id].v; }
        else el.value = vals[id].v;
      });
      // «Confirmo este valor» se decide después de los valores y en pareja con el suyo: si el servidor cambió el valor,
      // la casilla es la del servidor; si solo cambió la casilla, nunca queda marcada junto a un valor distinto del guardado.
      ids.filter(function (id) { return id.indexOf('pc-') === 0; }).forEach(function (id) {
        var el = document.getElementById(id), vid = 'pv-' + id.slice(3), v = document.getElementById(vid);
        if (!el || moved(vid)) return;
        if (moved(id)) { if (v && v.value.trim() !== v.getAttribute('data-server')) el.checked = false; return; }
        el.checked = !!vals[id].v;
      });
    }
    syncDirty();
    var target = S.focusAfter && document.getElementById(S.focusAfter);
    if (target) S.focusAfter = null;
    var t = target || errFocus || (changed ? app.querySelector('[data-focus]') : (focusId && document.getElementById(focusId)));
    if (t) t.focus({ preventScroll: !changed && !target && !errFocus });
  }
  /** Borrador con cambios sin guardar (valor o casilla distintos de lo que dijo el servidor). */
  function draftDirty() {
    var form = document.querySelector('form[data-form="plan-draft"]');
    if (!form) return false;
    return Array.prototype.some.call(form.querySelectorAll('input[data-key]'), function (el) {
      return el.type === 'checkbox' ? el.checked !== (el.getAttribute('data-server') === '1') : el.value.trim() !== el.getAttribute('data-server');
    });
  }
  function syncDirty() {
    var note = document.getElementById('pp-dirty');
    if (note) note.hidden = !draftDirty();
  }

  /* ------------------------------------------------------------------ eventos */
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function refreshCurrent() {
    var r = route();
    if (r.page === 'caso') reload('uc:' + r.arg, '/ai/use-cases/' + encodeURIComponent(r.arg));
    // Recarga conservando lo pintado hasta que llega la respuesta: los formularios (con su error y su motivo) no
    // desaparecen mientras tanto.
    if (r.page === 'negocio') { load('tenant:' + r.arg, '/tenants/' + encodeURIComponent(r.arg), true); if (S.data.assignable) load('assignable', '/plans', true); }
    if (r.page === 'plan') {
      load('plan:' + r.arg, '/plan-catalog/plans/' + encodeURIComponent(r.arg), true);
      Object.keys(S.data).forEach(function (k) {
        if (k.indexOf('review:') === 0) load(k, '/plan-catalog/revisions/' + encodeURIComponent(k.slice(7)) + '/review', true);
        if (k.indexOf('migr:') === 0) {
          var p = k.slice(5), to = S.migrTo && S.migrTo[p];
          if (p === r.arg && to) load(k, '/plan-catalog/plans/' + encodeURIComponent(p) + '/migration-preview?to=' + encodeURIComponent(to), true); else delete S.data[k];
        }
      });
    }
    if (r.page === 'planes' && S.data.plans) load('plans', '/plan-catalog/plans', true); else delete S.data.plans;
    if (r.page !== 'negocio') delete S.data.assignable;
    delete S.data.ucs; delete S.data.tenants;
  }

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
    /** Un código por envío: un segundo envío mientras el primero está en curso sería un replay rechazado. */
    'step-up': function () {
      var p = S.pending;
      if (S.stepUpBusy || !p) return;
      S.stepUpBusy = true;
      var b = document.getElementById('su-submit');
      if (b) b.disabled = true;
      api('POST', '/auth/step-up', { code: val('su-code') }).then(function (r) {
        S.stepUpBusy = false;
        if (!r.ok) {
          if (!S.pending) return; // la sesión caducó: ya se muestra el inicio de sesión
          var e = document.getElementById('su-error'), c = document.getElementById('su-code'), sb = document.getElementById('su-submit');
          if (sb) sb.disabled = false;
          if (e) { e.hidden = false; e.textContent = r.error.message; }
          if (c) { c.setAttribute('aria-invalid', 'true'); c.select(); c.focus(); }
          return;
        }
        S.pending = null;
        render();
        act(p.method, p.path, p.body, p.done);
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
    'tenant-plan': function (form) {
      clearFormError(form);
      var sel = document.getElementById('tp-plan');
      if (!sel.value) { showFormError(form, 'Elige un plan.', sel); return; }
      var reason = reasonOk(form, 'tp-reason');
      if (reason === null) return;
      busy(form, true);
      act('POST', '/tenants/' + encodeURIComponent(form.dataset.id) + '/plan', { plan_id: sel.value, reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form, 'as-t');
        toast(r.data.changed ? 'Plan asignado y fijado a su revisión publicada' : 'El negocio ya tenía ese plan y revisión'); refreshCurrent();
      });
    },
    /** Presupuesto de IA (platform_admin): el servidor pide el código de verificación; nunca se propone un valor. */
    budget: function (form) {
      clearFormError(form);
      var sel = document.getElementById('bud-scope'), input = document.getElementById('bud-limit');
      if (!sel.value) { showFormError(form, 'Elige el ámbito del presupuesto.', sel); return; }
      var raw = input.value.trim(), limit = Number(raw);
      if (raw === '' || !isFinite(limit) || limit < 0) { showFormError(form, 'Escribe el límite en USD (0 o más).', input); return; }
      var reason = reasonOk(form, 'bud-reason');
      if (reason === null) return;
      var scope = sel.value;
      busy(form, true);
      act('PUT', '/ai/budgets/' + encodeURIComponent(scope), { limit_usd: limit, reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form, 'bud-t');
        input = document.getElementById('bud-limit');
        if (input) input.value = '';
        toast((r.data.created ? 'Presupuesto creado: ' : 'Presupuesto actualizado: ') + scope + ' = ' + money(r.data.budget.limit_usd));
        // Recarga conservando lo pintado hasta que llegan los datos nuevos (el formulario no desaparece mientras tanto).
        delete S.data.costs; load('health', '/health', true); if (S.data.spend) load('spend', '/ai/spend', true);
      });
    },
    'plan-create': function (form) {
      clearFormError(form);
      var name = document.getElementById('npl-name'), n = Array.from(name.value.trim()).length;
      if (n < 3 || n > 60) { showFormError(form, 'El nombre debe tener de 3 a 60 caracteres.', name); return; }
      var reason = reasonOk(form, 'npl-reason');
      if (reason === null) return;
      busy(form, true);
      act('POST', '/plan-catalog/plans', { name: name.value.trim(), description: val('npl-desc'), clone_from_plan_id: val('npl-clone') || null, reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form);
        toast('Plan creado en borrador: confirma cada valor antes de publicar'); delete S.data.plans; location.hash = '#/plan/' + encodeURIComponent(r.data.plan_id);
      });
    },
    'plan-new-draft': function (form) {
      clearFormError(form);
      var reason = reasonOk(form, 'pnd-reason');
      if (reason === null) return;
      busy(form, true);
      act('POST', '/plan-catalog/plans/' + encodeURIComponent(form.dataset.plan) + '/revisions', { reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form, 'dr-t');
        toast('Borrador v' + r.data.version + ' creado'); refreshCurrent();
      });
    },
    'plan-meta': function (form) {
      clearFormError(form);
      var name = document.getElementById('pm-name'), n = Array.from(name.value.trim()).length;
      if (n < 3 || n > 60) { showFormError(form, 'El nombre debe tener de 3 a 60 caracteres.', name); return; }
      var reason = reasonOk(form, 'pm-reason');
      if (reason === null) return;
      busy(form, true);
      act('PATCH', '/plan-catalog/plans/' + encodeURIComponent(form.dataset.plan), { name: name.value.trim(), description: val('pm-desc'), reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form, 'pl-h1');
        toast('Nombre y descripción guardados'); refreshCurrent();
      });
    },
    'plan-status': function (form) {
      clearFormError(form);
      var enabled = form.dataset.enabled === 'true';
      var reason = reasonOk(form, form.dataset.reasonId);
      if (reason === null) return;
      busy(form, true);
      act('POST', '/plan-catalog/plans/' + encodeURIComponent(form.dataset.plan) + '/status', { enabled: enabled, reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form, 'pe-t');
        toast(enabled ? 'Plan habilitado para asignarse' : 'Plan deshabilitado para nuevas asignaciones'); refreshCurrent();
      });
    },
    /** Solo envía lo que cambió; una casilla nunca se marca sola (cambiar un valor la desmarca). */
    'plan-draft': function (form) {
      clearFormError(form);
      var values = [], errors = [];
      form.querySelectorAll('input[type="text"][data-key]').forEach(function (inp) {
        var key = inp.dataset.key, raw = inp.value.trim(), server = inp.dataset.server;
        var box = document.getElementById(fieldId('pc', key)), err = document.getElementById(fieldId('pe', key));
        var min = Number(inp.dataset.min), max = Number(inp.dataset.max);
        // Solo dígitos: «1,000», «1.5» o «1e3» se rechazan en lugar de interpretarse.
        var bad = raw !== '' && (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max);
        if (err) { err.hidden = !bad; if (bad) err.textContent = 'Escribe solo dígitos, sin comas ni puntos: un entero entre ' + min + ' y ' + max.toLocaleString('es-MX') + '.'; }
        inp.setAttribute('aria-invalid', bad ? 'true' : 'false');
        if (bad) { errors.push(inp); return; }
        var item = { key: key }, dirty = false;
        if (raw !== server) { item.value = raw === '' ? null : Number(raw); dirty = true; }
        var wasConfirmed = box && box.dataset.server === '1', nowConfirmed = !!(box && box.checked);
        if (nowConfirmed !== wasConfirmed || (dirty && nowConfirmed)) { item.confirmed = nowConfirmed; dirty = true; }
        if (dirty) values.push(item);
      });
      if (errors.length) { showFormError(form, 'Corrige ' + errors.length + ' valor(es) antes de guardar.'); errors[0].focus(); return; }
      if (!values.length) { showFormError(form, 'No hay cambios que guardar.'); return; }
      var reason = reasonOk(form, 'pdr-reason');
      if (reason === null) return;
      busy(form, true);
      act('PATCH', '/plan-catalog/revisions/' + encodeURIComponent(form.dataset.rev), { lock_version: Number(form.dataset.lock), values: values, reason: reason }, function (r) {
        if (!r.ok) {
          // Otra persona guardó antes: se recargan sus valores y el aviso del borrador lista lo que esta persona
          // intentaba guardar (el mensaje del servidor pide recargar, que aquí ya se hace solo).
          if (r.error.code === 'stale_version') {
            S.draftConflict = S.draftConflict || {}; S.draftConflict[form.dataset.rev] = values; S.focusAfter = 'dr-t';
            busy(form, false); toast('Otra persona guardó este borrador: revisa sus valores'); refreshCurrent();
            return;
          }
          failed(form, r);
          return;
        }
        if (S.draftConflict) delete S.draftConflict[form.dataset.rev];
        succeeded(form, 'rv-t');
        toast('Borrador guardado (' + values.length + ' cambio(s))'); refreshCurrent();
      });
    },
    'plan-publish': function (form) {
      clearFormError(form);
      if (draftDirty()) { showFormError(form, 'Tienes cambios sin guardar en el borrador: guárdalos (o deshazlos) antes de publicar.'); return; }
      var reason = reasonOk(form, 'pp-reason');
      if (reason === null) return;
      busy(form, true);
      act('POST', '/plan-catalog/revisions/' + encodeURIComponent(form.dataset.rev) + '/publish', { lock_version: Number(form.dataset.lock), reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form, 'pl-h1');
        toast('Revisión v' + r.data.version + ' publicada. Los clientes vigentes siguen en su revisión.'); refreshCurrent();
      });
    },
    'plan-discard': function (form) {
      clearFormError(form);
      var ok = document.getElementById('pdx-ok');
      var reason = reasonOk(form, 'pdx-reason');
      if (reason === null) return;
      if (!ok || !ok.checked) { showFormError(form, 'Marca la casilla para confirmar que quieres descartar el borrador.', ok); return; }
      busy(form, true);
      act('POST', '/plan-catalog/revisions/' + encodeURIComponent(form.dataset.rev) + '/discard', { lock_version: Number(form.dataset.lock), reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        if (S.draftConflict) delete S.draftConflict[form.dataset.rev];
        succeeded(form, 'pl-h1');
        toast('Borrador descartado'); refreshCurrent();
      });
    },
    'plan-rollback': function (form) {
      clearFormError(form);
      var reason = reasonOk(form, form.dataset.reasonId);
      if (reason === null) return;
      busy(form, true);
      act('POST', '/plan-catalog/plans/' + encodeURIComponent(form.dataset.plan) + '/rollback', { to_revision_id: form.dataset.rev, reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form, 'pl-h1');
        toast('Publicada v' + r.data.version + ' con los valores anteriores'); refreshCurrent();
      });
    },
    'plan-migrate': function (form) {
      clearFormError(form);
      var reason = reasonOk(form, 'pmg-reason');
      if (reason === null) return;
      busy(form, true);
      act('POST', '/plan-catalog/plans/' + encodeURIComponent(form.dataset.plan) + '/migrate-subscriptions', { to_revision_id: form.dataset.rev, tenant_ids: 'all', expected_count: Number(form.dataset.count), reason: reason }, function (r) {
        if (!r.ok) { failed(form, r); return; }
        succeeded(form, 'su2-t');
        toast(r.data.migrated.length + ' negocio(s) migrados'); refreshCurrent();
      });
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
    'step-up-cancel': function () { cancelStepUp(); },
    'plan-migration-preview': function (el) {
      var p = el.dataset.arg.split('|');
      api('GET', '/plan-catalog/plans/' + encodeURIComponent(p[0]) + '/migration-preview?to=' + encodeURIComponent(p[1])).then(function (r) {
        S.migrTo = S.migrTo || {}; S.migrTo[p[0]] = p[1];
        S.data['migr:' + p[0]] = r.ok ? r.data : { error: r.error.message }; S.focusAfter = 'su2-t'; render();
      });
    },
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
  // Planes: cambiar un valor del borrador quita su casilla «Confirmo este valor»; hay que volver a marcarla.
  // Cualquier cambio en el borrador actualiza el aviso «cambios sin guardar» junto a Publicar.
  document.addEventListener('input', function (e) {
    var inp = e.target;
    if (!inp || !inp.dataset || !inp.dataset.key || !inp.closest('[data-form="plan-draft"]')) return;
    if (inp.type === 'text') {
      var box = document.getElementById(fieldId('pc', inp.dataset.key));
      if (box && inp.value.trim() !== inp.dataset.server) box.checked = false;
    }
    syncDirty();
  });
  // El usuario depende del negocio elegido; se rellena sin redibujar para no perder la selección de rutas.
  document.addEventListener('change', function (e) {
    if (!e.target || e.target.id !== 'lg-tenant') return;
    var d = S.data.lab, u = document.getElementById('lg-user');
    if (!d || !u) return;
    u.innerHTML = userOptions(d.tenants.filter(function (t) { return t.tenant_id === e.target.value; })[0]);
  });

  // Una sola acción con efecto a la vez: evita el doble envío aunque un redibujo reactive el botón.
  document.addEventListener('submit', function (e) { var f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault(); if (S.inflight && f.dataset.form !== 'step-up') return; var fn = FORMS[f.dataset.form]; if (fn) fn(f); });
  document.addEventListener('click', function (e) { var el = e.target.closest('[data-action]'); if (!el) return; var fn = ACTIONS[el.dataset.action]; if (fn) { e.preventDefault(); fn(el); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.pending) cancelStepUp(); });
  /** Cerrar el diálogo de verificación devuelve el foco al control que lo abrió. */
  function cancelStepUp() {
    var origin = S.pending && S.pending.focus;
    S.pending = null;
    if (origin) S.focusAfter = origin;
    render();
  }

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
