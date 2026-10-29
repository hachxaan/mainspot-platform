/* =====================================================================
   MainSpot · Prototipo · Vistas de acceso
   Inicio de la demo · DS-01 Alta administrada (demo) · DS-02 Invitación
   DS-03 Contraseña, datos del negocio y Telegram · DS-04 Entrar
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var esc = MS.esc, icon = MS.icon, UI = MS.ui;
  var V = (MS.views = MS.views || {});

  /* Mantiene nombres coherentes si el administrador los cambia en DS-01. */
  MS.syncNames = function () {
    var S = MS.S, o = S.owner || {};
    MS.DATA.business = S.biz.name || 'Panadería Lupita';
    if (o.name) {
      MS.DATA.owner.name = o.name;
      MS.DATA.people.administration.name = o.name;
      MS.DATA.people.administration.short = o.short || o.name.split(' ')[0];
    }
    if (o.email) MS.DATA.owner.email = o.email;
    var slug = MS.DATA.business.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    MS.DATA.address = (slug || 'minegocio') + '.mainspot.ejemplo';
  };

  /* ---------- Inicio de la demo (herramienta, no producto) ---------- */
  V.hub = function () {
    var S = MS.S;
    var started = S.invite.status !== 'not_sent';
    var html = '<div class="hub">' + UI.planes('hub-art') +
      '<main class="hub-body" id="main">' +
      '<span class="demo-label">' + icon('flask-conical', 'ic-sm') + 'Prototipo de demostración</span>' +
      '<h1 tabindex="-1" data-focus>Tu negocio, en su lugar.</h1>' +
      '<p class="ob-lead" style="margin-top:12px">Recorre MainSpot como lo viviría la dueña de <strong>Panadería Lupita</strong>: desde que recibe su invitación hasta que su página está en internet.</p>' +
      '<ol class="hub-journey">' +
        j('El equipo de MainSpot da de alta el negocio', 'Vista de demostración del administrador.') +
        j('Lupita activa su cuenta', 'Abre su invitación, crea su contraseña y revisa sus datos.') +
        j('Conecta su Telegram', 'Para pedir cambios por chat y recibir avisos.') +
        j('Pide un cambio con sus palabras', 'MainSpot explica el cambio y prepara una vista previa.') +
        j('Revisa y decide', 'Nada se publica hasta que ella lo aprueba.') +
        j('Su página llega a internet', 'Con avisos claros si algo falla.') +
      '</ol>' +
      '<div class="ob-actions">' +
        (started ? UI.btn('Continuar donde me quedé', { action: 'hub-continue', block: true, icon: 'chevron-right' }) + UI.btn('Empezar de nuevo', { action: 'demo-reset', style: 'secondary', block: true })
                 : UI.btn('Empezar el recorrido', { href: '#/admin', block: true })) +
      '</div>' +
      '<p class="tiny" style="margin-top:20px">Todos los datos son ficticios. No hay conexión con Telegram, internet ni ningún servicio real. Usa el botón «Probar estados» para ver errores y casos especiales.</p>' +
      '</main></div>';
    return { title: 'Prototipo MainSpot', html: html, shell: false };
    function j(t, d) { return '<li><div><div class="t">' + esc(t) + '</div><div class="d">' + esc(d) + '</div></div></li>'; }
  };

  /* ---------- DS-01 · Alta administrada (vista de demostración) ---------- */
  V.admin = function () {
    var S = MS.S, inv = S.invite, o = S.owner || {};
    var html = '<div class="admin" data-screen="DS-01">' +
      '<div class="admin-top on-dark"><span class="brand"><span class="brand-mark"></span>MainSpot</span><span class="grow tagline">Vista interna del equipo (demo)</span><a class="btn btn-sm btn-ghost" style="color:#fff" href="#/">Salir</a></div>' +
      '<div class="admin-tape" aria-hidden="true"></div>' +
      '<main class="admin-body" id="main">';
    if (inv.status === 'not_sent') {
      html += '<span class="demo-label">' + icon('flask-conical', 'ic-sm') + 'Vista del administrador, solo para la demo</span>' +
        '<h1 tabindex="-1" data-focus style="font-size:var(--fs-2xl)">Dar de alta un negocio</h1>' +
        '<p class="muted" style="margin-top:8px">Registra el negocio y a su dueña o dueño. MainSpot le enviará una invitación que solo funciona una vez.</p>' +
        '<form class="card stack" style="margin-top:20px" data-form="admin" novalidate>' +
          field('a-biz', 'Nombre del negocio', S.biz.name, 'text', 'organization') +
          field('a-owner', 'Nombre de la persona propietaria', o.name || MS.DATA.owner.name, 'text', 'name') +
          field('a-email', 'Correo de la persona propietaria', o.email || MS.DATA.owner.email, 'email', 'email', 'A este correo quedará ligada su cuenta.') +
          '<fieldset class="fieldset field"><legend>Plan</legend>' +
            '<label class="list-row static" style="border:1.5px solid var(--ink);border-radius:var(--r-ctl)"><input type="radio" name="plan" checked style="width:20px;height:20px;accent-color:var(--ink)"> <span class="grow"><span class="title" style="display:block">Prueba gratis (Trial)</span><span class="sub">30 días desde que la cuenta se active. Sin cobros automáticos.</span></span></label>' +
            UI.note('Duración tomada de la propuesta de DEC-0018. Nombres y precios de planes están por definir.') +
          '</fieldset>' +
          '<div class="btn-row">' + UI.btn('Crear negocio e invitación', { type: 'submit', id: 'admin-submit' }) + '</div>' +
        '</form>';
    } else {
      var used = inv.status === 'used', revoked = inv.status === 'revoked';
      html += '<span class="demo-label">' + icon('flask-conical', 'ic-sm') + 'Vista del administrador, solo para la demo</span>' +
        '<div class="card stack" style="margin-top:4px">' +
          '<div class="row"><span class="spot ' + (revoked ? 'spot-none' : 'spot-live') + '" style="width:44px;height:44px">' + icon(revoked ? 'x' : 'check') + '</span><div class="grow"><h1 tabindex="-1" data-focus style="font-size:var(--fs-xl)">' + (revoked ? 'Invitación anulada' : (used ? 'Cuenta activada' : 'Invitación lista')) + '</h1><p class="muted small">' + esc(MS.DATA.business) + ' para ' + esc(MS.DATA.owner.name) + '</p></div></div>' +
          UI.facts([['mail', 'Correo', esc(MS.DATA.owner.email)], ['calendar', 'Plan', 'Prueba gratis (Trial)'], ['link', 'Enlace de invitación (un solo uso)', '<span style="word-break:break-all">mainspot.ejemplo/invitacion/' + esc(inv.code) + '</span>']]) +
          UI.note('El canal para enviar la invitación está por definir (correo es una propuesta, REQ-003).') +
          (used ? '<p class="banner banner-nopal">' + icon('circle-check') + '<span><strong>La invitación ya se usó.</strong>La cuenta está activa. Si alguien la abre otra vez, verá que ya no sirve.</span></p>' : '') +
          (revoked ? '<p class="banner banner-alerta">' + icon('circle-x') + '<span><strong>Esta invitación ya no funciona.</strong>Quien la abra verá un mensaje neutro, sin datos del negocio.</span></p>' : '') +
          '<div class="btn-row">' +
            (!used && !revoked ? UI.btn('Abrir la invitación como ' + MS.DATA.people.administration.short, { href: '#/invitacion/' + inv.code, icon: 'external-link' }) + UI.btn('Copiar enlace', { action: 'copy', arg: 'mainspot.ejemplo/invitacion/' + inv.code, style: 'secondary', icon: 'copy' }) + UI.btn('Anular invitación', { action: 'invite-revoke', style: 'ghost' }) : '') +
            (used ? UI.btn('Abrir la invitación otra vez', { href: '#/invitacion/' + inv.code, style: 'secondary' }) : '') +
            (revoked ? UI.btn('Crear una invitación nueva', { action: 'invite-new' }) + UI.btn('Abrir la invitación anulada', { href: '#/invitacion/' + inv.code, style: 'secondary' }) : '') +
          '</div>' +
        '</div>';
    }
    html += '</main></div>';
    return { title: 'Alta de negocio (demo)', html: html, shell: false };
  };

  function field(id, label, value, type, ac, hint) {
    return '<div class="field" id="f-' + id + '"><label for="' + id + '">' + esc(label) + '</label>' + (hint ? '<span class="hint" id="' + id + '-hint">' + esc(hint) + '</span>' : '') +
      '<input class="input" id="' + id + '" name="' + id + '" type="' + (type || 'text') + '" value="' + esc(value || '') + '"' + (ac ? ' autocomplete="' + ac + '"' : '') + (hint ? ' aria-describedby="' + id + '-hint"' : '') + '></div>';
  }
  MS.field = field;

  /* ---------- DS-02 · Invitación y bienvenida ---------- */
  V.invite = function (code, q) {
    var S = MS.S, inv = S.invite;
    var forced = q && q.demo; // solo herramienta de demostración: «usada» o «no-valida»
    var valid = !forced && inv.status === 'sent' && code === inv.code;
    var used = forced ? forced === 'usada' : (inv.status === 'used' && code === inv.code);
    if (!valid) {
      var t = used ? 'Esta invitación ya se usó' : 'Esta invitación ya no es válida';
      var b = used ? 'Si no fuiste tú, contacta a MainSpot. Si ya activaste tu cuenta, entra con tu correo y contraseña.' : 'Pide una nueva al equipo de MainSpot.';
      var h = '<div class="ob" data-screen="DS-02">' + UI.planes('ob-art') +
        '<div class="ob-wrap"><main class="ob-body" id="main">' +
        '<span class="spot spot-none" style="margin-bottom:20px">' + icon(used ? 'lock' : 'link') + '</span>' +
        '<h1 tabindex="-1" data-focus>' + esc(t) + '</h1>' +
        '<p class="ob-lead">' + esc(b) + '</p>' +
        '<div class="ob-actions">' + UI.btn('Entrar a MainSpot', { href: '#/entrar', block: true, style: used ? 'primary' : 'secondary' }) + '</div>' +
        UI.note('Mismo mensaje neutro para enlaces caducados, anulados o inexistentes: no revela si el negocio existe (NFR-002).') +
        '</main></div></div>';
      return { title: t, html: h, shell: false };
    }
    var html = '<div class="ob" data-screen="DS-02">' + UI.planes('ob-art tall') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' +
      '<h1 tabindex="-1" data-focus>' + esc(MS.DATA.business) + ' ya tiene su lugar en MainSpot</h1>' +
      '<p class="ob-lead">Hola, ' + esc(MS.DATA.people.administration.short) + '. El equipo de MainSpot preparó tu cuenta. En tres pasos la dejas lista.</p>' +
      '<div style="margin-top:24px">' + UI.facts([['mail', 'Tu correo para entrar', esc(MS.DATA.owner.email)], ['calendar', 'Tu plan', 'Prueba gratis hasta el ' + esc(MS.date(MS.trialEnd()))]]) + '</div>' + UI.note('Fecha ficticia: 30 días desde hoy.') +
      '<ol class="hub-journey" style="margin-top:20px" aria-label="Pasos para activar tu cuenta">' +
        '<li><div><div class="t">Crea tu contraseña</div></div></li>' +
        '<li><div><div class="t">Revisa los datos de tu negocio</div></div></li>' +
        '<li><div><div class="t">Conecta tu Telegram</div></div></li>' +
      '</ol>' +
      '<div class="ob-actions">' + UI.btn('Empezar', { href: '#/activar/contrasena', block: true }) +
        '<p class="small center muted">¿Ya activaste tu cuenta? <a href="#/entrar">Entra aquí</a></p></div>' +
      '</main></div></div>';
    return { title: 'Bienvenida a MainSpot', html: html, shell: false };
  };

  function steps(cur) {
    var names = ['Contraseña', 'Tu negocio', 'Telegram'];
    return '<ol class="steps" aria-label="Paso ' + (cur + 1) + ' de 3">' + names.map(function (n, i) {
      return '<li class="' + (i < cur ? 'done' : (i === cur ? 'current' : '')) + '"' + (i === cur ? ' aria-current="step"' : '') + '><span class="bar"></span><span class="lbl">' + esc(n) + '</span></li>';
    }).join('') + '</ol>';
  }

  /* ---------- DS-03a · Crear contraseña ---------- */
  V.password = function () {
    var html = '<div class="ob" data-screen="DS-03">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' + steps(0) +
      '<h1 tabindex="-1" data-focus>Crea tu contraseña</h1>' +
      '<p class="ob-lead">La usarás con tu correo para entrar cuando quieras.</p>' +
      '<form class="stack" style="margin-top:24px" data-form="password" novalidate>' +
        '<div class="field"><label for="p-email">Tu correo</label><input class="input" id="p-email" type="email" value="' + esc(MS.DATA.owner.email) + '" readonly autocomplete="username"></div>' +
        '<div class="field" id="f-p-pass"><label for="p-pass">Contraseña</label>' +
          '<div class="input-wrap"><input class="input" id="p-pass" name="pass" type="password" autocomplete="new-password" aria-describedby="p-reqs" data-live="pass-reqs"><button type="button" class="icon-btn" data-action="toggle-pass" data-arg="p-pass" aria-label="Mostrar contraseña" aria-pressed="false">' + icon('eye') + '</button></div>' +
          '<ul class="req-list" id="p-reqs" aria-label="Tu contraseña necesita">' +
            '<li data-req="len"><span class="dot">' + icon('check') + '</span>Al menos 8 caracteres</li>' +
            '<li data-req="num"><span class="dot">' + icon('check') + '</span>Al menos un número</li>' +
            '<li data-req="let"><span class="dot">' + icon('check') + '</span>Al menos una letra</li>' +
          '</ul>' + UI.note('Reglas de ejemplo; las definitivas están por definir.') +
        '</div>' +
        '<div class="field" id="f-p-pass2"><label for="p-pass2">Escríbela otra vez</label><input class="input" id="p-pass2" name="pass2" type="password" autocomplete="new-password"></div>' +
        '<div class="ob-actions" style="margin-top:8px">' + UI.btn('Guardar contraseña', { type: 'submit', block: true, id: 'pass-submit' }) + '</div>' +
      '</form></main></div></div>';
    return { title: 'Crea tu contraseña', html: html, shell: false };
  };
  MS.passReqs = function (v) { return { len: v.length >= 8, num: /\d/.test(v), let: /[a-záéíóúñ]/i.test(v) }; };

  /* ---------- DS-03b · Datos del negocio ---------- */
  V.business = function () {
    var b = MS.S.biz;
    var all = ['Pan dulce', 'Bolillo y telera', 'Pasteles por encargo', 'Café de olla', 'Galletas', 'Pan integral'];
    b.services.forEach(function (s) { if (all.indexOf(s) < 0) all.push(s); });
    var html = '<div class="ob" data-screen="DS-03">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' + steps(1) +
      '<h1 tabindex="-1" data-focus>Revisa los datos de tu negocio</h1>' +
      '<p class="ob-lead">Con esto preparamos tu página. Podrás cambiarlos cuando quieras.</p>' +
      UI.note('Datos ficticios precargados. Los campos mínimos del alta están por definir (FLOW-005).') +
      '<form class="stack" style="margin-top:20px" data-form="business" novalidate>' +
        '<div class="field"><label for="b-name">Nombre del negocio</label><input class="input" id="b-name" value="' + esc(b.name) + '" readonly><span class="hint">Lo registró el equipo de MainSpot. Si está mal, avísanos.</span></div>' +
        '<div class="field" id="f-b-line"><label for="b-line">Una frase sobre tu negocio</label><input class="input" id="b-line" name="line" value="' + esc(b.line) + '" maxlength="80"></div>' +
        '<div class="field" id="f-b-phone"><label for="b-phone">Teléfono del negocio</label><span class="hint" id="b-phone-hint">10 dígitos. Así te llamarán tus clientes.</span><input class="input" id="b-phone" name="phone" inputmode="tel" autocomplete="tel" value="' + esc(b.phone) + '" aria-describedby="b-phone-hint"></div>' +
        '<div class="field" id="f-b-address"><label for="b-address">Dirección</label><input class="input" id="b-address" name="address" autocomplete="street-address" value="' + esc(b.address) + '"></div>' +
        '<fieldset class="fieldset field"><legend>Horario</legend><span class="hint">Escribe «Cerrado» si ese día no abres.</span><div class="hours-grid" style="margin-top:6px">' +
          hours('b-hw', 'Lunes a viernes', b.hours.week) + hours('b-hs', 'Sábado', b.hours.sat) + hours('b-hd', 'Domingo', b.hours.sun) +
        '</div></fieldset>' +
        '<fieldset class="fieldset field"><legend>¿Qué vendes?</legend><span class="hint">Toca para elegir. Puedes elegir varios.</span><div class="chips" style="margin-top:6px" id="b-services">' +
          all.map(function (s) { var on = b.services.indexOf(s) >= 0; return '<button type="button" class="chip' + (on ? ' is-on' : '') + '" aria-pressed="' + on + '" data-action="chip-toggle" data-arg="' + esc(s) + '">' + (on ? icon('check') : icon('plus')) + esc(s) + '</button>'; }).join('') +
        '</div><div class="field-error" id="b-services-err" hidden>' + icon('circle-alert') + '<span>Elige al menos una cosa que vendas.</span></div></fieldset>' +
        '<div class="ob-actions" style="margin-top:8px">' + UI.btn('Guardar y continuar', { type: 'submit', block: true, id: 'biz-submit' }) + '</div>' +
      '</form></main></div></div>';
    return { title: 'Datos de tu negocio', html: html, shell: false };
    function hours(id, l, v) { return '<div class="field" id="f-' + id + '"><label for="' + id + '" style="font-weight:400;font-size:var(--fs-sm)">' + esc(l) + '</label><input class="input" id="' + id + '" value="' + esc(v) + '"></div>'; }
  };

  /* ---------- DS-03c · Siguiente paso: Telegram ---------- */
  V.onbTelegram = function () {
    var html = '<div class="ob" data-screen="DS-03">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' + steps(2) +
      '<h1 tabindex="-1" data-focus>Te falta un paso: conecta tu Telegram</h1>' +
      '<p class="ob-lead">Así podrás pedir cambios por chat, como le escribes a alguien de confianza, y te avisaremos cuando algo necesite tu atención.</p>' +
      '<div class="convo" style="margin-top:24px" aria-hidden="true">' +
        '<div class="msg me"><div class="bubble">El sábado abrimos de 8 a 2</div></div>' +
        '<div class="msg bot"><div class="bubble">Cambiaremos tu horario del sábado a 8:00 a 14:00. ¿Preparo la vista previa?</div></div>' +
      '</div>' +
      '<div class="ob-actions">' + UI.btn('Conectar Telegram', { action: 'onb-telegram', block: true }) + UI.btn('Lo haré después', { action: 'onb-skip', style: 'secondary', block: true }) + '</div>' +
      '</main></div></div>';
    return { title: 'Conecta tu Telegram', html: html, shell: false };
  };

  /* ---------- DS-04 · Entrar ---------- */
  V.login = function () {
    var html = '<div class="ob" data-screen="DS-04">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' +
      '<h1 tabindex="-1" data-focus>Entra a MainSpot</h1>' +
      '<p class="ob-lead">Con tu correo y tu contraseña.</p>' +
      '<form class="stack" style="margin-top:24px" data-form="login" novalidate>' +
        '<div class="banner banner-alerta" id="login-error" role="alert" hidden>' + icon('circle-alert') + '<span>El correo o la contraseña no son correctos. Revísalos e inténtalo de nuevo.</span></div>' +
        '<div class="field" id="f-l-email"><label for="l-email">Correo</label><input class="input" id="l-email" name="email" type="email" autocomplete="username" value="' + esc(MS.S.account.activated ? MS.DATA.owner.email : '') + '"></div>' +
        '<div class="field" id="f-l-pass"><label for="l-pass">Contraseña</label><div class="input-wrap"><input class="input" id="l-pass" name="pass" type="password" autocomplete="current-password"><button type="button" class="icon-btn" data-action="toggle-pass" data-arg="l-pass" aria-label="Mostrar contraseña" aria-pressed="false">' + icon('eye') + '</button></div></div>' +
        '<div class="ob-actions" style="margin-top:8px">' + UI.btn('Entrar', { type: 'submit', block: true, id: 'login-submit' }) +
          '<button type="button" class="link-btn" style="align-self:center" data-action="forgot">¿Olvidaste tu contraseña?</button></div>' +
        UI.note('Demo: ' + MS.DATA.owner.email + ' (Administración), tono@ejemplo.mx (Operación) o rosa@ejemplo.mx (Solo lectura), con la contraseña que creaste. Si recargaste la página, cualquier contraseña de 8 caracteres funciona.') +
      '</form></main></div></div>';
    return { title: 'Entrar', html: html, shell: false };
  };
})();
