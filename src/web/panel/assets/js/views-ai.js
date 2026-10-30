/* =========================================================================
   MainSpot · AI Core en el panel del negocio (issue #9)
   - Asistente con estado real, diseño/edición web con IA, publicaciones de Facebook generadas,
     Mi marca (hechos verificados), Biblioteca, calendario editorial, resumen y campañas.
   - Todo pasa por la API (/api/backoffice/ai/*). Nada se publica aquí: la página y las
     publicaciones siguen la vista previa y la aprobación humana existentes.
   - Etiqueta honesta: lo que hizo el simulador se marca «Simulado».
   ========================================================================= */
(function () {
  'use strict';
  var MS = window.MS;
  var V = MS.views = MS.views || {};
  var UI = MS.ui, API = MS.api;
  var esc = function (v) { return MS.esc(v); };
  var icon = function (n, c) { return MS.icon(n, c); };

  var A = MS.ai = { s: {}, jobs: {}, render: {} };
  function mem() { return A.s; }
  function emit() { MS.emit(); }
  function newKey() { return 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

  /* ---------- carga perezosa ---------- */
  var LOAD = {
    status: function () { return API.get('/ai/status'); },
    brand: function () { return API.get('/ai/brand'); },
    media: function () { return API.get('/ai/media'); },
    editorial: function () { return API.get('/ai/editorial'); },
    insights: function () { return API.get('/ai/insights'); },
    campaigns: function () { return API.get('/ai/campaigns'); },
    jobs: function () { return API.get('/ai/jobs'); }
  };
  A.need = function (key, force) {
    var m = mem();
    if (!force && (m[key] || m['loading_' + key])) return m[key] || null;
    m['loading_' + key] = true;
    LOAD[key]().then(function (r) {
      m['loading_' + key] = false;
      m[key] = r.ok ? r.data : { error: r.error.message };
      (key === 'jobs' && r.ok ? r.data.jobs : []).forEach(function (j) { if (!A.jobs[j.job_id]) A.jobs[j.job_id] = j; });
      emit();
    });
    return m[key] || null;
  };
  A.active = function (uc) {
    var st = mem().status;
    if (!st || !st.capabilities) return null;
    var c = st.capabilities.filter(function (x) { return x.use_case === uc; })[0];
    return c ? c : { active: false, simulated: false };
  };

  /* ---------- jobs (sondeo mientras haya alguno en curso) ---------- */
  A.trackJob = function (job) { A.jobs[job.job_id] = job; emit(); };
  setInterval(function () {
    if (!MS.S.session || document.visibilityState !== 'visible') return;
    Object.keys(A.jobs).forEach(function (id) {
      var j = A.jobs[id];
      if (!j || (j.status !== 'queued' && j.status !== 'running') || j._polling) return;
      j._polling = true;
      API.get('/ai/jobs/' + encodeURIComponent(id)).then(function (r) {
        j._polling = false;
        if (!r.ok) return;
        var before = j.status;
        A.jobs[id] = r.data.job;
        if (before !== r.data.job.status) {
          if (r.data.job.kind.indexOf('website.') === 0) MS.refresh(['proposals', 'requests', 'website'], true);
          if (r.data.job.status === 'succeeded') A.need('media', true);
        }
        emit();
      });
    });
  }, 1500);

  function jobOf(kind) {
    var list = Object.keys(A.jobs).map(function (k) { return A.jobs[k]; }).filter(function (j) { return j && j.kind.indexOf(kind) === 0; });
    list.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
    return list[0] || null;
  }

  var JOB_ERR = {
    no_active_route: 'Esta función todavía no está activa en tu cuenta.',
    blocked_external: 'Está pausada por una autorización externa pendiente (por ejemplo, del proveedor de IA).',
    budget_exhausted: 'Se alcanzó el presupuesto de IA de hoy.',
    invalid_output: 'La propuesta no cumplió nuestras reglas de calidad. Intenta describirlo de otra forma.',
    website_missing: 'Todavía no tienes página.',
    provider_unavailable: 'El servicio de IA no respondió. Inténtalo en unos minutos.',
    timeout: 'El servicio de IA tardó demasiado. Inténtalo en unos minutos.',
    attempts_exhausted: 'Lo intentamos varias veces sin éxito. Inténtalo más tarde.'
  };
  function jobCard(j, doneHtml) {
    if (!j) return '';
    if (j.status === 'queued' || j.status === 'running') {
      var step = (j.progress && j.progress.step) || 'en cola';
      var label = { design: 'Diseñando tu página', proposal: 'Preparando la vista previa', classify: 'Entendiendo tu pedido', edit: 'Preparando el cambio', compose: 'Escribiendo las variantes', image: 'Creando la imagen' }[String(step).split(':')[0]] || 'Trabajando';
      return '<div class="card row" role="status" aria-live="polite">' + icon('loader-circle', 'spinner') + '<span>' + esc(label) + '… Puedes seguir usando el panel; te avisamos aquí.</span></div>';
    }
    if (j.status === 'failed' || j.status === 'cancelled') {
      return '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span><strong>No se pudo completar</strong>' + esc(JOB_ERR[j.error_code] || 'Inténtalo de nuevo.') + '</span></div>';
    }
    return doneHtml(j.result || {});
  }

  function head(title, sub, extra) {
    return '<div class="page-head"><h1 tabindex="-1" data-focus>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + (extra || '') + '</div>';
  }
  function lock(text) { return '<div class="banner banner-lila">' + icon('lock') + '<span>' + esc(text) + '</span></div>'; }
  function simTag(sim) { return sim ? UI.sim('Simulado') : UI.tag('IA', 'nopal'); }
  function inactiveNote(uc) {
    var a = A.active(uc);
    if (!a || a.active) return a && a.simulated ? '<p class="tiny">' + UI.sim('Simulado') + ' En este entorno esta función usa el simulador: no es una respuesta real de IA.</p>' : '';
    return '<div class="banner banner-lila">' + icon('info') + '<span><strong>Todavía no está activa</strong>El equipo de MainSpot la activa cuando termina de probarla.</span></div>';
  }
  var back = function (tab) { return { tab: tab || 'ia', screen: 'AI', back: '#/ia', backLabel: 'IA de tu negocio' }; };

  /* ======================================================== hub + asistente */
  function hub() {
    A.need('status');
    var m = mem();
    var html = head('IA de tu negocio', 'Pregunta por tu cuenta, crea tu página, escribe publicaciones y planea tus campañas. Nada se publica sin tu aprobación.');
    html += '<div class="stack-lg">';
    if (MS.can('assistant.ask')) {
      html += '<section class="card stack" aria-labelledby="as-t"><h2 id="as-t" style="font-size:var(--fs-lg)">' + icon('sparkles') + ' Pregúntale a MainSpot</h2>' +
        '<form class="stack" data-form="ai-ask"><div class="field"><label for="ai-q">¿Qué quieres saber de tu negocio?</label><textarea class="textarea" id="ai-q" maxlength="1500" rows="2" placeholder="¿Qué comentarios necesitan mi respuesta? ¿Cuántas publicaciones hice esta semana?"></textarea></div>' +
        '<div class="btn-row">' + UI.btn('Preguntar', { type: 'submit', id: 'ai-ask-btn', icon: 'send' }) + '</div></form>' + inactiveNote('conversation.owner.assistant') +
        '<div id="ai-answer" aria-live="polite">' + answerHtml(m.answer) + '</div></section>';
    }
    var tiles = [
      ['#/ia/pagina', 'globe', 'Tu página con IA', 'Diseño a la medida y cambios con tus palabras.', MS.can('ai.generate')],
      ['#/ia/publicar', 'megaphone', 'Publicación para Facebook', 'Variantes con imagen, emojis y llamada a la acción.', MS.can('ai.generate') && MS.can('social.create')],
      ['#/ia/calendario', 'calendar', 'Calendario editorial', 'Ideas fechadas según tu marca.', MS.can('social.read')],
      ['#/ia/resumen', 'chart-line', 'Resumen de tu negocio', 'Qué pasó y qué te recomendamos, con datos.', MS.can('insights.read')],
      ['#/ia/campanas', 'flask-conical', 'Campañas propuestas', 'Planes sin gastar dinero hasta que tú lo autorices.', MS.can('insights.read')],
      ['#/ia/marca', 'palette', 'Mi marca', 'Los datos que MainSpot usa para hablar como tú.', MS.can('brand.read')],
      ['#/ia/biblioteca', 'image', 'Biblioteca de imágenes', 'Tus fotos e ilustraciones para la página y redes.', MS.can('media.read')]
    ];
    html += '<section aria-labelledby="ia-tools"><h2 id="ia-tools" class="sr-only">Herramientas</h2><ul class="list card card-flush">' + tiles.filter(function (t) { return t[4]; }).map(function (t) {
      return '<li><a class="list-row" href="' + t[0] + '">' + icon(t[1]) + '<span class="grow"><span class="title" style="display:block">' + esc(t[2]) + '</span><span class="sub" style="display:block">' + esc(t[3]) + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>';
    }).join('') + '</ul></section>';
    if (m.status && m.status.budget_today_usd && m.status.budget_today_usd.limit !== null) {
      html += '<p class="tiny">Uso de IA hoy: USD ' + Number(m.status.budget_today_usd.spent).toFixed(4) + ' de ' + Number(m.status.budget_today_usd.limit).toFixed(2) + '.</p>';
    }
    html += '</div>';
    return Object.assign({ title: 'IA de tu negocio', html: html }, { tab: 'ia', screen: 'AI' });
  }
  function answerHtml(a) {
    if (!a) return '';
    if (a.error) return '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(a.error) + '</span></div>';
    return '<div class="card stack" style="margin-top:12px"><div class="row" style="justify-content:space-between"><strong>Respuesta</strong>' + simTag(a.simulated) + '</div><p>' + esc(a.answer) + '</p>' +
      (a.evidence && a.evidence.length ? '<details><summary>De dónde sale</summary><ul>' + a.evidence.map(function (e) { return '<li><strong>' + esc(e.tool) + ':</strong> ' + esc(e.summary) + '</li>'; }).join('') + '</ul></details>' : '') +
      (a.suggested_action ? '<p class="tiny">' + icon('info', 'ic-sm') + ' ' + esc(a.suggested_action) + '</p>' : '') + '</div>';
  }

  /* ======================================================== página */
  function pagina() {
    A.need('status');
    A.need('jobs');
    if (!MS.can('ai.generate')) return Object.assign({ title: 'Tu página con IA', html: head('Tu página con IA') + lock('Tu perfil no puede pedir diseños ni cambios a la IA.') }, back());
    var S = MS.S, j = jobOf('website.');
    var html = head('Tu página con IA', 'MainSpot propone; tú ves la vista previa y decides si se publica.');
    html += '<div class="stack-lg">';
    if (!S.website) {
      html += UI.empty('Primero crea tu página', 'Con los datos de tu negocio armamos la base; después la IA la diseña a tu medida.', UI.btn('Crear mi página', { href: '#/pagina/crear' }));
    } else {
      html += '<form class="card stack" data-form="ai-design"><h2 style="font-size:var(--fs-lg)">' + icon('sparkles') + ' Diseño a la medida</h2>' +
        '<div class="field"><label for="ai-brief">¿Cómo te gustaría que se sintiera tu página? (opcional)</label><textarea class="textarea" id="ai-brief" maxlength="1500" rows="3" placeholder="Cálida y artesanal; que inviten a visitarnos para desayunar."></textarea></div>' +
        '<p class="hint">Usamos solo los datos confirmados de <a href="#/ia/marca">tu marca</a>. Las imágenes salen de tu biblioteca o se generan como ilustraciones (nunca se presentan como fotos de tu local).</p>' +
        '<div class="btn-row">' + UI.btn('Diseñar mi página', { type: 'submit', id: 'ai-design-btn', icon: 'sparkles' }) + '</div>' + inactiveNote('website.initial.design') + '</form>';
      if (S.site && S.site.published) {
        html += '<form class="card stack" data-form="ai-edit"><h2 style="font-size:var(--fs-lg)">' + icon('pencil') + ' Pedir un cambio con tus palabras</h2>' +
          '<div class="field"><label for="ai-instr">¿Qué quieres cambiar?</label><textarea class="textarea" id="ai-instr" maxlength="1000" rows="2" placeholder="Pon el color principal en verde oscuro y agrega una sección de preguntas frecuentes."></textarea></div>' +
          '<div class="btn-row">' + UI.btn('Preparar el cambio', { type: 'submit', id: 'ai-edit-btn' }) + '</div>' + inactiveNote('website.edit.simple') + '</form>';
      }
    }
    if (j) {
      html += '<section aria-labelledby="job-t" class="stack"><h2 id="job-t" style="font-size:var(--fs-lg)">Tu último pedido</h2>' + jobCard(j, function (r) {
        if (r.status === 'needs_clarification') return '<div class="banner banner-lila">' + icon('info') + '<span><strong>Necesitamos un detalle más</strong>' + esc(r.question) + '</span></div>';
        if (r.status === 'not_web_edit') return '<div class="banner banner-lila">' + icon('info') + '<span>' + esc(r.message) + '</span></div>';
        if (!r.proposal_id) return '';
        var blocked = (r.images_blocked || []).length ? '<p class="tiny">Algunas imágenes no se generaron (' + esc((r.images_blocked || []).join(', ')) + '). Puedes subir fotos a tu biblioteca.</p>' : '';
        return '<div class="card stack"><div class="row" style="justify-content:space-between"><strong>La vista previa está lista</strong>' + simTag(r.simulated) + '</div>' +
          '<p>Revísala antes de decidir. Nada cambia en tu página hasta que se apruebe.</p>' + blocked +
          '<div class="btn-row">' + UI.btn('Ver la vista previa', { href: '#/vista-previa/' + r.proposal_id, id: 'ai-open-preview' }) + '</div></div>';
      }) + '</section>';
    }
    html += '</div>';
    return Object.assign({ title: 'Tu página con IA', html: html }, back('pagina'));
  }

  /** Vista previa del servidor (el mismo HTML que se publicaría) para propuestas con diseño. */
  A.previewFrame = function (id, ver) {
    var key = id + ':' + ver, cached = A.render[key];
    if (!cached) {
      A.render[key] = { loading: true };
      API.get(id === 'published' ? '/ai/website/render' : '/ai/website/proposals/' + encodeURIComponent(id) + '/render' + (ver === 'antes' ? '?ver=antes' : '')).then(function (r) {
        A.render[key] = r.ok ? { html: r.data.html } : { error: r.error.message };
        emit();
      });
      cached = A.render[key];
    }
    if (cached.loading) return '<div class="card" aria-busy="true"><div class="skeleton" style="height:420px;border-radius:16px"></div></div>';
    if (cached.error) return '<div class="banner banner-alerta">' + icon('triangle-alert') + '<span>' + esc(cached.error) + '</span></div>';
    // Sin scripts (sandbox sin allow-scripts); misma procedencia solo para cargar imágenes de la biblioteca.
    return '<iframe class="site-frame" title="' + (ver === 'antes' ? 'Tu página como se ve hoy' : 'Vista previa de tu página') + '" sandbox="allow-same-origin" referrerpolicy="no-referrer" style="width:100%;height:min(80vh,900px);border:1px solid var(--line, #ddd);border-radius:16px;background:#fff" srcdoc="' + esc(cached.html) + '"></iframe>';
  };

  /* ======================================================== publicar */
  function publicar() {
    A.need('status');
    A.need('jobs');
    if (!MS.can('ai.generate') || !MS.can('social.create')) return Object.assign({ title: 'Publicación con IA', html: head('Publicación con IA') + lock('Tu perfil no puede crear publicaciones.') }, back('facebook'));
    var m = mem(), j = jobOf('social.compose');
    var pre = m.composePrefill || '';
    var html = head('Publicación para Facebook', 'Te proponemos variantes; eliges una, la ajustas y sigue el camino normal de aprobación.');
    html += '<div class="stack-lg"><form class="card stack" data-form="ai-compose"><div class="field"><label for="ai-req">¿Qué quieres publicar?</label><textarea class="textarea" id="ai-req" maxlength="1000" rows="3" placeholder="Anuncia que ya tenemos pan de muerto.">' + esc(pre) + '</textarea></div>' +
      '<label class="row"><input type="checkbox" id="ai-img"' + (A.active('social.facebook.image.generate') && A.active('social.facebook.image.generate').active ? ' checked' : ' disabled') + '> <span>Proponer también una ilustración' + (A.active('social.facebook.image.generate') && !A.active('social.facebook.image.generate').active ? ' (no disponible por ahora)' : '') + '</span></label>' +
      '<div class="btn-row">' + UI.btn('Proponer variantes', { type: 'submit', id: 'ai-compose-btn', icon: 'sparkles' }) + '</div>' + inactiveNote('social.facebook.post.compose') + '</form>';
    if (j) {
      html += '<section aria-labelledby="var-t" class="stack"><h2 id="var-t" style="font-size:var(--fs-lg)">Variantes</h2>' + jobCard(j, function (r) {
        var out = (r.warnings || []).map(function (w) { return '<div class="banner banner-ocre">' + icon('triangle-alert') + '<span>' + esc(w) + '</span></div>'; }).join('');
        var img = r.image && r.image.asset_id ? '<figure class="card"><img src="/media/' + encodeURIComponent(r.image.asset_id) + '/sq1080.webp" alt="' + esc(r.image.alt) + '" style="width:100%;max-width:420px;border-radius:12px"><figcaption class="tiny">Ilustración generada por IA · ' + esc(r.image.alt) + '</figcaption></figure>' : (r.image && r.image.status ? '<p class="tiny">La imagen no se generó (' + esc(r.image.status) + ').</p>' : '');
        out += '<form class="stack" data-form="ai-draft" data-job="' + esc(j.job_id) + '"><fieldset class="fieldset"><legend>Elige una variante ' + simTag(r.simulated) + '</legend>' + (r.variants || []).map(function (v, i) {
          return '<label class="radio-row' + (i === 0 ? ' is-on' : '') + '"><input type="radio" name="ai-variant" value="' + i + '"' + (i === 0 ? ' checked' : '') + '><span><span class="rr-t">' + esc(v.angle) + (v.duplicate_of ? ' ' + UI.tag('Parecida a una reciente', 'ocre') : '') + '</span><span class="rr-s" style="white-space:pre-wrap">' + esc(v.text) + '</span><span class="rr-s">' + esc(v.cta) + (v.hashtags && v.hashtags.length ? ' · ' + esc(v.hashtags.map(function (h) { return '#' + String(h).replace(/^#/, ''); }).join(' ')) : '') + '</span></span></label>';
        }).join('') + '</fieldset>' + img +
          '<div class="field"><label for="ai-edit-text">Si quieres, ajusta el texto (opcional)</label><textarea class="textarea" id="ai-edit-text" rows="4" maxlength="2000"></textarea></div>' +
          (r.image && r.image.asset_id ? '<label class="row"><input type="checkbox" id="ai-use-img" checked> <span>Usar la ilustración</span></label>' : '') +
          (r.suggested_slot ? '<p class="tiny">' + icon('calendar-clock', 'ic-sm') + ' Sugerencia: ' + esc(r.suggested_slot.weekday) + ' a las ' + esc(r.suggested_slot.hour) + ':00 — ' + esc(r.suggested_slot.why) + '</p>' : '') +
          '<div class="btn-row">' + UI.btn('Crear borrador', { type: 'submit', id: 'ai-draft-btn' }) + '</div><p class="tiny">El borrador sigue la aprobación normal de Facebook.</p></form>';
        return '<div class="card stack">' + out + '</div>';
      }) + '</section>';
    }
    html += '</div>';
    return Object.assign({ title: 'Publicación con IA', html: html }, back('facebook'));
  }

  /* ======================================================== marca */
  var BRAND_TEXT = ['name', 'category', 'description', 'value_proposition', 'voice', 'audience', 'language', 'avoid_tones', 'address', 'hours', 'cta', 'restrictions'];
  var BRAND_LIST = ['services', 'channels', 'fonts', 'locations'];
  function marca() {
    var b = A.need('brand');
    if (!MS.can('brand.read')) return Object.assign({ title: 'Mi marca', html: head('Mi marca') + lock('Tu perfil no puede ver la marca.') }, back());
    var can = MS.can('brand.manage');
    var html = head('Mi marca', 'MainSpot solo usa como dato lo que está confirmado aquí. Lo demás nunca se presenta como hecho.');
    if (!b) return Object.assign({ title: 'Mi marca', html: html + '<div class="skeleton" style="height:300px;border-radius:16px"></div>' }, back());
    if (b.error) return Object.assign({ title: 'Mi marca', html: html + '<div class="banner banner-alerta">' + esc(b.error) + '</div>' }, back());
    var by = {};
    b.facts.forEach(function (f) { by[f.key] = f; });
    function st(f) { return f && f.status ? UI.tag(f.status === 'confirmed' ? 'Confirmado' : f.status === 'unconfirmed' ? 'Sugerido, sin confirmar' : 'Descartado', f.status === 'confirmed' ? 'nopal' : 'ocre') : UI.tag('Sin dato', 'neutral'); }
    function val(f) { return f && f.value != null && f.status !== 'rejected' ? f.value : null; }
    var form = '<form class="stack" data-form="ai-brand">';
    BRAND_TEXT.forEach(function (k) {
      var f = by[k], v = val(f);
      form += '<div class="field"><label for="br-' + k + '">' + esc(f ? f.label : k) + ' ' + st(f) + '</label>' + (k === 'description' || k === 'restrictions' ? '<textarea class="textarea" rows="3"' : '<input class="input"') + ' id="br-' + k + '" data-key="' + k + '"' + (can ? '' : ' readonly') + (k === 'description' || k === 'restrictions' ? '>' + esc(v || '') + '</textarea>' : ' value="' + esc(v || '') + '">') + '</div>';
    });
    BRAND_LIST.forEach(function (k) {
      var f = by[k], v = val(f);
      form += '<div class="field"><label for="br-' + k + '">' + esc(f ? f.label : k) + ' ' + st(f) + '</label><input class="input" id="br-' + k + '" data-key="' + k + '" data-list="1" placeholder="Separa con comas"' + (can ? '' : ' readonly') + ' value="' + esc(Array.isArray(v) ? v.join(', ') : '') + '"></div>';
    });
    var pal = val(by.palette);
    form += '<div class="field"><label for="br-palette">' + esc(by.palette ? by.palette.label : 'Colores') + ' ' + st(by.palette) + '</label><input class="input" id="br-palette" data-key="palette" data-list="1" placeholder="#7a3e1d, #f4e9dc"' + (can ? '' : ' readonly') + ' value="' + esc(Array.isArray(pal) ? pal.join(', ') : '') + '">' + (Array.isArray(pal) ? '<div class="row" aria-hidden="true">' + pal.map(function (c) { return '<span style="display:inline-block;width:24px;height:24px;border-radius:6px;border:1px solid #0002;background:' + esc(c) + '"></span>'; }).join('') + '</div>' : '') + '</div>';
    var prices = val(by.prices), promos = val(by.promotions);
    form += '<div class="field"><label for="br-prices">' + esc(by.prices ? by.prices.label : 'Precios') + ' ' + st(by.prices) + '</label><textarea class="textarea" rows="3" id="br-prices" data-key="prices" placeholder="Café de olla | $35"' + (can ? '' : ' readonly') + '>' + esc(Array.isArray(prices) ? prices.map(function (p) { return p.item + ' | ' + p.price; }).join('\n') : '') + '</textarea><p class="hint">Un precio por línea: producto | precio. Solo estos se pueden citar.</p></div>';
    form += '<div class="field"><label for="br-promotions">' + esc(by.promotions ? by.promotions.label : 'Promociones') + ' ' + st(by.promotions) + '</label><textarea class="textarea" rows="3" id="br-promotions" data-key="promotions" placeholder="2x1 en café de olla los martes | 2026-11-30"' + (can ? '' : ' readonly') + '>' + esc(Array.isArray(promos) ? promos.map(function (p) { return p.text + ' | ' + p.valid_until; }).join('\n') : '') + '</textarea><p class="hint">Una por línea: texto | fecha de fin (AAAA-MM-DD). Al vencer, deja de usarse sola.</p></div>';
    form += (can ? '<div class="btn-row">' + UI.btn('Guardar y confirmar', { type: 'submit', id: 'ai-brand-save' }) + '</div><p class="tiny">Guardar confirma estos datos a tu nombre (versión ' + esc(b.version) + ' → nueva versión). Las propuestas abiertas hechas con datos anteriores se marcan como desactualizadas.</p>' : '<p class="tiny">Solo Administración puede confirmar datos de la marca.</p>') + '</form>';
    var html2 = html + '<div class="card">' + form + '</div>';
    if (mem().brandSaved) html2 = html + '<div class="banner banner-nopal" role="status">' + icon('circle-check') + '<span>' + esc(mem().brandSaved) + '</span></div><div class="card" style="margin-top:12px">' + form + '</div>';
    return Object.assign({ title: 'Mi marca', html: html2 }, back());
  }

  /* ======================================================== biblioteca */
  function biblioteca() {
    var d = A.need('media');
    if (!MS.can('media.read')) return Object.assign({ title: 'Biblioteca', html: head('Biblioteca') + lock('Tu perfil no puede ver la biblioteca.') }, back());
    var can = MS.can('media.manage');
    var html = head('Biblioteca de imágenes', 'Fotos tuyas e ilustraciones generadas. Se guardan sin datos de ubicación (EXIF).');
    if (can) {
      html += '<form class="card stack" data-form="ai-upload"><h2 style="font-size:var(--fs-lg)">' + icon('upload') + ' Subir una foto</h2>' +
        '<div class="field"><label for="up-file">Imagen (PNG, JPG o WebP, hasta 8 MB)</label><input class="input" type="file" id="up-file" accept="image/png,image/jpeg,image/webp"></div>' +
        '<div class="field"><label for="up-alt">Describe la imagen para quien no puede verla</label><input class="input" id="up-alt" maxlength="160" placeholder="Taza de café de olla sobre mesa de madera"></div>' +
        '<label class="row"><input type="checkbox" id="up-rights"> <span>Confirmo que la foto es mía o que tengo derecho a usarla.</span></label>' +
        '<div class="field-error" id="up-error" role="alert" hidden></div>' +
        '<div class="btn-row">' + UI.btn('Subir', { type: 'submit', id: 'up-btn' }) + '</div></form>';
    }
    if (!d) return Object.assign({ title: 'Biblioteca', html: html + '<div class="skeleton" style="height:200px;margin-top:16px"></div>' }, back());
    var assets = (d.assets || []).filter(function (a) { return a.status !== 'archived'; });
    html += assets.length ? '<ul class="media-grid" style="list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:16px">' + assets.map(function (a) {
      return '<li class="card stack" style="padding:10px"><img src="' + esc(a.url) + '" alt="' + esc(a.alt_text) + '" loading="lazy" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px">' +
        '<div class="row" style="flex-wrap:wrap;gap:6px">' + UI.tag(a.source === 'ai_generated' ? 'Ilustración IA' : 'Tuya', a.source === 'ai_generated' ? 'lila' : 'nopal') + UI.tag(a.status === 'approved' ? 'Aprobada' : 'Borrador', a.status === 'approved' ? 'nopal' : 'neutral') + '</div>' +
        '<p class="tiny">' + esc(a.alt_text) + '</p>' +
        (can ? '<div class="btn-row">' + (a.status === 'draft' ? UI.btn('Aprobar', { action: 'ai-media', arg: a.asset_id + '|approved', sm: true, style: 'secondary' }) : '') + UI.btn('Archivar', { action: 'ai-media', arg: a.asset_id + '|archived', sm: true, style: 'ghost' }) + '</div>' : '') + '</li>';
    }).join('') + '</ul>' : UI.empty('Tu biblioteca está vacía', 'Sube fotos de tus productos o de tu local; también guardamos aquí las ilustraciones que generes.', '');
    return Object.assign({ title: 'Biblioteca', html: html }, back());
  }

  /* ======================================================== calendario */
  function calendario() {
    var d = A.need('editorial');
    var html = head('Calendario editorial', 'Ideas fechadas a partir de tu marca. Aceptarlas no publica nada.');
    if (MS.can('ai.generate')) {
      html += '<form class="card stack" data-form="ai-editorial"><div class="hours-grid" style="grid-template-columns:1fr 1fr"><div class="field"><label for="ed-start">Desde</label><input class="input" type="date" id="ed-start" value="' + new Date(Date.now() + 864e5).toISOString().slice(0, 10) + '"></div>' +
        '<div class="field"><label for="ed-freq">Frecuencia</label><select class="select" id="ed-freq"><option>2 por semana</option><option selected>3 por semana</option><option>5 por semana</option></select></div></div>' +
        '<div class="btn-row">' + UI.btn('Sugerir ideas', { type: 'submit', id: 'ed-btn', icon: 'sparkles' }) + '</div>' + inactiveNote('editorial.calendar.suggest') + '</form>';
    }
    if (mem().editorialError) html += '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(mem().editorialError) + '</span></div>';
    var ideas = d && d.ideas ? d.ideas : [];
    html += ideas.length ? '<ul class="list card card-flush" style="margin-top:16px">' + ideas.map(function (i) {
      var acts = i.status === 'suggested' && MS.can('social.create') ? UI.btn('Aceptar', { action: 'ai-idea', arg: i.suggestion_id + '|accept', sm: true, style: 'secondary' }) + UI.btn('Descartar', { action: 'ai-idea', arg: i.suggestion_id + '|reject', sm: true, style: 'ghost' }) : '';
      var write = (i.status === 'accepted' || i.status === 'suggested') && MS.can('ai.generate') ? UI.btn('Escribir esta publicación', { action: 'ai-idea-write', arg: i.suggestion_id, sm: true }) : '';
      return '<li class="list-row static stack" style="align-items:flex-start"><span class="lead">' + icon('calendar') + '</span><span class="grow"><span class="title" style="display:block">' + esc(MS.date ? MS.date(i.suggested_for) : i.suggested_for) + ' · ' + esc(i.idea) + '</span><span class="sub" style="display:block">' + esc(i.rationale) + '</span><span>' + UI.tag({ suggested: 'Sugerida', accepted: 'Aceptada', rejected: 'Descartada', used: 'Usada' }[i.status] || i.status, i.status === 'accepted' || i.status === 'used' ? 'nopal' : 'neutral') + '</span><span class="btn-row" style="margin-top:6px">' + acts + write + '</span></span></li>';
    }).join('') + '</ul>' : (d ? UI.empty('Sin ideas por ahora', 'Pide sugerencias y aparecerán aquí con su fecha.', '') : '');
    return Object.assign({ title: 'Calendario editorial', html: html }, back('facebook'));
  }

  /* ======================================================== resumen */
  function resumen() {
    var m = mem();
    var html = head('Resumen de tu negocio', 'Con tus datos reales en MainSpot. Si no hay suficientes, te lo decimos en lugar de adivinar.');
    html += '<div class="card stack"><div class="btn-row">' + UI.btn('Últimos 7 días', { action: 'ai-insight', arg: '7', id: 'ins-7' }) + UI.btn('Últimos 30 días', { action: 'ai-insight', arg: '30', style: 'secondary', id: 'ins-30' }) + '</div>' + inactiveNote('business.insights.generate') + '</div>';
    var i = m.insight;
    if (i && i.error) html += '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(i.error) + '</span></div>';
    else if (i) {
      html += '<section class="card stack" aria-live="polite" style="margin-top:12px"><div class="row" style="justify-content:space-between"><strong>' + esc(i.period) + '</strong>' + UI.tag(i.status === 'abstained' ? 'Sin datos suficientes' : 'Resumen', i.status === 'abstained' ? 'neutral' : 'nopal') + '</div><p>' + esc(i.summary) + '</p>' +
        (i.abstain_reason ? '<p class="tiny">' + esc(i.abstain_reason) + '</p>' : '') +
        (i.highlights && i.highlights.length ? '<ul>' + i.highlights.map(function (h) { return '<li><strong>' + esc(h.label) + ':</strong> ' + esc(h.value) + ' <span class="tiny">(' + esc(h.metric) + ')</span></li>'; }).join('') + '</ul>' : '') +
        (i.recommendations && i.recommendations.length ? '<h3 style="font-size:var(--fs-md)">Recomendaciones</h3><ol>' + i.recommendations.map(function (r) { return '<li><strong>' + esc(r.title) + '</strong> — ' + esc(r.why) + ' <span class="tiny">(' + esc(r.metric) + ')</span></li>'; }).join('') + '</ol>' : '') +
        '<details><summary>Datos usados</summary><ul>' + Object.keys(i.metrics || {}).map(function (k) { return '<li>' + esc(k) + ': ' + esc(i.metrics[k] === null ? 'sin dato' : i.metrics[k]) + '</li>'; }).join('') + '</ul></details></section>';
    }
    return Object.assign({ title: 'Resumen', html: html }, back());
  }

  /* ======================================================== campañas */
  function campanas() {
    var d = A.need('campaigns');
    var html = head('Campañas propuestas', 'MainSpot prepara el plan. Aprobarlo NO gasta dinero: los anuncios requieren una cuenta publicitaria autorizada por ti.');
    html += '<div class="banner banner-lila">' + icon('lock') + '<span><strong>Sin gasto automático</strong>MainSpot no activa anuncios ni cobra publicidad. Hoy no hay cuenta publicitaria autorizada.</span></div>';
    if (MS.can('campaign.plan')) {
      html += '<form class="card stack" data-form="ai-campaign" style="margin-top:12px"><div class="field"><label for="cmp-obj">¿Qué quieres lograr?</label><textarea class="textarea" id="cmp-obj" maxlength="1000" rows="2" placeholder="Que vengan más clientes a desayunar en noviembre."></textarea></div>' +
        '<div class="field"><label for="cmp-budget">¿Tienes un monto en mente? (pesos, opcional)</label><input class="input" type="number" min="0" step="50" id="cmp-budget"></div>' +
        '<div class="btn-row">' + UI.btn('Proponer campaña', { type: 'submit', id: 'cmp-btn', icon: 'sparkles' }) + '</div>' + inactiveNote('marketing.campaign.plan') + '</form>';
    }
    if (mem().campaignError) html += '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(mem().campaignError) + '</span></div>';
    var list = d && d.campaigns ? d.campaigns : [];
    html += list.map(function (c) {
      var p = c.plan || {};
      var budget = p.budget || {};
      return '<section class="card stack" style="margin-top:12px"><div class="row" style="justify-content:space-between"><h2 style="font-size:var(--fs-lg)">' + esc(p.name || c.objective) + '</h2>' + UI.tag({ proposed: 'Propuesta', plan_approved: 'Plan aprobado (sin gasto)', rejected: 'Descartada' }[c.status] || c.status, c.status === 'plan_approved' ? 'nopal' : 'neutral') + '</div>' +
        '<p>' + esc(p.objective || '') + '</p>' +
        (p.audience ? '<p class="tiny"><strong>Público:</strong> ' + esc(p.audience.description) + ' · ' + esc(p.audience.location) + '</p>' : '') +
        '<p class="tiny"><strong>Duración:</strong> ' + esc(p.duration_days) + ' días · <strong>Canales:</strong> ' + esc((p.channels || []).join(', ')) + '</p>' +
        '<p class="tiny"><strong>Presupuesto propuesto:</strong> ' + (budget.proposed_total_mxn != null ? '$' + esc(budget.proposed_total_mxn) + ' MXN' : 'sin monto (no lo diste)') + (budget.rationale ? ' — ' + esc(budget.rationale) : '') + '</p>' +
        ((p.creatives || []).length ? '<details><summary>Textos propuestos (' + p.creatives.length + ')</summary><ul>' + p.creatives.map(function (v) { return '<li style="white-space:pre-wrap">' + esc(v.text) + '</li>'; }).join('') + '</ul></details>' : '') +
        ((p.requires_authorization || []).length ? '<p class="tiny"><strong>Para activarla haría falta:</strong> ' + esc(p.requires_authorization.join('; ')) + '</p>' : '') +
        (c.status === 'proposed' && MS.can('campaign.approve') ? '<div class="btn-row">' + UI.btn('Aprobar el plan', { action: 'ai-campaign-decide', arg: c.campaign_id + '|approve', sm: true }) + UI.btn('Descartar', { action: 'ai-campaign-decide', arg: c.campaign_id + '|reject', sm: true, style: 'ghost' }) + '</div>' : '') + '</section>';
    }).join('');
    return Object.assign({ title: 'Campañas', html: html }, back());
  }

  V.ai = function (sub) {
    switch (sub) {
      case undefined: return hub();
      case 'pagina': return pagina();
      case 'publicar': return publicar();
      case 'marca': return marca();
      case 'biblioteca': return biblioteca();
      case 'calendario': return calendario();
      case 'resumen': return resumen();
      case 'campanas': return campanas();
      default: return Object.assign({ title: 'No encontrado', html: UI.empty('No encontramos esta pantalla', 'Puede que el enlace esté incompleto.', UI.btn('Ir a IA de tu negocio', { href: '#/ia' })) }, back());
    }
  };

  /* ======================================================== acciones y formularios */
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = icon('loader-circle', 'spinner') + '<span>' + esc(label || 'Un momento…') + '</span>'; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function toast(t, ic) { UI.toast(t, ic); }
  function startJob(path, body, btnId, after) {
    var btn = document.getElementById(btnId);
    busy(btn, true, 'Enviando…');
    API.post(path, body, { idempotencyKey: newKey() }).then(function (r) {
      busy(btn, false);
      if (!r.ok) { toast(r.error.message, 'circle-alert'); return; }
      A.trackJob(r.data.job);
      if (after) after(r.data.job);
    });
  }

  MS.aiForms = {
    'ai-ask': function () {
      var t = document.getElementById('ai-q'), q = t.value.trim();
      if (!q) { t.focus(); toast('Escribe tu pregunta', 'info'); return; }
      var btn = document.getElementById('ai-ask-btn');
      busy(btn, true, 'Pensando…');
      API.post('/ai/assistant', { question: q }, { idempotencyKey: newKey() }).then(function (r) {
        busy(btn, false);
        mem().answer = r.ok ? r.data : { error: r.error.message };
        emit();
        var a = document.getElementById('ai-answer');
        if (a) a.focus && a.focus();
      });
    },
    'ai-design': function () {
      startJob('/ai/website/design', { brief: document.getElementById('ai-brief').value.trim() }, 'ai-design-btn', function () { toast('Estamos diseñando tu página', 'sparkles'); });
    },
    'ai-edit': function () {
      var t = document.getElementById('ai-instr'), v = t.value.trim();
      if (!v) { t.focus(); toast('Escribe el cambio que quieres', 'info'); return; }
      startJob('/ai/website/edit', { instruction: v }, 'ai-edit-btn', function () { t.value = ''; toast('Estamos preparando el cambio', 'sparkles'); });
    },
    'ai-compose': function () {
      var t = document.getElementById('ai-req'), v = t.value.trim();
      if (!v) { t.focus(); toast('Escribe qué quieres publicar', 'info'); return; }
      var img = document.getElementById('ai-img');
      startJob('/ai/social/compose', { request: v, with_image: !!(img && img.checked && !img.disabled), editorial_id: mem().composeEditorial || null }, 'ai-compose-btn', function () { mem().composePrefill = ''; mem().composeEditorial = null; });
    },
    'ai-draft': function (form) {
      var picked = form.querySelector('input[name="ai-variant"]:checked');
      var btn = document.getElementById('ai-draft-btn');
      var useImg = document.getElementById('ai-use-img');
      busy(btn, true, 'Creando…');
      API.post('/ai/social/compose/' + encodeURIComponent(form.dataset.job) + '/draft', { variant: picked ? Number(picked.value) : 0, text: document.getElementById('ai-edit-text').value.trim(), use_image: !!(useImg && useImg.checked) }).then(function (r) {
        busy(btn, false);
        if (!r.ok) { toast(r.error.message, 'circle-alert'); return; }
        MS.refresh(['posts'], true).then(function () { MS.go('#/facebook/post/' + r.data.post.post_id); toast('Borrador creado. Prográmalo o envíalo a aprobación.'); });
      });
    },
    'ai-brand': function (form) {
      var changes = [];
      form.querySelectorAll('[data-key]').forEach(function (el) {
        var key = el.dataset.key, raw = el.value.trim();
        if (!raw) return;
        var value = raw;
        if (el.dataset.list) value = raw.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        if (key === 'prices') value = raw.split('\n').map(function (l) { var p = l.split('|'); return { item: (p[0] || '').trim(), price: (p[1] || '').trim() }; }).filter(function (p) { return p.item && p.price; });
        if (key === 'promotions') value = raw.split('\n').map(function (l) { var p = l.split('|'); return { text: (p[0] || '').trim(), valid_from: null, valid_until: (p[1] || '').trim() }; }).filter(function (p) { return p.text; });
        changes.push({ key: key, value: value });
      });
      if (!changes.length) { toast('Escribe al menos un dato', 'info'); return; }
      var btn = document.getElementById('ai-brand-save');
      busy(btn, true, 'Guardando…');
      API.put('/ai/brand', { changes: changes }).then(function (r) {
        busy(btn, false);
        if (!r.ok) { toast(r.error.message, 'circle-alert'); return; }
        mem().brandSaved = 'Guardado como versión ' + r.data.version + '.' + (r.data.stale_proposals ? ' ' + r.data.stale_proposals + ' propuesta(s) abierta(s) se hicieron con datos anteriores: revísalas o pídelas de nuevo.' : '');
        A.need('brand', true);
      });
    },
    'ai-upload': function () {
      var file = document.getElementById('up-file').files[0];
      var alt = document.getElementById('up-alt').value.trim();
      var rights = document.getElementById('up-rights').checked;
      var err = document.getElementById('up-error');
      var fail = function (m) { err.hidden = false; err.textContent = m; };
      err.hidden = true;
      if (!file) return fail('Elige una imagen.');
      if (!alt) return fail('Describe la imagen.');
      if (!rights) return fail('Confirma que tienes derecho a usarla.');
      if (file.size > 8 * 1024 * 1024) return fail('La imagen supera 8 MB.');
      var btn = document.getElementById('up-btn');
      busy(btn, true, 'Subiendo…');
      window.fetch('/api/backoffice/ai/media', { method: 'POST', headers: { Authorization: 'Bearer ' + API.token(), 'Content-Type': file.type, 'X-Alt-Text': encodeURIComponent(alt), 'X-Rights-Confirmed': 'yes' }, body: file, credentials: 'same-origin' })
        .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, data: j }; }); })
        .then(function (r) {
          busy(btn, false);
          if (!r.ok) return fail((r.data && r.data.error && r.data.error.message) || 'No pudimos subir la imagen.');
          toast('Imagen guardada en tu biblioteca');
          A.need('media', true);
        }, function () { busy(btn, false); fail('No pudimos subir la imagen.'); });
    },
    'ai-editorial': function () {
      var btn = document.getElementById('ed-btn');
      busy(btn, true, 'Pensando ideas…');
      mem().editorialError = null;
      API.post('/ai/editorial', { start_date: document.getElementById('ed-start').value, frequency: document.getElementById('ed-freq').value }, { idempotencyKey: newKey() }).then(function (r) {
        busy(btn, false);
        if (!r.ok) { mem().editorialError = r.error.message; emit(); return; }
        A.need('editorial', true);
      });
    },
    'ai-campaign': function () {
      var t = document.getElementById('cmp-obj'), v = t.value.trim();
      if (!v) { t.focus(); toast('Escribe qué quieres lograr', 'info'); return; }
      var b = document.getElementById('cmp-budget').value;
      var btn = document.getElementById('cmp-btn');
      busy(btn, true, 'Preparando el plan…');
      mem().campaignError = null;
      API.post('/ai/campaigns', { objective: v, budget_hint_mxn: b === '' ? null : Number(b) }, { idempotencyKey: newKey() }).then(function (r) {
        busy(btn, false);
        if (!r.ok) { mem().campaignError = r.error.message; emit(); return; }
        t.value = '';
        A.need('campaigns', true);
      });
    }
  };

  MS.aiActions = {
    'ai-media': function (el) {
      var p = el.dataset.arg.split('|');
      API.request('PATCH', '/api/backoffice/ai/media/' + encodeURIComponent(p[0]), { status: p[1] }).then(function (r) {
        if (!r.ok) { toast(r.error.message, 'circle-alert'); return; }
        toast(p[1] === 'approved' ? 'Imagen aprobada' : 'Imagen archivada');
        A.need('media', true);
      });
    },
    'ai-idea': function (el) {
      var p = el.dataset.arg.split('|');
      API.post('/ai/editorial/' + encodeURIComponent(p[0]) + '/decision', { decision: p[1] }).then(function (r) {
        if (!r.ok) { toast(r.error.message, 'circle-alert'); return; }
        A.need('editorial', true);
      });
    },
    'ai-idea-write': function (el) {
      var d = mem().editorial, idea = d && (d.ideas || []).filter(function (i) { return i.suggestion_id === el.dataset.arg; })[0];
      if (!idea) return;
      mem().composePrefill = idea.idea;
      mem().composeEditorial = idea.suggestion_id;
      MS.go('#/ia/publicar');
    },
    'ai-insight': function (el) {
      busy(el, true, 'Calculando…');
      API.post('/ai/insights', { period_days: Number(el.dataset.arg) }, { idempotencyKey: newKey() }).then(function (r) {
        busy(el, false);
        mem().insight = r.ok ? r.data : { error: r.error.message };
        emit();
      });
    },
    'ai-campaign-decide': function (el) {
      var p = el.dataset.arg.split('|');
      API.post('/ai/campaigns/' + encodeURIComponent(p[0]) + '/decision', { decision: p[1] }).then(function (r) {
        if (!r.ok) { toast(r.error.message, 'circle-alert'); return; }
        toast(p[1] === 'approve' ? 'Plan aprobado. No se activó ningún gasto.' : 'Campaña descartada');
        A.need('campaigns', true);
      });
    }
  };
})();
