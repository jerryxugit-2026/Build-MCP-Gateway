// src/index.mjs — iCloud MCP Worker：路由 + OAuth 授权服务器
// 2026-10-22
// 认证模型：MCP 客户端（Grok）走 OAuth 2.0 授权码 + PKCE S256（公开客户端，无 secret）
// 授权页 /authorize 用 APPROVE_SECRET 保护，避免 URL 泄露后被第三方盗授权。

import { mintToken, verifyToken, sha256b64u, b64uDecode, b64uEncode } from './crypto.mjs';

const VERSION = '0.1.0';

// ---------- 基础响应 ----------
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { 'content-type': 'application/json', ...headers } });

function oauthDiscovery(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp', 'mcp:tools'],
    service_documentation: `${baseUrl}/`,
  };
}

// ---------- 路由 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const base = url.origin;

    // OAuth 发现
    if (url.pathname === '/.well-known/oauth-protected-resource')
      return json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server'
      || url.pathname === '/.well-known/openid-configuration')
      return json(oauthDiscovery(base));

    // 动态客户端注册（MCP 规范可选；Grok 手填 Client ID 时也兼容）
    if (url.pathname === '/register' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return json({
        client_id: env.OAUTH_CLIENT_ID,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }, 201);
    }

    // 授权页
    if (url.pathname === '/authorize')
      return handleAuthorize(request, env, url);

    // 令牌
    if (url.pathname === '/token')
      return handleToken(request, env, url);

    // MCP
    if (url.pathname === '/ima/mcp')
      return handleMcp(request, env, base, 'ima');
    // HUD 直推(2026-10-25):POST /hud/push,JSON {app,title,subtitle,body}[或 JSONL];
    // 鉴权同 MCP(STATIC_TOKEN/OAuth);经 MAC_BRIDGE 转投 .1 的 /s/<SECRET>/hud-push
    if (url.pathname === '/hud/push')
      return handleHudPush(request, env);
    if (url.pathname === '/mcp' || url.pathname === '/')
      return handleMcp(request, env, base, 'icloud');
    if (url.pathname === '/notes/mcp' || url.pathname === '/reminders/mcp')
      return handleMacProxy(request, env, url.pathname.includes('notes') ? 'notes' : 'reminders');
    if (url.pathname === '/gmail-personal/mcp')
      return handleMcp(request, env, base, 'gmail-personal');
    if (url.pathname === '/gcal-personal/mcp')
      return handleMcp(request, env, base, 'gcal-personal');
    if (url.pathname === '/gcal-work/mcp')
      return handleMcp(request, env, base, 'gcal-work');
    if (url.pathname === '/drive-personal/mcp')
      return handleMcp(request, env, base, 'drive-personal');
    if (url.pathname === '/drive-work/mcp')
      return handleMcp(request, env, base, 'drive-work');
    if (url.pathname === '/outlook/mcp')
      return handleMcp(request, env, base, 'outlook');
    if (url.pathname === '/gemini/mcp')
      return handleMcp(request, env, base, 'gemini');
    if (url.pathname === '/gmail-work/mcp')
      return handleMcp(request, env, base, 'gmail-work');

                            if (url.pathname === '/healthz')
      return json({ ok: true, version: VERSION });

    return json({ error: 'not_found' }, 404);
  },
};

// ---------- /authorize ----------
// ---------- Mac 代理（Notes / Reminders）----------
// Grok 走 OAuth 进 Worker；Worker 用密径把请求转给 Mac 的 Funnel（supergateway 说 2025-11-25 旧协议）
// HUD 直推(2026-10-25):收 JSON/JSONL,补 uuid/at,经 MAC_BRIDGE 转投 .1 hud-push。
// 字段约定:{app(来源标识,如 muse/grokbot), title, subtitle?, body} — worker 端自动补
// uuid(未带时生成)与 at(Unix 秒)。
async function handleHudPush(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let ok = false;
  if (env.STATIC_TOKEN && token === env.STATIC_TOKEN) ok = true;
  if (!ok && token) {
    const payload = await verifyToken(env.TOKEN_KEY, token);
    ok = !!(payload && payload.t === 'access');
  }
  if (!ok) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });

  let raw = await request.text();
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const now = Math.floor(Date.now() / 1000);
    // HUD 显示层按 id 过滤(notif-mirror 的 rec_id 同款),缺 id 的条目不显示——必须补
    const baseId = Math.floor(now * 1000);
    const lines = items.map((it, i) => JSON.stringify({
      id: it.id || baseId + i,
      uuid: it.uuid || `hudpush-${now}-${Math.random().toString(36).slice(2, 10)}${i || ''}`,
      app: it.app || 'agent',
      title: it.title || '',
      subtitle: it.subtitle || '',
      body: it.body || '',
      at: it.at || now,
    }));
    raw = lines.join('\n');
  } catch {
    // 非 JSON 视为 JSONL 原样转发(与 notif-mirror 语义一致)
  }

  const base = (env.MAC_BRIDGE_URL || 'https://YOUR-MAC.YOUR-TAILNET.ts.net/bridge' /* MOCK: set MAC_BRIDGE_URL */).replace(/\/$/, '');
  const secret = env.MAC_BRIDGE_SECRET;
  if (!secret) return json({ ok: false, error: 'MAC_BRIDGE_SECRET not set' }, 500);
  const upstream = await fetch(`${base}/s/${secret}/hud-push`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: raw + '\n',
  });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { 'content-type': 'application/json' } });
}

