/* =====================================================================
   MainSpot · Prototipo · Motor simulado
   - Interpretación de mensajes (simulada con reglas, sin IA real).
   - Ciclo de solicitud: propuesta → confirmación → vista previa → aprobación humana → publicación.
   - Publicación simulada con estados DEC-0043 (REGISTERED…ACTIVE, FAILED, RETRY_PENDING).
   - Vinculación de Telegram simulada (DEC-0041). Sin llamadas de red.
   El asistente PROPONE; nunca aprueba ni publica (RULE-004).
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var S = function () { return MS.S; };
  MS.mem.typing = { panel: false, tg: false };

  /* ---------- Utilidades de texto ---------- */
  function norm(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[¿¡]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function cap(t) { t = String(t).trim(); return t.charAt(0).toUpperCase() + t.slice(1); }
  function fmtHM(h, m) { return h + ':' + (m < 10 ? '0' : '') + m; }

  function dayOf(n) {
    if (/(lunes a viernes|entre semana|de lunes|semana)/.test(n)) return 'week';
    if (/sabado/.test(n)) return 'sat';
    if (/domingo/.test(n)) return 'sun';
    return null;
  }
  function closedOf(n) { return /(cerrado|no abrimos|no abre|no vamos a abrir|descansamos)/.test(n); }
  function timesOf(n) {
    if ((n.replace(/\D/g, '')).length >= 8 && !/:/.test(n)) return null; // parece teléfono
    var re = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|hrs|h\b)?/g;
    var out = [], m;
    while ((m = re.exec(n)) && out.length < 2) {
      var h = parseInt(m[1], 10), mm = m[2] ? parseInt(m[2], 10) : 0;
      if (h > 24 || mm > 59) continue;
      out.push({ h: h, m: mm, pm: m[3] && /p/.test(m[3]) });
    }
    if (out.length < 2) return null;
    var a = out[0], b = out[1];
    if (a.pm && a.h < 12) a.h += 12;
    if (b.pm && b.h < 12) b.h += 12;
    if (/(tarde|noche)/.test(n) && b.h < 12) b.h += 12;
    if (b.h <= a.h && b.h < 12) b.h += 12;
    return fmtHM(a.h, a.m) + ' a ' + fmtHM(b.h, b.m);
  }
  function fmtPhone(d) {
    d = d.slice(-10);
    if (d.length === 10) return d.slice(0, 2) + ' ' + d.slice(2, 6) + ' ' + d.slice(6);
    return d;
  }

  var DAY_TXT = { week: 'de lunes a viernes', sat: 'del sábado', sun: 'del domingo' };
  var DAY_FIELD = { week: 'hours.week', sat: 'hours.sat', sun: 'hours.sun' };

  /* ---------- Interpretación simulada ---------- */
  MS.parse = function (text, channel) {
    var n = norm(text);
    var base = MS.siteBase();
    var pend = S().pending[channel] || null;
    var isQuestion = /\?\s*$/.test(text.trim()) || /^(que|cual|cuales|a que hora|como|cuando|tengo|dime|cual es)\b/.test(n);
    var changeVerb = /(cambia|cambiar|pon|ponle|poner|agrega|agregar|anade|incluye|quita|quitar|elimina|borra|actualiza|ahora|abrimos|cerramos|ya no|tambien vendemos|ya vendemos)/.test(n);

    if (!n) return { type: 'empty' };

    // Precios: el canon prohíbe inventarlos (RULE-005) y la página aún no los muestra.
    if (/(precio|cuesta|cuestan|\$|pesos)/.test(n)) {
      return { type: 'info', text: 'Tu página todavía no muestra precios, así que no puedo agregarlos. Si es importante para tu negocio, coméntalo con el equipo de MainSpot.' };
    }
    if (/(instagram|facebook|whatsapp|google|tiktok|redes)/.test(n)) {
      return { type: 'info', text: 'Por ahora te ayudo con tu página web: horario, teléfono, dirección y lo que vendes.' };
    }

    // Preguntas simples: se responden sin aprobación (FLOW-003).
    if (isQuestion && !changeVerb) {
      if (/(horario|hora|abren|abrimos|cierran|cerramos)/.test(n)) {
        var d = dayOf(n);
        if (d) return { type: 'answer', text: 'Tu página dice que el horario ' + DAY_TXT[d] + ' es: ' + base.hours[d] + '.' };
        return { type: 'answer', text: 'Tu horario en la página es:\nLunes a viernes: ' + base.hours.week + '\nSábado: ' + base.hours.sat + '\nDomingo: ' + base.hours.sun };
      }
      if (/(telefono|numero|celular)/.test(n)) return { type: 'answer', text: 'El teléfono que aparece en tu página es ' + base.phone + '.' };
      if (/(direccion|donde)/.test(n)) return { type: 'answer', text: 'Tu página muestra esta dirección: ' + base.address + '.' };
      if (/(vend|producto|ofrec)/.test(n)) return { type: 'answer', text: 'En tu página aparece que vendes: ' + base.services.join(', ') + '.' };
      return { type: 'answer', text: 'Tu página muestra tu horario, teléfono, dirección y lo que vendes. ¿Quieres cambiar algo de eso?' };
    }

    // Horario
    var day = dayOf(n), times = timesOf(n), closed = closedOf(n);
    var hoursTopic = /(horario|hora|abrimos|abre|cerramos|cierra|abrir)/.test(n) || (pend && pend.topic === 'hours');
    if (hoursTopic || (day && (times || closed))) {
      if (pend && pend.topic === 'hours') { day = day || pend.day; times = times || pend.times; closed = closed || pend.closed; }
      if (day && (times || closed)) {
        var after = closed ? 'Cerrado' : times;
        var field = DAY_FIELD[day];
        var before = MS.fieldValue(base, field);
        if (before === after) return { type: 'info', text: 'Tu página ya dice que el horario ' + DAY_TXT[day] + ' es ' + after + '. No hay nada que cambiar.' };
        return {
          type: 'change', title: MS.FIELD_LABEL[field],
          changes: [{ field: field, label: MS.FIELD_LABEL[field], before: before, after: after }],
          summary: closed ? 'Tu página dirá que el ' + (day === 'week' ? 'horario de lunes a viernes' : (day === 'sat' ? 'sábado' : 'domingo')) + ' está cerrado.' : 'Cambiaremos tu horario ' + DAY_TXT[day] + ' a ' + after + '.'
        };
      }
      if ((times || closed) && !day) {
        return { type: 'clarify', pending: { topic: 'hours', times: times, closed: closed }, text: '¿Para qué día es ese horario?', chips: ['Lunes a viernes', 'Sábado', 'Domingo'] };
      }
      if (day && !times) {
        return { type: 'clarify', pending: { topic: 'hours', day: day }, text: '¿A qué hora abres y a qué hora cierras ' + (day === 'week' ? 'entre semana' : (day === 'sat' ? 'el sábado' : 'el domingo')) + '? Por ejemplo: «de 8 a 2».', chips: ['De 8 a 2', 'De 9 a 6 de la tarde', 'Ese día no abrimos'] };
      }
      return { type: 'clarify', pending: { topic: 'hours' }, text: 'Claro. ¿Qué día cambia y en qué horario abres y cierras? Por ejemplo: «El sábado abrimos de 8 a 2».', chips: ['El sábado abrimos de 8 a 2', 'El domingo no abrimos', 'Entre semana de 7 a 9 de la noche'] };
    }

    // Teléfono
    var digits = n.replace(/\D/g, '');
    if (/(telefono|tel\b|numero|celular)/.test(n) || (pend && pend.topic === 'phone')) {
      if (digits.length >= 8) {
        var ph = fmtPhone(digits);
        if (ph === base.phone) return { type: 'info', text: 'Tu página ya tiene ese teléfono: ' + ph + '.' };
        return { type: 'change', title: 'Teléfono', changes: [{ field: 'phone', label: 'Teléfono', before: base.phone, after: ph }], summary: 'Cambiaremos el teléfono de tu página a ' + ph + '.' };
      }
      return { type: 'clarify', pending: { topic: 'phone' }, text: '¿Cuál es el nuevo teléfono? Escríbelo con los 10 dígitos.', chips: [] };
    }

    // Dirección
    if (/(direccion|domicilio|nos mudamos|nos cambiamos|ahora estamos en)/.test(n) || (pend && pend.topic === 'address')) {
      var raw = String(text);
      var mAddr = raw.match(/(?:direcci[oó]n|domicilio)\s*(?:es|a|:|por)?\s*(.{8,})$/i) || raw.match(/(?:nos mudamos|nos cambiamos|ahora estamos)\s*(?:a|en)\s+(.{8,})$/i);
      var addr = mAddr ? mAddr[1].replace(/[.]+$/, '').trim() : (pend && pend.topic === 'address' && raw.trim().length > 8 ? raw.trim() : '');
      if (addr) return { type: 'change', title: 'Dirección', changes: [{ field: 'address', label: 'Dirección', before: base.address, after: cap(addr) }], summary: 'Cambiaremos tu dirección a: ' + cap(addr) + '.' };
      return { type: 'clarify', pending: { topic: 'address' }, text: '¿Cuál es la nueva dirección completa? Incluye calle, número y colonia.', chips: [] };
    }

    // Quitar algo de lo que vende
    if (/(quita|quitar|elimina|borra|ya no vendemos|ya no hacemos|ya no tenemos)/.test(n)) {
      var found = base.services.filter(function (s) { return n.indexOf(norm(s)) >= 0 || n.indexOf(norm(s).split(' ')[0]) >= 0 && norm(s).split(' ')[0].length > 4; })[0];
      if (found) return { type: 'change', title: 'Quitar ' + found, changes: [{ field: 'services.remove', label: 'Lo que vendes', before: found, after: '(se quita)' }], summary: 'Quitaremos «' + found + '» de lo que vendes.' };
      return { type: 'clarify', pending: { topic: 'remove' }, text: '¿Qué quieres quitar de tu página?', chips: base.services.map(function (s) { return 'Quita ' + s; }) };
    }

    // Agregar algo que vende
    if (/(agrega|agregar|anade|incluye|ponle|tambien vendemos|ya vendemos|ahora vendemos|ahora tenemos|vendemos)/.test(n)) {
      var item = '';
      if (/pan de muerto/.test(n)) item = 'Pan de muerto (temporada)';
      else {
        var mi = String(text).match(/(?:agrega|agregar|añade|anade|incluye|ponle|vendemos|tenemos)\s+(?:que\s+)?(?:también\s+|tambien\s+)?(.+)$/i);
        if (mi) item = mi[1].replace(/\s*(a lo que vendemos|a la p[aá]gina|a mi p[aá]gina|en la p[aá]gina|por favor|porfa)\.?$/i, '').replace(/[.!]+$/, '').trim();
      }
      if (item && item.length > 2) {
        item = cap(item);
        if (base.services.map(norm).indexOf(norm(item)) >= 0) return { type: 'info', text: '«' + item + '» ya aparece en tu página.' };
        return { type: 'change', title: 'Agregar ' + item, changes: [{ field: 'services.add', label: 'Lo que vendes', before: '', after: item }], summary: 'Agregaremos «' + item + '» a lo que vendes.' };
      }
      return { type: 'clarify', pending: { topic: 'add' }, text: '¿Qué quieres agregar a lo que vendes?', chips: ['Agrega pan de muerto'] };
    }

    if (pend && pend.topic === 'add' && n.length > 2) {
      var it2 = cap(String(text).replace(/[.!]+$/, ''));
      return { type: 'change', title: 'Agregar ' + it2, changes: [{ field: 'services.add', label: 'Lo que vendes', before: '', after: it2 }], summary: 'Agregaremos «' + it2 + '» a lo que vendes.' };
    }

    return { type: 'clarify', pending: null, text: 'No me quedó claro qué quieres cambiar. ¿Es sobre tu horario, tu teléfono, tu dirección o lo que vendes?', chips: ['Cambiar mi horario', 'Cambiar mi teléfono', 'Agregar algo que vendo'] };
  };

  /* ---------- Mensajes ---------- */
  function push(channel, msg) {
    msg.id = MS.id('m');
    msg.at = Date.now();
    S().convo[channel].push(msg);
    return msg;
  }
  MS.botSay = function (channel, text, actions, extra) {
    var m = { from: 'bot', text: text, actions: actions || [] };
    if (extra) Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
    return push(channel, m);
  };
  MS.systemSay = function (channel, text) { return push(channel, { from: 'system', text: text }); };

  function botLater(channel, fn, ms) {
    MS.mem.typing[channel] = true;
    MS.emit();
    MS.later('typing-' + channel, ms || 900, function () {
      MS.mem.typing[channel] = false;
      fn();
      MS.emit();
    });
  }

  /* El usuario escribe en el panel ('panel') o en Telegram ('tg'). */
  MS.send = function (channel, text) {
    text = String(text || '').trim();
    if (!text) return;
    push(channel, { from: 'me', text: text });
    if (channel === 'tg' && S().telegram.status !== 'linked') {
      botLater('tg', function () { MS.botSay('tg', 'Hola. Para usar MainSpot aquí, abre tu panel y toca «Conectar Telegram».'); });
      return;
    }
    botLater(channel, function () { respond(channel, text); });
  };

  function respond(channel, text) {
    if (!MS.can('request')) {
      MS.botSay(channel, 'Tu perfil puede ver la información del negocio, pero no pedir cambios. Pídele ayuda a quien administra tu negocio.');
      return;
    }
    var p = MS.parse(text, channel);
    if (p.type === 'answer' || p.type === 'info') {
      S().pending[channel] = null;
      MS.botSay(channel, p.text);
      return;
    }
    if (p.type === 'clarify') {
      S().pending[channel] = p.pending;
      MS.botSay(channel, p.text, (p.chips || []).map(function (c) { return { label: c, act: 'text', arg: c, style: 'chip' }; }));
      return;
    }
    if (p.type === 'change') {
      S().pending[channel] = null;
      if (MS.expired()) {
        MS.botSay(channel, 'Tu prueba terminó. Puedes ver tu información, pero para pedir cambios contacta a MainSpot.');
        return;
      }
      // ¿Es un ajuste a una propuesta existente? (botón «Pedir otro cambio»)
      var adj = channel === 'panel' && S().adjusting ? MS.req(S().adjusting) : null;
      var r;
      if (adj && (adj.status === 'preview_ready' || adj.status === 'expired' || adj.status === 'awaiting_confirm')) {
        r = adj;
        p.changes.forEach(function (c) {
          r.changes = r.changes.filter(function (x) { return x.field !== c.field || c.field.indexOf('services') === 0; });
          r.changes.push(c);
        });
        r.revision = (r.revision || 1) + 1;
        r.status = 'awaiting_confirm';
        r.preview = null;
        MS.addEvent(r, '[Pediste|Pidió] un ajuste: «' + text + '»', MS.me().name);
        S().adjusting = null;
        MS.botSay(channel, 'Ajustaré la propuesta «' + r.title + '». ' + p.summary + '\n¿Preparo la nueva vista previa?', [
          { label: 'Sí, prepara la vista previa', act: 'confirm', arg: r.id, style: 'primary' },
          { label: 'No, corregir', act: 'correct', arg: r.id, style: 'secondary' }
        ], { reqId: r.id, changes: p.changes });
        return;
      }
      r = {
        id: MS.id('r'), kind: 'change', title: p.title, channel: channel === 'tg' ? 'telegram' : 'panel', text: text,
        by: MS.me().name, changes: p.changes, status: 'awaiting_confirm', createdAt: Date.now(), revision: 1, events: []
      };
      MS.addEvent(r, '[Pediste|Pidió] el cambio ' + (channel === 'tg' ? 'por Telegram' : 'desde el panel') + ': «' + text + '»', MS.me().name);
      MS.addEvent(r, 'Explicamos el cambio y pedimos confirmación', 'MainSpot');
      S().requests.unshift(r);
      MS.botSay(channel, p.summary + '\n¿Preparo la vista previa?', [
        { label: channel === 'tg' ? 'Sí, prepárala' : 'Sí, prepara la vista previa', act: 'confirm', arg: r.id, style: 'primary' },
        { label: 'No, corregir', act: 'correct', arg: r.id, style: 'secondary' }
      ], { reqId: r.id, changes: p.changes });
      MS.tourDone(channel === 'tg' ? 'tgRequest' : 'panelRequest');
    }
  }

  /* Acciones dentro de la conversación (botones de un mensaje). Cada botón se usa una sola vez. */
  MS.convoAct = function (channel, msgId, idx) {
    var m = S().convo[channel].filter(function (x) { return x.id === msgId; })[0];
    if (!m || !m.actions || !m.actions[idx]) return;
    var a = m.actions[idx];
    if (a.act === 'text') { MS.send(channel, a.arg); return; }
    if (a.act === 'open') { location.hash = a.arg; return; }
    if (m.used) {
      if (a.act === 'approve' || a.act === 'approve-yes') { MS.botSay(channel, 'Ya habías aprobado este cambio. No se publicará dos veces.'); MS.emit(); }
      return;
    }
    m.used = idx;
    if (a.act === 'confirm') { MS.confirmRequest(a.arg, channel); return; }
    if (a.act === 'correct') {
      var r = MS.req(a.arg);
      if (r && r.status === 'awaiting_confirm') { r.status = 'cancelled'; MS.addEvent(r, '[Pediste|Pidió] corregir la propuesta', MS.me().name); }
      MS.botSay(channel, 'De acuerdo, no preparo nada. Dime cómo debe quedar.');
      MS.emit();
      return;
    }
    if (a.act === 'approve') {
      // Paso de confirmación explícita en Telegram: el voto final es del humano.
      MS.botSay(channel, '¿Publico este cambio en tu página? Tu página cambiará cuando termine la publicación.', [
        { label: 'Sí, publicar', act: 'approve-yes', arg: a.arg, style: 'primary' },
        { label: 'Todavía no', act: 'approve-no', arg: a.arg, style: 'secondary' }
      ]);
      MS.emit();
      return;
    }
    if (a.act === 'approve-yes') { var res = MS.approve(a.arg, channel); if (!res.ok) { MS.botSay(channel, res.message); MS.emit(); } return; }
    if (a.act === 'approve-no') { MS.botSay(channel, 'Está bien. El cambio sigue esperando tu decisión en tu panel.'); MS.emit(); return; }
    if (a.act === 'reject') { MS.reject(a.arg, channel); return; }
  };

  /* ---------- Ciclo de la solicitud ---------- */
  MS.confirmRequest = function (id, channel) {
    var r = MS.req(id);
    if (!r) return;
    if (!MS.can('confirm')) { MS.botSay(channel, 'Tu perfil no permite esta acción. Pídele ayuda a quien administra tu negocio.'); MS.emit(); return; }
    if (MS.expired()) { MS.botSay(channel, 'Tu prueba terminó. Para hacer cambios, contacta a MainSpot.'); MS.emit(); return; }
    if (r.status !== 'awaiting_confirm') { MS.botSay(channel, 'Ese cambio ya estaba en camino. No lo preparo dos veces.'); MS.emit(); return; }
    r.status = 'preparing';
    MS.addEvent(r, '[Confirmaste|Confirmó] el cambio', MS.me().name);
    MS.botSay(channel, 'Perfecto. Estoy preparando la vista previa…');
    MS.emit();
    MS.later('prep-' + id, 1800, function () { MS.previewReady(id, channel); MS.emit(); });
  };

  MS.previewReady = function (id, channel) {
    var r = MS.req(id);
    if (!r || r.status !== 'preparing') return;
    r.status = 'preview_ready';
    r.preview = { readyAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000, rev: r.revision || 1 };
    MS.addEvent(r, 'Preparamos la vista previa', 'MainSpot');
    var approverName = MS.DATA.people.administration.name;
    if (MS.can('approve')) {
      var acts = [{ label: 'Ver vista previa', act: 'open', arg: '#/vista-previa/' + r.id, style: channel === 'tg' ? 'secondary' : 'primary' }];
      if (channel === 'tg') {
        acts.push({ label: 'Publicar', act: 'approve', arg: r.id, style: 'primary' });
        acts.push({ label: 'Descartar', act: 'reject', arg: r.id, style: 'secondary' });
      }
      MS.botSay(channel, 'Tu vista previa está lista. Nada cambia en tu página hasta que tú lo apruebes.', acts, { reqId: r.id });
    } else {
      MS.botSay(channel, 'La vista previa está lista. Le avisamos a ' + approverName + ' para que la apruebe.', [{ label: 'Ver vista previa', act: 'open', arg: '#/vista-previa/' + r.id, style: 'secondary' }], { reqId: r.id });
    }
    MS.notify('approval', 'Tienes un cambio esperando tu aprobación', r.title, '#/vista-previa/' + r.id);
    if (S().telegram.status === 'linked' && channel !== 'tg') {
      MS.botSay('tg', 'Tienes un cambio esperando tu aprobación: «' + r.title + '».', [{ label: 'Ver vista previa', act: 'open', arg: '#/vista-previa/' + r.id, style: 'secondary' }]);
    }
  };

  MS.adjust = function (id) {
    var r = MS.req(id);
    if (!r) return;
    S().adjusting = id;
    MS.botSay('panel', 'Dime qué quieres ajustar en «' + r.title + '». Tu vista previa actual deja de valer cuando prepare la nueva.');
    MS.emit();
  };

  MS.renewPreview = function (id) {
    var r = MS.req(id);
    if (!r || r.status !== 'expired') return;
    r.status = 'preparing';
    r.revision = (r.revision || 1) + 1;
    MS.addEvent(r, '[Pediste|Pidió] una nueva vista previa', MS.me().name);
    MS.emit();
    MS.later('prep-' + id, 1600, function () { MS.previewReady(id, 'panel'); MS.emit(); });
  };

  MS.expirePreview = function (id) {
    var r = MS.req(id);
    if (!r || r.status !== 'preview_ready') return false;
    r.status = 'expired';
    MS.addEvent(r, 'La vista previa venció sin decisión', 'MainSpot');
    return true;
  };

  /* Aprobación: solo una persona con perfil de Administración. Repetir no duplica. */
  MS.approve = function (id, channel) {
    var r = MS.req(id);
    if (!r) return { ok: false, code: 'missing', message: 'No encontramos ese cambio.' };
    if (r.status === 'approved' || r.status === 'published') return { ok: false, code: 'already', message: 'Ya habías aprobado este cambio. No se publicará dos veces.' };
    if (!MS.can('approve')) return { ok: false, code: 'perm', message: 'Tu perfil no permite aprobar cambios. Pídele a ' + MS.DATA.people.administration.name + ' que lo revise.' };
    if (MS.expired()) return { ok: false, code: 'trial', message: 'Tu prueba terminó. Puedes ver tu información, pero para publicar cambios contacta a MainSpot.' };
    if (r.status === 'expired') return { ok: false, code: 'preview_expired', message: 'Esta vista previa ya venció. Pide una nueva para poder aprobarla.' };
    if (r.status !== 'preview_ready') return { ok: false, code: 'state', message: 'Este cambio todavía no está listo para aprobarse.' };
    var pub = S().site.pub;
    if (pub && pub.state !== 'done') return { ok: false, code: 'busy', message: 'Estamos publicando otro cambio. Apruébalo en cuanto termine.' };
    r.status = 'approved';
    r.approvedBy = MS.me().name;
    r.approvedAt = Date.now();
    r.approvedVia = channel === 'tg' ? 'Telegram' : 'panel';
    MS.addEvent(r, '[Aprobaste|Aprobó] el cambio ' + (channel === 'tg' ? 'por Telegram' : 'desde el panel'), MS.me().name);
    if (channel === 'tg') MS.botSay('tg', 'Listo, aprobaste el cambio. Lo estamos publicando y te aviso aquí cuando esté en tu página.');
    MS.notices_markRoute('#/vista-previa/' + r.id);
    MS.publish.start(r.id);
    MS.tourDone(r.kind === 'first' ? 'firstApproved' : 'changeApproved');
    return { ok: true };
  };

  MS.reject = function (id, channel) {
    var r = MS.req(id);
    if (!r) return;
    if (r.status === 'rejected') return;
    if (r.status !== 'preview_ready' && r.status !== 'expired' && r.status !== 'awaiting_confirm') return;
    r.status = 'rejected';
    MS.addEvent(r, '[Descartaste|Descartó] el cambio', MS.me().name);
    MS.notices_markRoute('#/vista-previa/' + r.id);
    if (channel === 'tg') MS.botSay('tg', 'Descartaste el cambio. Tu página sigue igual.');
    MS.emit();
  };

  MS.notices_markRoute = function (route) {
    S().notices.forEach(function (n) { if (n.route === route) n.read = true; });
  };

  /* Primera página: MainSpot la prepara con los datos del alta; la publica solo tras aprobación. */
  MS.createFirstPage = function () {
    if (S().requests.some(function (r) { return r.kind === 'first'; })) return;
    var r = {
      id: MS.id('r'), kind: 'first', title: 'Tu primera página', channel: 'mainspot', text: '', by: 'MainSpot',
      changes: [], status: 'preparing', createdAt: Date.now(), revision: 1, events: []
    };
    MS.addEvent(r, 'Empezamos a preparar la primera página con los datos del alta', 'MainSpot');
    S().requests.unshift(r);
    MS.later('prep-' + r.id, 2600, function () {
      r.status = 'preview_ready';
      r.preview = { readyAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000, rev: 1 };
      MS.addEvent(r, 'La primera página quedó lista para revisar', 'MainSpot');
      MS.notify('approval', 'Tu primera página está lista para revisar', 'Revísala y apruébala para publicarla.', '#/vista-previa/' + r.id);
      if (S().telegram.status === 'linked') MS.botSay('tg', 'Tu primera página está lista para revisar. Nada se publica hasta que tú la apruebes.', [{ label: 'Ver vista previa', act: 'open', arg: '#/vista-previa/' + r.id, style: 'secondary' }]);
      MS.emit();
    });
  };

  /* Volver a publicar una versión anterior: se trata como un cambio más (vista previa + aprobación). */
  MS.restoreVersion = function (n) {
    var v = S().site.versions.filter(function (x) { return x.n === n; })[0];
    if (!v) return null;
    var r = {
      id: MS.id('r'), kind: 'restore', title: 'Volver a la versión ' + n, channel: 'panel', text: '', by: MS.me().name,
      changes: [{ field: 'page', label: 'Tu página completa', before: 'Versión ' + S().site.versions[0].n + ' (la de ahora)', after: 'Versión ' + n + ' (' + MS.date(v.at) + ')', data: v.data }],
      status: 'preparing', createdAt: Date.now(), revision: 1, events: []
    };
    MS.addEvent(r, '[Pediste|Pidió] volver a la versión ' + n, MS.me().name);
    S().requests.unshift(r);
    MS.later('prep-' + r.id, 1500, function () { MS.previewReady(r.id, 'panel'); MS.emit(); });
    return r;
  };

  /* ---------- Publicación simulada (DEC-0043 §4) ---------- */
  var DUR = { REGISTERED: 1500, PREPARING: 2200, CONFIGURING: 2200, VERIFYING: 2600 };
  MS.PUB_TEXT = {
    REGISTERED: { t: 'Recibimos tu página', d: 'Tu aprobación quedó registrada.' },
    PREPARING: { t: 'Estamos preparando tu página', d: 'Armamos la versión que aprobaste.' },
    CONFIGURING: { t: 'Estamos configurando tu dirección web', d: 'Le damos a tu página su dirección propia.' },
    VERIFYING: { t: 'Comprobando que todo funcione', d: 'Revisamos que tu página abra bien y muestre lo correcto.' },
    ACTIVE: { t: 'Tu página ya está en internet', d: '' },
    FAILED: { t: 'No pudimos publicar tu página', d: 'Ya estamos revisándolo.' },
    RETRY_PENDING: { t: 'Lo intentaremos de nuevo en unos minutos', d: 'No tienes que hacer nada.' }
  };
  MS.publish = {
    steps: function (kind) { return kind === 'first' ? ['REGISTERED', 'PREPARING', 'CONFIGURING', 'VERIFYING', 'ACTIVE'] : ['REGISTERED', 'PREPARING', 'VERIFYING', 'ACTIVE']; },
    start: function (reqId) {
      var r = MS.req(reqId);
      var first = !S().site.published;
      S().site.pub = { reqId: reqId, kind: first ? 'first' : 'update', step: 'REGISTERED', state: 'running', attempts: 1, willFail: !!S().demo.failNextPublish, startedAt: Date.now(), failedStep: null, retryAt: null };
      S().demo.failNextPublish = false;
      MS.addEvent(r, 'Empezamos a publicar', 'MainSpot');
      MS.emit();
      MS.publish.schedule();
    },
    schedule: function () {
      var p = S().site.pub;
      if (!p) return;
      if (p.state === 'running') {
        MS.later('pub', DUR[p.step] || 1500, MS.publish.advance);
      } else if (p.state === 'failed') {
        MS.later('pub', 3000, function () {
          p.state = 'retry';
          p.retryAt = Date.now() + 12000;
          MS.emit();
          MS.publish.schedule();
        });
      } else if (p.state === 'retry') {
        MS.later('pub', Math.max(500, p.retryAt - Date.now()), MS.publish.retryNow);
      }
    },
    advance: function () {
      var p = S().site.pub;
      if (!p || p.state !== 'running') return;
      var steps = MS.publish.steps(p.kind);
      var i = steps.indexOf(p.step);
      if (p.step === 'VERIFYING' && p.willFail) {
        p.state = 'failed';
        p.failedStep = 'VERIFYING';
        var r = MS.req(p.reqId);
        MS.addEvent(r, 'La comprobación falló; la página no se marcó como publicada', 'MainSpot');
        MS.notify('failed', 'No pudimos publicar tu página', 'Ya estamos revisándolo. Lo intentaremos de nuevo en unos minutos.', '#/pagina');
        if (S().telegram.status === 'linked') MS.botSay('tg', 'No pudimos publicar tu página. Ya estamos revisándolo y lo intentaremos de nuevo en unos minutos. No tienes que hacer nada.');
        MS.emit();
        MS.publish.schedule();
        return;
      }
      p.step = steps[i + 1];
      if (p.step === 'ACTIVE') { MS.publish.finish(); return; }
      MS.emit();
      MS.publish.schedule();
    },
    retryNow: function () {
      var p = S().site.pub;
      if (!p || (p.state !== 'retry' && p.state !== 'failed')) return;
      p.state = 'running';
      p.step = 'PREPARING';
      p.attempts += 1;
      p.willFail = false;
      p.failedStep = null;
      p.retryAt = null;
      MS.addEvent(MS.req(p.reqId), 'Intentamos publicar de nuevo', 'MainSpot');
      MS.emit();
      MS.publish.schedule();
    },
    finish: function () {
      var p = S().site.pub;
      var r = MS.req(p.reqId);
      var data = MS.applyChanges(MS.siteBase(), r.changes);
      var n = S().site.versions.length + 1;
      S().site.published = data;
      S().site.versions.unshift({ n: n, at: Date.now(), by: r.approvedBy, title: r.title, data: data, reqId: r.id });
      r.status = 'published';
      r.publishedAt = Date.now();
      r.version = n;
      MS.addEvent(r, 'Comprobamos que la página funciona y quedó publicada (versión ' + n + ')', 'MainSpot');
      p.step = 'ACTIVE';
      p.state = 'done';
      p.doneAt = Date.now();
      var first = p.kind === 'first';
      MS.notify('live', first ? '¡Tu página ya está en internet!' : 'Tu cambio ya está en tu página', MS.DATA.address, '#/pagina');
      if (S().telegram.status === 'linked') MS.botSay('tg', (first ? '¡Tu página ya está en internet! ' : 'Listo, tu cambio ya está en tu página: ') + MS.DATA.address);
      MS.tourDone(first ? 'live' : (r.channel === 'telegram' ? 'tgPublished' : 'changePublished'));
      MS.emit();
    },
    resume: function () {
      var p = S().site.pub;
      if (p && p.state !== 'done') MS.publish.schedule();
      // Vistas previas que se estaban preparando al recargar la página
      S().requests.forEach(function (r) {
        if (r.status === 'preparing') {
          if (r.kind === 'first' && !r.preview) {
            r.status = 'preview_ready';
            r.preview = { readyAt: Date.now(), expiresAt: Date.now() + 3600000, rev: 1 };
          } else {
            MS.later('prep-' + r.id, 800, function () { MS.previewReady(r.id, r.channel === 'telegram' ? 'tg' : 'panel'); MS.emit(); });
          }
        }
      });
    }
  };

  /* ---------- Telegram simulado (DEC-0041) ---------- */
  MS.tg = {
    TTL: 10 * 60 * 1000, // «corta vigencia»: 10 min es un dato ficticio
    generate: function () {
      var t = S().telegram;
      var d = String(100000 + Math.floor(Math.random() * 899999));
      t.code = d.slice(0, 3) + ' ' + d.slice(3);
      t.codeState = 'active';
      t.codeExpiresAt = Date.now() + MS.tg.TTL;
      t.status = 'code';
      MS.emit();
    },
    liveState: function () {
      var t = S().telegram;
      if (t.codeState === 'active' && t.codeExpiresAt && Date.now() > t.codeExpiresAt) t.codeState = 'expired';
      return t.codeState;
    },
    revoke: function () {
      var t = S().telegram;
      if (t.codeState === 'active') t.codeState = 'revoked';
      MS.emit();
    },
    /* Se toca «Iniciar» en el chat abierto desde el enlace del panel. */
    start: function (code, typed) {
      var t = S().telegram;
      var st = MS.tg.liveState();
      push('tg', { from: 'me', text: typed || 'Iniciar' });
      MS.mem.tgStart = null;
      botLater('tg', function () {
        if (t.status === 'linked') { MS.botSay('tg', 'Este chat ya está conectado con ' + MS.DATA.business + '.'); return; }
        if (!code || code !== t.code) { MS.botSay('tg', 'Hola. Para usar MainSpot aquí, abre tu panel y toca «Conectar Telegram».'); return; }
        if (st === 'expired') { MS.botSay('tg', 'Este código caducó. Genera uno nuevo desde tu panel.'); return; }
        if (st === 'used') { MS.botSay('tg', 'Este código ya se usó. Si no fuiste tú, desconecta el chat desde tu panel y genera uno nuevo.'); return; }
        if (st === 'revoked') { MS.botSay('tg', 'Este código fue anulado. Genera uno nuevo desde tu panel.'); return; }
        t.codeState = 'used';
        t.status = 'linked';
        t.linkedAt = Date.now();
        t.chatName = MS.me().name.split(' ')[0] + ' ' + MS.me().name.split(' ')[1];
        MS.botSay('tg', 'Listo: tu Telegram está conectado con ' + MS.DATA.business + '.');
        MS.botSay('tg', 'Desde aquí puedes pedirme cambios para tu página, por ejemplo: «El sábado abrimos de 8 a 2».\nAntes de publicar cualquier cosa, siempre te pediré tu aprobación.');
        MS.notify('tg', 'Tu Telegram quedó conectado', 'Ya puedes pedir cambios por chat.', '#/telegram');
        MS.tourDone('telegram');
      }, 1000);
    },
    unlink: function () {
      var t = S().telegram;
      t.status = 'unlinked';
      t.code = null;
      t.codeState = null;
      t.codeExpiresAt = null;
      MS.systemSay('tg', 'Desconectaste este chat');
      MS.botSay('tg', 'Este chat ya no está conectado con ' + MS.DATA.business + '. Para volver a usarlo, conéctalo desde tu panel.');
      MS.emit();
    },
    force: function (state) {
      var t = S().telegram;
      if (!t.code) MS.tg.generate();
      t.status = t.status === 'linked' ? 'linked' : 'code';
      t.codeState = state;
      if (state === 'expired') t.codeExpiresAt = Date.now() - 1000;
      MS.emit();
    }
  };
})();
