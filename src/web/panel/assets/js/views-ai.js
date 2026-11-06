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
    jobs: function () { return API.get('/ai/jobs'); },
    lab: function () { return API.get('/ai/lab'); }
  };
  A.need = function (key, force) {
    var m = mem();
    if (!force && (m[key] || m['loading_' + key])) return m[key] || null;
    m['loading_' + key] = true;
    LOAD[key]().then(function (r) {
      m['loading_' + key] = false;
      // 403 con autorización de laboratorio elegida: NUNCA se reintenta sin header (podría ejecutar tráfico normal
      // y consumir crédito). La selección queda bloqueada con aviso hasta que la persona elija otra o salga.
      if (!r.ok && r.status === 403 && API.labGrant()) m.labBlocked = r.error.message;
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
  /* ---------- laboratorio manual (DEC-0074): rutas DRAFT solo con autorización explícita elegida aquí ---------- */
  /** Estado de laboratorio que el servidor confirmó para la autorización elegida (null si no hay o no es válida). */
  A.lab = function () {
    var st = mem().status;
    return st && st.lab && st.lab.grant_id === API.labGrant() && !mem().labBlocked ? st.lab : null;
  };
  /** Capacidad de laboratorio para un caso de uso; nunca sustituye a `active` normal. */
  A.labCap = function (uc) {
    var lab = A.lab();
    if (!lab || !lab.capabilities) return null;
    return lab.capabilities.filter(function (c) { return c.use_case === uc; })[0] || null;
  };
  function labExpired(lab) { return !!(lab && lab.expires_at && new Date(lab.expires_at).getTime() <= Date.now()); }
  function hhmm(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); }

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
          if (r.data.job.status === 'succeeded') { A.need('media', true); A.need('status', true); }
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
    budget_exhausted: 'Se alcanzó un presupuesto interno de IA. Los créditos del proveedor no amplían ese límite.',
    invalid_output: 'La propuesta no cumplió nuestras reglas de calidad. Intenta describirlo de otra forma.',
    website_missing: 'Todavía no tienes página.',
    provider_unavailable: 'El servicio de IA no respondió. Inténtalo en unos minutos.',
    timeout: 'El servicio de IA tardó demasiado. Inténtalo en unos minutos.',
    attempts_exhausted: 'Lo intentamos varias veces sin éxito. Inténtalo más tarde.',
    lab_grant_invalid: 'La autorización de laboratorio ya no es válida (caducó, fue revocada o no cubre esta función). Pide una nueva al equipo de MainSpot.'
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
  /** Capacidad de laboratorio tal como la devuelve /ai/status.lab (model = model_id, provider = provider_id). */
  function labRouteLine(c) { return esc(c.model_name || c.model || c.route_id) + ' · ' + esc(c.provider_kind || c.provider || '') + ' · ruta <span class="mono">' + esc(c.route_id) + '</span> (' + esc(c.status) + ')'; }
  function inactiveNote(uc) {
    var a = A.active(uc), lab = A.labCap(uc);
    // La ruta de laboratorio se informa aparte: nunca se muestra como «activa» normal.
    var labNote = lab ? '<p class="tiny">' + UI.tag('Laboratorio', 'lila') + ' Esta pantalla usará la ruta de laboratorio ' + labRouteLine(lab) + ' hasta las ' + esc(hhmm(A.lab().expires_at)) + '. Guarda el ID de invocación de la traza para la aceptación.</p>' : '';
    if (!a || a.active) return (a && a.simulated ? '<p class="tiny">' + UI.sim('Simulado') + ' En este entorno esta función usa el simulador: no es una respuesta real de IA.</p>' : '') + labNote;
    if (lab) return labNote;
    return '<div class="banner banner-lila">' + icon('info') + '<span><strong>Todavía no está activa</strong>El equipo de MainSpot la activa cuando termina de probarla.</span></div>';
  }
  /** Franja visible mientras hay una autorización de laboratorio elegida. Si el servidor la rechaza, todo queda
   *  bloqueado con aviso: no hay vuelta silenciosa al tráfico normal; solo «Elegir otra» o «Salir del laboratorio». */
  function labBanner() {
    var m = mem(), sel = API.labGrant();
    if (!sel) return '';
    var st = m.status, lab = A.lab();
    var exit = '<span class="btn-row" style="margin-top:6px"><a class="btn btn-secondary btn-sm" href="#/ia/laboratorio"><span>Elegir otra autorización</span></a>' + UI.btn('Salir del laboratorio', { action: 'ai-lab-clear', sm: true, style: 'ghost' }) + '</span>';
    if (m.labBlocked) {
      return '<div class="banner banner-ocre" role="alert">' + icon('triangle-alert') + '<span><strong>MainSpot rechazó la autorización de laboratorio elegida</strong>' + esc(m.labBlocked) + ' Las funciones de IA quedan en pausa (no se usa la ruta normal) hasta que elijas otra autorización o salgas del laboratorio.' + exit + '</span></div>';
    }
    if (!st) return '';
    if (!lab || lab.grant_id !== sel || labExpired(lab)) {
      return '<div class="banner banner-ocre" role="alert">' + icon('triangle-alert') + '<span><strong>La autorización de laboratorio ya no es válida</strong>Caducó, fue revocada o no corresponde a tu sesión. Las funciones de IA quedan en pausa hasta que elijas otra autorización o salgas del laboratorio.' + exit + '</span></div>';
    }
    return '<div class="banner banner-lila" role="status">' + icon('flask-conical') + '<span><strong>Rutas de laboratorio en uso hasta las ' + esc(hhmm(lab.expires_at)) + '</strong>' +
      'Autorización <span class="mono">' + esc(lab.grant_id) + '</span>. Lo que generes es un borrador que revisa el equipo de MainSpot; nada se publica solo.' +
      '<ul class="tiny" style="margin:6px 0 0 16px">' + (lab.capabilities || []).map(function (c) { return '<li>' + esc(c.use_case) + ': ' + labRouteLine(c) + '</li>'; }).join('') + '</ul>' +
      '<span class="btn-row" style="margin-top:6px"><a class="btn btn-ghost btn-sm" href="#/ia/laboratorio"><span>Ver laboratorio</span></a>' + UI.btn('Dejar de usar', { action: 'ai-lab-clear', sm: true, style: 'secondary' }) + '</span></span></div>';
  }
  var back = function (tab) { return { tab: tab || 'ia', screen: 'AI', back: '#/ia', backLabel: 'IA de tu negocio' }; };

  /* ======================================================== hub + asistente */
  function hub() {
    A.need('status');
    var m = mem();
    var html = head('IA de tu negocio', 'Pregunta por tu cuenta, crea tu página, escribe publicaciones y planea tus campañas. Nada se publica sin tu aprobación.');
    html += '<div class="stack-lg">' + labBanner();
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
      ['#/ia/biblioteca', 'image', 'Biblioteca de imágenes', 'Tus fotos e ilustraciones para la página y redes.', MS.can('media.read')],
      // Solo con el laboratorio habilitado (entorno `lab`, nunca producción): pruebas supervisadas con una autorización
      // explícita del equipo de MainSpot.
      ['#/ia/laboratorio', 'flask-conical', 'Laboratorio de IA', 'Prueba rutas nuevas con una autorización temporal; todo queda como borrador.', labAllowed() && !!(m.status && m.status.lab_enabled)]
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
  var TOOL_LABEL = { account_status: 'Tu cuenta y plan', website_status: 'Tu página', social_posts: 'Publicaciones', attention_cases: 'Atención a clientes', activity_metrics: 'Métricas de actividad', connections_status: 'Conexiones con Google y Facebook', brand_facts: 'Mi marca' };
  var NEXT_STEP = { open_page: ['Ver tu página', '#/pagina'], review_pending: ['Revisar cambios pendientes', '#/cambios'], review_cases: ['Ir a Atención', '#/atencion'], create_post: ['Crear una publicación', '#/ia/publicar'], plan_campaign: ['Planear una campaña', '#/ia/campanas'], edit_brand: ['Revisar Mi marca', '#/ia/marca'] };
  function answerHtml(a) {
    if (!a) return '';
    if (a.error) return '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(a.error) + '</span></div>';
    var next = NEXT_STEP[a.suggested_action];
    return '<div class="card stack" style="margin-top:12px"><div class="row" style="justify-content:space-between"><strong>Respuesta</strong>' + simTag(a.simulated) + '</div><p>' + esc(a.answer) + '</p>' +
      (a.evidence && a.evidence.length ? '<details><summary>De dónde sale</summary><ul>' + a.evidence.map(function (e) { return '<li><strong>' + esc(TOOL_LABEL[e.tool] || e.tool) + ':</strong> ' + esc(e.summary) + '</li>'; }).join('') + '</ul></details>' : '') +
      (next ? '<a class="btn btn-secondary btn-block" href="' + next[1] + '">' + esc(next[0]) + '</a>' : '') + '</div>';
  }

  /* ======================================================== página */
  function pagina() {
    A.need('status');
    A.need('jobs');
    if (!MS.can('ai.generate')) return Object.assign({ title: 'Tu página con IA', html: head('Tu página con IA') + lock('Tu perfil no puede pedir diseños ni cambios a la IA.') }, back());
    var S = MS.S, j = jobOf('website.');
    var html = head('Tu página con IA', 'MainSpot propone; tú ves la vista previa y decides si se publica.');
    html += '<div class="stack-lg">' + labBanner();
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
    // La ilustración se habilita por la ruta normal activa o, aparte, por una ruta de laboratorio autorizada (nunca se confunden).
    var imgNormal = A.active('social.facebook.image.generate'), imgLab = A.labCap('social.facebook.image.generate');
    var imgOn = !!((imgNormal && imgNormal.active) || imgLab);
    html += '<div class="stack-lg">' + labBanner() + '<form class="card stack" data-form="ai-compose"><div class="field"><label for="ai-req">¿Qué quieres publicar?</label><textarea class="textarea" id="ai-req" maxlength="1000" rows="3" placeholder="Anuncia que ya tenemos pan de muerto.">' + esc(pre) + '</textarea></div>' +
      '<label class="row"><input type="checkbox" id="ai-img"' + (imgOn ? ' checked' : ' disabled') + '> <span>Proponer también una ilustración' + (!imgOn && imgNormal ? ' (no disponible por ahora)' : '') + (imgOn && !(imgNormal && imgNormal.active) && imgLab ? ' ' + UI.tag('Laboratorio', 'lila') : '') + '</span></label>' +
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
    A.need('status');
    var html = head('Calendario editorial', 'Ideas fechadas a partir de tu marca. Aceptarlas no publica nada.') + labBanner();
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
    A.need('status');
    var html = head('Resumen de tu negocio', 'Con tus datos reales en MainSpot. Si no hay suficientes, te lo decimos en lugar de adivinar.') + labBanner();
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
    A.need('status');
    var html = head('Campañas propuestas', 'MainSpot prepara el plan. Aprobarlo NO gasta dinero: los anuncios requieren una cuenta publicitaria autorizada por ti.') + labBanner();
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
        '<p class="tiny"><strong>Duración:</strong> ' + esc(p.duration_days) + ' días · <strong>Canales:</strong> ' + esc((p.channels || []).map(function (c) { return { facebook_post: 'Publicaciones en Facebook', facebook_ads: 'Anuncios de Facebook (requieren autorización)' }[c] || c; }).join(', ')) + '</p>' +
        '<p class="tiny"><strong>Presupuesto propuesto:</strong> ' + (budget.proposed_total_mxn != null ? '$' + esc(budget.proposed_total_mxn) + ' MXN' : 'sin monto (no lo diste)') + (budget.rationale ? ' — ' + esc(budget.rationale) : '') + '</p>' +
        ((p.creatives || []).length ? '<details><summary>Textos propuestos (' + p.creatives.length + ')</summary><ul>' + p.creatives.map(function (v) { return '<li style="white-space:pre-wrap">' + esc(v.text) + '</li>'; }).join('') + '</ul></details>' : '') +
        ((p.requires_authorization || []).length ? '<p class="tiny"><strong>Para activarla haría falta:</strong> ' + esc(p.requires_authorization.join('; ')) + '</p>' : '') +
        (c.status === 'proposed' && MS.can('campaign.approve') ? '<div class="btn-row">' + UI.btn('Aprobar el plan', { action: 'ai-campaign-decide', arg: c.campaign_id + '|approve', sm: true }) + UI.btn('Descartar', { action: 'ai-campaign-decide', arg: c.campaign_id + '|reject', sm: true, style: 'ghost' }) + '</div>' : '') + '</section>';
    }).join('');
    return Object.assign({ title: 'Campañas', html: html }, back());
  }

  /* ======================================================== laboratorio manual (DEC-0074) */
  // Estilo por omisión exigido por el backend de imágenes de laboratorio (3–200, nunca vacío).
  var LAB_IMAGE_STYLE = 'Editorial contemporáneo';
  // Permisos del panel que el servidor exige por capacidad (ai.generate, assistant.ask, insights.read, campaign.plan…):
  // basta uno para ver el laboratorio; el backend decide qué capacidades puede recibir cada usuario.
  function labAllowed() { return ['ai.generate', 'assistant.ask', 'insights.read', 'campaign.plan'].some(function (p) { return MS.can(p); }); }
  // Dónde se ejercita cada capacidad desde el panel (pantallas existentes) o en los formularios directos de abajo.
  var LAB_SCREEN = {
    'conversation.owner.assistant': ['Asistente «Pregúntale a MainSpot»', '#/ia'],
    'website.initial.design': ['Tu página con IA · Diseño a la medida', '#/ia/pagina'],
    'website.edit.simple': ['Tu página con IA · Pedir un cambio', '#/ia/pagina'],
    'website.edit.complex': ['Tu página con IA · Pedir un cambio (el clasificador decide si es complejo)', '#/ia/pagina'],
    'website.image.generate': ['Imagen independiente (formulario de abajo) o Diseño a la medida', '#/ia/pagina'],
    'social.facebook.post.compose': ['Publicación para Facebook', '#/ia/publicar'],
    'social.facebook.image.generate': ['Imagen independiente (formulario de abajo) o Publicación con ilustración', '#/ia/publicar'],
    'engagement.facebook.comment.reply': ['Respuesta propuesta (formulario de abajo)', null],
    'engagement.google.review.reply': ['Respuesta propuesta (formulario de abajo)', null],
    'marketing.campaign.plan': ['Campañas propuestas', '#/ia/campanas'],
    'marketing.campaign.creatives': ['Campañas propuestas (textos del plan)', '#/ia/campanas'],
    'business.insights.generate': ['Resumen de tu negocio', '#/ia/resumen'],
    'editorial.calendar.suggest': ['Calendario editorial', '#/ia/calendario']
  };
  function grantState(g) {
    if (g.revoked_at || g.status === 'revoked') return ['Revocada', 'alerta'];
    if (g.status === 'expired' || (g.expires_at && new Date(g.expires_at).getTime() <= Date.now())) return ['Caducada', 'neutral'];
    return ['Vigente hasta las ' + hhmm(g.expires_at), 'nopal'];
  }
  function grantRoutes(g) { return Array.isArray(g.routes) ? g.routes : []; }
  /** Datos trazables de cada prueba: la persona los pasa al equipo de MainSpot para la aceptación. */
  function labResultMeta(r) {
    var items = [['info', 'ID de invocación', '<span class="mono">' + esc(r.invocation_id || '—') + '</span>']];
    if (r.classification_invocation_id) items.push(['info', 'ID de clasificación', '<span class="mono">' + esc(r.classification_invocation_id) + '</span>']);
    items.push(['sparkles', 'Modelo', esc(r.model || '—') + ' · ' + esc(r.provider || '—')]);
    items.push(['flask-conical', 'Ruta', '<span class="mono">' + esc(r.route_id || '—') + '</span>']);
    items.push(['chart-line', 'Costo', 'USD ' + esc(r.cost_usd != null ? Number(r.cost_usd).toFixed(6) : '—')]);
    return UI.facts(items);
  }
  function laboratorio() {
    var st = A.need('status'), d = A.need('lab'), m = mem();
    var ret = { tab: 'ia', screen: 'AI', back: '#/ia', backLabel: 'IA de tu negocio' };
    if (!labAllowed()) return Object.assign({ title: 'Laboratorio de IA', html: head('Laboratorio de IA') + lock('Tu perfil no puede usar el laboratorio de IA.') }, ret);
    var html = head('Laboratorio de IA', 'Pruebas supervisadas de rutas nuevas con una autorización temporal del equipo de MainSpot. Todo queda como borrador: nada se publica.');
    html += labBanner();
    if (!d || !st) return Object.assign({ title: 'Laboratorio de IA', html: html + '<div class="skeleton" style="height:240px;border-radius:16px"></div>' }, ret);
    if (d.error) return Object.assign({ title: 'Laboratorio de IA', html: html + '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(d.error) + '</span></div>' }, ret);
    var sel = API.labGrant(), lab = A.lab();
    var grants = (d.grants || []).slice();
    var usable = grants.filter(function (g) { return grantState(g)[1] === 'nopal'; });
    if (d.environment && d.environment !== 'lab') html += '<div class="banner banner-ocre">' + icon('info') + '<span><strong>Este entorno no es el laboratorio</strong>Aquí no se pueden usar rutas de laboratorio (entorno ' + esc(d.environment) + ').</span></div>';
    // 1) Elegir la autorización: nunca se activa sola; el ID elegido vive solo en esta pestaña.
    html += '<section class="card stack" aria-labelledby="lab-g-t"><h2 id="lab-g-t" style="font-size:var(--fs-lg)">' + icon('flask-conical') + ' Autorizaciones para tu cuenta</h2>';
    if (!grants.length) html += '<p class="muted">No hay autorizaciones de laboratorio para tu usuario. El equipo de MainSpot las emite desde su consola y te avisa.</p>';
    else {
      html += '<ul class="list card card-flush">' + grants.map(function (g) {
        var s = grantState(g), isSel = sel === g.grant_id;
        return '<li class="list-row static stack" style="align-items:flex-start"><span class="grow"><span class="title" style="display:block">' + UI.tag(s[0], s[1]) + (isSel ? ' ' + UI.tag(lab && lab.grant_id === g.grant_id ? 'En uso' : (m.labBlocked ? 'Rechazada por el servidor' : 'Elegida'), m.labBlocked && !(lab && lab.grant_id === g.grant_id) ? 'ocre' : 'lila') : '') + ' <span class="mono">' + esc(g.grant_id) + '</span></span>' +
          '<span class="sub" style="display:block">' + esc(g.reason || '') + (g.created_at ? ' · emitida ' + esc(MS.when(g.created_at)) : '') + '</span>' +
          '<ul class="tiny" style="margin:6px 0 0 16px">' + grantRoutes(g).map(function (r) { return '<li>' + esc(r.use_case_title || r.use_case_id) + ': ' + esc(r.model_name || r.model_id || r.route_id) + ' · ' + esc(r.provider_kind || r.provider_id || '') + ' · v' + esc(r.route_version) + ' <span class="mono">' + esc(r.route_id) + '</span> (' + esc(r.route_status) + ')' + (r.max_cost_usd != null ? ' · máx. USD ' + esc(r.max_cost_usd) + '/llamada' : '') + '</li>'; }).join('') + '</ul></span></li>';
      }).join('') + '</ul>';
      html += '<form class="stack" data-form="ai-lab-use"><div class="field"><label for="lab-grant-pick">Autorización que quieres usar</label><select class="select" id="lab-grant-pick">' + usable.map(function (g) { return '<option value="' + esc(g.grant_id) + '"' + ((m.labPick || sel) === g.grant_id ? ' selected' : '') + '>' + esc(g.grant_id) + ' · hasta las ' + esc(hhmm(g.expires_at)) + '</option>'; }).join('') + '</select></div>' +
        '<p class="hint">Al pulsar el botón, las pantallas de IA usarán las rutas autorizadas hasta su caducidad o hasta que dejes de usarlas. Se olvida al cerrar sesión. Cada prueba consume el presupuesto de laboratorio (y la clasificación, su cuota diaria).</p>' +
        '<div class="btn-row">' + UI.btn('Usar rutas de laboratorio', { type: 'submit', id: 'lab-use-btn', icon: 'flask-conical' }) + (sel ? UI.btn('Dejar de usar', { action: 'ai-lab-clear', style: 'secondary' }) : '') + '</div>' + (usable.length ? '' : '<p class="tiny">Ninguna autorización está vigente ahora mismo.</p>') + '</form>';
    }
    html += '</section>';
    if (!lab) {
      html += '<p class="tiny" style="margin-top:12px">Elige una autorización para ver qué pantallas puedes probar y los formularios directos de imagen y respuesta.</p>';
      return Object.assign({ title: 'Laboratorio de IA', html: html }, ret);
    }
    // 2) Dónde probar cada capacidad autorizada (pantallas existentes).
    html += '<section class="card stack" style="margin-top:12px" aria-labelledby="lab-c-t"><h2 id="lab-c-t" style="font-size:var(--fs-lg)">Qué puedes probar ahora</h2><ul class="list card card-flush">' + (lab.capabilities || []).map(function (c) {
      var where = LAB_SCREEN[c.use_case] || [c.use_case, null], normal = A.active(c.use_case);
      var inner = '<span class="grow"><span class="title" style="display:block">' + esc(where[0]) + '</span><span class="sub" style="display:block">' + esc(c.use_case) + ' · ' + labRouteLine(c) + (normal && normal.active ? ' · ' + UI.tag('también tiene ruta normal activa', 'neutral') : '') + '</span></span>';
      return '<li>' + (where[1] ? '<a class="list-row" href="' + where[1] + '">' + inner + icon('chevron-right', 'chev') + '</a>' : '<div class="list-row static">' + inner + '</div>') + '</li>';
    }).join('') + '</ul><p class="tiny">Después de cada prueba, el equipo de MainSpot revisa la traza por su ID de invocación y decide si la ruta queda probada. Aquí no se publica nada.</p></section>';
    var imgCap = A.labCap('website.image.generate') || A.labCap('social.facebook.image.generate');
    var replyCap = A.labCap('engagement.facebook.comment.reply') || A.labCap('engagement.google.review.reply');
    // 3) Imagen independiente: resultado = imagen en borrador en tu biblioteca + ID de invocación.
    if (imgCap) {
      html += '<form class="card stack" data-form="ai-lab-image" style="margin-top:12px"><h2 style="font-size:var(--fs-lg)">' + icon('image') + ' Imagen independiente</h2>' +
        '<div class="hours-grid" style="grid-template-columns:1fr 1fr"><div class="field"><label for="li-purpose">Para qué</label><select class="select" id="li-purpose">' + (A.labCap('website.image.generate') ? '<option value="website">Tu página</option>' : '') + (A.labCap('social.facebook.image.generate') ? '<option value="social">Redes sociales</option>' : '') + '</select></div>' +
        '<div class="field"><label for="li-aspect">Proporción</label><select class="select" id="li-aspect"><option value="1:1">Cuadrada (1:1)</option><option value="4:5">Vertical (4:5)</option><option value="3:4">Vertical (3:4)</option><option value="4:3">Horizontal (4:3)</option><option value="16:9">Panorámica (16:9)</option></select></div></div>' +
        '<div class="field"><label for="li-subject">¿Qué debe mostrar? (10–400 caracteres)</label><textarea class="textarea" id="li-subject" rows="2" minlength="10" maxlength="400" required placeholder="Pan de muerto recién horneado sobre una mesa de madera"></textarea></div>' +
        '<div class="field"><label for="li-style">Estilo (3–200 caracteres)</label><input class="input" id="li-style" minlength="3" maxlength="200" required value="' + esc(LAB_IMAGE_STYLE) + '" placeholder="' + esc(LAB_IMAGE_STYLE) + '"></div>' +
        '<p class="hint">Se guarda como ilustración en borrador en tu biblioteca; no se usa en tu página ni en redes hasta que la apruebes.</p>' +
        '<div class="btn-row">' + UI.btn('Generar imagen de prueba', { type: 'submit', id: 'lab-img-btn', icon: 'sparkles' }) + '</div></form>';
      var ir = m.labImage;
      if (ir && ir.error) html += '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(ir.error) + '</span></div>';
      else if (ir) {
        var asset = ir.asset || {};
        html += '<section class="card stack" aria-live="polite"><div class="row" style="justify-content:space-between"><strong>Imagen generada (borrador)</strong>' + simTag(ir.simulated) + '</div>' +
          (asset.asset_id ? '<figure><img src="' + esc(asset.url || ('/media/' + encodeURIComponent(asset.asset_id) + '/w640.webp')) + '" alt="' + esc(asset.alt || '') + '" style="width:100%;max-width:420px;border-radius:12px"><figcaption class="tiny">' + esc(asset.alt || '') + ' · <span class="mono">' + esc(asset.asset_id) + '</span></figcaption></figure>' : '') +
          labResultMeta(ir) + '<div class="btn-row"><a class="btn btn-secondary btn-sm" href="#/ia/biblioteca"><span>Ver en la biblioteca</span></a></div></section>';
      }
    }
    // 4) Respuesta propuesta: clasificación normal (TypeSafe) + redacción con la ruta de laboratorio; nunca se publica ni dispara al agente.
    if (replyCap) {
      html += '<form class="card stack" data-form="ai-lab-reply" style="margin-top:12px"><h2 style="font-size:var(--fs-lg)">' + icon('send') + ' Respuesta propuesta a un comentario o reseña</h2>' +
        '<div class="hours-grid" style="grid-template-columns:1fr 1fr"><div class="field"><label for="lr-origin">Origen</label><select class="select" id="lr-origin">' + (A.labCap('engagement.facebook.comment.reply') ? '<option value="facebook_comment">Comentario de Facebook</option>' : '') + (A.labCap('engagement.google.review.reply') ? '<option value="google_review">Reseña de Google</option>' : '') + '</select></div>' +
        '<div class="field"><label for="lr-rating">Estrellas (solo reseñas, opcional)</label><select class="select" id="lr-rating"><option value="">Sin calificación</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></div></div>' +
        '<div class="field"><label for="lr-message">Mensaje del cliente</label><textarea class="textarea" id="lr-message" rows="3" maxlength="2000" placeholder="¿Tienen pan de muerto de chocolate? ¿A qué hora abren el domingo?"></textarea></div>' +
        '<p class="hint">Primero se clasifica por la vía normal (consume la cuota diaria de clasificación) y después se redacta con la ruta de laboratorio. Solo ves la propuesta: no se contesta al cliente.</p>' +
        '<div class="btn-row">' + UI.btn('Proponer respuesta', { type: 'submit', id: 'lab-reply-btn', icon: 'sparkles' }) + '</div></form>';
      var rr = m.labReply;
      if (rr && rr.error) html += '<div class="banner banner-alerta" role="alert">' + icon('triangle-alert') + '<span>' + esc(rr.error) + '</span></div>';
      else if (rr) {
        var rep = rr.reply || {}, cls = rr.classification || {};
        html += '<section class="card stack" aria-live="polite"><div class="row" style="justify-content:space-between"><strong>Respuesta propuesta (no enviada)</strong>' + simTag(rr.simulated) + '</div>' +
          (rep.needs_human ? '<div class="banner banner-ocre">' + icon('info') + '<span><strong>Mejor que conteste una persona</strong>' + esc(rep.reason || '') + '</span></div>' : '') +
          '<p style="white-space:pre-wrap">' + esc(rep.text || '') + '</p>' +
          (Object.keys(cls).length ? '<details><summary>Clasificación</summary><ul>' + Object.keys(cls).map(function (k) { return '<li>' + esc(k) + ': ' + esc(typeof cls[k] === 'object' ? JSON.stringify(cls[k]) : cls[k]) + '</li>'; }).join('') + '</ul></details>' : '') +
          (rep.facts_used && rep.facts_used.length ? '<p class="tiny">Datos de tu marca usados: ' + esc(rep.facts_used.join(', ')) + '</p>' : '') +
          labResultMeta(rr) + '</section>';
      }
    }
    return Object.assign({ title: 'Laboratorio de IA', html: html }, ret);
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
      case 'laboratorio': return laboratorio();
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
        if (r.ok) A.need('status', true);
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
    },
    /* ---------- laboratorio manual: activación explícita y pruebas directas ---------- */
    'ai-lab-use': function () {
      var pick = document.getElementById('lab-grant-pick');
      var id = pick ? pick.value : '';
      if (!id) { toast('No hay una autorización vigente que elegir', 'info'); return; }
      mem().labPick = id;
      mem().labBlocked = null;
      API.setLabGrant(id);
      var btn = document.getElementById('lab-use-btn');
      busy(btn, true, 'Comprobando…');
      // El servidor confirma (o no) la autorización en /ai/status. Si la rechaza, la selección queda bloqueada con
      // aviso (nunca se vuelve al tráfico normal por sí solo): la persona elige otra o sale del laboratorio.
      LOAD.status().then(function (r) {
        busy(btn, false);
        mem().status = r.ok ? r.data : { error: r.error.message };
        if (!r.ok) { mem().labBlocked = r.error.message; toast(r.error.message, 'circle-alert'); emit(); return; }
        if (!A.lab() || A.lab().grant_id !== id) { mem().labBlocked = 'MainSpot no confirmó esa autorización para tu sesión (caducó, fue revocada o no te corresponde).'; toast(mem().labBlocked, 'circle-alert'); emit(); return; }
        toast('Rutas de laboratorio en uso hasta las ' + hhmm(A.lab().expires_at), 'flask-conical');
        emit();
      });
    },
    'ai-lab-image': function () {
      var subj = document.getElementById('li-subject'), v = subj.value.trim();
      if (v.length < 10 || v.length > 400) { subj.focus(); toast('Describe qué debe mostrar la imagen (entre 10 y 400 caracteres)', 'info'); return; }
      var styleEl = document.getElementById('li-style'), style = styleEl.value.trim() || LAB_IMAGE_STYLE;
      if (style.length < 3 || style.length > 200) { styleEl.focus(); toast('El estilo debe tener entre 3 y 200 caracteres', 'info'); return; }
      var btn = document.getElementById('lab-img-btn');
      busy(btn, true, 'Generando…');
      API.post('/ai/lab/images', { purpose: document.getElementById('li-purpose').value, subject: v, style: style, aspect_ratio: document.getElementById('li-aspect').value }, { idempotencyKey: newKey() }).then(function (r) {
        busy(btn, false);
        mem().labImage = r.ok ? r.data : { error: r.error.message };
        if (r.ok) { A.need('media', true); A.need('status', true); }
        emit();
      });
    },
    'ai-lab-reply': function () {
      var msg = document.getElementById('lr-message'), v = msg.value.trim();
      if (!v) { msg.focus(); toast('Escribe el mensaje del cliente', 'info'); return; }
      var rating = document.getElementById('lr-rating').value;
      var origin = document.getElementById('lr-origin').value;
      var btn = document.getElementById('lab-reply-btn');
      busy(btn, true, 'Clasificando y redactando…');
      API.post('/ai/lab/replies', { origin: origin, message: v, rating: origin === 'google_review' && rating !== '' ? Number(rating) : null }, { idempotencyKey: newKey() }).then(function (r) {
        busy(btn, false);
        mem().labReply = r.ok ? r.data : { error: r.error.message };
        if (r.ok) A.need('status', true);
        emit();
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
    },
    /* Salida explícita del laboratorio (única vía, junto con logout/cambio de sesión, para dejar de enviar el header). */
    'ai-lab-clear': function () {
      var m = mem();
      API.setLabGrant(null);
      m.labPick = null;
      m.labImage = null;
      m.labReply = null;
      m.labBlocked = null;
      toast('Saliste del laboratorio: vuelven las funciones normales', 'circle-check');
      A.need('status', true);
    }
  };
  // Un redibujo (sondeo de jobs) no restaura <select>: la elección pendiente se recuerda en memoria.
  document.addEventListener('change', function (e) { if (e.target && e.target.id === 'lab-grant-pick') mem().labPick = e.target.value; });
})();