async function handleMacProxy(request, env, service) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let ok = false;
  if (env.STATIC_TOKEN && token === env.STATIC_TOKEN) ok = true;
  if (!ok && token) {
    const payload = await verifyToken(env.TOKEN_KEY, token);
    ok = !!(payload && payload.t === 'access');
  }
  if (!ok) {
    return new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource"`,
        'cache-control': 'no-store',
      },
    });
  }
  const base = env.MAC_BRIDGE_URL || 'https://YOUR-MAC.YOUR-TAILNET.ts.net/bridge' /* MOCK: set MAC_BRIDGE_URL */;
  const secret = env.MAC_BRIDGE_SECRET;
  const target = `${base.replace(/\/$/, '')}/s/${secret}/${service}/mcp`;
  const body = await request.text();
  // P1-2：读类 tools/call 先查本 isolate 的 TTL 缓存（判定规则见 mcp.mjs isCacheableRead）
  let rpc = null;
  try { rpc = JSON.parse(body); } catch { /* 非 JSON 原样透传 */ }
  const slot = proxyCacheLookup(env, service, rpc);
  if (slot && slot.hit) {
    return new Response(slot.hit.text, {
      status: slot.hit.status,
      headers: { 'content-type': slot.hit.contentType, 'cache-control': 'no-store' },
    });
  }
  const upstream = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': request.headers.get('content-type') || 'application/json',
      'accept': request.headers.get('accept') || 'application/json, text/event-stream',
    },
    body,
  });
  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') || 'application/json';
  proxyCacheStore(slot, rpc, upstream.status, contentType, text);
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
  });
}

