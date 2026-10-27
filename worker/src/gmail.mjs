// src/gmail.mjs — Gmail API 客户端（两个账号：personal / work）
// 2026-10-22
// 走 Google 官方 REST API（gmail.googleapis.com），OAuth refresh token 换 access token。
// 工具面与云虚拟机上 mcparmory-google-gmail 1.0.4 的 63 个工具同名同参（drop-in 替换）。

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

// ---------- OAuth：refresh token 换 access token（带缓存） ----------
async function sha256fp(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function getAccessToken(env, account) {
  const refreshToken = env[`${account}_refresh_token`];
  // 缓存 key 带 refresh_token 指纹——换 token 自动作废各 colo 的旧 access_token
  const fp = refreshToken ? await sha256fp(refreshToken) : 'none';
  const key = new Request(`https://gmail-token.internal/${account}/${fp}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.text();

  const clientId = env[`${account}_client_id`];
  const clientSecret = env[`${account}_client_secret`];
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`Gmail ${account} 凭据不全（缺 CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN）`);
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Gmail OAuth 失败：${JSON.stringify(data).slice(0, 200)}`);
  // 缓存 50 分钟（token 有效 60 分钟）
  await cache.put(key, new Response(data.access_token, { headers: { 'cache-control': 'public, max-age=3000' } }));
  return data.access_token;
}

// ---------- REST 调用 ----------
export async function gmailApi(env, account, method, path, { query, body, headers } = {}) {
  const token = await getAccessToken(env, account);
  const url = new URL(GMAIL_API + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(headers || {}),
    },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || text.slice(0, 200);
    throw new Error(`Gmail API ${res.status}：${msg}`);
  }
  return json ?? text;
}

