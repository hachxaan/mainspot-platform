// API client: same-origin fetch with CSRF token; uniform error envelope.
let csrfToken = null;

async function request(method, path, body, extraHeaders = {}, { retried = false } = {}) {
  const options = { method, headers: { ...extraHeaders } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  if (method !== "GET" && csrfToken) options.headers["X-HDC-CSRF"] = csrfToken;
  let response;
  try {
    response = await fetch(path, options);
  } catch (_err) {
    const error = new Error("network down");
    error.code = "NETWORK_DOWN";
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload;
  const code = payload?.error?.code || `HTTP_${response.status}`;
  // The token is per service process: after a restart the old one is rejected
  // before anything is written. Fetch the current token and retry once.
  if (code === "CSRF_TOKEN_INVALID" && method !== "GET" && !retried) {
    csrfToken = null;
    await ensureCsrf();
    return request(method, path, body, extraHeaders, { retried: true });
  }
  const error = new Error(payload?.error?.message || response.statusText);
  error.code = code;
  error.status = response.status;
  error.fieldErrors = payload?.error?.field_errors || [];
  error.diagnosticIds = payload?.error?.diagnostic_ids || [];
  throw error;
}

export async function ensureCsrf() {
  if (!csrfToken) {
    const payload = await request("GET", "/api/v1/csrf");
    csrfToken = payload.token;
  }
  return csrfToken;
}

export const get = (path) => request("GET", path);
export const put = (path, body, headers) => request("PUT", path, body, headers);
export const del = (path, headers) => request("DELETE", path, undefined, headers);
export const post = (path, body) => request("POST", path, body);
