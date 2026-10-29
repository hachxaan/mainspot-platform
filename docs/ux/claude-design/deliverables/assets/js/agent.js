/* =====================================================================
   MainSpot · Prototipo · Agente de atención (contrato compartido §B)
   Flujo: llega → se descarta si es duplicado → se clasifica →
     política opt-in + acción segura → respuesta SIMULADA con evidencia
     si no → caso humano (panel + Telegram) con hasta 3 propuestas.
   Todo es simulado: no hay conexión con Google ni Meta.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var S = function () { return MS.S; };
  var SRC = {
    google_review: { ch: 'google', label: 'Reseña de Google', short: 'Google', ic: 'map-pin' },
    facebook_comment: { ch: 'facebook', label: 'Comentario en Facebook', short: 'Facebook', ic: 'message-square-text' }
  };

  /* Llegadas de ejemplo (datos ficticios). */
  var FIX = {
    g_thanks: { source: 'google_review', author: 'María G.', rating: 5, text: 'Las conchas están deliciosas y siempre calientitas. ¡Gracias!', intent: 'thanks', sentiment: 'Positivo', confidence: 0.95 },
    g_thanks2: { source: 'google_review', author: 'Héctor V.', rating: 5, text: 'El mejor bolillo de la colonia. Muy amables.', intent: 'thanks', sentiment: 'Positivo', confidence: 0.93 },
    g_complaint: { source: 'google_review', author: 'Ricardo M.', rating: 2, text: 'Mi pedido llegó mal y nadie me atendió.', intent: 'complaint', sentiment: 'Negativo', confidence: 0.9 },
    g_accuse: { source: 'google_review', author: 'Usuario de Google', rating: 1, text: 'Pésimo lugar, son unos rateros.', intent: 'accusation', sentiment: 'Negativo', confidence: 0.86 },
    g_mixed: { source: 'google_review', author: 'Paty S.', rating: 4, text: 'Muy buen pan, aunque a veces hay mucha fila.', intent: 'mixed', sentiment: 'Mixto', confidence: 0.7 },
    f_thanks: { source: 'facebook_comment', author: 'Jorge L.', text: '¡Qué rico su pan!', intent: 'thanks', sentiment: 'Positivo', confidence: 0.97 },
    f_question: { source: 'facebook_comment', author: 'Ana P.', text: '¿A qué hora abren el domingo?', intent: 'question', field: 'hours.sun', sentiment: 'Neutral', confidence: 0.92 },
    f_discount: { source: 'facebook_comment', author: 'Luis R.', text: '¿Me hacen descuento si compro 3 docenas?', intent: 'discount', sentiment: 'Neutral', confidence: 0.9 }
  };
  var INTENT = {
    thanks: { label: 'Agradecimiento', cat: 'thanks' },
    question: { label: 'Pregunta sobre tu negocio', cat: 'info' },
    complaint: { label: 'Queja', cat: 'complaint', why: 'Es una queja sobre un pedido. MainSpot no responde quejas sin ti.' },
    accusation: { label: 'Acusación', cat: 'sensitive', why: 'Contiene una acusación grave. Necesita tu criterio. MainSpot nunca oculta ni borra opiniones.' },
    discount: { label: 'Pide un descuento', cat: 'sensitive', why: 'Pide un descuento. MainSpot no ofrece descuentos, precios ni promesas por ti.' },
    mixed: { label: 'Comentario mixto', cat: 'complaint', why: 'Mezcla un elogio con una molestia. Prefiero que lo revises.' }
  };
  var CAT = {
    thanks: 'Agradecimientos y comentarios positivos',
    info: 'Preguntas sobre datos de tu negocio',
    complaint: 'Quejas y molestias',
    sensitive: 'Descuentos, acusaciones y temas delicados'
  };

  var AG = (MS.agent = { SRC: SRC, FIX: FIX, INTENT: INTENT, CAT: CAT });

  AG.STATUS = {
    received: { label: 'Recibido', tone: 'neutral' },
    classifying: { label: 'Analizando', tone: 'ocre' },
    needs_human: { label: 'Necesita tu decisión', tone: 'rosa' },
    awaiting_approval: { label: 'Espera aprobación', tone: 'rosa' },
    responding: { label: 'Respondiendo', tone: 'ocre' },
    retry_pending: { label: 'Reintentaremos', tone: 'ocre' },
    failed: { label: 'No se pudo responder', tone: 'alerta' },
    responded: { label: 'Respondido', tone: 'nopal' },
    rejected: { label: 'Sin respuesta', tone: 'neutral' },
    handled_outside: { label: 'Atendido fuera de MainSpot', tone: 'neutral' }
  };
  AG.statusLabel = function (c) {
    if (c.status === 'responded') return c.response && c.response.auto ? 'Atendido por MainSpot' : 'Respondido por ' + c.response.by.split(' ')[0];
    if (c.status === 'needs_human' && !MS.can('approve')) return 'Necesita decisión';
    return AG.STATUS[c.status].label;
  };

  AG.get = function (id) { return S().cases.filter(function (c) { return c.id === id; })[0] || null; };
  AG.needs = function () { return S().cases.filter(function (c) { return c.status === 'needs_human' || c.status === 'awaiting_approval' || c.status === 'failed'; }); };
  AG.auto = function () { return S().cases.filter(function (c) { return c.status === 'responded' && c.response && c.response.auto; }); };
  AG.errors = function () { return S().cases.filter(function (c) { return c.status === 'failed' || c.status === 'retry_pending'; }); };
  AG.open = function (c) { return ['needs_human', 'awaiting_approval', 'failed', 'retry_pending', 'responding', 'classifying', 'received'].indexOf(c.status) >= 0; };

  function ev(c, text, who) { c.events.push({ at: Date.now(), text: text, who: who || 'MainSpot' }); }
  function first(name) { return String(name).split(' ')[0]; }
  function chPhone(ch) { var e = MS.ph.effective(ch); return e ? e.intl : null; }
  function base() { return MS.siteBase(); }

  /* ---------- Llegada ---------- */
  AG.nextKey = function (src) { S().agent.fixture += 1; return src + '-' + (1000 + S().agent.fixture); };

  AG.ingest = function (items, opts) {
    opts = opts || {};
    var human = [];
    items.forEach(function (it, i) {
      var key = it.ext || AG.nextKey(it.source);
      var seen = S().agent.seen;
      if (!S().prov[SRC[it.source].ch].connected) return;
      if (seen[key]) {
        S().agent.dupes += 1;
        var orig = S().cases.filter(function (c) { return c.ext === key; })[0];
        if (orig) ev(orig, 'Llegó otra vez (duplicado). Lo ignoramos: no se responde dos veces.');
        return;
      }
      seen[key] = true;
      if (!S().agent.watching) { S().agent.queue.push(Object.assign({ ext: key }, it)); return; }
      var c = {
        id: MS.id('c'), ext: key, source: it.source, author: it.author, rating: it.rating || null, text: it.text,
        post: it.post || null, intent: it.intent, field: it.field || null, sentiment: it.sentiment, confidence: it.confidence,
        status: 'received', at: Date.now() + i, reason: '', drafts: [], response: null, attempts: 0, events: [], policyVersion: null, tgMsg: null
      };
      ev(c, it.source === 'google_review' ? 'Llegó una reseña de ' + it.rating + ' estrellas' : 'Llegó un comentario en tu publicación');
      S().cases.unshift(c);
      human.push(c);
    });
    S().agent.lastCheck = Date.now();
    MS.emit();
    // Clasificación (simulada) y decisión, con un pequeño retraso visible.
    MS.later('classify-' + Date.now(), 700, function () {
      human.forEach(function (c) { c.status = 'classifying'; });
      MS.emit();
      MS.later('decide-' + Date.now(), 900, function () {
        var toHuman = [];
        human.forEach(function (c) { if (AG.decide(c) === 'human') toHuman.push(c); });
        AG.alertTelegram(toHuman);
        MS.emit();
      });
    });
  };

  AG.arrive = function (fixKey) {
    var f = FIX[fixKey];
    var it = Object.assign({}, f);
    if (it.source === 'facebook_comment') {
      var p = S().posts.filter(function (x) { return x.status === 'published'; })[0];
      it.post = p ? p.id : null;
    }
    AG.ingest([it]);
  };

  /* ---------- Decisión según política del negocio ---------- */
  AG.decide = function (c) {
    var pol = S().agent.policy, src = SRC[c.source], intent = INTENT[c.intent] || { label: 'Otro', cat: 'complaint', why: 'No está claro qué necesita.' };
    c.category = intent.cat;
    ev(c, 'Lo clasificamos: ' + intent.label + '. Tono ' + c.sentiment.toLowerCase() + ', confianza ' + Math.round(c.confidence * 100) + '%.');
    var why = null;
    if (intent.cat === 'complaint' || intent.cat === 'sensitive') why = intent.why;
    else if (c.confidence < 0.8) why = 'No estoy seguro de entenderlo bien. Prefiero que lo revises.';
    else if (!pol.enabled || pol[intent.cat] !== 'auto' || !pol.scope[src.ch]) why = 'Tu regla para ' + CAT[intent.cat].toLowerCase() + ' es revisar primero.';
    else if (!S().prov[src.ch].perm) why = 'Falta permiso de ' + src.short + ' para responder. Reconéctalo.';
    else if (intent.cat === 'info' && !AG.verifiedAnswer(c)) why = 'No tengo un dato verificado para contestar.';
    if (why) {
      c.reason = why;
      c.drafts = AG.drafts(c);
      c.status = 'needs_human';
      ev(c, 'Necesita tu decisión: ' + why);
      ev(c, 'Preparamos ' + c.drafts.length + ' respuestas sugeridas.');
      MS.notify('case', 'Un cliente necesita tu atención', src.label + ' de ' + c.author, '#/caso/' + c.id);
      return 'human';
    }
    c.policyVersion = S().agent.version;
    c.reason = 'Permitido por tu regla «' + CAT[intent.cat] + '» (versión ' + c.policyVersion + ').';
    ev(c, 'Se puede responder solo: ' + c.reason);
    AG.respond(c, AG.autoText(c), { auto: true, by: 'MainSpot' });
    return 'auto';
  };

  AG.verifiedAnswer = function (c) {
    if (c.field && c.field.indexOf('hours.') === 0) { var v = base().hours[c.field.slice(6)]; return v ? v : null; }
    return null;
  };

  AG.autoText = function (c) {
    var n = first(c.author);
    if (c.intent === 'question') {
      var h = AG.verifiedAnswer(c);
      return '¡Hola, ' + n + '! ' + (h === 'Cerrado' ? 'El domingo no abrimos.' : 'El domingo abrimos de ' + h + '.') + ' Te esperamos en ' + MS.DATA.business + '.';
    }
    return c.source === 'google_review'
      ? '¡Muchas gracias, ' + n + '! Nos da mucho gusto que te guste nuestro pan. Te esperamos pronto en ' + MS.DATA.business + '.'
      : '¡Gracias, ' + n + '! Qué gusto leerte. Te esperamos pronto.';
  };

  /* Hasta 3 propuestas, sin descuentos, compensaciones ni hechos no verificados. */
  AG.drafts = function (c) {
    var n = first(c.author), ph = chPhone(SRC[c.source].ch);
    var call = ph ? 'llámanos al ' + ph : 'visítanos en la tienda';
    switch (c.intent) {
      case 'complaint': return [
        { tone: 'Disculpa y contacto', text: n + ', lamentamos mucho que tu pedido llegara mal y que no te atendiéramos. Queremos revisarlo contigo: ' + call + '.' },
        { tone: 'Breve y empática', text: 'Gracias por avisarnos, ' + n + '. Una disculpa por la mala experiencia; vamos a revisar qué pasó con tu pedido.' },
        { tone: 'Pedir detalles', text: 'Sentimos lo ocurrido, ' + n + '. Para revisar tu caso, ' + call + ' y cuéntanos la fecha de tu pedido.' }
      ];
      case 'accusation': return [
        { tone: 'Calmada y abierta', text: 'Lamentamos que tu experiencia no haya sido buena. Nos gustaría saber qué pasó para revisarlo: ' + call + '.' },
        { tone: 'Breve', text: 'Gracias por tu opinión. Tomamos en serio cualquier inconformidad y estamos a tus órdenes.' },
        { tone: 'Invitar a platicar', text: 'Sentimos que te sientas así. Si nos cuentas qué ocurrió, lo revisaremos con atención.' }
      ];
      case 'discount': return [
        { tone: 'Invitar a llamar', text: '¡Gracias por tu interés, ' + n + '! Para pedidos grandes, ' + call + ' y te damos los detalles.' },
        { tone: 'Cálida', text: '¡Qué gusto que quieras llevar 3 docenas, ' + n + '! Platiquemos tu pedido: ' + call + '.' },
        { tone: 'En persona', text: 'Hola, ' + n + '. Los pedidos especiales los platicamos en la tienda o por teléfono. ¡Te esperamos!' }
      ];
      case 'mixed': return [
        { tone: 'Agradecer y escuchar', text: '¡Gracias por tu visita, ' + n + '! Nos alegra que te guste el pan, y tomamos nota de lo de la fila.' },
        { tone: 'Breve', text: '¡Muchas gracias por tus estrellas, ' + n + '! Te esperamos pronto.' },
        { tone: 'Cercana', text: 'Gracias, ' + n + '. Qué gusto que disfrutes nuestro pan; tu comentario nos ayuda a mejorar.' }
      ];
      case 'question': var h = AG.verifiedAnswer(c); return [
        { tone: 'Directa', text: '¡Hola, ' + n + '! El domingo abrimos de ' + h + '.' },
        { tone: 'Con invitación', text: '¡Hola, ' + n + '! El domingo abrimos de ' + h + '. Te esperamos.' },
        { tone: 'Con contacto', text: 'El domingo abrimos de ' + h + '. Si tienes otra duda, ' + call + '.' }
      ];
      default: return [
        { tone: 'Cálida', text: AG.autoText(c) },
        { tone: 'Breve', text: '¡Gracias, ' + n + '!' },
        { tone: 'Con invitación', text: '¡Gracias por tu comentario, ' + n + '! Te esperamos pronto en ' + MS.DATA.business + '.' }
      ];
    }
  };

  /* ---------- Respuesta (simulada) con idempotencia y reintentos ---------- */
  AG.respond = function (c, text, who) {
    if (c.response) return { ok: false, message: 'Este caso ya tiene respuesta. No respondemos dos veces.' };
    c.pending = { text: text, auto: !!who.auto, by: who.by, via: who.via || 'panel', key: c.id + ':r1' };
    c.status = 'responding';
    MS.emit();
    MS.later('resp-' + c.id, 1300, function () { AG.attempt(c.id); });
    return { ok: true };
  };

  AG.attempt = function (id) {
    var c = AG.get(id);
    if (!c || c.response || !c.pending) return;
    var src = SRC[c.source];
    c.attempts += 1;
    if (S().prov[src.ch].down) {
      if (c.attempts >= 3) {
        c.status = 'failed';
        c.reason = src.short + ' no respondió después de ' + c.attempts + ' intentos. No se publicó nada.';
        ev(c, 'Intento ' + c.attempts + ' falló: ' + src.short + ' no respondió. Lo dejamos para ti.');
        MS.notify('case_failed', 'No pudimos responder a un cliente', src.label + ' de ' + c.author, '#/caso/' + c.id);
        if (S().telegram.status === 'linked') MS.botSay('tg', 'No pudimos publicar la respuesta a ' + c.author + ' en ' + src.short + '. No se publicó nada. Revísalo en tu panel.', [{ label: 'Ver en el panel', act: 'open', arg: '#/caso/' + c.id, style: 'secondary' }]);
      } else {
        c.status = 'retry_pending';
        c.retryAt = Date.now() + 8000 * c.attempts;
        ev(c, 'Intento ' + c.attempts + ' falló: ' + src.short + ' no respondió. No se publicó nada; lo intentaremos de nuevo.');
        MS.later('resp-' + c.id, c.retryAt - Date.now(), function () { AG.attempt(id); });
      }
      MS.emit();
      return;
    }
    c.response = { text: c.pending.text, auto: c.pending.auto, by: c.pending.by, via: c.pending.via, at: Date.now(), key: c.pending.key, policyVersion: c.pending.auto ? c.policyVersion : null };
    c.pending = null;
    c.status = 'responded';
    ev(c, c.response.auto ? 'MainSpot respondió por ti (simulado). Regla versión ' + c.response.policyVersion + '.' : 'Se publicó la respuesta que eligió ' + c.response.by + ' (simulado).', c.response.auto ? 'MainSpot' : c.response.by);
    MS.emit();
  };

  AG.retryNow = function (id) {
    var c = AG.get(id);
    if (!c || c.response) return;
    if (c.status === 'failed') { c.attempts = 0; }
    if (!c.pending) return;
    c.status = 'responding';
    MS.emit();
    MS.later('resp-' + c.id, 900, function () { AG.attempt(id); });
  };

  /* ---------- Decisión humana (panel o Telegram: una sola resolución) ---------- */
  AG.resolve = function (id, action, text, via) {
    var c = AG.get(id);
    var who = MS.me().name;
    if (!c) return { ok: false, message: 'No encontramos ese caso.' };
    if (c.resolvedBy || c.response || ['responded', 'rejected', 'handled_outside', 'responding', 'retry_pending'].indexOf(c.status) >= 0) {
      return { ok: false, message: 'Este caso ya se resolvió' + (c.resolvedVia ? ' desde ' + (c.resolvedVia === 'tg' ? 'Telegram' : 'el panel') : '') + '. No se responde dos veces.' };
    }
    if (MS.expired()) return { ok: false, message: 'Tu prueba terminó. Para responder, contacta a MainSpot.' };
    if (!MS.can('request')) return { ok: false, message: 'Tu perfil puede ver los casos, pero no responderlos.' };
    if (action === 'reply' && !MS.can('approve')) {
      c.status = 'awaiting_approval';
      c.proposal = text;
      ev(c, '[Propusiste|Propuso] una respuesta y la envió a aprobación', who);
      MS.notify('case', 'Una respuesta espera tu aprobación', SRC[c.source].label + ' de ' + c.author, '#/caso/' + c.id);
      MS.emit();
      return { ok: true, message: 'Enviamos tu propuesta a ' + MS.DATA.people.administration.name + ' para que la apruebe.' };
    }
    if (action === 'reply') {
      if (!S().prov[SRC[c.source].ch].perm) return { ok: false, message: 'Falta permiso de ' + SRC[c.source].short + ' para responder. Reconéctalo para publicar la respuesta.' };
      if (!String(text || '').trim()) return { ok: false, message: 'Escribe la respuesta antes de publicarla.' };
      c.resolvedBy = who; c.resolvedVia = via;
      ev(c, '[Aprobaste|Aprobó] la respuesta ' + (via === 'tg' ? 'por Telegram' : 'desde el panel'), who);
      AG.respond(c, text.trim(), { auto: false, by: who, via: via });
    } else if (action === 'reject') {
      c.status = 'rejected'; c.resolvedBy = who; c.resolvedVia = via;
      ev(c, '[Decidiste|Decidió] no responder. La opinión sigue publicada tal cual.', who);
    } else if (action === 'outside') {
      c.status = 'handled_outside'; c.resolvedBy = who; c.resolvedVia = via;
      ev(c, '[Marcaste|Marcó] que se atendió fuera de MainSpot', who);
    }
    MS.notices_markRoute('#/caso/' + c.id);
    MS.emit();
    return { ok: true };
  };

  /* ---------- Telegram: mismo caso, sin avisos duplicados ---------- */
  AG.alertTelegram = function (list) {
    if (!list.length || S().telegram.status !== 'linked') return;
    if (list.length > 1) {
      MS.botSay('tg', 'Llegaron ' + list.length + ' mensajes de clientes que necesitan tu decisión:\n' + list.map(function (c) { return '• ' + SRC[c.source].short + ': ' + c.author + (c.rating ? ' (' + c.rating + '★)' : ''); }).join('\n'), [{ label: 'Ver en el panel', act: 'open', arg: '#/atencion', style: 'secondary' }]);
      list.forEach(function (c) { c.tgMsg = 'summary'; ev(c, 'Te avisamos por Telegram (resumen de ' + list.length + ').'); });
      return;
    }
    var c = list[0];
    var m = MS.botSay('tg', (c.source === 'google_review' ? 'Nueva reseña de ' + c.rating + '★ en Google' : 'Nuevo comentario en Facebook') + ' de ' + c.author + ':\n«' + c.text + '»\n\nPor qué te aviso: ' + c.reason + '\n\nTe propongo:\n' + c.drafts.map(function (d, i) { return (i + 1) + '. ' + d.text; }).join('\n'), [
      { label: 'Usar opción 1', act: 'case-pick', arg: c.id + '|0', style: 'primary' },
      { label: 'Usar opción 2', act: 'case-pick', arg: c.id + '|1', style: 'secondary' },
      { label: 'Usar opción 3', act: 'case-pick', arg: c.id + '|2', style: 'secondary' },
      { label: 'Ver en el panel', act: 'open', arg: '#/caso/' + c.id, style: 'secondary' },
      { label: 'No responder', act: 'case-reject', arg: c.id, style: 'secondary' }
    ], { caseId: c.id });
    c.tgMsg = m.id;
    ev(c, 'Te avisamos por Telegram con las 3 propuestas.');
  };

  /* Acciones de los botones del chat simulado. */
  AG.tgAct = function (a) {
    var parts = String(a.arg).split('|'), c = AG.get(parts[0]);
    if (!c) return;
    if (c.resolvedBy || !AG.open(c) || c.status !== 'needs_human') {
      MS.botSay('tg', 'Este caso ya se resolvió' + (c.resolvedVia === 'panel' ? ' desde el panel' : '') + '. No se responde dos veces.');
      MS.emit();
      return;
    }
    if (a.act === 'case-pick') {
      var d = c.drafts[+parts[1]];
      MS.botSay('tg', '¿Publico esta respuesta en ' + SRC[c.source].short + '?\n«' + d.text + '»', [
        { label: 'Sí, publicar', act: 'case-yes', arg: c.id + '|' + parts[1], style: 'primary' },
        { label: 'Todavía no', act: 'case-no', arg: c.id, style: 'secondary' }
      ]);
    } else if (a.act === 'case-yes') {
      var r = AG.resolve(c.id, 'reply', c.drafts[+parts[1]].text, 'tg');
      MS.botSay('tg', r.ok ? (r.message || 'Listo. Estamos publicando tu respuesta (simulado). En el panel verás el mismo caso resuelto.') : r.message);
    } else if (a.act === 'case-no') {
      MS.botSay('tg', 'Está bien. El caso sigue esperando tu decisión en tu panel.');
    } else if (a.act === 'case-reject') {
      var r2 = AG.resolve(c.id, 'reject', '', 'tg');
      MS.botSay('tg', r2.ok ? 'Listo: no responderemos. La opinión sigue publicada tal cual.' : r2.message);
    }
    MS.emit();
  };

  /* ---------- Política «Qué puede responder MainSpot por mí» ---------- */
  AG.setPolicy = function (next, who) {
    var a = S().agent;
    a.policy = next;
    a.version += 1;
    var parts = [];
    if (next.enabled && next.thanks === 'auto') parts.push('agradecimientos');
    if (next.enabled && next.info === 'auto') parts.push('preguntas con datos verificados');
    var scope = ['google', 'facebook'].filter(function (k) { return next.scope[k]; }).map(function (k) { return k === 'google' ? 'Google' : 'Facebook'; }).join(' y ');
    var summary = parts.length ? 'MainSpot responde solo: ' + parts.join(' y ') + ' en ' + (scope || 'ningún canal') + '. Todo lo demás se revisa.' : 'Todas las respuestas públicas se revisan antes de publicarse.';
    a.versions.unshift({ v: a.version, at: Date.now(), by: who, summary: summary });
  };

  /* ---------- Vigilancia (simulada) ---------- */
  AG.setWatching = function (on) {
    var a = S().agent;
    a.watching = on;
    if (on && a.queue.length) {
      var q = a.queue.slice(); a.queue = [];
      q.forEach(function (it) { delete S().agent.seen[it.ext]; });
      AG.ingest(q);
    }
    MS.emit();
  };

  /* Al conectar Google o Facebook, llega la actividad reciente (ejemplo). */
  AG.onConnect = function (ch) {
    MS.later('seed-' + ch, 1800, function () {
      if (ch === 'google') AG.ingest([Object.assign({}, FIX.g_thanks), Object.assign({}, FIX.g_complaint)]);
      else {
        var p = S().posts.filter(function (x) { return x.status === 'published'; })[0];
        AG.ingest([Object.assign({ post: p && p.id }, FIX.f_thanks), Object.assign({ post: p && p.id }, FIX.f_question)]);
      }
    });
  };
})();
