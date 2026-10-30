/* =====================================================================
   MainSpot · Cambios a la página, publicación y Telegram (API real, DEV-E2E-03)
   - La interpretación la hace el backend (POST /conversation/messages):
     aquí no hay reglas simuladas; la conversación se reconstruye de las
     solicitudes y propuestas guardadas en PostgreSQL (sobrevive a recargas).
   - Ciclo: propuesta → confirmación → vista previa → aprobación humana → publicación.
   - El asistente PROPONE; nunca aprueba ni publica (RULE-004).
   - Telegram: chat SIMULADO de desarrollo que usa el mismo webhook/servicio que el bot.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var API = MS.api;
  var S = function () { return MS.S; };
  var seq = 0;
  function localId(p) { seq += 1; return (p || 'l') + '-' + seq; }

  /* ---------- Textos de publicación (DEC-0043) ---------- */
  MS.PUB_TEXT = {
    REGISTERED: { t: 'Recibimos tu página', d: 'Tu aprobación quedó registrada.' },
    PREPARING: { t: 'Estamos preparando tu página', d: 'Armamos la versión que aprobaste.' },
    CONFIGURING: { t: 'Estamos configurando tu dirección web', d: 'Le damos a tu página su dirección propia.' },
    VERIFYING: { t: 'Comprobando que todo funcione', d: 'Revisamos que tu página abra bien y muestre lo correcto.' },
    ACTIVE: { t: 'Tu página ya está en internet', d: '' },
    FAILED: { t: 'No pudimos publicar tu página', d: 'Tu página no cambió.' },
    RETRY_PENDING: { t: 'Lo intentaremos de nuevo en unos minutos', d: 'No tienes que hacer nada.' }
  };
  MS.publish = {
    steps: function (kind) { return kind === 'first' ? ['REGISTERED', 'PREPARING', 'CONFIGURING', 'VERIFYING', 'ACTIVE'] : ['REGISTERED', 'PREPARING', 'VERIFYING', 'ACTIVE']; }
  };

  /* ---------- Conversación del panel, reconstruida del backend ---------- */
  var SYSTEM_INTENTS = /^(website\.initial|website\.phone|website\.restore|social\.)/;
  MS.buildConvo = function (requests, reqById) {
    var meId = S().me ? S().me.user_id : null;
    var list = requests.filter(function (r) { return r.channel === 'simulated' && !SYSTEM_INTENTS.test(r.intent || ''); })
      .slice().sort(function (a, b) { return (MS.ts(a.created_at) || 0) - (MS.ts(b.created_at) || 0); }).slice(-30);
    var out = [];
    list.forEach(function (r) {
      var at = MS.ts(r.created_at) || Date.now();
      out.push({ id: 'u-' + r.request_id, from: 'me', text: r.raw_message, at: at, who: r.actor_id === meId ? MS.me().short : 'Tu equipo' });
      var p = r.proposal_id ? reqById[r.proposal_id] : null;
      var m = { id: 'b-' + r.request_id, from: 'bot', at: at + 1, actions: [], text: '' };
      if (p && p.kind === 'change') {
        var sum = p.summary;
        m.changes = p.changes.filter(function (c) { return c.field !== 'generic'; });
        m.reqId = p.id;
        var canDecide = MS.can('approve');
        switch (p.status) {
          case 'awaiting_confirm':
            m.text = sum + '\n¿Preparo la vista previa?';
            if (MS.can('confirm') && !MS.expired()) m.actions = [{ label: 'Sí, prepara la vista previa', act: 'confirm', arg: p.id, style: 'primary' }, { label: 'No, corregir', act: 'correct', arg: p.id, style: 'secondary' }];
            break;
          case 'preparing': m.text = sum + '\nEstoy preparando la vista previa…'; break;
          case 'preview_ready':
            m.text = sum + '\nTu vista previa está lista. Nada cambia en tu página hasta que ' + (canDecide ? 'tú lo apruebes.' : 'quien administra tu negocio lo apruebe.');
            m.actions = [{ label: 'Ver vista previa', act: 'open', arg: '#/vista-previa/' + p.id, style: 'primary' }];
            break;
          case 'approved': m.text = sum + '\nAprobado. Lo estamos publicando.'; break;
          case 'published': m.text = sum + '\nListo: ya está en tu página.'; m.actions = [{ label: 'Ver mi página', act: 'open', arg: '#/sitio', style: 'secondary' }]; break;
          case 'rejected': m.text = sum + '\nDe acuerdo, no se preparó ni se publicó nada.'; break;
          case 'expired': m.text = sum + '\nLa vista previa venció sin decisión. No se publicó nada.'; break;
          case 'failed': m.text = sum + '\nNo se pudo publicar. Tu página no cambió.'; m.actions = [{ label: 'Ver qué pasó', act: 'open', arg: '#/cambios/' + p.id, style: 'secondary' }]; break;
          default: m.text = sum;
        }
      } else {
        m.text = r.response_message || 'Recibimos tu mensaje.';
        if (/Teléfonos de contacto/.test(m.text)) m.actions = [{ label: 'Cambiar el teléfono de mi página', act: 'open', arg: '#/pagina?ir=phone-website', style: 'secondary' }];
        if (/Todavía no tienes página/.test(m.text)) m.actions = [{ label: 'Crear mi página', act: 'open', arg: '#/pagina/crear', style: 'primary' }];
        if (p && p.kind === 'sensitive') m.actions = [{ label: 'Ver la solicitud', act: 'open', arg: '#/cambios/' + p.id, style: 'secondary' }];
      }
      out.push(m);
    });
    return out;
  };

  function finishLocal(channel) { MS.mem.typing[channel] = false; MS.mem.local[channel] = []; }

  /** La persona escribe en el panel: el backend clasifica y responde (sin efectos sin aprobación). */
  MS.send = function (channel, text) {
    text = String(text || '').trim();
    if (!text) return Promise.resolve();
    if (channel === 'tg') return MS.tg.send(text);
    MS.mem.local.panel = [{ id: localId('me'), from: 'me', text: text, at: Date.now() }];
    MS.mem.typing.panel = true;
    MS.emit();
    return API.post('/conversation/messages', { text: text, channel: 'simulated' }, { idempotencyKey: API.key() }).then(function (res) {
      if (!res.ok) {
        MS.mem.typing.panel = false;
        MS.mem.local.panel.push({ id: localId('err'), from: 'bot', error: true, text: res.error.message, at: Date.now() });
        MS.emit();
        return res;
      }
      return MS.refresh(['requests', 'proposals'], true).then(function () { finishLocal('panel'); MS.emit(); return res; });
    });
  };

  /* Botones dentro de la conversación. */
  MS.convoAct = function (channel, msgId, idx) {
    if (channel === 'tg') { MS.tg.act(msgId, idx); return; }
    var m = S().convo.panel.concat(MS.mem.local.panel).filter(function (x) { return x.id === msgId; })[0];
    if (!m || !m.actions || !m.actions[idx] || MS.mem.busy[msgId]) return;
    var a = m.actions[idx];
    if (a.act === 'text') { MS.send(channel, a.arg); return; }
    if (a.act === 'open') { location.hash = a.arg; return; }
    MS.mem.busy[msgId] = true;
    MS.emit();
    var done = function (r) { delete MS.mem.busy[msgId]; if (r && !r.ok) MS.ui.toast(r.message || r.error.message, 'info'); MS.emit(); };
    if (a.act === 'confirm') MS.confirmRequest(a.arg).then(done);
    else if (a.act === 'correct') MS.reject(a.arg).then(function (r) { done(r); if (r.ok) MS.ui.toast('De acuerdo, no preparo nada. Dime cómo debe quedar.', 'info'); });
    else done();
  };

  /* ---------- Ciclo de la solicitud (API) ---------- */
  function after(res, keys) {
    return MS.refresh(keys || ['proposals', 'requests', 'website'], true).then(function () {
      return res.ok ? { ok: true, data: res.data } : { ok: false, code: res.error.code, status: res.status, message: res.error.message };
    });
  }

  MS.confirmRequest = function (id) {
    return API.post('/conversation/proposals/' + encodeURIComponent(id) + '/confirm').then(function (res) { return after(res); });
  };

  /** Aprobación humana: solo Administración (el backend lo exige). Repetir no duplica. */
  MS.approve = function (id) {
    return API.post('/conversation/proposals/' + encodeURIComponent(id) + '/approve').then(function (res) {
      return after(res, ['proposals', 'requests', 'website', 'phones']).then(function (out) {
        if (out.ok && res.data && res.data.already_published) out.message = 'Ya habías aprobado este cambio. No se publicó dos veces.';
        if (!out.ok && out.code === 'publish_failed') out.message = 'No pudimos publicar. Tu página no cambió; puedes intentarlo de nuevo.';
        return out;
      });
    });
  };

  MS.reject = function (id) {
    return API.post('/conversation/proposals/' + encodeURIComponent(id) + '/reject').then(function (res) { return after(res); });
  };

  /** Vista previa vencida: se vuelve a pedir el mismo cambio (nueva propuesta). */
  MS.renewPreview = function (id) {
    var r = MS.req(id);
    if (!r || !r.text) return Promise.resolve({ ok: false, message: 'Escribe de nuevo el cambio que quieres.' });
    return MS.send('panel', r.text).then(function () { return { ok: true }; });
  };

  /* ---------- Página del negocio ---------- */
  function slugify(name) {
    var s = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return s.length >= 2 ? s : 'mi-negocio';
  }

  /**
   * Crea la página con los datos del alta (cuota «website» del plan) y prepara su primera
   * versión con vista previa. Si el subdominio ya existe, prueba otro; si la página ya existía
   * (otra sesión), continúa con ella.
   */
  MS.createSite = function (data) {
    var name = MS.DATA.business || 'Mi negocio';
    var base = slugify(name);
    function attempt(n) {
      var slug = n === 0 ? base : base + '-' + Math.random().toString(36).slice(2, 6);
      return API.post('/website', { slug: slug, site_name: name, data: data }, { idempotencyKey: API.key() }).then(function (res) {
        if (res.ok) return res;
        if (res.status === 409 && n < 3) {
          return API.get('/website').then(function (w) { return w.ok && w.data.website ? { ok: true } : attempt(n + 1); });
        }
        return res;
      });
    }
    var start = S().website ? Promise.resolve({ ok: true }) : attempt(0);
    return start.then(function (res) {
      if (!res.ok) return { ok: false, message: res.error.message, code: res.error.code };
      return MS.prepareFirstPage();
    });
  };

  MS.prepareFirstPage = function () {
    return API.post('/website/first-publication').then(function (res) {
      if (!res.ok && res.error.code === 'already_published') res = { ok: true, data: {} };
      return after(res).then(function (out) {
        if (out.ok && res.data && res.data.proposal) out.id = res.data.proposal.proposal_id;
        return out;
      });
    });
  };

  /** El número nuevo de la Página web se publica con vista previa y aprobación. */
  MS.prepareWebPhone = function () {
    return API.post('/website/phone-publication').then(function (res) {
      return after(res).then(function (out) {
        if (out.ok && res.data && res.data.proposal) out.id = res.data.proposal.proposal_id;
        return out;
      });
    });
  };

  /** «Restaurar esta versión»: propuesta con vista previa «actual vs solicitada»; publica solo tras aprobación. */
  MS.restoreVersion = function (n, expectedCurrent) {
    return API.post('/website/versions/' + encodeURIComponent(n) + '/restore', { expected_current_version: expectedCurrent }, { idempotencyKey: API.key() }).then(function (res) {
      return after(res).then(function (out) {
        if (out.ok && res.data && res.data.proposal) out.id = res.data.proposal.proposal_id;
        return out;
      });
    });
  };

  /* ---------- Telegram (vínculo real + chat simulado de desarrollo) ---------- */
  function fmtCode(c) { return String(c || '').replace(/(.{4})(?=.)/g, '$1 '); }
  MS.tg = {
    fmt: fmtCode,
    /** Código de un solo uso (10 min). Solo vive en memoria de esta pestaña. */
    generate: function () {
      return API.post('/telegram/link-code').then(function (res) {
        if (!res.ok) return { ok: false, message: res.error.message };
        MS.mem.tgCode = { code: res.data.code, expiresAt: MS.ts(res.data.expires_at), channel_mode: res.data.channel_mode, instructions: res.data.instructions, revoked: false };
        MS.derive();
        MS.emit();
        return { ok: true };
      });
    },
    liveState: function () { MS.derive(); return S().telegram.codeState; },
    /**
     * Anular: el backend invalida los códigos anteriores al emitir uno nuevo; se emite uno y se
     * descarta sin mostrarlo, así el código visible deja de funcionar.
     */
    revoke: function () {
      return API.post('/telegram/link-code').then(function (res) {
        if (MS.mem.tgCode) MS.mem.tgCode.revoked = true;
        MS.derive();
        MS.emit();
        return res.ok ? { ok: true } : { ok: false, message: res.error.message };
      });
    },
    unlink: function () {
      return API.del('/telegram/link').then(function (res) {
        return MS.refresh(['telegram', 'tgChat'], true).then(function () { return res.ok ? { ok: true } : { ok: false, message: res.error.message }; });
      });
    },
    /** «Iniciar» en el chat simulado: envía /start CÓDIGO al webhook, como el bot real. */
    start: function (code) {
      MS.mem.tgStart = null;
      return MS.tg.send('/start ' + String(code || '').replace(/\s+/g, ''));
    },
    send: function (text) {
      text = String(text || '').trim();
      if (!text) return Promise.resolve();
      MS.mem.local.tg = [{ id: localId('tgme'), from: 'me', text: text, at: Date.now() }];
      MS.mem.typing.tg = true;
      MS.mem.busy.tg = true;
      MS.emit();
      return API.post('/dev/simulator/telegram', { text: text }).then(function (res) {
        return MS.refresh(['tgChat', 'telegram', 'cases'], true).then(function () {
          finishLocal('tg');
          delete MS.mem.busy.tg;
          if (!res.ok) MS.ui.toast(res.error.message, 'info');
          MS.emit();
          return res;
        });
      });
    },
    /** Mensajes del chat simulado; los avisos de casos abiertos llevan botones (mismo case_id). */
    build: function (messages) {
      return (messages || []).map(function (m, i) {
        var out = { id: 'tg-' + i + '-' + m.at, from: m.from, text: m.text, at: MS.ts(m.at), actions: [] };
        var mc = m.from === 'bot' ? /Caso: (\S+)/.exec(m.text) : null;
        if (mc) {
          var id = mc[1];
          var c = (S().cases || []).filter(function (x) { return x.id === id; })[0];
          var n = (m.text.match(/^\d\) /gm) || []).length;
          if (c && (c.status === 'needs_human' || c.status === 'failed') && MS.can('engagement.approve')) {
            for (var k = 1; k <= n; k += 1) out.actions.push({ label: 'Usar opción ' + k, act: 'case-pick', arg: id + '|' + k });
            out.actions.push({ label: 'No responder', act: 'case-reject', arg: id });
          }
          out.actions.push({ label: 'Ver en el panel', act: 'open', arg: '#/caso/' + id });
        }
        return out;
      });
    },
    act: function (msgId, idx) {
      var m = S().convo.tg.concat(MS.mem.local.tg).filter(function (x) { return x.id === msgId; })[0];
      if (!m || !m.actions || !m.actions[idx] || MS.mem.busy.tg) return;
      var a = m.actions[idx];
      if (a.act === 'open') { location.hash = a.arg; return; }
      var parts = String(a.arg || '').split('|');
      if (a.act === 'case-pick') {
        var c = MS.agent.get(parts[0]);
        var d = c && c.drafts[Number(parts[1]) - 1];
        // Segundo toque en Telegram antes de publicar (la decisión es de la persona).
        MS.mem.local.tg = [{ id: localId('tgq'), from: 'bot', at: Date.now(), text: '¿Publico esta respuesta' + (c ? ' en ' + MS.agent.SRC[c.source].short : '') + '?\n«' + (d ? d.text : '') + '»', actions: [{ label: 'Sí, publicar', act: 'case-yes', arg: a.arg }, { label: 'Todavía no', act: 'case-no' }] }];
        MS.emit();
        return;
      }
      if (a.act === 'case-no') { MS.mem.local.tg = [{ id: localId('tgn'), from: 'system', at: Date.now(), text: 'El caso sigue esperando tu decisión.' }]; MS.emit(); return; }
      if (a.act === 'case-yes') { MS.tg.send('/aprobar ' + parts[0] + ' ' + parts[1]); return; }
      if (a.act === 'case-reject') { MS.tg.send('/rechazar ' + parts[0]); }
    }
  };
})();