// ---------- 工具映射表 ----------
// method + path + query/body 字段映射
// path 中 {xxx} 由 args[xxx] 替换；query 字段取自 args；body 字段取自 args
const M = {
  // ── 邮件核心 ──
  list_messages:            { method: 'GET',  path: '/users/{userId}/messages',            build: 'listq' },
  get_message:              { method: 'GET',  path: '/users/{userId}/messages/{id}',       query: ['format', 'metadataHeaders'] },
  get_message_attachment:   { method: 'GET',  path: '/users/{userId}/messages/{id}/attachments/{attachmentId}' },
  import_message:           { method: 'POST', path: '/users/{userId}/messages/import',     build: 'mime' },
  insert_message:           { method: 'POST', path: '/users/{userId}/messages/insert',     build: 'mime' },
  // 红线（2026-10-22 徐总）：删除只进垃圾箱，不永久删
  delete_message:           { method: 'POST', path: '/users/{userId}/messages/{id}/trash' },
  delete_messages_batch:    { build: 'batchtrash' },  // 红线：批量软删，不永久
  move_message_to_trash:    { method: 'POST', path: '/users/{userId}/messages/{id}/trash' },
  remove_message_from_trash:{ method: 'POST', path: '/users/{userId}/messages/{id}/untrash' },
  update_message_labels:    { method: 'POST', path: '/users/{userId}/messages/{id}/modify', body: ['addLabelIds', 'removeLabelIds'] },
  update_message_labels_batch: { method: 'POST', path: '/users/{userId}/messages/batchModify', body: ['ids', 'addLabelIds', 'removeLabelIds'] },

  send_message:             { method: 'POST', path: '/users/{userId}/messages/send',       build: 'mime' },

  list_threads:             { method: 'GET',  path: '/users/{userId}/threads',             query: ['maxResults', 'pageToken', 'q', 'labelIds', 'includeSpamTrash'] },
  get_thread:               { method: 'GET',  path: '/users/{userId}/threads/{id}',        query: ['format'] },
  // 红线：删除只进垃圾箱
  delete_thread:            { method: 'POST', path: '/users/{userId}/threads/{id}/trash' },
  move_thread_to_trash:     { method: 'POST', path: '/users/{userId}/threads/{id}/trash' },
  remove_thread_from_trash: { method: 'POST', path: '/users/{userId}/threads/{id}/untrash' },
  update_thread_labels:     { method: 'POST', path: '/users/{userId}/threads/{id}/modify', body: ['addLabelIds', 'removeLabelIds'] },

  list_drafts:              { method: 'GET',  path: '/users/{userId}/drafts',              query: ['maxResults', 'pageToken', 'q', 'includeSpamTrash'] },
  get_draft:                { method: 'GET',  path: '/users/{userId}/drafts/{id}',         query: ['format'] },
  create_draft:             { method: 'POST', path: '/users/{userId}/drafts',              build: 'draft' },
  update_draft:             { method: 'PUT',  path: '/users/{userId}/drafts/{id}',         build: 'draft' },
  delete_draft:             { method: 'DELETE', path: '/users/{userId}/drafts/{id}' },
  send_draft:               { method: 'POST', path: '/users/{userId}/drafts/send',         build: 'senddraft' },

  // ── 标签 ──
  list_labels:              { method: 'GET',  path: '/users/{userId}/labels' },
  get_label:                { method: 'GET',  path: '/users/{userId}/labels/{id}' },
  create_label:             { method: 'POST', path: '/users/{userId}/labels',              body: ['name', 'labelListVisibility', 'messageListVisibility'] },
  update_label:             { method: 'PUT',  path: '/users/{userId}/labels/{id}',         body: ['name', 'labelListVisibility', 'messageListVisibility'] },
  update_label_partial:     { method: 'PATCH', path: '/users/{userId}/labels/{id}',        body: ['name', 'labelListVisibility', 'messageListVisibility'] },
  delete_label:             { method: 'DELETE', path: '/users/{userId}/labels/{id}' },

  // ── 用户设置 ──
  get_profile:              { method: 'GET',  path: '/users/{userId}/profile' },
  get_vacation_settings:    { method: 'GET',  path: '/users/{userId}/settings/vacation' },
  get_auto_forwarding:      { method: 'GET',  path: '/users/{userId}/settings/autoForwarding' },
  list_mailbox_history:     { method: 'GET',  path: '/users/{userId}/history',             query: ['startHistoryId', 'maxResults', 'pageToken', 'historyTypes'] },

  list_delegates:           { method: 'GET',  path: '/users/{userId}/settings/delegates' },
  get_delegate:             { method: 'GET',  path: '/users/{userId}/settings/delegates/{delegateEmail}' },

  list_send_as_aliases:     { method: 'GET',  path: '/users/{userId}/settings/sendAs' },
  get_send_as_alias:        { method: 'GET',  path: '/users/{userId}/settings/sendAs/{sendAsEmail}' },
  update_send_as_alias:     { method: 'PUT',  path: '/users/{userId}/settings/sendAs/{sendAsEmail}', body: ['sendAsEmail', 'displayName', 'replyToAddress', 'signature', 'isDefault', 'treatAsAlias', 'smtpMsa'] },
  update_send_as_alias_partial: { method: 'PATCH', path: '/users/{userId}/settings/sendAs/{sendAsEmail}', body: ['sendAsEmail', 'displayName', 'replyToAddress', 'signature', 'isDefault', 'treatAsAlias', 'smtpMsa'] },
  send_verification_email_to_send_as_alias: { method: 'POST', path: '/users/{userId}/settings/sendAs/{sendAsEmail}/verify' },

  list_forwarding_addresses: { method: 'GET',  path: '/users/{userId}/settings/forwardingAddresses' },
  get_forwarding_address:    { method: 'GET',  path: '/users/{userId}/settings/forwardingAddresses/{forwardingEmail}' },
  delete_forwarding_address: { method: 'DELETE', path: '/users/{userId}/settings/forwardingAddresses/{forwardingEmail}' },

  list_filters:              { method: 'GET',  path: '/users/{userId}/settings/filters' },
  get_filter:                { method: 'GET',  path: '/users/{userId}/settings/filters/{id}' },
  delete_filter:             { method: 'DELETE', path: '/users/{userId}/settings/filters/{id}' },

  // ── S/MIME ──
  list_smime_configs:        { method: 'GET',  path: '/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo' },
  get_smime_info:            { method: 'GET',  path: '/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo/{id}' },
  create_smime_config:       { method: 'POST', path: '/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo', body: ['id', 'isDefault', 'expiration', 'clientEncryptedCert', 'clientSigningCert', 'pkcs12'] },
  set_default_smime_config:  { method: 'POST', path: '/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo/{id}/setDefault' },
  delete_send_as_smime_config: { method: 'DELETE', path: '/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo/{id}' },

  // ── CSE（客户端加密）──
  list_cse_identities:       { method: 'GET',  path: '/users/{userId}/settings/cse/identities' },
  get_cse_identity:          { method: 'GET',  path: '/users/{userId}/settings/cse/identities/{cseEmailAddress}' },
  create_cse_identity:       { method: 'POST', path: '/users/{userId}/settings/cse/identities', body: ['emailAddress', 'primaryKeyId', 'signingKeyPairId', 'encryptedKeyPair'] },
  update_cse_identity_keypair:{ method: 'PUT', path: '/users/{userId}/settings/cse/identities/{cseEmailAddress}', body: ['signingKeyPairId', 'encryptedKeyPair'] },
  delete_cse_identity:       { method: 'DELETE', path: '/users/{userId}/settings/cse/identities/{cseEmailAddress}' },

  list_cse_keypairs:         { method: 'GET',  path: '/users/{userId}/settings/cse/keypairs' },
  get_cse_keypair:           { method: 'GET',  path: '/users/{userId}/settings/cse/keypairs/{keyPairId}' },
  create_cse_keypair:        { method: 'POST', path: '/users/{userId}/settings/cse/keypairs', body: ['keyPair'] },
  enable_cse_keypair:        { method: 'POST', path: '/users/{userId}/settings/cse/keypairs/{keyPairId}/enable' },
  disable_cse_keypair:       { method: 'POST', path: '/users/{userId}/settings/cse/keypairs/{keyPairId}/disable' },
  delete_cse_keypair_permanently: { method: 'DELETE', path: '/users/{userId}/settings/cse/keypairs/{keyPairId}' },
};

