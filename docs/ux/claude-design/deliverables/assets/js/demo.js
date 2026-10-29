/* =====================================================================
   MainSpot · Prototipo · Herramienta de demostración «Probar estados»
   NO es parte del producto. Permite saltar a pantallas y forzar casos
   alternativos (errores, vencimientos, permisos) sin tocar código.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var esc = MS.esc, icon = MS.icon, UI = MS.ui;
  var root;
  var open = false;

  var TOUR = [
    ['admin', 'Dar de alta el negocio', '#/admin'],
    ['activated', 'Activar la cuenta con la invitación', null],
    ['telegram', 'Conectar Telegram', '#/telegram'],
    ['live', 'Aprobar y publicar la primera página', null],
    ['changePublished', 'Pedir un cambio desde el panel y publicarlo', '#/cambios/nuevo'],
    ['tgPublished', 'Pedir un cambio desde Telegram y publicarlo', '#/chat']
  ];

  var SCREENS = [
    ['DS-01', 'Alta administrada'], ['DS-02', 'Invitación'], ['DS-03', 'Contraseña y datos'], ['DS-04', 'Entrar'],
    ['DS-05', 'Inicio'], ['DS-06', 'Mi negocio y plan'], ['DS-07', 'Telegram'], ['DS-08', 'Pedir un cambio'],
    ['DS-09', 'Vista previa'], ['DS-10', 'Aprobación'], ['DS-11', 'Mi página'], ['DS-12', 'Avisos']
  ];

  function b(label, action, arg, pressed, ds) {
    return '<button type="button" class="dp-btn' + (action === 'demo-reset' ? ' dp-reset' : '') + '" data-action="' + action + '"' + (arg != null ? ' data-arg="' + esc(arg) + '"' : '') + (pressed != null ? ' aria-pressed="' + !!pressed + '"' : '') + '>' + (ds ? '<span class="ds">' + ds + '</span>' : '') + esc(label) + '</button>';
  }

  function panel() {
    var S = MS.S;
    var next = TOUR.filter(function (t) { return !S.tour[t[0]]; })[0];
    return '<div class="demo-panel on-dark" role="dialog" aria-modal="false" aria-labelledby="dp-title">' +
      '<div class="dp-head"><div class="dp-tape" aria-hidden="true"></div><div class="dp-title"><h2 id="dp-title">Probar estados</h2><button type="button" class="icon-btn" data-action="demo-close" aria-label="Cerrar herramienta de demostración">' + icon('x') + '</button></div>' +
      '<p class="dp-sub">Herramienta de demostración. No es parte de MainSpot.</p></div>' +
      '<section><h3>Recorrido sugerido</h3><ul class="tour">' + TOUR.map(function (t) {
        var d = !!S.tour[t[0]];
        return '<li class="' + (d ? 'done' : '') + '"><span class="tk" aria-hidden="true">' + (d ? icon('check') : '') + '</span>' + esc(t[1]) + '<span class="sr-only">' + (d ? ' (hecho)' : '') + '</span></li>';
      }).join('') + '</ul>' + (next ? '<p class="small" style="margin-top:8px;color:#BDB3D6">Siguiente: ' + esc(next[1]) + '</p>' : '<p class="small" style="margin-top:8px;color:#BDB3D6">Recorrido completo.</p>') + '</section>' +
      '<section><h3>Ir a una pantalla</h3><div class="dp-grid">' + SCREENS.map(function (s) { return b(s[1], 'demo-go', s[0], null, s[0]); }).join('') + '</div></section>' +
      '<section><h3>Perfil de quien usa el panel</h3><div class="dp-grid">' +
        b('Administración', 'demo-role', 'administration', S.role === 'administration') + b('Operación', 'demo-role', 'operation', S.role === 'operation') + b('Solo lectura', 'demo-role', 'read_only', S.role === 'read_only') + '</div></section>' +
      '<section><h3>Prueba gratis</h3><div class="dp-grid">' +
        b('Vigente', 'demo-trial', 'active', S.trial === 'active') + b('Por vencer', 'demo-trial', 'ending', S.trial === 'ending') + b('Terminada', 'demo-trial', 'expired', S.trial === 'expired') + '</div></section>' +
      '<section><h3>Invitación</h3><div class="dp-grid">' +
        b('Invitación válida', 'demo-invite', 'valida') + b('Ya usada', 'demo-invite', 'usada') + b('Caducada o anulada', 'demo-invite', 'no-valida') + b('Enlace roto', 'demo-invite', 'rota') + '</div></section>' +
      '<section><h3>Telegram</h3><div class="dp-grid">' +
        b('Código caducado', 'demo-tg', 'expired') + b('Código ya usado', 'demo-tg', 'used') + b('Código anulado', 'demo-tg', 'revoked') + b('Escribe un chat sin conectar', 'demo-tg', 'unlinked-chat') + '</div></section>' +
      '<section><h3>Cambios y publicación</h3><div class="dp-grid">' +
        b('Pedido ambiguo', 'demo-ambiguous') + b('Pregunta simple', 'demo-question') + b('Vencer la vista previa', 'demo-preview-expire') + b('Abrir una vista previa ya usada', 'demo-preview-used') +
        b('Repetir la última aprobación', 'demo-repeat') + b('Fallar la próxima publicación', 'demo-fail', null, S.demo.failNextPublish) + '</div></section>' +
      '<section><h3>Panel</h3><div class="dp-grid">' +
        b('Error al cargar', 'demo-dash-error') + b('Cargando', 'demo-dash-loading') + b('Negocio nuevo, sin página', 'demo-new-biz') + b('Página ya publicada', 'demo-live') + b('Sin avisos', 'demo-notices-clear') + '</div></section>' +
      '<section><h3>Notas de prototipo</h3><div class="dp-grid">' + b('Mostrar notas', 'demo-notes', null, S.demo.notes) + '</div></section>' +
      '<section style="padding-bottom:20px">' + b('Reiniciar la demo', 'demo-reset') + '</section>' +
    '</div>';
  }

  MS.demo = {
    render: function () {
      root = root || document.getElementById('demo-root');
      if (!root) return;
      var hadFocus = root.contains(document.activeElement) ? (document.activeElement.dataset.action + '|' + (document.activeElement.dataset.arg || '')) : null;
      var scroll = root.querySelector('.demo-panel') ? root.querySelector('.demo-panel').scrollTop : 0;
      root.innerHTML = open ? panel() : '<button type="button" class="demo-fab" data-action="demo-open" aria-label="Probar estados (herramienta de demostración)">' + icon('flask-conical') + '<span>Probar estados</span></button>';
      var p = root.querySelector('.demo-panel');
      if (p) p.scrollTop = scroll;
      if (hadFocus) {
        var parts = hadFocus.split('|');
        var el = root.querySelector('[data-action="' + parts[0] + '"]' + (parts[1] ? '[data-arg="' + parts[1] + '"]' : ''));
        if (el) el.focus({ preventScroll: true });
      }
    },
    actions: {}
  };
  var D = MS.demo.actions;
  function close() { open = false; MS.demo.render(); }
  function done(msg) { close(); MS.emit(); if (msg) UI.toast(msg, 'flask-conical'); }

  D['demo-open'] = function () { open = true; MS.demo.render(); var c = root.querySelector('[data-action="demo-close"]'); if (c) c.focus(); };
  D['demo-close'] = function () { close(); var f = root.querySelector('.demo-fab'); if (f) f.focus(); };
  D['demo-reset'] = function () { MS.reset(); MS.syncNames(); open = false; MS.go('#/'); MS.emit(); UI.toast('Reiniciamos la demo'); };

  D['demo-go'] = function (el) {
    var ds = el.dataset.arg, S = MS.S;
    var h = '#/';
    switch (ds) {
      case 'DS-01': h = '#/admin'; break;
      case 'DS-02':
        if (S.account.activated) { h = '#/invitacion/' + S.invite.code; break; }
        if (S.invite.status !== 'sent') S.invite = { status: 'sent', sentAt: Date.now(), code: S.invite.code };
        h = '#/invitacion/' + S.invite.code; break;
      case 'DS-03':
        if (!S.account.activated) { if (S.invite.status !== 'sent') S.invite = { status: 'sent', sentAt: Date.now(), code: S.invite.code }; h = '#/activar/contrasena'; }
        else { S.session = true; h = '#/activar/negocio'; }
        break;
      case 'DS-04': MS.ff('active'); S.session = false; h = '#/entrar'; break;
      case 'DS-05': MS.ff('active'); h = '#/inicio'; break;
      case 'DS-06': MS.ff('active'); h = '#/negocio'; break;
      case 'DS-07': MS.ff('active'); h = '#/telegram'; break;
      case 'DS-08': MS.ff('active'); h = '#/cambios/nuevo'; break;
      case 'DS-09':
        MS.ff('active');
        var ready = S.requests.filter(function (r) { return r.status === 'preview_ready'; })[0];
        if (!ready) { ready = demoChange('Horario del sábado', [{ field: 'hours.sat', label: 'Horario del sábado', before: MS.siteBase().hours.sat, after: '8:00 a 14:00' }], 'El sábado abrimos de 8 a 2'); }
        h = '#/vista-previa/' + ready.id; break;
      case 'DS-10':
        MS.ff('active');
        var ap = S.requests.filter(function (r) { return r.status === 'approved' || r.status === 'published'; })[0];
        if (!ap) {
          var first = S.requests.filter(function (r) { return r.kind === 'first' && r.status === 'preview_ready'; })[0];
          if (first) { S.role = 'administration'; S.trial = S.trial === 'expired' ? 'active' : S.trial; MS.approve(first.id, 'panel'); ap = first; }
        }
        h = ap ? '#/aprobado/' + ap.id : '#/cambios'; break;
      case 'DS-11': MS.ff('active'); h = '#/pagina'; break;
      case 'DS-12': MS.ff('active'); h = '#/avisos'; break;
    }
    close();
    MS.emit();
    MS.go(h);
  };

  /* Crea una solicitud ya lista para revisar (atajo de demo). */
  function demoChange(title, changes, text) {
    var r = { id: MS.id('r'), kind: 'change', title: title, channel: 'panel', text: text, by: MS.DATA.people.administration.name, changes: changes, status: 'preview_ready', createdAt: Date.now(), revision: 1, events: [], preview: { readyAt: Date.now(), expiresAt: Date.now() + 3600000, rev: 1 } };
    MS.addEvent(r, '[Pediste|Pidió] el cambio desde el panel: «' + text + '»', r.by);
    MS.addEvent(r, '[Confirmaste|Confirmó] el cambio', r.by);
    MS.addEvent(r, 'Preparamos la vista previa', 'MainSpot');
    MS.S.requests.unshift(r);
    MS.notify('approval', 'Tienes un cambio esperando tu aprobación', title, '#/vista-previa/' + r.id);
    return r;
  }

  D['demo-role'] = function (el) {
    MS.ff('active');
    MS.S.role = el.dataset.arg;
    var me = MS.me();
    done('Ahora ves el panel como ' + me.name + ' (' + me.role + ')');
    if ((location.hash || '').indexOf('#/inicio') !== 0 && !/vista-previa|cambios|pagina|negocio|telegram|avisos/.test(location.hash)) MS.go('#/inicio');
  };
  D['demo-trial'] = function (el) {
    var t = el.dataset.arg;
    MS.ff('active');
    MS.S.trial = t;
    if (t === 'ending') MS.notify('trial', 'Tu prueba gratis vence en 3 días', 'Después podrás ver tu información; para hacer cambios, contacta a MainSpot.', '#/negocio/plan');
    if (t === 'expired') MS.notify('trial', 'Tu prueba gratis terminó', 'Tus datos se conservan. Para hacer cambios, contacta a MainSpot.', '#/negocio/plan');
    done(t === 'active' ? 'Prueba gratis vigente' : (t === 'ending' ? 'Prueba gratis por vencer' : 'Prueba gratis terminada'));
    if (!/inicio|negocio|vista-previa|cambios/.test(location.hash)) MS.go('#/inicio');
  };
  D['demo-invite'] = function (el) {
    var k = el.dataset.arg, S = MS.S;
    close();
    if (k === 'valida') {
      if (S.account.activated) { UI.toast('La cuenta ya está activa. Reinicia la demo para ver una invitación válida.', 'info'); return; }
      if (S.invite.status !== 'sent') S.invite = { status: 'sent', sentAt: Date.now(), code: S.invite.code };
      MS.emit(); MS.go('#/invitacion/' + S.invite.code); return;
    }
    if (k === 'usada') { MS.go('#/invitacion/' + S.invite.code + '?demo=usada'); return; }
    if (k === 'no-valida') { MS.go('#/invitacion/' + S.invite.code + '?demo=no-valida'); return; }
    MS.go('#/invitacion/ZZ90-XX');
  };
  D['demo-tg'] = function (el) {
    var k = el.dataset.arg, t = MS.S.telegram;
    MS.ff('active');
    if (t.status === 'linked') { t.status = 'unlinked'; }
    if (k === 'unlinked-chat') {
      t.status = 'unlinked'; t.code = null; t.codeState = null;
      close(); MS.emit(); MS.go('#/chat');
      setTimeout(function () { MS.send('tg', 'Hola, quiero cambiar mi horario'); }, 400);
      return;
    }
    MS.tg.force(k);
    close(); MS.go('#/telegram');
  };
  D['demo-ambiguous'] = function () { MS.ff('active'); MS.S.trial = MS.S.trial === 'expired' ? 'active' : MS.S.trial; if (MS.S.role === 'read_only') MS.S.role = 'administration'; MS.S.adjusting = null; close(); MS.emit(); MS.go('#/cambios/nuevo'); setTimeout(function () { MS.send('panel', 'Cambia el horario'); }, 300); };
  D['demo-question'] = function () { MS.ff('active'); if (MS.S.role === 'read_only') MS.S.role = 'administration'; MS.S.adjusting = null; close(); MS.emit(); MS.go('#/cambios/nuevo'); setTimeout(function () { MS.send('panel', '¿Qué horario tengo el sábado?'); }, 300); };
  D['demo-preview-expire'] = function () {
    MS.ff('active');
    var r = MS.S.requests.filter(function (x) { return x.status === 'preview_ready'; })[0];
    if (!r) r = demoChange('Horario del sábado', [{ field: 'hours.sat', label: 'Horario del sábado', before: MS.siteBase().hours.sat, after: '8:00 a 14:00' }], 'El sábado abrimos de 8 a 2');
    MS.expirePreview(r.id);
    close(); MS.emit(); MS.go('#/vista-previa/' + r.id);
  };
  D['demo-preview-used'] = function () {
    MS.ff('live');
    var r = MS.S.requests.filter(function (x) { return x.status === 'published' || x.status === 'approved'; })[0];
    close(); MS.emit();
    if (r) MS.go('#/vista-previa/' + r.id);
  };
  D['demo-repeat'] = function () {
    var r = MS.S.requests.filter(function (x) { return x.status === 'published' || x.status === 'approved'; })[0];
    close();
    if (!r) { UI.toast('Primero aprueba un cambio para probar esto.', 'info'); return; }
    var res = MS.approve(r.id, 'panel');
    UI.toast(res.message, 'info');
  };
  D['demo-fail'] = function () {
    MS.S.demo.failNextPublish = !MS.S.demo.failNextPublish;
    MS.save(); MS.demo.render();
    UI.toast(MS.S.demo.failNextPublish ? 'La próxima publicación fallará una vez y se reintentará' : 'Las publicaciones funcionarán normal', 'flask-conical');
  };
  D['demo-dash-error'] = function () { MS.ff('active'); MS.S.demo.dashError = true; close(); MS.emit(); MS.go('#/inicio'); };
  D['demo-dash-loading'] = function () {
    MS.ff('active'); MS.S.demo.dashLoading = true; close(); MS.emit(); MS.go('#/inicio');
    MS.later('dash', 2500, function () { MS.S.demo.dashLoading = false; MS.emit(); });
  };
  D['demo-new-biz'] = function () { MS.reset(); MS.syncNames(); MS.ff('active'); open = false; MS.emit(); MS.go('#/inicio'); UI.toast('Negocio recién activado, sin página publicada', 'flask-conical'); };
  D['demo-live'] = function () { MS.ff('live'); close(); MS.emit(); MS.go('#/pagina'); };
  D['demo-notices-clear'] = function () { MS.ff('active'); MS.S.notices = []; close(); MS.emit(); MS.go('#/avisos'); };
  D['demo-notes'] = function () { MS.S.demo.notes = !MS.S.demo.notes; MS.emit(); };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open && !document.querySelector('.scrim')) { D['demo-close'](); }
  });
})();
