// src/caldav.mjs — CalDAV/CardDAV 客户端 + iCalendar 构造/解析（最小实现）
// 2026-10-22

const CAL_BASE = 'https://caldav.icloud.com';
const CARDBASE = 'https://contacts.icloud.com';

function authHdr(env) {
  return 'Basic ' + btoa(`${env.ICLOUD_EMAIL}:${env.ICLOUD_PASSWORD}`);
}

export async function dav(env, method, url, body = null, depth = null, extra = {}, base = CAL_BASE) {
  const headers = {
    authorization: authHdr(env),
    'content-type': 'application/xml; charset=utf-8',
    ...extra,
  };
  if (depth !== null) headers['depth'] = String(depth);
  const abs = /^https?:/i.test(url) ? url : new URL(url, base).toString();
  const res = await fetch(abs, { method, headers, body: body ?? undefined, redirect: 'manual' });
  return res;
}

// ---------- XML 最小解析（命名空间无关） ----------
function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[a-z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}
function xmlAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<(?:[a-z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${tag}>`, 'gi');
  let m; while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function xmlHrefInside(xml, wrapperTag) {
  const inner = xmlText(xml, wrapperTag);
  if (!inner) return '';
  return decodeXml(xmlText(inner, 'href'));
}
function decodeXml(s) {
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
}
// ---------- 发现（带 1 小时缓存） ----------
export async function discover(env) {
  const cache = caches.default;
  const key = new Request(`https://caldav-cache.internal/${env.ICLOUD_EMAIL}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const r1 = await dav(env, 'PROPFIND', `${CAL_BASE}/`, propfindXml('current-user-principal'), 0);
  const x1 = await r1.text();
  const principal = xmlHrefInside(x1, 'current-user-principal') || '/';

  const r2 = await dav(env, 'PROPFIND', absolute(CAL_BASE, principal), propfindXml('c:calendar-home-set'), 0);
  const x2 = await r2.text();
  const home = xmlHrefInside(x2, 'calendar-home-set') || xmlHrefInside(x2, 'calendar-home') || principal;

  const out = { principal, home: absolute(CAL_BASE, home) };
  await cache.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': 'public, max-age=3600' } }));
  return out;
}
function absolute(base, href) {
  if (!href) return base + '/';
  try { return new URL(href, base).toString(); } catch { return base + href; }
}
function propfindXml(prop) {
  const el = prop.includes(':') ? prop : 'd:' + prop;
  return `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop><${el}/><d:displayname/><d:getetag/><d:resourcetype/><cs:getctag/><ic:calendar-color/></d:prop>
</d:propfind>`;
}

// ---------- 列日历 ----------
export async function listCalendars(env) {
  const { home } = await discover(env);
  const r = await dav(env, 'PROPFIND', home, `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><cs:getctag/></d:prop>
</d:propfind>`, 1);
  const xml = await r.text();
  const items = [];
  for (const resp of xmlAll(xml, 'response')) {
    const href = decodeXml(xmlText(resp, 'href'));
    const name = decodeXml(xmlText(resp, 'displayname'));
    const isCal = /<(?:[a-z0-9]+:)?calendar[\s/>]/i.test(resp);
    const comps = xmlAll(resp, 'comp').map(c => (c.match(/name="([^"]+)"/) || [])[1]).filter(Boolean);
    if (isCal) items.push({ href: absolute(CAL_BASE, href), name: name || '(未命名)', components: comps.length ? comps : ['VEVENT'] });
  }
  return items;
}

// ---------- 查询事件 ----------
export async function listEvents(env, calendarHref, { timeMin, timeMax, query, limit = 50 } = {}) {
  // Apple CalDAV 不给无 time-range 的全量查询；缺省用一年前→两年后的宽范围
  if (!timeMin && !timeMax) {
    const now = Date.now();
    timeMin = new Date(now - 365 * 86400e3).toISOString();
    timeMax = new Date(now + 730 * 86400e3).toISOString();
  }
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
      ${timeMin || timeMax ? `<c:time-range${timeMin ? ` start="${icalUtc(timeMin)}"` : ''}${timeMax ? ` end="${icalUtc(timeMax)}"` : ''}/>` : ''}
    </c:comp-filter></c:comp-filter>
  </c:filter>
  ${limit ? `<c:limit><c:nresults>${limit}</c:nresults></c:limit>` : ''}
</c:calendar-query>`;
  const r = await dav(env, 'REPORT', calendarHref, body, 1);
  // ★ MAJOR 6 修复：REPORT 失败要抛错，不能让错误响应被当空结果（会导致虚报空闲）
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`CalDAV REPORT ${r.status}：${txt.slice(0, 160)}`);
  }
  const xml = await r.text();
  const out = [];
  for (const resp of xmlAll(xml, 'response')) {
    const href = decodeXml(xmlText(resp, 'href'));
    const ics = xmlText(resp, 'calendar-data');
    const ev = parseVEvent(ics);
    if (ev) {
      if (query && !((ev.summary || '') + ' ' + (ev.description || '')).toLowerCase().includes(query.toLowerCase())) continue;
      out.push({ ...ev, href: absolute(CAL_BASE, href) });
    }
  }
  return out;
}

export async function getEvent(env, href) {
  const r = await dav(env, 'GET', href);
  // ★ 防护：GET 失败要抛错（避免错误响应被当事件解析）
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`CalDAV GET ${r.status}：${txt.slice(0, 160)}`);
  }
  const ics = await r.text();
  return { ...parseVEvent(ics), href: absolute(CAL_BASE, href), etag: r.headers.get('etag') };
}

export async function createEvent(env, calendarHref, ev) {
  const uid = `${crypto.randomUUID()}@icloud-mcp`;
  const ics = buildICS(uid, ev);
  const href = absolute(CAL_BASE, calendarHref.replace(/\/$/, '') + '/' + uid + '.ics');
  const r = await dav(env, 'PUT', href, ics, null, { 'if-none-match': '*', 'content-type': 'text/calendar; charset=utf-8' });
  return { ok: r.ok, status: r.status, uid, href };
}

// ★ 2026-10-25 update_event 合并式更新（修复"只传 start/end 清空标题/描述/地点"）
// 思路：GET 原 ICS → 只替换传入字段 → PUT 回写；VALARM/ATTENDEE/RRULE/SEQUENCE 等一切原样保留。
// 回归判据：只传 {start,end} 后 summary/description/location 不变；字段含 `$&`/`$$` 不变形；VALARM 存活。
export function mergeEventICS(ics, patch) {
  if (!/BEGIN:VEVENT/i.test(ics)) throw new Error('目标不是日历事件');
  const blocks = ics.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];
  if (blocks.length > 1) {
    throw new Error(`该对象含 ${blocks.length} 个 VEVENT（复发覆盖块），合并式更新不支持，避免改一半`);
  }
  // all_day 未传 → 从原文推断（防全天事件被改写成时刻形态）
  const isAllDay = patch.all_day !== undefined
    ? !!patch.all_day
    : /DTSTART[^:\r\n]*;VALUE=DATE/i.test(ics);
  const now = icalUtc(new Date());
  const esc = escIcs;
  const toDate = (iso) => String(iso).slice(0, 10).replace(/-/g, '');

  // DTSTART/DTEND：保留原 TZID 参数与本地钟点语义（延续 MAJOR 2 修复意图）
  const fmtWhen = (name, iso) => {
    if (isAllDay) return `${name};VALUE=DATE:${toDate(iso)}`;
    const orig = (ics.match(new RegExp(`^${name}[^\\r\\n]*$`, 'mi')) || [''])[0];
    const tzid = (orig.match(/TZID=([^:;\r\n]+)/i) || [])[1] || '';
    const s = String(iso || '');
    if (tzid && !s.endsWith('Z')) {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
      if (m) return `${name};TZID=${tzid}:${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}`;
    }
    return `${name}:${icalUtc(iso)}`;
  };

  return ics.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/i, (block) => {
    // VALARM 是子组件：只改头部属性区，不碰它
    const parts = block.split(/(?=BEGIN:VALARM)/i);
    let h = parts[0];
    const setProp = (name, line) => {
      const re = new RegExp(`^${name}[^:\\r\\n]*[:][^\\r\\n]*$`, 'mi');
      // ★ 函数式替换：字段值含 $&/$$ 等字符不被当作替换模式（字符串替换会注入）
      h = re.test(h)
        ? h.replace(re, () => line)
        : h.replace(/END:VEVENT|$/i, (m) => `${line}\r\n${m}`);
    };
    if (patch.summary !== undefined) setProp('SUMMARY', `SUMMARY:${esc(patch.summary)}`);
    if (patch.description !== undefined) setProp('DESCRIPTION', `DESCRIPTION:${esc(patch.description)}`);
    if (patch.location !== undefined) setProp('LOCATION', `LOCATION:${esc(patch.location)}`);
    if (patch.start !== undefined) setProp('DTSTART', fmtWhen('DTSTART', patch.start));
    if (patch.end !== undefined) setProp('DTEND', fmtWhen('DTEND', patch.end));
    setProp('DTSTAMP', `DTSTAMP:${now}`);
    setProp('LAST-MODIFIED', `LAST-MODIFIED:${now}`);
    const seq = Number((h.match(/^SEQUENCE:(\d+)/mi) || [, 0])[1]) + 1;
    setProp('SEQUENCE', `SEQUENCE:${seq}`);
    return [h, ...parts.slice(1)].join('');
  });
}

export async function updateEvent(env, href, ev, etag) {
  const g = await dav(env, 'GET', href);
  if (!g.ok) {
    const txt = await g.text().catch(() => '');
    throw new Error(`CalDAV GET ${g.status}：${txt.slice(0, 160)}`);
  }
  const serverEtag = etag || g.headers.get('etag');
  const ics = unfold(await g.text());
  const out = mergeEventICS(ics, ev);
  const r = await dav(env, 'PUT', href, out, null, {
    'content-type': 'text/calendar; charset=utf-8',
    ...(serverEtag ? { 'if-match': serverEtag } : {}),
  });
  if (!r.ok) throw new Error(`更新失败 ${r.status}${r.status === 412 ? '（事件已被其他端修改，请重试）' : ''}`);
  return { ok: true, status: r.status };
}

export async function deleteEvent(env, href, etag) {
  const r = await dav(env, 'DELETE', href, null, null, etag ? { 'if-match': etag } : {});
  return { ok: r.ok, status: r.status };
}

// ---------- iCalendar ----------
function icalUtc(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
export function buildICS(uid, ev) {
  const dtstamp = icalUtc(new Date());
  const allday = !!ev.all_day;
  // ★ MAJOR 2 补充：带 TZID 的本地时间**不要**转 UTC（保持本地钟点）
  const dt = (v, tzid) => {
    if (allday) return icalUtc(v).slice(0, 8);
    const str = String(v || '');
    // 已是 UTC（带 Z）→ 直接转
    if (str.endsWith('Z')) return icalUtc(v);
    // 无 Z 且有 TZID → 保持本地时间格式（YYYYMMDDTHHMMSS）
    if (tzid) {
      const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
      if (m) return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}`;
    }
    return icalUtc(v);
  };
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//icloud-mcp//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART${allday ? ';VALUE=DATE' : ''}${ev.startTzid && !allday ? ';TZID=' + ev.startTzid : ''}:${dt(ev.start, ev.startTzid)}`,
    `DTEND${allday ? ';VALUE=DATE' : ''}${(ev.endTzid || ev.startTzid) && !allday ? ';TZID=' + (ev.endTzid || ev.startTzid) : ''}:${dt(ev.end, ev.endTzid || ev.startTzid)}`,
  ];
  if (ev.summary) lines.push(fold(`SUMMARY:${escIcs(ev.summary)}`));
  if (ev.description) lines.push(fold(`DESCRIPTION:${escIcs(ev.description)}`));
  if (ev.location) lines.push(fold(`LOCATION:${escIcs(ev.location)}`));
  // ★ MAJOR 2 修复：写入侧支持 RRULE
  if (Array.isArray(ev.recurrence)) {
    for (const r of ev.recurrence) {
      const rule = String(r).startsWith('RRULE:') ? String(r) : 'RRULE:' + r;
      lines.push(rule);
    }
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
function escIcs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// RFC 5545 行折叠还原（长 DESCRIPTION 折行会被误匹配/截断）
function unfold(s) {
  return String(s).replace(/\r?\n[ \t]/g, '');
}
function fold(line) {
  const out = [];
  let s = line;
  while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
  out.push(s);
  return out.join('\r\n');
}
// iCalendar 时间（20261022T100000Z / 20261022）→ ISO8601
export function icsToIso(v) {
  const str = String(v || '').trim();
  if (!str) return '';
  const d = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (d) return `${d[1]}-${d[2]}-${d[3]}`;
  const t = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (t) {
    const [, Y, M, D, h, m, sec, z] = t;
    return `${Y}-${M}-${D}T${h}:${m}:${sec}${z === 'Z' ? 'Z' : ''}`;
  }
  return str;
}

export function parseVEvent(ics) {
  if (!ics || !/BEGIN:VEVENT/i.test(ics)) return null;
  const body = ics.split(/\r?\n/);
  const flat = [];
  for (const raw of body) {
    if (/^\s/.test(raw) && flat.length) flat[flat.length - 1] += raw.trim();
    else flat.push(raw);
  }
  // ★ MAJOR 3 修复：只在 VEVENT 块内查找（VTIMEZONE 的 STANDARD/DAYLIGHT 也有 DTSTART，会污染）
  const inEvent = [];
  let inVevent = false;
  for (const ln of flat) {
    const up = ln.toUpperCase();
    if (up.startsWith('BEGIN:VEVENT')) { inVevent = true; continue; }
    if (up.startsWith('END:VEVENT')) { inVevent = false; continue; }
    if (inVevent) inEvent.push(ln);
  }
  const scope = inEvent.length ? inEvent : flat;
  const get = (name) => {
    const l = scope.find(x => x.toUpperCase().startsWith(name + ';') || x.toUpperCase().startsWith(name + ':'));
    return l ? unescIcs(l.slice(l.indexOf(':') + 1)) : '';
  };
  const allDay = scope.some(x => /^DTSTART;VALUE=DATE/i.test(x));
  return {
    uid: get('UID'),
    summary: get('SUMMARY'),
    description: get('DESCRIPTION'),
    location: get('LOCATION'),
    // ★ 规范化为 ISO（S1 修复：findFreeSlots/searchEvents 需要）
    start: icsToIso(get('DTSTART')),
    end: icsToIso(get('DTEND')),
    // 保留原始串（调用方需要时区时用）
    startRaw: get('DTSTART'),
    endRaw: get('DTEND'),
    startTzid: tzidOf(scope.find(x => /^DTSTART/i.test(x)) || ''),
    endTzid: tzidOf(scope.find(x => /^DTEND/i.test(x)) || ''),
    all_day: allDay,
    allDay,
    recurrence: scope.filter(x => /^RRULE/i.test(x)).map(x => x.slice(x.indexOf(':') + 1)),
  };
}

function tzidOf(line) {
  const m = line.match(/TZID=([^;:]+)/i);
  return m ? m[1].replace(/^"|"$/g, '') : '';
}
function unescIcs(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// ═══════════════════════ S1 新增：能力与查询工具 ═══════════════════════

// icloud_capabilities：返回服务能力面（agent 自检用）
export async function icloudCapabilities(env) {
  return {
    protocols: {
      caldav: { available: true, url: 'https://caldav.icloud.com', note: '日历读写' },
      carddav: { available: true, url: 'https://contacts.icloud.com', note: '联系人读写' },
      imap: { available: true, host: 'imap.mail.me.com', port: 993, note: '邮件读写' },
      smtp: { available: true, host: 'smtp.mail.me.com', port: 587, note: '发信（465 被封，用 587+STARTTLS）' },
    },
    limits: {
      notes: { available: false, reason: 'Apple 无公开 Notes API，只能在 macOS 上用 AppleScript（经 Mac 代理暴露）' },
      reminders: { available: 'legacy-only', reason: 'CalDAV VTODO 只覆盖旧版提醒列表；新版提醒需 macOS EventKit（经 Mac 代理暴露）' },
      mail_delete: { available: true, semantic: '软删（进垃圾箱），需 confirm: true' },
    },
    auth: {
      caldav_carddav: 'App 专用密码（Apple ID）',
      imap_smtp: 'App 专用密码（iCloud 邮箱 @me.com，与 Apple ID 不同）',
    },
  };
}

// calendar_capabilities：查日历的可写性/组件/时区
export async function calendarCapabilities(env, calendarHref) {
  const cals = await listCalendars(env);
  const targets = calendarHref ? cals.filter(c => c.href === calendarHref) : cals;
  const out = [];
  for (const cal of targets) {
    out.push({
      href: cal.href,
      name: cal.name,
      components: cal.components || [],
      // ★ MAJOR 2 修复：区分"服务端能力"与"当前工具实际支持"
      serverCapabilities: {
        canWrite: true,  // CalDAV PUT/DELETE 走 App 密码，服务端层面可写
        canCreateEvents: (cal.components || []).includes('VEVENT'),
      },
      toolSupport: {
        createEvent: true,
        updateEvent: true,
        deleteEvent: true,
        recurring: true,      // buildICS 已支持写 RRULE（S1 第三轮修复）
        attachments: false,
        alarms: false,
        timezones: 'passthrough',  // TZID 透传给目标 API，但不做时区换算
      },
      notes: '读取侧支持 recurrence 解析；写入侧暂不支持生成 RRULE'
    });
  }
  return { calendars: out };
}

// findFreeSlots：忙闲计算
// ★ MAJOR 5 已知限制：CalDAV REPORT 不展开重复事件实例；
//   findFreeSlots 和 search_events 对重复事件只算"首个实例"，可能漏掉重复发生时段。
//   如需精确，将来可加 expand-recurrence-set 或在客户端按 RRULE 展开。
export async function findFreeSlots(env, { start, end, duration = 30, calendarId, workStart, workEnd }) {
  const limitations = ['重复事件（RRULE）只算首个实例，可能漏掉重复发生时段'];
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { valid: false, error: 'start/end 无法解析为时间' };
  }
  if (endMs <= startMs) return { valid: false, error: 'end 必须晚于 start' };
  const durMs = Math.max(1, Number(duration) || 30) * 60000;

  // 拉事件（用 ISO 字符串给 listEvents）
  const iso = (ms) => new Date(ms).toISOString();
  const evs = await listEvents(env, calendarId || (await defaultCalendarHref(env)), {
    timeMin: iso(startMs), timeMax: iso(endMs), limit: 500,
  });

  // ★ MAJOR 4 修复：iCalendar 时间串先规范化为 ISO，再 Date.parse
  //   （否则 20261022T090000Z / 20261022 解析失败 → 忙事件被过滤 → 虚报空闲）
  // ★ MAJOR 1 修复：带 TZID 的本地时间要换算到 UTC（不能直接补 Z）
  const toMs = (v, isAllDay, tzid) => {
    if (!v) return NaN;
    let iso = icsToIso(v);
    if (!iso) return NaN;
    if (iso.length === 10) { iso += 'T00:00:00Z'; return Date.parse(iso); }
    if (iso.endsWith('Z')) return Date.parse(iso);
    // 无 Z：如果有 TZID，按该时区解析；否则按 UTC
    if (tzid) return parseWithTz(iso, tzid);
    return Date.parse(iso + 'Z');
  };
  const busy = evs.map(e => {
    const tz = e.startTzid || '';
    let s = toMs(e.start, e.all_day, tz);
    let en = toMs(e.end, e.all_day, e.endTzid || tz);
    if (!Number.isFinite(s)) return null;
    if (!Number.isFinite(en) || en <= s) en = s + (e.all_day ? 86400e3 : 3600e3);
    // ★ 裁剪到查询窗口（重复事件用原始 DTSTART 会落窗外，需裁剪）
    s = Math.max(s, startMs);
    en = Math.min(en, endMs);
    return en > s ? [s, en] : null;
  }).filter(Boolean).sort((a, b) => a[0] - b[0]);
  // 统计被丢弃的事件数（供调用方判断可信度）
  const unparseable = evs.filter(e => !Number.isFinite(toMs(e.start, e.all_day, e.startTzid || ''))).length;

  // 合并重叠
  const merged = [];
  for (const iv of busy) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }

  // 扫空档（限制在工作时间内）
  // ★ MAJOR 1 修复：工作时间按 UTC 解释（明示于返回值）；如需本地时区由调用方换算
  const ws = (workStart === undefined || workStart === null) ? 0 : Number(workStart);
  const we = (workEnd === undefined || workEnd === null) ? 24 : Number(workEnd);
  const allSlots = [];
  let cur = startMs;
  for (const [bs, be] of merged) {
    const from = Math.max(cur, startMs);
    const to = Math.min(bs, endMs);
    if (to - from >= durMs) pushSlots(allSlots, from, to, durMs, ws, we);
    cur = Math.max(cur, be);
  }
  if (endMs - cur >= durMs) pushSlots(allSlots, cur, endMs, durMs, ws, we);
  // ★ MINOR 修复：total 是全量计数，slots 只是截断后的前 50 个
  const slots = allSlots.slice(0, 50);

  return {
    valid: true,
    start, end, duration_minutes: duration,
    // ★ MAJOR 1 修复：明示工作时间按 UTC 计算；如需本地时区，调用方先把工作时间换算成 UTC
    timezone_semantics: 'working_hours_start/end 按 UTC 解释；如需本地时区请自行换算',
    busy_intervals: merged.map(([s, e]) => ({ start: iso(s), end: iso(e) })),
    free_slots: slots.slice(0, 50),
    // ★ MINOR 修复：total_free_slots 是"截断前的真实总数"（pushSlots 全量累加后才截断）
    total_free_slots: allSlots.length,
    truncated: allSlots.length > 50,
    // ★ MAJOR 4 附加：丢弃的事件数（> 0 说明有事件时间解析失败，空闲报告可信度下降）
    unparseable_events: unparseable,
    ...(unparseable > 0 ? { warning: `${unparseable} 个事件的时间无法解析，已忽略；空闲可能偏多` } : {}),
    limitations,
  };
}

