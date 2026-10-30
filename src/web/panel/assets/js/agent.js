/* =====================================================================
   MainSpot · Agente de atención (contrato compartido §B), conectado a la API
   El worker del servidor observa, clasifica y responde SIN navegador:
     política opt-in + caso seguro → respuesta (simulada) con versión de regla
     si no → caso humano (panel + Telegram) con hasta 3 propuestas.
   Aquí solo se muestra el estado real y se envían decisiones humanas
   (aprobar / descartar / editar propuestas / reglas con consentimiento).
   Google y Meta: SIMULADOS mientras no haya conexión real verificada.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var API = MS.api;
  var S = function () { return MS.S; };
  var SRC = {
    google_review: { ch: 'google', label: 'Reseña de Google', short: 'Google', ic: 'map-pin', api: 'google_review' },
    facebook_comment: { ch: 'facebook', label: 'Comentario en Facebook', short: 'Facebook', ic: 'message-square-text', api: 'facebook_comment' }
  };
  var CAT_LABEL = { gratitude: 'Agradecimiento', basic_info: 'Pregunta sobre tu negocio', other: 'Otro tema' };
  var CAT = {
    thanks: 'Agradecimientos y comentarios positivos',
    info: 'Preguntas sobre datos de tu negocio',
    complaint: 'Quejas y molestias',
    sensitive: 'Descuentos, acusaciones y temas delicados'
  };
  var REASON = {
    category_not_safe: 'No es un caso simple: MainSpot no responde quejas ni temas delicados sin ti.',
    no_policy: 'No has autorizado respuestas automáticas para este tipo de mensaje.',
    policy_review_required: 'Tu regla para este tipo de mensaje es revisar primero.',
    low_confidence: 'MainSpot no está seguro de entenderlo bien. Prefiere que lo revises.',
    unverified_data: 'No hay un dato verificado para contestar.',
    rate_limited: 'Se alcanzó el máximo de respuestas automáticas por hora.',
    provider_failed: 'No se pudo publicar tras varios intentos. No se publicó nada.',
    delivery_uncertain: 'No sabemos si la respuesta llegó; revísala antes de reenviar.',
    answered_in_reviews: 'Ya se respondió desde Reseñas.'
  };
  var RISK = { legal: 'temas legales', compensation: 'compensaciones u ofertas', safety: 'salud o seguridad', threat: 'amenazas', accusation: 'acusaciones', private_data: 'datos privados' };
  function reasonText(code) {
    if (!code) return '';
    if (code.indexOf('risk:') === 0) return 'Menciona ' + code.slice(5).split(',').map(function (f) { return RISK[f] || f; }).join(', ') + '. Necesita tu criterio.';
    var pol = /^policy:[^:]+:v(\d+)$/.exec(code);
    if (pol) return 'Permitido por tu regla (versión ' + pol[1] + ').';
    return REASON[code] || code;
  }

  var AG = (MS.agent = { SRC: SRC, CAT: CAT, CAT_LABEL: CAT_LABEL, reasonText: reasonText });

  AG.STATUS = {
    received: { label: 'Recibido', tone: 'neutral' },
    classifying: { label: 'Analizando', tone: 'ocre' },
    needs_human: { label: 'Necesita tu decisión', tone: 'rosa' },
    responding: { label: 'Respondiendo', tone: 'ocre' },
    retry_pending: { label: 'Reintentaremos', tone: 'ocre' },
    failed: { label: 'No se pudo responder', tone: 'alerta' },
    responded: { label: 'Respondido', tone: 'nopal' },
    rejected: { label: 'Sin respuesta', tone: 'neutral' },
    handled_outside: { label: 'Respondido desde Reseñas', tone: 'neutral' }
  };
  var STATE = {
    received: 'received', classified: 'responding', responding: 'responding', responded: 'responded', needs_human: 'needs_human',
    approved: 'responding', rejected: 'rejected', retry_pending: 'retry_pending', failed: 'failed', closed_elsewhere: 'handled_outside'
  };
  AG.statusLabel = function (c) {
    if (c.status === 'responded') return c.response && c.response.auto ? 'Atendido por MainSpot' : 'Respondido por ' + String(c.response ? c.response.by : '').split(' ')[0];
    if (c.status === 'needs_human' && !MS.can('engagement.approve')) return 'Necesita decisión';
    return (AG.STATUS[c.status] || { label: c.status }).label;
  };

  /* Caso del backend → forma que usan las vistas. */
  AG.adapt = function (c) {
    var status = STATE[c.state] || c.state;
    var at = MS.ts(c.created_at);
    var ev = [];
    var push = function (iso, text, who) { var t = MS.ts(iso); if (t) ev.push({ at: t, text: text, who: who || 'MainSpot' }); };
    push(c.created_at, c.origin === 'google_review' ? 'Llegó una reseña' + (c.rating ? ' de ' + c.rating + ' estrellas' : '') : 'Llegó un comentario en tu publicación');
    if (c.classified_at) push(c.classified_at, 'Lo clasificamos: ' + (CAT_LABEL[c.category] || 'Otro tema') + (c.confidence ? ', confianza ' + Math.round(Number(c.confidence) * 100) + '%' : '') + '.');
    if (c.decision === 'human_review' && c.classified_at) push(c.classified_at, 'Necesita tu decisión: ' + reasonText(c.reason));
    if (c.notify_status === 'sent') push(c.classified_at || c.updated_at, 'Te avisamos por Telegram con las propuestas.');
    if (c.notify_status === 'no_destination') push(c.classified_at || c.updated_at, 'Telegram sin conectar: el caso queda solo en tu panel.');
    var auto = c.resolution_channel === 'auto';
    if (c.resolved_at && c.state === 'rejected') push(c.resolved_at, '[Decidiste|Decidió] no responder. La opinión sigue publicada tal cual.', MS.who(c.resolved_by));
    else if (c.resolved_at && !auto) push(c.resolved_at, '[Aprobaste|Aprobó] la respuesta ' + (c.resolution_channel === 'telegram' ? 'por Telegram' : 'desde el panel'), MS.who(c.resolved_by));
    if (c.responded_at) push(c.responded_at, auto ? 'MainSpot respondió por ti (' + (c.delivery_mode === 'real' ? 'proveedor' : 'simulado') + '). Regla versión ' + c.policy_version + '.' : 'Se publicó la respuesta (' + (c.delivery_mode === 'real' ? 'proveedor' : 'simulado') + ').');
    if (c.state === 'retry_pending' || c.state === 'failed') push(c.updated_at, 'No se pudo publicar (intento ' + c.attempts + '). No se publicó nada.');
    if (c.state === 'closed_elsewhere') push(c.updated_at, 'Se respondió desde Reseñas; no se responde dos veces.');
    ev.sort(function (a, b) { return a.at - b.at; });
    return {
      id: c.case_id, ext: c.external_ref, source: c.origin, author: c.author_label, rating: c.rating, text: c.body, post: c.post_id,
      category: c.category, riskFlags: c.risk_flags || [], confidence: c.confidence == null ? null : Number(c.confidence),
      status: status, rawState: c.state, at: at, updatedAt: MS.ts(c.updated_at), reasonCode: c.reason, reason: reasonText(c.reason),
      drafts: (c.drafts || []).map(function (t) { return { tone: '', text: t }; }),
      response: c.state === 'responded' ? { text: c.response_text, auto: auto, by: auto ? 'MainSpot' : MS.who(c.resolved_by), via: c.resolution_channel === 'telegram' ? 'tg' : 'panel', at: MS.ts(c.responded_at), policyVersion: c.policy_version, delivery: c.delivery_mode } : null,
      attempts: c.attempts, retryAt: MS.ts(c.next_attempt_at), policyVersion: auto ? c.policy_version : null, notify: c.notify_status,
      delivery: c.delivery_mode, events: ev
    };
  };

  AG.get = function (id) { return S().cases.filter(function (c) { return c.id === id; })[0] || null; };
  AG.needs = function () { return S().cases.filter(function (c) { return c.status === 'needs_human' || c.status === 'failed'; }); };
  AG.auto = function () { return S().cases.filter(function (c) { return c.status === 'responded' && c.response && c.response.auto; }); };
  AG.errors = function () { return S().cases.filter(function (c) { return c.status === 'failed' || c.status === 'retry_pending'; }); };
  AG.open = function (c) { return ['needs_human', 'failed', 'retry_pending', 'responding', 'received'].indexOf(c.status) >= 0; };

  /* ---------- Decisión humana: mismo servicio que Telegram (una sola resolución) ---------- */
  function after(res) {
    return MS.refresh(['cases', 'tgChat'], true).then(function () {
      return res.ok ? { ok: true, data: res.data, message: res.data && res.data.message } : { ok: false, status: res.status, message: res.error.message };
    });
  }
  /** Publica la respuesta elegida/editada (Administración). Repetir no publica dos veces. */
  AG.approve = function (id, text) {
    return API.post('/engagement/cases/' + encodeURIComponent(id) + '/approve', { text: text }).then(function (res) {
      return after(res).then(function (out) {
        if (out.ok && res.data.already_approved) out.message = 'Este caso ya tenía una decisión. No se responde dos veces.';
        return out;
      });
    });
  };
  AG.reject = function (id) {
    return API.post('/engagement/cases/' + encodeURIComponent(id) + '/reject').then(function (res) {
      return after(res).then(function (out) {
        if (out.ok && res.data.already_rejected) out.message = 'Este caso ya estaba descartado.';
        return out;
      });
    });
  };
  /** Operación propone: guarda su texto en la propuesta elegida para que Administración decida. */
  AG.saveDraft = function (id, index, text) {
    return API.post('/engagement/cases/' + encodeURIComponent(id) + '/drafts/' + (index + 1), { text: text }).then(after);
  };

  /* ---------- Reglas: matriz real (origen × categoría) ⇄ diseño (activar + tipos + dónde) ---------- */
  var COMBOS = [
    { origin: 'google_review', ch: 'google', category: 'gratitude', key: 'thanks' },
    { origin: 'google_review', ch: 'google', category: 'basic_info', key: 'info' },
    { origin: 'facebook_comment', ch: 'facebook', category: 'gratitude', key: 'thanks' },
    { origin: 'facebook_comment', ch: 'facebook', category: 'basic_info', key: 'info' }
  ];
  AG.COMBOS = COMBOS;
  function modeOf(rows, origin, category) {
    var r = rows.filter(function (x) { return x.origin === origin && x.category === category; })[0];
    return r ? r.mode : 'review_required';
  }
  AG.derivePolicy = function (rows) {
    var a = S().agent;
    a.rows = rows;
    var on = function (k, ch) { return COMBOS.some(function (c) { return c.key === k && (!ch || c.ch === ch) && modeOf(rows, c.origin, c.category) === 'safe_auto_reply'; }); };
    var enabled = on('thanks') || on('info');
    a.policy = {
      enabled: enabled,
      thanks: on('thanks') ? 'auto' : 'review',
      info: on('info') ? 'auto' : 'review',
      scope: { google: !enabled || on('thanks', 'google') || on('info', 'google'), facebook: !enabled || on('thanks', 'facebook') || on('info', 'facebook') }
    };
    a.version = rows.reduce(function (m, r) { return Math.max(m, r.version || 0); }, 0);
    a.versions = rows.filter(function (r) { return r.policy_id; }).map(function (r) {
      return {
        v: r.version, at: MS.ts(r.created_at), by: MS.who(r.decided_by),
        summary: SRC[r.origin].label.replace('Reseña', 'Reseñas').replace('Comentario', 'Comentarios') + ' · ' + (r.category === 'gratitude' ? 'agradecimientos' : 'preguntas con datos verificados') + ': ' + (r.mode === 'safe_auto_reply' ? 'responde MainSpot' : 'se revisa antes')
      };
    }).sort(function (x, y) { return (y.at || 0) - (x.at || 0); });
    if (!a.versions.length) a.versions = [{ v: 0, at: null, by: 'MainSpot', summary: 'Predeterminado: todas las respuestas públicas se revisan antes de publicarse.' }];
  };
  /** Combos que cambiarían con el borrador del diseño. */
  AG.policyChanges = function (d) {
    var rows = S().agent.rows || [];
    return COMBOS.map(function (c) {
      var want = d.enabled && d[c.key] === 'auto' && d.scope[c.ch] ? 'safe_auto_reply' : 'review_required';
      return { origin: c.origin, category: c.category, ch: c.ch, key: c.key, from: modeOf(rows, c.origin, c.category), mode: want };
    }).filter(function (x) { return x.from !== x.mode; });
  };
  /** Guarda solo lo que cambió; activar respuestas automáticas exige consentimiento explícito. */
  AG.setPolicy = function (d) {
    var changes = AG.policyChanges(d);
    var chain = Promise.resolve({ ok: true });
    changes.forEach(function (c) {
      chain = chain.then(function (prev) {
        if (!prev.ok) return prev;
        var body = { origin: c.origin, category: c.category, mode: c.mode };
        if (c.mode === 'safe_auto_reply') body.consent = true;
        return API.put('/engagement/policies', body).then(function (res) { return res.ok ? { ok: true } : { ok: false, message: res.error.message }; });
      });
    });
    return chain.then(function (out) { return MS.refresh(['policies', 'cases'], true).then(function () { return out; }); });
  };
})();
