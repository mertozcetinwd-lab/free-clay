/** Thin fetch wrapper. Every call returns parsed JSON or throws an ApiError with a readable message. */

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function call(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    if (typeof body === 'string') init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  }
  let res;
  try { res = await fetch('/api' + path, init); }
  catch { throw new ApiError(0, 'You look offline. Nothing was saved.'); }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (res.status === 401 && path !== '/login') { onUnauthorized(); throw new ApiError(401, 'Please log in again', data); }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data);
  return data;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b = {}) => call('POST', p, b),
  patch: (p, b) => call('PATCH', p, b),
  put: (p, b) => call('PUT', p, b),
  del: (p, b) => call('DELETE', p, b),
};
