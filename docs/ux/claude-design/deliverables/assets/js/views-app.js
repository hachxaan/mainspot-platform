/* =====================================================================
   MainSpot · Prototipo · Vistas del panel del propietario
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
    { key: 'cambios', href: '#/cambios', label: 'Cambios', ic: 'message-square-text' },
    { key: 'pagina', href: '#/pagina', label: 'Mi página', ic: 'globe' },
    { key: 'negocio', href: '#/negocio', label: 'Mi negocio', ic: 'store' }
  ];

  MS.shell = function (v) {
    var S = MS.S, me = MS.me();
    var pend = MS.S.requests.filter(function (r) { return r.status === 'preview_ready' || r.status === 'awaiting_confirm' || r.status === 'expired'; }).length;
    var unread = MS.unread();
    function badge(key) {
      if (key === 'cambios' && pend) return '<span class="badge-count" aria-label="' + pend + ' pendientes">' + pend + '</span>';
      if (key === 'avisos' && unread) return '<span class="badge-count" aria-label="' + unread + ' sin leer">' + unread + '</span>';
      return '';
    }
    var tg = S.telegram.status === 'linked';
    var side = '<aside class="sidebar" aria-label="Menú">' +
      '<a class="brand" href="#/inicio"><span class="brand-mark" aria-hidden="true"></span>MainSpot</a>' +
      '<nav aria-label="Principal"><ul class="side-nav">' +
        TABS.concat([{ key: 'avisos', href: '#/avisos', label: 'Avisos', ic: 'bell' }]).map(function (t) {
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
      '<a class="icon-btn" href="#/avisos" aria-label="Avisos' + (unread ? ', ' + unread + ' sin leer' : '') + '">' + icon('bell') + (unread ? '<span class="badge-count" aria-hidden="true">' + unread + '</span>' : '') + '</a>' +
      '</header>';

    var banners = '';
    if (S.trial === 'expired') banners += '<div class="banner banner-ink" style="margin-bottom:16px">' + icon('lock') + '<span><strong>Tu prueba terminó</strong>Puedes ver tu información, pero para hacer cambios contacta a MainSpot. Tus datos no se borran.<br>' + UI.btn('Contactar a MainSpot', { action: 'contact', sm: true, style: 'secondary' }) + '</span></div>';
    else if (S.trial === 'ending' && v.tab === 'inicio') banners += '<div class="banner banner-ocre" style="margin-bottom:16px">' + icon('clock') + '<span><strong>Tu prueba gratis vence en 3 días</strong>Después podrás seguir viendo tu información; para seguir haciendo cambios, contacta a MainSpot.<br>' + UI.btn('Ver mi plan', { href: '#/negocio/plan', sm: true, style: 'secondary' }) + '</span></div>';

    var nav = '<nav class="bottomnav" aria-label="Principal"><ul>' + TABS.map(function (t) {
      return '<li><a href="' + t.href + '"' + (v.tab === t.key ? ' aria-current="page"' : '') + '>' + icon(t.ic) + '<span>' + t.label + '</span>' + badge(t.key) + '</a></li>';
    }).join('') + '</ul></nav>';

    var wide = window.matchMedia && window.matchMedia('(min-width: 1280px)').matches;
    var aside = wide ? '<aside class="aside" aria-label="Tu chat de Telegram (simulado)"><div class="aside-title">' + icon('message-circle', 'ic-sm') + 'Tu Telegram</div>' + UI.tg('aside') + '</aside>' : '';

    return '<a class="skip-link" href="#main">Saltar al contenido</a><div class="app">' + side +
      '<div class="app-col' + (wide ? ' with-aside' : '') + '"><div>' + top + '<main class="main" id="main" data-screen="' + (v.screen || '') + '">' + banners + v.html + '</main></div>' + aside + '</div>' +
      nav + '</div>';
  };

  function head(title, sub, extra) {
    return '<div class="page-head"><h1 tabindex="-1" data-focus>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + (extra || '') + '</div>';
  }

  /* ---------- DS-05 · Inicio ---------- */
  V.home = function () {
    var S = MS.S, me = MS.me();
    if (S.demo.dashError) {
      return { tab: 'inicio', screen: 'DS-05', title: 'Inicio', html: '<div style="padding-top:24px">' + '<div class="card center stack"><span class="spot spot-fail" style="margin:0 auto">' + icon('triangle-alert') + '</span><h1 tabindex="-1" data-focus style="font-size:var(--fs-xl)">No pudimos cargar tu información</h1><p class="muted">Revisa tu conexión a internet e inténtalo de nuevo. Tu página y tus datos están bien.</p>' + UI.btn('Intentar de nuevo', { action: 'dash-retry', icon: 'refresh-cw' }) + '</div></div>' };
    }
    if (S.demo.dashLoading) {
      return { tab: 'inicio', screen: 'DS-05', title: 'Inicio', html: '<div aria-busy="true" aria-label="Cargando tu información" style="padding-top:16px"><div class="skeleton" style="height:22px;width:40%"></div><div class="skeleton" style="height:44px;width:80%;margin-top:10px"></div><div class="skeleton" style="height:150px;margin-top:24px;border-radius:20px"></div><div class="skeleton" style="height:120px;margin-top:16px;border-radius:20px"></div><span class="sr-only" role="status">Cargando tu información</span></div>' };
    }

    var html = '<div class="hello"><div class="who">' + esc(MS.DATA.business) + '</div><h1 tabindex="-1" data-focus>Hola, ' + esc(me.short) + '</h1></div>';
    if (S.role !== 'administration') {
      html += '<div class="banner banner-lila" style="margin-bottom:16px">' + icon('info') + '<span><strong>Tu perfil: ' + esc(me.role) + '</strong>' + esc(me.desc) + '</span></div>';
    }
    html += '<div class="stack">';

    // Estado de la página
    var st = UI.siteState();
    html += '<section class="siteband" aria-labelledby="band-t"><span class="spot spot-' + st.spot + '" aria-hidden="true">' + icon(st.ic) + '</span><div><h2 id="band-t">' + esc(st.title) + '</h2>' +
      (st.addr ? '<p class="addr">' + esc(st.addr) + '</p>' : '') + (st.body ? '<p class="muted small" style="margin-top:6px">' + esc(st.body) + '</p>' : '') + '</div>';
    var acts = '';
    if (st.spot === 'live') acts = UI.btn('Ver mi página', { href: '#/sitio', style: 'secondary', icon: 'external-link' });
    else if (st.spot === 'work' || st.spot === 'fail') acts = UI.btn('Ver cómo va', { href: '#/pagina', style: 'secondary' });
    html += (acts ? '<div class="actions">' + acts + '</div>' : '') + '</section>';

    // Te toca decidir
    var ready = S.requests.filter(function (r) { return r.status === 'preview_ready' || r.status === 'expired' || r.status === 'awaiting_confirm'; });
    ready.forEach(function (r, i) {
      if (r.status === 'preview_ready') {
        if (MS.can('approve')) {
          html += '<section class="decide" aria-label="Te toca decidir"><div class="kicker">' + icon('eye', 'ic-sm') + 'Te toca decidir</div><h3>' + esc(r.title) + '</h3><p>' + esc(UI.changeLine(r)) + '</p>' +
            UI.btn(r.kind === 'first' ? 'Revisar mi primera página' : 'Revisar y decidir', { href: '#/vista-previa/' + r.id, style: i === 0 ? 'primary' : 'secondary' }) + '</section>';
        } else {
          html += '<section class="decide" aria-label="Esperando aprobación"><div class="kicker">' + icon('hourglass', 'ic-sm') + 'Esperando aprobación</div><h3>' + esc(r.title) + '</h3><p>Le avisamos a ' + esc(MS.DATA.people.administration.name) + ' para que lo revise.</p>' +
            UI.btn('Ver vista previa', { href: '#/vista-previa/' + r.id, style: 'secondary' }) + '</section>';
        }
      } else if (r.status === 'expired') {
        html += '<section class="decide" aria-label="Vista previa vencida"><div class="kicker">' + icon('clock', 'ic-sm') + 'La vista previa venció</div><h3>' + esc(r.title) + '</h3><p>No se publicó nada. Si todavía quieres este cambio, pide una nueva vista previa.</p>' +
          (MS.can('confirm') && !MS.expired() ? UI.btn('Pedir una nueva vista previa', { action: 'renew', arg: r.id, style: 'secondary' }) : '') + '</section>';
      } else if (r.status === 'awaiting_confirm' && MS.can('confirm') && !MS.expired()) {
        html += '<section class="decide" aria-label="Falta confirmar"><div class="kicker">' + icon('message-square-text', 'ic-sm') + 'Falta confirmar</div><h3>' + esc(r.title) + '</h3><p>' + esc(UI.changeLine(r)) + '</p>' +
          UI.btn('Continuar', { href: r.channel === 'telegram' ? '#/chat' : '#/cambios/nuevo', style: 'secondary' }) + '</section>';
      }
    });

    // ¿Qué quieres cambiar?
    if (MS.can('request')) {
      if (MS.expired()) {
        html += '<section class="composer is-locked" aria-labelledby="ask-t"><h2 id="ask-t">¿Qué quieres cambiar en tu página?</h2><p class="lead">Tu prueba terminó, así que por ahora no puedes pedir cambios. Tu información sigue aquí.</p><div class="send-row" style="justify-content:flex-start">' + UI.btn('Contactar a MainSpot', { action: 'contact', style: 'secondary' }) + '</div></section>';
      } else {
        var hasDecision = S.requests.some(function (r) { return r.status === 'preview_ready'; }) && MS.can('approve');
        html += '<section class="composer" aria-labelledby="ask-t"><h2 id="ask-t">¿Qué quieres cambiar en tu página?</h2><p class="lead">Escríbelo con tus palabras. Te enseñamos cómo queda antes de publicar.</p>' +
          '<form data-form="ask"><label class="sr-only" for="home-ask">Describe el cambio</label><textarea class="textarea" id="home-ask" name="ask" placeholder="Por ejemplo: el sábado abrimos de 8 a 2"></textarea>' +
          '<div class="chips" aria-label="Ejemplos">' + ['El sábado abrimos de 8 a 2', 'Cambia mi teléfono', 'Agrega pan de muerto'].map(function (c) { return '<button type="button" class="chip" data-action="ask-chip" data-arg="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
          '<div class="send-row">' + (hasDecision ? '<button type="submit" class="btn" style="background:#fff;color:var(--ink)">' + icon('send') + '<span>Enviar</span></button>' : UI.btn('Enviar', { type: 'submit', icon: 'send' })) + '</div></form></section>';
      }
    }

    // Próximos pasos
    var firstR = S.requests.filter(function (r) { return r.kind === 'first'; })[0];
    var stepsList = [
      { t: 'Activa tu cuenta', done: true },
      { t: 'Conecta tu Telegram', done: S.telegram.status === 'linked', href: '#/telegram', cta: 'Conectar' },
      { t: 'Revisa y aprueba tu primera página', done: !!(firstR && (firstR.status === 'approved' || firstR.status === 'published')), href: firstR ? '#/vista-previa/' + firstR.id : '#/pagina', cta: 'Revisar' },
      { t: 'Tu página llega a internet', done: !!S.site.published, href: '#/pagina', cta: 'Ver' }
    ];
    var doneCount = stepsList.filter(function (s) { return s.done; }).length;
    if (doneCount < stepsList.length && MS.S.role === 'administration') {
      html += '<section class="card" aria-labelledby="steps-t"><div class="section-title"><h2 id="steps-t">Para dejar todo listo</h2><span class="muted small">' + doneCount + ' de ' + stepsList.length + '</span></div><ul class="checklist">' +
        stepsList.map(function (s) { return '<li class="' + (s.done ? 'done' : '') + '"><span class="tick" aria-hidden="true">' + (s.done ? icon('check') : '') + '</span><span class="txt">' + esc(s.t) + '<span class="sr-only">' + (s.done ? ' (hecho)' : ' (pendiente)') + '</span></span>' + (!s.done && s.href ? '<a class="btn btn-sm btn-secondary" href="' + s.href + '">' + esc(s.cta) + '</a>' : '') + '</li>'; }).join('') +
        '</ul></section>';
    }

    // Telegram y plan
    var tg = S.telegram.status === 'linked';
    html += '<section class="card card-flush" aria-label="Tu cuenta"><ul class="list">' +
      '<li><a class="list-row" href="#/telegram"><span class="lead">' + icon('message-circle') + '</span><span class="grow"><span class="title" style="display:block">Telegram</span><span class="sub" style="display:block">' + (tg ? 'Conectado: ' + esc(S.telegram.chatName) : 'Pide cambios y recibe avisos por chat') + '</span><span style="display:block;margin-top:6px">' + (tg ? UI.tag('Conectado', 'nopal') : UI.tag('Sin conectar', 'neutral')) + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
      '<li><a class="list-row" href="#/negocio/plan"><span class="lead">' + icon('calendar') + '</span><span class="grow"><span class="title" style="display:block">Prueba gratis</span><span class="sub" style="display:block">' + esc(MS.trialText()) + '</span><span style="display:block;margin-top:6px">' + (S.trial === 'expired' ? UI.tag('Terminada', 'alerta') : (S.trial === 'ending' ? UI.tag('Por vencer', 'ocre') : UI.tag('Vigente', 'nopal'))) + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
      '</ul></section>';

    // Actividad reciente
    var ev = [];
    S.requests.forEach(function (r) { (r.events || []).forEach(function (e) { ev.push({ at: e.at, text: MS.evText(e), who: e.who, r: r }); }); });
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
      '<section aria-labelledby="data-t"><div class="section-title"><h2 id="data-t">Lo que muestra tu página</h2></div>' +
        UI.facts([
          ['message-square-text', 'Frase', esc(d.line)],
          ['phone', 'Teléfono', esc(d.phone)],
          ['map-pin', 'Dirección', esc(d.address)],
          ['clock', 'Horario', 'Lunes a viernes: ' + esc(d.hours.week) + '<br>Sábado: ' + esc(d.hours.sat) + '<br>Domingo: ' + esc(d.hours.sun)],
          ['store', 'Lo que vendes', esc(d.services.join(', '))]
        ]) +
        (MS.can('request') && !MS.expired() ? '<div style="margin-top:12px">' + UI.btn('Pedir un cambio en estos datos', { href: '#/cambios/nuevo', style: 'secondary', icon: 'pencil' }) + '<p class="tiny" style="margin-top:8px">Todo lo que se ve en tu página pasa por una vista previa y tu aprobación.</p></div>' : '') +
      '</section>' +
      '<section class="card card-flush" aria-label="Más opciones"><ul class="list">' +
        '<li><a class="list-row" href="#/negocio/plan"><span class="lead">' + icon('calendar') + '</span><span class="grow"><span class="title" style="display:block">Mi plan</span><span class="sub">' + esc(MS.trialText()) + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
        '<li><a class="list-row" href="#/telegram"><span class="lead">' + icon('message-circle') + '</span><span class="grow"><span class="title" style="display:block">Telegram</span><span class="sub">' + (S.telegram.status === 'linked' ? 'Conectado: ' + esc(S.telegram.chatName) : 'Sin conectar') + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
        '<li><a class="list-row" href="#/cambios/historial"><span class="lead">' + icon('history') + '</span><span class="grow"><span class="title" style="display:block">Historial de cambios</span><span class="sub">Quién pidió, aprobó y publicó cada cambio</span></span>' + icon('chevron-right', 'chev') + '</a></li>' +
      '</ul></section>' +
      '<section class="card" aria-labelledby="acc-t"><h2 id="acc-t" style="font-size:var(--fs-lg)">Tu acceso</h2><p style="margin-top:8px"><strong>' + esc(me.name) + '</strong></p><p class="muted small" style="margin-top:2px">' + esc(me.short === MS.DATA.people.administration.short ? MS.DATA.owner.email : me.short.toLowerCase() + '@ejemplo.mx') + '</p>' +
        '<div style="margin-top:10px">' + UI.tag(me.role, 'lila') + '</div><p class="muted small" style="margin-top:8px">' + esc(me.desc) + '</p>' +
        '<div style="margin-top:16px">' + UI.btn('Cerrar sesión', { action: 'logout', style: 'secondary', icon: 'log-out' }) + '</div></section>' +
      '</div>';
    return { tab: 'negocio', screen: 'DS-06', title: 'Mi negocio', html: html };
  };

  V.plan = function () {
    var S = MS.S;
    var tone = S.trial === 'expired' ? 'alerta' : (S.trial === 'ending' ? 'ocre' : 'nopal');
    var label = S.trial === 'expired' ? 'Terminada' : (S.trial === 'ending' ? 'Por vencer' : 'Vigente');
    var html = head('Mi plan') + '<div class="stack">' +
      '<section class="card stack"><div class="row"><h2 class="grow">Prueba gratis</h2>' + UI.tag(label, tone) + '</div>' +
      UI.facts([
        ['calendar', 'Empezó', esc(MS.date(S.trialStart, true))],
        ['clock', S.trial === 'expired' ? 'Terminó' : 'Vence', esc(MS.date(MS.trialEnd(), true))]
      ]) + UI.note('Fechas ficticias. Duración de 30 días según la propuesta de DEC-0018.') +
      (S.trial === 'expired'
        ? '<div class="banner banner-alerta">' + icon('lock') + '<span><strong>Tu prueba terminó</strong>Puedes ver tu información, pero para hacer cambios contacta a MainSpot.</span></div>' + UI.btn('Contactar a MainSpot', { action: 'contact' })
        : '<p>Durante la prueba puedes pedir cambios, revisarlos y publicar tu página.</p>') +
      '</section>' +
      '<section class="card"><h3>Cuando termine la prueba</h3><ul class="list" style="margin-top:8px">' +
        '<li class="list-row static" style="padding-left:0">' + icon('shield-check') + '<span>No se hace ningún cobro automático.</span></li>' +
        '<li class="list-row static" style="padding-left:0">' + icon('eye') + '<span>Puedes seguir viendo tu información; tus datos no se borran.</span></li>' +
        '<li class="list-row static" style="padding-left:0">' + icon('lock') + '<span>Para seguir haciendo cambios, contacta a MainSpot.</span></li>' +
      '</ul>' + UI.note('Qué pasa con la página publicada al vencer está por definir (DEC-0018). Planes y precios: [por definir].') + '</section>' +
      '</div>';
    return { tab: 'negocio', screen: 'DS-06', title: 'Mi plan', html: html, back: '#/negocio', backLabel: 'Mi negocio' };
  };

  /* ---------- DS-07 · Telegram ---------- */
  V.telegram = function (q) {
    var S = MS.S, t = S.telegram;
    var onb = q && q.desde === 'alta';
    var html = '';
    var cs = MS.tg.liveState();
    if (t.status === 'linked') {
      html = '<div class="result" data-screen="DS-07"><div class="big-spot spot-live">' + icon('check') + '</div><h1 tabindex="-1" data-focus>Tu Telegram está conectado</h1>' +
        '<p>Listo: tu Telegram está conectado con ' + esc(MS.DATA.business) + '. Pide cambios por chat y te avisaremos ahí.</p></div>' +
        UI.facts([['user', 'Chat conectado', esc(t.chatName)], ['clock', 'Desde', esc(MS.when(t.linkedAt))]]) +
        '<div class="btn-row" style="margin-top:24px">' + (onb ? UI.btn('Ir a mi panel', { action: 'onb-finish' }) : '') + UI.btn('Abrir el chat', { href: '#/chat', style: onb ? 'secondary' : 'primary', icon: 'message-circle' }) + UI.btn('Desconectar', { action: 'tg-unlink', style: 'danger', icon: 'unlink' }) + '</div>';
    } else if (t.status === 'code' && t.code) {
      var dead = cs !== 'active';
      var msg = { expired: ['Este código caducó', 'Genera uno nuevo para conectar tu Telegram.'], revoked: ['Anulaste este código', 'Ya no funciona. Genera uno nuevo cuando quieras conectar.'], used: ['Este código ya se usó', 'Si no fuiste tú, genera uno nuevo. El anterior ya no sirve.'] }[cs];
      html = head('Conecta tu Telegram', dead ? '' : 'Sigue estos pasos en tu celular.');
      html += '<div class="code-box' + (dead ? ' is-dead' : '') + '"><div class="small muted">Tu código de conexión</div><div class="code" aria-label="Código ' + esc(t.code.split('').join(' ')) + '">' + esc(t.code) + '</div>' +
        (dead ? '<div class="timer">' + icon('circle-x', 'ic-sm') + 'Ya no funciona</div>' : '<div class="timer">' + icon('clock', 'ic-sm') + 'Vence en <span data-countdown="' + t.codeExpiresAt + '" data-on-zero="tg-expire">' + countdown(t.codeExpiresAt) + '</span></div>') + '</div>';
      if (dead) {
        html += '<div class="banner banner-alerta" style="margin-top:16px" role="alert">' + icon('circle-alert') + '<span><strong>' + esc(msg[0]) + '</strong>' + esc(msg[1]) + '</span></div>' +
          '<div class="btn-row" style="margin-top:24px">' + UI.btn('Generar un código nuevo', { action: 'tg-generate', icon: 'refresh-cw' }) + '</div>';
      } else {
        html += UI.note('Vigencia de 10 minutos como ejemplo; «corta vigencia» está por definir (DEC-0041).') +
          '<ol class="hub-journey" style="margin-top:20px" aria-label="Pasos">' +
            '<li><div><div class="t">Toca «Abrir Telegram»</div><div class="d">Se abrirá el chat oficial de MainSpot.</div></div></li>' +
            '<li><div><div class="t">Toca «Iniciar» en el chat</div><div class="d">Si no aparece, escribe el código de arriba.</div></div></li>' +
            '<li><div><div class="t">Listo</div><div class="d">Aquí verás que tu Telegram quedó conectado.</div></div></li>' +
          '</ol>' +
          '<div class="btn-row" style="margin-top:24px">' + UI.btn('Abrir Telegram', { href: '#/chat?inicio=' + encodeURIComponent(t.code), icon: 'external-link' }) + UI.btn('Anular este código', { action: 'tg-revoke', style: 'ghost' }) + '</div>';
      }
    } else {
      html = head('Telegram', 'Pide cambios por chat y recibe avisos en tu celular.') +
        '<div class="card stack">' +
          '<div class="convo" aria-hidden="true"><div class="msg me"><div class="bubble">Agrega pan de muerto, ya es temporada</div></div><div class="msg bot"><div class="bubble">Agregaremos «Pan de muerto (temporada)» a lo que vendes. ¿Preparo la vista previa?</div></div></div>' +
          '<ul class="list">' +
            '<li class="list-row static" style="padding-left:0">' + icon('shield-check') + '<span>Usas el chat oficial de MainSpot. No tienes que crear nada.</span></li>' +
            '<li class="list-row static" style="padding-left:0">' + icon('eye') + '<span>Antes de publicar algo, siempre te pedimos tu aprobación.</span></li>' +
            '<li class="list-row static" style="padding-left:0">' + icon('unlink') + '<span>Puedes desconectarlo cuando quieras.</span></li>' +
          '</ul>' +
          (S.trial === 'expired' ? UI.note('Abierto: si generar un código cuenta como «crear» con la prueba terminada (DEC-0018). Aquí se permite.') : '') +
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

  /* Chat de Telegram a pantalla completa (simulado) */
  V.chat = function (q) {
    if (q && q.inicio) MS.mem.tgStart = q.inicio;
    var html = '<div class="tg-screen" data-screen="DS-07"><div class="tg-phone" role="dialog" aria-modal="true" aria-label="Chat de Telegram simulado">' + UI.tg('full', { back: true }) + '</div></div>';
    return { title: 'Telegram (simulado)', html: html, shell: false, chat: true };
  };

  /* ---------- DS-08 · Cambios ---------- */
  V.changes = function (tab) {
    var S = MS.S;
    var hist = tab === 'historial';
    var pendingSt = ['awaiting_confirm', 'preparing', 'preview_ready', 'expired', 'approved'];
    var list = S.requests.filter(function (r) { return hist ? true : pendingSt.indexOf(r.status) >= 0; });
    var nPend = S.requests.filter(function (r) { return pendingSt.indexOf(r.status) >= 0; }).length;
    var html = head('Cambios', 'Pide cambios y decide qué se publica.');
    var canAsk = MS.can('request') && !MS.expired();
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
    return { tab: 'cambios', screen: 'DS-08', title: 'Cambios', html: html };
  };

  V.ask = function () {
    var canAsk = MS.can('request') && !MS.expired();
    var adj = MS.S.adjusting ? MS.req(MS.S.adjusting) : null;
    var html = head(adj ? 'Ajustar el cambio' : 'Pedir un cambio', adj ? 'Sobre: ' + adj.title : 'Escríbelo como se lo dirías a alguien de confianza.');
    html += UI.convo('panel');
    if (canAsk) {
      html += '<form class="convo-input" data-form="panel-send"><label class="sr-only" for="panel-input">Escribe tu mensaje</label><textarea class="textarea" id="panel-input" name="msg" rows="1" placeholder="Escribe aquí lo que quieres cambiar"></textarea><button class="icon-btn" type="submit" aria-label="Enviar">' + icon('arrow-up') + '</button></form>';
    } else {
      html += '<div class="banner ' + (MS.expired() ? 'banner-alerta' : 'banner-lila') + '" style="margin-top:16px">' + icon('lock') + '<span>' + (MS.expired() ? 'Tu prueba terminó. Para pedir cambios, contacta a MainSpot.' : 'Tu perfil puede ver los cambios, pero no pedirlos. Pídele ayuda a quien administra tu negocio.') + '</span></div>';
    }
    return { tab: 'cambios', screen: 'DS-08', title: 'Pedir un cambio', html: html, back: '#/cambios', backLabel: 'Cambios', convo: 'panel' };
  };

  V.changeDetail = function (id) {
    var r = MS.req(id);
    if (!r) return { tab: 'cambios', screen: 'DS-08', title: 'Cambio', html: UI.empty('No encontramos ese cambio', 'Puede que el enlace esté incompleto.', UI.btn('Ver mis cambios', { href: '#/cambios' })), back: '#/cambios', backLabel: 'Cambios' };
    var html = '<div class="page-head"><div style="margin-bottom:8px">' + UI.statusTag(r) + '</div><h1 tabindex="-1" data-focus>' + esc(r.title) + '</h1><p>' + (r.kind === 'first' ? 'Preparada por MainSpot con los datos de tu alta.' : 'Pedido por ' + esc(r.by) + ' en ' + UI.channelName(r.channel) + (r.text ? ': «' + esc(r.text) + '»' : '.')) + '</p></div>';
    html += '<div class="stack-lg">';
    if (r.changes.length && r.kind !== 'restore') html += '<section aria-labelledby="ch-t"><h2 id="ch-t" style="font-size:var(--fs-lg);margin-bottom:10px">El cambio</h2>' + UI.diff(r.changes) + '</section>';
    // acción según estado
    var act = '';
    if (r.status === 'preview_ready') act = UI.btn(MS.can('approve') ? 'Revisar y decidir' : 'Ver vista previa', { href: '#/vista-previa/' + r.id, style: MS.can('approve') ? 'primary' : 'secondary' });
    else if (r.status === 'expired' && MS.can('confirm') && !MS.expired()) act = UI.btn('Pedir una nueva vista previa', { action: 'renew', arg: r.id });
    else if (r.status === 'awaiting_confirm' && MS.can('confirm') && !MS.expired()) act = UI.btn('Continuar en la conversación', { href: r.channel === 'telegram' ? '#/chat' : '#/cambios/nuevo', style: 'secondary' });
    else if (r.status === 'approved') act = UI.btn('Ver cómo va la publicación', { href: '#/pagina', style: 'secondary' });
    else if (r.status === 'published') act = UI.btn('Ver mi página', { href: '#/sitio', style: 'secondary', icon: 'external-link' });
    else if (r.status === 'preparing') act = '<p class="row muted">' + icon('loader-circle', 'spinner') + 'Estamos preparando la vista previa…</p>';
    if (act) html += '<div>' + act + '</div>';
    html += '<section aria-labelledby="tl-t"><h2 id="tl-t" style="font-size:var(--fs-lg);margin-bottom:10px">Qué ha pasado</h2><ol class="track">' +
      (r.events || []).map(function (e, i, arr) {
        var mine = e.who !== 'MainSpot';
        return '<li class="' + (i === arr.length - 1 ? 'ok' : 'done') + '"><span class="node">' + icon(mine ? 'user' : 'shield-check') + '</span><div><div class="t">' + esc(MS.evText(e)) + '</div><div class="d">' + esc(e.who === MS.me().name ? e.who + ' (tú)' : e.who) + ', ' + esc(MS.when(e.at)) + '</div></div></li>';
      }).join('') + '</ol>' + UI.note('Quién pidió, aprobó y publicó queda registrado (REQ-009). El asistente propone; las aprobaciones siempre son de una persona.') + '</section>';
    html += '</div>';
    return { tab: 'cambios', screen: 'DS-08', title: r.title, html: html, back: '#/cambios', backLabel: 'Cambios' };
  };

  /* ---------- DS-09 · Vista previa ---------- */
  V.preview = function (id, q) {
    var r = MS.req(id);
    var back = { back: '#/cambios', backLabel: 'Cambios', tab: 'cambios', screen: 'DS-09' };
    function stateView(spotCls, ic, title, body, actions) {
      return Object.assign({ title: title, html: '<div class="result"><div class="big-spot ' + spotCls + '">' + icon(ic) + '</div><h1 tabindex="-1" data-focus>' + esc(title) + '</h1><p>' + esc(body) + '</p><div class="btn-row" style="justify-content:center;margin-top:24px">' + (actions || '') + '</div></div>' }, back);
    }
    if (!r) return stateView('spot-none', 'link', 'Este enlace de vista previa no funciona', 'Revisa que esté completo o pide uno nuevo desde tu panel.', UI.btn('Ir a mis cambios', { href: '#/cambios' }));
    if (r.status === 'expired') return stateView('spot-none', 'clock', 'Este enlace de vista previa ya no funciona', 'Las vistas previas vencen después de un tiempo. Pide una nueva desde tu panel; no se publicó nada.', MS.can('confirm') && !MS.expired() ? UI.btn('Pedir una nueva vista previa', { action: 'renew', arg: r.id }) : UI.btn('Ir a mis cambios', { href: '#/cambios', style: 'secondary' }));
    if (r.status === 'published' || r.status === 'approved') return stateView('spot-live', 'check', 'Esta vista previa ya se usó', (r.approvedBy || 'Alguien') + ' aprobó este cambio ' + MS.when(r.approvedAt) + '. Cada vista previa sirve para una sola decisión.', r.status === 'published' ? UI.btn('Ver mi página', { href: '#/sitio' }) : UI.btn('Ver cómo va', { href: '#/pagina' }));
    if (r.status === 'rejected') return stateView('spot-none', 'x', 'Descartaste este cambio', 'Tu página sigue igual. Si cambias de opinión, puedes pedirlo de nuevo.', MS.can('request') ? UI.btn('Pedir un cambio', { href: '#/cambios/nuevo', style: 'secondary' }) : '');
    if (r.status === 'cancelled') return stateView('spot-none', 'x', 'Esta propuesta se corrigió', 'No se preparó ninguna vista previa con ella.', UI.btn('Ir a mis cambios', { href: '#/cambios', style: 'secondary' }));
    if (r.status === 'preparing') return Object.assign({ title: 'Preparando vista previa', html: '<div class="result" aria-busy="true"><div class="big-spot spot-work">' + icon('hourglass') + '</div><h1 tabindex="-1" data-focus>Estamos preparando la vista previa</h1><p>Tarda solo un momento. No cambia nada en tu página.</p></div><div class="skeleton" style="height:320px;border-radius:20px"></div>' }, back);
    if (r.status === 'awaiting_confirm') return stateView('spot-wait', 'message-square-text', 'Falta confirmar este cambio', 'Confírmalo en la conversación para que preparemos la vista previa.', UI.btn('Continuar', { href: r.channel === 'telegram' ? '#/chat' : '#/cambios/nuevo' }));

    var first = r.kind === 'first';
    var mode = (q && q.ver === 'antes') ? 'antes' : 'despues';
    var base = MS.siteBase();
    var after = MS.applyChanges(first ? MS.S.biz : base, r.changes);
    var html = '<div class="page-head"><h1 tabindex="-1" data-focus>' + (first ? 'Así se verá tu página' : 'Así quedaría tu página') + '</h1><p>Nada cambia hasta que tú lo apruebes.</p>' +
      '<p class="tiny inline-meta" style="margin-top:8px">' + icon('clock') + '<span>Esta vista previa vence hoy a las ' + esc(MS.time(r.preview.expiresAt)) + ' y sirve para una sola decisión.</span></p>' + UI.note('Vigencia ficticia; es configurable (DEC-0003).') + '</div>';
    html += '<div class="stack-lg">';
    if (first) {
      html += '<section class="card"><h2 style="font-size:var(--fs-lg)">Tu primera versión</h2><p class="muted" style="margin-top:6px">La armamos con los datos que nos diste. Revisa que tu horario, teléfono y dirección estén bien.</p>' + (r.changes.length ? '<div style="margin-top:12px">' + UI.diff(r.changes) + '</div>' : '') + '</section>';
    } else if (r.kind === 'restore') {
      html += '<section class="card"><h2 style="font-size:var(--fs-lg)">' + esc(r.title) + '</h2><p class="muted" style="margin-top:6px">Tu página volverá a verse como en la ' + esc(r.changes[0].after) + '.</p></section>';
    } else {
      html += '<section aria-labelledby="sum-t"><h2 id="sum-t" style="font-size:var(--fs-lg);margin-bottom:10px">Esto es lo que cambia</h2>' + UI.diff(r.changes) + '</section>';
    }

    // Decisión
    var canDecide = MS.can('approve') && !MS.expired();
    if (canDecide) {
      html += '<section class="card stack" aria-labelledby="dec-t"><h2 id="dec-t" style="font-size:var(--fs-lg)">¿Qué hacemos?</h2>' +
        '<div class="btn-row" style="margin-top:4px">' + UI.btn(first ? 'Publicar mi página' : 'Publicar este cambio', { action: 'approve-ask', arg: r.id, id: 'approve-btn' }) + UI.btn('Pedir otro cambio', { action: 'adjust', arg: r.id, style: 'secondary' }) + UI.btn('Descartar', { action: 'reject-ask', arg: r.id, style: 'ghost' }) + '</div>' +
        '<p class="tiny">Al publicar, quedará registrado que tú lo aprobaste.</p></section>';
    } else if (MS.expired()) {
      html += '<div class="banner banner-alerta">' + icon('lock') + '<span><strong>Tu prueba terminó</strong>Puedes ver esta vista previa, pero para publicar cambios contacta a MainSpot.</span></div>';
    } else {
      html += '<div class="banner banner-lila">' + icon('info') + '<span><strong>Tu perfil no permite aprobar cambios</strong>' + (MS.S.role === 'operation' ? 'Ya le avisamos a ' + esc(MS.DATA.people.administration.name) + ' para que lo revise y decida.' : 'Puedes ver la vista previa. Quien administra tu negocio decide si se publica.') + '</span></div>';
    }

    // Página completa
    html += '<section aria-labelledby="full-t"><div class="section-title" style="flex-wrap:wrap"><h2 id="full-t">Tu página completa</h2>' +
      (!first ? '<div class="segmented" role="group" aria-label="Comparar"><button type="button" aria-pressed="' + (mode === 'antes') + '" data-action="go" data-arg="#/vista-previa/' + r.id + '?ver=antes">Antes</button><button type="button" aria-pressed="' + (mode === 'despues') + '" data-action="go" data-arg="#/vista-previa/' + r.id + '">Después</button></div>' : '') + '</div>' +
      UI.browser(mode === 'antes' ? UI.site(base) : UI.site(after, { highlight: r.changes.filter(function (c) { return c.field !== 'page'; }) }), { flag: mode === 'antes' ? 'Así se ve hoy' : 'Vista previa: aún no publicada', label: mode === 'antes' ? 'Tu página como se ve hoy' : 'Vista previa de tu página' }) +
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
      '<p>Quedó registrado a tu nombre, ' + esc(MS.when(r.approvedAt)) + '. ' + (r.status === 'published' ? 'Ya está en tu página.' : 'Ahora lo estamos publicando y te avisaremos cuando esté listo.') + '</p></div>';
    if (p && p.reqId === r.id) html += '<section class="card" aria-label="Avance de la publicación">' + UI.track(p) + '</section>';
    html += '<div class="btn-row" style="margin-top:24px;justify-content:center">' + (r.status === 'published' ? UI.btn('Ver mi página', { href: '#/sitio', icon: 'external-link' }) : UI.btn('Ver cómo va', { href: '#/pagina' })) + UI.btn('Volver al inicio', { href: '#/inicio', style: 'secondary' }) + '</div>';
    return { tab: 'cambios', screen: 'DS-10', title: 'Aprobaste el cambio', html: html };
  };

  /* ---------- DS-11 · Mi página ---------- */
  V.page = function () {
    var S = MS.S, p = S.site.pub, live = !!S.site.published;
    var st = UI.siteState();
    var html = head('Mi página');
    html += '<div class="stack-lg">';
    html += '<section class="siteband" aria-labelledby="pg-t"><span class="spot spot-' + st.spot + '" aria-hidden="true">' + icon(st.ic) + '</span><div><h2 id="pg-t">' + esc(st.title) + '</h2>' + (live ? '<p class="addr">' + esc(MS.DATA.address) + '</p>' : '') + (st.body ? '<p class="muted small" style="margin-top:6px">' + esc(st.body) + '</p>' : '') + '</div>';
    var acts = '';
    if (live) acts += UI.btn('Ver mi página', { href: '#/sitio', icon: 'external-link', style: p && p.state !== 'done' ? 'secondary' : 'primary' }) + UI.btn('Copiar dirección', { action: 'copy', arg: MS.DATA.address, style: 'secondary', icon: 'copy' });
    else if (st.first) acts += UI.btn(MS.can('approve') ? 'Revisar mi primera página' : 'Ver vista previa', { href: '#/vista-previa/' + st.first.id });
    html += (acts ? '<div class="actions">' + acts + '</div>' : '') + '</section>';
    if (live) html += UI.note('Dirección de ejemplo; el dominio está por definir (DEC-0004). Sin conexión ni certificados reales.');

    if (p && (p.state !== 'done' || Date.now() - (p.doneAt || 0) < 20000)) {
      html += '<section class="card" aria-labelledby="tr-t" aria-live="polite"><div class="section-title"><h2 id="tr-t">' + (p.state === 'done' ? 'Publicación terminada' : 'Cómo va la publicación') + '</h2>' + (p.attempts > 1 ? '<span class="tiny">Intento ' + p.attempts + '</span>' : '') + '</div>' + UI.track(p);
      if (p.state === 'failed') html += '<div class="banner banner-alerta" style="margin-top:16px" role="alert">' + icon('triangle-alert') + '<span><strong>' + MS.PUB_TEXT.FAILED.t + '</strong>' + MS.PUB_TEXT.FAILED.d + (live ? ' Tu página sigue mostrando la versión anterior.' : ' No marcamos tu página como publicada hasta comprobar que funciona.') + '</span></div>';
      if (p.state === 'retry') html += '<div class="banner banner-ocre" style="margin-top:16px">' + icon('clock') + '<span><strong>' + MS.PUB_TEXT.RETRY_PENDING.t + '</strong>Siguiente intento en <span data-countdown="' + p.retryAt + '">' + countdown(p.retryAt) + '</span>. No tienes que hacer nada.<br>' + UI.btn('Intentar ahora', { action: 'pub-retry', sm: true, style: 'secondary', icon: 'refresh-cw' }) + '</span></div>';
      html += UI.note('Tiempos acelerados para la demo. Sin conexión real: los pasos se simulan.') + '</section>';
    }

    // Versiones
    html += '<section aria-labelledby="ver-t"><div class="section-title"><h2 id="ver-t">Versiones publicadas</h2></div>';
    if (!S.site.versions.length) html += '<p class="card muted">Cuando publiques tu página, aquí guardaremos cada versión. Así podrás regresar a una anterior si lo necesitas.</p>';
    else html += '<div class="card card-flush"><ul class="list">' + S.site.versions.map(function (v, i) {
      var cur = i === 0;
      return '<li><div class="list-row static"><span class="lead">' + icon(cur ? 'globe' : 'history') + '</span><span class="grow"><span class="title" style="display:block">Versión ' + v.n + '</span><span class="sub">' + esc(v.title) + '. Aprobó ' + esc(v.by) + ', ' + esc(MS.when(v.at)) + '</span>' +
        (cur ? '<span style="display:block;margin-top:6px">' + UI.tag('En internet', 'nopal') + '</span>' : (MS.can('request') && !MS.expired() ? '<span style="display:block;margin-top:8px">' + UI.btn('Volver a esta versión', { action: 'restore-ask', arg: v.n, sm: true, style: 'secondary', icon: 'undo-2' }) + '</span>' : '')) + '</span></div></li>';
    }).join('') + '</ul></div>';
    html += '</section></div>';
    return { tab: 'pagina', screen: 'DS-11', title: 'Mi página', html: html };
  };

  V.site = function () {
    var S = MS.S;
    if (!S.site.published) return { tab: 'pagina', screen: 'DS-11', title: 'Mi página', back: '#/pagina', backLabel: 'Mi página', html: UI.empty('Tu página todavía no está en internet', 'Cuando apruebes tu primera versión y termine la publicación, la verás aquí.', UI.btn('Ir a Mi página', { href: '#/pagina' })) };
    var v = S.site.versions[0];
    var html = '<div class="page-head"><h1 tabindex="-1" data-focus>Tu página en internet</h1><p>Así la ven tus clientes. Versión ' + v.n + ', publicada ' + esc(MS.when(v.at)) + '.</p></div>' + UI.browser(UI.site(S.site.published), { label: 'Tu página publicada' }) + UI.note('Simulación: la página no está realmente en internet.');
    return { tab: 'pagina', screen: 'DS-11', title: 'Tu página', html: html, back: '#/pagina', backLabel: 'Mi página' };
  };

  /* ---------- DS-12 · Avisos ---------- */
  var NK = { approval: ['rosa', 'eye'], live: ['nopal', 'globe'], failed: ['alerta', 'triangle-alert'], trial: ['ocre', 'clock'], tg: ['lila', 'message-circle'] };
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
      return '<li><button type="button" class="notice' + (n.read ? '' : ' unread') + '" data-action="notice-open" data-arg="' + n.id + '"><span class="n-ic n-' + k[0] + '" aria-hidden="true">' + icon(k[1]) + '</span><span><span class="n-title" style="display:block">' + esc(n.title) + '</span><span class="n-body" style="display:block">' + esc(n.body) + '</span><span class="n-time">' + esc(MS.when(n.at)) + '</span></span></button></li>';
    }).join('') + '</ul></div>';
    html += '<div class="banner banner-lila" style="margin-top:20px">' + icon('message-circle') + '<span>' + (S.telegram.status === 'linked' ? '<strong>También te avisamos por Telegram</strong>Los mismos avisos llegan a tu chat con MainSpot.' : '<strong>Recibe estos avisos en tu celular</strong>Conecta tu Telegram y te escribiremos ahí.<br>' + UI.btn('Conectar Telegram', { href: '#/telegram', sm: true, style: 'secondary' })) + '</span></div>';
    return { tab: 'avisos', screen: 'DS-12', title: 'Avisos', html: html, back: '#/inicio', backLabel: 'Inicio' };
  };
})();
