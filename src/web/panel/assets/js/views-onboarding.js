/* =====================================================================
   MainSpot · Vistas de acceso (API real)
   DS-02 Invitación de un solo uso · DS-03 Contraseña, datos del negocio y Telegram
   DS-04 Entrar (correo + contraseña, sin identificador interno)
   El alta del negocio la hace el equipo de MainSpot (CLI invite-owner): no hay
   «vista de administrador» de demostración en el producto.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var esc = MS.esc, icon = MS.icon, UI = MS.ui;
  var V = (MS.views = MS.views || {});

  function field(id, label, value, type, ac, hint) {
    return '<div class="field" id="f-' + id + '"><label for="' + id + '">' + esc(label) + '</label>' + (hint ? '<span class="hint" id="' + id + '-hint">' + esc(hint) + '</span>' : '') +
      '<input class="input" id="' + id + '" name="' + id + '" type="' + (type || 'text') + '" value="' + esc(value || '') + '"' + (ac ? ' autocomplete="' + ac + '"' : '') + (hint ? ' aria-describedby="' + id + '-hint"' : '') + '></div>';
  }
  MS.field = field;

  function neutralInvite(title, body) {
    var h = '<div class="ob" data-screen="DS-02">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' +
      '<span class="spot spot-none" style="margin-bottom:20px">' + icon('link') + '</span>' +
      '<h1 tabindex="-1" data-focus>' + esc(title) + '</h1>' +
      '<p class="ob-lead">' + esc(body) + '</p>' +
      '<div class="ob-actions">' + UI.btn('Entrar a MainSpot', { href: '#/entrar', block: true, style: 'secondary' }) + '</div>' +
      '</main></div></div>';
    return { title: title, html: h, shell: false };
  }

  /* ---------- DS-02 · Invitación y bienvenida (POST /api/auth/invitation) ---------- */
  V.invite = function () {
    var inv = MS.mem.inv;
    if (!MS.mem.invToken) return neutralInvite('Abre de nuevo tu enlace de invitación', 'Por seguridad, el enlace no se guarda. Ábrelo otra vez desde el mensaje que te enviamos o, si ya activaste tu cuenta, entra con tu correo.');
    if (!inv) {
      MS.loadInvitation();
      return { title: 'Revisando tu invitación', shell: false, html: '<div class="ob" data-screen="DS-02">' + UI.planes('ob-art') + '<div class="ob-wrap"><main class="ob-body" id="main" aria-busy="true"><h1 tabindex="-1" data-focus>Revisando tu invitación…</h1><p class="ob-lead">Un momento.</p></main></div></div>' };
    }
    // Misma respuesta neutra para enlaces usados, caducados, anulados o inexistentes (no revela si el negocio existe).
    if (!inv.ok) return neutralInvite('Esta invitación ya no es válida', inv.message || 'Pide una nueva al equipo de MainSpot. Si ya activaste tu cuenta, entra con tu correo y contraseña.');
    var html = '<div class="ob" data-screen="DS-02">' + UI.planes('ob-art tall') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' +
      '<h1 tabindex="-1" data-focus>' + esc(inv.business_name) + ' ya tiene su lugar en MainSpot</h1>' +
      '<p class="ob-lead">El equipo de MainSpot preparó tu cuenta. En tres pasos la dejas lista.</p>' +
      '<div style="margin-top:24px">' + UI.facts([['calendar', 'Esta invitación vence', esc(MS.date(MS.ts(inv.expires_at), true)) + ', ' + esc(MS.time(MS.ts(inv.expires_at)))], ['lock', 'Sirve una sola vez', 'Después entrarás con tu correo y tu contraseña.']]) + '</div>' +
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

  /* ---------- DS-03a · Crear contraseña (POST /api/auth/invitation/accept) ---------- */
  V.password = function () {
    var inv = MS.mem.inv;
    if (!MS.mem.invToken || !inv || !inv.ok) return V.invite();
    var html = '<div class="ob" data-screen="DS-03">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' + steps(0) +
      '<h1 tabindex="-1" data-focus>Crea tu contraseña</h1>' +
      '<p class="ob-lead">La usarás con tu correo para entrar cuando quieras.</p>' +
      '<form class="stack" style="margin-top:24px" data-form="password" novalidate>' +
        '<div class="banner banner-alerta" id="pass-error" role="alert" hidden>' + icon('circle-alert') + '<span id="pass-error-text"></span></div>' +
        field('p-name', 'Tu nombre', '', 'text', 'name', 'Así te saludaremos en tu panel.') +
        '<div class="field" id="f-p-pass"><label for="p-pass">Contraseña</label>' +
          '<div class="input-wrap"><input class="input" id="p-pass" name="pass" type="password" autocomplete="new-password" aria-describedby="p-reqs" data-live="pass-reqs"><button type="button" class="icon-btn" data-action="toggle-pass" data-arg="p-pass" aria-label="Mostrar contraseña" aria-pressed="false">' + icon('eye') + '</button></div>' +
          '<ul class="req-list" id="p-reqs" aria-label="Tu contraseña necesita">' +
            '<li data-req="len"><span class="dot">' + icon('check') + '</span>Al menos 10 caracteres</li>' +
            '<li data-req="num"><span class="dot">' + icon('check') + '</span>Al menos un número</li>' +
            '<li data-req="let"><span class="dot">' + icon('check') + '</span>Al menos una letra</li>' +
          '</ul>' +
        '</div>' +
        '<div class="field" id="f-p-pass2"><label for="p-pass2">Escríbela otra vez</label><input class="input" id="p-pass2" name="pass2" type="password" autocomplete="new-password"></div>' +
        '<div class="ob-actions" style="margin-top:8px">' + UI.btn('Guardar contraseña', { type: 'submit', block: true, id: 'pass-submit' }) + '</div>' +
      '</form></main></div></div>';
    return { title: 'Crea tu contraseña', html: html, shell: false };
  };
  MS.passReqs = function (v) { return { len: v.length >= 10, num: /\d/.test(v), let: /[a-z]/i.test(v) }; };

  /* ---------- DS-03b · Datos del negocio → página con vista previa (POST /website + first-publication) ---------- */
  V.business = function (opts) {
    opts = opts || {};
    var inShell = !!opts.shell;
    var S = MS.S;
    if (S.website && inShell) {
      return { tab: 'pagina', screen: 'DS-03', title: 'Crear mi página', back: '#/pagina', backLabel: 'Mi página', html: UI.empty('Tu página ya existe', 'Puedes pedir cambios con tus palabras o publicar tu primera versión.', UI.btn('Ir a Mi página', { href: '#/pagina' })) };
    }
    if (!MS.can('website.provision')) {
      var deny = UI.empty('Tu perfil no puede crear la página', 'Quien administra tu negocio puede crearla.', UI.btn('Ir al inicio', { href: '#/inicio' }));
      return inShell ? { tab: 'pagina', screen: 'DS-03', title: 'Crear mi página', html: deny } : { title: 'Datos de tu negocio', shell: false, html: '<div class="ob"><div class="ob-wrap"><main class="ob-body" id="main">' + deny + '</main></div></div>' };
    }
    var d = MS.mem.bizDraft || (MS.mem.bizDraft = { services: [] });
    var b = S.biz;
    var chips = d.services.map(function (s) {
      return '<button type="button" class="chip is-on" aria-pressed="true" data-action="chip-toggle" data-arg="' + esc(s) + '">' + icon('check') + esc(s) + '</button>';
    }).join('');
    var form = '<form class="stack" style="margin-top:20px" data-form="business" novalidate>' +
        '<div class="banner banner-alerta" id="biz-error" role="alert" hidden>' + icon('circle-alert') + '<span id="biz-error-text"></span></div>' +
        '<div class="field"><label for="b-name">Nombre del negocio</label><input class="input" id="b-name" value="' + esc(MS.DATA.business) + '" readonly><span class="hint">Lo registró el equipo de MainSpot. Si está mal, avísanos.</span></div>' +
        '<div class="field" id="f-b-line"><label for="b-line">Una frase sobre tu negocio</label><input class="input" id="b-line" name="line" value="' + esc(b.line) + '" maxlength="160"></div>' +
        (S.primary ? '' : '<fieldset class="fieldset field"><legend>Teléfono del negocio</legend><span class="hint">Será tu número principal. Después podrás usar otro número distinto en tu página, en Google Maps y en Facebook.</span>' + MS.ph.numberFields('primary', MS.ph.draft('primary')) + '</fieldset>') +
        '<div class="field" id="f-b-address"><label for="b-address">Dirección</label><input class="input" id="b-address" name="address" autocomplete="street-address" maxlength="200" value="' + esc(b.address) + '"></div>' +
        '<fieldset class="fieldset field"><legend>Horario</legend><span class="hint">Escribe «Cerrado» si ese día no abres.</span><div class="hours-grid" style="margin-top:6px">' +
          hours('b-hw', 'Lunes a viernes', '9:00 a 18:00') + hours('b-hs', 'Sábado', '9:00 a 14:00') + hours('b-hd', 'Domingo', 'Cerrado') +
        '</div></fieldset>' +
        '<fieldset class="fieldset field"><legend>¿Qué vendes?</legend><span class="hint">Escribe cada cosa y toca «Agregar». Puedes agregar varias.</span>' +
          '<div class="row" style="margin-top:6px;gap:8px"><label class="sr-only" for="b-service">Algo que vendes</label><input class="input" id="b-service" maxlength="80" placeholder="Por ejemplo: Pasteles por encargo"><button type="button" class="btn btn-secondary btn-sm" data-action="service-add">' + icon('plus') + '<span>Agregar</span></button></div>' +
          '<div class="chips" style="margin-top:8px" id="b-services">' + chips + '</div>' +
          '<div class="field-error" id="b-services-err" hidden>' + icon('circle-alert') + '<span>Agrega al menos una cosa que vendas.</span></div></fieldset>' +
        '<div class="ob-actions" style="margin-top:8px">' + UI.btn(inShell ? 'Crear mi página' : 'Guardar y continuar', { type: 'submit', block: true, id: 'biz-submit' }) + '</div>' +
      '</form>';
    if (inShell) {
      return { tab: 'pagina', screen: 'DS-03', title: 'Crear mi página', back: '#/pagina', backLabel: 'Mi página',
        html: '<div class="page-head"><h1 tabindex="-1" data-focus>Crea tu página</h1><p>Con estos datos preparamos tu primera versión. La revisas antes de que llegue a internet.</p></div>' + form };
    }
    var html = '<div class="ob" data-screen="DS-03">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' + steps(1) +
      '<h1 tabindex="-1" data-focus>Revisa los datos de tu negocio</h1>' +
      '<p class="ob-lead">Con esto preparamos tu página. Nada se publica hasta que la apruebes.</p>' + form +
      (S.website ? '<p class="small center muted" style="margin-top:12px">Tu página ya existe. <a href="#/activar/telegram">Continuar</a></p>' : '') +
      '</main></div></div>';
    return { title: 'Datos de tu negocio', html: html, shell: false };
    function hours(id, l, ph) { return '<div class="field" id="f-' + id + '"><label for="' + id + '" style="font-weight:400;font-size:var(--fs-sm)">' + esc(l) + '</label><input class="input" id="' + id + '" placeholder="' + esc(ph) + '"></div>'; }
  };

  /* ---------- DS-03c · Siguiente paso: Telegram ---------- */
  V.onbTelegram = function () {
    var html = '<div class="ob" data-screen="DS-03">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' + steps(2) +
      '<h1 tabindex="-1" data-focus>Te falta un paso: conecta tu Telegram</h1>' +
      '<p class="ob-lead">Te avisaremos ahí cuando un cliente necesite tu decisión, y podrás aprobar o descartar respuestas desde el chat.</p>' +
      '<div class="ob-actions">' + (MS.can('telegram.link') ? UI.btn('Conectar Telegram', { action: 'onb-telegram', block: true }) : '') + UI.btn('Lo haré después', { action: 'onb-skip', style: 'secondary', block: true }) + '</div>' +
      '</main></div></div>';
    return { title: 'Conecta tu Telegram', html: html, shell: false };
  };

  /* ---------- DS-04 · Entrar (POST /api/auth/login, sin tenant_id) ---------- */
  V.login = function () {
    var pick = MS.mem.tenantChoice;
    var html = '<div class="ob" data-screen="DS-04">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' +
      '<h1 tabindex="-1" data-focus>Entra a MainSpot</h1>' +
      '<p class="ob-lead">Con tu correo y tu contraseña.</p>' +
      '<form class="stack" style="margin-top:24px" data-form="login" novalidate>' +
        '<div class="banner banner-alerta" id="login-error" role="alert"' + (MS.mem.loginError ? '' : ' hidden') + '>' + icon('circle-alert') + '<span id="login-error-text">' + esc(MS.mem.loginError || 'El correo o la contraseña no son correctos. Revísalos e inténtalo de nuevo.') + '</span></div>' +
        '<div class="field" id="f-l-email"><label for="l-email">Correo</label><input class="input" id="l-email" name="email" type="email" autocomplete="username" value="' + esc(MS.mem.loginEmail || '') + '"></div>' +
        '<div class="field" id="f-l-pass"><label for="l-pass">Contraseña</label><div class="input-wrap"><input class="input" id="l-pass" name="pass" type="password" autocomplete="current-password"><button type="button" class="icon-btn" data-action="toggle-pass" data-arg="l-pass" aria-label="Mostrar contraseña" aria-pressed="false">' + icon('eye') + '</button></div></div>' +
        (pick ? '<fieldset class="fieldset field" id="l-tenants"><legend>¿Con qué negocio quieres entrar?</legend>' + pick.map(function (t, i) {
          return '<label class="radio-row' + (i === 0 ? ' is-on' : '') + '"><input type="radio" name="l-tenant" value="' + esc(t.tenant_id) + '"' + (i === 0 ? ' checked' : '') + '><span><span class="rr-t">' + esc(t.business_name) + '</span></span></label>';
        }).join('') + '</fieldset>' : '') +
        '<div class="ob-actions" style="margin-top:8px">' + UI.btn('Entrar', { type: 'submit', block: true, id: 'login-submit' }) +
          '<a class="link-btn" style="align-self:center" href="#/recuperar">¿Olvidaste tu contraseña?</a></div>' +
      '</form></main></div></div>';
    return { title: 'Entrar', html: html, shell: false };
  };

  /* ---------- DS-05a · ¿Olvidaste tu contraseña? (POST /api/auth/password/forgot) ----------
     La respuesta del servidor es la misma exista o no el correo; aquí solo se muestra. */
  V.forgot = function () {
    var done = MS.mem.forgotDone;
    var html = '<div class="ob" data-screen="DS-05">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">';
    if (done) {
      html += '<span class="spot spot-none" style="margin-bottom:20px">' + icon('mail') + '</span>' +
        '<h1 tabindex="-1" data-focus>Revisa tu correo</h1>' +
        '<p class="ob-lead">' + esc(done.message) + '</p>' +
        '<div style="margin-top:24px">' + UI.facts([['clock', 'El enlace vence', 'En 30 minutos.'], ['lock', 'Sirve una sola vez', 'Si pides otro, el anterior deja de funcionar.']]) + '</div>' +
        '<div class="ob-actions">' + UI.btn('Volver a entrar', { href: '#/entrar', block: true }) +
          '<button type="button" class="link-btn" style="align-self:center" data-action="forgot-again">¿No te llegó? Pedir otro enlace</button></div>';
    } else {
      html += '<h1 tabindex="-1" data-focus>Crea una contraseña nueva</h1>' +
        '<p class="ob-lead">Escribe el correo con el que entras a MainSpot y te enviaremos un enlace para elegir una contraseña nueva.</p>' +
        '<form class="stack" style="margin-top:24px" data-form="forgot" novalidate>' +
          '<div class="banner banner-alerta" id="forgot-error" role="alert" hidden>' + icon('circle-alert') + '<span id="forgot-error-text"></span></div>' +
          field('fg-email', 'Correo', MS.mem.loginEmail || '', 'email', 'username') +
          '<div class="ob-actions" style="margin-top:8px">' + UI.btn('Enviarme el enlace', { type: 'submit', block: true, id: 'forgot-submit' }) +
            '<a class="link-btn" style="align-self:center" href="#/entrar">Volver a entrar</a></div>' +
        '</form>';
    }
    html += '</main></div></div>';
    return { title: 'Crea una contraseña nueva', html: html, shell: false };
  };

  /* ---------- DS-05b · Contraseña nueva desde el enlace (POST /api/auth/password/reset) ----------
     El token llega en el fragmento (/restablecer#TOKEN), vive solo en memoria y nunca se guarda. */
  V.reset = function () {
    var invalid = MS.mem.resetInvalid;
    if (!MS.mem.resetToken) {
      var h = '<div class="ob" data-screen="DS-05">' + UI.planes('ob-art') +
        '<div class="ob-wrap"><main class="ob-body" id="main">' +
        '<span class="spot spot-none" style="margin-bottom:20px">' + icon('link') + '</span>' +
        '<h1 tabindex="-1" data-focus>' + esc(invalid ? 'Este enlace ya no sirve' : 'Abre de nuevo tu enlace') + '</h1>' +
        '<p class="ob-lead">' + esc(invalid || 'Por seguridad, el enlace no se guarda. Ábrelo otra vez desde el correo que te enviamos o pide uno nuevo.') + '</p>' +
        '<div class="ob-actions">' + UI.btn('Pedir un enlace nuevo', { href: '#/recuperar', block: true }) + UI.btn('Entrar a MainSpot', { href: '#/entrar', block: true, style: 'secondary' }) + '</div>' +
        '</main></div></div>';
      return { title: 'Crea una contraseña nueva', html: h, shell: false };
    }
    var html = '<div class="ob" data-screen="DS-05">' + UI.planes('ob-art') +
      '<div class="ob-wrap"><main class="ob-body" id="main">' +
      '<h1 tabindex="-1" data-focus>Elige tu contraseña nueva</h1>' +
      '<p class="ob-lead">La usarás con tu correo para entrar. Tus otras sesiones abiertas se cerrarán.</p>' +
      '<form class="stack" style="margin-top:24px" data-form="reset" novalidate>' +
        '<div class="banner banner-alerta" id="reset-error" role="alert" hidden>' + icon('circle-alert') + '<span id="reset-error-text"></span></div>' +
        '<div class="field" id="f-p-pass"><label for="p-pass">Contraseña nueva</label>' +
          '<div class="input-wrap"><input class="input" id="p-pass" name="pass" type="password" autocomplete="new-password" aria-describedby="p-reqs" data-live="pass-reqs"><button type="button" class="icon-btn" data-action="toggle-pass" data-arg="p-pass" aria-label="Mostrar contraseña" aria-pressed="false">' + icon('eye') + '</button></div>' +
          '<ul class="req-list" id="p-reqs" aria-label="Tu contraseña necesita">' +
            '<li data-req="len"><span class="dot">' + icon('check') + '</span>Al menos 10 caracteres</li>' +
            '<li data-req="num"><span class="dot">' + icon('check') + '</span>Al menos un número</li>' +
            '<li data-req="let"><span class="dot">' + icon('check') + '</span>Al menos una letra</li>' +
          '</ul>' +
        '</div>' +
        '<div class="field" id="f-p-pass2"><label for="p-pass2">Escríbela otra vez</label><input class="input" id="p-pass2" name="pass2" type="password" autocomplete="new-password"></div>' +
        '<div class="ob-actions" style="margin-top:8px">' + UI.btn('Guardar contraseña nueva', { type: 'submit', block: true, id: 'reset-submit' }) + '</div>' +
      '</form></main></div></div>';
    return { title: 'Elige tu contraseña nueva', html: html, shell: false };
  };
})();
