// src/google-apis.mjs — Google OAuth 通用认证 + Calendar / Drive / Sheets / Docs API
// 2026-10-22 v2：按真实工具名/参数重写（drive_search / sheets_read / list_calendars …）

const ENDPOINTS = {
  calendar: 'https://www.googleapis.com/calendar/v3',
  drive:    'https://www.googleapis.com/drive/v3',
  sheets:   'https://sheets.googleapis.com/v4',
  docs:     'https://docs.googleapis.com/v1',
};

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function googleToken(env, clientKind, account) {
  // 每账号可覆盖 client（work 的 drive 用另一个 OAuth client）
  const clientId = env[`${clientKind}_${account}_client_id`] || env[`${clientKind}_client_id`];
  const clientSecret = env[`${clientKind}_${account}_client_secret`] || env[`${clientKind}_client_secret`];
  const refreshToken = env[`${clientKind}_${account}_refresh`];
  if (!clientId || !clientSecret || !refreshToken) throw new Error(`Google ${clientKind}/${account} 凭据不全`);
  // 缓存 key 带 refresh_token 指纹——换 token 自动作废各 colo 的旧 access_token
  const fp = (await sha256(refreshToken)).slice(0, 16);
  const key = new Request(`https://gtok.internal/${clientKind}/${account}/${fp}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.text();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google OAuth 失败：${JSON.stringify(data).slice(0, 200)}`);
  await cache.put(key, new Response(data.access_token, { headers: { 'cache-control': 'public, max-age=3000' } }));
  return data.access_token;
}

export async function gapi(env, clientKind, account, api, method, path, { query, body, raw } = {}) {
  const token = await googleToken(env, clientKind, account);
  const url = new URL(ENDPOINTS[api] + path);
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
    throw new Error(`Google ${api} ${res.status}：${msg}`);
  }
  if (raw) return text;
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- Google Calendar（19 工具，真实名）----------
// snake_case 入参 → Google API camelCase
const CAL = {
  // 认证类（Worker 用 refresh token，已认证）——返回固定说明
  auth_status:            { stub: () => ({ authenticated: true, mode: 'refresh-token (Worker 部署，无需交互登录)' }) },
  setup_instructions:     { stub: () => ({ note: 'Worker 部署用 refresh token，不需要交互式 OAuth。' }) },
  set_client:             { stub: () => ({ ok: false, error: 'Worker 部署不支持 set_client（client 由部署侧固定）' }) },
  start_login:            { stub: () => ({ ok: false, error: 'Worker 部署不支持交互登录（用 refresh token）' }) },
  finish_login:           { stub: () => ({ ok: false, error: 'Worker 部署不支持交互登录（用 refresh token）' }) },
  logout:                 { stub: () => ({ ok: false, error: 'Worker 部署不支持 logout（refresh token 常驻）' }) },

  list_calendars:         { api: 'calendar', method: 'GET',  path: '/users/me/calendarList', query: [['maxResults','max_results'],['pageToken','page_token'],['minAccessRole','min_access_role'],['showHidden','show_hidden']] },
  get_calendar:           { api: 'calendar', method: 'GET',  path: '/calendars/{calendar_id}' },
  list_events:            { api: 'calendar', method: 'GET',  path: '/calendars/{calendar_id}/events', query: [['timeMin','time_min'],['timeMax','time_max'],['q','q'],['singleEvents','single_events'],['orderBy','order_by'],['timeZone','time_zone'],['maxResults','max_results'],['pageToken','page_token'],['showDeleted','show_deleted'],['updatedMin','updated_min'],['eventTypes','event_types']] },
  get_event:              { api: 'calendar', method: 'GET',  path: '/calendars/{calendar_id}/events/{event_id}', query: [['timeZone','time_zone']] },
  create_event:           { api: 'calendar', method: 'POST', path: '/calendars/{calendar_id}/events', build: 'event' },
  update_event:           { api: 'calendar', method: 'PUT',  path: '/calendars/{calendar_id}/events/{event_id}', build: 'event' },
  delete_event:           { api: 'calendar', method: 'DELETE', path: '/calendars/{calendar_id}/events/{event_id}', query: [['sendUpdates','send_updates']] },
  move_event:             { api: 'calendar', method: 'POST', path: '/calendars/{calendar_id}/events/{event_id}/move', query: [['destination','destination_calendar_id'],['sendUpdates','send_updates']] },
  list_event_instances:   { api: 'calendar', method: 'GET',  path: '/calendars/{calendar_id}/events/{event_id}/instances', query: [['timeMin','time_min'],['timeMax','time_max'],['timeZone','time_zone'],['maxResults','max_results'],['pageToken','page_token'],['showDeleted','show_deleted']] },
  query_free_busy:        { api: 'calendar', method: 'POST', path: '/freeBusy', build: 'freebusy' },
  create_out_of_office:   { api: 'calendar', method: 'POST', path: '/calendars/{calendar_id}/events', build: 'ooo' },
  create_focus_time:      { api: 'calendar', method: 'POST', path: '/calendars/{calendar_id}/events', build: 'focus' },
  raw_request:            { api: 'calendar', method: 'RAW',  path: '{path}' },
};