// ---------- 构造 helper ----------
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildMime(a) {
  const headers = [];
  if (a.email_from) headers.push(`From: ${a.email_from}`);
  if (a.email_to) headers.push(`To: ${a.email_to}`);
  if (a.email_cc) headers.push(`Cc: ${a.email_cc}`);
  if (a.email_bcc) headers.push(`Bcc: ${a.email_bcc}`);
  if (a.email_subject) headers.push(`Subject: ${a.email_subject}`);
  if (a.email_reply_to) headers.push(`Reply-To: ${a.email_reply_to}`);
  if (a.email_in_reply_to) headers.push(`In-Reply-To: ${a.email_in_reply_to}`);
  if (a.email_references) headers.push(`References: ${a.email_references}`);
  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: text/${a.email_body_is_html ? 'html' : 'plain'}; charset=utf-8`);
  const raw = [...headers, '', a.email_body || ''].join('\r\n');
  return b64u(new TextEncoder().encode(raw));
}
function buildListQ(a) {
  const parts = [];
  if (a.from_address) parts.push(`from:${a.from_address}`);
  if (a.to_address) parts.push(`to:${a.to_address}`);
  if (a.subject_contains) parts.push(`subject:${a.subject_contains}`);
  if (a.has_attachment === true) parts.push('has:attachment');
  if (a.is_unread === true) parts.push('is:unread');
  if (a.is_starred === true) parts.push('is:starred');
  if (a.before_date) parts.push(`before:${a.before_date}`);
  if (a.after_date) parts.push(`after:${a.after_date}`);
  if (a.custom_query) parts.push(a.custom_query);
  return parts.join(' ');
}

// ---------- 调度 ----------
export function hasTool(name) { return !!M[name]; }
export function listMappedTools() { return Object.keys(M); }

export async function callGmailTool(env, account, name, args = {}) {
  const spec = M[name];
  if (!spec) throw new Error(`未知 Gmail 工具：${name}`);
  // 红线：批量删除 → 逐个进垃圾箱（Gmail 无 batchTrash）
  if (name === 'delete_messages_batch') {
    const ids = args.ids || [];
    const out = [];
    for (const id of ids) {
      try {
        await gmailApi(env, account, 'POST', `/users/me/messages/${encodeURIComponent(id)}/trash`);
        out.push({ id, ok: true, action: 'trashed' });
      } catch (e) { out.push({ id, ok: false, err: String(e.message || e).slice(0, 120) }); }
    }
    return { ok: true, action: 'trash (软删)', count: out.length, results: out };
  }

  // userId 默认 me
  const a = { userId: 'me', ...args };

  // 路径参数替换
  let path = spec.path.replace(/\{(\w+)\}/g, (_, k) => {
    const v = a[k];
    if (v === undefined || v === null || v === '') throw new Error(`工具 ${name} 缺少参数 ${k}`);
    return encodeURIComponent(String(v));
  });

  const query = {};
  if (spec.query) for (const k of spec.query) if (a[k] !== undefined) query[k] = Array.isArray(a[k]) ? a[k].join(',') : a[k];

  let body;
  if (spec.build === 'mime') {
    body = { raw: buildMime(a) };
    if (a.labelIds) body.labelIds = a.labelIds;
    if (a.threadId) body.threadId = a.threadId;
  } else if (spec.build === 'draft') {
    body = { message: { raw: buildMime(a) } };
    if (a.labelIds) body.message.labelIds = a.labelIds;
  } else if (spec.build === 'senddraft') {
    if (!a.id) throw new Error('send_draft 需要 id（要发送的草稿 id）');
    path = `/users/${a.userId || 'me'}/drafts/send`;
    body = { id: a.id };
  } else if (spec.build === 'listq') {
    const q = buildListQ(a);
    if (q) query.q = q;
    if (a.maxResults) query.maxResults = a.maxResults;
    if (a.includeSpamTrash !== undefined) query.includeSpamTrash = a.includeSpamTrash;
    if (a.labelIds) query.labelIds = Array.isArray(a.labelIds) ? a.labelIds.join(',') : a.labelIds;
    if (a.pageToken) query.pageToken = a.pageToken;
  } else if (spec.body) {
    body = {};
    for (const k of spec.body) if (a[k] !== undefined) body[k] = a[k];
    if (!Object.keys(body).length) body = undefined;
    if (spec.method === 'GET' || spec.method === 'DELETE') body = undefined;
  }

  return gmailApi(env, account, spec.method, path, { query, body });
}