// 在 [from,to) 里扫出长度 ≥ durMs 的空档，且落在 [ws,we) 工作时间内
function pushSlots(out, from, to, durMs, ws, we) {
  // 逐日切分，套用工作时间窗口
  const DAY = 86400e3;
  for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) {
    const wStart = day + ws * 3600e3;
    const wEnd = day + we * 3600e3;
    const s = Math.max(from, wStart, day);
    const e = Math.min(to, wEnd, day + DAY);
    if (e - s >= durMs) {
      // 以 durMs 为粒度切槽
      for (let t = s; t + durMs <= e; t += durMs) {
        out.push({ start: new Date(t).toISOString(), end: new Date(t + durMs).toISOString() });
      }
    }
  }
}

/** 用 Intl 把「本地时间字符串 + IANA 时区」换算成 UTC 毫秒 */
function parseWithTz(localIso, tzid) {
  try {
    // localIso 形如 2026-10-24T09:00:00（无 Z）
    const m = localIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return NaN;
    const [, Y, M, D, h, mi, sec] = m.map(Number);
    // 用 Intl 找该时区在此刻的 UTC 偏移
    const guess = Date.UTC(Y, M - 1, D, h, mi, sec);
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    const offset = asUtc - guess;  // 该时刻的时区偏移
    return guess - offset;
  } catch { return NaN; }
}

