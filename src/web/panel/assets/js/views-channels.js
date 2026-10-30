/* =====================================================================
   MainSpot · Canales y atención (estado real del backend)
   Google Maps (ficha simulada) · Facebook (publicaciones y comentarios)
   · Atención a clientes · Caso · «Qué puede responder MainSpot por mí».
   Google y Meta siguen SIMULADOS mientras no haya conexión real verificada.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var esc = MS.esc, icon = MS.icon, UI = MS.ui;
  var V = (MS.views = MS.views || {});
  var S = function () { return MS.S; };

  function head(title, sub, extra) {
    return '<div class="page-head"><h1 tabindex="-1" data-focus>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + (extra || '') + '</div>';
  }
  function simTag(mode) { return UI.sim(mode === 'not_verified' ? 'Conexión real no verificada' : 'Simulación'); }
  function stars(n) {
    if (!n) return '';
    var s = '';
    for (var i = 1; i <= 5; i++) s += i <= n ? '★' : '☆';
    return '<span class="stars" aria-label="' + n + ' de 5 estrellas">' + s + '</span>';
  }
  MS.ui.stars = stars;

  function attentionSummary(ch) {
    var cs = S().cases.filter(function (c) { return MS.agent.SRC[c.source].ch === ch; });
    var need = cs.filter(function (c) { return ['needs_human', 'failed'].indexOf(c.status) >= 0; }).length;
    var auto = cs.filter(function (c) { return c.status === 'responded' && c.response && c.response.auto; }).length;
    return '<a class="list-row" href="#/atencion?canal=' + ch + '"><span class="lead">' + icon('message-circle') + '</span><span class="grow"><span class="title" style="display:block">' + (ch === 'google' ? 'Reseñas' : 'Comentarios') + '</span><span class="sub" style="display:block">' + cs.length + ' en total, ' + auto + ' atendidos por MainSpot</span>' + (need ? '<span style="display:block;margin-top:6px">' + UI.tag(need + (need === 1 ? ' necesita tu decisión' : ' necesitan tu decisión'), 'rosa') + '</span>' : '') + '</span>' + icon('chevron-right', 'chev') + '</a>';
  }

  /* ---------- Google Maps: ficha (GET/PUT /google/profile) ---------- */
  var DAYS = [['mon', 'Lunes'], ['tue', 'Martes'], ['wed', 'Miércoles'], ['thu', 'Jueves'], ['fri', 'Viernes'], ['sat', 'Sábado'], ['sun', 'Domingo']];
  function hoursText(hours) {
    if (!hours || !hours.length) return 'Sin horario';
    var byDay = {};
    hours.forEach(function (h) { byDay[h.day] = h.closed ? 'Cerrado' : esc(h.open) + ' a ' + esc(h.close); });
    var wk = ['mon', 'tue', 'wed', 'thu', 'fri'].map(function (d) { return byDay[d] || 'Cerrado'; });
    var same = wk.every(function (x) { return x === wk[0]; });
    var parts = same ? ['Lunes a viernes: ' + wk[0]] : DAYS.slice(0, 5).map(function (d) { return d[1] + ': ' + (byDay[d[0]] || 'Cerrado'); });
    parts.push('Sábado: ' + (byDay.sat || 'Cerrado'));
    parts.push('Domingo: ' + (byDay.sun || 'Cerrado'));
    return parts.join('<br>');
  }
  function gbpForm(p) {
    var hours = {};
    ((p && p.hours) || []).forEach(function (h) { hours[h.day] = h; });
    var wk = hours.mon || { open: '09:00', close: '18:00' };
    function dayRow(id, label, h, def) {
      var closed = h ? !!h.closed : def.closed;
      return '<fieldset class="fieldset field"><legend>' + esc(label) + '</legend><div class="hours-grid" style="grid-template-columns:1fr 1fr">' +
        '<div class="field"><label for="g-' + id + '-open" style="font-weight:400;font-size:var(--fs-sm)">Abre</label><input class="input" type="time" id="g-' + id + '-open" value="' + esc(h && h.open ? h.open : def.open) + '"></div>' +
        '<div class="field"><label for="g-' + id + '-close" style="font-weight:400;font-size:var(--fs-sm)">Cierra</label><input class="input" type="time" id="g-' + id + '-close" value="' + esc(h && h.close ? h.close : def.close) + '"></div></div>' +
        '<label class="check"><input type="checkbox" id="g-' + id + '-closed"' + (closed ? ' checked' : '') + '><span>Cerrado</span></label></fieldset>';
    }
    var site = MS.siteBase();
    return '<form class="card stack" data-form="gbp" novalidate id="gbp-form">' +
      '<div class="banner banner-alerta" id="gbp-error" role="alert" hidden>' + icon('circle-alert') + '<span id="gbp-error-text"></span></div>' +
      MS.field('g-name', 'Nombre en Google', p ? p.business_name : MS.DATA.business, 'text', 'organization') +
      MS.field('g-cat', 'Categoría principal', p ? p.primary_category : '', 'text', '', 'Por ejemplo: Panadería, Restaurante, Estética.') +
      MS.field('g-addr', 'Dirección', p ? p.address_line : site.address, 'text', 'street-address') +
      MS.field('g-loc', 'Ciudad', p ? p.locality : '', 'text', 'address-level2') +
      dayRow('wk', 'Lunes a viernes', hours.mon, { open: wk.open || '09:00', close: wk.close || '18:00', closed: false }) +
      dayRow('sat', 'Sábado', hours.sat, { open: '09:00', close: '14:00', closed: false }) +
      dayRow('sun', 'Domingo', hours.sun, { open: '09:00', close: '14:00', closed: true }) +
      '<p class="tiny">El teléfono de la ficha se elige abajo, en «Teléfono en Google Maps».</p>' +
      '<div class="btn-row">' + UI.btn(p ? 'Guardar ficha' : 'Crear mi ficha de Google', { type: 'submit', id: 'gbp-submit' }) + (p ? UI.btn('Cancelar', { action: 'gbp-cancel', style: 'ghost' }) : '') + '</div>' +
      UI.note(S().prov.google.mode === 'simulated' ? 'Ficha simulada: no se cambia nada en Google.' : 'Guardar solicita cambios a Google. Solo la lectura posterior confirma los campos admitidos; los restringidos quedan pendientes.') +
      '</form>';
  }

  /* ---------- Google: conexión OAuth real (GET /connections/google) — DEV-E2E-04 ---------- */
  var CONN_ST = {
    connected: ['Conectado con Google', 'nopal'], needs_authorization: ['Falta autorizar en Google', 'ocre'],
    permission_missing: ['Google no da permiso a este proyecto o cuenta', 'alerta'], disconnected: ['Sin conectar con Google', 'neutral'],
    failed: ['La conexión falló', 'alerta'], provider_unavailable: ['Google no responde ahora', 'ocre']
  };
  var CONN_MSG = {
    connected: 'Google quedó conectado.', needs_location: 'Google autorizado. Elige la ubicación de tu negocio.',
    error: 'No se pudo conectar con Google.'
  };
  function gbpConnectionCard(q) {
    var gc = S().googleConn;
    if (!gc) return '';
    var canManage = MS.can('editData');
    var st = CONN_ST[gc.status] || [gc.status, 'neutral'];
    var c = gc.connection;
    var html = '<section class="card stack" aria-labelledby="g-conn-t"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><h2 id="g-conn-t">Conexión con Google</h2>' + UI.tag(st[0], st[1]) + '</div>';
    if (q && q.conexion && CONN_MSG[q.conexion]) {
      html += '<div class="banner banner-' + (q.conexion === 'error' ? 'alerta' : 'nopal') + '" role="status">' + icon(q.conexion === 'error' ? 'circle-alert' : 'circle-check') + '<span>' + esc(CONN_MSG[q.conexion]) + (q.conexion === 'error' && q.motivo ? ' (' + esc(q.motivo) + ')' : '') + '</span></div>';
    }
    if (gc.blocked_prerequisites && gc.blocked_prerequisites.length) {
      html += '<p class="muted small">La conexión real con Google no está habilitada en este entorno. Falta configurar: ' + esc(gc.blocked_prerequisites.join(', ')) + '.</p>';
    }
    if (c && c.external_resource_id) {
      html += '<p class="small">Ubicación: <strong>' + esc(c.external_resource_name || c.external_resource_id) + '</strong>' + (c.last_verified_at ? '<span class="match">Comprobada ' + esc(MS.when(MS.ts(c.last_verified_at))) + '</span>' : '') + '</p>';
    }
    if (c && c.last_error_code && gc.status !== 'connected' && c.last_error_code !== 'location_not_selected') html += '<p class="tiny">Último error de Google: ' + esc(c.last_error_code) + '</p>';
    var btns = [];
    if (canManage) {
      if (gc.needs_location) btns.push(UI.btn(MS.mem.gbpLocations ? 'Actualizar ubicaciones' : 'Elegir ubicación', { action: 'gbp-locations', style: 'secondary', sm: true }));
      if (!gc.needs_location && gc.status !== 'connected') btns.push(UI.btn(c && c.has_token ? 'Volver a conectar Google' : 'Conectar Google', { action: 'gbp-connect', sm: true, disabled: !gc.oauth_configured }));
      if (gc.status === 'connected') { btns.push(UI.btn('Volver a conectar', { action: 'gbp-connect', style: 'ghost', sm: true })); btns.push(UI.btn('Comprobar', { action: 'gbp-verify-conn', style: 'secondary', sm: true })); }
      if (c && c.has_token) btns.push(UI.btn('Desconectar', { action: 'gbp-disconnect', style: 'danger', sm: true }));
    }
    if (btns.length) html += '<div class="btn-row">' + btns.join('') + '</div>';
    var L = MS.mem.gbpLocations;
    if (gc.needs_location && L) {
      var rows = [];
      (L.accounts || []).forEach(function (a) {
        (a.locations || []).forEach(function (l) {
          rows.push('<li class="list-row static" style="justify-content:space-between;flex-wrap:wrap"><span class="grow"><strong>' + esc(l.title || l.name) + '</strong><span class="sub" style="display:block">' + esc([a.account_name || a.name, l.address].filter(Boolean).join(' · ')) + (l.verified ? '' : ' · sin verificar en Google') + '</span></span>' +
            UI.btn('Usar esta', { action: 'gbp-pick-location', arg: a.name + '|' + l.name, sm: true, style: 'secondary' }) + '</li>');
        });
      });
      html += rows.length ? '<ul class="list">' + rows.join('') + '</ul>' : '<p class="muted small">La cuenta de Google autorizada no tiene ubicaciones accesibles. Verifica tu ficha en Google Business Profile o autoriza con otra cuenta.</p>';
    }
    html += '<p class="tiny">MainSpot solo responde reseñas con tu autorización expresa y guarda el texto de las reseñas de Google como máximo 30 días.</p></section>';
    return html;
  }

  V.google = function (q) {
    var g = S().gbp, prov = S().prov.google;
    var html = head('Google Maps', 'Tu ficha del negocio y tus reseñas.');
    var canEdit = MS.can('editData');
    var connCard = gbpConnectionCard(q || {}), actual = S().googleLocation;
    if (actual) connCard += '<section class="card stack"><h2>Lectura actual en Google</h2>' + UI.facts([
      ['map-pin', 'Nombre y dirección', esc([actual.title, actual.address_line, actual.locality].filter(Boolean).join(' · '))],
      ['phone', 'Teléfono confirmado', esc(actual.primary_phone || 'Sin teléfono')],
      ['clock', 'Horario confirmado', hoursText(actual.hours)],
      ['globe', 'Sitio confirmado', esc(actual.website_url || 'Sin sitio')]
    ]) + '</section>';
    if (!g) {
      html += '<section class="card stack" aria-labelledby="g-new-t"><h2 id="g-new-t">Crea tu ficha de Google Maps</h2>' +
        '<p class="muted">Así tu ficha tiene tus datos correctos y MainSpot está pendiente de tus reseñas.</p>' +
        '<ul class="list"><li class="list-row static" style="padding-left:0">' + icon('eye') + '<span>Antes de publicar algo por ti, MainSpot sigue tus reglas o te pregunta.</span></li>' +
        '<li class="list-row static" style="padding-left:0">' + icon('shield-check') + '<span>Nunca oculta ni borra opiniones.</span></li></ul>' +
        UI.note(prov.mode === 'simulated' ? 'Sin modo real: la ficha se guarda en MainSpot en simulación.' : 'Los datos locales y los campos confirmados por Google se muestran por separado.') + '</section>';
      html += connCard;
      html += canEdit ? gbpForm(actual ? Object.assign({}, actual, { business_name: actual.title }) : null) : '<p class="tiny">Quien administra tu negocio puede crearla.</p>';
      html += '<div style="margin-top:16px">' + MS.ph.card('google') + '</div>';
      html += '<section class="card card-flush" aria-label="Reseñas" style="margin-top:16px"><ul class="list"><li>' + attentionSummary('google') + '</li></ul></section>';
      return { tab: 'google', screen: 'DS-13', title: 'Google Maps', html: html };
    }
    var eff = MS.ph.effective('google'), site = MS.siteBase();
    var rated = S().cases.filter(function (c) { return c.source === 'google_review' && c.rating; });
    var avg = prov.mode === 'simulated' && rated.length ? (rated.reduce(function (s, c) { return s + c.rating; }, 0) / rated.length).toFixed(1) : null;
    var sameAddr = site.address && g.address_line && site.address.trim().toLowerCase() === g.address_line.trim().toLowerCase();
    var SYNC = { simulated_synced: ['Sincronizada (simulado)', 'nopal'], simulated_pending_verification: ['Google pediría verificar (simulado)', 'ocre'], not_verified: ['Conexión real no verificada', 'alerta'], synced: ['Confirmada en Google', 'nopal'], partial: ['Sincronización parcial: hay campos pendientes', 'ocre'], failed: ['Google no confirmó el cambio', 'alerta'] };
    var sy = SYNC[g.sync_status] || [g.sync_status, 'neutral'];
    html += '<div class="stack-lg">' + connCard;
    if (MS.mem.gbpEdit && canEdit) {
      html += gbpForm(g);
    } else {
      html += '<section class="card card-flush" aria-labelledby="g-t">' +
        '<div class="map" aria-hidden="true"><span class="street s1"></span><span class="street s2"></span><span class="street s3"></span><span class="block b1"></span><span class="block b2"></span><span class="pin"></span></div>' +
        '<div style="padding:16px 20px 20px" class="stack-sm"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><h2 id="g-t">' + esc(g.business_name) + '</h2>' + simTag(prov.mode) + '</div>' +
        '<p class="muted small">' + esc(g.primary_category) + (prov.mode === 'simulated' ? ', ' + (avg ? avg + ' ★ (' + rated.length + (rated.length === 1 ? ' reseña' : ' reseñas') + ' en MainSpot)' : 'sin reseñas todavía') : '') + '</p>' +
        '<p>' + UI.tag(sy[0], sy[1]) + '</p></div>' +
        UI.facts([
          ['map-pin', 'Dirección', esc([g.address_line, g.locality].filter(Boolean).join(', ') || 'Sin dirección') + (site.address ? '<span class="match">' + (sameAddr ? icon('check', 'ic-sm') + 'Igual que en tu página' : 'Tu página dice: ' + esc(site.address)) + '</span>' : '')],
          ['clock', 'Horario', hoursText(g.hours)],
          ['phone', 'Teléfono en Google', esc(eff ? eff.intl : 'Sin número') + '<span class="match">' + (S().phones.google.mode === 'other' ? 'Otro número, solo para Google' : 'Tu número principal') + '</span>']
        ]) +
        '<div style="padding:0 20px 16px" class="btn-row">' + (canEdit ? UI.btn('Editar ficha', { action: 'gbp-edit', style: 'secondary', sm: true, icon: 'pencil' }) : '') +
          (canEdit && g.sync_status === 'simulated_pending_verification' && S().dev.simulator ? UI.btn('Simular verificación de Google', { action: 'gbp-verify', style: 'ghost', sm: true }) : '') + '</div>' +
        '<div style="padding:0 20px 16px">' + UI.note(prov.mode === 'simulated' ? 'Ficha simulada: no se cambia nada en Google.' : 'Solo se muestran como sincronizados los campos confirmados por lectura posterior de Google. Los campos restringidos quedan pendientes.') + '</div>' +
        '</section>';
    }
    html += MS.ph.card('google') +
      '<section class="card card-flush" aria-label="Reseñas"><ul class="list"><li>' + attentionSummary('google') + '</li></ul></section>' +
      '</div>';
    return { tab: 'google', screen: 'DS-13', title: 'Google Maps', html: html };
  };

  /* ---------- Facebook: publicaciones (social/posts + aprobación) ---------- */
  MS.fb = {
    /** Borrador a partir de tus palabras (sin IA): tu texto + el teléfono elegido para Facebook. */
    write: function (prompt) {
      var n = String(prompt || '').trim();
      var ph = MS.ph.effective('facebook');
      var t = n.charAt(0).toUpperCase() + n.slice(1).replace(/[.!]*$/, '');
      return t + '.' + (ph ? ' Informes y pedidos: ' + ph.intl + '.' : '');
    },
    get: function (id) { return S().posts.filter(function (p) { return p.id === id; })[0]; }
  };

  function postCard(p, opts) {
    opts = opts || {};
    var when = p.status === 'scheduled' || (p.scheduledFor && p.status !== 'published') ? 'Programada: ' + MS.date(p.scheduledFor) + ', ' + MS.time(p.scheduledFor) : (p.publishedAt ? MS.when(p.publishedAt) : 'Vista previa');
    return '<article class="fbpost">' +
      '<header><span class="av" aria-hidden="true"><span class="brand-mark"></span></span><div><strong>' + esc(MS.DATA.business) + '</strong><div class="tiny">' + esc(when) + '</div></div></header>' +
      '<p>' + esc(p.text) + '</p>' +
      (opts.footer ? '<footer>' + opts.footer + '</footer>' : '') + '</article>';
  }
  var POST_ST = { draft: ['Espera aprobación', 'rosa'], awaiting_approval: ['Espera aprobación', 'rosa'], scheduled: ['Programada', 'lila'], publishing: ['Publicando', 'ocre'], published: ['Publicada (simulado)', 'nopal'], failed: ['No se publicó', 'alerta'], rejected: ['Descartada', 'neutral'] };

  function metaConnectionCard(q) {
    var m = S().metaConn;
    if (!m) return '';
    var c = m.connection, status = c ? c.status : 'disconnected';
    var labels = { connected: 'Página conectada', needs_authorization: 'Falta autorizar o elegir página', permission_missing: 'Faltan permisos de Facebook',
      disconnected: 'Facebook sin conectar', failed: 'La conexión falló', provider_unavailable: 'Facebook no responde' };
    var html = '<section class="card stack"><h2>Conexión con Facebook</h2><p>' + UI.tag(labels[status] || status, status === 'connected' ? 'nopal' : 'neutral') + '</p>';
    if (q && q.conexion) html += '<p role="status">Resultado de autorización: ' + esc(q.conexion) + '</p>';
    if (c && c.page_name) html += '<p>Página: <strong>' + esc(c.page_name) + '</strong></p>';
    if (!m.enabled || !m.oauth_configured) html += '<p class="muted small">La conexión real necesita SOCIAL_PROVIDER=meta, CONNECTOR_TOKEN_KEY y una app autorizada (META_APP_ID, META_APP_SECRET).</p>';
    if (MS.can('editData')) {
      html += '<div class="btn-row">' + UI.btn('Conectar Facebook', { action: 'meta-connect', disabled: !m.enabled || !m.oauth_configured }) +
        (m.enabled ? UI.btn('Elegir página', { action: 'meta-pages', style: 'secondary' }) : '') +
        (c ? UI.btn('Comprobar', { action: 'meta-verify', style: 'secondary' }) + UI.btn('Desconectar', { action: 'meta-disconnect', style: 'danger' }) : '') + '</div>';
      if (MS.mem.metaPages) html += '<ul class="list">' + MS.mem.metaPages.map(function (p) {
        return '<li class="list-row static"><span class="grow">' + esc(p.name) + '</span>' + UI.btn('Usar esta página', { action: 'meta-pick-page', arg: p.page_id, style: 'secondary', sm: true }) + '</li>';
      }).join('') + '</ul>';
    }
    return html + '<p class="tiny">Anuncios: solo comprobación de acceso autorizada. No se crean campañas ni se gasta dinero.</p></section>';
  }

  V.facebook = function (q) {
    var prov = S().prov.facebook;
    var html = head('Facebook', 'Tus publicaciones y los comentarios de tus clientes.');
    var canAsk = MS.can('social.create') && !MS.expired();
    html += '<div class="banner banner-lila" style="margin-bottom:16px">' + icon('info') + '<span>' +
      (prov.mode === 'real' ? 'Facebook real por negocio. Solo se marca una publicación como publicada tras confirmarla en Meta; los resultados inciertos requieren reconciliación o revisión.' : 'Facebook simulado: nada aparece en Facebook.') + '</span></div>';
    html += '<div class="stack-lg">' + metaConnectionCard(q) +
      (canAsk ? '<div class="btn-row">' + UI.btn('Nueva publicación', { href: '#/facebook/nueva', icon: 'plus' }) + (MS.can('ai.generate') ? UI.btn('Escribir con IA', { href: '#/ia/publicar', icon: 'sparkles', style: 'secondary' }) + UI.btn('Calendario de ideas', { href: '#/ia/calendario', icon: 'calendar', style: 'ghost' }) : '') + '</div>' : '') +
      '<section aria-labelledby="fb-posts"><div class="section-title"><h2 id="fb-posts">Publicaciones</h2>' + simTag(prov.mode) + '</div>' +
      (S().posts.length ? '<div class="card card-flush"><ul class="list" id="fb-post-list">' + S().posts.slice().sort(function (a, b) { return (b.publishedAt || b.scheduledFor || b.createdAt) - (a.publishedAt || a.scheduledFor || a.createdAt); }).map(function (x) {
        var st = x.status === 'published' && x.external && x.external.indexOf('sim:') !== 0 ? ['Publicada en Facebook', 'nopal'] : POST_ST[x.status] || [x.status, 'neutral'];
        var nc = S().cases.filter(function (c) { return c.post === x.id; }).length;
        return '<li><a class="list-row" href="#/facebook/post/' + x.id + '"><span class="lead">' + icon('message-square-text') + '</span><span class="grow"><span class="title clamp" style="display:block;font-weight:400">' + esc(x.text) + '</span><span class="sub" style="display:block">' + nc + (nc === 1 ? ' comentario' : ' comentarios') + '</span><span style="display:block;margin-top:6px">' + UI.tag(st[0], st[1]) + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>';
      }).join('') + '</ul></div>' : '<p class="card muted">Aún no tienes publicaciones.</p>') + '</section>' +
      '<section class="card card-flush" aria-label="Comentarios"><ul class="list"><li>' + attentionSummary('facebook') + '</li></ul></section>' +
      MS.ph.card('facebook') +
      UI.note('Sin gasto publicitario ni Instagram. Las publicaciones aprobadas se programan automáticamente en el servidor.') +
      '</div>';
    return { tab: 'facebook', screen: 'DS-14', title: 'Facebook', html: html };
  };

  V.fbNew = function () {
    var back = { tab: 'facebook', screen: 'DS-14', back: '#/facebook', backLabel: 'Facebook' };
    if (!MS.can('social.create') || MS.expired()) return Object.assign({ title: 'Nueva publicación', html: head('Nueva publicación') + '<div class="banner banner-lila">' + icon('lock') + '<span>' + (MS.expired() ? 'Tu plan no está activo. Para publicar, contacta a MainSpot.' : 'Tu perfil no permite crear publicaciones.') + '</span></div>' }, back);
    var d = MS.mem.fbDraft;
    var html = head('Nueva publicación', 'Cuéntale a MainSpot qué quieres decir. Te enseña cómo queda antes de publicar.');
    if (!d || d.step === 'write') {
      html += '<form class="card stack" data-form="fb-write"><div class="field"><label for="fb-prompt">¿Qué quieres contarle a tus clientes?</label><textarea class="textarea" id="fb-prompt" maxlength="1500" placeholder="Por ejemplo: ya tenemos pan de muerto">' + esc(d ? d.prompt : '') + '</textarea></div>' +
        '<div class="btn-row">' + UI.btn('Preparar publicación', { type: 'submit', id: 'fb-prepare' }) + '</div></form>';
    } else {
      var now = new Date(Date.now() + 864e5);
      var defDate = d.date || now.toISOString().slice(0, 10), defTime = d.time || '08:00';
      var canApprove = MS.can('social.approve');
      html += '<div class="stack-lg"><section aria-labelledby="fbp-t"><h2 id="fbp-t" style="font-size:var(--fs-lg);margin-bottom:10px">Así se verá en Facebook</h2>' + postCard({ text: d.text, status: 'draft' }) + '</section>' +
        '<form class="card stack" data-form="fb-confirm">' +
          '<div class="field"><label for="fb-text">Puedes ajustar el texto</label><textarea class="textarea" id="fb-text" rows="5" maxlength="2000">' + esc(d.text) + '</textarea></div>' +
          '<fieldset class="fieldset ph-modes"><legend>¿Cuándo?</legend>' +
            '<label class="radio-row' + (d.when !== 'later' ? ' is-on' : '') + '"><input type="radio" id="fb-when-now" name="fb-when" value="now" data-action="fb-when" data-arg="now"' + (d.when !== 'later' ? ' checked' : '') + '><span><span class="rr-t">Publicar ahora</span></span></label>' +
            '<label class="radio-row' + (d.when === 'later' ? ' is-on' : '') + '"><input type="radio" id="fb-when-later" name="fb-when" value="later" data-action="fb-when" data-arg="later"' + (d.when === 'later' ? ' checked' : '') + '><span><span class="rr-t">Programar</span></span></label>' +
          '</fieldset>' +
          (d.when === 'later' ? '<div class="hours-grid" style="grid-template-columns:1fr 1fr"><div class="field"><label for="fb-date">Día</label><input class="input" type="date" id="fb-date" value="' + defDate + '"></div><div class="field"><label for="fb-time">Hora</label><input class="input" type="time" id="fb-time" value="' + defTime + '"></div></div>' : '') +
          (d.when === 'later' ? '<p class="hint">Zona horaria: ' + esc(S().metaConn && S().metaConn.scheduler_timezone || 'America/Cancun') + '. Una hora inexistente o repetida por cambio de horario se rechaza.</p>' : '') +
          (d.error ? '<div class="field-error" role="alert">' + icon('circle-alert') + '<span>' + esc(d.error) + '</span></div>' : '') +
          '<div class="btn-row">' + UI.btn(canApprove ? (d.when === 'later' ? 'Programar publicación' : 'Publicar') : 'Enviar a aprobación', { type: 'submit', id: 'fb-submit' }) + UI.btn('Volver a escribir', { action: 'fb-back', style: 'secondary' }) + '</div>' +
          '<p class="tiny">Incluye el teléfono que elegiste para Facebook: ' + (MS.ph.effective('facebook') ? esc(MS.ph.effective('facebook').intl) : 'sin número') + '.</p>' +
        '</form></div>';
    }
    return Object.assign({ title: 'Nueva publicación', html: html }, back);
  };

  V.fbPost = function (id) {
    var p = MS.fb.get(id), back = { tab: 'facebook', screen: 'DS-14', back: '#/facebook', backLabel: 'Facebook' };
    if (!p) return Object.assign({ title: 'Publicación', html: UI.empty('No encontramos esa publicación', 'Puede que el enlace esté incompleto.', UI.btn('Ir a Facebook', { href: '#/facebook' })) }, back);
    var st = p.status === 'published' && p.external && p.external.indexOf('sim:') !== 0 ? ['Publicada en Facebook', 'nopal'] : POST_ST[p.status] || [p.status, 'neutral'];
    var acts = '';
    if ((p.status === 'draft' || p.status === 'awaiting_approval') && MS.can('social.approve')) acts = UI.btn(p.scheduledFor ? 'Aprobar y programar' : 'Aprobar y publicar', { action: 'fb-approve', arg: p.id, id: 'fb-approve' }) + UI.btn('Descartar', { action: 'fb-reject', arg: p.id, style: 'secondary' });
    else if ((p.status === 'draft' || p.status === 'awaiting_approval') && MS.can('social.schedule')) acts = UI.btn('Descartar', { action: 'fb-reject', arg: p.id, style: 'secondary' });
    if (p.status === 'failed' && MS.can('approve') && p.proposalId) acts = UI.btn('Intentar de nuevo', { action: 'fb-retry', arg: p.id, icon: 'refresh-cw' });
    if (p.status === 'scheduled' && MS.can('social.schedule')) acts = UI.btn('Cancelar programación', { action: 'fb-reject', arg: p.id, style: 'secondary' });
    var comments = S().cases.filter(function (c) { return c.post === p.id; });
    var html = '<div class="page-head"><div style="margin-bottom:8px">' + UI.tag(st[0], st[1]) + ' ' + simTag(S().prov.facebook.mode) + '</div><h1 tabindex="-1" data-focus>Publicación</h1>' +
      '<p>Creada por ' + esc(p.by) + (p.status === 'published' ? '. Publicada ' + esc(MS.when(p.publishedAt)) + (p.external && p.external.indexOf('sim:') === 0 ? ' en el simulador.' : ' en Facebook.') : '.') + '</p></div>' +
      '<div class="stack-lg">' + postCard(p) +
      (p.status === 'failed' ? '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>La publicación no quedó confirmada. Revisa el resultado en el proveedor antes de preparar otro envío.</span></div>' : '') +
      ((p.status === 'draft' || p.status === 'awaiting_approval') && !MS.can('social.approve') ? '<div class="banner banner-lila">' + icon('info') + '<span>Quien administra tu negocio la revisará antes de publicarla.</span></div>' : '') +
      (acts ? '<div class="btn-row">' + acts + '</div>' : '') +
      '<section aria-labelledby="fbc-t"><h2 id="fbc-t" style="font-size:var(--fs-lg);margin-bottom:10px">Comentarios</h2>' +
      (comments.length ? caseList(comments) : '<p class="card muted">Sin comentarios todavía. Cuando lleguen, MainSpot los atiende según tus reglas.</p>') +
      '</section></div>';
    return Object.assign({ title: 'Publicación', html: html }, back);
  };

  /* ---------- Atención a clientes ---------- */
  function caseList(list) {
    return '<div class="card card-flush"><ul class="list" id="case-list">' + list.map(function (c) {
      var src = MS.agent.SRC[c.source], st = MS.agent.STATUS[c.status] || { tone: 'neutral' };
      return '<li><a class="list-row case-row" href="#/caso/' + c.id + '" data-case-ext="' + esc(c.ext) + '"><span class="lead">' + icon(src.ic) + '</span><span class="grow"><span class="title" style="display:block">' + esc(c.author) + ' ' + stars(c.rating) + '</span><span class="sub clamp" style="display:block">' + esc(c.text) + '</span><span class="meta-line">' + UI.tag(MS.agent.statusLabel(c), st.tone) + '<span class="tiny">' + esc(src.short) + ', ' + esc(MS.when(c.at)) + '</span></span></span>' + icon('chevron-right', 'chev') + '</a></li>';
    }).join('') + '</ul></div>';
  }
  MS.ui.caseList = caseList;

  MS.ui.agentSummary = function () {
    var need = MS.agent.needs().length, auto = MS.agent.auto().length, err = MS.agent.errors().length;
    return '<div class="agent-sum">' +
      '<a class="as-item' + (need ? ' as-rosa' : '') + '" href="#/atencion?estado=decidir"><span class="n">' + need + '</span><span class="l">Necesitan tu decisión</span></a>' +
      '<a class="as-item" href="#/atencion?estado=atendidas"><span class="n">' + auto + '</span><span class="l">Atendidas por MainSpot</span></a>' +
      '<a class="as-item' + (err ? ' as-alerta' : '') + '" href="#/atencion?estado=errores"><span class="n">' + err + '</span><span class="l">Con error</span></a>' +
    '</div>';
  };

  MS.ui.watchLine = function () {
    return '<p class="watch"><span class="pulse" aria-hidden="true"></span><span>MainSpot está pendiente de Google y Facebook desde el servidor, aunque cierres esta pantalla. Cada canal indica su modo y conexión. Última actualización de esta pantalla: ' + esc(MS.when(S().agent.lastCheck)) + '.</span></p>';
  };

  var FILTERS = {
    decidir: function (c) { return ['needs_human', 'failed'].indexOf(c.status) >= 0; },
    atendidas: function (c) { return c.status === 'responded' && c.response && c.response.auto; },
    errores: function (c) { return c.status === 'failed' || c.status === 'retry_pending'; },
    todas: function () { return true; }
  };

  V.attention = function (q) {
    q = q || {};
    var canal = q.canal || 'todos', estado = q.estado || 'todas';
    var pol = S().agent.policy;
    var html = head('Atención a clientes', 'Reseñas de Google y comentarios de Facebook, en un solo lugar.');
    html += '<div class="stack-lg">' + MS.ui.watchLine() + MS.ui.agentSummary();
    var autoOn = pol.enabled && (pol.thanks === 'auto' || pol.info === 'auto');
    html += '<a class="card policy-link" href="#/atencion/reglas"><span class="grow"><span class="title" style="display:block;font-weight:700">Qué puede responder MainSpot por mí</span><span class="sub" style="display:block">' + esc(autoOn ? 'Respuestas automáticas solo en lo que autorizaste. Todo lo demás se revisa.' : 'Todas las respuestas públicas se revisan antes de publicarse.') + '</span></span>' + UI.tag(autoOn ? 'Respuestas automáticas activas' : 'Todo se revisa', autoOn ? 'nopal' : 'neutral') + icon('chevron-right', 'chev') + '</a>';
    if (S().telegram.status !== 'linked' && MS.can('telegram.link')) html += '<div class="banner banner-ocre">' + icon('message-circle') + '<span><strong>Telegram sin conectar</strong>Los casos siguen aquí, pero no te avisaremos al celular.<br>' + UI.btn('Conectar Telegram', { href: '#/telegram', sm: true, style: 'secondary' }) + '</span></div>';
    function qs(c, e) { return '#/atencion?canal=' + c + '&estado=' + e; }
    html += '<div class="filters"><div class="segmented" role="group" aria-label="Canal">' + [['todos', 'Todos'], ['google', 'Google'], ['facebook', 'Facebook']].map(function (x) { return '<button type="button" aria-pressed="' + (canal === x[0]) + '" data-action="go" data-arg="' + qs(x[0], estado) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="chips" role="group" aria-label="Estado">' + [['todas', 'Todas'], ['decidir', 'Te necesitan'], ['atendidas', 'Atendidas por MainSpot'], ['errores', 'Con error']].map(function (x) { return '<button type="button" class="chip' + (estado === x[0] ? ' is-on' : '') + '" aria-pressed="' + (estado === x[0]) + '" data-action="go" data-arg="' + qs(canal, x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div></div>';
    var list = S().cases.filter(function (c) { return (canal === 'todos' || MS.agent.SRC[c.source].ch === canal) && (FILTERS[estado] || FILTERS.todas)(c); });
    if (!list.length) html += UI.empty('Nada por aquí', estado === 'decidir' ? 'No hay nada que necesite tu decisión. MainSpot te avisa cuando llegue algo.' : 'Cuando lleguen reseñas o comentarios, aparecerán aquí.', '');
    else html += caseList(list);
    html += MS.devsim.block();
    html += '</div>';
    return { tab: 'atencion', screen: 'DS-15', title: 'Atención', html: html };
  };

  /* ---------- Caso ---------- */
  V.caseView = function (id) {
    var c = MS.agent.get(id), back = { tab: 'atencion', screen: 'DS-16', back: '#/atencion', backLabel: 'Atención' };
    if (!c) return Object.assign({ title: 'Caso', html: UI.empty('No encontramos este caso', 'Puede que el enlace esté incompleto o que no sea de tu negocio.', UI.btn('Ir a Atención', { href: '#/atencion' })) }, back);
    var src = MS.agent.SRC[c.source], st = MS.agent.STATUS[c.status] || { tone: 'neutral' };
    var post = c.post ? MS.fb.get(c.post) : null;
    var html = '<div class="page-head"><div class="row-wrap" style="margin-bottom:8px"><span id="case-status">' + UI.tag(MS.agent.statusLabel(c), st.tone) + '</span>' + simTag(S().prov[src.ch].mode) + '</div><h1 tabindex="-1" data-focus>' + esc(src.label) + '</h1><p>' + esc(c.author) + ', ' + esc(MS.when(c.at)) + (post ? '. En tu publicación «' + esc(post.text.slice(0, 40)) + '…»' : '') + '</p></div>';
    html += '<div class="stack-lg">';
    html += '<blockquote class="quote">' + (c.rating ? stars(c.rating) : '') + '<p>«' + esc(c.text) + '»</p></blockquote>';
    if (c.status === 'received') html += '<p class="row muted" role="status">' + icon('loader-circle', 'spinner') + 'MainSpot lo está analizando…</p>';
    if (c.category) {
      var risks = (c.riskFlags || []).length ? 'Delicado' : (c.category === 'other' ? 'Requiere criterio' : 'Seguro');
      html += '<section class="why"><h2>' + (c.response && c.response.auto ? 'Por qué respondió MainSpot solo' : (c.reason ? 'Por qué te lo paso' : 'Qué entendió MainSpot')) + '</h2><p>' + esc(c.reason) + '</p>' +
        '<dl class="why-grid"><div><dt>Qué es</dt><dd>' + esc(MS.agent.CAT_LABEL[c.category] || 'Otro tema') + '</dd></div><div><dt>Riesgo</dt><dd>' + esc(risks) + '</dd></div><div><dt>Seguridad</dt><dd>' + (c.confidence != null ? Math.round(c.confidence * 100) + '%' : '—') + '</dd></div></dl></section>';
    }
    if (c.response) {
      html += '<section class="answer" aria-labelledby="ans-t" id="case-answer"><h2 id="ans-t">' + (c.response.auto ? 'Respuesta de MainSpot' : 'Respuesta publicada') + '</h2><p>' + esc(c.response.text) + '</p><p class="tiny">' + (c.response.auto ? 'Atendido por MainSpot con tu regla versión ' + esc(c.response.policyVersion) : 'Aprobó ' + esc(c.response.by) + (c.response.via === 'tg' ? ' desde Telegram' : ' desde el panel')) + ', ' + esc(MS.when(c.response.at)) + '. ' + (c.response.delivery === 'real' ? 'Enviada al proveedor.' : 'Publicación simulada.') + '</p></section>';
    }
    if (c.status === 'responding') html += '<p class="row muted" role="status">' + icon('loader-circle', 'spinner') + 'Comprobando la publicación de la respuesta en ' + src.short + '…</p>';
    if (c.status === 'retry_pending') html += '<div class="banner banner-ocre">' + icon('clock') + '<span><strong>Resultado pendiente de confirmar</strong>MainSpot comprobará el resultado antes de otro envío' + (c.retryAt ? ' en <span data-countdown="' + c.retryAt + '">' + MS.countdown(c.retryAt) + '</span>' : '') + '.</span></div>';
    if (c.status === 'failed') html += '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span><strong>No se confirmó la respuesta</strong>Revisa el canal antes de intentar un nuevo envío: un fallo de lectura no prueba que no se publicara.</span></div>';
    if (c.status === 'rejected') html += '<div class="banner banner-lila">' + icon('info') + '<span>Se decidió no responder. La opinión sigue publicada tal cual.</span></div>';
    if (c.status === 'handled_outside') html += '<div class="banner banner-lila">' + icon('info') + '<span>Se respondió desde Reseñas. No se responde dos veces.</span></div>';

    if (c.status === 'needs_human' || c.status === 'failed') {
      var canRespond = MS.can('engagement.respond') && !MS.expired();
      var canApprove = MS.can('engagement.approve') && !MS.expired();
      var dr = MS.mem.caseDraft[c.id];
      if (!dr) dr = MS.mem.caseDraft[c.id] = { pick: 0, text: c.drafts[0] ? c.drafts[0].text : '' };
      if (!canRespond) {
        html += '<div class="banner banner-lila">' + icon('lock') + '<span>' + (MS.expired() ? 'Tu plan no está activo. Para responder, contacta a MainSpot.' : 'Tu perfil puede ver este caso, pero no responderlo.') + '</span></div>';
      } else {
        html += '<section aria-labelledby="dr-t"><h2 id="dr-t" style="font-size:var(--fs-lg);margin-bottom:10px">Elige una respuesta</h2><div class="drafts" role="radiogroup" aria-labelledby="dr-t">' +
          c.drafts.map(function (d, i) { return '<label class="draft' + (dr.pick === i ? ' is-on' : '') + '"><input type="radio" id="draft-' + c.id + '-' + i + '" name="draft-' + c.id + '" value="' + i + '" data-action="case-pick" data-arg="' + c.id + '|' + i + '"' + (dr.pick === i ? ' checked' : '') + '><span><span class="d-tone">Opción ' + (i + 1) + '</span><span class="d-text">' + esc(d.text) + '</span></span></label>'; }).join('') + '</div></section>' +
          '<form class="card stack" data-form="case-reply" data-arg="' + c.id + '"><div class="field"><label for="case-text-' + c.id + '">Tu respuesta</label><span class="hint">Puedes editarla. No prometas descuentos ni cosas que no puedas cumplir.</span><textarea class="textarea" id="case-text-' + c.id + '" rows="4" maxlength="1000">' + esc(dr.text) + '</textarea></div>' +
          '<div class="btn-row">' + UI.btn(canApprove ? (c.status === 'failed' ? 'Intentar de nuevo' : 'Publicar respuesta') : 'Guardar propuesta para aprobación', { type: 'submit', id: 'case-submit' }) + (canApprove ? UI.btn('No responder', { action: 'case-reject', arg: c.id, style: 'secondary', id: 'case-reject' }) : '') + '</div>' +
          (canApprove ? '' : '<p class="tiny">Quien administra tu negocio decide si se publica.</p>') + '</form>';
        html += S().telegram.status === 'linked' ? '<p class="tiny inline-meta">' + icon('message-circle') + '<span>También te avisamos por Telegram. Puedes decidir desde ahí; aquí verás el mismo resultado.</span></p>'
          : (MS.can('telegram.link') ? '<div class="banner banner-ocre">' + icon('message-circle') + '<span><strong>Telegram sin conectar</strong>Este caso solo está en tu panel.<br>' + UI.btn('Conectar Telegram', { href: '#/telegram', sm: true, style: 'secondary' }) + '</span></div>' : '');
      }
    }
    html += '<p class="tiny inline-meta">' + icon('shield-check') + '<span>MainSpot nunca oculta ni borra opiniones, no pide 5 estrellas y no ofrece descuentos ni promesas por ti.</span></p>';
    html += '<section aria-labelledby="ev-t"><h2 id="ev-t" style="font-size:var(--fs-lg);margin-bottom:10px">Historial</h2><ol class="track">' + c.events.map(function (e, i, arr) {
      var mine = e.who !== 'MainSpot';
      return '<li class="' + (i === arr.length - 1 ? 'ok' : 'done') + '"><span class="node">' + icon(mine ? 'user' : 'shield-check') + '</span><div><div class="t">' + esc(MS.evText(e)) + '</div><div class="d">' + esc(e.who === MS.me().name ? e.who + ' (tú)' : e.who) + ', ' + esc(MS.when(e.at)) + '</div></div></li>';
    }).join('') + '</ol></section>';
    html += '</div>';
    return Object.assign({ title: src.label, html: html }, back);
  };

  /* ---------- Reglas (GET/PUT /engagement/policies, versionadas y con consentimiento) ---------- */
  V.rules = function () {
    var a = S().agent, canEdit = MS.can('engagement.policy.manage') && !MS.expired();
    var d = MS.mem.polDraft || (MS.mem.polDraft = MS.clone(a.policy));
    var back = { tab: 'atencion', screen: 'DS-17', back: '#/atencion', backLabel: 'Atención' };
    function opt(cat, title, sub) {
      return '<fieldset class="rule"><legend><span class="rule-t">' + esc(title) + '</span><span class="rule-s">' + esc(sub) + '</span></legend>' +
        '<div class="seg2">' + [['auto', 'Responder por mí'], ['review', 'Revisar primero']].map(function (x) {
          return '<label class="seg2-o' + (d[cat] === x[0] ? ' is-on' : '') + '"><input type="radio" id="pol-' + cat + '-' + x[0] + '" name="pol-' + cat + '" value="' + x[0] + '" data-action="pol-set" data-arg="' + cat + '|' + x[0] + '"' + (d[cat] === x[0] ? ' checked' : '') + (canEdit && d.enabled ? '' : ' disabled') + '>' + x[1] + '</label>';
        }).join('') + '</div></fieldset>';
    }
    function fixed(title, sub, val) {
      return '<div class="rule"><div><span class="rule-t">' + esc(title) + '</span><span class="rule-s">' + esc(sub) + '</span></div><span class="tag tag-neutral">' + esc(val) + '</span></div>';
    }
    var html = head('Qué puede responder MainSpot por mí', 'Tú decides qué responde solo y qué te pregunta antes.');
    html += '<div class="stack-lg">';
    html += '<div class="banner banner-lila">' + icon('info') + '<span><strong>Autorización por negocio</strong>Los canales reales publican respuestas visibles con las reglas que autorices. Los simulados no publican fuera de MainSpot. Por defecto, todo se revisa antes de publicarse.</span></div>';
    html += '<section class="card stack"><div class="row" style="justify-content:space-between"><div><h2 style="font-size:var(--fs-lg)">Respuestas automáticas</h2><p class="muted small">Si lo apagas, MainSpot te pregunta antes de cada respuesta.</p></div>' +
      '<button type="button" class="switch" id="pol-switch" role="switch" aria-checked="' + !!d.enabled + '" aria-label="Respuestas automáticas" data-action="pol-toggle"' + (canEdit ? '' : ' disabled') + '><span></span></button></div></section>';
    html += '<section class="card stack" aria-labelledby="rl-t"><h2 id="rl-t" style="font-size:var(--fs-lg)">Por tipo de mensaje</h2>' +
      opt('thanks', 'Agradecimientos y comentarios positivos', 'Sin compromisos ni promesas.') +
      opt('info', 'Preguntas sobre tu negocio', 'Solo con datos que tú confirmaste (por ejemplo, el teléfono de cada canal).') +
      fixed('Quejas y molestias', 'Te aviso y te propongo 3 respuestas.', 'Siempre te pregunto') +
      fixed('Descuentos, reembolsos, acusaciones, datos personales, temas legales o emergencias', 'Nunca comprometo a tu negocio.', 'Nunca sin ti') +
      '</section>';
    html += '<section class="card stack" aria-labelledby="sc-t"><h2 id="sc-t" style="font-size:var(--fs-lg)">Dónde</h2><div class="row-wrap">' + [['google', 'Reseñas de Google'], ['facebook', 'Comentarios de Facebook']].map(function (x) {
      return '<label class="check"><input type="checkbox" id="pol-scope-' + x[0] + '" data-action="pol-scope" data-arg="' + x[0] + '"' + (d.scope[x[0]] ? ' checked' : '') + (canEdit && d.enabled ? '' : ' disabled') + '><span>' + x[1] + '</span></label>';
    }).join('') + '</div></section>';
    html += '<section class="card"><h2 style="font-size:var(--fs-lg)">Siempre, pase lo que pase</h2><ul class="list" style="margin-top:6px">' +
      ['No oculta ni borra opiniones.', 'No pide a nadie que deje 5 estrellas.', 'No ofrece descuentos, reembolsos ni promesas.', 'Responde una sola vez a cada mensaje.', 'Si algo no está claro, te pregunta.'].map(function (t) { return '<li class="list-row static" style="padding-left:0;min-height:48px">' + icon('shield-check') + '<span>' + t + '</span></li>'; }).join('') + '</ul></section>';
    var dirty = MS.agent.policyChanges(d).length > 0;
    if (canEdit) html += '<div class="btn-row">' + UI.btn('Guardar reglas', { action: 'pol-save', style: dirty ? 'primary' : 'secondary', id: 'pol-save' }) + (dirty ? UI.btn('Cancelar', { action: 'pol-cancel', style: 'ghost' }) : '') + '</div>';
    else html += '<p class="tiny">' + (MS.expired() ? 'Tu plan no está activo; las reglas no se pueden cambiar.' : 'Solo quien administra tu negocio puede cambiar estas reglas.') + '</p>';
    html += '<section aria-labelledby="vh-t"><h2 id="vh-t" style="font-size:var(--fs-lg);margin-bottom:10px">Historial de reglas</h2><div class="card card-flush"><ul class="list" id="policy-versions">' + a.versions.map(function (v, i) {
      return '<li><div class="list-row static"><span class="lead">' + icon(i === 0 ? 'shield-check' : 'history') + '</span><span class="grow"><span class="title" style="display:block">' + (v.v ? 'Versión ' + v.v : 'Predeterminado') + '</span><span class="sub" style="display:block">' + esc(v.summary) + '</span><span class="tiny" style="display:block">' + esc(v.by) + (v.at ? ', ' + esc(MS.when(v.at)) : '') + '</span></span></div></li>';
    }).join('') + '</ul></div></section>';
    html += '</div>';
    return Object.assign({ title: 'Qué puede responder MainSpot', html: html }, back);
  };
})();
