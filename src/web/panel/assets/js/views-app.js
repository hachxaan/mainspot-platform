/* =====================================================================
   MainSpot · Vistas del panel del propietario (estado real del backend)
   DS-05 Inicio · DS-06 Mi negocio y plan · DS-07 Telegram
   DS-08 Cambios · DS-09 Vista previa · DS-10 Aprobación
   DS-11 Mi página y publicación · DS-12 Avisos
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var esc = MS.esc, icon = MS.icon, UI = MS.ui;
  var V = (MS.views = MS.views || {});

  /* ---------- Estructura común ---------- */
  var TABS = [
    { key: 'inicio', href: '#/inicio', label: 'Inicio', ic: 'house' },
    { key: 'pagina', href: '#/pagina', label: 'Mi página', ic: 'globe' },
    { key: 'google', href: '#/google', label: 'Google', ic: 'map-pin' },
    { key: 'facebook', href: '#/facebook', label: 'Facebook', ic: 'megaphone' },
    { key: 'atencion', href: '#/atencion', label: 'Atención', ic: 'messages-square' }
  ];

  MS.shell = function (v) {
    var S = MS.S, me = MS.me();
    var pend = MS.pendingRequests().filter(function (r) { return r.status === 'preview_ready' || r.status === 'awaiting_confirm' || r.status === 'expired' || r.status === 'failed'; }).length;
    var unread = MS.unread();
    function badge(key) {
      if (key === 'pagina' && pend) return '<span class="badge-count" aria-label="' + pend + ' pendientes">' + pend + '</span>';
      var need = MS.agent.needs().length;
      if (key === 'atencion' && need) return '<span class="badge-count" aria-label="' + need + ' necesitan tu decisión">' + need + '</span>';
      if (key === 'avisos' && unread) return '<span class="badge-count" aria-label="' + unread + ' sin leer">' + unread + '</span>';
      return '';
    }
    var tg = S.telegram.status === 'linked';
    var side = '<aside class="sidebar" aria-label="Menú">' +
      '<a class="brand" href="#/inicio"><span class="brand-mark" aria-hidden="true"></span>MainSpot</a>' +
      '<nav aria-label="Principal"><ul class="side-nav">' +
        TABS.concat([{ key: 'avisos', href: '#/avisos', label: 'Avisos', ic: 'bell' }, { key: 'negocio', href: '#/negocio', label: 'Mi negocio', ic: 'store' }]).map(function (t) {
          return '<li><a href="' + t.href + '"' + (v.tab === t.key ? ' aria-current="page"' : '') + '>' + icon(t.ic) + '<span>' + t.label + '</span>' + badge(t.key) + '</a></li>';
        }).join('') +
      '</ul></nav>' +
      '<div class="side-foot"><div><div class="who">' + esc(me.name) + '</div><div class="muted">' + esc(MS.DATA.business) + '</div></div>' +
        '<div>' + UI.tag(me.role, 'lila') + '</div>' +
        '<a class="row" style="text-decoration:none;color:inherit" href="#/telegram">' + icon('message-circle', 'ic-sm') + '<span>Telegram: ' + (tg ? 'conectado' : 'sin conectar') + '</span></a>' +
      '</div></aside>';

    var top = '<header class="topbar" id="topbar">' +
      (v.back ? '<a class="btn btn-ghost back" href="' + v.back + '">' + icon('chevron-left') + '<span>' + esc(v.backLabel || 'Volver') + '</span></a><span class="grow"></span>'
              : '<a class="brand hide-desk" href="#/inicio"><span class="brand-mark" aria-hidden="true"></span>MainSpot</a><span class="grow"></span>') +
      '<a class="icon-btn hide-desk" href="#/negocio" aria-label="Mi negocio"' + (v.tab === 'negocio' ? ' aria-current="page"' : '') + '>' + icon('store') + '</a>' +
      '<a class="icon-btn" href="#/avisos" aria-label="Avisos' + (unread ? ', ' + unread + ' sin leer' : '') + '">' + icon('bell') + (unread ? '<span class="badge-count" aria-hidden="true">' + unread + '</span>' : '') + '</a>' +
      '</header>';

    var banners = '';
    if (S.trial === 'expired') banners += '<div class="banner banner-ink" style="margin-bottom:16px">' + icon('lock') + '<span><strong>Tu plan no está activo</strong>Puedes ver tu información, pero para hacer cambios contacta a MainSpot. Tus datos no se borran.<br>' + UI.btn('Contactar a MainSpot', { action: 'contact', sm: true, style: 'secondary' }) + '</span></div>';
    if (S.loadError && v.tab === 'inicio') banners += '<div class="banner banner-alerta" style="margin-bottom:16px" role="alert">' + icon('triangle-alert') + '<span><strong>No pudimos cargar toda tu información</strong>' + esc(S.loadError) + '<br>' + UI.btn('Intentar de nuevo', { action: 'dash-retry', sm: true, style: 'secondary', icon: 'refresh-cw' }) + '</span></div>';

    var nav = '<nav class="bottomnav" aria-label="Principal"><ul>' + TABS.map(function (t) {
      return '<li><a href="' + t.href + '"' + (v.tab === t.key ? ' aria-current="page"' : '') + '>' + icon(t.ic) + '<span>' + t.label + '</span>' + badge(t.key) + '</a></li>';
    }).join('') + '</ul></nav>';

    // Chat de Telegram SIMULADO en la columna derecha (≥1280 px), solo si el entorno lo ofrece.
    var wide = window.matchMedia && window.matchMedia('(min-width: 1280px)').matches && S.dev.telegram;
    var aside = wide ? '<aside class="aside" aria-label="Tu chat de Telegram (simulado)"><div class="aside-title">' + icon('message-circle', 'ic-sm') + 'Tu Telegram (simulado)</div>' + UI.tg('aside') + '</aside>' : '';

    return '<a class="skip-link" href="#main">Saltar al contenido</a><div class="app">' + side +
      '<div class="app-col' + (wide ? ' with-aside' : '') + '"><div>' + top + '<main class="main" id="main" data-screen="' + (v.screen || '') + '">' + banners + v.html + '</main></div>' + aside + '</div>' +
      nav + '</div>';
  };

  function head(title, sub, extra) {
    return '<div class="page-head"><h1 tabindex="-1" data-focus>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + (extra || '') + '</div>';
  }

  /** Acciones de la franja de estado de la página (Inicio y Mi página). */
  function bandActions(st, live) {
    if (st.create) return UI.btn('Crear mi página', { href: '#/pagina/crear', icon: 'plus' });
    if (st.retry && MS.can('approve')) return UI.btn('Intentar publicar de nuevo', { action: 'approve-ask', arg: st.retry, icon: 'refresh-cw' });
    if (st.first) return UI.btn(MS.can('approve') ? 'Revisar mi primera página' : 'Ver vista previa', { href: '#/vista-previa/' + st.first.id });
    if (st.prepare) return UI.btn('Preparar mi primera página', { action: 'first-page', id: 'first-page-btn' });
    if (live) return UI.btn('Ver mi página', { href: '#/sitio', style: 'secondary', icon: 'external-link' });
    return '';
  }

  /* ---------- DS-05 · Inicio ---------- */
  V.home = function () {
    var S = MS.S, me = MS.me();
    if (S.loading) {
      return { tab: 'inicio', screen: 'DS-05', title: 'Inicio', html: '<div aria-busy="true" aria-label="Cargando tu información" style="padding-top:16px"><div class="skeleton" style="height:22px;width:40%"></div><div class="skeleton" style="height:44px;width:80%;margin-top:10px"></div><div class="skeleton" style="height:150px;margin-top:24px;border-radius:20px"></div><div class="skeleton" style="height:120px;margin-top:16px;border-radius:20px"></div><span class="sr-only" role="status">Cargando tu información</span></div>' };
    }

    var html = '<div class="hello"><div class="who">' + esc(MS.DATA.business) + '</div><h1 tabindex="-1" data-focus>Hola, ' + esc(me.short) + '</h1></div>';
    if (S.role !== 'administration') {
      html += '<div class="banner banner-lila" style="margin-bottom:16px">' + icon('info') + '<span><strong>Tu perfil: ' + esc(me.role) + '</strong>' + esc(me.desc) + '</span></div>';
    }
    html += '<div class="stack">';

    // Estado de la página
    var st = UI.siteState(), live = !!S.site.published;
    html += '<section class="siteband" aria-labelledby="band-t"><span class="spot spot-' + st.spot + '" aria-hidden="true">' + icon(st.ic) + '</span><div><h2 id="band-t">' + esc(st.title) + '</h2>' +
      (st.addr ? '<p class="addr">' + esc(st.addr) + '</p>' : '') + (st.body ? '<p class="muted small" style="margin-top:6px">' + esc(st.body) + '</p>' : '') + '</div>';
    var acts = bandActions(st, live);
    html += (acts ? '<div class="actions">' + acts + '</div>' : '') + '</section>';

    // Lo que hizo MainSpot por ti (agente de atención)
    if (MS.can('engagement.read')) {
      html += '<section class="card stack" aria-labelledby="ag-t"><div class="section-title" style="margin:0"><h2 id="ag-t">Tus clientes</h2><a class="small" href="#/atencion">Ver todo</a></div>' + UI.watchLine() + UI.agentSummary() + '</section>';
      var allNeed = MS.agent.needs(), needCases = allNeed.slice(0, 2);
      needCases.forEach(function (c, i) {
        var src = MS.agent.SRC[c.source];
        html += '<section class="decide" aria-label="Un cliente necesita tu decisión"><div class="kicker">' + icon('messages-square', 'ic-sm') + (c.status === 'failed' ? 'No se pudo responder' : 'Un cliente necesita tu decisión') + '</div><h3>' + esc(src.label) + ' de ' + esc(c.author) + ' ' + UI.stars(c.rating) + '</h3><p>«' + esc(c.text) + '»</p>' +
          UI.btn(c.status === 'failed' ? 'Ver qué pasó' : 'Elegir respuesta', { href: '#/caso/' + c.id, style: i === 0 && !MS.waitingApproval().length ? 'primary' : 'secondary' }) + '</section>';
      });
      if (allNeed.length > 2) html += '<a class="btn btn-secondary btn-block" href="#/atencion?estado=decidir">Ver los ' + allNeed.length + ' que necesitan tu decisión</a>';
    }

    // Te toca decidir (cambios a la página)
    var ready = MS.webRequests().filter(function (r) { return r.kind !== 'first' && (r.status === 'preview_ready' || r.status === 'expired' || r.status === 'awaiting_confirm' || r.status === 'awaiting_decision'); });
    ready.forEach(function (r, i) {
      if (r.status === 'preview_ready') {
        if (MS.can('approve')) {
          html += '<section class="decide" aria-label="Te toca decidir"><div class="kicker">' + icon('eye', 'ic-sm') + 'Te toca decidir</div><h3>' + esc(r.title) + '</h3><p>' + esc(UI.changeLine(r)) + '</p>' +
            UI.btn('Revisar y decidir', { href: '#/vista-previa/' + r.id, style: i === 0 ? 'primary' : 'secondary' }) + '</section>';
        } else {
          html += '<section class="decide" aria-label="Esperando aprobación"><div class="kicker">' + icon('hourglass', 'ic-sm') + 'Esperando aprobación</div><h3>' + esc(r.title) + '</h3><p>Quien administra tu negocio lo revisará.</p>' +
            UI.btn('Ver vista previa', { href: '#/vista-previa/' + r.id, style: 'secondary' }) + '</section>';
        }
      } else if (r.status === 'expired') {
        html += '<section class="decide" aria-label="Vista previa vencida"><div class="kicker">' + icon('clock', 'ic-sm') + 'La vista previa venció</div><h3>' + esc(r.title) + '</h3><p>No se publicó nada. Si todavía quieres este cambio, pídelo de nuevo.</p>' +
          (MS.can('request') && r.text && !MS.expired() ? UI.btn('Pedirlo de nuevo', { action: 'renew', arg: r.id, style: 'secondary' }) : '') + '</section>';
      } else if (r.status === 'awaiting_confirm' && MS.can('confirm') && !MS.expired()) {
        html += '<section class="decide" aria-label="Falta confirmar"><div class="kicker">' + icon('message-square-text', 'ic-sm') + 'Falta confirmar</div><h3>' + esc(r.title) + '</h3><p>' + esc(UI.changeLine(r)) + '</p>' +
          UI.btn('Continuar', { href: '#/cambios/nuevo', style: 'secondary' }) + '</section>';
      } else if (r.status === 'awaiting_decision') {
        html += '<section class="decide" aria-label="Decisión sensible"><div class="kicker">' + icon('shield-check', 'ic-sm') + 'Decisión sensible</div><h3>' + esc(r.title) + '</h3><p>' + esc(r.summary) + '</p>' +
          UI.btn('Ver la solicitud', { href: '#/cambios/' + r.id, style: 'secondary' }) + '</section>';
      }
    });

    // ¿Qué quieres cambiar?
    if (MS.can('request') && S.website) {
      if (MS.expired()) {
        html += '<section class="composer is-locked" aria-labelledby="ask-t"><h2 id="ask-t">¿Qué quieres cambiar en tu página?</h2><p class="lead">Tu plan no está activo, así que por ahora no puedes pedir cambios. Tu información sigue aquí.</p><div class="send-row" style="justify-content:flex-start">' + UI.btn('Contactar a MainSpot', { action: 'contact', style: 'secondary' }) + '</div></section>';
      } else {
        var hasDecision = MS.waitingApproval().length && MS.can('approve');
        html += '<section class="composer" aria-labelledby="ask-t"><h2 id="ask-t">¿Qué quieres cambiar en tu página?</h2><p class="lead">Escríbelo con tus palabras. Te enseñamos cómo queda antes de publicar.</p>' +
          '<form data-form="ask"><label class="sr-only" for="home-ask">Describe el cambio</label><textarea class="textarea" id="home-ask" name="ask" placeholder="Por ejemplo: el horario es de 9:00 a 18:00"></textarea>' +
          '<div class="chips" aria-label="Ejemplos">' + ['El horario es de 9:00 a 18:00', 'Agrega un servicio llamado Pasteles por encargo', '¿Cuál es mi horario?'].map(function (c) { return '<button type="button" class="chip" data-action="ask-chip" data-arg="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
          '<div class="send-row">' + (hasDecision ? '<button type="submit" class="btn" style="background:#fff;color:var(--ink)">' + icon('send') + '<span>Enviar</span></button>' : UI.btn('Enviar', { type: 'submit', icon: 'send' })) + '</div></form></section>';
      }
    }

    // Próximos pasos
    var first = S.site.initial;
    var stepsList = [
      { t: 'Activa tu cuenta', done: true },
      { t: 'Crea tu página con los datos de tu negocio', done: !!S.website, href: '#/pagina/crear', cta: 'Crear' },
      { t: 'Revisa y aprueba tu primera página', done: !!S.site.published || !!(first && (first.status === 'approved' || first.status === 'published')), href: first ? '#/vista-previa/' + first.id : '#/pagina', cta: 'Revisar' },
      { t: 'Tu página llega a internet', done: !!S.site.published, href: '#/pagina', cta: 'Ver' },
      { t: 'Conecta tu Telegram', done: S.telegram.status === 'linked', href: '#/telegram', cta: 'Conectar' },
      { t: 'Crea tu ficha de Google', done: S.prov.google.connected, href: '#/google', cta: 'Crear' },
      { t: 'Elige qué puede responder MainSpot por ti', done: S.agent.version > 0, href: '#/atencion/reglas', cta: 'Elegir' }
    ];
    var doneCount = stepsList.filter(function (s) { return s.done; }).length;
    if (doneCount < stepsList.length && S.role === 'administration') {
      html += '<section class="card" aria-labelledby="steps-t"><div class="section-title"><h2 id="steps-t">Para dejar todo listo</h2><span class="muted small">' + doneCount + ' de ' + stepsList.length + '</span></div><ul class="checklist">' +
        stepsList.map(function (s) { return '<li class="' + (s.done ? 'done' : '') + '"><span class="tick" aria-hidden="true">' + (s.done ? icon('check') : '') + '</span><span class="txt">' + esc(s.t) + '<span class="sr-only">' + (s.done ? ' (hecho)' : ' (pendiente)') + '</span></span>' + (!s.done && s.href ? '<a class="btn btn-sm btn-secondary" href="' + s.href + '">' + esc(s.cta) + '</a>' : '') + '</li>'; }).join('') +
        '</ul></section>';
    }

    // Tus canales: estado y número que ve cada uno
    var tg = S.telegram.status === 'linked';
    function chRow(href, ic, title, sub, tag) {
      return '<li><a class="list-row" href="' + href + '"><span class="lead">' + icon(ic) + '</span><span class="grow"><span class="title" style="display:block">' + title + '</span><span class="sub" style="display:block">' + sub + '</span><span style="display:block;margin-top:6px">' + tag + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>';
    }
    function phSub(ch) { var e = MS.ph.effective(ch); return 'Teléfono: ' + esc(e ? e.intl : 'sin número') + (S.phones[ch].mode === 'other' ? ' (otro número)' : ''); }
    html += '<section aria-labelledby="ch-t"><div class="section-title"><h2 id="ch-t">Tus canales</h2></div><div class="card card-flush"><ul class="list">' +
      chRow('#/pagina', 'globe', 'Página web', phSub('website'), S.site.published ? UI.tag('En internet (desarrollo)', 'nopal') : UI.tag(S.website ? 'Sin publicar' : 'Sin crear', 'neutral')) +
      chRow('#/google', 'map-pin', 'Google Maps', phSub('google'), S.prov.google.connected ? UI.tag('Ficha creada (simulado)', 'nopal') : UI.tag('Sin ficha', 'neutral')) +
      chRow('#/facebook', 'megaphone', 'Facebook', phSub('facebook'), UI.tag(S.prov.facebook.mode === 'not_verified' ? 'Conexión real no verificada' : 'Simulado, sin conexión real', 'lila')) +
      chRow('#/telegram', 'message-circle', 'Telegram', tg ? 'Avisos de casos: ' + esc(S.telegram.chatName) : 'Para avisos de casos', tg ? UI.tag('Conectado', 'nopal') : UI.tag('Sin conectar', 'neutral')) +
      chRow('#/negocio/plan', 'calendar', 'Plan', esc(MS.trialText()), S.trial === 'expired' ? UI.tag('No activo', 'alerta') : UI.tag('Activo', 'nopal')) +
      '</ul></div></section>';

    // Actividad reciente
    var ev = [];
    MS.webRequests().forEach(function (r) { (r.events || []).forEach(function (e) { ev.push({ at: e.at, text: MS.evText(e), who: e.who, r: r }); }); });
    ev.sort(function (a, b) { return b.at - a.at; });
    html += '<section aria-labelledby="act-t"><div class="section-title"><h2 id="act-t">Actividad reciente</h2>' + (ev.length ? '<a class="small" href="#/cambios/historial">Ver historial</a>' : '') + '</div>';
    if (!ev.length) html += '<p class="muted card">Aquí verás quién pidió, aprobó y publicó cada cambio.</p>';
    else html += '<div class="card card-flush"><ul class="list">' + ev.slice(0, 4).map(function (e) {
      return '<li><a class="list-row" href="#/cambios/' + e.r.id + '"><span class="lead">' + icon(e.who === 'MainSpot' ? 'shield-check' : 'user') + '</span><span class="grow"><span class="title" style="display:block;font-weight:400">' + esc(e.text) + '</span><span class="sub">' + esc(e.who === MS.me().name ? e.who + ' (tú)' : e.who) + ', ' + esc(MS.when(e.at)) + '</span></span></a></li>';
    }).join('') + '</ul></div>';
    html += '</section></div>';
    return { tab: 'inicio', screen: 'DS-05', title: 'Inicio', html: html };
  };

  /* ---------- DS-06 · Mi negocio ---------- */
  V.biz = function () {
    var S = MS.S, me = MS.me();
    var d = MS.siteBase();
    var html = head('Mi negocio', MS.DATA.business) + '<div class="stack-lg">' +
      MS.ph.primaryCard() + MS.ph.overview() +
      '<section aria-labelledby="data-t"><div class="section-title"><h2 id="data-t">Lo que muestra tu página</h2></div>' +
        (S.website ? UI.facts([
          ['message-square-text', 'Frase', esc(d.line || 'Sin frase')],
          ['map-pin', 'Dirección', esc(d.address || 'Sin dirección')],
          ['clock', 'Horario', UI.hours(d)],
          ['store', 'Lo que vendes', esc((d.services || []).join(', ') || 'Sin datos')]
        ]) : '<p class="card muted">Todavía no tienes página. ' + (MS.can('website.provision') ? '<a href="#/pagina/crear">Créala con los datos de tu negocio</a>.' : '') + '</p>') +
        (S.website && MS.can('request') && !MS.expired() ? '<div style="margin-top:12px">' + UI.btn('Pedir un cambio en estos datos', { href: '#/cambios/nuevo', style: 'secondary', icon: 'pencil' }) + '<p class="tiny" style="margin-top:8px">Todo lo que se ve en tu página pasa por una vista previa y la aprobación de Administración.</p></div>' : '') +
      '</section>' +
      '<section class="card card-flush" aria-label="Más opciones"><ul class="list">' +
        '<li><a class="list-row" href="#/negocio/plan"><span class="lead">' + icon('calendar') + '</span><span class="grow"><span class="title" style="display:block">Mi plan</span><span class="sub">' + esc(MS.trialText()) + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
        '<li><a class="list-row" href="#/telegram"><span class="lead">' + icon('message-circle') + '</span><span class="grow"><span class="title" style="display:block">Telegram</span><span class="sub">' + (S.telegram.status === 'linked' ? 'Conectado: ' + esc(S.telegram.chatName) : 'Sin conectar') + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
        '<li><a class="list-row" href="#/cambios/historial"><span class="lead">' + icon('history') + '</span><span class="grow"><span class="title" style="display:block">Historial de cambios</span><span class="sub">Quién pidió, aprobó y publicó cada cambio</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
      '</ul></section>' + teamCard() +
      '<section class="card" aria-labelledby="acc-t"><h2 id="acc-t" style="font-size:var(--fs-lg)">Tu acceso</h2><p style="margin-top:8px"><strong>' + esc(me.name) + '</strong></p>' +
        '<div style="margin-top:10px">' + UI.tag(me.role, 'lila') + '</div><p class="muted small" style="margin-top:8px">' + esc(me.desc) + '</p>' +
        '<div style="margin-top:16px">' + UI.btn('Cerrar sesión', { action: 'logout', style: 'secondary', icon: 'log-out' }) + '</div></section>' +
      '</div>';
    return { tab: 'negocio', screen: 'DS-06', title: 'Mi negocio', html: html };
  };

  /** Tu equipo (solo Administración, user.manage): Operación pide y prepara; Solo lectura consulta. */
  function teamCard() {
    if (!MS.can('user.manage')) return '';
    var team = MS.S.team || [];
    return '<section class="card stack" aria-labelledby="team-t" id="team"><h2 id="team-t" style="font-size:var(--fs-lg)">Tu equipo</h2>' +
      '<p class="muted small">Cada persona entra con su correo y su contraseña. Operación pide cambios y prepara vistas previas; Solo lectura consulta. Solo Administración aprueba y publica.</p>' +
      (team.length ? '<ul class="list" id="team-list">' + team.map(function (u) {
        return '<li class="list-row static" style="padding-left:0">' + icon('user') + '<span class="grow">' + esc(u.display_name) + (u.user_id === MS.S.me.user_id ? ' (tú)' : '') + '</span>' + UI.tag(u.status === 'active' ? 'Activa' : u.status, u.status === 'active' ? 'nopal' : 'neutral') + '</li>';
      }).join('') + '</ul>' : '') +
      '<form class="stack" data-form="team-add" novalidate>' +
        '<div class="banner banner-alerta" id="team-error" role="alert" hidden>' + icon('circle-alert') + '<span id="team-error-text"></span></div>' +
        MS.field('t-name', 'Nombre', '', 'text', 'off') + MS.field('t-email', 'Correo para entrar', '', 'email', 'off') +
        '<div class="field" id="f-t-pass"><label for="t-pass">Contraseña inicial</label><span class="hint">Al menos 8 caracteres. Compártela por un canal privado.</span><input class="input" id="t-pass" type="password" autocomplete="new-password"></div>' +
        '<div class="field"><label for="t-role">Perfil</label><select class="select" id="t-role"><option value="operation">Operación</option><option value="read_only">Solo lectura</option><option value="administration">Administración</option></select></div>' +
        '<div class="btn-row">' + UI.btn('Agregar persona', { type: 'submit', id: 'team-submit', style: 'secondary', icon: 'plus' }) + '</div>' +
      '</form></section>';
  }

  var CAP_LABELS = { website: 'Páginas web', social_posts: 'Publicaciones en Facebook', social_ads: 'Anuncios', reviews_managed: 'Reseñas atendidas', agents: 'Usuarios del panel', conversations: 'Mensajes al asistente' };
  V.plan = function () {
    var S = MS.S, p = S.plan;
    var html = head('Mi plan') + '<div class="stack">';
    if (!p) {
      html += '<section class="card stack"><div class="banner banner-alerta">' + icon('lock') + '<span><strong>Tu negocio no tiene un plan activo</strong>Puedes ver tu información; para hacer cambios contacta a MainSpot.</span></div>' + UI.btn('Contactar a MainSpot', { action: 'contact' }) + '</section>';
    } else {
      var active = S.trial !== 'expired';
      html += '<section class="card stack"><div class="row"><h2 class="grow">' + esc(p.name) + '</h2>' + UI.tag(active ? 'Activo' : 'No activo', active ? 'nopal' : 'alerta') + '</div>' +
        (p.description ? '<p class="muted">' + esc(p.description) + '</p>' : '') +
        (active ? '<p>Con tu plan puedes pedir cambios, revisarlos y publicar tu página.</p>' : '<div class="banner banner-alerta">' + icon('lock') + '<span><strong>Tu plan no está activo</strong>Puedes ver tu información, pero para hacer cambios contacta a MainSpot.</span></div>' + UI.btn('Contactar a MainSpot', { action: 'contact' })) +
        '</section>';
      var keys = Object.keys(S.limits || {});
      if (keys.length) {
        html += '<section class="card"><h3>Lo que incluye</h3><ul class="list" style="margin-top:8px">' + keys.map(function (k) {
          return '<li class="list-row static" style="padding-left:0">' + icon('check') + '<span class="grow">' + esc(CAP_LABELS[k] || k) + '</span><strong>' + esc(S.limits[k]) + '</strong></li>';
        }).join('') + '</ul>' + UI.note('Sin cobros: el plan piloto no tiene precio aprobado.') + '</section>';
      }
    }
    html += '</div>';
    return { tab: 'negocio', screen: 'DS-06', title: 'Mi plan', html: html, back: '#/negocio', backLabel: 'Mi negocio' };
  };

  /* ---------- DS-07 · Telegram ---------- */
  V.telegram = function (q) {
    var S = MS.S, t = S.telegram;
    var onb = q && q.desde === 'alta';
    var html = '';
    if (!MS.can('telegram.link')) {
      return { tab: 'negocio', screen: 'DS-07', title: 'Telegram', back: '#/negocio', backLabel: 'Mi negocio', html: head('Telegram') + '<div class="banner banner-lila">' + icon('lock') + '<span>Tu perfil no recibe avisos por Telegram.</span></div>' };
    }
    if (t.status === 'linked') {
      html = '<div class="result" data-screen="DS-07"><div class="big-spot spot-live">' + icon('check') + '</div><h1 tabindex="-1" data-focus>Tu Telegram está conectado</h1>' +
        '<p>Te avisaremos en ese chat cuando un cliente necesite tu decisión. Puedes aprobar o descartar desde ahí; verás el mismo resultado en tu panel.</p></div>' +
        UI.facts([['user', 'Chat conectado', esc(t.chatName)], ['clock', 'Desde', esc(MS.when(t.linkedAt))]]) +
        (S.dev.telegram ? UI.note('Telegram simulado en desarrollo: no hay conexión real con Telegram.') : '') +
        '<div class="btn-row" style="margin-top:24px">' + (onb ? UI.btn('Ir a mi panel', { action: 'onb-finish' }) : '') + (S.dev.telegram ? UI.btn('Abrir el chat', { href: '#/chat', style: onb ? 'secondary' : 'primary', icon: 'message-circle' }) : '') + UI.btn('Desconectar', { action: 'tg-unlink', style: 'danger', icon: 'unlink' }) + '</div>';
    } else if (t.status === 'code' && t.code) {
      var cs = t.codeState, dead = cs !== 'active';
      var msg = { expired: ['Este código caducó', 'Genera uno nuevo para conectar tu Telegram.'], revoked: ['Anulaste este código', 'Ya no funciona. Genera uno nuevo cuando quieras conectar.'] }[cs] || ['Este código ya no sirve', 'Genera uno nuevo.'];
      html = head('Conecta tu Telegram', dead ? '' : 'Sigue estos pasos en tu celular.');
      html += '<div class="code-box' + (dead ? ' is-dead' : '') + '"><div class="small muted">Tu código de conexión</div><div class="code" id="tg-code" aria-label="Código ' + esc(t.code.split('').join(' ')) + '">' + esc(MS.tg.fmt(t.code)) + '</div>' +
        (dead ? '<div class="timer">' + icon('circle-x', 'ic-sm') + 'Ya no funciona</div>' : '<div class="timer">' + icon('clock', 'ic-sm') + 'Vence en <span data-countdown="' + t.codeExpiresAt + '" data-on-zero="tg-expire">' + countdown(t.codeExpiresAt) + '</span></div>') + '</div>';
      if (dead) {
        html += '<div class="banner banner-alerta" style="margin-top:16px" role="alert">' + icon('circle-alert') + '<span><strong>' + esc(msg[0]) + '</strong>' + esc(msg[1]) + '</span></div>' +
          '<div class="btn-row" style="margin-top:24px">' + UI.btn('Generar un código nuevo', { action: 'tg-generate', icon: 'refresh-cw' }) + '</div>';
      } else {
        html += '<ol class="hub-journey" style="margin-top:20px" aria-label="Pasos">' +
            '<li><div><div class="t">' + (S.dev.telegram ? 'Toca «Abrir Telegram»' : 'Abre el bot de MainSpot en Telegram') + '</div><div class="d">' + (S.dev.telegram ? 'Se abrirá el chat simulado de MainSpot.' : 'Envía: /start ' + esc(t.code)) + '</div></div></li>' +
            '<li><div><div class="t">Toca «Iniciar» en el chat</div><div class="d">Si no aparece, escribe /start y el código de arriba.</div></div></li>' +
            '<li><div><div class="t">Listo</div><div class="d">Aquí verás que tu Telegram quedó conectado.</div></div></li>' +
          '</ol>' +
          (t.mode === 'simulated' ? UI.note('Telegram simulado en desarrollo: no hay conexión real con Telegram.') : '') +
          '<div class="btn-row" style="margin-top:24px">' + (S.dev.telegram ? UI.btn('Abrir Telegram', { href: '#/chat?inicio=' + encodeURIComponent(t.code), icon: 'external-link' }) : '') + UI.btn('Anular este código', { action: 'tg-revoke', style: 'ghost' }) + '</div>';
      }
    } else {
      html = head('Telegram', 'Recibe en tu celular los casos que necesitan tu decisión.') +
        '<div class="card stack">' +
          '<ul class="list">' +
            '<li class="list-row static" style="padding-left:0">' + icon('shield-check') + '<span>Usas el chat oficial de MainSpot. No tienes que crear nada.</span></li>' +
            '<li class="list-row static" style="padding-left:0">' + icon('eye') + '<span>Antes de publicar una respuesta, siempre te pedimos tu aprobación.</span></li>' +
            '<li class="list-row static" style="padding-left:0">' + icon('phone') + '<span>Tu chat de avisos no es el teléfono público de tu negocio.</span></li>' +
            '<li class="list-row static" style="padding-left:0">' + icon('unlink') + '<span>Puedes desconectarlo cuando quieras.</span></li>' +
          '</ul>' +
        '</div>' +
        '<div class="btn-row" style="margin-top:24px">' + UI.btn('Conectar Telegram', { action: 'tg-generate' }) + (onb ? UI.btn('Lo haré después', { action: 'onb-finish', style: 'secondary' }) : '') + '</div>';
    }
    return { tab: 'negocio', screen: 'DS-07', title: 'Telegram', html: html, back: onb ? null : '#/negocio', backLabel: 'Mi negocio' };
  };
  function countdown(ts) {
    var s = Math.max(0, Math.round((ts - Date.now()) / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  MS.countdown = countdown;

  /* Chat de Telegram a pantalla completa (simulado, desarrollo) */
  V.chat = function (q) {
    if (q && q.inicio) MS.mem.tgStart = q.inicio;
    var html = '<div class="tg-screen" data-screen="DS-07"><div class="tg-phone" role="dialog" aria-modal="true" aria-label="Chat de Telegram simulado">' + UI.tg('full', { back: true }) + '</div></div>';
    return { title: 'Telegram (simulado)', html: html, shell: false, chat: true };
  };

  /* ---------- DS-08 · Cambios ---------- */
  var PENDING = ['awaiting_confirm', 'preparing', 'preview_ready', 'expired', 'approved', 'failed', 'awaiting_decision'];
  V.changes = function (tab) {
    var hist = tab === 'historial';
    var all = MS.webRequests();
    var list = all.filter(function (r) { return hist ? true : PENDING.indexOf(r.status) >= 0; });
    var nPend = all.filter(function (r) { return PENDING.indexOf(r.status) >= 0; }).length;
    var html = head('Cambios', 'Pide cambios y decide qué se publica.');
    var canAsk = MS.can('request') && !MS.expired() && !!MS.S.website;
    html += '<div class="row" style="justify-content:space-between;flex-wrap:wrap;margin-bottom:16px">' +
      '<div class="segmented" role="tablist" aria-label="Ver"><button role="tab" aria-selected="' + !hist + '" data-action="go" data-arg="#/cambios">Pendientes' + (nPend ? ' (' + nPend + ')' : '') + '</button><button role="tab" aria-selected="' + hist + '" data-action="go" data-arg="#/cambios/historial">Historial</button></div>' +
      (canAsk ? UI.btn('Pedir un cambio', { href: '#/cambios/nuevo', icon: 'plus', style: nPend ? 'secondary' : 'primary' }) : '') + '</div>';
    if (!list.length) {
      html += hist ? UI.empty('Todavía no hay historial', 'Cuando pidas, apruebes o publiques un cambio, quedará registrado aquí.', '')
                   : UI.empty('No tienes cambios pendientes', 'Cuando pidas un cambio, aquí verás si espera tu decisión.', canAsk ? UI.btn('Pedir un cambio', { href: '#/cambios/nuevo' }) : '');
    } else {
      html += '<div class="card card-flush"><ul class="list">' + list.map(function (r) {
        var last = (r.events || [])[r.events.length - 1];
        return '<li><a class="list-row" href="#/cambios/' + r.id + '"><span class="lead">' + icon(r.channel === 'telegram' ? 'message-circle' : (r.kind === 'first' ? 'globe' : 'message-square-text')) + '</span><span class="grow"><span class="title" style="display:block">' + esc(r.title) + '</span><span class="sub">' + (r.kind === 'first' ? 'Preparada por MainSpot' : 'Pedido por ' + esc(r.by) + ' en ' + UI.channelName(r.channel)) + ', ' + esc(MS.when(last ? last.at : r.createdAt)) + '</span><span style="display:block;margin-top:6px">' + UI.statusTag(r) + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>';
      }).join('') + '</ul></div>';
    }
    return { tab: 'pagina', screen: 'DS-08', title: 'Cambios', html: html };
  };

  V.ask = function () {
    var S = MS.S;
    var canAsk = MS.can('request') && !MS.expired();
    var html = head('Pedir un cambio', 'Escríbelo como se lo dirías a alguien de confianza.');
    if (!S.website) {
      html += '<div class="banner banner-ocre">' + icon('info') + '<span><strong>Primero crea tu página</strong>Con los datos de tu negocio preparamos tu primera versión; después podrás pedir cambios.<br>' + (MS.can('website.provision') ? UI.btn('Crear mi página', { href: '#/pagina/crear', sm: true, style: 'secondary' }) : '') + '</span></div>';
    }
    html += UI.convo('panel');
    if (canAsk) {
      html += '<form class="convo-input" data-form="panel-send"><label class="sr-only" for="panel-input">Escribe tu mensaje</label><textarea class="textarea" id="panel-input" name="msg" rows="1" maxlength="2000" placeholder="Escribe aquí lo que quieres cambiar"></textarea><button class="icon-btn" type="submit" aria-label="Enviar" id="panel-send">' + icon('arrow-up') + '</button></form>';
    } else {
      html += '<div class="banner ' + (MS.expired() ? 'banner-alerta' : 'banner-lila') + '" style="margin-top:16px">' + icon('lock') + '<span>' + (MS.expired() ? 'Tu plan no está activo. Para pedir cambios, contacta a MainSpot.' : 'Tu perfil puede ver los cambios, pero no pedirlos. Pídele ayuda a quien administra tu negocio.') + '</span></div>';
    }
    return { tab: 'pagina', screen: 'DS-08', title: 'Pedir un cambio', html: html, back: '#/cambios', backLabel: 'Cambios', convo: 'panel' };
  };

  V.changeDetail = function (id) {
    var r = MS.req(id);
    if (!r) return { tab: 'pagina', screen: 'DS-08', title: 'Cambio', html: UI.empty('No encontramos ese cambio', 'Puede que el enlace esté incompleto.', UI.btn('Ver mis cambios', { href: '#/cambios' })), back: '#/cambios', backLabel: 'Cambios' };
    var html = '<div class="page-head"><div style="margin-bottom:8px">' + UI.statusTag(r) + '</div><h1 tabindex="-1" data-focus>' + esc(r.title) + '</h1><p>' + (r.kind === 'first' ? 'Preparada por MainSpot con los datos de tu negocio.' : 'Pedido por ' + esc(r.by) + ' en ' + UI.channelName(r.channel) + (r.text ? ': «' + esc(r.text) + '»' : '.')) + '</p></div>';
    html += '<div class="stack-lg">';
    if (r.changes.length) html += '<section aria-labelledby="ch-t"><h2 id="ch-t" style="font-size:var(--fs-lg);margin-bottom:10px">El cambio</h2>' + UI.diff(r.changes) + '</section>';
    else if (r.kind === 'sensitive') html += '<section class="card"><p>' + esc(r.summary) + '</p></section>';
    var act = '';
    if (r.status === 'preview_ready') act = UI.btn(MS.can('approve') ? 'Revisar y decidir' : 'Ver vista previa', { href: '#/vista-previa/' + r.id, style: MS.can('approve') ? 'primary' : 'secondary' });
    else if (r.status === 'expired' && MS.can('request') && r.text && !MS.expired()) act = UI.btn('Pedirlo de nuevo', { action: 'renew', arg: r.id });
    else if (r.status === 'awaiting_confirm' && MS.can('confirm') && !MS.expired()) act = UI.btn('Continuar en la conversación', { href: '#/cambios/nuevo', style: 'secondary' });
    else if (r.status === 'approved') act = UI.btn('Ver cómo va la publicación', { href: '#/pagina', style: 'secondary' });
    else if (r.status === 'published') act = UI.btn('Ver mi página', { href: '#/sitio', style: 'secondary', icon: 'external-link' });
    else if (r.status === 'failed' && MS.can('approve')) act = UI.btn('Intentar publicar de nuevo', { action: 'approve-ask', arg: r.id, icon: 'refresh-cw' });
    else if (r.status === 'awaiting_decision' && MS.can('approve')) act = UI.btn('Aprobar', { action: 'approve-ask', arg: r.id }) + ' ' + UI.btn('Descartar', { action: 'reject-ask', arg: r.id, style: 'secondary' });
    else if (r.status === 'preparing') act = '<p class="row muted">' + icon('loader-circle', 'spinner') + 'Estamos preparando la vista previa…</p>';
    if (act) html += '<div class="btn-row">' + act + '</div>';
    html += '<section aria-labelledby="tl-t"><h2 id="tl-t" style="font-size:var(--fs-lg);margin-bottom:10px">Qué ha pasado</h2><ol class="track">' +
      (r.events || []).map(function (e, i, arr) {
        var mine = e.who !== 'MainSpot';
        return '<li class="' + (i === arr.length - 1 ? 'ok' : 'done') + '"><span class="node">' + icon(mine ? 'user' : 'shield-check') + '</span><div><div class="t">' + esc(MS.evText(e)) + '</div><div class="d">' + esc(e.who === MS.me().name ? e.who + ' (tú)' : e.who) + ', ' + esc(MS.when(e.at)) + '</div></div></li>';
      }).join('') + '</ol><p class="tiny" style="margin-top:8px">Quién pidió, aprobó y publicó queda registrado. El asistente propone; las aprobaciones siempre son de una persona.</p></section>';
    html += '</div>';
    return { tab: 'pagina', screen: 'DS-08', title: r.title, html: html, back: '#/cambios', backLabel: 'Cambios' };
  };

  /* ---------- DS-09 · Vista previa (datos de la propuesta real) ---------- */
  V.preview = function (id, q) {
    var r = MS.req(id);
    var back = { back: '#/cambios', backLabel: 'Cambios', tab: 'pagina', screen: 'DS-09' };
    function stateView(spotCls, ic, title, body, actions) {
      return Object.assign({ title: title, html: '<div class="result"><div class="big-spot ' + spotCls + '">' + icon(ic) + '</div><h1 tabindex="-1" data-focus>' + esc(title) + '</h1><p>' + esc(body) + '</p><div class="btn-row" style="justify-content:center;margin-top:24px">' + (actions || '') + '</div></div>' }, back);
    }
    if (!r) return stateView('spot-none', 'link', 'Este enlace de vista previa no funciona', 'Revisa que esté completo o pide uno nuevo desde tu panel.', UI.btn('Ir a mis cambios', { href: '#/cambios' }));
    if (r.status === 'expired') return stateView('spot-none', 'clock', 'Esta vista previa ya no funciona', 'Las vistas previas vencen después de un tiempo. No se publicó nada.', MS.can('request') && r.text && !MS.expired() ? UI.btn('Pedirlo de nuevo', { action: 'renew', arg: r.id }) : UI.btn('Ir a mis cambios', { href: '#/cambios', style: 'secondary' }));
    if (r.status === 'published' || r.status === 'approved') return stateView('spot-live', 'check', 'Esta vista previa ya se usó', (r.approvedBy || 'Alguien') + ' aprobó este cambio ' + MS.when(r.approvedAt) + '. Cada vista previa sirve para una sola decisión.', r.status === 'published' ? UI.btn('Ver mi página', { href: '#/sitio' }) : UI.btn('Ver cómo va', { href: '#/pagina' }));
    if (r.status === 'rejected') return stateView('spot-none', 'x', 'Este cambio se descartó', 'Tu página sigue igual. Si cambias de opinión, puedes pedirlo de nuevo.', MS.can('request') && MS.S.website ? UI.btn('Pedir un cambio', { href: '#/cambios/nuevo', style: 'secondary' }) : '');
    if (r.status === 'preparing') return Object.assign({ title: 'Preparando vista previa', html: '<div class="result" aria-busy="true"><div class="big-spot spot-work">' + icon('hourglass') + '</div><h1 tabindex="-1" data-focus>Estamos preparando la vista previa</h1><p>No cambia nada en tu página.</p></div>' }, back);
    if (r.status === 'awaiting_confirm') return stateView('spot-wait', 'message-square-text', 'Falta confirmar este cambio', 'Confírmalo en la conversación para que preparemos la vista previa.', UI.btn('Continuar', { href: '#/cambios/nuevo' }));

    var first = r.kind === 'first';
    var mode = (q && q.ver === 'antes') ? 'antes' : 'despues';
    var base = MS.siteBase();
    var after = MS.withWebPhone(r.after || base);
    var html = '<div class="page-head"><h1 tabindex="-1" data-focus>' + (first ? 'Así se verá tu página' : 'Así quedaría tu página') + '</h1><p>Nada cambia hasta que ' + (MS.can('approve') ? 'tú lo apruebes.' : 'quien administra tu negocio lo apruebe.') + '</p>' +
      '<p class="tiny inline-meta" style="margin-top:8px">' + icon('clock') + '<span>Esta vista previa sirve para una sola decisión.</span></p></div>';
    html += '<div class="stack-lg">';
    if (r.status === 'failed') {
      html += '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span><strong>' + MS.PUB_TEXT.FAILED.t + '</strong>Tu página no cambió. ' + (MS.can('approve') ? 'Puedes intentarlo de nuevo.' : 'Quien administra tu negocio puede intentarlo de nuevo.') + '</span></div>';
    }
    if (first) {
      html += '<section class="card"><h2 style="font-size:var(--fs-lg)">Tu primera versión</h2><p class="muted" style="margin-top:6px">La armamos con los datos que nos diste. Revisa que tu horario, teléfono y dirección estén bien.</p></section>';
    } else {
      html += '<section aria-labelledby="sum-t"><h2 id="sum-t" style="font-size:var(--fs-lg);margin-bottom:10px">Esto es lo que cambia</h2>' + (r.changes.length ? UI.diff(r.changes) : '<p class="card">' + esc(r.summary) + '</p>') + '</section>';
    }

    // Decisión (el backend exige Administración: operation.approve)
    var canDecide = MS.can('approve') && !MS.expired();
    if (canDecide) {
      html += '<section class="card stack" aria-labelledby="dec-t"><h2 id="dec-t" style="font-size:var(--fs-lg)">¿Qué hacemos?</h2>' +
        '<div class="btn-row" style="margin-top:4px">' + UI.btn(r.status === 'failed' ? 'Intentar publicar de nuevo' : (first ? 'Publicar mi página' : 'Publicar este cambio'), { action: 'approve-ask', arg: r.id, id: 'approve-btn' }) +
        (first || r.kind === 'phone' || r.status === 'failed' ? '' : UI.btn('Pedir otro cambio', { href: '#/cambios/nuevo', style: 'secondary' })) +
        (r.status === 'failed' ? '' : UI.btn('Descartar', { action: 'reject-ask', arg: r.id, style: 'ghost', id: 'reject-btn' })) + '</div>' +
        '<p class="tiny">Al publicar, quedará registrado que tú lo aprobaste.</p></section>';
    } else if (MS.expired()) {
      html += '<div class="banner banner-alerta">' + icon('lock') + '<span><strong>Tu plan no está activo</strong>Puedes ver esta vista previa, pero para publicar cambios contacta a MainSpot.</span></div>';
    } else {
      html += '<div class="banner banner-lila" id="no-approve">' + icon('info') + '<span><strong>Tu perfil no permite aprobar cambios</strong>' + (MS.S.role === 'operation' ? 'Quien administra tu negocio lo revisará y decidirá.' : 'Puedes ver la vista previa. Quien administra tu negocio decide si se publica.') + '</span></div>';
    }

    // Página completa
    var hl = r.changes.filter(function (c) { return c.field !== 'generic'; });
    html += '<section aria-labelledby="full-t"><div class="section-title" style="flex-wrap:wrap"><h2 id="full-t">Tu página completa</h2>' +
      (!first && MS.S.site.published ? '<div class="segmented" role="group" aria-label="Comparar"><button type="button" aria-pressed="' + (mode === 'antes') + '" data-action="go" data-arg="#/vista-previa/' + r.id + '?ver=antes">Antes</button><button type="button" aria-pressed="' + (mode === 'despues') + '" data-action="go" data-arg="#/vista-previa/' + r.id + '">Después</button></div>' : '') + '</div>' +
      UI.browser(mode === 'antes' ? UI.site(base) : UI.site(after, { highlight: hl }), { flag: mode === 'antes' ? 'Así se ve hoy' : 'Vista previa: aún no publicada', label: mode === 'antes' ? 'Tu página como se ve hoy' : 'Vista previa de tu página' }) +
      '</section>';
    html += '</div>';
    return Object.assign({ title: 'Vista previa', html: html }, back);
  };

  /* ---------- DS-10 · Aprobación registrada ---------- */
  V.approved = function (id) {
    var r = MS.req(id);
    if (!r || !r.approvedAt) return V.preview(id);
    var p = MS.S.site.pub;
    var html = '<div class="result"><div class="big-spot spot-live">' + icon('check') + '</div><h1 tabindex="-1" data-focus>' + (r.kind === 'first' ? 'Aprobaste tu página' : 'Aprobaste el cambio') + '</h1>' +
      '<p>Quedó registrado a tu nombre, ' + esc(MS.when(r.approvedAt)) + '. ' + (r.status === 'published' ? 'Ya está en tu página' + (r.version ? ' (versión ' + r.version + ')' : '') + '.' : 'Ahora lo estamos publicando.') + '</p></div>';
    if (p && p.reqId === r.id) html += '<section class="card" aria-label="Avance de la publicación">' + UI.track(p) + UI.note('Publicación de desarrollo: dirección y certificado simulados.') + '</section>';
    html += '<div class="btn-row" style="margin-top:24px;justify-content:center">' + (r.status === 'published' ? UI.btn('Ver mi página', { href: '#/sitio', icon: 'external-link' }) : UI.btn('Ver cómo va', { href: '#/pagina' })) + UI.btn('Volver al inicio', { href: '#/inicio', style: 'secondary' }) + '</div>';
    return { tab: 'pagina', screen: 'DS-10', title: 'Aprobaste el cambio', html: html };
  };

  /* ---------- DS-11 · Mi página ---------- */
  V.page = function () {
    var S = MS.S, p = S.site.pub, live = !!S.site.published;
    var st = UI.siteState();
    var html = head('Mi página');
    html += '<div class="stack-lg">';
    html += '<section class="siteband" aria-labelledby="pg-t"><span class="spot spot-' + st.spot + '" aria-hidden="true">' + icon(st.ic) + '</span><div><h2 id="pg-t">' + esc(st.title) + '</h2>' + (live && MS.DATA.address ? '<p class="addr">' + esc(MS.DATA.address) + '</p>' : '') + (st.body ? '<p class="muted small" style="margin-top:6px">' + esc(st.body) + '</p>' : '') + '</div>';
    var acts = bandActions(st, false);
    if (live) acts += UI.btn('Ver mi página', { href: '#/sitio', icon: 'external-link', style: 'primary' }) + (MS.DATA.address ? UI.btn('Copiar dirección', { action: 'copy', arg: MS.DATA.address, style: 'secondary', icon: 'copy' }) : '');
    html += (acts ? '<div class="actions">' + acts + '</div>' : '') + '</section>';
    if (live) html += UI.note('Publicación de desarrollo: la dirección y el certificado son simulados; la página no está en internet de verdad.');

    if (p && (p.state !== 'done' || Date.now() - (p.doneAt || 0) < 60000)) {
      html += '<section class="card" aria-labelledby="tr-t" aria-live="polite"><div class="section-title"><h2 id="tr-t">' + (p.state === 'done' ? 'Publicación terminada' : 'Cómo va la publicación') + '</h2></div>' + UI.track(p);
      if (p.state === 'failed') html += '<div class="banner banner-alerta" style="margin-top:16px" role="alert">' + icon('triangle-alert') + '<span><strong>' + MS.PUB_TEXT.FAILED.t + '</strong>' + (live ? 'Tu página sigue mostrando la versión anterior.' : 'No marcamos tu página como publicada.') + '</span></div>';
      html += '</section>';
    }

    if (S.website) {
      var nPend = MS.webRequests().filter(function (r) { return PENDING.indexOf(r.status) >= 0; }).length;
      html += '<section class="card card-flush" aria-label="Cambios a tu página"><ul class="list">' +
        (MS.can('request') && !MS.expired() ? '<li><a class="list-row" href="#/cambios/nuevo"><span class="lead">' + icon('pencil') + '</span><span class="grow"><span class="title" style="display:block">Pedir un cambio</span><span class="sub" style="display:block">Escríbelo con tus palabras</span></span>' + icon('chevron-right', 'chev') + '</a></li>' : '') +
        '<li><a class="list-row" href="#/cambios"><span class="lead">' + icon('message-square-text') + '</span><span class="grow"><span class="title" style="display:block">Cambios pendientes</span><span class="sub" style="display:block">' + (nPend ? nPend + (nPend === 1 ? ' cambio en camino' : ' cambios en camino') : 'Nada pendiente') + '</span></span>' + (nPend ? '<span class="badge-inline">' + nPend + '</span>' : '') + icon('chevron-right', 'chev') + '</a></li>' +
        '<li><a class="list-row" href="#/cambios/historial"><span class="lead">' + icon('history') + '</span><span class="grow"><span class="title" style="display:block">Historial</span><span class="sub" style="display:block">Quién pidió, aprobó y publicó cada cambio</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
        '</ul></section>';
    }
    html += MS.ph.card('website');

    // Versiones (website_content real)
    html += '<section aria-labelledby="ver-t"><div class="section-title"><h2 id="ver-t">Versiones publicadas</h2></div>';
    if (!S.site.versions.length) html += '<p class="card muted">Cuando publiques tu página, aquí guardaremos cada versión.</p>';
    else html += '<div class="card card-flush"><ul class="list" id="versions">' + S.site.versions.map(function (v, i) {
      var cur = i === 0;
      return '<li><div class="list-row static"><span class="lead">' + icon(cur ? 'globe' : 'history') + '</span><span class="grow"><span class="title" style="display:block">Versión ' + v.n + '</span><span class="sub">' + esc(v.title) + '. Aprobó ' + esc(v.by) + ', ' + esc(MS.when(v.at)) + '</span>' +
        (cur ? '<span style="display:block;margin-top:6px">' + UI.tag('Publicada', 'nopal') + '</span>' : '') + '</span></div></li>';
    }).join('') + '</ul></div>';
    html += '</section></div>';
    return { tab: 'pagina', screen: 'DS-11', title: 'Mi página', html: html };
  };

  V.site = function () {
    var S = MS.S;
    if (!S.site.published) return { tab: 'pagina', screen: 'DS-11', title: 'Mi página', back: '#/pagina', backLabel: 'Mi página', html: UI.empty('Tu página todavía no está publicada', 'Cuando apruebes tu primera versión y termine la publicación, la verás aquí.', UI.btn('Ir a Mi página', { href: '#/pagina' })) };
    var v = S.site.versions[0];
    var html = '<div class="page-head"><h1 tabindex="-1" data-focus>Tu página publicada</h1><p>Así la ven tus clientes' + (v ? '. Versión ' + v.n + ', publicada ' + esc(MS.when(v.at)) : '') + '.</p></div>' + UI.browser(UI.site(S.site.published), { label: 'Tu página publicada' }) + UI.note('Publicación de desarrollo: la página no está realmente en internet.');
    return { tab: 'pagina', screen: 'DS-11', title: 'Tu página', html: html, back: '#/pagina', backLabel: 'Mi página' };
  };

  /* ---------- DS-12 · Avisos ---------- */
  var NK = { approval: ['rosa', 'eye'], live: ['nopal', 'globe'], failed: ['alerta', 'triangle-alert'], tg: ['lila', 'message-circle'], 'case': ['rosa', 'messages-square'], case_failed: ['alerta', 'triangle-alert'] };
  V.notices = function (q) {
    var S = MS.S;
    var onlyUnread = q && q.filtro === 'sin-leer';
    var list = S.notices.filter(function (n) { return !onlyUnread || !n.read; });
    var unread = MS.unread();
    var html = head('Avisos', unread ? 'Tienes ' + unread + (unread === 1 ? ' aviso sin leer.' : ' avisos sin leer.') : 'Estás al día.');
    html += '<div class="row" style="justify-content:space-between;flex-wrap:wrap;margin-bottom:16px"><div class="segmented" role="group" aria-label="Mostrar"><button type="button" aria-pressed="' + !onlyUnread + '" data-action="go" data-arg="#/avisos">Todos</button><button type="button" aria-pressed="' + onlyUnread + '" data-action="go" data-arg="#/avisos?filtro=sin-leer">Sin leer</button></div>' +
      (unread ? '<button type="button" class="link-btn" data-action="notices-read">Marcar todo como leído</button>' : '') + '</div>';
    if (!list.length) html += UI.empty(onlyUnread ? 'No tienes avisos sin leer' : 'No tienes avisos', 'Aquí te avisaremos cuando algo necesite tu atención o cuando tu página cambie.', '');
    else html += '<div class="card card-flush"><ul class="list">' + list.map(function (n) {
      var k = NK[n.kind] || ['lila', 'info'];
      return '<li><button type="button" class="notice' + (n.read ? '' : ' unread') + '" data-action="notice-open" data-arg="' + esc(n.id) + '"><span class="n-ic n-' + k[0] + '" aria-hidden="true">' + icon(k[1]) + '</span><span><span class="n-title" style="display:block">' + esc(n.title) + '</span><span class="n-body" style="display:block">' + esc(n.body) + '</span><span class="n-time">' + esc(MS.when(n.at)) + '</span></span></button></li>';
    }).join('') + '</ul></div>';
    html += '<div class="banner banner-lila" style="margin-top:20px">' + icon('message-circle') + '<span>' + (S.telegram.status === 'linked' ? '<strong>También te avisamos por Telegram</strong>Los casos que necesitan tu decisión llegan a tu chat con MainSpot.' : '<strong>Recibe los casos en tu celular</strong>Conecta tu Telegram y te escribiremos ahí.<br>' + UI.btn('Conectar Telegram', { href: '#/telegram', sm: true, style: 'secondary' })) + '</span></div>';
    return { tab: 'avisos', screen: 'DS-12', title: 'Avisos', html: html, back: '#/inicio', backLabel: 'Inicio' };
  };
})();
