/* =====================================================================
   MainSpot · Prototipo · Canales y atención (iteración 2)
   Google Maps · Facebook (publicaciones y comentarios) · Atención a clientes
   · Caso · «Qué puede responder MainSpot por mí».
   Conexiones, sincronización y respuestas son SIMULADAS.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var esc = MS.esc, icon = MS.icon, UI = MS.ui;
  var V = (MS.views = MS.views || {});
  var S = function () { return MS.S; };
  MS.mem.connect = MS.mem.connect || {};

  function head(title, sub, extra) {
    return '<div class="page-head"><h1 tabindex="-1" data-focus>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + (extra || '') + '</div>';
  }
  function simTag() { return '<span class="tag tag-lila">Simulación</span>'; }
  function stars(n) {
    if (!n) return '';
    var s = '';
    for (var i = 1; i <= 5; i++) s += i <= n ? '★' : '☆';
    return '<span class="stars" aria-label="' + n + ' de 5 estrellas">' + s + '</span>';
  }
  MS.ui.stars = stars;

  /* ---------- Conexión simulada ---------- */
  MS.connect = {
    start: function (ch) {
      MS.mem.connect[ch] = 'searching';
      MS.emit();
      MS.later('conn-' + ch, 1500, function () { MS.mem.connect[ch] = 'found'; MS.emit(); });
    },
    confirm: function (ch) {
      var p = S().prov[ch];
      p.connected = true; p.connectedAt = Date.now(); p.perm = true;
      delete MS.mem.connect[ch];
      if (ch === 'facebook' && !S().posts.length) {
        S().posts.push({ id: MS.id('p'), text: 'Hoy salieron conchas de vainilla y chocolate recién horneadas. ¡Te esperamos!', status: 'published', createdAt: Date.now() - 3 * 864e5, publishedAt: Date.now() - 3 * 864e5, by: 'Publicada antes de conectar', prior: true });
      }
      MS.ph.propagate([ch]);
      MS.notify('tg', (ch === 'google' ? 'Tu ficha de Google' : 'Tu página de Facebook') + ' quedó conectada (simulado)', 'MainSpot ya está pendiente de tus clientes ahí.', ch === 'google' ? '#/google' : '#/facebook');
      MS.tourDone(ch);
      MS.agent.onConnect(ch);
      MS.emit();
    },
    cancel: function (ch) { delete MS.mem.connect[ch]; MS.emit(); },
    disconnect: function (ch) { var p = S().prov[ch]; p.connected = false; MS.emit(); }
  };

  function connectBlock(ch) {
    var st = MS.mem.connect[ch];
    var isG = ch === 'google';
    var name = isG ? 'tu ficha de Google' : 'tu página de Facebook';
    var html = '<section class="card stack" aria-labelledby="cn-t-' + ch + '">';
    if (st === 'searching') {
      html += '<div class="row"><span class="spot spot-work" aria-hidden="true">' + icon('hourglass') + '</span><div><h2 id="cn-t-' + ch + '">Buscando ' + name + '…</h2><p class="muted small" role="status">Esto tarda un momento.</p></div></div>';
    } else if (st === 'found') {
      html += '<h2 id="cn-t-' + ch + '">' + (isG ? '¿Es este tu negocio?' : '¿Es esta tu página?') + '</h2>' +
        '<div class="found-card"><span class="spot spot-wait" aria-hidden="true">' + icon(isG ? 'map-pin' : 'store') + '</span><div><strong>' + esc(MS.DATA.business) + '</strong><div class="muted small">' + esc(isG ? 'Panadería, ' + MS.siteBase().address : 'Página de negocio, 312 seguidores') + '</div></div></div>' +
        '<div class="btn-row">' + UI.btn(isG ? 'Sí, es mi negocio' : 'Sí, es mi página', { action: 'conn-confirm', arg: ch }) + UI.btn('No es', { action: 'conn-cancel', arg: ch, style: 'secondary' }) + '</div>' +
        UI.note('Datos de ejemplo. En producción, ' + (isG ? 'Google' : 'Meta') + ' pedirá tu permiso en su propia pantalla.');
    } else {
      html += '<h2 id="cn-t-' + ch + '">' + (isG ? 'Conecta tu ficha de Google Maps' : 'Conecta tu página de Facebook') + '</h2>' +
        '<p class="muted">' + (isG ? 'Así MainSpot revisa que tu ficha tenga tus datos correctos y está pendiente de tus reseñas.' : 'Así puedes publicar desde MainSpot y él está pendiente de los comentarios de tus clientes.') + '</p>' +
        '<ul class="list">' +
          '<li class="list-row static" style="padding-left:0">' + icon('eye') + '<span>Antes de publicar algo por ti, MainSpot sigue tus reglas o te pregunta.</span></li>' +
          '<li class="list-row static" style="padding-left:0">' + icon('shield-check') + '<span>Nunca oculta ni borra opiniones.</span></li>' +
        '</ul>' +
        (MS.can('editData') ? '<div class="btn-row">' + UI.btn(isG ? 'Conectar mi ficha de Google' : 'Conectar mi página de Facebook', { action: 'conn-start', arg: ch }) + '</div>' : '<p class="tiny">Quien administra tu negocio puede conectarla.</p>') +
        UI.note('Conexión simulada. No hay conexión real con ' + (isG ? 'Google' : 'Meta') + '.');
    }
    return html + '</section>';
  }

  function provBanners(ch) {
    var p = S().prov[ch], name = ch === 'google' ? 'Google' : 'Facebook', html = '';
    if (p.down) html += '<div class="banner banner-alerta" style="margin-bottom:16px">' + icon('triangle-alert') + '<span><strong>' + name + ' no responde</strong>Tus datos están guardados aquí. Reintentaremos sin duplicar nada. (simulado)</span></div>';
    if (!p.perm) html += '<div class="banner banner-ocre" style="margin-bottom:16px">' + icon('lock') + '<span><strong>Falta un permiso de ' + name + '</strong>MainSpot puede leer, pero no responder. Reconecta para darlo.<br>' + UI.btn('Reconectar ' + name, { action: 'perm-fix', arg: ch, sm: true, style: 'secondary' }) + '</span></div>';
    return html;
  }

  function attentionSummary(ch) {
    var cs = S().cases.filter(function (c) { return MS.agent.SRC[c.source].ch === ch; });
    var need = cs.filter(function (c) { return ['needs_human', 'awaiting_approval', 'failed'].indexOf(c.status) >= 0; }).length;
    var auto = cs.filter(function (c) { return c.status === 'responded' && c.response.auto; }).length;
    return '<a class="list-row" href="#/atencion?canal=' + ch + '"><span class="lead">' + icon('message-circle') + '</span><span class="grow"><span class="title" style="display:block">' + (ch === 'google' ? 'Reseñas' : 'Comentarios') + '</span><span class="sub" style="display:block">' + cs.length + ' en total, ' + auto + ' atendidos por MainSpot</span>' + (need ? '<span style="display:block;margin-top:6px">' + UI.tag(need + (need === 1 ? ' necesita tu decisión' : ' necesitan tu decisión'), 'rosa') + '</span>' : '') + '</span>' + icon('chevron-right', 'chev') + '</a>';
  }

  /* ---------- Google Maps ---------- */
  V.google = function () {
    var p = S().prov.google;
    var html = head('Google Maps', 'Tu ficha del negocio y tus reseñas.');
    if (!p.connected) {
      html += connectBlock('google') + '<div style="margin-top:16px">' + MS.ph.card('google') + '</div>';
      return { tab: 'google', screen: 'DS-13', title: 'Google Maps', html: html };
    }
    var d = MS.siteBase(), eff = MS.ph.effective('google');
    var gc = S().cases.filter(function (c) { return c.source === 'google_review' && c.rating; });
    var sum = 4.6 * 21, n = 21;
    gc.forEach(function (c) { sum += c.rating; n += 1; });
    html += provBanners('google') + '<div class="stack-lg">' +
      '<section class="card card-flush" aria-labelledby="g-t">' +
        '<div class="map" aria-hidden="true"><span class="street s1"></span><span class="street s2"></span><span class="street s3"></span><span class="block b1"></span><span class="block b2"></span><span class="pin"></span></div>' +
        '<div style="padding:16px 20px 20px" class="stack-sm"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><h2 id="g-t">' + esc(MS.DATA.business) + '</h2>' + simTag() + '</div>' +
        '<p class="muted small">Panadería, ' + (n ? (sum / n).toFixed(1) + ' ★ (' + n + ' reseñas)' : 'Sin reseñas') + '</p></div>' +
        UI.facts([
          ['map-pin', 'Dirección', esc(d.address) + '<span class="match">' + icon('check', 'ic-sm') + 'Igual que en tu página</span>'],
          ['clock', 'Horario', 'Lunes a viernes: ' + esc(d.hours.week) + '<br>Sábado: ' + esc(d.hours.sat) + '<br>Domingo: ' + esc(d.hours.sun) + '<span class="match">' + icon('check', 'ic-sm') + 'Igual que en tu página</span>'],
          ['phone', 'Teléfono en Google', esc(eff ? eff.intl : 'Sin número') + '<span class="match">' + (S().phones.google.mode === 'other' ? 'Otro número, solo para Google' : 'Tu número principal') + '</span>']
        ]) +
        '<div style="padding:0 20px 16px">' + UI.note('Ficha simulada. Editar horario o dirección directamente en Google aún no está conectado.') + '</div>' +
      '</section>' +
      MS.ph.card('google') +
      '<section class="card card-flush" aria-label="Reseñas"><ul class="list"><li>' + attentionSummary('google') + '</li></ul></section>' +
      '<div>' + UI.btn('Desconectar Google (simulado)', { action: 'conn-off', arg: 'google', style: 'ghost', sm: true }) + '</div>' +
      '</div>';
    return { tab: 'google', screen: 'DS-13', title: 'Google Maps', html: html };
  };

  /* ---------- Facebook ---------- */
  MS.fb = {
    write: function (prompt) {
      var n = String(prompt || '').trim();
      var ph = MS.ph.effective('facebook');
      var tail = ph ? ' Informes y pedidos: ' + ph.intl + '.' : '';
      if (/pan de muerto/i.test(n)) return '¡Ya llegó el pan de muerto a ' + MS.DATA.business + '! Recién horneado todos los días de temporada. Te esperamos en ' + MS.siteBase().address.split(',')[0] + '.' + tail;
      if (/encargo|pastel/i.test(n)) return 'En ' + MS.DATA.business + ' hacemos pasteles por encargo para tus celebraciones. Cuéntanos qué necesitas.' + tail;
      var t = n.charAt(0).toUpperCase() + n.slice(1).replace(/[.!]*$/, '');
      return t + '. Te esperamos en ' + MS.DATA.business + '.' + tail;
    },
    publish: function (id) {
      var p = MS.fb.get(id);
      if (!p || p.status === 'published' || p.status === 'publishing') return;
      p.status = 'publishing';
      MS.emit();
      MS.later('fbpub-' + id, 1400, function () {
        if (S().prov.facebook.down) { p.status = 'failed'; p.error = 'Facebook no respondió. No se publicó nada.'; }
        else { p.status = 'published'; p.publishedAt = Date.now(); p.error = null; MS.tourDone('fbPost'); }
        MS.emit();
      });
    },
    get: function (id) { return S().posts.filter(function (p) { return p.id === id; })[0]; }
  };
  MS.mem.fbDraft = MS.mem.fbDraft || null;

  function postCard(p, opts) {
    opts = opts || {};
    var when = p.status === 'scheduled' ? 'Programada: ' + MS.date(p.scheduledFor) + ', ' + MS.time(p.scheduledFor) : (p.publishedAt ? MS.when(p.publishedAt) : 'Vista previa');
    return '<article class="fbpost">' +
      '<header><span class="av" aria-hidden="true"><span class="brand-mark"></span></span><div><strong>' + esc(MS.DATA.business) + '</strong><div class="tiny">' + esc(when) + '</div></div></header>' +
      '<p>' + esc(p.text) + '</p>' +
      (opts.footer ? '<footer>' + opts.footer + '</footer>' : '') + '</article>';
  }
  var POST_ST = { draft: ['Borrador', 'neutral'], awaiting_approval: ['Espera aprobación', 'rosa'], scheduled: ['Programada', 'lila'], publishing: ['Publicando', 'ocre'], published: ['Publicada', 'nopal'], failed: ['No se publicó', 'alerta'], rejected: ['Descartada', 'neutral'] };

  V.facebook = function () {
    var p = S().prov.facebook;
    var html = head('Facebook', 'Tus publicaciones y los comentarios de tus clientes.');
    if (!p.connected) {
      html += connectBlock('facebook') + '<div style="margin-top:16px">' + MS.ph.card('facebook') + '</div>';
      return { tab: 'facebook', screen: 'DS-14', title: 'Facebook', html: html };
    }
    var canAsk = MS.can('request') && !MS.expired();
    html += provBanners('facebook') + '<div class="stack-lg">' +
      (canAsk ? '<div>' + UI.btn('Nueva publicación', { href: '#/facebook/nueva', icon: 'plus' }) + '</div>' : '') +
      '<section aria-labelledby="fb-posts"><div class="section-title"><h2 id="fb-posts">Publicaciones</h2>' + simTag() + '</div>' +
      (S().posts.length ? '<div class="card card-flush"><ul class="list">' + S().posts.slice().sort(function (a, b) { return (b.publishedAt || b.scheduledFor || b.createdAt) - (a.publishedAt || a.scheduledFor || a.createdAt); }).map(function (x) {
        var st = POST_ST[x.status];
        var nc = S().cases.filter(function (c) { return c.post === x.id; }).length;
        return '<li><a class="list-row" href="#/facebook/post/' + x.id + '"><span class="lead">' + icon('message-square-text') + '</span><span class="grow"><span class="title clamp" style="display:block;font-weight:400">' + esc(x.text) + '</span><span class="sub" style="display:block">' + nc + (nc === 1 ? ' comentario' : ' comentarios') + '</span><span style="display:block;margin-top:6px">' + UI.tag(st[0], st[1]) + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>';
      }).join('') + '</ul></div>' : '<p class="card muted">Aún no tienes publicaciones.</p>') + '</section>' +
      '<section class="card card-flush" aria-label="Comentarios"><ul class="list"><li>' + attentionSummary('facebook') + '</li></ul></section>' +
      MS.ph.card('facebook') +
      UI.note('Sin anuncios ni Instagram en este alcance.') +
      '<div>' + UI.btn('Desconectar Facebook (simulado)', { action: 'conn-off', arg: 'facebook', style: 'ghost', sm: true }) + '</div>' +
      '</div>';
    return { tab: 'facebook', screen: 'DS-14', title: 'Facebook', html: html };
  };

  V.fbNew = function () {
    var back = { tab: 'facebook', screen: 'DS-14', back: '#/facebook', backLabel: 'Facebook' };
    if (!S().prov.facebook.connected) return Object.assign({ title: 'Nueva publicación', html: head('Nueva publicación') + connectBlock('facebook') }, back);
    if (!MS.can('request') || MS.expired()) return Object.assign({ title: 'Nueva publicación', html: head('Nueva publicación') + '<div class="banner banner-lila">' + icon('lock') + '<span>' + (MS.expired() ? 'Tu prueba terminó. Para publicar, contacta a MainSpot.' : 'Tu perfil no permite crear publicaciones.') + '</span></div>' }, back);
    var d = MS.mem.fbDraft;
    var html = head('Nueva publicación', 'Cuéntale a MainSpot qué quieres decir. Te enseña cómo queda antes de publicar.');
    if (!d || d.step === 'write') {
      html += '<form class="card stack" data-form="fb-write"><div class="field"><label for="fb-prompt">¿Qué quieres contarle a tus clientes?</label><textarea class="textarea" id="fb-prompt" placeholder="Por ejemplo: ya tenemos pan de muerto">' + esc(d ? d.prompt : '') + '</textarea></div>' +
        '<div class="chips" aria-label="Ideas">' + ['Ya tenemos pan de muerto', 'Hacemos pasteles por encargo'].map(function (c) { return '<button type="button" class="chip" data-action="fb-chip" data-arg="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
        '<div class="btn-row">' + UI.btn('Preparar publicación', { type: 'submit' }) + '</div></form>';
    } else {
      var now = new Date(Date.now() + 864e5);
      var defDate = d.date || now.toISOString().slice(0, 10), defTime = d.time || '08:00';
      html += '<div class="stack-lg"><section aria-labelledby="fbp-t"><h2 id="fbp-t" style="font-size:var(--fs-lg);margin-bottom:10px">Así se verá en Facebook</h2>' + postCard({ text: d.text, status: 'draft' }) + '</section>' +
        '<form class="card stack" data-form="fb-confirm">' +
          '<div class="field"><label for="fb-text">Puedes ajustar el texto</label><textarea class="textarea" id="fb-text" rows="5">' + esc(d.text) + '</textarea></div>' +
          '<fieldset class="fieldset ph-modes"><legend>¿Cuándo?</legend>' +
            '<label class="radio-row' + (d.when !== 'later' ? ' is-on' : '') + '"><input type="radio" id="fb-when-now" name="fb-when" value="now" data-action="fb-when" data-arg="now"' + (d.when !== 'later' ? ' checked' : '') + '><span><span class="rr-t">Publicar ahora</span></span></label>' +
            '<label class="radio-row' + (d.when === 'later' ? ' is-on' : '') + '"><input type="radio" id="fb-when-later" name="fb-when" value="later" data-action="fb-when" data-arg="later"' + (d.when === 'later' ? ' checked' : '') + '><span><span class="rr-t">Programar</span></span></label>' +
          '</fieldset>' +
          (d.when === 'later' ? '<div class="hours-grid" style="grid-template-columns:1fr 1fr"><div class="field"><label for="fb-date">Día</label><input class="input" type="date" id="fb-date" value="' + defDate + '"></div><div class="field"><label for="fb-time">Hora</label><input class="input" type="time" id="fb-time" value="' + defTime + '"></div></div>' : '') +
          (d.error ? '<div class="field-error">' + icon('circle-alert') + '<span>' + esc(d.error) + '</span></div>' : '') +
          '<div class="btn-row">' + UI.btn(MS.can('approve') ? (d.when === 'later' ? 'Programar publicación' : 'Publicar') : 'Enviar a aprobación', { type: 'submit' }) + UI.btn('Volver a escribir', { action: 'fb-back', style: 'secondary' }) + '</div>' +
          '<p class="tiny">Incluye el teléfono que elegiste para Facebook. ' + (MS.ph.effective('facebook') ? esc(MS.ph.effective('facebook').intl) : 'Sin número') + '.</p>' +
        '</form></div>';
    }
    return Object.assign({ title: 'Nueva publicación', html: html }, back);
  };

  V.fbPost = function (id) {
    var p = MS.fb.get(id), back = { tab: 'facebook', screen: 'DS-14', back: '#/facebook', backLabel: 'Facebook' };
    if (!p) return Object.assign({ title: 'Publicación', html: UI.empty('No encontramos esa publicación', 'Puede que el enlace esté incompleto.', UI.btn('Ir a Facebook', { href: '#/facebook' })) }, back);
    var st = POST_ST[p.status];
    var acts = '';
    if (p.status === 'awaiting_approval' && MS.can('approve')) acts = UI.btn('Aprobar y publicar', { action: 'fb-approve', arg: p.id }) + UI.btn('Descartar', { action: 'fb-reject', arg: p.id, style: 'secondary' });
    if (p.status === 'failed') acts = UI.btn('Intentar de nuevo', { action: 'fb-retry', arg: p.id, icon: 'refresh-cw' });
    if (p.status === 'scheduled' && MS.can('approve')) acts = UI.btn('Cancelar programación', { action: 'fb-reject', arg: p.id, style: 'secondary' });
    var comments = S().cases.filter(function (c) { return c.post === p.id; });
    var html = '<div class="page-head"><div style="margin-bottom:8px">' + UI.tag(st[0], st[1]) + ' ' + simTag() + '</div><h1 tabindex="-1" data-focus>Publicación</h1>' +
      '<p>' + esc(p.prior ? 'Publicada antes de conectar MainSpot.' : 'Creada por ' + p.by + (p.approvedBy ? '. Aprobó ' + p.approvedBy : '') + '.') + '</p></div>' +
      '<div class="stack-lg">' + postCard(p) +
      (p.error ? '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(p.error) + '</span></div>' : '') +
      (acts ? '<div class="btn-row">' + acts + '</div>' : '') +
      '<section aria-labelledby="fbc-t"><h2 id="fbc-t" style="font-size:var(--fs-lg);margin-bottom:10px">Comentarios</h2>' +
      (comments.length ? caseList(comments) : '<p class="card muted">Sin comentarios todavía. Cuando lleguen, MainSpot los atiende según tus reglas.</p>') +
      '</section></div>';
    return Object.assign({ title: 'Publicación', html: html }, back);
  };

  /* ---------- Atención a clientes ---------- */
  function caseList(list) {
    return '<div class="card card-flush"><ul class="list">' + list.map(function (c) {
      var src = MS.agent.SRC[c.source], st = MS.agent.STATUS[c.status];
      return '<li><a class="list-row case-row" href="#/caso/' + c.id + '"><span class="lead">' + icon(src.ic) + '</span><span class="grow"><span class="title" style="display:block">' + esc(c.author) + ' ' + stars(c.rating) + '</span><span class="sub clamp" style="display:block">' + esc(c.text) + '</span><span class="meta-line">' + UI.tag(MS.agent.statusLabel(c), st.tone) + '<span class="tiny">' + esc(src.short) + ', ' + esc(MS.when(c.at)) + '</span></span></span>' + icon('chevron-right', 'chev') + '</a></li>';
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
    var a = S().agent, g = S().prov.google.connected, f = S().prov.facebook.connected;
    if (!g && !f) return '<p class="watch watch-off">' + icon('info', 'ic-sm') + '<span>Conecta Google o Facebook para que MainSpot esté pendiente de tus clientes.</span></p>';
    var where = [g ? 'Google' : null, f ? 'Facebook' : null].filter(Boolean).join(' y ');
    if (!a.watching) return '<p class="watch watch-pause">' + icon('clock', 'ic-sm') + '<span>La vigilancia está en pausa. Al reanudar, recuperamos lo que llegó mientras tanto' + (a.queue.length ? ' (' + a.queue.length + ' en espera)' : '') + '. (simulado)</span></p>';
    return '<p class="watch">' + '<span class="pulse" aria-hidden="true"></span><span>MainSpot está pendiente de ' + where + ', aunque cierres esta pantalla. Última revisión: ' + esc(MS.when(a.lastCheck)) + '. (simulado)</span></p>';
  };

  var FILTERS = {
    decidir: function (c) { return ['needs_human', 'awaiting_approval', 'failed'].indexOf(c.status) >= 0; },
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
    html += '<a class="card policy-link" href="#/atencion/reglas"><span class="grow"><span class="title" style="display:block;font-weight:700">Qué puede responder MainSpot por mí</span><span class="sub" style="display:block">' + esc(S().agent.versions[0].summary) + '</span></span>' + UI.tag(pol.enabled && (pol.thanks === 'auto' || pol.info === 'auto') ? 'Respuestas automáticas activas' : 'Todo se revisa', pol.enabled && (pol.thanks === 'auto' || pol.info === 'auto') ? 'nopal' : 'neutral') + icon('chevron-right', 'chev') + '</a>';
    if (S().telegram.status !== 'linked') html += '<div class="banner banner-ocre">' + icon('message-circle') + '<span><strong>Telegram sin conectar</strong>Los casos siguen aquí, pero no te avisaremos al celular.<br>' + UI.btn('Conectar Telegram', { href: '#/telegram', sm: true, style: 'secondary' }) + '</span></div>';
    function qs(c, e) { return '#/atencion?canal=' + c + '&estado=' + e; }
    html += '<div class="filters"><div class="segmented" role="group" aria-label="Canal">' + [['todos', 'Todos'], ['google', 'Google'], ['facebook', 'Facebook']].map(function (x) { return '<button type="button" aria-pressed="' + (canal === x[0]) + '" data-action="go" data-arg="' + qs(x[0], estado) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="chips" role="group" aria-label="Estado">' + [['todas', 'Todas'], ['decidir', 'Te necesitan'], ['atendidas', 'Atendidas por MainSpot'], ['errores', 'Con error']].map(function (x) { return '<button type="button" class="chip' + (estado === x[0] ? ' is-on' : '') + '" aria-pressed="' + (estado === x[0]) + '" data-action="go" data-arg="' + qs(canal, x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div></div>';
    var list = S().cases.filter(function (c) { return (canal === 'todos' || MS.agent.SRC[c.source].ch === canal) && (FILTERS[estado] || FILTERS.todas)(c); });
    if (!S().prov.google.connected && !S().prov.facebook.connected) {
      html += UI.empty('Aún no hay canales conectados', 'Conecta tu ficha de Google o tu página de Facebook y aquí verás lo que dicen tus clientes.', '<div class="btn-row" style="justify-content:center">' + UI.btn('Conectar Google', { href: '#/google' }) + UI.btn('Conectar Facebook', { href: '#/facebook', style: 'secondary' }) + '</div>');
    } else if (!list.length) {
      html += UI.empty('Nada por aquí', estado === 'decidir' ? 'No hay nada que necesite tu decisión. MainSpot te avisa cuando llegue algo.' : 'Cuando lleguen reseñas o comentarios, aparecerán aquí.', '');
    } else html += caseList(list);
    html += MS.ui.demoArrivals();
    html += '</div>';
    return { tab: 'atencion', screen: 'DS-15', title: 'Atención', html: html };
  };

  /* Bloque de demostración dentro de Atención (claramente marcado). */
  MS.ui.demoArrivals = function () {
    var g = S().prov.google.connected, f = S().prov.facebook.connected;
    if (!g && !f) return '';
    var b = function (k, l) { return '<button type="button" class="dp-inline" data-action="arrive" data-arg="' + k + '">' + esc(l) + '</button>'; };
    return '<section class="demo-inline" aria-label="Herramienta de demostración"><p><strong>Herramienta de demostración:</strong> simula que llega algo nuevo.</p><div class="row-wrap">' +
      (g ? b('g_thanks2', 'Reseña de 5★') + b('g_complaint', 'Reseña de 2★ con queja') + b('g_accuse', 'Reseña con acusación') : '') +
      (f ? b('f_thanks', 'Comentario «¡Qué rico!»') + b('f_question', 'Pregunta de horario') + b('f_discount', 'Piden descuento') : '') + '</div></section>';
  };

  /* ---------- Caso ---------- */
  MS.mem.caseDraft = MS.mem.caseDraft || {};
  V.caseView = function (id) {
    var c = MS.agent.get(id), back = { tab: 'atencion', screen: 'DS-16', back: '#/atencion', backLabel: 'Atención' };
    if (!c) return Object.assign({ title: 'Caso', html: UI.empty('No encontramos este caso', 'Puede que el enlace esté incompleto.', UI.btn('Ir a Atención', { href: '#/atencion' })) }, back);
    var src = MS.agent.SRC[c.source], st = MS.agent.STATUS[c.status];
    var post = c.post ? MS.fb.get(c.post) : null;
    var html = '<div class="page-head"><div class="row-wrap" style="margin-bottom:8px">' + UI.tag(MS.agent.statusLabel(c), st.tone) + simTag() + '</div><h1 tabindex="-1" data-focus>' + esc(src.label) + '</h1><p>' + esc(c.author) + ', ' + esc(MS.when(c.at)) + (post ? '. En tu publicación «' + esc(post.text.slice(0, 40)) + '…»' : '') + '</p></div>';
    html += '<div class="stack-lg">';
    html += '<blockquote class="quote">' + (c.rating ? stars(c.rating) : '') + '<p>«' + esc(c.text) + '»</p></blockquote>';
    if (c.status === 'received' || c.status === 'classifying') {
      html += '<p class="row muted" role="status">' + icon('loader-circle', 'spinner') + 'MainSpot lo está analizando…</p>';
    }
    if (c.category) {
      html += '<section class="why"><h2>' + (c.policyVersion && !c.resolvedBy ? 'Por qué responde MainSpot solo' : (c.reason ? 'Por qué te lo paso' : 'Qué entendió MainSpot')) + '</h2><p>' + esc(c.reason) + '</p>' +
        '<dl class="why-grid"><div><dt>Qué es</dt><dd>' + esc((MS.agent.INTENT[c.intent] || {}).label || 'Otro') + '</dd></div><div><dt>Tono</dt><dd>' + esc(c.sentiment) + '</dd></div><div><dt>Seguridad</dt><dd>' + Math.round(c.confidence * 100) + '%</dd></div></dl></section>';
    }
    if (c.response) {
      html += '<section class="answer" aria-labelledby="ans-t"><h2 id="ans-t">' + (c.response.auto ? 'Respuesta de MainSpot' : 'Tu respuesta') + '</h2><p>' + esc(c.response.text) + '</p><p class="tiny">' + (c.response.auto ? 'Atendido por MainSpot con tu regla versión ' + c.response.policyVersion : 'Aprobó ' + esc(c.response.by) + (c.response.via === 'tg' ? ' desde Telegram' : ' desde el panel')) + ', ' + esc(MS.when(c.response.at)) + '. Publicación simulada.</p></section>';
    }
    if (c.status === 'responding') html += '<p class="row muted" role="status">' + icon('loader-circle', 'spinner') + 'Publicando la respuesta en ' + src.short + '… (simulado)</p>';
    if (c.status === 'retry_pending') html += '<div class="banner banner-ocre">' + icon('clock') + '<span><strong>' + src.short + ' no respondió</strong>No se publicó nada. Intento ' + (c.attempts + 1) + ' en <span data-countdown="' + c.retryAt + '">' + MS.countdown(c.retryAt) + '</span>.<br>' + UI.btn('Intentar ahora', { action: 'case-retry', arg: c.id, sm: true, style: 'secondary', icon: 'refresh-cw' }) + '</span></div>';
    if (c.status === 'failed') html += '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span><strong>No se pudo responder</strong>' + esc(c.reason) + '<br>' + UI.btn('Intentar de nuevo', { action: 'case-retry', arg: c.id, sm: true, style: 'secondary', icon: 'refresh-cw' }) + '</span></div>';
    if (c.status === 'rejected') html += '<div class="banner banner-lila">' + icon('info') + '<span>Decidiste no responder. La opinión sigue publicada tal cual.</span></div>';
    if (c.status === 'handled_outside') html += '<div class="banner banner-lila">' + icon('info') + '<span>Lo atendiste fuera de MainSpot. No se publicó ninguna respuesta.</span></div>';

    if (c.status === 'needs_human' || c.status === 'awaiting_approval') {
      var canAct = MS.can('request') && !MS.expired();
      var dr = MS.mem.caseDraft[c.id] || (MS.mem.caseDraft[c.id] = { pick: c.status === 'awaiting_approval' ? -1 : 0, text: c.status === 'awaiting_approval' ? c.proposal : c.drafts[0].text });
      if (!canAct) {
        html += '<div class="banner banner-lila">' + icon('lock') + '<span>' + (MS.expired() ? 'Tu prueba terminó. Para responder, contacta a MainSpot.' : 'Tu perfil puede ver este caso, pero no responderlo.') + '</span></div>';
      } else {
        if (c.status === 'awaiting_approval') html += '<div class="banner banner-lila">' + icon('info') + '<span>Esta respuesta la propuso alguien de tu equipo y espera aprobación.</span></div>';
        html += '<section aria-labelledby="dr-t"><h2 id="dr-t" style="font-size:var(--fs-lg);margin-bottom:10px">Elige una respuesta</h2><div class="drafts" role="radiogroup" aria-labelledby="dr-t">' +
          c.drafts.map(function (d, i) { return '<label class="draft' + (dr.pick === i ? ' is-on' : '') + '"><input type="radio" id="draft-' + c.id + '-' + i + '" name="draft-' + c.id + '" value="' + i + '" data-action="case-pick" data-arg="' + c.id + '|' + i + '"' + (dr.pick === i ? ' checked' : '') + '><span><span class="d-tone">Opción ' + (i + 1) + ': ' + esc(d.tone) + '</span><span class="d-text">' + esc(d.text) + '</span></span></label>'; }).join('') + '</div></section>' +
          '<form class="card stack" data-form="case-reply" data-arg="' + c.id + '"><div class="field"><label for="case-text-' + c.id + '">Tu respuesta</label><span class="hint">Puedes editarla. No prometas descuentos ni cosas que no puedas cumplir.</span><textarea class="textarea" id="case-text-' + c.id + '" rows="4">' + esc(dr.text) + '</textarea></div>' +
          '<div class="btn-row">' + UI.btn(MS.can('approve') ? 'Publicar respuesta' : 'Enviar a aprobación', { type: 'submit', id: 'case-submit' }) + UI.btn('No responder', { action: 'case-reject', arg: c.id, style: 'secondary' }) + '</div>' +
          '<button type="button" class="link-btn" data-action="case-outside" data-arg="' + c.id + '">Ya lo atendí fuera de MainSpot</button></form>';
        html += S().telegram.status === 'linked' ? '<p class="tiny inline-meta">' + icon('message-circle') + '<span>También te avisamos por Telegram. Puedes decidir desde ahí; aquí verás el mismo resultado.</span></p>'
          : '<div class="banner banner-ocre">' + icon('message-circle') + '<span><strong>Telegram sin conectar</strong>Este caso solo está en tu panel.<br>' + UI.btn('Conectar Telegram', { href: '#/telegram', sm: true, style: 'secondary' }) + '</span></div>';
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

  /* ---------- Reglas ---------- */
  MS.mem.polDraft = null;
  V.rules = function () {
    var a = S().agent, canEdit = MS.can('approve') && !MS.expired();
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
    html += '<div class="banner banner-lila">' + icon('flask-conical') + '<span><strong>Modo de prueba de desarrollo</strong>Las respuestas automáticas son simuladas: nada se publica en Google ni en Facebook. Por defecto, todo se revisa antes de publicarse.</span></div>';
    html += '<section class="card stack"><div class="row" style="justify-content:space-between"><div><h2 style="font-size:var(--fs-lg)">Respuestas automáticas</h2><p class="muted small">Si lo apagas, MainSpot te pregunta antes de cada respuesta.</p></div>' +
      '<button type="button" class="switch" id="pol-switch" role="switch" aria-checked="' + !!d.enabled + '" aria-label="Respuestas automáticas" data-action="pol-toggle"' + (canEdit ? '' : ' disabled') + '><span></span></button></div></section>';
    html += '<section class="card stack" aria-labelledby="rl-t"><h2 id="rl-t" style="font-size:var(--fs-lg)">Por tipo de mensaje</h2>' +
      opt('thanks', 'Agradecimientos y comentarios positivos', 'Sin compromisos ni promesas.') +
      opt('info', 'Preguntas sobre tu negocio', 'Solo horario, dirección y teléfono que tú confirmaste.') +
      fixed('Quejas y molestias', 'Te aviso y te propongo 3 respuestas.', 'Siempre te pregunto') +
      fixed('Descuentos, reembolsos, acusaciones, datos personales, temas legales o emergencias', 'Nunca comprometo a tu negocio.', 'Nunca sin ti') +
      '</section>';
    html += '<section class="card stack" aria-labelledby="sc-t"><h2 id="sc-t" style="font-size:var(--fs-lg)">Dónde</h2><div class="row-wrap">' + [['google', 'Reseñas de Google'], ['facebook', 'Comentarios de Facebook']].map(function (x) {
      return '<label class="check"><input type="checkbox" id="pol-scope-' + x[0] + '" data-action="pol-scope" data-arg="' + x[0] + '"' + (d.scope[x[0]] ? ' checked' : '') + (canEdit && d.enabled ? '' : ' disabled') + '><span>' + x[1] + '</span></label>';
    }).join('') + '</div></section>';
    html += '<section class="card"><h2 style="font-size:var(--fs-lg)">Siempre, pase lo que pase</h2><ul class="list" style="margin-top:6px">' +
      ['No oculta ni borra opiniones.', 'No pide a nadie que deje 5 estrellas.', 'No ofrece descuentos, reembolsos ni promesas.', 'Responde una sola vez a cada mensaje.', 'Si algo no está claro, te pregunta.'].map(function (t) { return '<li class="list-row static" style="padding-left:0;min-height:48px">' + icon('shield-check') + '<span>' + t + '</span></li>'; }).join('') + '</ul></section>';
    var dirty = JSON.stringify(d) !== JSON.stringify(a.policy);
    if (canEdit) html += '<div class="btn-row">' + UI.btn('Guardar reglas', { action: 'pol-save', style: dirty ? 'primary' : 'secondary', id: 'pol-save' }) + (dirty ? UI.btn('Cancelar', { action: 'pol-cancel', style: 'ghost' }) : '') + '</div>';
    else html += '<p class="tiny">' + (MS.expired() ? 'Tu prueba terminó; las reglas no se pueden cambiar.' : 'Solo quien administra tu negocio puede cambiar estas reglas.') + '</p>';
    html += '<section aria-labelledby="vh-t"><h2 id="vh-t" style="font-size:var(--fs-lg);margin-bottom:10px">Historial de reglas</h2><div class="card card-flush"><ul class="list">' + a.versions.map(function (v, i) {
      return '<li><div class="list-row static"><span class="lead">' + icon(i === 0 ? 'shield-check' : 'history') + '</span><span class="grow"><span class="title" style="display:block">Versión ' + v.v + (i === 0 ? ' (vigente)' : '') + '</span><span class="sub" style="display:block">' + esc(v.summary) + '</span><span class="tiny" style="display:block">' + esc(v.by) + ', ' + esc(MS.when(v.at)) + '</span></span></div></li>';
    }).join('') + '</ul></div></section>';
    html += '</div>';
    return Object.assign({ title: 'Qué puede responder MainSpot', html: html }, back);
  };
})();
