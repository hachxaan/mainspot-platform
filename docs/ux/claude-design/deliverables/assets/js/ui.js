/* =====================================================================
   MainSpot · Prototipo · Componentes de interfaz reutilizables
   Cada función devuelve HTML (texto). La interacción se resuelve por
   delegación de eventos en main.js mediante atributos data-action.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var esc = MS.esc, icon = MS.icon;
  var UI = (MS.ui = {});

  /* ---------- Botón ---------- */
  UI.btn = function (label, o) {
    o = o || {};
    var cls = 'btn btn-' + (o.style || 'primary') + (o.block ? ' btn-block' : '') + (o.sm ? ' btn-sm' : '');
    var ic = o.icon ? icon(o.icon) : '';
    var attrs = (o.action ? ' data-action="' + o.action + '"' : '') + (o.arg != null ? ' data-arg="' + esc(o.arg) + '"' : '') + (o.id ? ' id="' + o.id + '"' : '') + (o.label ? ' aria-label="' + esc(o.label) + '"' : '');
    if (o.href) return '<a class="' + cls + '" href="' + esc(o.href) + '"' + attrs + '>' + ic + '<span>' + esc(label) + '</span></a>';
    return '<button type="' + (o.type || 'button') + '" class="' + cls + '"' + attrs + (o.disabled ? ' disabled' : '') + '>' + ic + '<span>' + esc(label) + '</span></button>';
  };

  UI.tag = function (text, tone) { return '<span class="tag tag-' + (tone || 'neutral') + '">' + esc(text) + '</span>'; };
  UI.statusTag = function (r) {
    var st = MS.STATUS[r.status] || { label: r.status, tone: 'neutral' };
    var label = st.label;
    if (r.status === 'preview_ready' && !MS.can('approve')) label = 'Espera aprobación';
    if (r.status === 'awaiting_confirm' && !MS.can('confirm')) label = 'Espera confirmación';
    return UI.tag(label, st.tone);
  };
  UI.note = function (text) { return '<span class="proto-note">' + esc(text) + '</span>'; };

  UI.planes = function (cls) {
    return '<div class="planes ' + (cls || '') + '" aria-hidden="true"><div class="p-wall"></div><div class="p-shadow"></div><div class="p-sun"></div><div class="p-step2"></div><div class="p-step1"></div><div class="p-slot"></div><div class="p-brand"><span class="brand"><span class="brand-mark"></span>MainSpot</span></div></div>';
  };

  UI.empty = function (title, body, action) {
    return '<div class="empty"><div class="em-art" aria-hidden="true"><span class="a"></span><span class="b"></span><span class="c"></span></div><h2>' + esc(title) + '</h2><p>' + esc(body) + '</p>' + (action || '') + '</div>';
  };

  UI.facts = function (items) {
    return '<ul class="facts">' + items.map(function (it) {
      return '<li>' + icon(it[0]) + '<div class="grow"><span class="k">' + esc(it[1]) + '</span><span class="v">' + it[2] + '</span></div></li>';
    }).join('') + '</ul>';
  };

  UI.channelName = function (c) { return c === 'telegram' ? 'Telegram' : (c === 'panel' ? 'el panel' : 'MainSpot'); };

  /* ---------- Cambio antes / después ---------- */
  UI.diff = function (changes) {
    if (!changes || !changes.length) return '';
    return '<div class="diff">' + changes.map(function (c) {
      var isAdd = c.field === 'services.add', isRem = c.field === 'services.remove';
      var before = isAdd ? 'No aparece' : c.before;
      var after = isRem ? 'Ya no aparece' : c.after;
      var what = isAdd ? 'Lo que vendes: ' + c.after : (isRem ? 'Lo que vendes: ' + c.before : c.label);
      return '<div class="diff-item"><div class="what">' + esc(what) + '</div><div class="cols"><div><span class="k">Antes</span><span class="v old">' + esc(before) + '</span></div><div><span class="k">Después</span><span class="v">' + esc(after) + '</span></div></div></div>';
    }).join('') + '</div>';
  };

  UI.changeLine = function (r) {
    if (r.kind === 'first') return 'Tu primera versión, hecha con los datos que nos diste.';
    return (r.changes || []).map(function (c) {
      if (c.field === 'services.add') return 'Agregar «' + c.after + '»';
      if (c.field === 'services.remove') return 'Quitar «' + c.before + '»';
      if (c.field === 'page') return 'Volver a: ' + c.after;
      return c.label + ': ' + c.after;
    }).join('. ');
  };

  /* ---------- Sitio del negocio (plantilla ilustrativa) ---------- */
  UI.site = function (data, opts) {
    opts = opts || {};
    var hl = {};
    (opts.highlight || []).forEach(function (c) { hl[c.field] = c; });
    function mark(field, inner, tag) {
      return hl[field] ? '<span class="changed">' + inner + '<span class="changed-tag">' + (tag || 'Cambió') + '</span></span>' : inner;
    }
    var added = hl['services.add'] ? hl['services.add'].after : null;
    var services = data.services.map(function (s) {
      return '<li>' + (s === added ? mark('services.add', esc(s), 'Nuevo') : esc(s)) + '</li>';
    }).join('');
    if (opts.showRemoved && hl['services.remove']) services += '<li class="gone">' + esc(hl['services.remove'].before) + '</li>';
    return '<div class="site">' +
      '<div class="site-hero"><div class="s-name">' + esc(data.name) + '</div><div class="s-line">' + mark('line', esc(data.line)) + '</div></div>' +
      '<div class="site-body">' +
        '<div class="site-card">' + esc(data.about) + '</div>' +
        '<div class="site-card"><h5>Lo que vendemos</h5><ul>' + services + '</ul>' + (hl['services.remove'] && !opts.showRemoved ? '<p style="margin-top:6px"><span class="changed" style="font-size:.85rem">Se quitó «' + esc(hl['services.remove'].before) + '»<span class="changed-tag">Cambió</span></span></p>' : '') + '</div>' +
        '<div class="site-card"><h5>Horario</h5><dl>' +
          '<dt>Lunes a viernes</dt><dd>' + mark('hours.week', esc(data.hours.week)) + '</dd>' +
          '<dt>Sábado</dt><dd>' + mark('hours.sat', esc(data.hours.sat)) + '</dd>' +
          '<dt>Domingo</dt><dd>' + mark('hours.sun', esc(data.hours.sun)) + '</dd>' +
        '</dl></div>' +
        '<div class="site-card"><h5>Visítanos</h5><dl>' +
          '<dt>Teléfono</dt><dd>' + mark('phone', esc(data.phone)) + '</dd>' +
          '<dt>Dirección</dt><dd>' + mark('address', esc(data.address)) + '</dd>' +
        '</dl></div>' +
      '</div>' +
      '<div class="site-foot">' + esc(data.name) + '</div>' +
    '</div>';
  };

  UI.browser = function (inner, opts) {
    opts = opts || {};
    return '<div class="browser" role="group" aria-label="' + esc(opts.label || 'Tu página') + '">' +
      '<div class="browser-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="url">' + esc(opts.url || MS.DATA.address) + '</span></div>' +
      (opts.flag ? '<div class="preview-flag">' + esc(opts.flag) + '</div>' : '') +
      inner + '</div>';
  };

  /* ---------- Seguimiento de publicación ---------- */
  UI.track = function (p) {
    var steps = MS.publish.steps(p.kind);
    var cur = steps.indexOf(p.step);
    var html = '<ol class="track" aria-label="Avance de la publicación">';
    steps.forEach(function (s, i) {
      var cls = 'todo', ic = '', extra = '';
      var txt = MS.PUB_TEXT[s];
      if (p.state === 'done') { cls = s === 'ACTIVE' ? 'ok' : 'done'; ic = 'check'; }
      else if (i < cur) { cls = 'done'; ic = 'check'; }
      else if (i === cur) {
        if (p.state === 'failed' || p.state === 'retry') { cls = 'fail'; ic = 'x'; }
        else { cls = 'now'; ic = 'loader-circle'; }
      }
      var title = txt.t;
      if (s === 'REGISTERED' && p.kind !== 'first') title = 'Recibimos tu cambio';
      if (s === 'ACTIVE' && p.state !== 'done') title = p.kind === 'first' ? 'Tu página estará en internet' : 'Tu cambio estará en tu página';
      if (s === 'ACTIVE' && p.state === 'done' && p.kind !== 'first') title = 'Tu cambio ya está en tu página';
      var d = '';
      if (cls === 'now') d = txt.d;
      if (cls === 'fail') d = p.state === 'retry' ? 'Esta comprobación no salió bien. Lo intentaremos de nuevo.' : 'Esta comprobación no salió bien.';
      if (cls === 'ok') d = MS.DATA.address;
      var state = cls === 'done' || cls === 'ok' ? 'Completado' : (cls === 'now' ? 'En curso' : (cls === 'fail' ? 'No se completó' : 'Pendiente'));
      html += '<li class="' + cls + '"' + (cls === 'now' ? ' aria-current="step"' : '') + '><span class="node">' + (ic ? icon(ic, ic === 'loader-circle' ? 'spinner' : '') : '') + '</span><div><div class="t">' + esc(title) + '<span class="sr-only"> (' + state + ')</span></div>' + (d ? '<div class="d">' + esc(d) + '</div>' : '') + extra + '</div></li>';
    });
    return html + '</ol>';
  };

  /* ---------- Franja del estado de la página (el «spot») ---------- */
  UI.siteState = function () {
    var S = MS.S, p = S.site.pub, live = !!S.site.published;
    var first = S.requests.filter(function (r) { return r.kind === 'first'; })[0];
    if (p && p.state !== 'done') {
      if (p.state === 'failed') return { spot: 'fail', ic: 'triangle-alert', title: MS.PUB_TEXT.FAILED.t, body: 'Ya estamos revisándolo. ' + (live ? 'Mientras, tu página sigue mostrando la versión anterior.' : 'No tienes que hacer nada.'), tone: 'alerta' };
      if (p.state === 'retry') return { spot: 'work', ic: 'clock', title: MS.PUB_TEXT.RETRY_PENDING.t, body: live ? 'Mientras, tu página sigue mostrando la versión anterior.' : 'No tienes que hacer nada. Te avisaremos cuando esté lista.', tone: 'ocre' };
      return { spot: 'work', ic: 'hourglass', title: live ? 'Estamos actualizando tu página' : MS.PUB_TEXT[p.step].t, body: live ? 'Mientras, se ve la versión anterior. Te avisaremos cuando termine.' : 'Te avisaremos cuando esté lista. Puedes seguir usando MainSpot.', tone: 'ocre' };
    }
    if (live) return { spot: 'live', ic: 'check', title: 'Tu página ya está en internet', body: '', addr: MS.DATA.address, tone: 'nopal' };
    if (first && first.status === 'preparing') return { spot: 'work', ic: 'hourglass', title: 'Estamos preparando tu página', body: 'La armamos con los datos que nos diste. Tarda solo un momento.', tone: 'ocre' };
    if (first && first.status === 'preview_ready') return { spot: 'none', ic: 'globe', title: 'Tu página todavía no está en internet', body: MS.can('approve') ? 'La publicaremos en cuanto apruebes tu primera versión.' : 'La primera versión está lista y espera la aprobación de ' + MS.DATA.people.administration.name + '.', tone: 'neutral', first: first };
    return { spot: 'none', ic: 'globe', title: 'Tu página todavía no está en internet', body: 'Cuando apruebes tu primera versión, la publicaremos.', tone: 'neutral' };
  };

  /* ---------- Conversación del panel ---------- */
  UI.convo = function (channel) {
    var msgs = MS.S.convo[channel];
    var me = MS.me();
    var html = '<div class="convo" id="convo-' + channel + '" aria-live="polite">';
    html += msgBot('Hola, ' + me.short + '. Cuéntame qué quieres cambiar en tu página, con tus palabras. Por ejemplo: «El sábado abrimos de 8 a 2» o «Agrega pan de muerto».\nAntes de publicar nada, te enseñaré cómo queda.', null, []);
    msgs.forEach(function (m) {
      if (m.from === 'me') html += '<div class="msg me"><div class="who">' + esc(me.short) + '</div><div class="bubble">' + esc(m.text) + '</div></div>';
      else if (m.from === 'system') html += '<div class="tiny center">' + esc(m.text) + '</div>';
      else html += msgBot(m.text, m, m.actions || []);
    });
    if (MS.mem.typing[channel]) html += '<div class="msg bot typing"><div class="who"><span class="brand-mark"></span>MainSpot</div><div class="bubble" aria-label="MainSpot está escribiendo"><i></i><i></i><i></i></div></div>';
    return html + '</div>';

    function msgBot(text, m, actions) {
      var out = '<div class="msg bot"><div class="who"><span class="brand-mark" aria-hidden="true"></span>MainSpot</div><div class="bubble">' + esc(text);
      if (m && m.changes && m.changes.length) out += '<div class="change-box">' + UI.diff(m.changes) + '</div>';
      out += '</div>';
      if (actions.length) {
        out += '<div class="actions">' + actions.map(function (a, i) {
          var used = m && m.used !== undefined && m.used !== false && a.act !== 'text' && a.act !== 'open';
          var chosen = used && m.used === i;
          if (a.style === 'chip') return '<button type="button" class="chip" data-action="convo-act" data-ch="' + channel + '" data-msg="' + m.id + '" data-i="' + i + '">' + esc(a.label) + '</button>';
          if (used) return '<span class="tag ' + (chosen ? 'tag-nopal' : 'tag-neutral') + '">' + (chosen ? 'Elegiste: ' : '') + esc(a.label) + '</span>';
          return '<button type="button" class="btn btn-sm btn-' + (a.style === 'primary' ? 'primary' : 'secondary') + '" data-action="convo-act" data-ch="' + channel + '" data-msg="' + m.id + '" data-i="' + i + '">' + esc(a.label) + '</button>';
        }).join('') + '</div>';
      }
      return out + '</div>';
    }
  };

  /* ---------- Telegram simulado ---------- */
  UI.tg = function (ctx, opts) {
    opts = opts || {};
    var t = MS.S.telegram, msgs = MS.S.convo.tg;
    var linked = t.status === 'linked';
    var html = '<div class="tg">';
    html += '<div class="tg-top"><div class="tg-head">' + (opts.back ? '<button type="button" class="icon-btn" data-action="tg-close" aria-label="Volver a MainSpot">' + icon('chevron-left') + '</button>' : '') +
      '<div class="av" aria-hidden="true"><span class="brand-mark"></span></div><div class="grow"><div class="nm">MainSpot</div><div class="st">bot' + (linked ? ', conectado con ' + esc(MS.DATA.business) : '') + '</div></div></div>';
    html += '<div class="tg-sim">Simulación de Telegram, sin conexión real</div></div>';
    html += '<div class="tg-feed" id="tg-feed-' + ctx + '" aria-live="polite">';
    if (!msgs.length && !MS.mem.tgStart) html += '<div class="tg-system">Aún no hay mensajes</div>';
    msgs.forEach(function (m) {
      if (m.from === 'system') { html += '<div class="tg-system">' + esc(m.text) + '</div>'; return; }
      html += '<div class="tg-msg' + (m.from === 'me' ? ' me' : '') + '">' + esc(m.text);
      if (m.changes && m.changes.length) html += '\n' + esc(m.changes.map(function (c) { return c.field === 'services.add' ? '+ ' + c.after : (c.field === 'services.remove' ? '− ' + c.before : c.label + ': ' + c.before + ' → ' + c.after); }).join('\n'));
      if (m.actions && m.actions.length) {
        html += '<div class="kb">' + m.actions.map(function (a, i) {
          var used = m.used !== undefined && m.used !== false && a.act !== 'open' && a.act !== 'text';
          var lbl = (used && m.used === i ? '✓ ' : '') + a.label;
          return '<button type="button" data-action="convo-act" data-ch="tg" data-msg="' + m.id + '" data-i="' + i + '"' + (used && a.act !== 'approve' && a.act !== 'approve-yes' ? ' disabled' : '') + '>' + esc(lbl) + '</button>';
        }).join('') + '</div>';
      }
      html += '<span class="tm">' + MS.time(m.at) + '</span></div>';
    });
    if (MS.mem.typing.tg) html += '<div class="tg-msg" aria-label="MainSpot está escribiendo">escribiendo…</div>';
    if (MS.mem.tgStart && !linked) {
      html += '<div class="tg-system">Abriste el chat de MainSpot desde tu panel</div>';
      html += '<div class="tg-start"><button type="button" class="btn" data-action="tg-start">Iniciar</button></div>';
    }
    html += '</div>';
    if (linked && MS.can('request')) {
      html += '<div class="tg-suggest" aria-label="Ideas para escribir">' + ['Agrega pan de muerto', '¿Qué horario tengo?', 'El domingo no abrimos'].map(function (s) {
        return '<button type="button" data-action="tg-suggest" data-arg="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('') + '</div>';
    }
    html += '<form class="tg-input" data-form="tg-send"><label class="sr-only" for="tg-input-' + ctx + '">Mensaje para MainSpot</label><input class="input" id="tg-input-' + ctx + '" name="msg" autocomplete="off" placeholder="Escribe un mensaje"><button class="icon-btn" type="submit" aria-label="Enviar mensaje">' + icon('send') + '</button></form>';
    return html + '</div>';
  };

  /* ---------- Hoja inferior / diálogo ---------- */
  var openSheet = null;
  UI.sheet = function (o) {
    UI.closeSheet();
    var opener = document.activeElement;
    var wrap = document.createElement('div');
    wrap.className = 'scrim';
    wrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="grabber" aria-hidden="true"></div><h2 id="sheet-title" tabindex="-1">' + esc(o.title) + '</h2><div class="sheet-body">' + (o.html || '<p>' + esc(o.body || '') + '</p>') + '</div><div class="btn-row">' +
      (o.actions || []).map(function (a, i) {
        return '<button type="button" class="btn btn-' + (a.style || 'secondary') + '" data-sheet="' + i + '">' + (a.icon ? icon(a.icon) : '') + '<span>' + esc(a.label) + '</span></button>';
      }).join('') + '</div></div>';
    document.body.appendChild(wrap);
    openSheet = { el: wrap, opener: opener, o: o };
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) { UI.closeSheet(); return; }
      var b = e.target.closest('[data-sheet]');
      if (!b) return;
      var a = o.actions[+b.getAttribute('data-sheet')];
      if (a.keepOpen) { a.fn && a.fn(b); return; }
      UI.closeSheet(true);
      if (a.fn) a.fn();
    });
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); UI.closeSheet(); }
      if (e.key === 'Tab') {
        var f = wrap.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    var firstBtn = wrap.querySelector('[data-sheet]');
    (firstBtn || wrap.querySelector('#sheet-title')).focus();
  };
  UI.closeSheet = function (keepFocus) {
    if (!openSheet) return;
    var s = openSheet;
    openSheet = null;
    s.el.remove();
    if (!keepFocus && s.opener && document.body.contains(s.opener)) s.opener.focus();
  };

  /* ---------- Mensaje flotante ---------- */
  var toastTimer;
  UI.toast = function (text, ic) {
    var w = document.getElementById('toasts');
    if (!w) return;
    w.innerHTML = '<div class="toast">' + icon(ic || 'circle-check') + '<span>' + esc(text) + '</span></div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { w.innerHTML = ''; }, 3400);
  };
})();