async function handleAuthorize(request, env, url) {
  const client_id = url.searchParams.get('client_id') || '';
  const redirect_uri = url.searchParams.get('redirect_uri') || '';
  const state = url.searchParams.get('state') || '';
  const challenge = url.searchParams.get('code_challenge') || '';
  const method = url.searchParams.get('code_challenge_method') || 'S256';
  const scope = url.searchParams.get('scope') || 'mcp';

  // 基本校验：redirect_uri 必须是 loopback（Grok/Claude 这类本地回调）或 https
  const ru = redirect_uri ? safeURL(redirect_uri) : null;
  const badRedirect = !ru || !(
    ru.protocol === 'https:' ||
    (ru.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(ru.hostname))
  );

  if (request.method === 'GET') {
    return new Response(authPage({ client_id, redirect_uri, state, challenge, method, scope, badRedirect }), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    // POST 时参数在表单体里（不在 query），必须从 form 取
    const F = (k) => (form ? String(form.get(k) || '') : (url.searchParams.get(k) || ''));
    const client_id2 = F('client_id');
    const redirect_uri2 = F('redirect_uri');
    const state2 = F('state');
    const challenge2 = F('code_challenge');
    const method2 = F('code_challenge_method') || 'S256';
    const scope2 = F('scope') || 'mcp';
    const pass = F('pass');
    const approve = form ? form.get('approve') : null;
    const ru2 = redirect_uri2 ? safeURL(redirect_uri2) : null;
    const badRedirect2 = !ru2 || !(
      ru2.protocol === 'https:' ||
      (ru2.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(ru2.hostname))
    );
    if (badRedirect2) return new Response(errPage('redirect_uri 无效'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (!approve) return redirectWith(redirect_uri2, { error: 'access_denied', state: state2 });
    if (pass !== env.APPROVE_SECRET) {
      return new Response(authPage({ client_id: client_id2, redirect_uri: redirect_uri2, state: state2, challenge: challenge2, method: method2, scope: scope2, badRedirect: badRedirect2, failed: true }), {
        status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (!challenge2 || method2 !== 'S256')
      return redirectWith(redirect_uri2, { error: 'invalid_request', error_description: '仅支持 PKCE S256', state: state2 });

    const now = Math.floor(Date.now() / 1000);
    const code = await mintToken(env.TOKEN_KEY, {
      t: 'code', client_id: client_id2, redirect_uri: redirect_uri2, code_challenge: challenge2, scope: scope2,
      iat: now, exp: now + Number(env.AUTHCODE_TTL_SECONDS || 600),
    });
    return redirectWith(redirect_uri2, { code, state: state2 });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

function safeURL(u) { try { return new URL(u); } catch { return null; } }
function redirectWith(redirect_uri, params) {
  const u = new URL(redirect_uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
}

// ---------- /token ----------
async function handleToken(request, env, url) {
  const ct = request.headers.get('content-type') || '';
  let params = {};
  if (ct.includes('application/x-www-form-urlencoded')) {
    params = Object.fromEntries((await request.text()).split('&').filter(Boolean).map(p => {
      const [k, v] = p.split('='); return [decodeURIComponent(k), decodeURIComponent(v || '')];
    }));
  } else {
    params = await request.json().catch(() => ({}));
  }

  const grant = params.grant_type;
  const now = Math.floor(Date.now() / 1000);

  if (grant === 'authorization_code') {
    const payload = await verifyToken(env.TOKEN_KEY, params.code);
    if (!payload || payload.t !== 'code')
      return tokenError('invalid_grant', '授权码无效或已过期');
    if (payload.redirect_uri !== params.redirect_uri)
      return tokenError('invalid_grant', 'redirect_uri 不匹配');
    if (payload.client_id !== (params.client_id || env.OAUTH_CLIENT_ID))
      return tokenError('invalid_grant', 'client_id 不匹配');
    // PKCE S256
    const computed = await sha256b64u(params.code_verifier || '');
    if (computed !== payload.code_challenge)
      return tokenError('invalid_grant', 'PKCE 校验失败');

    return tokenSuccess(env, payload, now);
  }

  if (grant === 'refresh_token') {
    const payload = await verifyToken(env.TOKEN_KEY, params.refresh_token);
    if (!payload || payload.t !== 'refresh')
      return tokenError('invalid_grant', 'refresh_token 无效');
    return tokenSuccess(env, { ...payload }, now);
  }

  return tokenError('unsupported_grant_type', '仅支持 authorization_code / refresh_token');
}

async function tokenSuccess(env, payload, now) {
  const ttl = Number(env.TOKEN_TTL_SECONDS || 86400);
  return json({
    access_token: await mintToken(env.TOKEN_KEY, {
      t: 'access', sub: payload.sub || 'user', scope: payload.scope || 'mcp',
      iat: now, exp: now + ttl,
    }),
    token_type: 'Bearer',
    expires_in: ttl,
    refresh_token: await mintToken(env.TOKEN_KEY, {
      t: 'refresh', sub: payload.sub || 'user', scope: payload.scope || 'mcp',
      iat: now, exp: now + 30 * 86400,
    }),
    scope: payload.scope || 'mcp',
  }, 200, { 'cache-control': 'no-store' });
}
function tokenError(error, description) {
  return json({ error, error_description: description }, 400, { 'cache-control': 'no-store' });
}

// ---------- 授权页 HTML ----------
function authPage(d) {
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iCloud MCP · 授权</title>
<style>
 body{font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#1a1a1a}
 h1{font-size:20px} .card{border:1px solid #e2e2e2;border-radius:10px;padding:18px 20px;margin:18px 0}
 code{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
 input[type=password]{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:15px;box-sizing:border-box}
 button{width:100%;padding:12px;border:0;border-radius:8px;font-size:16px;cursor:pointer;margin-top:12px}
 .ok{background:#1a7f37;color:#fff}.no{background:#d93025;color:#fff}
 .warn{background:#fff4e5;border-color:#f0c36d}.err{background:#fdecea;border-color:#e57373}
 .muted{color:#666;font-size:13px}
</style>
<h1>🔐 iCloud MCP · 授权</h1>
${d.failed ? '<div class="card err">❌ 口令错误，请重试。</div>' : ''}
${d.badRedirect ? '<div class="card err">❌ <code>redirect_uri</code> 不合法（必须是 https 或 localhost 回调）。</div>' : ''}
<div class="card">
  <div class="muted">请求方</div>
  <code>${esc(d.client_id)}</code>
  <div class="muted" style="margin-top:10px">回调地址</div>
  <code>${esc(d.redirect_uri)}</code>
  <div class="muted" style="margin-top:10px">范围 · <code>${esc(d.scope)}</code> · PKCE <code>${esc(d.method)}</code></div>
</div>
<form method="POST">
  <input type="hidden" name="client_id" value="${esc(d.client_id)}">
  <input type="hidden" name="redirect_uri" value="${esc(d.redirect_uri)}">
  <input type="hidden" name="state" value="${esc(d.state)}">
  <input type="hidden" name="code_challenge" value="${esc(d.challenge)}">
  <input type="hidden" name="code_challenge_method" value="${esc(d.method)}">
  <input type="hidden" name="scope" value="${esc(d.scope)}">
  <div class="card">
    <div class="muted">授权口令（在你的密钥库中）</div>
    <input type="password" name="pass" autocomplete="current-password" required>
  </div>
  <button class="ok" name="approve" value="1">✅ 批准授权</button>
  <button class="no" name="approve" value="">❌ 拒绝</button>
</form>
<p class="muted">批准后将把授权码回传给上面的回调地址，之后该客户端可读写你的 iCloud 日历（视工具而定）。</p>`;
}
function errPage(msg) {
  return `<!doctype html><meta charset="utf-8"><title>错误</title><body style="font-family:system-ui;max-width:520px;margin:60px auto"><h2>❌ 出错</h2><p>${msg}</p></body>`;
}

// ---------- /mcp ----------
// 在 mcp.mjs 里实现（含双协议），此处导入
import { handleMcp, proxyCacheLookup, proxyCacheStore } from './mcp.mjs';

