/* =====================================================================
   MainSpot · Prototipo · Enrutador, acciones y arranque
   Rutas con #hash para que «Atrás» del navegador funcione.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var V = MS.views, UI = MS.ui;
  var app, lastPath = null, lastMsgCount = -1;

  /* ---------- Rutas ---------- */
  function parseHash() {
    var h = (location.hash || '').replace(/^#/, '') || '/';
    var i = h.indexOf('?');
    var path = i >= 0 ? h.slice(0, i) : h;
    var q = {};
    if (i >= 0) h.slice(i + 1).split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); });
    return { path: path, parts: path.split('/').filter(Boolean), q: q, raw: '#' + h };
  }

  function redirect(h) { history.replaceState(null, '', h); return resolve(parseHash()); }

  function resolve(r) {
    var S = MS.S, p = r.parts, q = r.q;
    var needAuth = ['inicio', 'negocio', 'telegram', 'chat', 'cambios', 'vista-previa', 'aprobado', 'pagina', 'sitio', 'avisos'];
    if (needAuth.indexOf(p[0]) >= 0 && !S.session) return redirect(S.account.activated ? '#/entrar' : '#/');
    switch (p[0]) {
      case undefined: return V.hub();
      case 'admin': return V.admin();
      case 'invitacion': return V.invite(p[1] || '', q);
      case 'activar':
        if (p[1] === 'contrasena') {
          if (S.account.activated) return redirect(S.session ? '#/activar/negocio' : '#/entrar');
          if (S.invite.status !== 'sent') return redirect('#/invitacion/' + S.invite.code);
          return V.password();
        }
        if (!S.session) return redirect('#/entrar');
        if (p[1] === 'negocio') return V.business();
        if (p[1] === 'telegram') return V.onbTelegram();
        return redirect('#/inicio');
      case 'entrar': return S.session ? redirect('#/inicio') : V.login();
      case 'inicio': return V.home();
      case 'negocio': return p[1] === 'plan' ? V.plan() : V.biz();
      case 'telegram': return V.telegram(q);
      case 'chat': return V.chat(q);
      case 'cambios':
        if (!p[1]) return V.changes();
        if (p[1] === 'historial') return V.changes('historial');
        if (p[1] === 'nuevo') return V.ask();
        return V.changeDetail(p[1]);
      case 'vista-previa': return V.preview(p[1], q);
      case 'aprobado': return V.approved(p[1]);
      case 'pagina': return V.page();
      case 'sitio': return V.site();
      case 'avisos': return V.notices(q);
      default:
        return { title: 'No encontrado', shell: !!S.session, tab: '', html: UI.empty('No encontramos esta pantalla', 'Puede que el enlace esté incompleto.', UI.btn('Ir al inicio', { href: S.session ? '#/inicio' : '#/' })) };
    }
  }

  /* ---------- Render ---------- */
  function captureInputs() {
    var vals = {}, active = document.activeElement, focus = null;
    app.querySelectorAll('input[id], textarea[id]').forEach(function (el) {
      if (el.type === 'radio' || el.type === 'checkbox') return;
      vals[el.id] = el.value;
    });
    if (active && active.id && app.contains(active)) focus = { id: active.id, s: active.selectionStart, e: active.selectionEnd };
    return { vals: vals, focus: focus };
  }
  function restoreInputs(c) {
    Object.keys(c.vals).forEach(function (id) { var el = document.getElementById(id); if (el && !el.readOnly) el.value = c.vals[id]; });
    if (c.focus) {
      var el = document.getElementById(c.focus.id);
      if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(c.focus.s, c.focus.e); } catch (e) { /* no aplica */ } }
    }
  }

  function render(routeChanged) {
    var r = parseHash();
    if (routeChanged && r.parts[0] !== 'chat') MS.mem.lastHash = r.raw;
    var view = resolve(r);
    var html;
    if (view.chat) {
      // El chat se abre encima de la pantalla anterior.
      var baseHash = MS.mem.lastHash && MS.mem.lastHash.indexOf('#/chat') !== 0 ? MS.mem.lastHash : (MS.S.session ? '#/inicio' : '#/');
      var keep = location.hash;
      history.replaceState(null, '', baseHash);
      var base = resolve(parseHash());
      history.replaceState(null, '', keep);
      var wideAside = base.shell !== false && window.matchMedia('(min-width: 1280px)').matches;
      // En escritorio ancho el chat ya vive en la columna derecha: no se abre encima.
      html = (base.shell === false ? base.html : MS.shell(base)) + (wideAside ? '' : view.html);
      view.asideChat = wideAside;
    } else {
      html = view.shell === false ? view.html : MS.shell(view);
    }
    var c = routeChanged ? { vals: {}, focus: null } : captureInputs();
    var scrollY = window.scrollY;
    app.innerHTML = html;
    document.title = (view.title ? view.title + ' | ' : '') + 'MainSpot';
    document.body.classList.toggle('no-nav', view.shell === false && !view.chat);
    document.body.classList.toggle('chat-open', !!view.chat && !view.asideChat);
    document.body.classList.toggle('has-aside', !!app.querySelector('.aside'));
    document.body.classList.toggle('hide-notes', !MS.S.demo.notes);
    restoreInputs(c);
    var pp = document.getElementById('p-pass');
    if (pp) pp.dispatchEvent(new Event('input', { bubbles: true }));
    var feeds = app.querySelectorAll('.tg-feed');
    feeds.forEach(function (f) { var sc = f.closest('.tg'); if (sc) sc.scrollTop = sc.scrollHeight; });
    if (routeChanged) {
      window.scrollTo(0, 0);
      var target = view.chat ? app.querySelector(view.asideChat ? '#tg-input-aside' : '#tg-input-full') : app.querySelector('[data-focus]');
      if (target) target.focus({ preventScroll: true });
      lastMsgCount = -1;
    } else {
      window.scrollTo(0, scrollY);
    }
    if (view.convo) {
      var count = MS.S.convo[view.convo].length + (MS.mem.typing[view.convo] ? 1 : 0);
      if (count !== lastMsgCount) { window.scrollTo(0, document.body.scrollHeight); lastMsgCount = count; }
    }
    var tb = document.getElementById('topbar');
    if (tb) tb.classList.toggle('scrolled', window.scrollY > 4);
    if (MS.demo) MS.demo.render();
    lastPath = r.raw;
  }
  MS.render = render;

  /* ---------- Atajos de la demo: llevar el estado al punto necesario ---------- */
  MS.ff = function (level) {
    var S = MS.S;
    if (!S.account.activated) {
      if (S.invite.status === 'not_sent') S.invite.status = 'sent';
      S.invite.status = 'used';
      S.account.activated = true;
      S.account.activatedAt = Date.now();
      S.trialStart = Date.now();
      S.tour.admin = S.tour.admin || Date.now();
      S.tour.activated = Date.now();
    }
    S.session = true;
    S.onboardingDone = true;
    var first = S.requests.filter(function (r) { return r.kind === 'first'; })[0];
    if (!first) {
      first = { id: MS.id('r'), kind: 'first', title: 'Tu primera página', channel: 'mainspot', text: '', by: 'MainSpot', changes: [], status: 'preview_ready', createdAt: Date.now(), revision: 1, events: [], preview: { readyAt: Date.now(), expiresAt: Date.now() + 3600000, rev: 1 } };
      MS.addEvent(first, 'Preparamos la primera página con los datos del alta', 'MainSpot');
      S.requests.push(first);
    }
    if (level === 'live' && !S.site.published) {
      var admin = MS.DATA.people.administration.name;
      first.status = 'published';
      first.approvedBy = admin;
      first.approvedAt = Date.now();
      first.publishedAt = Date.now();
      first.version = 1;
      MS.addEvent(first, '[Aprobaste|Aprobó] el cambio desde el panel', admin);
      MS.addEvent(first, 'Comprobamos que la página funciona y quedó publicada (versión 1)', 'MainSpot');
      S.site.published = MS.clone(S.biz);
      S.site.versions.unshift({ n: 1, at: Date.now(), by: admin, title: 'Tu primera página', data: MS.clone(S.biz), reqId: first.id });
      S.site.pub = { reqId: first.id, kind: 'first', step: 'ACTIVE', state: 'done', attempts: 1, doneAt: 0 };
      S.tour.live = Date.now();
    }
  };

  /* ---------- Acciones ---------- */
  function go(h) { if (location.hash === h) render(true); else location.hash = h; }
  MS.go = go;

  var A = (MS.actions = {
    go: function (el) { go(el.dataset.arg); },
    'hub-continue': function () {
      var S = MS.S;
      if (S.session) go(S.onboardingDone ? '#/inicio' : '#/activar/negocio');
      else if (S.account.activated) go('#/entrar');
      else if (S.invite.status === 'sent') go('#/invitacion/' + S.invite.code);
      else go('#/admin');
    },
    'demo-reset': function () { MS.reset(); MS.syncNames(); go('#/'); UI.toast('Reiniciamos la demo'); },
    copy: function (el) {
      var t = el.dataset.arg;
      try { if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {}); } catch (e) { /* sin portapapeles */ }
      UI.toast('Copiado: ' + t, 'copy');
    },
    'invite-revoke': function () {
      UI.sheet({ title: '¿Anular esta invitación?', body: 'El enlace dejará de funcionar. Quien lo abra verá que ya no es válido.', actions: [
        { label: 'Sí, anular', style: 'danger-solid', fn: function () { MS.S.invite.status = 'revoked'; MS.emit(); UI.toast('Invitación anulada'); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    'invite-new': function () { MS.S.invite = { status: 'sent', sentAt: Date.now(), code: 'R' + Math.floor(100 + Math.random() * 899) + '-PL' }; MS.emit(); UI.toast('Creamos una invitación nueva'); },
    'toggle-pass': function (el) {
      var inp = document.getElementById(el.dataset.arg);
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      el.setAttribute('aria-pressed', String(show));
      el.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
      el.innerHTML = MS.icon(show ? 'eye-off' : 'eye');
    },
    'chip-toggle': function (el) {
      var on = el.getAttribute('aria-pressed') !== 'true';
      el.setAttribute('aria-pressed', String(on));
      el.classList.toggle('is-on', on);
      el.innerHTML = MS.icon(on ? 'check' : 'plus') + MS.esc(el.dataset.arg);
      var err = document.getElementById('b-services-err'); if (err) err.hidden = true;
    },
    'onb-telegram': function () { MS.S.onboardingDone = true; MS.tg.generate(); go('#/telegram?desde=alta'); },
    'onb-skip': function () { MS.S.onboardingDone = true; MS.emit(); go('#/inicio'); UI.toast('Puedes conectar Telegram cuando quieras desde tu panel', 'info'); },
    'onb-finish': function () { MS.S.onboardingDone = true; MS.emit(); go('#/inicio'); },
    forgot: function () {
      UI.sheet({ title: 'Recupera tu acceso', html: '<p>Pide ayuda al equipo de MainSpot y te ayudarán a crear una contraseña nueva.</p>' + UI.note('El proceso de recuperación está por definir.'), actions: [{ label: 'Entendido', style: 'primary' }] });
    },
    'dash-retry': function () {
      MS.S.demo.dashError = false; MS.S.demo.dashLoading = true; MS.emit();
      MS.later('dash', 1300, function () { MS.S.demo.dashLoading = false; MS.emit(); });
    },
    'ask-chip': function (el) { var t = document.getElementById('home-ask'); if (t) { t.value = el.dataset.arg; t.focus(); } },
    renew: function (el) { MS.renewPreview(el.dataset.arg); go('#/vista-previa/' + el.dataset.arg); UI.toast('Estamos preparando una nueva vista previa', 'hourglass'); },
    'convo-act': function (el) { MS.convoAct(el.dataset.ch, el.dataset.msg, +el.dataset.i); },
    'tg-start': function () { MS.tg.start(MS.mem.tgStart); },
    'tg-close': function () { MS.mem.tgStart = null; go(MS.mem.lastHash && MS.mem.lastHash.indexOf('#/chat') !== 0 ? MS.mem.lastHash : '#/telegram'); },
    'tg-suggest': function (el) { MS.send('tg', el.dataset.arg); },
    'tg-generate': function () { MS.tg.generate(); UI.toast('Generamos un código nuevo', 'refresh-cw'); },
    'tg-revoke': function () { MS.tg.revoke(); UI.toast('Anulaste el código. Ya no funciona.', 'circle-x'); },
    'tg-unlink': function () {
      UI.sheet({ title: '¿Desconectar Telegram?', body: 'Ya no podrás pedir cambios ni recibir avisos por ese chat. Puedes volver a conectarlo cuando quieras.', actions: [
        { label: 'Sí, desconectar', style: 'danger-solid', fn: function () { MS.tg.unlink(); UI.toast('Desconectaste Telegram'); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    logout: function () { MS.S.session = false; MS.emit(); go('#/entrar'); UI.toast('Cerraste tu sesión', 'log-out'); },
    contact: function () {
      UI.sheet({ title: 'Contactar a MainSpot', html: '<p>Le avisaremos al equipo de MainSpot que quieres seguir haciendo cambios. Te contactarán con los datos de tu cuenta.</p>' + UI.note('El canal de contacto y las opciones de plan están por definir.'), actions: [
        { label: 'Pedir que me contacten', style: 'primary', fn: function () { UI.toast('Listo. Avisamos al equipo de MainSpot.'); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    'approve-ask': function (el) {
      var r = MS.req(el.dataset.arg);
      if (!r) return;
      var first = r.kind === 'first';
      UI.sheet({
        title: first ? '¿Publicar tu página?' : '¿Publicar este cambio?',
        html: (first ? '<p>Tu página quedará en internet en unos minutos, en ' + MS.esc(MS.DATA.address) + '.</p>' : '<div style="margin-bottom:12px">' + UI.diff(r.changes) + '</div><p>Tu página se actualizará en unos minutos.</p>') +
          '<p>Quedará registrado que tú, ' + MS.esc(MS.me().name) + ', lo aprobaste.</p>',
        actions: [
          { label: 'Sí, publicar', style: 'primary', fn: function () {
            var res = MS.approve(r.id, 'panel');
            if (res.ok) { MS.emit(); go('#/aprobado/' + r.id); }
            else { UI.toast(res.message, 'info'); MS.emit(); }
          } },
          { label: 'Todavía no', style: 'secondary' }]
      });
    },
    adjust: function (el) { MS.adjust(el.dataset.arg); go('#/cambios/nuevo'); },
    'reject-ask': function (el) {
      var id = el.dataset.arg;
      UI.sheet({ title: '¿Descartar este cambio?', body: 'Tu página seguirá igual. Si cambias de opinión, puedes pedirlo de nuevo.', actions: [
        { label: 'Sí, descartar', style: 'danger-solid', fn: function () { MS.reject(id, 'panel'); go('#/cambios/' + id); UI.toast('Descartaste el cambio. Tu página sigue igual.'); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    'pub-retry': function () { MS.publish.retryNow(); UI.toast('Lo estamos intentando de nuevo', 'refresh-cw'); },
    'restore-ask': function (el) {
      var n = +el.dataset.arg;
      UI.sheet({ title: '¿Volver a la versión ' + n + '?', body: 'Prepararemos una vista previa con la versión ' + n + '. Tu página no cambia hasta que la apruebes.', actions: [
        { label: 'Preparar vista previa', style: 'primary', fn: function () { var r = MS.restoreVersion(n); MS.emit(); if (r) go('#/vista-previa/' + r.id); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    'notices-read': function () { MS.S.notices.forEach(function (n) { n.read = true; }); MS.emit(); UI.toast('Marcaste todo como leído'); },
    'notice-open': function (el) {
      var n = MS.S.notices.filter(function (x) { return x.id === el.dataset.arg; })[0];
      if (!n) return;
      n.read = true; MS.emit();
      go(n.route || '#/avisos');
    }
  });

  /* ---------- Formularios ---------- */
  function setError(id, msg) {
    var f = document.getElementById('f-' + id);
    var inp = document.getElementById(id);
    if (!f || !inp) return;
    var prev = f.querySelector('.field-error');
    if (prev) prev.remove();
    f.classList.toggle('has-error', !!msg);
    if (msg) {
      var e = document.createElement('div');
      e.className = 'field-error';
      e.id = id + '-err';
      e.innerHTML = MS.icon('circle-alert') + '<span>' + MS.esc(msg) + '</span>';
      f.appendChild(e);
      inp.setAttribute('aria-invalid', 'true');
      var d = (inp.getAttribute('aria-describedby') || '').split(' ').filter(function (x) { return x && x !== id + '-err'; });
      d.push(id + '-err');
      inp.setAttribute('aria-describedby', d.join(' '));
    } else {
      inp.removeAttribute('aria-invalid');
    }
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = MS.icon('loader-circle', 'spinner') + '<span>' + MS.esc(label || 'Un momento…') + '</span>'; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  var F = {
    admin: function (form) {
      var biz = val('a-biz'), owner = val('a-owner'), email = val('a-email'), bad = null;
      setError('a-biz', biz ? '' : 'Escribe el nombre del negocio.');
      setError('a-owner', owner ? '' : 'Escribe el nombre de la persona propietaria.');
      setError('a-email', /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? '' : 'Escribe un correo válido, por ejemplo nombre@correo.mx.');
      bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      var btn = document.getElementById('admin-submit');
      busy(btn, true, 'Creando…');
      setTimeout(function () {
        var S = MS.S;
        S.biz.name = biz;
        S.owner = { name: owner, short: /guadalupe/i.test(owner) ? 'Lupita' : owner.split(' ')[0], email: email };
        S.invite = { status: 'sent', sentAt: Date.now(), code: S.invite.code };
        MS.syncNames();
        MS.tourDone('admin');
        MS.emit();
        UI.toast('Invitación lista para ' + owner);
      }, 900);
    },
    password: function (form) {
      var v = document.getElementById('p-pass').value, v2 = document.getElementById('p-pass2').value;
      var rq = MS.passReqs(v);
      setError('p-pass', !v ? 'Escribe una contraseña.' : (!(rq.len && rq.num && rq.let) ? 'Tu contraseña todavía no cumple lo de la lista.' : ''));
      var okRules = v && rq.len && rq.num && rq.let;
      setError('p-pass2', !okRules ? '' : (!v2 ? 'Escribe la contraseña otra vez.' : (v2 !== v ? 'Las contraseñas no coinciden. Escríbela igual en los dos campos.' : '')));
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      busy(document.getElementById('pass-submit'), true, 'Guardando…');
      setTimeout(function () {
        var S = MS.S;
        MS.mem.password = v; // solo en memoria, nunca se guarda
        S.invite.status = 'used';
        S.account.activated = true;
        S.account.activatedAt = Date.now();
        S.trialStart = Date.now();
        S.session = true;
        S.role = 'administration';
        MS.tourDone('activated');
        MS.emit();
        go('#/activar/negocio');
        UI.toast('Tu contraseña quedó guardada');
      }, 800);
    },
    business: function (form) {
      var phone = val('b-phone'), digits = phone.replace(/\D/g, '');
      setError('b-phone', digits.length === 10 ? '' : 'Escribe los 10 dígitos del teléfono, sin espacios o con espacios.');
      setError('b-address', val('b-address') ? '' : 'Escribe la dirección para que tus clientes te encuentren.');
      setError('b-line', val('b-line') ? '' : 'Escribe una frase corta, por ejemplo qué vendes.');
      ['b-hw', 'b-hs', 'b-hd'].forEach(function (id) { setError(id, val(id) ? '' : 'Escribe el horario o «Cerrado».'); });
      var chosen = Array.prototype.map.call(form.querySelectorAll('#b-services [aria-pressed="true"]'), function (b) { return b.dataset.arg; });
      var err = document.getElementById('b-services-err');
      err.hidden = chosen.length > 0;
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      if (!chosen.length) { form.querySelector('#b-services .chip').focus(); return; }
      busy(document.getElementById('biz-submit'), true, 'Guardando…');
      setTimeout(function () {
        var b = MS.S.biz;
        b.line = val('b-line'); b.phone = digits.slice(0, 2) + ' ' + digits.slice(2, 6) + ' ' + digits.slice(6);
        b.address = val('b-address');
        b.hours = { week: val('b-hw'), sat: val('b-hs'), sun: val('b-hd') };
        b.services = chosen;
        MS.createFirstPage();
        MS.emit();
        go('#/activar/telegram');
        UI.toast('Guardamos los datos de tu negocio');
      }, 700);
    },
    login: function (form) {
      var email = val('l-email').toLowerCase(), pass = document.getElementById('l-pass').value;
      var err = document.getElementById('login-error');
      err.hidden = true;
      setError('l-email', email ? '' : 'Escribe tu correo.');
      setError('l-pass', pass ? '' : 'Escribe tu contraseña.');
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      var btn = document.getElementById('login-submit');
      busy(btn, true, 'Entrando…');
      setTimeout(function () {
        var S = MS.S;
        var roles = {}; roles[MS.DATA.owner.email.toLowerCase()] = 'administration'; roles['tono@ejemplo.mx'] = 'operation'; roles['rosa@ejemplo.mx'] = 'read_only';
        var role = roles[email];
        var okPass = role === 'administration' && MS.mem.password ? pass === MS.mem.password : pass.length >= 8;
        if (!S.account.activated || !role || !okPass) {
          busy(btn, false);
          err.hidden = false;
          err.focus && err.setAttribute('tabindex', '-1');
          err.focus();
          return;
        }
        S.session = true; S.role = role; S.onboardingDone = true;
        MS.emit();
        go('#/inicio');
        UI.toast('Hola de nuevo, ' + MS.me().short);
      }, 700);
    },
    ask: function (form) {
      var t = document.getElementById('home-ask');
      var text = t.value.trim();
      if (!text) { t.focus(); UI.toast('Escribe qué quieres cambiar', 'info'); return; }
      t.value = '';
      MS.S.adjusting = null;
      go('#/cambios/nuevo');
      MS.send('panel', text);
    },
    'panel-send': function (form) {
      var t = document.getElementById('panel-input');
      var text = t.value.trim();
      if (!text) { t.focus(); return; }
      t.value = '';
      MS.send('panel', text);
    },
    'tg-send': function (form) {
      var inp = form.querySelector('input');
      var text = inp.value.trim();
      if (!text) { inp.focus(); return; }
      inp.value = '';
      var t = MS.S.telegram;
      if (t.status !== 'linked' && t.code && text.replace(/\D/g, '') === t.code.replace(/\D/g, '')) { MS.tg.start(t.code, text); return; }
      MS.send('tg', text);
    }
  };

  /* ---------- Delegación de eventos ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var name = el.dataset.action;
    var fn = A[name] || (MS.demo && MS.demo.actions[name]);
    if (fn) { e.preventDefault(); fn(el, e); }
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    var fn = F[f.dataset.form];
    if (fn) fn(f, e);
  });
  document.addEventListener('input', function (e) {
    if (e.target.dataset && e.target.dataset.live === 'pass-reqs') {
      var rq = MS.passReqs(e.target.value);
      Object.keys(rq).forEach(function (k) {
        var li = document.querySelector('[data-req="' + k + '"]');
        if (li) { li.classList.toggle('ok', rq[k]); }
      });
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'panel-input') {
      e.preventDefault();
      var f = e.target.closest('form');
      if (f) f.requestSubmit ? f.requestSubmit() : F['panel-send'](f);
    }
  });
  window.addEventListener('scroll', function () {
    var tb = document.getElementById('topbar');
    if (tb) tb.classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  /* ---------- Contadores (código de Telegram, reintento) ---------- */
  setInterval(function () {
    var needs = false;
    document.querySelectorAll('[data-countdown]').forEach(function (el) {
      var ts = +el.getAttribute('data-countdown');
      el.textContent = MS.countdown(ts);
      if (ts - Date.now() <= 0 && el.getAttribute('data-on-zero')) needs = true;
    });
    if (needs) MS.emit();
  }, 1000);

  /* ---------- Arranque ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    app = document.getElementById('app');
    MS.syncNames();
    MS.on(function () { render(false); });
    window.addEventListener('hashchange', function () { UI.closeSheet(true); render(true); });
    // Solo se vuelve a dibujar si cambia la presencia del chat lateral (≥1280 px);
    // así abrir el teclado en el celular no reinicia formularios.
    var wasWide = window.matchMedia('(min-width: 1280px)').matches, resizeT;
    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(function () {
        var wide = window.matchMedia('(min-width: 1280px)').matches;
        if (wide !== wasWide) { wasWide = wide; render(false); }
      }, 200);
    });
    MS.publish.resume();
    MS.mem.lastHash = location.hash && location.hash.indexOf('#/chat') !== 0 ? location.hash : null;
    render(true);
  });
})();