async function defaultCalendarHref(env) {
  const cals = await listCalendars(env);
  const cal = cals.find(c => (c.components || []).includes('VEVENT') && !/提醒|tasks|reminders/i.test(c.name || '')) || cals[0];
  return cal ? cal.href : '';
}

// searchEvents：关键词搜索（匹配 summary/description/location）
export async function searchEvents(env, { query, timeMin, timeMax, calendarId, limit = 20 }) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const tm = timeMin || iso(now - 30 * 86400e3);
  const tx = timeMax || iso(now + 90 * 86400e3);
  const kw = String(query || '').toLowerCase();

  const cals = calendarId
    ? (await listCalendars(env)).filter(c => c.href === calendarId)
    : (await listCalendars(env)).filter(c => (c.components || []).includes('VEVENT') && !/提醒|tasks|reminders/i.test(c.name || ''));

  const out = [];
  for (const cal of cals) {
    const evs = await listEvents(env, cal.href, { timeMin: tm, timeMax: tx, limit: 500 });
    for (const e of evs) {
      const hay = `${e.summary || ''} ${e.description || ''} ${e.location || ''}`.toLowerCase();
      if (!kw || hay.includes(kw)) {
        out.push({
          uid: e.uid,
          summary: e.summary,
          description: (e.description || '').slice(0, 200),
          location: e.location || '',
          start: e.start,
          end: e.end,
          all_day: !!e.all_day,
          calendar: cal.name,
          href: e.href || null,
        });
      }
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  // 按时间排序
  out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { query, count: out.length, events: out.slice(0, limit) };
}

// validateEvent：字段校验
export function validateEvent({ start, end, summary, allDay, recurrence, timezone }) {
  const errors = [];
  const warnings = [];

  // 1) 必填
  if (!start) errors.push('缺 start');
  if (!end) errors.push('缺 end');
  if (!summary || !String(summary).trim()) warnings.push('summary 为空（建议填标题）');

  // 2) 时间解析 + 倒挂
  const sMs = Date.parse(start && String(start).length === 10 ? start + 'T00:00:00Z' : (start || ''));
  const eMs = Date.parse(end && String(end).length === 10 ? end + 'T00:00:00Z' : (end || ''));
  if (start && !Number.isFinite(sMs)) errors.push(`start 无法解析：${start}`);
  if (end && !Number.isFinite(eMs)) errors.push(`end 无法解析：${end}`);
  if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs < sMs) errors.push('end 早于 start');
  if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs === sMs && !allDay) warnings.push('end 等于 start（非全天事件应有正时长）');

  // 3) 全天事件
  if (allDay && start && String(start).length !== 10) warnings.push('全天事件的 start 应为 YYYY-MM-DD 格式');

  // 4) 早年事件（Graph 会拒）
  if (Number.isFinite(sMs)) {
    const y = new Date(sMs).getFullYear();
    if (y < 1900) warnings.push(`start 年份 ${y} 过早（Microsoft Graph 会拒绝，同步时会钳到 1900）`);
    if (y > 2050) warnings.push(`start 年份 ${y} 过远（部分 API 会拒绝）`);
  }

  // 5) RRULE
  if (recurrence && recurrence.length) {
    for (const r of recurrence) {
      const ruleStr = String(r).startsWith('RRULE:') ? String(r).slice(6) : String(r);
      if (!/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY|HOURLY|MINUTELY|SECONDLY)/i.test(ruleStr)) {
        errors.push(`RRULE 缺 FREQ：${r}`);
      }
      // ★ MAJOR 3 修复：BYDAY 逐项校验（不能只匹配到首个合法星期就放过）
      const byday = ruleStr.match(/BYDAY=([^;]*)/i);
      if (byday) {
        for (const item of byday[1].split(',').map(x => x.trim()).filter(Boolean)) {
          if (!/^[+-]?\d{0,2}(MO|TU|WE|TH|FR|SA|SU)$/i.test(item)) {
            errors.push(`RRULE 的 BYDAY 项不合法：${item}（全串 ${r}）`);
          }
        }
      }
      if (/UNTIL=/i.test(ruleStr)) {
        const u = ruleStr.match(/UNTIL=(\d{4})(\d{2})(\d{2})/);
        if (u) {
          const uy = parseInt(u[1], 10);
          if (uy < 1900) warnings.push(`RRULE 的 UNTIL 年份 ${uy} 过早`);
          if (uy > 2050) warnings.push(`RRULE 的 UNTIL 年份 ${uy} 过远（Graph 会转 noEnd）`);
        }
      }
    }
  }

  // 6) 时区
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      errors.push(`timezone 不是有效 IANA 名：${timezone}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalized: {
      start: Number.isFinite(sMs) ? new Date(sMs).toISOString() : start,
      end: Number.isFinite(eMs) ? new Date(eMs).toISOString() : end,
      all_day: !!allDay,
      summary: summary || '',
    },
  };
}
