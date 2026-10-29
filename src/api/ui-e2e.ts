/**
 * UI mínima integrada de DEV-E2E-02 (mientras se conecta el diseño final de Claude Design,
 * docs/ux/claude-design/**). Se inserta en /panel: teléfonos (un «Otro número» por integración),
 * agente de atención (políticas, casos, 3 borradores), Telegram, ficha de Google y simulador.
 * Todo texto dinámico se escapa; sin plantillas JS anidadas (el script vive en un literal TS).
 */

export function e2eCardsHtml(): string {
  return `
  <div class="card" id="phonesCard" hidden>
    <h2>Teléfonos de contacto</h2>
    <p>Tu número principal y, para cada integración, «Usar mi número» u «Otro número». Cada integración tiene su propio otro número.</p>
    <form id="primaryForm" class="phoneRow">
      <strong>Mi número principal</strong>
      <label for="pp_country">País</label>
      <select id="pp_country" class="countrySel"></select>
      <label for="pp_number">Número</label>
      <input id="pp_number" inputmode="tel" autocomplete="tel-national">
      <button type="submit">Guardar</button>
      <span class="fieldErr" id="pp_err" role="alert"></span>
    </form>
    <div id="integrationPhones"></div>
  </div>
  <div class="card" id="agentCard" hidden>
    <h2>Agente de atención (reseñas de Google y comentarios de Facebook)</h2>
    <p>Por defecto toda respuesta pública espera tu revisión. Solo los casos seguros de una categoría que tú autorices se responden solos. <em>Modo simulado: no se publica nada en Google ni en Facebook.</em></p>
    <div id="policiesBox"></div>
    <div class="actions">
      <label for="caseFilter">Ver</label>
      <select id="caseFilter">
        <option value="">Todos</option>
        <option value="needs_human">Pendientes de mi decisión</option>
        <option value="responded">Respondidos</option>
        <option value="failed">Con problemas</option>
      </select>
      <button class="secondary" id="runAgentBtn" type="button">Procesar ahora</button>
    </div>
    <div id="casesBox" aria-live="polite"></div>
  </div>
  <div class="card" id="telegramCard" hidden>
    <h2>Telegram</h2>
    <p>Recibe aquí los casos que esperan tu decisión. Telegram usa tu chat vinculado, nunca el teléfono público de tu negocio.</p>
    <div id="telegramBox"></div>
  </div>
  <div class="card" id="gbpCard" hidden>
    <h2>Ficha de Google (simulada)</h2>
    <p>Datos básicos, ubicación y horario. El teléfono de la ficha es el de la integración de Google en «Teléfonos». <em>Sin conexión real con Google.</em></p>
    <div id="gbpBox"></div>
  </div>
  <div class="card" id="simCard" hidden>
    <h2>Simulador de desarrollo</h2>
    <p>Genera reseñas y comentarios ficticios para probar el agente.</p>
    <form id="simReviewForm" class="phoneRow">
      <label for="sim_rating">Estrellas</label>
      <select id="sim_rating"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select>
      <label for="sim_review">Reseña</label>
      <input id="sim_review" value="¡Excelente atención, gracias!">
      <button type="submit">Nueva reseña de Google</button>
    </form>
    <form id="simCommentForm" class="phoneRow">
      <label for="sim_post">Publicación</label>
      <select id="sim_post"></select>
      <label for="sim_comment">Comentario</label>
      <input id="sim_comment" value="¿Cuál es su teléfono?">
      <button type="submit">Nuevo comentario de Facebook</button>
    </form>
  </div>`;
}

