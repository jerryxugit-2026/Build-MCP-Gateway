// src/crypto.mjs — 无状态签名令牌（HMAC-SHA256）
// 格式：base64url(json).base64url(sig)
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64uEncode = (str) => b64u(new TextEncoder().encode(str));
export const b64uDecode = (s) => new TextDecoder().decode(decB64u(s));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
export async function sign(secret, data) {
  const key = await hmacKey(secret);
  return b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
const pad = (s) => s + '='.repeat((4 - (s.length % 4)) % 4);
function decB64u(s) {
  return Uint8Array.from(atob(pad(s.replace(/-/g, '+').replace(/_/g, '/'))), c => c.charCodeAt(0));
}
async function verifySig(secret, data, sig) {
  try {
    const a = await sign(secret, data);
    const x = decB64u(a);
    const y = decB64u(sig);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
  } catch { return false; }
}
export async function mintToken(secret, payload) {
  const body = b64uEncode(JSON.stringify(payload));
  return `${body}.${await sign(secret, body)}`;
}
export async function verifyToken(secret, token) {
  const parts = String(token).split('.');
  const [body, sig] = parts;
  if (!body || !sig) return null;
  if (!(await verifySig(secret, body, sig))) return null;
  try {
    const payload = JSON.parse(b64uDecode(body));
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}
export async function sha256b64u(str) {
  return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}
