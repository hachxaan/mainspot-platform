/* =====================================================================
   MainSpot · Simulador de proveedores (SOLO desarrollo, DEV-E2E-03)
   Sustituye la «herramienta de demostración» del prototipo: en lugar de
   fingir llegadas en el navegador, inyecta reseñas/comentarios ficticios en
   el simulador del backend (/dev/simulator/*, 404 en producción). El worker
   del servidor los recoge en su ciclo, aunque cierres el navegador.
   Nada de esto llama a Google, Meta ni Telegram.
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var API = MS.api;
  var esc = MS.esc;
  var S = function () { return MS.S; };

  var ARRIVALS = {
    g_thanks: { origin: 'google', label: 'Reseña de 5★', body: { rating: 5, body: '¡Excelente atención, muchas gracias!', author_label: 'María G.' } },
    g_complaint: { origin: 'google', label: 'Reseña de 2★ con queja', body: { rating: 2, body: 'Mi pedido llegó mal y nadie me atendió.', author_label: 'Ricardo M.' } },
    g_risk: { origin: 'google', label: 'Reseña: pide reembolso', body: { rating: 1, body: 'Me enfermé después de comer, exijo reembolso.', author_label: 'Beto S.' } },
    f_thanks: { origin: 'facebook', label: 'Comentario «¡Gracias!»', body: { body: '¡Gracias, todo delicioso!', author_label: 'Jorge L.' } },
    f_question: { origin: 'facebook', label: 'Pregunta: ¿su teléfono?', body: { body: '¿Cuál es su teléfono para pedidos?', author_label: 'Ana P.' } },
    f_risk: { origin: 'facebook', label: 'Comentario: amenaza con denunciar', body: { body: 'Voy a denunciarlos, me cobraron de más.', author_label: 'Dani R.' } }
  };

  var DEV = (MS.devsim = { ARRIVALS: ARRIVALS });

  DEV.available = function () { return S().dev.simulator && MS.can('engagement.policy.manage'); };

  DEV.lastPublishedPost = function () {
    return S().posts.filter(function (p) { return p.status === 'published'; }).sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); })[0] || null;
  };

  /** Bloque dentro de Atención, claramente marcado como simulación de desarrollo. */
  DEV.block = function () {
    if (!DEV.available()) return '';
    var b = function (k) { return '<button type="button" class="dp-inline" data-action="arrive" data-arg="' + k + '">' + esc(ARRIVALS[k].label) + '</button>'; };
    var post = DEV.lastPublishedPost();
    return '<section class="demo-inline" aria-label="Simulador de desarrollo">' +
      '<p><strong>Simulador de desarrollo:</strong> llega algo nuevo a Google o Facebook (ficticio). El agente del servidor lo atiende en su próximo ciclo, aunque cierres esta pantalla.</p>' +
      '<div class="row-wrap">' + b('g_thanks') + b('g_complaint') + b('g_risk') + '</div>' +
      '<div class="row-wrap" style="margin-top:8px">' + (post ? b('f_thanks') + b('f_question') + b('f_risk') : '<span class="tiny">Para comentarios de Facebook publica primero algo en Facebook.</span>') + '</div>' +
      '<div class="row-wrap" style="margin-top:8px"><button type="button" class="dp-inline" data-action="sim-fault" data-arg="google_review">Google falla 3 veces</button>' +
      '<button type="button" class="dp-inline" data-action="sim-run">Procesar ahora</button></div>' +
      '</section>';
  };

  DEV.arrive = function (key) {
    var a = ARRIVALS[key];
    if (!a) return Promise.resolve({ ok: false });
    var body = MS.clone(a.body);
    var path = '/dev/simulator/google-reviews';
    if (a.origin === 'facebook') {
      var post = DEV.lastPublishedPost();
      if (!post) return Promise.resolve({ ok: false, message: 'Publica primero algo en Facebook.' });
      body.post_id = post.id;
      path = '/dev/simulator/facebook-comments';
    }
    return API.post(path, body).then(function (res) {
      MS.mem.fastPoll = Date.now() + 30000;
      return res.ok ? { ok: true } : { ok: false, message: res.error.message };
    });
  };

  DEV.fault = function (origin) {
    return API.post('/dev/simulator/faults', { origin: origin, kind: 'error', count: 3 }).then(function (res) {
      return res.ok ? { ok: true } : { ok: false, message: res.error.message };
    });
  };

  /** Un ciclo del worker solo para tu negocio (el worker también corre solo cada pocos segundos). */
  DEV.run = function () {
    return API.post('/engagement/run').then(function (res) {
      return MS.refresh(['cases', 'tgChat'], true).then(function () {
        return res.ok ? { ok: true, report: res.data.report } : { ok: false, message: res.error.message };
      });
    });
  };
})();