export function e2eScript(): string {
  return `
var COUNTRIES = [['MX','+52','México'],['US','+1','Estados Unidos'],['CA','+1','Canadá'],['ES','+34','España'],['AR','+54','Argentina'],['CO','+57','Colombia'],['CL','+56','Chile'],['PE','+51','Perú'],['GT','+502','Guatemala'],['BR','+55','Brasil']];
var CHANNEL_LABELS = { website: 'Página web', google_business_profile: 'Google Maps / Perfil del negocio', facebook: 'Facebook' };
var ORIGIN_LABELS = { google_review: 'Reseñas de Google', facebook_comment: 'Comentarios de Facebook' };
var CATEGORY_LABELS = { gratitude: 'Agradecimientos simples', basic_info: 'Preguntas de datos básicos (teléfono, horario, dirección)' };
var CASE_STATES = { received: 'Recibido', classified: 'Respondiendo', responding: 'Respondiendo', responded: 'Respondido', needs_human: 'Pendiente de tu decisión', approved: 'Aprobado, publicando', rejected: 'Descartado', retry_pending: 'Reintentando', failed: 'No se pudo publicar', closed_elsewhere: 'Respondido desde Reseñas' };
var SYNC_LABELS = { applies_on_publish: 'Se verá en la próxima publicación de tu página', simulated_synced: 'Sincronizado (simulado)', pending: 'Pendiente', not_verified: 'Conexión real no verificada' };

var REASON_LABELS = { category_not_safe: 'No es un caso simple de responder solo', no_policy: 'No has autorizado respuestas automáticas para este tipo de caso', policy_review_required: 'Pediste revisar este tipo de caso', low_confidence: 'MainSpot no está seguro de entenderlo', unverified_data: 'Falta un dato verificado para responder', rate_limited: 'Se alcanzó el máximo de respuestas automáticas por hora', provider_failed: 'No se pudo publicar tras varios intentos', delivery_uncertain: 'No sabemos si la respuesta llegó; revísala antes de reenviar', answered_in_reviews: 'Ya se respondió desde Reseñas' };
var RISK_LABELS = { legal: 'temas legales', compensation: 'compensaciones u ofertas', safety: 'salud o seguridad', threat: 'amenazas', accusation: 'acusaciones', private_data: 'datos privados' };
function reasonText(reason) {
  if (reason.indexOf('risk:') === 0) return 'Menciona ' + reason.slice(5).split(',').map(function (f) { return RISK_LABELS[f] || f; }).join(', ');
  return REASON_LABELS[reason] || reason;
}
function countryOptions(selected) {
  return COUNTRIES.map(function (c) {
    return '<option value="' + c[0] + '"' + (c[0] === selected ? ' selected' : '') + '>' + esc(c[2] + ' (' + c[1] + ')') + '</option>';
  }).join('');
}
function fieldErrors(data) {
  var e = data && data.error;
  if (!e) return 'No se pudo guardar.';
  return e.message || 'No se pudo guardar.';
}

async function loadPhones() {
  var r = await api('/contact/phones');
  if (!r.res.ok) return;
  var v = r.data;
  document.getElementById('phonesCard').hidden = false;
  var canEdit = has('client.config.manage');
  var pp = v.primary_phone;
  document.getElementById('pp_country').innerHTML = countryOptions(pp ? pp.country_iso2 : 'MX');
  document.getElementById('pp_number').value = pp ? pp.national_number : '';
  document.getElementById('pp_number').disabled = !canEdit;
  var box = document.getElementById('integrationPhones');
  box.innerHTML = '';
  ['website', 'google_business_profile', 'facebook'].forEach(function (ch) {
    var p = v.integration_phones[ch];
    var other = p.other_phone;
    var form = document.createElement('form');
    form.className = 'phoneRow';
    form.setAttribute('data-channel', ch);
    form.innerHTML =
      '<strong>' + esc(CHANNEL_LABELS[ch]) + '</strong>' +
      '<label><input type="radio" name="mode_' + ch + '" value="own"' + (p.mode === 'own' ? ' checked' : '') + '> Usar mi número</label>' +
      '<label><input type="radio" name="mode_' + ch + '" value="other"' + (p.mode === 'other' ? ' checked' : '') + '> Otro número</label>' +
      '<span class="otherFields"' + (p.mode === 'other' ? '' : ' hidden') + '>' +
        '<label for="c_' + ch + '">País</label><select id="c_' + ch + '">' + countryOptions(other ? other.country_iso2 : 'MX') + '</select>' +
        '<label for="n_' + ch + '">Número</label><input id="n_' + ch + '" inputmode="tel" value="' + esc(other ? other.national_number : '') + '">' +
      '</span>' +
      (canEdit ? '<button type="submit">Guardar</button>' : '') +
      '<span class="hint">Se mostrará: <b>' + esc(p.effective_phone || (p.needs_primary ? 'falta tu número principal' : 'sin número')) + '</b> · ' + esc(SYNC_LABELS[p.sync.status] || p.sync.status) + '</span>' +
      '<span class="fieldErr" role="alert"></span>';
    form.querySelectorAll('input[type=radio]').forEach(function (radio) {
      radio.disabled = !canEdit;
      radio.addEventListener('change', function () {
        form.querySelector('.otherFields').hidden = radio.value !== 'other' || !radio.checked;
      });
    });
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var mode = form.querySelector('input[type=radio]:checked').value;
      var body = { mode: mode };
      var num = document.getElementById('n_' + ch).value.trim();
      if (mode === 'other' && num) body.other_phone = { country_iso2: document.getElementById('c_' + ch).value, national_number: num };
      var res = await api('/contact/phones/integrations/' + ch, { method: 'PUT', body: body });
      if (!res.res.ok) { form.querySelector('.fieldErr').textContent = fieldErrors(res.data); return; }
      showNotice('Guardado: ' + CHANNEL_LABELS[ch] + '.');
      loadPhones();
    });
    box.appendChild(form);
  });
}

document.getElementById('primaryForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var res = await api('/contact/phones/primary', { method: 'PUT', body: { primary_phone: { country_iso2: document.getElementById('pp_country').value, national_number: document.getElementById('pp_number').value.trim() } } });
  if (!res.res.ok) { document.getElementById('pp_err').textContent = fieldErrors(res.data); return; }
  document.getElementById('pp_err').textContent = '';
  showNotice('Número principal guardado. Los canales con «Usar mi número» lo usarán.');
  loadPhones();
});

async function loadPolicies() {
  var r = await api('/engagement/policies');
  if (!r.res.ok) return;
  var canManage = has('engagement.policy.manage');
  var box = document.getElementById('policiesBox');
  box.innerHTML = '<h3>Qué puede responder MainSpot por mí</h3>';
  r.data.policies.forEach(function (p) {
    var row = document.createElement('div');
    row.className = 'policyRow';
    var on = p.mode === 'safe_auto_reply';
    row.innerHTML = '<span>' + esc(ORIGIN_LABELS[p.origin]) + ' · ' + esc(CATEGORY_LABELS[p.category]) + ': <b>' + (on ? 'MainSpot responde (seguro)' : 'Espera mi revisión') + '</b>' + (p.version ? ' (v' + p.version + ')' : '') + '</span>';
    if (canManage) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = on ? 'Revocar' : 'Permitir';
      btn.addEventListener('click', async function () {
        var body = { origin: p.origin, category: p.category, mode: on ? 'review_required' : 'safe_auto_reply' };
        if (!on) {
          var ok = window.confirm('Autorizo a MainSpot a responder públicamente en mi nombre solo los casos de esta categoría que pasen todas las comprobaciones de seguridad. Las quejas, riesgos y casos dudosos seguirán esperando mi revisión. ¿Confirmas?');
          if (!ok) return;
          body.consent = true;
        }
        var res = await api('/engagement/policies', { method: 'PUT', body: body });
        if (!res.res.ok) { showError(fieldErrors(res.data)); return; }
        loadPolicies();
      });
      row.appendChild(btn);
    }
    box.appendChild(row);
  });
}

async function loadCases() {
  var filter = document.getElementById('caseFilter').value;
  var r = await api('/engagement/cases' + (filter ? '?state=' + encodeURIComponent(filter) : ''));
  var box = document.getElementById('casesBox');
  if (!r.res.ok) { box.textContent = 'No se pudieron cargar los casos.'; return; }
  if (!r.data.cases.length) { box.innerHTML = '<p>No hay casos con este filtro.</p>'; return; }
  box.innerHTML = '';
  r.data.cases.forEach(function (c) {
    var div = document.createElement('div');
    div.className = 'caseItem';
    div.id = 'caso-' + c.case_id;
    var who = (c.origin === 'google_review' ? 'Reseña de Google' + (c.rating ? ' (' + c.rating + '★)' : '') : 'Comentario de Facebook') + ' · ' + c.author_label;
    var html = '<p><b>' + esc(CASE_STATES[c.state] || c.state) + '</b> · ' + esc(who) + '</p><blockquote>' + esc(c.body) + '</blockquote>';
    if (c.state === 'responded') {
      html += '<p>' + (c.resolution_channel === 'auto' ? 'Atendido por MainSpot (política v' + esc(c.policy_version) + ')' : 'Aprobado por una persona (' + esc(c.resolution_channel) + ')') + ' · ' + (c.delivery_mode === 'simulated' ? 'simulación' : esc(c.delivery_mode)) + '</p><p>' + esc(c.response_text) + '</p>';
    } else if (c.reason) {
      html += '<p class="hint">Motivo: ' + esc(reasonText(c.reason)) + (c.notify_status === 'no_destination' ? ' · Conecta Telegram para recibir este aviso' : '') + '</p>';
    }
    div.innerHTML = html;
    if ((c.state === 'needs_human' || c.state === 'failed') && c.drafts.length) {
      c.drafts.forEach(function (d, i) {
        var wrap = document.createElement('div');
        wrap.className = 'draft';
        var ta = document.createElement('textarea');
        ta.rows = 2;
        ta.value = d;
        ta.setAttribute('aria-label', 'Respuesta sugerida ' + (i + 1));
        ta.disabled = !has('engagement.respond');
        wrap.appendChild(ta);
        if (has('engagement.respond')) {
          var save = document.createElement('button');
          save.type = 'button'; save.className = 'secondary'; save.textContent = 'Guardar cambios';
          save.addEventListener('click', async function () {
            var res = await api('/engagement/cases/' + c.case_id + '/drafts/' + (i + 1), { method: 'POST', body: { text: ta.value } });
            if (!res.res.ok) { showError(fieldErrors(res.data)); return; }
            showNotice('Respuesta ' + (i + 1) + ' guardada.');
          });
          wrap.appendChild(save);
        }
        if (has('engagement.approve')) {
          var ap = document.createElement('button');
          ap.type = 'button'; ap.textContent = 'Publicar esta respuesta';
          ap.addEventListener('click', async function () {
            if (!window.confirm('¿Publicar esta respuesta? (simulación)')) return;
            var res = await api('/engagement/cases/' + c.case_id + '/approve', { method: 'POST', body: { text: ta.value } });
            if (!res.res.ok) { showError(fieldErrors(res.data)); return; }
            showNotice(res.data.message);
            loadCases();
          });
          wrap.appendChild(ap);
        }
        div.appendChild(wrap);
      });
      if (has('engagement.approve')) {
        var rj = document.createElement('button');
        rj.type = 'button'; rj.className = 'secondary'; rj.textContent = 'Descartar (no responder)';
        rj.addEventListener('click', async function () {
          var res = await api('/engagement/cases/' + c.case_id + '/reject', { method: 'POST', body: {} });
          if (!res.res.ok) { showError(fieldErrors(res.data)); return; }
          loadCases();
        });
        div.appendChild(rj);
      }
    }
    box.appendChild(div);
  });
}

async function loadTelegram() {
  var r = await api('/telegram/link');
  if (!r.res.ok) return;
  document.getElementById('telegramCard').hidden = false;
  var box = document.getElementById('telegramBox');
  if (r.data.linked) {
    box.innerHTML = '<p>Conectado (chat ' + esc(r.data.chat_hint) + ').</p>';
    var un = document.createElement('button');
    un.type = 'button'; un.className = 'secondary'; un.textContent = 'Desconectar';
    un.addEventListener('click', async function () {
      if (!window.confirm('¿Desconectar Telegram? Los avisos seguirán en el panel.')) return;
      await api('/telegram/link', { method: 'DELETE' });
      loadTelegram();
    });
    box.appendChild(un);
    return;
  }
  box.innerHTML = '<p>No conectado.</p>';
  var gen = document.createElement('button');
  gen.type = 'button'; gen.textContent = 'Conectar Telegram';
  gen.addEventListener('click', async function () {
    var res = await api('/telegram/link-code', { method: 'POST', body: {} });
    if (!res.res.ok) { showError(fieldErrors(res.data)); return; }
    box.innerHTML = '<p>' + esc(res.data.instructions) + ' (caduca a las ' + esc(new Date(res.data.expires_at).toLocaleTimeString()) + ')' + (res.data.channel_mode === 'simulated' ? ' · Telegram simulado' : '') + '</p>';
  });
  box.appendChild(gen);
}

async function loadGbp() {
  var r = await api('/google/profile');
  if (!r.res.ok) return;
  document.getElementById('gbpCard').hidden = false;
  var p = r.data.profile || {};
  var canEdit = has('client.config.manage');
  var box = document.getElementById('gbpBox');
  box.innerHTML =
    '<p>Teléfono de la ficha: <b>' + esc(r.data.phone.effective_phone || 'sin número') + '</b> (' + (r.data.phone.mode === 'other' ? 'otro número de Google' : 'tu número principal') + ')' +
    (p.sync_status ? ' · Estado: ' + esc(p.sync_status === 'simulated_pending_verification' ? 'pendiente de verificación (simulado)' : SYNC_LABELS[p.sync_status] || p.sync_status) : '') + '</p>' +
    '<form id="gbpForm">' +
    '<label for="g_name">Nombre en Google</label><input id="g_name" value="' + esc(p.business_name || '') + '">' +
    '<label for="g_cat">Categoría principal</label><input id="g_cat" value="' + esc(p.primary_category || '') + '">' +
    '<label for="g_addr">Dirección</label><input id="g_addr" value="' + esc(p.address_line || '') + '">' +
    '<label for="g_loc">Ciudad</label><input id="g_loc" value="' + esc(p.locality || '') + '">' +
    '<label for="g_hours">Horario lunes a viernes (HH:MM-HH:MM)</label><input id="g_hours" placeholder="09:00-18:00" value="' + esc((p.hours && p.hours[0] && p.hours[0].open) ? p.hours[0].open + '-' + p.hours[0].close : '') + '">' +
    (canEdit ? '<button type="submit">Guardar ficha (simulado)</button>' : '') +
    '<span class="fieldErr" role="alert"></span></form>';
  var form = document.getElementById('gbpForm');
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var hours = [];
    var hv = document.getElementById('g_hours').value.trim();
    if (hv) {
      var parts = hv.split('-');
      ['mon', 'tue', 'wed', 'thu', 'fri'].forEach(function (d) { hours.push({ day: d, open: (parts[0] || '').trim(), close: (parts[1] || '').trim() }); });
    }
    var res = await api('/google/profile', { method: 'PUT', body: { business_name: document.getElementById('g_name').value, primary_category: document.getElementById('g_cat').value, address_line: document.getElementById('g_addr').value, locality: document.getElementById('g_loc').value, hours: hours } });
    if (!res.res.ok) { form.querySelector('.fieldErr').textContent = fieldErrors(res.data); return; }
    showNotice('Ficha guardada (simulación).');
    loadGbp();
  });
}

async function loadSimPosts() {
  var r = await api('/social/posts');
  var sel = document.getElementById('sim_post');
  if (!r.res.ok) return;
  var pub = (r.data.posts || []).filter(function (p) { return p.status === 'published'; });
  sel.innerHTML = pub.length ? pub.map(function (p) { return '<option value="' + esc(p.post_id) + '">' + esc(truncate(p.text, 40)) + '</option>'; }).join('') : '<option value="">(publica primero algo en Facebook)</option>';
}

document.getElementById('caseFilter').addEventListener('change', loadCases);
document.getElementById('runAgentBtn').addEventListener('click', async function () {
  var r = await api('/engagement/run', { method: 'POST', body: {} });
  if (!r.res.ok) { showError(fieldErrors(r.data)); return; }
  showNotice('Agente: ' + r.data.report.classified + ' casos clasificados, ' + r.data.report.responded + ' respondidos, ' + r.data.report.notifications.sent + ' avisos.');
  loadCases();
});
document.getElementById('simReviewForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var r = await api('/dev/simulator/google-reviews', { method: 'POST', body: { rating: Number(document.getElementById('sim_rating').value), body: document.getElementById('sim_review').value, author_label: 'Cliente de prueba' } });
  showNotice(r.res.ok ? 'Reseña simulada creada. El agente la verá en su próximo ciclo.' : fieldErrors(r.data));
});
document.getElementById('simCommentForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var r = await api('/dev/simulator/facebook-comments', { method: 'POST', body: { post_id: document.getElementById('sim_post').value, body: document.getElementById('sim_comment').value, author_label: 'Persona de prueba' } });
  showNotice(r.res.ok ? 'Comentario simulado creado.' : fieldErrors(r.data));
});

window.initE2E = function () {
  if (has('data.read')) { loadPhones(); loadGbp(); }
  if (has('engagement.read')) { document.getElementById('agentCard').hidden = false; loadPolicies(); loadCases(); }
  if (has('telegram.link')) loadTelegram();
  if (has('engagement.policy.manage')) {
    api('/dev/simulator/replies').then(function (r) { if (r.res.ok) { document.getElementById('simCard').hidden = false; loadSimPosts(); } });
  }
  if (location.hash.indexOf('#caso-') === 0) setTimeout(function () { var el = document.getElementById(location.hash.slice(1)); if (el) el.scrollIntoView(); }, 800);
};
`;
}

