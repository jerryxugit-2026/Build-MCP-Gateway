// src/mcp.mjs — MCP 协议层（2025-11-25 旧版 + 2026-07-28 新版）+ iCloud 日历工具
// 2026-10-22

import { listCalendars, listEvents, getEvent, createEvent, updateEvent, deleteEvent, icloudCapabilities, calendarCapabilities, findFreeSlots, searchEvents, validateEvent } from './caldav.mjs';
import { listAddressBooks, searchContacts, getContact, createContact, updateContact, deleteContact } from './carddav.mjs';
import { listMailboxes, searchMessages, getMessage, setFlags, deleteMessage, moveMessage, createDraft, sendMail } from './imap.mjs';
import { callGmailTool, hasTool } from './gmail.mjs';
import gmailTools from './gmail-tools.json' with { type: 'json' };
import gcalTools from './tools-gcal.json' with { type: 'json' };
import driveTools from './tools-drive.json' with { type: 'json' };
import outlookTools from './tools-outlook.json' with { type: 'json' };
import geminiTools from './tools-gemini.json' with { type: 'json' };
import { callGoogleTool } from './google-apis.mjs';
import { callGraphTool } from './graph.mjs';
import { callImaTool } from './ima.mjs';
import imaTools from './ima-tools.json' with { type: 'json' };
import { callGeminiGrounding } from './vertex.mjs';

const SERVER_INFO = { name: 'icloud-mcp-worker', version: '0.1.0' };

