/**
 * One password, stored as the Worker secret APP_PASSWORD. A tool for one person or a small team
 * does not need user accounts; it needs its door locked.
 *
 * The session cookie is "<expiry ms>.<HMAC-SHA256(password, expiry)>": nothing is stored server
 * side, and changing the password invalidates every cookie at once.
 */

export const SESSION_DAYS = 30;

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '');
}

/** Length-safe comparison, so a wrong password takes as long to reject as a nearly right one. */
export function sameText(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function makeSession(password, nowMs = Date.now()) {
  const exp = String(nowMs + SESSION_DAYS * 86400000);
  return exp + '.' + await hmac(password, exp);
}

export async function validSession(password, value, nowMs = Date.now()) {
  const [exp, sig] = String(value || '').split('.');
  if (!exp || !sig || !(Number(exp) > nowMs)) return false;
  return sameText(sig, await hmac(password, exp));
}

export function readCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export function sessionCookie(value, secure) {
  return `fc_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export const CLEAR_COOKIE = 'fc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
