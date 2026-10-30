/* =====================================================================
   MainSpot · Enrutador, acciones y arranque (API real, DEV-E2E-03)
   Rutas con #hash para que «Atrás» del navegador funcione. Cada acción
   llama a la API; el estado se vuelve a leer del backend (MS.refresh).
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var V = MS.views, UI = MS.ui, API = MS.api;
  var app, lastMsgCount = -1;

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

  var NEED_AUTH = ['inicio', 'negocio', 'telegram', 'chat', 'cambios', 'vista-previa', 'aprobado', 'pagina', 'sitio', 'avisos', 'google', 'facebook', 'atencion', 'caso'];
  function resolve(r) {
    var S = MS.S, p = r.parts, q = r.q;
    if (S.booting) return { title: 'MainSpot', shell: false, html: '<div class="ob"><div class="ob-wrap"><main class="ob-body" id="main" aria-busy="true"><h1 tabindex="-1" data-focus>Cargando MainSpot…</h1></main></div></div>' };
    if (NEED_AUTH.indexOf(p[0]) >= 0 && !S.session) return redirect('#/entrar');
    switch (p[0]) {
      case undefined: return redirect(S.session ? '#/inicio' : '#/entrar');
      case 'invitacion': return V.invite();
      case 'activar':
        if (p[1] === 'contrasena') return S.session ? redirect('#/activar/negocio') : V.password();
        if (!S.session) return redirect('#/entrar');
        if (p[1] === 'negocio') return V.business();
        if (p[1] === 'telegram') return V.onbTelegram();
        return redirect('#/inicio');
      case 'entrar': return S.session ? redirect('#/inicio') : V.login();
      case 'recuperar': return S.session ? redirect('#/inicio') : V.forgot();
      case 'restablecer': return V.reset();
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
      case 'pagina': return p[1] === 'crear' ? V.business({ shell: true }) : V.page();
      case 'sitio': return V.site();
      case 'avisos': return V.notices(q);
      case 'google': return V.google(q);
      case 'facebook':
        if (p[1] === 'nueva') return V.fbNew();
        if (p[1] === 'post') return V.fbPost(p[2]);
        return V.facebook(q);
      case 'atencion': return p[1] === 'reglas' ? V.rules() : V.attention(q);
      case 'caso': return V.caseView(p[1]);
      default:
        return { title: 'No encontrado', shell: !!S.session, tab: '', html: UI.empty('No encontramos esta pantalla', 'Puede que el enlace esté incompleto.', UI.btn('Ir al inicio', { href: S.session ? '#/inicio' : '#/entrar' })) };
    }
  }

  /* ---------- Render ---------- */
  function captureInputs() {
    var vals = {}, active = document.activeElement, focus = null;
    app.querySelectorAll('input[id], textarea[id], select[id]').forEach(function (el) {
      if (el.type === 'radio' || el.type === 'checkbox') return;
      vals[el.id] = el.value;
    });
    if (active && active.id && app.contains(active)) focus = { id: active.id, s: active.selectionStart, e: active.selectionEnd };
    return { vals: vals, focus: focus };
  }
  function restoreInputs(c) {
    Object.keys(c.vals).forEach(function (id) { var el = document.getElementById(id); if (el && !el.readOnly && el.tagName !== 'SELECT') el.value = c.vals[id]; });
    if (c.focus) {
      var el = document.getElementById(c.focus.id);
      if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(c.focus.s, c.focus.e); } catch (e) { /* no aplica */ } }
    }
  }

  function render(routeChanged) {
    if (!app) return;
    var r = parseHash();
    if (routeChanged && r.parts[0] !== 'chat') MS.mem.lastHash = r.raw;
    var view = resolve(r);
    var html;
    if (view.chat) {
      // El chat se abre encima de la pantalla anterior.
      var baseHash = MS.mem.lastHash && MS.mem.lastHash.indexOf('#/chat') !== 0 ? MS.mem.lastHash : (MS.S.session ? '#/inicio' : '#/entrar');
      var keep = location.hash;
      history.replaceState(null, '', baseHash);
      var base = resolve(parseHash());
      history.replaceState(null, '', keep);
      var wideAside = base.shell !== false && MS.S.dev.telegram && window.matchMedia('(min-width: 1280px)').matches;
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
    restoreInputs(c);
    var pp = document.getElementById('p-pass');
    if (pp) pp.dispatchEvent(new Event('input', { bubbles: true }));
    app.querySelectorAll('.tg-feed').forEach(function (f) { var sc = f.closest('.tg'); if (sc) sc.scrollTop = sc.scrollHeight; });
    if (routeChanged) {
      window.scrollTo(0, 0);
      var target = view.chat ? app.querySelector(view.asideChat ? '#tg-input-aside' : '#tg-input-full') : app.querySelector('[data-focus]');
      if (target) target.focus({ preventScroll: true });
      lastMsgCount = -1;
    } else {
      window.scrollTo(0, scrollY);
    }
    if (view.convo) {
      var count = MS.S.convo[view.convo].length + (MS.mem.local[view.convo] || []).length + (MS.mem.typing[view.convo] ? 1 : 0);
      if (count !== lastMsgCount) { window.scrollTo(0, document.body.scrollHeight); lastMsgCount = count; }
    }
    var tb = document.getElementById('topbar');
    if (tb) tb.classList.toggle('scrolled', window.scrollY > 4);
    if (routeChanged && r.q.ir) {
      var tgt = document.getElementById(r.q.ir);
      if (tgt) { tgt.scrollIntoView({ block: 'start' }); var f = tgt.querySelector('input:checked, input, select, button'); if (f) f.focus({ preventScroll: true }); }
    }
  }
  MS.render = render;

  /* ---------- Utilidades de acciones ---------- */
  function go(h) { if (location.hash === h) render(true); else location.hash = h; }
  MS.go = go;
  function toast(t, ic) { UI.toast(t, ic); }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = MS.icon('loader-circle', 'spinner') + '<span>' + MS.esc(label || 'Un momento…') + '</span>'; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  /** Bloquea el botón mientras la API responde (evita dobles clics). */
  function withBusy(el, label, p) {
    busy(el, true, label);
    return p.then(function (r) { if (document.body.contains(el)) busy(el, false); return r; });
  }
  function connectionRequest(el, provider, action, body) {
    return withBusy(el, 'Conectando…', API.post('/connections/' + provider + '/' + action, body)).then(function (r) {
      if (!r.ok) { toast(r.error.message, 'info'); return r; }
      return MS.refresh([provider === 'google' ? 'googleConn' : 'metaConn', 'gbp', 'phones'], true).then(function () { return r; });
    });
  }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function showBanner(id, msg) {
    var b = document.getElementById(id), t = document.getElementById(id + '-text');
    if (!b) { toast(msg, 'info'); return; }
    if (t) t.textContent = msg;
    b.hidden = false;
    b.setAttribute('tabindex', '-1');
    b.focus();
  }

  /** Publicación de Facebook por Administración: aprobar → vista previa → publicar (simulado). */
  function publishPost(postId) {
    return API.post('/social/posts/' + encodeURIComponent(postId) + '/approve').then(function (res) {
      if (!res.ok) return res;
      var pid = res.data.proposal_id;
      return API.post('/conversation/proposals/' + pid + '/confirm').then(function (c) {
        if (!c.ok && c.status !== 409) return c;
        return API.post('/conversation/proposals/' + pid + '/approve');
      });
    });
  }

  var A = (MS.actions = {
    go: function (el) { go(el.dataset.arg); },
    copy: function (el) {
      var t = el.dataset.arg;
      try { if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {}); } catch (e) { /* sin portapapeles */ }
      toast('Copiado: ' + t, 'copy');
    },
    'toggle-pass': function (el) {
      var inp = document.getElementById(el.dataset.arg);
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      el.setAttribute('aria-pressed', String(show));
      el.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
      el.innerHTML = MS.icon(show ? 'eye-off' : 'eye');
    },
    'chip-toggle': function (el) {
      var d = MS.mem.bizDraft;
      if (d) d.services = d.services.filter(function (s) { return s !== el.dataset.arg; });
      MS.emit();
    },
    'service-add': function () {
      var inp = document.getElementById('b-service'), v = inp ? inp.value.trim() : '';
      if (!v) { if (inp) inp.focus(); return; }
      var d = MS.mem.bizDraft || (MS.mem.bizDraft = { services: [] });
      if (d.services.indexOf(v) < 0 && d.services.length < 12) d.services.push(v);
      inp.value = '';
      MS.emit();
      var again = document.getElementById('b-service'); if (again) { again.value = ''; again.focus(); }
    },
    'onb-telegram': function (el) {
      withBusy(el, 'Generando…', MS.tg.generate()).then(function (r) { if (r.ok) go('#/telegram?desde=alta'); else toast(r.message, 'info'); });
    },
    'onb-skip': function () { go('#/inicio'); toast('Puedes conectar Telegram cuando quieras desde tu panel', 'info'); },
    'onb-finish': function () { go('#/inicio'); },
    /* DS-05a: volver a pedir el enlace (el anterior deja de valer en el servidor). */
    'forgot-again': function () { MS.mem.forgotDone = null; MS.emit(); },
    'dash-retry': function (el) { withBusy(el, 'Cargando…', MS.boot()); },
    'ask-chip': function (el) { var t = document.getElementById('home-ask'); if (t) { t.value = el.dataset.arg; t.focus(); } },
    renew: function (el) {
      go('#/cambios/nuevo');
      MS.renewPreview(el.dataset.arg).then(function (r) { if (!r.ok) toast(r.message, 'info'); });
    },
    'convo-act': function (el) { MS.convoAct(el.dataset.ch, el.dataset.msg, +el.dataset.i); },
    'tg-start': function () { MS.tg.start(MS.mem.tgStart); },
    'tg-close': function () { MS.mem.tgStart = null; go(MS.mem.lastHash && MS.mem.lastHash.indexOf('#/chat') !== 0 ? MS.mem.lastHash : '#/telegram'); },
    'tg-suggest': function (el) { MS.tg.send(el.dataset.arg); },
    'tg-generate': function (el) { withBusy(el, 'Generando…', MS.tg.generate()).then(function (r) { toast(r.ok ? 'Generamos un código nuevo' : r.message, r.ok ? 'refresh-cw' : 'info'); }); },
    'tg-revoke': function (el) { withBusy(el, 'Anulando…', MS.tg.revoke()).then(function (r) { toast(r.ok ? 'Anulaste el código. Ya no funciona.' : r.message, r.ok ? 'circle-x' : 'info'); }); },
    'tg-unlink': function () {
      UI.sheet({ title: '¿Desconectar Telegram?', body: 'Ya no recibirás avisos ni podrás decidir casos por ese chat. Los casos siguen en tu panel.', actions: [
        { label: 'Sí, desconectar', style: 'danger-solid', fn: function () { MS.tg.unlink().then(function (r) { toast(r.ok ? 'Desconectaste Telegram' : r.message, r.ok ? 'circle-check' : 'info'); }); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    logout: function () {
      API.auth('/logout').then(function () {
        MS.endSession();
        go('#/entrar');
        toast('Cerraste tu sesión', 'log-out');
      });
    },
    contact: function () {
      UI.sheet({ title: 'Contactar a MainSpot', html: '<p>Escríbele al equipo de MainSpot que te dio de alta; te ayudarán con tu plan.</p>', actions: [{ label: 'Entendido', style: 'primary' }] });
    },
    'first-page': function (el) {
      withBusy(el, 'Preparando…', MS.prepareFirstPage()).then(function (r) {
        if (!r.ok) { toast(r.message, 'info'); return; }
        toast('Tu primera página está lista para revisar', 'eye');
        if (r.id) go('#/vista-previa/' + r.id);
      });
    },
    'approve-ask': function (el) {
      var r = MS.req(el.dataset.arg);
      if (!r) return;
      var first = r.kind === 'first';
      var retry = r.status === 'failed';
      UI.sheet({
        title: retry ? '¿Intentar publicar de nuevo?' : (first ? '¿Publicar tu página?' : (r.kind === 'sensitive' ? '¿Aprobar esta decisión?' : '¿Publicar este cambio?')),
        html: (first ? '<p>Tu página se publicará en el entorno de desarrollo' + (MS.DATA.address ? ', en ' + MS.esc(MS.DATA.address) : '') + '.</p>' : (r.changes.length ? '<div style="margin-bottom:12px">' + UI.diff(r.changes) + '</div>' : '<p>' + MS.esc(r.summary) + '</p>')) +
          '<p>Quedará registrado que tú, ' + MS.esc(MS.me().name) + ', lo aprobaste.</p>',
        actions: [
          { label: retry ? 'Sí, intentar' : 'Sí, publicar', style: 'primary', fn: function () {
            MS.approve(r.id).then(function (res) {
              if (res.ok) {
                MS.notices_markRoute('#/vista-previa/' + r.id);
                if (res.message) toast(res.message, 'info');
                go(r.kind === 'sensitive' ? '#/cambios/' + r.id : '#/aprobado/' + r.id);
                return;
              }
              toast(res.message, 'info');
              if (res.code === 'website_missing') go('#/pagina/crear');
            });
          } },
          { label: 'Todavía no', style: 'secondary' }]
      });
    },
    'reject-ask': function (el) {
      var id = el.dataset.arg;
      UI.sheet({ title: '¿Descartar este cambio?', body: 'Tu página seguirá igual. Si cambias de opinión, puedes pedirlo de nuevo.', actions: [
        { label: 'Sí, descartar', style: 'danger-solid', fn: function () {
          MS.reject(id).then(function (res) {
            if (!res.ok) { toast(res.message, 'info'); return; }
            go('#/cambios/' + id);
            toast('Descartaste el cambio. Tu página sigue igual.');
          });
        } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    'notices-read': function () { MS.markRead(MS.S.notices.map(function (n) { return n.id; })); MS.emit(); toast('Marcaste todo como leído'); },
    'notice-open': function (el) {
      var n = MS.S.notices.filter(function (x) { return x.id === el.dataset.arg; })[0];
      if (!n) return;
      MS.markRead([n.id]);
      go(n.route || '#/avisos');
    },
    /* --- Teléfonos por integración --- */
    'ph-save': function (el) {
      var ch = el.dataset.arg;
      if (ch === 'primary') {
        withBusy(el, 'Guardando…', MS.ph.savePrimary()).then(function (r) {
          MS.emit();
          if (r.ok) toast('Guardamos tu número principal. ' + (r.changed.length ? 'Cambia en: ' + r.changed.map(function (c) { return MS.ph.CH[c].label; }).join(', ') + '.' : 'Ningún canal lo usa ahora.') + (r.kept.length ? ' No cambia: ' + r.kept.map(function (c) { return MS.ph.CH[c].label; }).join(', ') + '.' : ''));
          else { var inp = document.getElementById('ph-num-primary'); if (inp) inp.focus(); }
        });
        return;
      }
      withBusy(el, 'Guardando…', MS.ph.saveChannel(ch)).then(function (res) {
        MS.emit();
        if (res.ok) {
          var others = MS.ph.ORDER.filter(function (c) { return c !== ch; }).map(function (c) { return MS.ph.CH[c].label; }).join(' ni ');
          toast('Guardamos el teléfono de ' + MS.ph.CH[ch].label + '. No cambia ' + others + '.');
        } else { var n = document.getElementById('ph-num-' + ch); if (n) n.focus(); }
      });
    },
    'ph-cancel': function (el) { MS.ph.resetDraft(el.dataset.arg); MS.emit(); },
    'ph-clear': function (el) {
      var ch = el.dataset.arg;
      UI.sheet({ title: '¿Borrar el otro número de ' + MS.ph.CH[ch].label + '?', body: 'Ya no lo guardaremos. Los otros canales no cambian.', actions: [
        { label: 'Sí, borrarlo', style: 'danger-solid', fn: function () { MS.ph.clearOther(ch).then(function (r) { MS.emit(); toast(r.ok ? 'Borramos ese número' : r.error, r.ok ? 'circle-check' : 'info'); }); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    'ph-web-publish': function (el) {
      withBusy(el, 'Preparando…', MS.prepareWebPhone()).then(function (r) {
        if (!r.ok) { toast(r.message, 'info'); return; }
        toast('Preparamos la vista previa con el número nuevo', 'eye');
        if (r.id) go('#/vista-previa/' + r.id);
      });
    },
    /* --- Restaurar una versión de la página (DEV-E2E-04 P3): confirmación → vista previa «actual vs
       solicitada» → aprobación de Administración. Nada cambia en la página hasta aprobar. --- */
    'restore-ask': function (el) {
      var n = Number(el.dataset.arg), S = MS.S;
      var cur = S.website ? Number(S.website.published_version) : 0;
      if (!n || !cur) return;
      var v = S.site.versions.filter(function (x) { return x.n === n; })[0];
      UI.sheet({
        title: '¿Restaurar la versión ' + n + '?',
        html: '<p>Prepararemos una vista previa para comparar tu página de hoy (versión ' + cur + ') con la versión ' + n + (v ? ' («' + MS.esc(v.title) + '»)' : '') + '.</p>' +
          '<p>Se publicará como una versión nueva solo cuando ' + (MS.can('approve') ? 'tú la apruebes' : 'Administración la apruebe') + '. El historial no se borra ni se reescribe.</p>',
        actions: [
          { label: 'Sí, preparar la vista previa', style: 'primary', fn: function () {
            MS.restoreVersion(n, cur).then(function (r) {
              if (!r.ok) { toast(r.message, 'info'); if (r.code === 'stale_version') MS.refresh(['website', 'proposals', 'requests'], true); return; }
              toast('Vista previa lista: compara la versión actual con la solicitada', 'eye');
              if (r.id) go('#/vista-previa/' + r.id);
            });
          } },
          { label: 'Cancelar', style: 'secondary' }]
      });
    },
    /* --- Conexiones reales por negocio (OAuth, sin tokens en el navegador) --- */
    'gbp-connect': function (el) {
      connectionRequest(el, 'google', 'start').then(function (r) { if (r.ok) location.assign(r.data.authorization_url); });
    },
    'gbp-locations': function (el) {
      withBusy(el, 'Consultando…', API.get('/connections/google/locations')).then(function (r) {
        if (!r.ok) { toast(r.error.message, 'info'); return; }
        MS.mem.gbpLocations = r.data; MS.emit();
      });
    },
    'gbp-pick-location': function (el) {
      var parts = el.dataset.arg.split('|');
      connectionRequest(el, 'google', 'location', { account: parts[0], location: parts[1] });
    },
    'gbp-verify-conn': function (el) { connectionRequest(el, 'google', 'verify'); },
    'gbp-disconnect': function (el) {
      UI.sheet({ title: '¿Desconectar Google?', body: 'MainSpot dejará de leer y responder reseñas y borrará las credenciales de este negocio.', actions: [
        { label: 'Desconectar', style: 'danger', fn: function () { connectionRequest(el, 'google', 'disconnect'); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    'meta-connect': function (el) {
      connectionRequest(el, 'meta', 'start').then(function (r) { if (r.ok) location.assign(r.data.url); });
    },
    'meta-pages': function (el) {
      withBusy(el, 'Consultando…', API.get('/connections/meta/pages')).then(function (r) {
        if (!r.ok) { toast(r.error.message, 'info'); return; }
        MS.mem.metaPages = r.data.pages; MS.emit();
      });
    },
    'meta-pick-page': function (el) { connectionRequest(el, 'meta', 'select', { page_id: el.dataset.arg }); },
    'meta-verify': function (el) { connectionRequest(el, 'meta', 'verify'); },
    'meta-disconnect': function (el) {
      UI.sheet({ title: '¿Desconectar Facebook?', body: 'MainSpot dejará de publicar y responder en esta página y borrará las credenciales del negocio.', actions: [
        { label: 'Desconectar', style: 'danger', fn: function () { connectionRequest(el, 'meta', 'disconnect'); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    /* --- Ficha Google (estado de sincronización suministrado por la API) --- */
    'gbp-edit': function () { MS.mem.gbpEdit = true; MS.emit(); },
    'gbp-cancel': function () { MS.mem.gbpEdit = false; MS.emit(); },
    'gbp-verify': function (el) {
      withBusy(el, 'Verificando…', API.post('/google/profile/simulate-verification')).then(function (r) {
        MS.refresh(['gbp'], true);
        toast(r.ok ? 'Verificación simulada lista' : r.error.message, r.ok ? 'circle-check' : 'info');
      });
    },
    /* --- Facebook --- */
    'fb-when': function (el) { if (MS.mem.fbDraft) { MS.mem.fbDraft.when = el.dataset.arg; var tx = document.getElementById('fb-text'); if (tx) MS.mem.fbDraft.text = tx.value; MS.emit(); } },
    'fb-back': function () { if (MS.mem.fbDraft) MS.mem.fbDraft.step = 'write'; MS.emit(); },
    'fb-approve': function (el) {
      var p = MS.fb.get(el.dataset.arg);
      UI.sheet({ title: p.scheduledFor ? '¿Programar esta publicación?' : '¿Publicar en Facebook?', body: 'Quedará registrado que tú la aprobaste.' + (MS.S.prov.facebook.mode === 'simulated' ? ' (simulado: no se publica nada en Facebook)' : ' El servidor confirmará el resultado con Facebook.'), actions: [
        { label: p.scheduledFor ? 'Sí, programar' : 'Sí, publicar', style: 'primary', fn: function () {
          publishPost(p.id).then(function (res) {
            MS.refresh(['posts', 'proposals', 'requests'], true);
            toast(res.ok ? (MS.S.prov.facebook.mode === 'simulated' ? (p.scheduledFor ? 'Publicación programada (simulado)' : 'Publicada en Facebook (simulado)') : 'Aprobación guardada: el servidor confirmará la publicación') : res.error.message, res.ok ? 'circle-check' : 'info');
          });
        } },
        { label: 'Todavía no', style: 'secondary' }] });
    },
    'fb-reject': function (el) {
      var p = MS.fb.get(el.dataset.arg);
      API.post('/social/posts/' + encodeURIComponent(p.id) + '/reject').then(function (res) {
        MS.refresh(['posts', 'proposals'], true);
        toast(res.ok ? (p.status === 'scheduled' ? 'Cancelaste la programación' : 'Descartaste la publicación') : res.error.message, res.ok ? 'circle-check' : 'info');
      });
    },
    'fb-retry': function (el) {
      var p = MS.fb.get(el.dataset.arg);
      withBusy(el, 'Publicando…', API.post('/conversation/proposals/' + p.proposalId + '/approve')).then(function (res) {
        MS.refresh(['posts', 'proposals'], true);
        toast(res.ok ? 'Solicitud procesada; consulta el estado confirmado de la publicación' : res.error.message, res.ok ? 'circle-check' : 'info');
      });
    },
    /* --- Simulador de desarrollo --- */
    arrive: function (el) {
      withBusy(el, 'Enviando…', MS.devsim.arrive(el.dataset.arg)).then(function (r) {
        toast(r.ok ? 'Llegó algo nuevo (simulado). MainSpot lo atenderá en su próximo ciclo.' : r.message, r.ok ? 'messages-square' : 'info');
      });
    },
    'sim-fault': function (el) { withBusy(el, 'Un momento…', MS.devsim.fault(el.dataset.arg)).then(function (r) { toast(r.ok ? 'Las próximas 3 respuestas a Google fallarán (simulado)' : r.message, 'info'); }); },
    'sim-run': function (el) {
      withBusy(el, 'Procesando…', MS.devsim.run()).then(function (r) {
        toast(r.ok ? 'Ciclo del agente: ' + r.report.classified + ' clasificados, ' + r.report.responded + ' respondidos.' : r.message, 'info');
      });
    },
    /* --- Atención a clientes --- */
    'case-pick': function (el) {
      var parts = el.dataset.arg.split('|'), c = MS.agent.get(parts[0]);
      if (!c) return;
      MS.mem.caseDraft[c.id] = { pick: +parts[1], text: c.drafts[+parts[1]].text };
      var t = document.getElementById('case-text-' + c.id); if (t) t.value = c.drafts[+parts[1]].text;
      MS.emit();
    },
    'case-reject': function (el) {
      var id = el.dataset.arg;
      UI.sheet({ title: '¿No responder?', body: 'No publicaremos ninguna respuesta. La opinión sigue publicada tal cual; MainSpot nunca la oculta ni la borra.', actions: [
        { label: 'Sí, no responder', style: 'primary', fn: function () { MS.agent.reject(id).then(function (r) { toast(r.ok ? (r.message || 'Listo: no responderemos') : r.message, r.ok ? 'circle-check' : 'info'); }); } },
        { label: 'Cancelar', style: 'secondary' }] });
    },
    /* --- Reglas del agente --- */
    'pol-toggle': function () { var d = MS.mem.polDraft; d.enabled = !d.enabled; MS.emit(); },
    'pol-set': function (el) { var p = el.dataset.arg.split('|'); MS.mem.polDraft[p[0]] = p[1]; MS.emit(); },
    'pol-scope': function (el) { var d = MS.mem.polDraft; d.scope[el.dataset.arg] = !d.scope[el.dataset.arg]; MS.emit(); },
    'pol-cancel': function () { MS.mem.polDraft = null; MS.emit(); },
    'pol-save': function () {
      var d = MS.mem.polDraft;
      var changes = MS.agent.policyChanges(d);
      if (!changes.length) { toast('No hay cambios que guardar', 'info'); return; }
      function save() {
        MS.agent.setPolicy(d).then(function (r) {
          MS.mem.polDraft = null;
          MS.emit();
          toast(r.ok ? 'Guardamos tus reglas (versión ' + MS.S.agent.version + ')' : r.message, r.ok ? 'circle-check' : 'info');
        });
      }
      var grants = changes.filter(function (c) { return c.mode === 'safe_auto_reply'; });
      if (!grants.length) { save(); return; }
      UI.sheet({
        title: '¿Autorizas a MainSpot a responder por ti?',
        html: '<p>MainSpot responderá <strong>públicamente y sin preguntarte</strong>, solo en casos seguros, a:</p><ul>' + grants.map(function (g) {
          return '<li>' + MS.esc((g.origin === 'google_review' ? 'Reseñas de Google' : 'Comentarios de Facebook') + ': ' + (g.category === 'gratitude' ? 'agradecimientos y comentarios positivos' : 'preguntas sobre tu negocio con datos que confirmaste')) + '</li>';
        }).join('') + '</ul>' +
          '<p>Nunca responderá quejas, descuentos, acusaciones ni temas delicados sin ti. Puedes apagarlo cuando quieras y verás cada respuesta en tu historial.</p>' +
          '<label class="check" style="margin-top:12px"><input type="checkbox" id="pol-consent"><span>Lo autorizo para ' + MS.esc(MS.DATA.business) + '</span></label>' +
          '<p class="field-error" id="pol-consent-err" hidden>' + MS.icon('circle-alert') + '<span>Marca la casilla para autorizarlo.</span></p>' + UI.note('En los canales conectados, las respuestas autorizadas serán públicas. Los canales en modo simulado no publican fuera de MainSpot.'),
        actions: [
          { label: 'Autorizar y guardar', style: 'primary', keepOpen: true, fn: function () {
            var cb = document.getElementById('pol-consent');
            if (!cb || !cb.checked) { document.getElementById('pol-consent-err').hidden = false; if (cb) cb.focus(); return; }
            UI.closeSheet(true); save();
          } },
          { label: 'Cancelar', style: 'secondary' }]
      });
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

  var F = {
    'fb-write': function () {
      var t = document.getElementById('fb-prompt'), v = t.value.trim();
      if (!v) { t.focus(); toast('Escribe qué quieres publicar', 'info'); return; }
      MS.mem.fbDraft = { prompt: v, text: MS.fb.write(v), step: 'preview', when: 'now' };
      MS.emit();
      var h = document.querySelector('[data-focus]'); if (h) h.focus();
    },
    'fb-confirm': function () {
      var d = MS.mem.fbDraft, text = document.getElementById('fb-text').value.trim();
      d.text = text;
      if (!text) { d.error = 'Escribe el texto de la publicación.'; MS.emit(); return; }
      var at = null;
      if (d.when === 'later') {
        var dd = document.getElementById('fb-date').value, tt = document.getElementById('fb-time').value;
        d.date = dd; d.time = tt;
        if (!dd || !tt) { d.error = 'Elige un día y una hora; el servidor comprobará la zona horaria configurada.'; MS.emit(); return; }
        at = dd + 'T' + tt; // No interpretar en la zona del navegador.
      }
      d.error = '';
      function create() {
        return API.post('/social/posts', { text: text }, { idempotencyKey: API.key() }).then(function (res) {
          if (!res.ok || !at) return res;
          return API.post('/social/posts/' + res.data.post.post_id + '/schedule', { publish_local: dd + 'T' + tt }).then(function (s) { return s.ok ? res : s; });
        });
      }
      if (!MS.can('social.approve')) {
        create().then(function (res) {
          if (!res.ok) { d.error = res.error.message; MS.emit(); return; }
          MS.mem.fbDraft = null;
          MS.refresh(['posts'], true).then(function () { go('#/facebook/post/' + res.data.post.post_id); toast('Enviamos la publicación a aprobación'); });
        });
        return;
      }
      UI.sheet({ title: at ? '¿Programar esta publicación?' : '¿Publicar en Facebook?', body: (at ? 'Se publicará según la zona horaria configurada del negocio. ' : '') + 'Quedará registrado que tú la aprobaste.' + (MS.S.prov.facebook.mode === 'simulated' ? ' (simulado: no se publica nada en Facebook)' : ' El servidor comprobará la publicación antes de marcarla como publicada.'), actions: [
        { label: at ? 'Sí, programar' : 'Sí, publicar', style: 'primary', fn: function () {
          create().then(function (res) {
            if (!res.ok) { d.error = res.error.message; MS.emit(); return null; }
            var postId = res.data.post.post_id;
            return publishPost(postId).then(function (pub) {
              MS.mem.fbDraft = null;
              return MS.refresh(['posts', 'proposals', 'requests'], true).then(function () {
                go('#/facebook/post/' + postId);
                toast(pub.ok ? (MS.S.prov.facebook.mode === 'simulated' ? (at ? 'Publicación programada (simulado)' : 'Publicada en Facebook (simulado)') : 'Aprobación guardada: publicación pendiente de confirmar') : pub.error.message, pub.ok ? 'circle-check' : 'info');
              });
            });
          });
        } },
        { label: 'Todavía no', style: 'secondary' }] });
    },
    'case-reply': function (form) {
      var id = form.dataset.arg, t = document.getElementById('case-text-' + id), text = t.value.trim();
      var c = MS.agent.get(id);
      if (!text) { t.focus(); toast('Escribe la respuesta', 'info'); return; }
      var draft = MS.mem.caseDraft[id] || { pick: 0 };
      if (!MS.can('engagement.approve')) {
        MS.agent.saveDraft(id, draft.pick, text).then(function (r) { toast(r.ok ? 'Guardamos tu propuesta. Quien administra tu negocio decide si se publica.' : r.message, r.ok ? 'circle-check' : 'info'); });
        return;
      }
      function send() {
        var btn = document.getElementById('case-submit');
        withBusy(btn, 'Publicando…', MS.agent.approve(id, text)).then(function (r) {
          delete MS.mem.caseDraft[id];
          MS.notices_markRoute('#/caso/' + id);
          toast(r.ok ? (r.message || 'Respuesta procesada; consulta su estado de entrega') : r.message, r.ok ? 'circle-check' : 'info');
        });
      }
      if (/(descuento|\d+\s*%|gratis|reembolso|te regalamos)/i.test(text)) {
        UI.sheet({ title: 'Revisa tu respuesta', body: 'Parece que ofrece un descuento, algo gratis o un reembolso. MainSpot no lo sugiere; si de verdad lo decidiste, publícalo bajo tu responsabilidad.', actions: [
          { label: 'Publicar así', style: 'primary', fn: send }, { label: 'Volver a editar', style: 'secondary', fn: function () { t.focus(); } }] });
        return;
      }
      UI.sheet({ title: '¿Publicar esta respuesta?', html: '<p>«' + MS.esc(text) + '»</p><p>Se publicará en ' + MS.esc(c ? MS.agent.SRC[c.source].short : 'el canal') + ' a tu nombre. El modo de cada canal indica si es real o simulado.</p>', actions: [
        { label: 'Sí, publicar', style: 'primary', fn: send }, { label: 'Todavía no', style: 'secondary' }] });
    },
    gbp: function (form) {
      var name = val('g-name'), cat = val('g-cat');
      setError('g-name', name ? '' : 'Escribe el nombre como aparece en Google.');
      setError('g-cat', cat ? '' : 'Escribe la categoría principal, por ejemplo «Panadería».');
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      var hours = [];
      function day(id, days) {
        var closed = document.getElementById('g-' + id + '-closed').checked;
        var open = val('g-' + id + '-open'), close = val('g-' + id + '-close');
        days.forEach(function (dd) { hours.push(closed ? { day: dd, closed: true } : { day: dd, open: open, close: close }); });
      }
      day('wk', ['mon', 'tue', 'wed', 'thu', 'fri']); day('sat', ['sat']); day('sun', ['sun']);
      var body = { business_name: name, primary_category: cat, address_line: val('g-addr'), locality: val('g-loc'), hours: hours };
      withBusy(document.getElementById('gbp-submit'), 'Guardando…', API.put('/google/profile', body)).then(function (res) {
        if (!res.ok) { showBanner('gbp-error', res.error.message); return; }
        MS.mem.gbpEdit = false;
        MS.refresh(['gbp', 'phones'], true).then(function () { toast('Solicitud guardada. Consulta qué campos confirmó el proveedor.'); });
      });
    },
    'team-add': function (form) {
      var name = val('t-name'), email = val('t-email').toLowerCase(), pass = document.getElementById('t-pass').value;
      setError('t-name', name ? '' : 'Escribe el nombre de la persona.');
      setError('t-email', /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? '' : 'Escribe un correo válido.');
      setError('t-pass', pass.length >= 8 ? '' : 'La contraseña debe tener al menos 8 caracteres.');
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      withBusy(document.getElementById('team-submit'), 'Agregando…', API.post('/users', { display_name: name, login: email, password: pass, role: document.getElementById('t-role').value })).then(function (res) {
        if (!res.ok) { showBanner('team-error', res.error.message); return; }
        ['t-name', 't-email', 't-pass'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
        MS.refresh(['users'], true).then(function () { toast('Agregamos a ' + name + '. Ya puede entrar con su correo.'); });
      });
    },
    password: function (form) {
      var name = val('p-name');
      var v = document.getElementById('p-pass').value, v2 = document.getElementById('p-pass2').value;
      var rq = MS.passReqs(v);
      setError('p-name', name ? '' : 'Escribe tu nombre.');
      setError('p-pass', !v ? 'Escribe una contraseña.' : (!(rq.len && rq.num && rq.let) ? 'Tu contraseña todavía no cumple lo de la lista.' : ''));
      var okRules = v && rq.len && rq.num && rq.let;
      setError('p-pass2', !okRules ? '' : (!v2 ? 'Escribe la contraseña otra vez.' : (v2 !== v ? 'Las contraseñas no coinciden. Escríbela igual en los dos campos.' : '')));
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      var btn = document.getElementById('pass-submit');
      busy(btn, true, 'Guardando…');
      API.auth('/invitation/accept', { token: MS.mem.invToken, display_name: name, password: v }).then(function (res) {
        if (!res.ok) {
          busy(btn, false);
          if (res.status === 404) { MS.mem.inv = { ok: false, message: res.error.message }; go('#/invitacion'); return null; }
          showBanner('pass-error', res.error.message);
          return null;
        }
        return API.auth('/login', { login: res.data.login, password: v }).then(function (l) {
          if (!l.ok) { busy(btn, false); MS.mem.loginEmail = res.data.login; go('#/entrar'); toast('Tu cuenta está lista. Entra con tu correo y tu contraseña.'); return null; }
          MS.mem.invToken = null;
          MS.mem.inv = null;
          return MS.startSession(l.data.token).then(function () { go('#/activar/negocio'); toast('Tu contraseña quedó guardada'); });
        });
      });
    },
    business: function (form) {
      var inShell = location.hash.indexOf('#/pagina/crear') === 0;
      var needPhone = !!document.getElementById('ph-num-primary');
      var phr = null;
      if (needPhone) {
        var phd = MS.ph.draft('primary');
        phr = MS.ph.parse(phd.iso, phd.nat);
        setError('ph-num-primary', phr.ok ? '' : phr.error);
      }
      setError('b-address', val('b-address') ? '' : 'Escribe la dirección para que tus clientes te encuentren.');
      setError('b-line', val('b-line') ? '' : 'Escribe una frase corta, por ejemplo qué vendes.');
      ['b-hw', 'b-hs', 'b-hd'].forEach(function (id) { setError(id, val(id) ? '' : 'Escribe el horario o «Cerrado».'); });
      var d = MS.mem.bizDraft || { services: [] };
      var pendingService = val('b-service');
      if (pendingService && d.services.indexOf(pendingService) < 0) d.services.push(pendingService);
      var err = document.getElementById('b-services-err');
      err.hidden = d.services.length > 0;
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      if (!d.services.length) { document.getElementById('b-service').focus(); return; }
      var btn = document.getElementById('biz-submit');
      busy(btn, true, 'Guardando…');
      var data = {
        line: val('b-line'), address: val('b-address'),
        hours: 'Lunes a viernes: ' + val('b-hw') + ' · Sábado: ' + val('b-hs') + ' · Domingo: ' + val('b-hd'),
        services: d.services
      };
      (needPhone ? MS.ph.savePrimary() : Promise.resolve({ ok: true })).then(function (p) {
        if (!p.ok) { busy(btn, false); MS.emit(); return null; }
        return MS.createSite(data).then(function (r) {
          if (!r.ok) { busy(btn, false); showBanner('biz-error', r.message); return; }
          MS.mem.bizDraft = null;
          toast('Guardamos los datos de tu negocio. Tu primera página está lista para revisar.');
          go(inShell ? (r.id ? '#/vista-previa/' + r.id : '#/pagina') : '#/activar/telegram');
        });
      });
    },
    login: function (form) {
      var email = val('l-email').toLowerCase(), pass = document.getElementById('l-pass').value;
      document.getElementById('login-error').hidden = true;
      setError('l-email', email ? '' : 'Escribe tu correo.');
      setError('l-pass', pass ? '' : 'Escribe tu contraseña.');
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      var body = { login: email, password: pass };
      var picked = form.querySelector('input[name="l-tenant"]:checked');
      if (picked && MS.mem.tenantChoice) body.tenant_id = picked.value;
      var btn = document.getElementById('login-submit');
      busy(btn, true, 'Entrando…');
      API.auth('/login', body).then(function (res) {
        if (res.status === 409 && res.data && res.data.tenants) {
          busy(btn, false);
          MS.mem.tenantChoice = res.data.tenants;
          MS.mem.loginEmail = email;
          MS.mem.loginError = res.error.message;
          MS.emit();
          return;
        }
        if (!res.ok) {
          busy(btn, false);
          showBanner('login-error', res.status === 401 ? 'El correo o la contraseña no son correctos. Revísalos e inténtalo de nuevo.' : res.error.message);
          return;
        }
        MS.mem.tenantChoice = null;
        MS.mem.loginError = null;
        MS.mem.loginEmail = null;
        MS.startSession(res.data.token).then(function (ok) {
          if (!ok) { showBanner('login-error', 'No pudimos abrir tu sesión. Inténtalo de nuevo.'); return; }
          go('#/inicio');
          toast('Hola de nuevo, ' + MS.me().short);
        });
      });
    },
    ask: function () {
      var t = document.getElementById('home-ask');
      var text = t.value.trim();
      if (!text) { t.focus(); toast('Escribe qué quieres cambiar', 'info'); return; }
      t.value = '';
      go('#/cambios/nuevo');
      MS.send('panel', text);
    },
    'panel-send': function () {
      var t = document.getElementById('panel-input');
      var text = t.value.trim();
      if (!text || MS.mem.typing.panel) { t.focus(); return; }
      t.value = '';
      MS.send('panel', text);
    },
    'tg-send': function (form) {
      var inp = form.querySelector('input');
      var text = inp.value.trim();
      if (!text) { inp.focus(); return; }
      inp.value = '';
      var t = MS.S.telegram;
      // Escribir solo el código equivale a /start CÓDIGO (como en el bot).
      if (t.status !== 'linked' && t.code && text.replace(/\s+/g, '').toUpperCase() === t.code) { MS.tg.start(t.code); return; }
      MS.tg.send(text);
    },
    /* DS-05a: la respuesta es la misma exista o no el correo; solo se muestra lo que dice el servidor. */
    forgot: function (form) {
      var email = val('fg-email').toLowerCase();
      document.getElementById('forgot-error').hidden = true;
      setError('fg-email', /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? '' : 'Escribe el correo con el que entras a MainSpot.');
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      var btn = document.getElementById('forgot-submit');
      busy(btn, true, 'Enviando…');
      API.auth('/password/forgot', { login: email }).then(function (res) {
        if (!res.ok) { busy(btn, false); showBanner('forgot-error', res.error.message); return; }
        MS.mem.loginEmail = email;
        MS.mem.forgotDone = { message: res.data && res.data.message ? res.data.message : 'Si ese correo tiene una cuenta en MainSpot, recibirás un mensaje con un enlace para crear una contraseña nueva.' };
        MS.emit();
      });
    },
    /* DS-05b: contraseña nueva con el token en memoria (nunca en sessionStorage ni localStorage). */
    reset: function (form) {
      var v = document.getElementById('p-pass').value, v2 = document.getElementById('p-pass2').value;
      var rq = MS.passReqs(v);
      document.getElementById('reset-error').hidden = true;
      setError('p-pass', !v ? 'Escribe una contraseña.' : (!(rq.len && rq.num && rq.let) ? 'Tu contraseña todavía no cumple lo de la lista.' : ''));
      var okRules = v && rq.len && rq.num && rq.let;
      setError('p-pass2', !okRules ? '' : (!v2 ? 'Escribe la contraseña otra vez.' : (v2 !== v ? 'Las contraseñas no coinciden. Escríbela igual en los dos campos.' : '')));
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) { bad.focus(); return; }
      var btn = document.getElementById('reset-submit');
      busy(btn, true, 'Guardando…');
      API.auth('/password/reset', { token: MS.mem.resetToken, password: v }).then(function (res) {
        if (!res.ok) {
          busy(btn, false);
          if (res.status === 404) { MS.mem.resetToken = null; MS.mem.resetInvalid = res.error.message; MS.emit(); return; }
          showBanner('reset-error', res.error.message);
          return;
        }
        MS.mem.resetToken = null;
        MS.mem.resetInvalid = null;
        MS.mem.forgotDone = null;
        go('#/entrar');
        toast(res.data && res.data.message ? res.data.message : 'Tu contraseña cambió. Entra con tu correo y tu contraseña nueva.', 'circle-check');
      });
    }
  };

  /** DS-02: valida el enlace de invitación (respuesta neutra si no sirve). */
  MS.loadInvitation = function () {
    if (MS.mem.invLoading) return;
    MS.mem.invLoading = true;
    API.auth('/invitation', { token: MS.mem.invToken }).then(function (res) {
      MS.mem.invLoading = false;
      MS.mem.inv = res.ok ? { ok: true, business_name: res.data.business_name, expires_at: res.data.expires_at } : { ok: false, message: res.error.message };
      MS.emit();
    });
  };

  /* ---------- Delegación de eventos ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var fn = A[el.dataset.action];
    if (fn) { if (el.tagName !== 'INPUT') e.preventDefault(); fn(el, e); }
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
      if (f) { if (f.requestSubmit) f.requestSubmit(); else F['panel-send'](f); }
    }
    if (e.key === 'Enter' && e.target.id === 'b-service') { e.preventDefault(); A['service-add'](); }
  });
  window.addEventListener('scroll', function () {
    var tb = document.getElementById('topbar');
    if (tb) tb.classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  /* ---------- Contadores (código de Telegram, reintentos) ---------- */
  setInterval(function () {
    var needs = false;
    document.querySelectorAll('[data-countdown]').forEach(function (el) {
      var ts = +el.getAttribute('data-countdown');
      el.textContent = MS.countdown(ts);
      if (ts - Date.now() <= 0 && el.getAttribute('data-on-zero')) needs = true;
    });
    if (needs) { MS.derive(); MS.emit(); }
  }, 1000);

  /* ---------- Sondeo del backend (worker, Telegram, otras sesiones) ---------- */
  setInterval(function () { MS.poll(); }, 5000);
  setInterval(function () {
    if (!MS.S.session || document.visibilityState !== 'visible') return;
    var chatVisible = location.hash.indexOf('#/chat') === 0 || !!document.querySelector('.aside .tg');
    var tgPending = MS.S.telegram.status === 'code';
    if ((chatVisible && MS.S.dev.telegram) || tgPending) MS.refresh(['tgChat', 'telegram', 'cases']);
    if (MS.mem.fastPoll && Date.now() < MS.mem.fastPoll) MS.refresh(['cases']);
  }, 2000);

  /* ---------- Arranque ---------- */
  API.onUnauthorized = function () {
    if (!MS.S.session) return;
    MS.endSession();
    go('#/entrar');
    toast('Tu sesión terminó. Entra de nuevo para continuar.', 'log-out');
  };

  document.addEventListener('DOMContentLoaded', function () {
    app = document.getElementById('app');
    // Enlace de invitación (/invitacion#TOKEN): el token queda solo en memoria y sale de la barra.
    if (location.pathname === '/invitacion') {
      var h = location.hash.replace(/^#/, '');
      if (h && h.charAt(0) !== '/') MS.mem.invToken = h;
      history.replaceState(null, '', '/panel#/invitacion');
    }
    // Enlace de contraseña nueva (/restablecer#TOKEN): igual que la invitación, solo en memoria.
    if (location.pathname === '/restablecer') {
      var rh = location.hash.replace(/^#/, '');
      if (rh && rh.charAt(0) !== '/') MS.mem.resetToken = rh;
      history.replaceState(null, '', '/panel#/restablecer');
    }
    MS.on(function () { render(false); });
    window.addEventListener('hashchange', function () { UI.closeSheet(true); render(true); });
    // Solo se vuelve a dibujar si cambia la presencia del chat lateral (≥1280 px).
    var wasWide = window.matchMedia('(min-width: 1280px)').matches, resizeT;
    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(function () {
        var wide = window.matchMedia('(min-width: 1280px)').matches;
        if (wide !== wasWide) { wasWide = wide; render(false); }
      }, 200);
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') MS.poll(); });
    MS.mem.lastHash = location.hash && location.hash.indexOf('#/chat') !== 0 ? location.hash : null;
    render(true);
    MS.boot().then(function () { render(true); });
  });
})();