// ---------- 工具定义 ----------
const ICLOUD_TOOLS = [
  {
    name: 'list_calendars',
    description: '列出 iCloud 账户下的全部日历（名称、路径、支持的组件类型）。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_events',
    description: '查询指定日历中的事件。支持按时间范围与关键词过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar: { type: 'string', description: '日历路径（来自 list_calendars 的 href）。缺省取第一个日历。' },
        time_min: { type: 'string', description: '起始时间 ISO8601，如 2026-10-22T00:00:00Z' },
        time_max: { type: 'string', description: '结束时间 ISO8601' },
        query: { type: 'string', description: '标题/描述关键词（不区分大小写）' },
        limit: { type: 'integer', description: '最多返回条数，默认 50' },
      },
    },
  },
  {
    name: 'get_event',
    description: '按 href 读取单个事件的完整字段。',
    inputSchema: {
      type: 'object',
      properties: { href: { type: 'string', description: '事件的 CalDAV href' } },
      required: ['href'],
    },
  },
  {
    name: 'create_event',
    description: '创建日历事件。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar: { type: 'string', description: '日历 href（缺省取第一个）' },
        title: { type: 'string', description: '标题' },
        start: { type: 'string', description: '开始时间 ISO8601' },
        end: { type: 'string', description: '结束时间 ISO8601' },
        all_day: { type: 'boolean', description: '是否全天事件' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'update_event',
    description: '更新已有事件的部分字段（合并式：未传字段保持原样，VALARM/RRULE/参与人等一律保留）。',
    inputSchema: {
      type: 'object',
      properties: {
        href: { type: 'string', description: '事件 href' },
        title: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        all_day: { type: 'boolean' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['href'],
    },
  },
  {
    name: 'delete_event',
    description: '删除事件。⚠️ 不可撤销，请确认后再调用。',
    inputSchema: {
      type: 'object',
      properties: {
        href: { type: 'string', description: '事件 href' },
        confirm: { type: 'boolean', description: '必须传 true 才会真正删除（防误删）' },
      },
      required: ['href', 'confirm'],
    },
  },

  // ── 联系人（CardDAV）──
  {
    name: 'list_address_books',
    description: '列出 iCloud 联系人账户下的通讯录（名称、路径）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_contacts',
    description: '按姓名/机构搜索联系人。',
    inputSchema: {
      type: 'object',
      properties: {
        address_book: { type: 'string', description: '通讯录 href（来自 list_address_books）；缺省用第一个' },
        query: { type: 'string', description: '搜索关键词（匹配姓名/机构，不区分大小写）' },
        limit: { type: 'integer', description: '最多返回条数，默认 50' },
      },
    },
  },
  {
    name: 'get_contact',
    description: '按 href 读取单个联系人。',
    inputSchema: {
      type: 'object',
      properties: { href: { type: 'string', description: '联系人 href' } },
      required: ['href'],
    },
  },
  {
    name: 'create_contact',
    description: '新建联系人。',
    inputSchema: {
      type: 'object',
      properties: {
        address_book: { type: 'string', description: '通讯录 href（缺省用第一个）' },
        name: { type: 'string', description: '姓名（必填）' },
        email: { type: 'string' },
        phone: { type: 'string' },
        organization: { type: 'string' },
        title: { type: 'string', description: '职务' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_contact',
    description: '更新联系人部分字段。',
    inputSchema: {
      type: 'object',
      properties: {
        href: { type: 'string', description: '联系人 href' },
        name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
        organization: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' },
      },
      required: ['href'],
    },
  },
  {
    name: 'delete_contact',
    description: '删除联系人。⚠️ 不可撤销，请确认后再调用。',
    inputSchema: {
      type: 'object',
      properties: {
        href: { type: 'string', description: '联系人 href' },
        confirm: { type: 'boolean', description: '必须传 true 才会真正删除（防误删）' },
      },
      required: ['href', 'confirm'],
    },
  },

  // ── 邮件（IMAP / SMTP）──
  {
    name: 'list_mailboxes',
    description: '列出 iCloud 邮箱（文件夹）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_messages',
    description: '搜索邮件。',
    inputSchema: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', description: '邮箱名，默认 INBOX' },
        query: { type: 'string', description: '全文搜索关键词' },
        since: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        before: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        unread: { type: 'boolean', description: '只找未读' },
        limit: { type: 'integer', description: '最多返回条数，默认 20' },
      },
    },
  },
  {
    name: 'get_message',
    description: '按 UID 读取邮件全文（含正文）。',
    inputSchema: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', description: '邮箱名，默认 INBOX' },
        uid: { type: 'string', description: '邮件 UID' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'send_message',
    description: '发送邮件。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件人（可逗号分隔）' },
        subject: { type: 'string' },
        body: { type: 'string', description: '正文（纯文本）' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'create_draft',
    description: '保存草稿（不发送）。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'delete_message',
    description: '删除邮件。⚠️ 不可撤销，请确认后再调用。',
    inputSchema: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', description: '邮箱名，默认 INBOX' },
        uid: { type: 'string' },
        confirm: { type: 'boolean', description: '必须传 true 才会真正删除（防误删）' },
      },
      required: ['uid', 'confirm'],
    },
  },
  {
    name: 'mark_message',
    description: '设置邮件标记（已读/未读、加星）。',
    inputSchema: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', description: '邮箱名，默认 INBOX' },
        uid: { type: 'string' },
        seen: { type: 'boolean', description: 'true=已读 / false=未读' },
        flagged: { type: 'boolean', description: 'true=加星 / false=取消星标' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'move_message',
    description: '移动邮件到另一个邮箱（如 Archive、Trash）。',
    inputSchema: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', description: '源邮箱，默认 INBOX' },
        uid: { type: 'string' },
        target: { type: 'string', description: '目标邮箱，默认 Archive' },
      },
      required: ['uid'],
    },
  },

  // ── 能力与查询（S1 新增，最大化集合对齐 Mac 版）──
  {
    name: 'icloud_capabilities',
    description: '返回 iCloud 服务的能力面（哪些协议可用、哪些受限）。用于 agent 自检。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'calendar_capabilities',
    description: '返回指定日历的能力（可写性、支持的组件类型、时区）。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: '日历 href；缺省查所有日历' },
      },
    },
  },
  {
    name: 'find_free_slots',
    description: '在指定时间范围内查找空闲时段（忙闲计算）。支持工作时间限制。',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '起始时间 ISO8601' },
        end: { type: 'string', description: '结束时间 ISO8601' },
        duration_minutes: { type: 'integer', description: '每个空档的最短时长（分钟），默认 30' },
        calendar_id: { type: 'string', description: '日历 href；缺省用主日历' },
        working_hours_start: { type: 'integer', description: '工作时间起（0-23），不限则 0' },
        working_hours_end: { type: 'integer', description: '工作时间止（0-23），不限则 24' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'search_events',
    description: '按关键词搜索事件（匹配标题/描述/地点，不区分大小写）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        time_min: { type: 'string', description: '起始时间 ISO8601；缺省为现在-30 天' },
        time_max: { type: 'string', description: '结束时间 ISO8601；缺省为现在+90 天' },
        calendar_id: { type: 'string', description: '日历 href；缺省查所有日历' },
        limit: { type: 'integer', description: '最多返回条数，默认 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'validate_event',
    description: '校验事件字段（时间倒挂、RRULE 语法、必填字段、时区），返回错误和警告。',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始时间 ISO8601 或 YYYY-MM-DD（全天）' },
        end: { type: 'string', description: '结束时间 ISO8601 或 YYYY-MM-DD' },
        summary: { type: 'string', description: '标题' },
        all_day: { type: 'boolean', description: '是否全天事件' },
        recurrence: { type: 'array', items: { type: 'string' }, description: 'RRULE 数组' },
        timezone: { type: 'string', description: 'IANA 时区名，如 Asia/Shanghai' },
      },
      required: ['start', 'end'],
    },
  },
];