// 把 snake_case 入参拼成 Google API 的 event / freebusy body
function buildBody(kind, a) {
  const ev = {};
  const put = (googleKey, v) => { if (v !== undefined) ev[googleKey] = v; };
  if (kind === 'event' || kind === 'ooo' || kind === 'focus') {
    put('summary', a.summary);
    put('description', a.description);
    put('location', a.location);
    if (a.start_date_time || a.start_date) {
      ev.start = a.start_date_time
        ? { dateTime: a.start_date_time, ...(a.time_zone ? { timeZone: a.time_zone } : {}) }
        : { date: a.start_date };
    }
    if (a.end_date_time || a.end_date) {
      ev.end = a.end_date_time
        ? { dateTime: a.end_date_time, ...(a.time_zone ? { timeZone: a.time_zone } : {}) }
        : { date: a.end_date };
    }
    if (a.attendees) ev.attendees = Array.isArray(a.attendees) ? a.attendees.map(x => typeof x === 'string' ? { email: x } : x) : a.attendees;
    if (a.recurrence) ev.recurrence = Array.isArray(a.recurrence) ? a.recurrence : [a.recurrence];
    if (a.reminders !== undefined) ev.reminders = a.reminders;
    if (a.use_default_reminders !== undefined) ev.reminders = { useDefault: a.use_default_reminders, ...(a.reminders ? { overrides: a.reminders } : {}) };
    put('transparency', a.transparency);
    put('visibility', a.visibility);
    put('colorId', a.color_id);
    if (a.guests_can_invite_others !== undefined || a.guests_can_modify !== undefined || a.guests_can_see_other_guests !== undefined) {
      ev.guestsCanInviteOthers = a.guests_can_invite_others;
      ev.guestsCanModify = a.guests_can_modify;
      ev.guestsCanSeeOtherGuests = a.guests_can_see_other_guests;
    }
    if (kind === 'ooo') { ev.eventType = 'outOfOffice'; if (a.auto_decline !== undefined) ev.outOfOfficeProperties = { autoDeclineMode: a.auto_decline ? 'all' : 'none' }; }
    if (kind === 'focus') { ev.eventType = 'focusTime'; if (a.chat_status) ev.focusTimeProperties = { chatStatus: a.chat_status }; }
    return ev;
  }
  if (kind === 'freebusy') {
    return {
      timeMin: a.time_min, timeMax: a.time_max,
      ...(a.time_zone ? { timeZone: a.time_zone } : {}),
      items: (a.calendar_ids || []).map(id => ({ id })),
    };
  }
  return {};
}

