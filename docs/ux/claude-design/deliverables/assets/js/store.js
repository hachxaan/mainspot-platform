/* =====================================================================
   MainSpot · Prototipo · Estado simulado y utilidades
   Todo es ficticio. La única persistencia es localStorage del navegador,
   con datos de demostración reiniciables. Las contraseñas NUNCA se guardan.
   ===================================================================== */
(function () {
  'use strict';
  var MS = (window.MS = window.MS || {});
  var KEY = 'mainspot-prototipo-v2';

  /* ---------- Datos de demostración ---------- */
  MS.DATA = {
    business: 'Panadería Lupita',
    address: 'panaderialupita.mainspot.ejemplo', // dirección ficticia (dominio por definir, DEC-0004)
    owner: { name: 'Guadalupe Ramírez', short: 'Lupita', email: 'lupita@ejemplo.mx' },
    people: {
      administration: { name: 'Guadalupe Ramírez', short: 'Lupita', role: 'Administración', desc: 'Puedes pedir cambios, aprobarlos y publicarlos.' },
      operation: { name: 'Toño Ramírez', short: 'Toño', role: 'Operación', desc: 'Puedes pedir cambios y preparar vistas previas. Quien administra el negocio los aprueba.' },
      read_only: { name: 'Rosa Méndez', short: 'Rosa', role: 'Solo lectura', desc: 'Puedes ver la información del negocio, pero no cambiarla.' }
    },
    advisor: 'Ana, del equipo MainSpot',
    draft: {
      name: 'Panadería Lupita',
      line: 'Pan dulce y salado, recién horneado cada mañana',
      about: 'Horneamos en el barrio desde 1998. Conchas, orejas, bolillos y pasteles por encargo.',
      phone: '+52 983 000 0000',
      address: 'Calle de los Fresnos 12, Col. Ejemplo, Ciudad de México',
      hours: { week: '7:00 a 20:00', sat: '7:00 a 15:00', sun: '8:00 a 13:00' },
      services: ['Pan dulce', 'Bolillo y telera', 'Pasteles por encargo', 'Café de olla']
    }
  };

  MS.FIELD_LABEL = {
    'hours.week': 'Horario de lunes a viernes',
    'hours.sat': 'Horario del sábado',
    'hours.sun': 'Horario del domingo',
    phone: 'Teléfono',
    address: 'Dirección',
    line: 'Frase de tu negocio',
    'services.add': 'Lo que vendes',
    'services.remove': 'Lo que vendes',
    page: 'Tu página completa'
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  MS.clone = clone;

  function fresh() {
    var now = Date.now();
    return {
      v: 2,
      createdAt: now,
      invite: { status: 'not_sent', sentAt: null, code: 'K7Q2-PL' },
      account: { activated: false, activatedAt: null },
      session: false,
      role: 'administration',
      trial: 'active', // active | ending | expired
      trialStart: now,
      biz: clone(MS.DATA.draft),
      onboardingDone: false,
      site: { published: null, versions: [], pub: null },
      telegram: { status: 'unlinked', code: null, codeState: null, codeExpiresAt: null, linkedAt: null, chatName: 'Lupita Ramírez' },
      requests: [],
      convo: { panel: [], tg: [] },
      pending: { panel: null, tg: null },
      adjusting: null,
      notices: [],
      seq: 1,
      tour: {},
      // Teléfonos (contrato compartido §A): un principal y un «otro número» INDEPENDIENTE por integración.
      primary: { iso: 'MX', nat: '9830000000' },
      phones: {
        website: { mode: 'own', other: null, savedAt: null },
        google: { mode: 'own', other: null, savedAt: null, sync: null },
        facebook: { mode: 'own', other: null, savedAt: null, sync: null }
      },
      // Integraciones simuladas: nunca hay conexión real con Google ni Meta.
      prov: {
        google: { connected: false, down: false, perm: true, connectedAt: null },
        facebook: { connected: false, down: false, perm: true, connectedAt: null }
      },
      posts: [],
      // Agente de atención (contrato §B). Por defecto todo pasa a revisión humana.
      agent: {
        watching: true, lastCheck: now, queue: [], seen: {}, dupes: 0, fixture: 0,
        policy: { enabled: false, thanks: 'review', info: 'review', scope: { google: true, facebook: true } },
        version: 1,
        versions: [{ v: 1, at: now, by: 'MainSpot', summary: 'Predeterminado: todas las respuestas públicas se revisan antes de publicarse.' }]
      },
      cases: [],
      demo: { notes: true, failNextPublish: false, dashError: false, dashLoading: false }
    };
  }

  MS.mem = { password: null, timers: {} };

  MS.load = function () {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.v === 2) return s;
      }
    } catch (e) { /* sin almacenamiento: seguimos en memoria */ }
    return fresh();
  };
  MS.S = MS.load();

  MS.save = function () {
    try { window.localStorage.setItem(KEY, JSON.stringify(MS.S)); } catch (e) { /* ignorar */ }
  };

  MS.reset = function () {
    Object.keys(MS.mem.timers).forEach(function (k) { clearTimeout(MS.mem.timers[k]); });
    MS.mem.timers = {};
    MS.mem.password = null;
    MS.S = fresh();
    MS.save();
  };

  MS.id = function (p) { MS.S.seq += 1; return (p || 'x') + MS.S.seq; };

  /* ---------- Eventos ---------- */
  var listeners = [];
  MS.on = function (fn) { listeners.push(fn); };
  MS.emit = function () { MS.save(); listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); };

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
    var now = new Date();
    var d = new Date(ts);
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return 'hace un momento';
    if (d.toDateString() === now.toDateString()) return 'hoy, ' + MS.time(ts);
    return MS.date(ts) + ', ' + MS.time(ts);
  };

  /* ---------- Plan Trial (fechas ficticias, 30 días según DEC-0018) ---------- */
  MS.trialEnd = function () { return MS.S.trialStart + 30 * 24 * 3600 * 1000; };
  MS.trialText = function () {
    var end = MS.date(MS.trialEnd());
    if (MS.S.trial === 'expired') return 'Tu prueba gratis terminó el ' + end + '.';
    if (MS.S.trial === 'ending') return 'Tu prueba gratis vence en 3 días, el ' + end + '.';
    return 'Tu prueba gratis vence el ' + end + '.';
  };

  /* ---------- Personas y permisos ---------- */
  MS.me = function () { return MS.DATA.people[MS.S.role]; };
  MS.can = function (what) {
    var r = MS.S.role;
    var table = {
      request: r !== 'read_only',
      confirm: r !== 'read_only',
      approve: r === 'administration',
      editData: r === 'administration'
    };
    return !!table[what];
  };
  MS.expired = function () { return MS.S.trial === 'expired'; };

  /* ---------- Datos del sitio y cambios ---------- */
  MS.siteBase = function () { return MS.S.site.published || MS.S.biz; };

  MS.applyChanges = function (data, changes) {
    var d = clone(data);
    (changes || []).forEach(function (c) {
      if (c.field.indexOf('hours.') === 0) d.hours[c.field.slice(6)] = c.after;
      else if (c.field === 'services.add') { if (d.services.indexOf(c.after) < 0) d.services.push(c.after); }
      else if (c.field === 'services.remove') { d.services = d.services.filter(function (s) { return s !== c.before; }); }
      else if (c.field === 'page') { d = clone(c.data); }
      else d[c.field] = c.after;
    });
    return d;
  };

  MS.fieldValue = function (data, field) {
    if (field.indexOf('hours.') === 0) return data.hours[field.slice(6)];
    return data[field];
  };

  /* ---------- Solicitudes ---------- */
  MS.STATUS = {
    awaiting_confirm: { label: 'Espera tu confirmación', tone: 'rosa' },
    preparing: { label: 'Preparando vista previa', tone: 'ocre' },
    preview_ready: { label: 'Lista para revisar', tone: 'rosa' },
    approved: { label: 'Aprobado, publicando', tone: 'ocre' },
    published: { label: 'Publicado', tone: 'nopal' },
    rejected: { label: 'Descartado', tone: 'neutral' },
    expired: { label: 'Vista previa vencida', tone: 'neutral' },
    cancelled: { label: 'Corregido', tone: 'neutral' }
  };
  MS.req = function (id) { return MS.S.requests.filter(function (r) { return r.id === id; })[0] || null; };
  MS.pendingRequests = function () {
    return MS.S.requests.filter(function (r) { return r.status === 'preview_ready' || r.status === 'awaiting_confirm' || r.status === 'preparing' || r.status === 'expired'; });
  };
  MS.waitingApproval = function () { return MS.S.requests.filter(function (r) { return r.status === 'preview_ready'; }); };

  /* El texto puede llevar «[tú|otra persona]» para leerse bien según quién mire el historial. */
  MS.evText = function (e) {
    var mine = e.who === MS.me().name;
    return String(e.text).replace(/\[([^|\]]+)\|([^\]]+)\]/g, function (_, a, b) { return mine ? a : b; });
  };
  MS.addEvent = function (req, text, who) {
    req.events = req.events || [];
    req.events.push({ at: Date.now(), text: text, who: who || '' });
  };

  /* ---------- Avisos ---------- */
  MS.notify = function (kind, title, body, route) {
    MS.S.notices.unshift({ id: MS.id('n'), kind: kind, title: title, body: body, route: route || '', at: Date.now(), read: false });
  };
  MS.unread = function () { return MS.S.notices.filter(function (n) { return !n.read; }).length; };

  /* ---------- Recorrido sugerido (herramienta de demo) ---------- */
  MS.tourDone = function (k) { if (!MS.S.tour[k]) { MS.S.tour[k] = Date.now(); } };
})();