// ---------- 协议响应封装 ----------
function negotiateVersion(body, request) {
  const pv = body?.params?.protocolVersion;
  if (pv) return pv;
  const h = request.headers.get('mcp-protocol-version');
  return h || '2025-11-25';
}
function isModern(v) { return v && v.startsWith('2026-'); }

function respond(payload, version, opts = {}) {
  const status = opts.status ?? 200;
  if (isModern(version)) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(opts.headers || {}) },
    });
  }
  // 旧版：SSE 单事件（与 supergateway 行为一致，Grok 实测可消费）
  const lines = [];
  if (payload) lines.push('event: message', 'data: ' + JSON.stringify(payload), '');
  return new Response(lines.join('\n') + (lines.length ? '\n' : ''), {
    status,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      ...(opts.headers || {}),
    },
  });
}

function rpcOk(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// ---------- Bearer 认证 ----------
import { verifyToken } from './crypto.mjs';

export async function handleMcp(request, env, base, service = 'icloud') {
  if (request.method !== 'POST') {
    return respond(null, '2025-11-25', { status: 405 });
  }
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let ok = false;
  // 1) 静态 Bearer token（给 DSH / Muse / GrokBot / Hark 这类不走 OAuth 的客户端）
  if (env.STATIC_TOKEN && token === env.STATIC_TOKEN) ok = true;
  // 2) OAuth 签发的 Bearer token（Grok / Codex / Claude Code）
  if (!ok && token) {
    const payload = await verifyToken(env.TOKEN_KEY, token);
    ok = !!(payload && payload.t === 'access');
  }
  if (!ok) {
    return new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        'cache-control': 'no-store',
      },
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return respond(rpcErr(null, -32700, 'parse error'), '2025-11-25', { status: 400 });
  }
  const version = negotiateVersion(body, request);
  const id = body.id ?? null;
  const method = body.method;

  // 通知（无 id）
  if (id === null && method && method.startsWith('notifications/')) {
    return respond(null, version, { status: 202 });
  }

  try {
    if (method === 'initialize') {
      return respond(rpcOk(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }), version, {
        headers: isModern(version) ? {} : { 'mcp-session-id': 'stateless' },
      });
    }

    if (method === 'tools/list') {
      // P0-2：走模块加载时预序列化好的字节；未登记的 service 才回落到现序列化
      const pre = TOOLS_LIST_PRE.get(service);
      if (pre) return respondToolsList(pre, id, version);
      return respond(rpcOk(id, { tools: toolsFor(service) }), version);
    }

    if (method === 'tools/call') {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      const result = await cachedToolCall(env, service, name, args, () => callTool(env, name, args, service));
      return respond(rpcOk(id, result), version);
    }

    return respond(rpcErr(id, -32601, `Method not found: ${method}`), version);
  } catch (e) {
    return respond(rpcOk(id, {
      content: [{ type: 'text', text: `执行失败：${e && e.message ? e.message : e}` }],
      isError: true,
    }), version);
  }
}

