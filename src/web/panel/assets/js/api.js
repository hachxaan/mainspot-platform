/* =====================================================================
   MainSpot · Cliente de la API real (DEV-E2E-03)
   - Mismo mecanismo de sesión que el backend: token Bearer en sessionStorage
     (se pierde al cerrar la pestaña; nunca se guardan contraseñas).
   - Toda respuesta se normaliza a { ok, status, data, error:{code,message,fields}, retryAfter };
     la promesa nunca se rechaza, así cada pantalla decide qué mostrar.
   - El backend es la autoridad de permisos: ocultar un botón no sustituye RBAC.
   ===================================================================== */
(function () {
  'use strict';
  var MS = (window.MS = window.MS || {});
  var TOKEN_KEY = 'mainspot.token';
  var API = (MS.api = {});

  API.token = function () {
    try { return window.sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  };
  API.setToken = function (t) {
    try {
      if (t) window.sessionStorage.setItem(TOKEN_KEY, t);
      else window.sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* sin almacenamiento de sesión: el token vive solo en esta carga */ }
  };

  /** Clave de idempotencia por acción del usuario (el servidor no duplica si se reintenta). */
  API.key = function () {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  };

  var GENERIC = {
    0: 'No pudimos conectar con MainSpot. Revisa tu conexión e inténtalo de nuevo.',
    401: 'Tu sesión terminó. Entra de nuevo para continuar.',
    403: 'Tu perfil no permite hacer esto. Pídele ayuda a quien administra tu negocio.',
    404: 'No encontramos lo que buscabas. Puede que ya no exista.',
    409: 'Esto cambió mientras lo revisabas. Revisa el estado actual e inténtalo de nuevo.',
    429: 'Hubo demasiados intentos. Espera un momento y vuelve a intentarlo.',
    500: 'Ocurrió un problema en MainSpot. Inténtalo de nuevo en un momento.'
  };

  /** Se llama cuando el backend rechaza la sesión (401) en una ruta protegida. */
  API.onUnauthorized = null;

  API.request = function (method, path, body, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var token = API.token();
    if (opts.auth !== false && token) headers.Authorization = 'Bearer ' + token;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    return window.fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
          var out = { ok: res.ok, status: res.status, data: data, error: null, retryAfter: null };
          if (!res.ok) {
            var e = (data && data.error) || {};
            var gen = GENERIC[res.status] || (res.status >= 500 ? GENERIC[500] : GENERIC[409]);
            out.error = { code: e.code || 'http_' + res.status, message: e.message || gen, fields: Array.isArray(e.fields) ? e.fields : [] };
            var ra = Number(res.headers.get('Retry-After'));
            if (res.status === 429 && ra > 0) {
              out.retryAfter = ra;
              out.error.message = (e.message || GENERIC[429]) + ' (' + ra + ' s)';
            }
            if (res.status === 401 && opts.auth !== false && typeof API.onUnauthorized === 'function') API.onUnauthorized(out);
          }
          return out;
        });
      }, function () {
        return { ok: false, status: 0, data: null, error: { code: 'network', message: GENERIC[0], fields: [] }, retryAfter: null };
      });
  };

  function bo(p) { return '/api/backoffice' + p; }
  API.get = function (p) { return API.request('GET', bo(p)); };
  API.post = function (p, b, o) { return API.request('POST', bo(p), b === undefined ? {} : b, o); };
  API.put = function (p, b, o) { return API.request('PUT', bo(p), b === undefined ? {} : b, o); };
  API.del = function (p) { return API.request('DELETE', bo(p)); };
  /** Rutas públicas de acceso (/api/auth/*): sin token. */
  API.auth = function (p, b) { return API.request('POST', '/api/auth' + p, b === undefined ? {} : b, { auth: p === '/logout' }); };
})();
