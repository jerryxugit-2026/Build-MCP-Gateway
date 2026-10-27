// src/vertex.mjs — Gemini 接地搜索（Vertex AI，service account JWT 认证）
// 2026-10-22
// 走 Google 的 JWT-Self-Signed 流程换 access token。

async function sha256fp(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function saToken(env) {
  const fp = await sha256fp(env.gemini_sa_key);
  const key = new Request('https://gtok.internal/vertex');
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.text();

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.gemini_sa_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const enc = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const pem = env.gemini_sa_key.replace(/\\n/g, '\n');
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const pk = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pk, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Vertex OAuth 失败：${JSON.stringify(data).slice(0, 250)}`);
  await cache.put(key, new Response(data.access_token, { headers: { 'cache-control': 'public, max-age=3000' } }));
  return data.access_token;
}

export async function callGeminiGrounding(env, { query, model, temperature, maxOutputTokens } = {}) {
  const token = await saToken(env);
  const project = env.gemini_project;
  const m = model || 'gemini-2.5-flash';
  const location = env.gemini_location || 'global';
  const url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${m}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vertex ${res.status}：${text.slice(0, 250)}`);
  try { return JSON.parse(text); } catch { return text; }
}