// ---------- 工具调度 ----------
function textResult(obj) {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
  };
}

async function resolveCalendar(env, href) {
  if (href) return href;
  const cals = await listCalendars(env);
  const cal = cals.find(c => c.components.includes('VEVENT')) || cals[0];
  if (!cal) throw new Error('账户下没有日历');
  return cal.href;
}

async function callTool(env, name, a, service = 'icloud') {
  if (service === 'ima') {
    return textResult(await callImaTool(env, name, a));
  }
  if (service === 'gmail-personal' || service === 'gmail-work') {
    return textResult(await callGmailTool(env, serviceAccount(service), name, a));
  }
  if (service === 'gcal-personal' || service === 'gcal-work' || service === 'drive-personal' || service === 'drive-work') {
    return textResult(await callGoogleTool(env, service, name, a));
  }
  if (service === 'outlook') {
    return textResult(await callGraphTool(env, name, a));
  }
  if (service === 'gemini') {
    return textResult(await callGeminiGrounding(env, a));
  }
  switch (name) {
    case 'list_calendars':
      return textResult(await listCalendars(env));

    case 'list_events': {
      const cal = await resolveCalendar(env, a.calendar);
      const evs = await listEvents(env, cal, {
        timeMin: a.time_min, timeMax: a.time_max, query: a.query, limit: a.limit,
      });
      return textResult({ calendar: cal, count: evs.length, events: evs });
    }

    case 'get_event':
      return textResult(await getEvent(env, a.href));

    case 'create_event': {
      const cal = await resolveCalendar(env, a.calendar);
      const r = await createEvent(env, cal, {
        summary: a.title, start: a.start, end: a.end,
        all_day: a.all_day, description: a.description, location: a.location,
      });
      return textResult(r);
    }

    case 'update_event': {
      const r = await updateEvent(env, a.href, {
        summary: a.title, start: a.start, end: a.end,
        all_day: a.all_day, description: a.description, location: a.location,
      });
      return textResult(r);
    }

    case 'delete_event':
      if (a.confirm !== true) return textResult({ error: '需要 confirm: true 才会执行删除' });
      return textResult(await deleteEvent(env, a.href));

    // ── 联系人 ──
    case 'list_address_books':
      return textResult(await listAddressBooks(env));

    case 'search_contacts': {
      const books = await listAddressBooks(env);
      const book = a.address_book || (books[0] && books[0].href);
      if (!book) throw new Error('没有找到通讯录');
      const cs = await searchContacts(env, book, { query: a.query, limit: a.limit });
      return textResult({ address_book: book, count: cs.length, contacts: cs });
    }

    case 'get_contact':
      return textResult(await getContact(env, a.href));

    case 'create_contact': {
      const books = await listAddressBooks(env);
      const book = a.address_book || (books[0] && books[0].href);
      if (!book) throw new Error('没有找到通讯录');
      return textResult(await createContact(env, book, {
        name: a.name, email: a.email, phone: a.phone,
        organization: a.organization, title: a.title, notes: a.notes,
      }));
    }

    case 'update_contact':
      return textResult(await updateContact(env, a.href, {
        name: a.name, email: a.email, phone: a.phone,
        organization: a.organization, title: a.title, notes: a.notes,
      }));

    case 'delete_contact':
      if (a.confirm !== true) return textResult({ error: '需要 confirm: true 才会执行删除' });
      return textResult(await deleteContact(env, a.href));

    // ── 邮件 ──
    case 'list_mailboxes':
      return textResult(await listMailboxes(env));

    case 'search_messages':
      return textResult(await searchMessages(env, {
        mailbox: a.mailbox || 'INBOX', query: a.query,
        since: a.since, before: a.before, unread: a.unread, limit: a.limit,
      }));

    case 'get_message':
      return textResult(await getMessage(env, { mailbox: a.mailbox || 'INBOX', uid: a.uid }));

    case 'send_message':
      return textResult(await sendMail(env, { to: a.to, subject: a.subject, body: a.body, cc: a.cc, bcc: a.bcc }));

    case 'create_draft':
      return textResult(await createDraft(env, { to: a.to, subject: a.subject, body: a.body }));

    case 'delete_message':
      if (a.confirm !== true) return textResult({ error: '需要 confirm: true 才会执行删除' });
      return textResult(await deleteMessage(env, { mailbox: a.mailbox || 'INBOX', uid: a.uid }));

    case 'mark_message':
      return textResult(await setFlags(env, {
        mailbox: a.mailbox || 'INBOX', uid: a.uid, seen: a.seen, flagged: a.flagged,
      }));

    case 'move_message':
      return textResult(await moveMessage(env, {
        mailbox: a.mailbox || 'INBOX', uid: a.uid, target: a.target || 'Archive',
      }));

    // ── 能力与查询（S1 新增）──
    case 'icloud_capabilities':
      return textResult(await icloudCapabilities(env));

    case 'calendar_capabilities':
      return textResult(await calendarCapabilities(env, a.calendar_id));

    case 'find_free_slots':
      return textResult(await findFreeSlots(env, {
        start: a.start, end: a.end, duration: a.duration_minutes || 30,
        calendarId: a.calendar_id,
        workStart: a.working_hours_start, workEnd: a.working_hours_end,
      }));

    case 'search_events':
      return textResult(await searchEvents(env, {
        query: a.query, timeMin: a.time_min, timeMax: a.time_max,
        calendarId: a.calendar_id, limit: a.limit || 20,
      }));

    case 'validate_event':
      return textResult(validateEvent({
        start: a.start, end: a.end, summary: a.summary,
        allDay: a.all_day, recurrence: a.recurrence, timezone: a.timezone,
      }));

    default:
      return textResult({ error: `未知工具：${name}` });
  }
}


