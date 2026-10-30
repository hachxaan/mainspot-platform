/* =====================================================================
   MainSpot · Estado del panel hidratado desde la API real (DEV-E2E-03)
   Sustituye al store del prototipo (localStorage + fixtures): MS.S se
   reconstruye SIEMPRE a partir de las respuestas del backend (MS.R) con
   adaptadores pequeños, con la forma que esperan las vistas de Claude.
   localStorage solo guarda qué avisos ya viste (ids, sin datos sensibles).
   ===================================================================== */
(function () {
  'use strict';
  var MS = (window.MS = window.MS || {});
  var API = MS.api;

  /* ---------- Datos del negocio en sesión (antes: datos de demostración) ---------- */
  MS.DATA = {
    business: '',
    address: '',
    owner: { name: '', short: '', email: '' },
    people: { administration: { name: 'quien administra tu negocio', short: '', role: 'Administración', desc: '' } }
  };

  MS.FIELD_LABEL = {
    phone: 'Teléfono', hours: 'Horario', address: 'Dirección', line: 'Frase de tu negocio', name: 'Nombre',
    'services.add': 'Lo que vendes', 'section.add': 'Sección', generic: 'Información', page: 'Tu página completa'
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  MS.clone = clone;

  function emptySite() { return { name: '', line: '', about: '', phone: '', email: '', address: '', hours: '', services: [], sections: [] }; }
  MS.emptySite = emptySite;

  function freshPhone() { return { mode: 'own', other: null, effective: null, savedAt: null, sync: null, needsPrimary: false }; }

  function fresh() {
    return {
      session: false,
      booting: true,
      loading: false,
      loadError: null,
      me: null,
      role: null,
      perms: [],
      trial: 'active',
      plan: null,
      biz: emptySite(),
      website: null,
      site: { published: null, versions: [], pub: null, initial: null, local: null },
      requests: [],
      convo: { panel: [], tg: [] },
      notices: [],
      telegram: { status: 'unlinked', code: null, codeState: null, codeExpiresAt: null, linkedAt: null, chatName: '', mode: 'simulated' },
      primary: null,
      phones: { website: freshPhone(), google: freshPhone(), facebook: freshPhone() },
      prov: {
        google: { connected: false, down: false, perm: true, connectedAt: null, mode: 'simulated' },
        facebook: { connected: true, down: false, perm: true, connectedAt: null, mode: 'simulated' }
      },
      gbp: null,
      posts: [],
      agent: { watching: true, lastCheck: null, policy: { enabled: false, thanks: 'review', info: 'review', scope: { google: true, facebook: true } }, version: 0, versions: [] },
      cases: [],
      dev: { simulator: false, telegram: false }
    };
  }

  /** Respuestas crudas del backend (fuente de verdad del render). */
  MS.R = {};
  MS.S = fresh();
  /** Memoria de la pestaña (borradores de formularios, estados de carga). Nunca contraseñas. */
  function freshMem() {
    return {
      timers: {}, typing: { panel: false, tg: false }, busy: {}, local: { panel: [], tg: [] }, tgCode: null,
      phDraft: {}, caseDraft: {}, fbDraft: null, polDraft: null, bizDraft: null, gbpEdit: false, gbpLocations: null, metaPages: null
    };
  }
  MS.mem = freshMem();

  MS.reset = function () {
    Object.keys(MS.mem.timers).forEach(function (k) { clearTimeout(MS.mem.timers[k]); });
    MS.R = {};
    MS.S = fresh();
    MS.S.booting = false;
    MS.mem = freshMem();
  };

  /* ---------- Eventos ---------- */
  var listeners = [];
  MS.on = function (fn) { listeners.push(fn); };
  MS.emit = function () { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); };
  MS.later = function (key, ms, fn) {
    clearTimeout(MS.mem.timers[key]);
    MS.mem.timers[key] = setTimeout(function () { delete MS.mem.timers[key]; fn(); }, ms);
  };

  /* ---------- Formato ---------- */
  MS.esc = function (v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  MS.icon = function (name, cls) {
    return '<svg class="ic ' + (cls || '') + '" aria-hidden="true" focusable="false"><use href="#i-' + name + '"></use></svg>';
  };
  var MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  MS.ts = function (iso) { var t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? null : t; };
  MS.time = function (ts) {
    var d = new Date(ts);
    var h = d.getHours(), m = d.getMinutes();
    return h + ':' + (m < 10 ? '0' : '') + m;
  };
  MS.date = function (ts, withYear) {
    var d = new Date(ts);
    return d.getDate() + ' de ' + MONTHS[d.getMonth()] + (withYear ? ' de ' + d.getFullYear() : '');
  };
  MS.when = function (ts) {
    if (!ts) return '';
    var now = new Date();
    var d = new Date(ts);
    var diff = Date.now() - ts;
    if (diff < 60 * 1000 && diff > -60 * 1000) return 'hace un momento';
    if (d.toDateString() === now.toDateString()) return 'hoy, ' + MS.time(ts);
    return MS.date(ts) + ', ' + MS.time(ts);
  };
  MS.cap = function (t) { t = String(t || ''); return t.charAt(0).toUpperCase() + t.slice(1); };

  /* ---------- Plan (suscripción real; sin fechas inventadas) ---------- */
  MS.trialText = function () {
    var p = MS.S.plan;
    if (!p) return 'Tu negocio no tiene un plan activo.';
    if (MS.S.trial === 'expired') return 'Tu plan ' + p.name + ' no está activo.';
    return 'Plan ' + p.name + ' activo.';
  };

  /* ---------- Personas y permisos (del backend) ---------- */
  MS.me = function () {
    var m = MS.S.me || {};
    var name = m.display_name || '';
    return { id: m.user_id, name: name, short: name.split(' ')[0] || name, role: m.role_label || '', desc: m.role_description || '' };
  };
  /** Nombre visible de un actor: tú, MainSpot o alguien de tu equipo (el backend no expone otros nombres). */
  MS.who = function (actorId) {
    if (!actorId) return 'MainSpot';
    if (MS.S.me && actorId === MS.S.me.user_id) return MS.me().name;
    if (/^system:|^preview_token$/.test(actorId)) return 'MainSpot';
    return 'Alguien de tu equipo';
  };
  var ALIAS = { request: 'conversation.send', confirm: 'conversation.confirm', approve: 'operation.approve', editData: 'client.config.manage' };
  MS.can = function (what) { return MS.S.perms.indexOf(ALIAS[what] || what) >= 0; };
  MS.expired = function () { return MS.S.trial === 'expired'; };

  /* ---------- Sitio ---------- */
  function siteData(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var s = function (v) { return typeof v === 'string' ? v : ''; };
    return {
      name: s(r.name), line: s(r.line), about: s(r.about), phone: s(r.phone), email: s(r.email), address: s(r.address),
      hours: s(r.hours), services: Array.isArray(r.services) ? r.services.filter(function (x) { return typeof x === 'string'; }) : [],
      sections: Array.isArray(r.sections) ? r.sections.filter(function (x) { return x && typeof x.title === 'string'; }) : [],
      // AI Core: la página tiene diseño generado (se previsualiza con el HTML del servidor).
      designed: !!(r.design && typeof r.design === 'object')
    };
  }
  MS.siteData = siteData;
  MS.siteBase = function () { return MS.S.site.published || MS.S.biz; };
  /** La página muestra el número efectivo del canal Página web (si está configurado), igual que el publicador. */
  MS.withWebPhone = function (data) {
    var e = MS.ph && MS.ph.effective('website');
    if (!e) return data;
    var d = clone(data);
    d.phone = e.intl;
    return d;
  };

  /* ---------- Solicitudes (propuestas reales) ---------- */
  MS.STATUS = {
    awaiting_confirm: { label: 'Espera tu confirmación', tone: 'rosa' },
    preparing: { label: 'Preparando vista previa', tone: 'ocre' },
    preview_ready: { label: 'Lista para revisar', tone: 'rosa' },
    approved: { label: 'Aprobado, publicando', tone: 'ocre' },
    published: { label: 'Publicado', tone: 'nopal' },
    rejected: { label: 'Descartado', tone: 'neutral' },
    expired: { label: 'Vista previa vencida', tone: 'neutral' },
    failed: { label: 'No se pudo publicar', tone: 'alerta' },
    awaiting_decision: { label: 'Espera aprobación', tone: 'rosa' },
    cancelled: { label: 'Corregido', tone: 'neutral' }
  };
  var P_STATUS = {
    drafted: 'awaiting_decision', awaiting_confirmation: 'awaiting_confirm', confirmed: 'preparing', preview_ready: 'preview_ready',
    approved_for_publish: 'approved', published: 'published', rejected: 'rejected', expired: 'expired', failed: 'failed'
  };
  var PATCH_FIELD = {
    'contact.phone': 'phone', 'schedule.hours': 'hours', 'service.add': 'services.add', 'contact.address': 'address',
    'site.line': 'line', 'site.name': 'name', 'section.add': 'section.add', 'site.generic': 'generic'
  };
  function changesOf(p) {
    var patches = (p.detail && Array.isArray(p.detail.patches)) ? p.detail.patches : [];
    if (!patches.length && p.detail && p.detail.ai && Array.isArray(p.detail.diff_sentences)) {
      return p.detail.diff_sentences.slice(1).map(function (s) { return { field: 'generic', label: 'Cambio', before: '', after: String(s), sentence: String(s) }; });
    }
    return patches.map(function (x) {
      var f = PATCH_FIELD[x.field] || 'generic';
      return { field: f, label: MS.FIELD_LABEL[f] || MS.cap(x.label), before: x.before || '', after: f === 'generic' ? (x.sentence || x.after) : (x.after || ''), sentence: x.sentence || '' };
    });
  }
  function kindOf(p) {
    if (p.proposal_type === 'website.initial') return 'first';
    if (p.proposal_type === 'website.phone') return 'phone';
    if (p.proposal_type === 'website.restore') return 'restore';
    if (p.proposal_type === 'website.ai_design' || p.proposal_type === 'website.ai_edit') return 'ai';
    if (p.capability_target === 'website') return 'change';
    if (p.capability_target === 'social') return 'social';
    return 'sensitive';
  }
  function titleOf(p, kind, changes) {
    if (kind === 'first') return 'Tu primera página';
    if (kind === 'phone') return 'Teléfono de tu página';
    if (kind === 'restore') return 'Volver a la versión ' + ((p.detail && p.detail.restore && p.detail.restore.source_version) || '');
    if (kind === 'sensitive') return 'Decisión que requiere aprobación';
    if (kind === 'ai') { var t = String(p.summary || 'Propuesta de MainSpot'); return t.length > 60 ? t.slice(0, 57) + '…' : t; }
    if (changes.length === 1 && changes[0].field !== 'generic') {
      var c = changes[0];
      if (c.field === 'services.add') return 'Agregar ' + c.after;
      if (c.field === 'section.add') return 'Sección ' + c.after;
      return c.label;
    }
    var s = String(p.summary || 'Cambio en tu página');
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  }
  function eventsOf(p, kind) {
    var ev = [];
    var push = function (iso, text, who) { var t = MS.ts(iso); if (t) ev.push({ at: t, text: text, who: who }); };
    if (kind === 'first') push(p.created_at, 'Preparamos la primera página con los datos de tu negocio', 'MainSpot');
    else if (kind === 'phone') push(p.created_at, '[Cambiaste|Cambió] el teléfono de la página web', MS.who(p.created_by));
    else if (kind === 'restore') push(p.created_at, '[Pediste|Pidió] volver a la versión ' + ((p.detail && p.detail.restore && p.detail.restore.source_version) || ''), MS.who(p.created_by));
    else if (kind === 'ai') push(p.created_at, 'MainSpot preparó la propuesta con IA a partir de [tu|su] pedido', MS.who(p.created_by));
    else push(p.created_at, '[Pediste|Pidió] el cambio', MS.who(p.created_by));
    if (p.confirmed_at) push(p.confirmed_at, 'Preparamos la vista previa', 'MainSpot');
    if (p.rejected_at) push(p.rejected_at, '[Descartaste|Descartó] el cambio', MS.who(p.rejected_by));
    if (p.approved_at) push(p.approved_at, '[Aprobaste|Aprobó] el cambio', MS.who(p.approved_by));
    if (p.status === 'published') push(p.updated_at, 'Comprobamos que la página funciona y quedó publicada' + (p.published_version ? ' (versión ' + p.published_version + ')' : ''), 'MainSpot');
    if (p.status === 'failed') push(p.updated_at, 'La publicación falló; tu página no cambió', 'MainSpot');
    if (p.status === 'expired') push(p.updated_at, 'La vista previa venció sin decisión', 'MainSpot');
    return ev.sort(function (a, b) { return a.at - b.at; });
  }
  function reqOf(p, reqById) {
    var kind = kindOf(p);
    var changes = changesOf(p);
    var rq = reqById[p.request_id];
    return {
      id: p.proposal_id, kind: kind, title: titleOf(p, kind, changes), summary: p.summary,
      channel: kind === 'first' ? 'mainspot' : (rq && rq.channel === 'telegram' ? 'telegram' : 'panel'),
      text: rq && kind === 'change' ? rq.raw_message : '', by: MS.who(p.created_by), byId: p.created_by,
      changes: changes, status: P_STATUS[p.status] || p.status, raw: p.status, target: p.capability_target,
      createdAt: MS.ts(p.created_at), updatedAt: MS.ts(p.updated_at), events: eventsOf(p, kind),
      after: p.detail && p.detail.after ? siteData(p.detail.after) : null,
      designed: !!(p.detail && p.detail.after && p.detail.after.design),
      approvedBy: p.approved_by ? MS.who(p.approved_by) : null, approvedAt: MS.ts(p.approved_at),
      version: p.published_version, preview: p.status === 'preview_ready' ? { readyAt: MS.ts(p.updated_at) } : null
    };
  }
  MS.req = function (id) { return MS.S.requests.filter(function (r) { return r.id === id; })[0] || null; };
  MS.webRequests = function () { return MS.S.requests.filter(function (r) { return r.target === 'website' || r.kind === 'sensitive'; }); };
  MS.pendingRequests = function () {
    return MS.webRequests().filter(function (r) { return ['preview_ready', 'awaiting_confirm', 'preparing', 'expired', 'awaiting_decision', 'failed'].indexOf(r.status) >= 0; });
  };
  MS.waitingApproval = function () { return MS.webRequests().filter(function (r) { return r.status === 'preview_ready'; }); };

  /* El texto puede llevar «[tú|otra persona]» para leerse bien según quién mire el historial. */
  MS.evText = function (e) {
    var mine = e.who === MS.me().name;
    return String(e.text).replace(/\[([^|\]]+)\|([^\]]+)\]/g, function (_, a, b) { return mine ? a : b; });
  };

  /* ---------- Avisos (derivados del estado real; «leído» es preferencia local) ---------- */
  function readKey() { return 'mainspot.avisos.leidos.' + (MS.S.me ? MS.S.me.user_id : 'x'); }
  function readSet() {
    try { return JSON.parse(window.localStorage.getItem(readKey()) || '[]'); } catch (e) { return []; }
  }
  MS.markRead = function (ids) {
    var cur = readSet();
    ids.forEach(function (id) { if (cur.indexOf(id) < 0) cur.push(id); });
    try { window.localStorage.setItem(readKey(), JSON.stringify(cur.slice(-500))); } catch (e) { /* sin almacenamiento */ }
    var set = {};
    cur.forEach(function (x) { set[x] = true; });
    MS.S.notices.forEach(function (n) { if (set[n.id]) n.read = true; });
  };
  MS.notices_markRoute = function (route) {
    MS.markRead(MS.S.notices.filter(function (n) { return n.route === route; }).map(function (n) { return n.id; }));
  };
  MS.unread = function () { return MS.S.notices.filter(function (n) { return !n.read; }).length; };

  function deriveNotices() {
    var S = MS.S, out = [];
    MS.webRequests().forEach(function (r) {
      if (r.status === 'preview_ready') out.push({ id: 'p-ready-' + r.id, kind: 'approval', title: r.kind === 'first' ? 'Tu primera página está lista para revisar' : 'Tienes un cambio esperando tu aprobación', body: r.title, route: '#/vista-previa/' + r.id, at: r.updatedAt });
      if (r.status === 'published') out.push({ id: 'p-live-' + r.id, kind: 'live', title: r.kind === 'first' ? '¡Tu página ya está en internet!' : 'Tu cambio ya está en tu página', body: MS.DATA.address || r.title, route: '#/pagina', at: r.updatedAt });
      if (r.status === 'failed') out.push({ id: 'p-fail-' + r.id, kind: 'failed', title: 'No pudimos publicar tu página', body: 'Tu página no cambió. Puedes intentarlo de nuevo.', route: '#/pagina', at: r.updatedAt });
    });
    S.cases.forEach(function (c) {
      var src = MS.agent && MS.agent.SRC[c.source];
      if (c.status === 'needs_human') out.push({ id: 'c-need-' + c.id, kind: 'case', title: 'Un cliente necesita tu atención', body: (src ? src.label : 'Mensaje') + ' de ' + c.author, route: '#/caso/' + c.id, at: c.at });
      if (c.status === 'failed') out.push({ id: 'c-fail-' + c.id, kind: 'case_failed', title: 'No pudimos responder a un cliente', body: (src ? src.label : 'Mensaje') + ' de ' + c.author, route: '#/caso/' + c.id, at: c.updatedAt });
    });
    if (S.telegram.status === 'linked' && S.telegram.linkedAt) out.push({ id: 'tg-' + S.telegram.linkedAt, kind: 'tg', title: 'Tu Telegram quedó conectado', body: 'Ahí te avisamos de lo que necesite tu decisión.', route: '#/telegram', at: S.telegram.linkedAt });
    var read = {};
    readSet().forEach(function (x) { read[x] = true; });
    out.forEach(function (n) { n.read = !!read[n.id]; });
    S.notices = out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  /* ---------- Derivación de MS.S a partir de MS.R ---------- */
  function derive() {
    var S = MS.S, R = MS.R;
    if (R.me) {
      S.me = R.me;
      S.role = R.me.role_id;
      S.perms = R.me.permissions || [];
      MS.DATA.business = (R.me.tenant && R.me.tenant.business_name) || '';
      MS.DATA.owner = { name: R.me.display_name, short: String(R.me.display_name || '').split(' ')[0], email: '' };
      if (S.role === 'administration') MS.DATA.people.administration = { name: R.me.display_name, short: MS.DATA.owner.short, role: 'Administración', desc: R.me.role_description };
      else MS.DATA.people.administration = { name: 'quien administra tu negocio', short: '', role: 'Administración', desc: '' };
    }
    if (R.ent !== undefined) {
      S.plan = R.ent ? R.ent.plan : null;
      S.trial = R.ent && R.ent.subscription && R.ent.subscription.status === 'active' ? 'active' : 'expired';
      S.limits = R.ent ? R.ent.limits : {};
    }
    // Sitio
    var w = R.website ? R.website.website : null;
    S.website = w;
    S.domain = R.website ? R.website.domain : null;
    // DEV-E2E-04 (P3): sitio local real (https://<slug>.mainspot.local.io) si Operación lo provisionó.
    S.site.local = R.website && R.website.local_site ? R.website.local_site : null;
    MS.DATA.address = S.site.local && S.site.local.provisioned ? S.site.local.url : (S.domain && S.domain.subdomain ? S.domain.subdomain : '');
    S.biz = siteData(w ? w.data : {});
    if (!S.biz.name) S.biz.name = (w && w.site_name) || MS.DATA.business;
    S.site.published = w && Number(w.published_version) > 0 ? siteData(w.data) : null;
    if (S.site.published && !S.site.published.name) S.site.published.name = w.site_name;

    // Solicitudes (propuestas) y conversación
    var reqById = {};
    (R.requests || []).forEach(function (r) { reqById[r.request_id] = r; });
    S.requests = (R.proposals || []).map(function (p) { return reqOf(p, reqById); });
    var byId = {};
    S.requests.forEach(function (r) { byId[r.id] = r; });
    S.site.initial = S.requests.filter(function (r) { return r.kind === 'first' && ['awaiting_confirm', 'preparing', 'preview_ready', 'approved', 'failed', 'published'].indexOf(r.status) >= 0; })[0] || null;
    S.site.versions = ((R.website && R.website.versions) || []).map(function (v) {
      var r = byId[v.proposal_id];
      return { n: v.version, at: MS.ts(v.created_at), by: r && r.approvedBy ? r.approvedBy : 'Alguien de tu equipo', title: r ? r.title : v.diff_summary, reqId: v.proposal_id,
        restorable: v.restorable !== false, from: v.restored_from_version || null };
    });
    var lastPub = MS.webRequests().filter(function (r) { return r.target === 'website' && ['approved', 'published', 'failed'].indexOf(r.status) >= 0; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0];
    S.site.pub = lastPub ? {
      reqId: lastPub.id, kind: lastPub.kind === 'first' ? 'first' : 'update',
      step: lastPub.status === 'published' ? 'ACTIVE' : 'VERIFYING',
      state: lastPub.status === 'published' ? 'done' : (lastPub.status === 'failed' ? 'failed' : 'running'),
      attempts: 1, doneAt: lastPub.updatedAt
    } : null;
    S.convo.panel = MS.buildConvo ? MS.buildConvo(R.requests || [], byId) : [];

    // Teléfonos
    if (R.phones) MS.ph.hydrate(R.phones);

    // Google / Facebook (simulados mientras no haya conexión real verificada)
    var g = R.gbp;
    S.gbp = g ? g.profile : null;
    S.googleLocation = g && g.google ? g.google.location : null;
    S.prov.google = { connected: !!(g && g.profile), down: false, perm: true, connectedAt: g && g.profile ? MS.ts(g.profile.updated_at) : null, mode: g ? g.provider_mode : 'simulated' };
    // DEV-E2E-04: conexión OAuth real con Google (estado de provider_connection; nunca tokens).
    var gc = R.googleConn;
    S.googleConn = gc || null;
    if (gc) { S.prov.google.status = gc.status; S.prov.google.down = gc.status === 'provider_unavailable'; S.prov.google.perm = gc.status !== 'permission_missing'; if (gc.status === 'connected' && g && g.provider_mode === 'real') S.prov.google.connected = true; }
    var fbSync = R.phones && R.phones.integration_phones && R.phones.integration_phones.facebook ? R.phones.integration_phones.facebook.sync.mode : 'simulated';
    S.prov.facebook = { connected: true, down: false, perm: true, connectedAt: null, mode: fbSync };
    var mc = R.metaConn, mcc = mc && mc.connection;
    S.metaConn = mc || null;
    if (mc && mc.enabled) S.prov.facebook = { connected: !!(mcc && mcc.status === 'connected'), status: mcc ? mcc.status : 'disconnected',
      down: !!(mcc && mcc.status === 'provider_unavailable'), perm: !(mcc && mcc.status === 'permission_missing'), mode: 'real' };
    S.posts = (R.posts || []).map(function (p) {
      return {
        id: p.post_id, text: p.text, status: p.status, contentType: p.content_type, proposalId: p.proposal_id,
        createdAt: MS.ts(p.created_at), publishedAt: MS.ts(p.published_at), scheduledFor: MS.ts(p.scheduled_at),
        by: MS.who(p.created_by), byId: p.created_by, external: p.external_ref
      };
    });

    // Agente
    if (MS.agent) {
      S.cases = (R.cases || []).map(MS.agent.adapt);
      MS.agent.derivePolicy(R.policies || []);
      S.agent.lastCheck = MS.mem.lastPoll || Date.now();
    }

    // Telegram
    var t = R.telegram;
    var code = MS.mem.tgCode;
    if (t && t.linked) {
      S.telegram = { status: 'linked', code: null, codeState: 'used', codeExpiresAt: null, linkedAt: MS.ts(t.linked_at), chatName: 'chat ' + (t.chat_hint || ''), mode: (code && code.channel_mode) || S.telegram.mode };
      MS.mem.tgCode = null;
    } else if (code) {
      var expired = Date.now() > code.expiresAt;
      S.telegram = { status: 'code', code: code.code, codeState: code.revoked ? 'revoked' : (expired ? 'expired' : 'active'), codeExpiresAt: code.expiresAt, linkedAt: null, chatName: '', mode: code.channel_mode };
    } else {
      S.telegram = { status: 'unlinked', code: null, codeState: null, codeExpiresAt: null, linkedAt: null, chatName: '', mode: S.telegram.mode };
    }
    S.convo.tg = MS.tg && MS.tg.build ? MS.tg.build(R.tgChat || []) : [];
    S.dev = { simulator: !!R.devsim, telegram: !!R.devTelegram };
    S.team = R.users || [];

    deriveNotices();
  }
  MS.derive = derive;

  /* ---------- Cargadores (cada uno tolera 403: el perfil no tiene ese permiso) ---------- */
  var LOADERS = {
    me: function () { return API.get('/me').then(function (r) { if (r.ok) MS.R.me = r.data.session; return r; }); },
    ent: function () { return API.get('/subscriptions/entitlements').then(function (r) { MS.R.ent = r.ok ? r.data.entitlements : null; return r; }); },
    website: function () { return API.get('/website').then(function (r) { if (r.ok) MS.R.website = r.data; return r; }); },
    proposals: function () { return API.get('/conversation/proposals').then(function (r) { if (r.ok) MS.R.proposals = r.data.proposals; return r; }); },
    requests: function () { return API.get('/conversation/requests').then(function (r) { if (r.ok) MS.R.requests = r.data.requests; return r; }); },
    phones: function () { return API.get('/contact/phones').then(function (r) { if (r.ok) MS.R.phones = r.data; return r; }); },
    gbp: function () { return API.get('/google/profile').then(function (r) { if (r.ok) MS.R.gbp = r.data; return r; }); },
    posts: function () { return API.get('/social/posts').then(function (r) { if (r.ok) MS.R.posts = r.data.posts; return r; }); },
    cases: function () { return API.get('/engagement/cases').then(function (r) { if (r.ok) MS.R.cases = r.data.cases; return r; }); },
    policies: function () { return API.get('/engagement/policies').then(function (r) { if (r.ok) MS.R.policies = r.data.policies; return r; }); },
    users: function () {
      if (!MS.can('user.manage')) return Promise.resolve({ ok: true });
      return API.get('/users').then(function (r) { if (r.ok) MS.R.users = r.data.users; return r; });
    },
    telegram: function () {
      if (!MS.can('telegram.link')) { MS.R.telegram = null; return Promise.resolve({ ok: true }); }
      return API.get('/telegram/link').then(function (r) { if (r.ok) MS.R.telegram = r.data; return r; });
    },
    devsim: function () {
      // El simulador de proveedores solo existe fuera de producción (404 en producción).
      if (!MS.can('engagement.read')) return Promise.resolve({ ok: true });
      return API.get('/dev/simulator/replies').then(function (r) { MS.R.devsim = r.ok; return r; });
    },
    tgChat: function () {
      if (!MS.can('telegram.link')) return Promise.resolve({ ok: true });
      return API.get('/dev/simulator/telegram').then(function (r) {
        MS.R.devTelegram = r.ok;
        if (r.ok) MS.R.tgChat = r.data.messages;
        return r;
      });
    },
    googleConn: function () { return API.get('/connections/google').then(function (r) { if (r.ok) MS.R.googleConn = r.data; return r; }); },
    metaConn: function () { return API.get('/connections/meta').then(function (r) { if (r.ok) MS.R.metaConn = r.data; return r; }); }
  };
  var ALL = ['ent', 'website', 'proposals', 'requests', 'phones', 'gbp', 'googleConn', 'metaConn', 'posts', 'cases', 'policies', 'telegram', 'devsim', 'tgChat', 'users'];

  function snapshot() {
    try { return JSON.stringify([MS.R, MS.mem.tgCode]); } catch (e) { return String(Math.random()); }
  }

  /** Recarga partes del estado desde la API. Re-dibuja solo si algo cambió (o si force). */
  MS.refresh = function (keys, force) {
    var before = snapshot();
    return Promise.all((keys || ALL).map(function (k) { return LOADERS[k] ? LOADERS[k]() : Promise.resolve({ ok: true }); }))
      .then(function (results) {
        derive();
        if (force || snapshot() !== before) MS.emit();
        return results;
      });
  };

  /** Arranque: si hay token, valida la sesión real (GET /me) y carga todo. */
  MS.boot = function () {
    if (!API.token()) { MS.S.booting = false; MS.S.session = false; return Promise.resolve(false); }
    MS.S.booting = true;
    return LOADERS.me().then(function (r) {
      if (!r.ok) {
        API.setToken(null);
        MS.reset();
        return false;
      }
      MS.S.session = true;
      MS.S.loading = true;
      derive();
      return MS.refresh(ALL, true).then(function (results) {
        MS.S.loading = false;
        MS.S.booting = false;
        var failed = results.filter(function (x) { return x && !x.ok && x.status !== 403 && x.status !== 404; });
        MS.S.loadError = failed.length ? failed[0].error.message : null;
        MS.emit();
        return true;
      });
    });
  };

  /** Tras iniciar sesión (token nuevo). */
  MS.startSession = function (token) {
    API.setToken(token);
    MS.reset();
    return MS.boot();
  };

  MS.endSession = function () {
    API.setToken(null);
    MS.reset();
  };

  /* ---------- Sondeo: refleja worker, Telegram y otras sesiones sin recargar ---------- */
  MS.poll = function () {
    if (!MS.S.session || document.visibilityState !== 'visible') return;
    MS.mem.lastPoll = Date.now();
    MS.refresh(['proposals', 'requests', 'website', 'cases', 'posts', 'telegram', 'policies', 'phones', 'gbp', 'googleConn', 'metaConn']);
  };
})();