// ---------- Google Drive / Sheets / Docs（8 工具，真实名）----------
const DRIVE = {
  drive_search:  { api: 'drive',  method: 'GET',  path: '/files', query: [['q','query'],['pageSize','maxResults'],['fields','files(id,name,mimeType,modifiedTime,webViewLink,parents)']] },
  drive_list:    { api: 'drive',  method: 'GET',  path: '/files', query: [['q','folderId', v => v ? `'${v}' in parents` : undefined],['pageSize','maxResults'],['fields','files(id,name,mimeType,modifiedTime,webViewLink,parents)']] },
  sheets_info:   { api: 'sheets', method: 'GET',  path: '/spreadsheets/{spreadsheetId}', query: [] },
  sheets_read:   { api: 'sheets', method: 'GET',  path: '/spreadsheets/{spreadsheetId}/values/{range}' },
  sheets_update: { api: 'sheets', method: 'PUT',  path: '/spreadsheets/{spreadsheetId}/values/{range}', body: ['values','majorDimension'], query: [['valueInputOption','__fixed:RAW']] },
  sheets_append: { api: 'sheets', method: 'POST', path: '/spreadsheets/{spreadsheetId}/values/{range}:append', body: ['values','majorDimension'], query: [['valueInputOption','__fixed:RAW'],['insertDataOption','__fixed:INSERT_ROWS']] },
  docs_read:     { api: 'docs',   method: 'GET',  path: '/documents/{documentId}' },
  docs_create:   { api: 'docs',   method: 'POST', path: '/documents', build: 'doc' },
};

function buildDriveBody(kind, a) {
  if (kind === 'doc') {
    return { title: a.title };
  }
  return {};
}

const ALL = { ...CAL, ...DRIVE };
export function hasTool(name) { return !!ALL[name]; }
export function listMappedTools() { return Object.keys(ALL); }

export async function callGoogleTool(env, service, name, args = {}) {
  const spec = ALL[name];
  if (!spec) throw new Error(`未知工具：${name}`);
  const account = service.endsWith('work') ? 'work' : 'personal';
  const clientKind = service.startsWith('gcal') ? 'calendar' : 'drive';

  if (spec.stub) return spec.stub(args);

  // 路径参数（用 snake_case 名字）
  let path = spec.path.replace(/\{(\w+)\}/g, (_, k) => {
    const v = args[k];
    if (v === undefined || v === null || v === '') throw new Error(`工具 ${name} 缺少参数 ${k}`);
    return encodeURIComponent(String(v));
  });

  // query：[apiKey, argName] 或 [apiKey, argName, fn] 或 [apiKey, '__fixed:value']
  const query = {};
  if (spec.query) for (const entry of spec.query) {
    const [apiK, argK, fn] = entry;
    let v;
    if (typeof argK === 'string' && argK.startsWith('__fixed:')) v = argK.slice(8);
    else if (typeof fn === 'function') v = fn(args[argK]);
    else v = args[argK];
    if (v !== undefined && v !== null && v !== '') query[apiK] = v;
  }
  // drive_search：裸关键词 → Drive 查询语法（描述里承诺过；Google 只认语法）
  if (name === 'drive_search' && query.q && !/[=<>]| contains | in | and | or /i.test(query.q)) {
    const kw = String(query.q).replace(/'/g, "\\'");
    query.q = `name contains '${kw}' or fullText contains '${kw}'`;
  }

  // body
  let body;
  if (name === 'docs_create' && (!args.title || !String(args.title).trim())) {
    throw new Error('docs_create 需要非空 title（避免误建空白文档）');
  }
  if (spec.build) body = buildBody(spec.build, args);
  else if (spec.body && spec.method !== 'GET' && spec.method !== 'DELETE') {
    body = {};
    for (const k of spec.body) if (args[k] !== undefined) body[k] = args[k];
    if (!Object.keys(body).length) body = undefined;
  }
  if (spec.build === 'doc') body = buildDriveBody('doc', args);

  // raw_request 透传
  if (spec.method === 'RAW') {
    return gapi(env, clientKind, account, 'calendar', (args.method || 'GET').toUpperCase(), args.path, { body: args.body });
  }

  return gapi(env, clientKind, account, spec.api, spec.method, path, { query, body });
}
