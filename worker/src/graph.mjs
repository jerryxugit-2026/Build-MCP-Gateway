// src/graph.mjs — Microsoft Graph（Outlook）API
// 2026-10-22 v2：按真实工具名/参数重写（login / list_messages / send_mail / …）
// 红线：删除只进垃圾箱（软删）——delete_message 走 move to Deleted Items，除非 bulk 显式 permanent


async function sha256fp(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function graphToken(env) {
  const SCOPE = 'User.Read Mail.ReadWrite Mail.Send MailboxSettings.ReadWrite Calendars.ReadWrite offline_access openid profile';
  // 缓存 key 带 refresh_token 指纹 + scope 指纹——换任一都作废旧缓存
  const fp = (await sha256fp(env.outlook_refresh || '')) + '-' + (await sha256fp(SCOPE)).slice(0, 8);
  const key = new Request(`https://gtok.internal/outlook/${fp}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.text();
  const res = await fetch(`https://login.microsoftonline.com/${env.outlook_tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.outlook_client_id,
      refresh_token: env.outlook_refresh,
      scope: SCOPE,
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Outlook OAuth 失败：${JSON.stringify(data).slice(0, 250)}`);
  await cache.put(key, new Response(data.access_token, { headers: { 'cache-control': 'public, max-age=3000' } }));
  return data.access_token;
}

export async function gcall(env, method, path, { query, body, raw } = {}) {
  const token = await graphToken(env);
  const url = new URL(GRAPH + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const res = await fetch(url.toString(), {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 250);
    try { msg = JSON.parse(text).error.message || msg; } catch {}
    throw new Error(`Graph ${res.status}：${msg}`);
  }
  if (raw) return text;
  if (!text) return { ok: true };
  try { return JSON.parse(text); } catch { return text; }
}

function dateFilter(since, until, from) {
  const parts = [];
  if (since) parts.push(`receivedDateTime ge ${since}`);
  if (until) parts.push(`receivedDateTime le ${until}`);
  if (from) parts.push(`from/emailAddress/address eq '${from}'`);
  return parts.length ? parts.join(' and ') : undefined;
}
function addr(x) {
  return (Array.isArray(x) ? x : String(x).split(',')).map(s => ({ emailAddress: { address: s.trim() } }));
}

const M = {
  // ── 认证类（Worker 用 refresh token，已登录）──
  login:                { stub: () => ({ ok: true, note: 'Worker 部署用 refresh token，已登录' }) },
  auth_status:          { stub: () => ({ authenticated: true, mode: 'refresh-token (Worker 部署)' }) },
  logout:               { stub: () => ({ ok: false, error: 'Worker 部署不支持 logout（refresh token 常驻）' }) },

  // ── 文件夹 ──
  list_folders:         { method: 'GET',  path: '/me/mailFolders', query: [['includeHiddenFolders', 'includeHidden']] },

  // ── 邮件 ──
  list_messages:        { method: 'GET',  path: '/me/messages' },
  search_messages:      { method: 'GET',  path: '/me/messages' },
  get_message:          { method: 'GET',  path: '/me/messages/{id}', query: [['select', '__fixed:id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments,importance,flag,categories']] },
  list_attachments:     { method: 'GET',  path: '/me/messages/{messageId}/attachments' },
  download_attachment:  { method: 'GET',  path: '/me/messages/{messageId}/attachments/{attachmentId}' },

  send_mail:            { method: 'POST',   path: '/me/sendMail', build: 'mail' },
  create_draft:         { method: 'POST',   path: '/me/messages', build: 'draft' },
  reply_message:        { method: 'POST',   path: '/me/messages/{id}/createReply', build: 'reply' },
  forward_message:      { method: 'POST',   path: '/me/messages/{id}/forward', build: 'forward' },
  move_message:         { method: 'POST',   path: '/me/messages/{id}/move', build: 'move' },
  mark_read:            { method: 'PATCH',  path: '/me/messages/{id}', build: 'markread' },
  flag_message:         { method: 'PATCH',  path: '/me/messages/{id}', build: 'flag' },
  // 红线：软删（move to Deleted Items）
  delete_message:       { method: 'POST',   path: '/me/messages/{id}/move', build: 'softdelete' },

  bulk_action:          { build: 'bulk' },
  get_unsubscribe_info: { method: 'GET',    path: '/me/messages/{id}', query: [['select', '__fixed:id,subject,unsubscribeEnabled,unsubscribeFlag']] },
  unsubscribe:          { method: 'POST',   path: '/me/messages/{id}/unsubscribe' },
  find_newsletters:     { method: 'GET',    path: '/me/messages' },
  mail_digest:          { method: 'GET',    path: '/me/messages' },

  // ── 日历 ──
  list_calendars:           { method: 'GET',    path: '/me/calendars', query: [['select','__fixed:id,name,isDefaultCalendar,hexColor,canEdit,canShare,canViewPrivateItems,isRemovable,owner']] },
  get_calendar:             { method: 'GET',    path: '/me/calendars/{id}' },
  list_events:              { method: 'GET',    path: '/me/calendar/events', build: 'events' },
  get_event:                { method: 'GET',    path: '/me/events/{id}', query: [['select','__fixed:id,subject,body,start,end,location,attendees,isAllDay,categories,organizer,onlineMeeting,importance,showAs']] },
  create_event:             { method: 'POST',   path: '/me/events', build: 'event' },
  update_event:             { method: 'PATCH',  path: '/me/events/{id}', build: 'event' },
  delete_event:             { method: 'DELETE', path: '/me/events/{id}' },
  accept_event:             { method: 'POST',   path: '/me/events/{id}/accept', build: 'rsvp' },
  decline_event:            { method: 'POST',   path: '/me/events/{id}/decline', build: 'rsvp' },
  tentatively_accept_event: { method: 'POST',   path: '/me/events/{id}/tentativelyAccept', build: 'rsvp' },

  list_rules:           { method: 'GET',    path: '/me/mailFolders/inbox/messageRules' },
  create_rule:          { method: 'POST',   path: '/me/mailFolders/inbox/messageRules', build: 'rule' },
  delete_rule:          { method: 'DELETE', path: '/me/mailFolders/inbox/messageRules/{id}' },
  block_sender:         { method: 'POST',   path: '/me/mailFolders/inbox/messageRules', build: 'block' },
};

function build(kind, a) {
  const msg = {
    ...(a.subject !== undefined ? { subject: a.subject } : {}),
    ...(a.body !== undefined ? { body: { contentType: a.bodyType || 'Text', content: a.body } } : {}),
    ...(a.to !== undefined ? { toRecipients: addr(a.to) } : {}),
    ...(a.cc !== undefined ? { ccRecipients: addr(a.cc) } : {}),
    ...(a.bcc !== undefined ? { bccRecipients: addr(a.bcc) } : {}),
  };
  switch (kind) {
    case 'mail': return { message: msg, saveToSentItems: a.saveToSentItems !== false };
    case 'draft': return msg;
    case 'reply': return { comment: a.comment };
    case 'forward': return { comment: a.comment, toRecipients: addr(a.to) };
    case 'move': return { destinationId: a.destinationFolderId };
    case 'markread': return { isRead: a.isRead };
    case 'flag': return { flag: { flagStatus: a.status } };
    case 'softdelete': return { destinationId: 'deleteditems' };
    case 'rule': return {
      displayName: a.displayName,
      conditions: {
        ...(a.fromAddresses ? { fromAddresses: addr(a.fromAddresses) } : {}),
        ...(a.senderContains ? { senderContains: [a.senderContains] } : {}),
        ...(a.subjectContains ? { subjectContains: [a.subjectContains] } : {}),
      },
      actions: {
        ...(a.action === 'move' && a.destinationFolderId ? { moveToFolder: a.destinationFolderId } : {}),
        ...(a.action === 'delete' ? { delete: true } : {}),
        ...(a.action === 'markAsRead' ? { markAsRead: true } : {}),
        ...(a.stopProcessingRules !== undefined ? { stopProcessingRules: a.stopProcessingRules } : {}),
      },
    };
    case 'event': {
      const ev = {};
      if (a.subject !== undefined) ev.subject = a.subject;
      if (a.body !== undefined) ev.body = { contentType: a.bodyType || 'Text', content: a.body };
      if (a.location !== undefined) ev.location = { displayName: a.location };
      const tz = a.timeZone || 'UTC';
      if (a.start) ev.start = { dateTime: a.start, timeZone: tz };
      if (a.end) ev.end = { dateTime: a.end, timeZone: tz };
      if (a.attendees) ev.attendees = (Array.isArray(a.attendees) ? a.attendees : [a.attendees]).map(x => ({ emailAddress: { address: x }, type: 'required' }));
      if (a.isAllDay !== undefined) ev.isAllDay = a.isAllDay;
      if (a.categories) ev.categories = a.categories;
      return ev;
    }
    case 'rsvp': return { comment: a.comment || '', sendResponse: a.sendResponse !== false };
    case 'block': return {
      displayName: 'Block sender (auto)',
      conditions: {
        ...(a.addresses ? { fromAddresses: addr(a.addresses) } : {}),
        ...(a.domains ? { senderContains: (Array.isArray(a.domains) ? a.domains : [a.domains]) } : {}),
      },
      actions: { delete: true },
    };
    default: return undefined;
  }
}

export function hasTool(name) { return !!M[name]; }
export function listGraphTools() { return Object.keys(M); }

export async function callGraphTool(env, name, args = {}) {
  const spec = M[name];
  if (!spec) throw new Error(`未知 Outlook 工具：${name}`);
  if (spec.stub) return spec.stub(args);

  // bulk_action：先查再逐个执行
  if (name === 'bulk_action') {
    const listQ = { $top: args.max || 20, $orderby: 'receivedDateTime desc' };
    const f = dateFilter(args.since, args.until, args.from);
    if (f) listQ.$filter = f;
    if (args.unreadOnly) listQ.$filter = (listQ.$filter ? listQ.$filter + ' and ' : '') + 'isRead eq false';
    const listPath = args.folderId ? `/me/mailFolders/${args.folderId}/messages` : '/me/messages';
    const list = await gcall(env, 'GET', listPath, { query: listQ });
    const ids = (list.value || []).map(m => m.id);
    if (args.dryRun) return { ok: true, dryRun: true, matched: ids.length, ids };
    const results = [];
    for (const id of ids) {
      try {
        if (args.action === 'move') await gcall(env, 'POST', `/me/messages/${id}/move`, { body: { destinationId: args.destinationFolderId } });
        else if (args.action === 'delete') await gcall(env, 'POST', `/me/messages/${id}/move`, { body: { destinationId: 'deleteditems' } });
        else if (args.action === 'markRead') await gcall(env, 'PATCH', `/me/messages/${id}`, { body: { isRead: true } });
        results.push({ id, ok: true });
      } catch (e) { results.push({ id, ok: false, err: String(e.message || e).slice(0, 120) }); }
    }
    return { ok: true, action: args.action, count: results.length, results };
  }

  let path = spec.path.replace(/\{(\w+)\}/g, (_, k) => {
    const v = args[k];
    if (v === undefined || v === null || v === '') throw new Error(`工具 ${name} 缺少参数 ${k}`);
    return encodeURIComponent(String(v));
  });

  const query = {};
  if (spec.query) for (const [apiK, argK] of spec.query) {
    const v = typeof argK === 'string' && argK.startsWith('__fixed:') ? argK.slice(8) : args[argK];
    if (v !== undefined && v !== null && v !== '') query[apiK] = v;
  }

  if (name === 'list_messages' || name === 'search_messages') {
    if (args.folderId) path = `/me/mailFolders/${args.folderId}/messages`;
    if (args.nextLink) return gcall(env, 'GET', args.nextLink.replace(GRAPH, ''), { raw: true });
    if (name === 'search_messages') {
      query.$search = `"${args.query}"`;
    } else {
      if (args.unreadOnly) query.$filter = 'isRead eq false';
      const f = dateFilter(args.since, args.until, args.from);
      if (f) query.$filter = query.$filter ? `${query.$filter} and ${f}` : f;
      if (args.hasAttachments !== undefined) query.$filter = (query.$filter ? query.$filter + ' and ' : '') + `hasAttachments eq ${args.hasAttachments}`;
      query.$orderby = 'receivedDateTime desc';
    }
    if (args.top) query.$top = args.top;
  }
  if (name === 'list_events') {
    if (args.calendarId) path = `/me/calendars/${args.calendarId}/events`;
    if (args.nextLink) return gcall(env, 'GET', args.nextLink.replace(GRAPH, ''), { raw: true });
    if (args.startDateTime || args.endDateTime) {
      const parts = [];
      if (args.startDateTime) parts.push(`start/dateTime ge '${args.startDateTime}'`);
      if (args.endDateTime) parts.push(`end/dateTime le '${args.endDateTime}'`);
      query.$filter = parts.join(' and ');
    }
    if (args.search) query.$search = `"${args.search}"`;
    if (args.filter) query.$filter = args.filter;
    query.$top = args.top || 20;
    query.$orderby = 'start/dateTime';
    query.$select = 'id,subject,start,end,location,isAllDay,categories,organizer,importance,showAs';
  }
  if (name === 'find_newsletters' || name === 'mail_digest') {
    if (args.folderId) path = `/me/mailFolders/${args.folderId}/messages`;
    if (name === 'find_newsletters') query.$top = args.maxMessages || 50;
    else {
      if (args.since) query.$filter = `receivedDateTime ge ${args.since}`;
      if (args.unreadOnly) query.$filter = (query.$filter ? query.$filter + ' and ' : '') + 'isRead eq false';
      query.$top = args.maxMessages || 50;
    }
    query.$orderby = 'receivedDateTime desc';
  }

  const body = spec.build ? build(spec.build, args) : undefined;
  return gcall(env, spec.method, path, { query, body });
}