export const E2E_CSS = `
.phoneRow{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.6rem 0;padding:.5rem;border:1px solid #e3e3e3;border-radius:8px}
.phoneRow label{margin:0}
.phoneRow input:not([type=radio]),.phoneRow select{width:auto;min-width:9rem}
.hint{color:#555;font-size:.9rem}
.fieldErr{color:#b00020}
.fieldErr:empty{display:none}
.policyRow{display:flex;justify-content:space-between;gap:.5rem;align-items:center;padding:.3rem 0;border-bottom:1px solid #eee}
.caseItem{border:1px solid #ddd;border-radius:8px;padding:.6rem;margin:.6rem 0}
.caseItem blockquote{margin:.3rem 0;padding-left:.6rem;border-left:3px solid #ccc}
.draft{display:flex;gap:.4rem;align-items:flex-start;margin:.3rem 0}
.draft textarea{flex:1}
`;

export function invitationPageHtml(sharedCss: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MainSpot — Activa tu cuenta</title>
<style>${sharedCss}</style>
</head>
<body>
<main>
  <div class="card">
    <h1 id="invTitle">Activa tu cuenta de MainSpot</h1>
    <p id="invIntro">Estamos revisando tu invitación…</p>
    <form id="acceptForm" hidden autocomplete="on">
      <label for="display_name">Tu nombre</label>
      <input id="display_name" required maxlength="80" autocomplete="name">
      <label for="password">Elige una contraseña (al menos 10 caracteres, con letras y números)</label>
      <input id="password" type="password" required minlength="10" autocomplete="new-password">
      <label for="password2">Repite la contraseña</label>
      <input id="password2" type="password" required minlength="10" autocomplete="new-password">
      <div style="margin-top:1rem"><button type="submit">Guardar y entrar</button></div>
    </form>
    <div id="error" role="alert"></div>
  </div>
</main>
<script>
var token = location.hash.replace(/^#/, '');
history.replaceState(null, '', location.pathname);
var form = document.getElementById('acceptForm');
var error = document.getElementById('error');
function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); });
}
post('/api/auth/invitation', { token: token }).then(function (r) {
  if (!r.ok) { document.getElementById('invIntro').textContent = (r.data.error && r.data.error.message) || 'Este enlace no es válido.'; return; }
  document.getElementById('invTitle').textContent = 'Bienvenida o bienvenido a ' + r.data.business_name;
  document.getElementById('invIntro').textContent = 'Elige tu contraseña para entrar a tu panel.';
  form.hidden = false;
});
form.addEventListener('submit', function (ev) {
  ev.preventDefault();
  error.textContent = '';
  var p1 = document.getElementById('password').value;
  if (p1 !== document.getElementById('password2').value) { error.textContent = 'Las contraseñas no coinciden.'; return; }
  post('/api/auth/invitation/accept', { token: token, display_name: document.getElementById('display_name').value, password: p1 }).then(function (r) {
    if (!r.ok) { error.textContent = (r.data.error && r.data.error.message) || 'No se pudo activar la cuenta.'; return; }
    return post('/api/auth/login', { login: r.data.login, password: p1 }).then(function (l) {
      if (!l.ok) { window.location.href = '/'; return; }
      sessionStorage.setItem('mainspot.token', l.data.token);
      window.location.href = '/panel';
    });
  });
});
</script>
</body>
</html>`;
}