// ---------- 多服务：icloud / gmail-personal / gmail-work ----------
const GMAIL_TOOLS = gmailTools;
export function toolsFor(service) {
  if (service === 'ima') return imaTools;
  if (service === 'gmail-personal' || service === 'gmail-work') return GMAIL_TOOLS;
  if (service === 'gcal-personal' || service === 'gcal-work') return gcalTools;
  if (service === 'drive-personal' || service === 'drive-work') return driveTools;
  if (service === 'outlook') return outlookTools;
  if (service === 'gemini') return geminiTools;
  return ICLOUD_TOOLS;
}
export function serviceAccount(service) {
  return service === 'gmail-work' ? 'work' : 'personal';
}


// ---------- P0-2：tools/list 响应预序列化 ----------
// isolate 冷启动时按端点把 tools/list 的响应体编码成 UTF-8 字节，请求到来只拼接 JSON-RPC id。
// 字节形态与 respond(rpcOk(id, { tools }), version) 逐字节一致：
//   新版（2026-*）：{"jsonrpc":"2.0","id":<id>,"result":{"tools":[...]}}
//   旧版（SSE）  ：event: message\ndata: <同上>\n\n
// personal / work 共用同一份工具数组，按数组身份去重，只编码一次。
// notes / reminders 是 Mac 代理（index.mjs 透传），工具列表来自上游，不在此处。
const ENC = new TextEncoder();
const MCP_SERVICES = ['icloud', 'ima', 'gmail-personal', 'gmail-work', 'gcal-personal', 'gcal-work', 'drive-personal', 'drive-work', 'outlook', 'gemini'];
const RPC_HEAD = '{"jsonrpc":"2.0","id":';

function buildToolsListPre(tools) {
  const tail = ',"result":{"tools":' + JSON.stringify(tools) + '}}';
  return {
    modern: { head: ENC.encode(RPC_HEAD), tail: ENC.encode(tail) },
    legacy: { head: ENC.encode('event: message\ndata: ' + RPC_HEAD), tail: ENC.encode(tail + '\n\n') },
  };
}

const TOOLS_LIST_PRE = (() => {
  const byArray = new Map();
  const out = new Map();
  for (const s of MCP_SERVICES) {
    const tools = toolsFor(s);
    if (!byArray.has(tools)) byArray.set(tools, buildToolsListPre(tools));
    out.set(s, byArray.get(tools));
  }
  return out;
})();

function respondToolsList(pre, id, version) {
  const modern = isModern(version);
  const p = modern ? pre.modern : pre.legacy;
  const idBytes = ENC.encode(JSON.stringify(id));
  const body = new Uint8Array(p.head.length + idBytes.length + p.tail.length);
  body.set(p.head, 0);
  body.set(idBytes, p.head.length);
  body.set(p.tail, p.head.length + idBytes.length);
  // 响应头与 respond() 对应分支保持一致
  const headers = modern
    ? { 'content-type': 'application/json', 'cache-control': 'no-store' }
    : { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
  return new Response(body, { status: 200, headers });
}


// ---------- P1-2：读类工具 每 isolate TTL 内存缓存 ----------
// key   = 端点 + 工具名 + 参数规范化 JSON（对象键递归排序后序列化）
// value = tools/call 的 result（Mac 代理则为上游响应原文）
// TTL 默认 45 秒，env MCP_READ_CACHE_TTL_MS 覆盖（0 = 全关闭）；容量 200 条，Map 插入序做 LRU。
// 另设单条/总量字符上限，防大邮件正文把 128MB isolate 撑爆。
//
// 可缓存判定（保守，拿不准一律不缓存）：
//   1) 工具名以 list_ / get_ / search_ 开头（notes 端点工具名用连字符：list- / get- / search-；
//      reminders 端点工具名带 reminders_ 命名空间前缀，判定前先剥掉）；
//      另有显式白名单 gemini_grounding_search（只读、按次计费，命中直接省钱）。
//   2) 工具名任一分词命中写类动词（create/update/delete/send/mark/move/confirm/append/edit 等）→ 永不缓存，
//      哪怕以 get_/list_ 开头（例如 get_send_as_alias 因含 send 被排除）。
//   3) 参数里带 confirm 字段 → 不缓存（删除类确认语义，原样走上游）。
//   4) 只存成功结果：抛异常、isError、或 textResult({ error }) 形态的结果都不存。
// 同端点上出现任何不可缓存的 tools/call（写操作或拿不准的工具）→ 清空该端点缓存，保证本 isolate 内读己之写。
const READ_CACHE_DEFAULT_TTL_MS = 45_000;
const READ_CACHE_MAX_ENTRIES = 200;
const READ_CACHE_MAX_ENTRY_CHARS = 512 * 1024;
const READ_CACHE_MAX_TOTAL_CHARS = 8 * 1024 * 1024;
const READ_PREFIX = /^(list|get|search)[_-]/;
const WRITE_TOKEN = /(^|[_-])(create|update|delete|send|mark|move|confirm|append|edit|set|add|remove|insert|import|trash|untrash|modify|batch|enable|disable|complete|uncomplete|rename|save|export|transcribe|prune|block|unsubscribe|accept|decline|reply|forward|flag|login|logout|start|finish|raw)([_-]|$)/;
const READ_ALLOW = new Set(['gemini_grounding_search']);
// 以读前缀开头、但结果随 Mac 前台状态瞬变的工具，不缓存
const READ_DENY = new Set(['get-selected-notes']);

const readCache = new Map(); // key → { exp, size, value }
let readCacheChars = 0;
let readCacheGen = 0; // ★ 代际号：写失效 +1，在途读回填前校验，防写后读竞态回填旧数据

function readCacheTtl(env) {
  const raw = env?.MCP_READ_CACHE_TTL_MS;
  if (raw === undefined || raw === null || raw === '') return READ_CACHE_DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return READ_CACHE_DEFAULT_TTL_MS;
  return n > 0 ? n : 0;
}

export function isCacheableRead(service, name, args) {
  if (typeof name !== 'string' || !name) return false;
  if (args && typeof args === 'object' && Object.prototype.hasOwnProperty.call(args, 'confirm')) return false;
  if (READ_ALLOW.has(name)) return true;
  if (READ_DENY.has(name)) return false;
  const bare = service === 'reminders' && name.startsWith('reminders_') ? name.slice('reminders_'.length) : name;
  if (!READ_PREFIX.test(bare)) return false;
  return !WRITE_TOKEN.test(bare);
}

// 参数规范化：对象键递归排序，数组保序
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(x => canonicalJson(x === undefined ? null : x)).join(',') + ']';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

function readCacheKey(service, name, args) {
  return service + '\u0000' + name + '\u0000' + canonicalJson(args || {});
}

function readCacheDrop(key) {
  const e = readCache.get(key);
  if (!e) return;
  readCache.delete(key);
  readCacheChars -= e.size;
}

function readCacheGetEntry(key) {
  const e = readCache.get(key);
  if (!e) return undefined;
  if (e.exp <= Date.now()) { readCacheDrop(key); return undefined; }
  // LRU：命中挪到队尾
  readCache.delete(key);
  readCache.set(key, e);
  return e.value;
}

function readCacheSetEntry(key, value, size, ttl) {
  if (size > READ_CACHE_MAX_ENTRY_CHARS) return;
  readCacheDrop(key);
  readCache.set(key, { exp: Date.now() + ttl, size, value });
  readCacheChars += size;
  // 超条数或超总量：从最久未用的一端淘汰
  while (readCache.size > READ_CACHE_MAX_ENTRIES || readCacheChars > READ_CACHE_MAX_TOTAL_CHARS) {
    readCacheDrop(readCache.keys().next().value);
  }
}

function readCacheInvalidate(service) {
  // ★ 代际号 +1：在途读若晚于此刻完成，不得回填（见 cachedToolCall / proxyCacheStore）
  readCacheGen++;
  const prefix = service + '\u0000';
  for (const key of [...readCache.keys()]) if (key.startsWith(prefix)) readCacheDrop(key);
}

// 本 isolate 的 Worker 端点 tools/call：命中直接返回 result，未命中走 call() 并回填
async function cachedToolCall(env, service, name, args, call) {
  const ttl = readCacheTtl(env);
  if (!ttl) return call();
  if (!isCacheableRead(service, name, args)) {
    readCacheInvalidate(service);
    return call();
  }
  const key = readCacheKey(service, name, args);
  const hit = readCacheGetEntry(key);
  if (hit !== undefined) {
    console.log(`[read-cache] hit ${service} ${name}`);
    return hit;
  }
  console.log(`[read-cache] miss ${service} ${name}`);
  const gen = readCacheGen;
  const result = await call();
  const size = resultChars(result);
  // ★ 仅当代际未变（期间无写失效）才回填；否则丢弃，宁缺勿旧
  if (size >= 0 && gen === readCacheGen) readCacheSetEntry(key, result, size, ttl);
  return result;
}

// 成功结果的字符量；不该缓存的结果返回 -1
function resultChars(result) {
  if (!result || typeof result !== 'object' || result.isError) return -1;
  const content = Array.isArray(result.content) ? result.content : [];
  let n = 0;
  for (const c of content) {
    const t = c && (c.text ?? c.data);
    if (typeof t === 'string') {
      // textResult({ error: ... }) 渲染出的固定开头（JSON.stringify(obj, null, 2) 首键为 error）
      if (c.type === 'text' && t.startsWith('{\n  "error":')) return -1;
      n += t.length;
    }
  }
  return n;
}

// ---------- Mac 代理（notes / reminders）的缓存钩子：供 index.mjs 调用 ----------
// 上游返回的是完整 JSON-RPC 响应（JSON 或 SSE），缓存原文；命中时把 id 换成本次请求的 id。
export function proxyCacheLookup(env, service, rpc) {
  const ttl = readCacheTtl(env);
  if (!ttl || !rpc || typeof rpc !== 'object') return null;
  // ★ 批量请求（数组）：含任意非可缓存 tools/call（写操作或拿不准）时同样失效该端点缓存，
  //   此前数组路径直接 return null、绕过了失效逻辑（PiMoa 审查 MINOR 修复）
  if (Array.isArray(rpc)) {
    for (const m of rpc) {
      if (m && typeof m === 'object' && m.method === 'tools/call' && !isCacheableRead(service, m.params?.name, m.params?.arguments || {})) {
        readCacheInvalidate(service);
        break;
      }
    }
    return null;
  }
  if (rpc.method !== 'tools/call') return null;
  const name = rpc.params?.name;
  const args = rpc.params?.arguments || {};
  if (!isCacheableRead(service, name, args)) {
    readCacheInvalidate(service);
    return null;
  }
  const key = readCacheKey(service, name, args);
  const hit = readCacheGetEntry(key);
  if (hit !== undefined) {
    const text = rewriteRpcId(hit.text, hit.contentType, hit.id, rpc.id ?? null);
    if (text !== null) {
      console.log(`[read-cache] hit ${service} ${name}`);
      return { key, ttl, name, gen: readCacheGen, hit: { status: hit.status, contentType: hit.contentType, text } };
    }
  }
  console.log(`[read-cache] miss ${service} ${name}`);
  return { key, ttl, name, gen: readCacheGen, hit: null };
}

export function proxyCacheStore(slot, rpc, status, contentType, text) {
  if (!slot || status !== 200) return;
  const msg = singleRpcMessage(text, contentType);
  if (!msg || !('result' in msg) || msg.error || msg.result?.isError) return;
  if (JSON.stringify(msg.id ?? null) !== JSON.stringify(rpc.id ?? null)) return;
  // ★ 代际校验：发出请求后若发生过写失效（含批量请求触发的失效），旧结果不得回填
  if (slot.gen !== readCacheGen) return;
  readCacheSetEntry(slot.key, { status, contentType, text, id: rpc.id ?? null }, text.length, slot.ttl);
}

function isSse(contentType) { return /text\/event-stream/i.test(contentType || ''); }

// 取出响应里唯一的一条 JSON-RPC 消息；多条/解析失败返回 null（不缓存）
function singleRpcMessage(text, contentType) {
  try {
    if (!isSse(contentType)) {
      const m = JSON.parse(text);
      return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
    }
    const msgs = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    return msgs.length === 1 && msgs[0] && typeof msgs[0] === 'object' && !Array.isArray(msgs[0]) ? msgs[0] : null;
  } catch { return null; }
}

function rewriteRpcId(text, contentType, oldId, newId) {
  if (JSON.stringify(oldId) === JSON.stringify(newId)) return text;
  try {
    if (!isSse(contentType)) {
      const m = JSON.parse(text);
      m.id = newId;
      return JSON.stringify(m);
    }
    return text.split('\n').map(l => {
      if (!l.startsWith('data: ')) return l;
      const m = JSON.parse(l.slice(6));
      m.id = newId;
      return 'data: ' + JSON.stringify(m);
    }).join('\n');
  } catch { return null; }
}

// 测试钩子：清空缓存
export function _resetReadCache() {
  readCache.clear();
  readCacheChars = 0;
}
