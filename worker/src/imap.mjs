// src/imap.mjs — IMAP（读写）+ SMTP（发信）最小实现，跑在 Cloudflare TCP sockets 上
// 2026-10-22
// 端点：imap.mail.me.com:993（隐式 TLS）· smtp.mail.me.com:465（隐式 TLS）

import { connect } from 'cloudflare:sockets';

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;
const SMTP_HOST = 'smtp.mail.me.com';
const SMTP_PORT = 587;  // 465 在 Cloudflare 出口被封；587 + STARTTLS 可用

// ---------- 套接字辅助 ----------
function openTls(host, port) {
  // 隐式 TLS：secureTransport='on'
  return connect({ hostname: host, port }, { secureTransport: 'on' });
}

class LineReader {
  constructor(stream) {
    this.reader = stream.getReader();
    this.buf = '';
  }
  async readLine() {
    while (!this.buf.includes('\n')) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('IMAP: 连接关闭');
      this.buf += new TextDecoder().decode(value);
    }
    const i = this.buf.indexOf('\n');
    const line = this.buf.slice(0, i).replace(/\r$/, '');
    this.buf = this.buf.slice(i + 1);
    return line;
  }
  async readLiteral(n) {
    while (this.buf.length < n) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('IMAP: 连接关闭');
      this.buf += new TextDecoder().decode(value);
    }
    const s = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return s;
  }
}

// ---------- IMAP 会话 ----------
export async function imapConnect(env) {
  const sock = openTls(IMAP_HOST, IMAP_PORT);
  const reader = new LineReader(sock.readable);
  const writer = sock.writable.getWriter();
  // 问候
  await reader.readLine();
  const send = async (line) => { await writer.write(new TextEncoder().encode(line + '\r\n')); };

  // LOGIN（iCloud 支持 AUTHENTICATE PLAIN 也支持 LOGIN）
  const tag = 'a001';
  const mailUser = env.ICLOUD_MAIL_ADDRESS || env.ICLOUD_EMAIL;
  await send(`${tag} LOGIN ${mailUser} ${env.ICLOUD_PASSWORD}`);
  const res = await readTagged(reader, tag);
  if (!res.ok) throw new Error(`IMAP LOGIN 失败：${res.lines.join(' ').slice(0, 200)}`);

  return { sock, reader, writer, send, seq: 2 };
}

async function readTagged(reader, tag) {
  const lines = [];
  let literal = null;
  for (;;) {
    let line = await reader.readLine();
    // 处理字面量（多行）：形如 xxx {N}
    const m = line.match(/\{(\d+)\}$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const lit = await reader.readLiteral(n);
      const tail = await reader.readLine(); // 字面量后还有一行
      lines.push({ text: line, literal: lit, tail });
      continue;
    }
    lines.push(line);
    if (line.startsWith(tag + ' ')) {
      const ok = line.startsWith(tag + ' OK');
      return { ok, lines };
    }
    if (line.startsWith('* BYE')) return { ok: false, lines };
  }
}

async function imapCmd(session, line) {
  const tag = 'a' + String(session.seq++).padStart(3, '0');
  await session.send(`${tag} ${line}`);
  return readTagged(session.reader, tag);
}

function parseFlags(text) {
  const m = text.match(/FLAGS \(([^)]*)\)/);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

// ---------- IMAP ENVELOPE 解析 ----------
// ENVELOPE (DATE SUBJECT FROM SENDER REPLY-TO TO CC BCC IN-REPLY-TO MESSAGE-ID)
// 每项为字符串 "..."、NIL 或地址列表 ((name nil local domain) ...)
function parseEnvelope(str) {
  let i = 0;
  const s = String(str);
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const readString = () => {
    skipWs();
    if (s.startsWith('NIL', i)) { i += 3; return ''; }
    if (s[i] === '"') {
      i++;
      let out = '';
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i + 1]; i += 2; continue; }
        if (s[i] === '"') { i++; return out; }
        out += s[i++];
      }
      return out;
    }
    // 地址列表或其它 token：跳到匹配的右括号
    if (s[i] === '(') {
      let depth = 0;
      const start = i;
      while (i < s.length) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      return parseAddrList(s.slice(start, i));
    }
    // 原子
    let out = '';
    while (i < s.length && !/[\s()]/.test(s[i])) out += s[i++];
    return out;
  };
  const parseAddrList = (txt) => {
    // ((name nil local domain) ...)
    const items = [];
    const re = /\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(txt))) {
      const parts = m[1].match(/"((?:\\.|[^"])*)"|NIL/g) || [];
      const vals = parts.map(p2 => p2 === 'NIL' ? '' : p2.slice(1, -1).replace(/\\(.)/g, '$1'));
      const [name, , local, domain] = vals;
      items.push(`${name ? name + ' <' : ''}${local}${domain ? '@' + domain : ''}${name ? '>' : ''}`);
    }
    return items.join(', ');
  };
  skipWs();
  if (s[i] !== '(') return { subject: '', from: '', to: '', date: '' };
  i++; // 跳过左括号
  const fields = [];
  for (let k = 0; k < 10; k++) {
    skipWs();
    if (s[i] === ')') break;
    fields.push(readString());
    skipWs();
    if (s[i] === ',') i++;
  }
  return {
    date: fields[0] || '',
    subject: fields[1] || '',
    from: fields[2] || '',
    to: fields[5] || '',
    cc: fields[6] || '',
    replyTo: fields[4] || '',
    messageId: fields[9] || '',
  };
}


// RFC2047 编码字解码（=?UTF-8?B?...?= / =?charset?Q?...?=）
function decodeMime(str) {
  if (!str) return '';
  return String(str).replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, enc, payload) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
        return new TextDecoder(charset.toLowerCase()).decode(bytes);
      }
      // Q 编码
      const q = payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return q;
    } catch { return payload; }
  });
}

// modified-UTF-7（IMAP 邮箱名编码）解码
function mutf7Decode(str) {
  return String(str).replace(/&([^-]*)-?/g, (_, enc) => {
    if (enc === '') return '&';
    const b64 = (enc + '===').slice(0, Math.ceil(enc.length / 4) * 4).replace(/-/g, '+').replace(/,/g, '/');
    try {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      // UTF-16BE 解码
      let out = '';
      for (let i = 0; i < bytes.length - 1; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    } catch { return `&${enc}-`; }
  });
}

function extractField(text, key) {
  const re = new RegExp(`${key}: (.*)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

export async function listMailboxes(env) {
  const s = await imapConnect(env);
  try {
    const r = await imapCmd(s, 'LIST "" "*"');
    const out = [];
    for (const l of r.lines) {
      const m = String(l).match(/\* LIST \(.*?\) ".*?" "(.*)"$/);
      if (m) out.push(mutf7Decode(m[1]));
    }
    return out;
  } finally { try { await imapCmd(s, 'LOGOUT'); } catch {} }
}

export async function searchMessages(env, { mailbox = 'INBOX', query, since, before, limit = 20, unread } = {}) {
  const s = await imapConnect(env);
  try {
    await imapCmd(s, `SELECT "${mailbox}"`);
    const parts = [];
    if (unread) parts.push('UNSEEN');
    if (since) parts.push('SINCE "' + since + '"');
    if (before) parts.push('BEFORE "' + before + '"');
    if (query) parts.push('TEXT "' + query.replace(/"/g, '\\"') + '"');
    const criteria = parts.length ? parts.join(' ') : 'ALL';
    const r = await imapCmd(s, `UID SEARCH ${criteria}`);
    const idsLine = r.lines.find(l => l.startsWith('* SEARCH')) || '* SEARCH';
    const uids = idsLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).slice(-limit);
    if (!uids.length) return { mailbox, count: 0, messages: [] };

    const fetch = await imapCmd(s, `UID FETCH ${uids.join(',')} (UID FLAGS ENVELOPE)`);
    const msgs = [];
    for (const l of fetch.lines) {
      const m = String(l).match(/^\* \d+ FETCH (.*)$/);
      if (!m) continue;
      const body = m[1];
      const uidM = body.match(/UID (\d+)/);
      const envM = body.match(/ENVELOPE \(([\s\S]*)\)/);
      const flags = parseFlags(body);
      const env = envM ? parseEnvelope('(' + envM[1] + ')') : {};
      msgs.push({ uid: uidM ? uidM[1] : '', subject: decodeMime(env.subject), from: decodeMime(env.from), date: env.date || '', flags, seen: flags.includes('\\Seen') });
    }
    return { mailbox, count: msgs.length, messages: msgs };
  } finally { try { await imapCmd(s, 'LOGOUT'); } catch {} }
}

export async function getMessage(env, { mailbox = 'INBOX', uid } = {}) {
  const s = await imapConnect(env);
  try {
    await imapCmd(s, `SELECT "${mailbox}"`);
    const r = await imapCmd(s, `UID FETCH ${uid} (UID FLAGS ENVELOPE BODY[TEXT])`);
    let msg = null;
    for (const l of r.lines) {
      const entry = typeof l === 'object' ? l : null;
      const text = entry ? entry.text : String(l);
      const m = text.match(/^\* \d+ FETCH (.*)$/);
      if (!m) continue;
      const body = m[1];
      const uidM = body.match(/UID (\d+)/);
      const envM = body.match(/ENVELOPE \(([\s\S]*)\)/);
      const flags = parseFlags(body);
      const env = envM ? parseEnvelope('(' + envM[1] + ')') : {};
      msg = {
        uid: uidM ? uidM[1] : '', subject: decodeMime(env.subject), from: decodeMime(env.from),
        to: decodeMime(env.to), cc: decodeMime(env.cc), date: env.date || '', flags,
        body: entry ? entry.literal : '',
      };
    }
    return msg || { error: '未找到该邮件' };
  } finally { try { await imapCmd(s, 'LOGOUT'); } catch {} }
}

export async function setFlags(env, { mailbox = 'INBOX', uid, seen, deleted, flagged } = {}) {
  const s = await imapConnect(env);
  try {
    await imapCmd(s, `SELECT "${mailbox}"`);
    const ops = [];
    if (seen !== undefined) ops.push(seen ? '+FLAGS (\\Seen)' : '-FLAGS (\\Seen)');
    if (flagged !== undefined) ops.push(flagged ? '+FLAGS (\\Flagged)' : '-FLAGS (\\Flagged)');
    if (deleted !== undefined) ops.push(deleted ? '+FLAGS (\\Deleted)' : '-FLAGS (\\Deleted)');
    if (!ops.length) return { ok: false, error: '没有任何标记变更' };
    const r = await imapCmd(s, `UID STORE ${uid} ${ops.join(' ')}`);
    return { ok: r.ok, uid, changes: ops };
  } finally { try { await imapCmd(s, 'LOGOUT'); } catch {} }
}

export async function deleteMessage(env, { mailbox = 'INBOX', uid } = {}) {
  const s = await imapConnect(env);
  try {
    await imapCmd(s, `SELECT "${mailbox}"`);
    await imapCmd(s, `UID STORE ${uid} +FLAGS (\\Deleted)`);
    const r = await imapCmd(s, 'EXPUNGE');
    return { ok: r.ok, uid, message: '已删除' };
  } finally { try { await imapCmd(s, 'LOGOUT'); } catch {} }
}

export async function moveMessage(env, { mailbox = 'INBOX', uid, target = 'Archive' } = {}) {
  const s = await imapConnect(env);
  try {
    await imapCmd(s, `SELECT "${mailbox}"`);
    // 先试 UID MOVE（IMAP4rev2 / Apple 扩展）
    let r = await imapCmd(s, `UID MOVE ${uid} "${target}"`);
    if (!r.ok) {
      await imapCmd(s, `UID COPY ${uid} "${target}"`);
      await imapCmd(s, `UID STORE ${uid} +FLAGS (\\Deleted)`);
      await imapCmd(s, 'EXPUNGE');
    }
    return { ok: true, uid, target };
  } finally { try { await imapCmd(s, 'LOGOUT'); } catch {} }
}

export async function createDraft(env, { to, subject, body } = {}) {
  const raw = buildRfc822({ to, subject, body });
  const s = await imapConnect(env);
  try {
    // IMAP APPEND 带字面量
    const tag = 'a' + String(s.seq++).padStart(3, '0');
    await s.send(`${tag} APPEND "Drafts" (\\Seen) {${raw.length}}`);
    // 等 + Go ahead
    await s.reader.readLine();
    await s.writer.write(new TextEncoder().encode(raw + '\r\n'));
    const r = await readTagged(s.reader, tag);
    return { ok: r.ok, message: r.ok ? '草稿已保存' : r.lines.join(' ').slice(0, 200) };
  } finally { try { await imapCmd(s, 'LOGOUT'); } catch {} }
}

function buildRfc822({ to, subject, body }) {
  const now = new Date().toUTCString();
  return [
    `From: ${process.env?.ICLOUD_FROM || (process.env?.ICLOUD_MAIL_ADDRESS || process.env?.ICLOUD_EMAIL || 'me')}`,
    `To: ${to || ''}`,
    `Subject: ${subject || ''}`,
    `Date: ${now}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body || '',
  ].join('\r\n');
}

// ---------- SMTP（发信） ----------
export async function sendMail(env, { to, subject, body, cc, bcc } = {}) {
  // 587 + STARTTLS：先明文握手，再升级 TLS
  let sock = connect({ hostname: SMTP_HOST, port: SMTP_PORT }, { secureTransport: 'starttls' });
  await sock.opened;
  let reader = new LineReader(sock.readable);
  let writer = sock.writable.getWriter();
  const send = async (line) => { await writer.write(new TextEncoder().encode(line + '\r\n')); };
  const readResp = async () => {
    const lines = [];
    for (;;) {
      const l = await reader.readLine();
      lines.push(l);
      if (/^\d{3} /.test(l)) return lines;
    }
  };

  const resp0 = await readResp(); // 220 问候
  if (!/^220/.test(resp0[0])) throw new Error('SMTP 问候失败');
  await send('EHLO icloud-mcp-worker');
  await readResp();
  await send('STARTTLS');
  await readResp();
  // 释放旧的 reader/writer 锁，再升级 TLS
  try { writer.releaseLock(); } catch {}
  try { reader.reader.releaseLock(); } catch {}
  sock = sock.startTls ? await sock.startTls() : sock;
  reader = new LineReader(sock.readable);
  writer = sock.writable.getWriter();
  await send('EHLO icloud-mcp-worker');
  await readResp();
  // AUTH PLAIN
  const mailUser = env.ICLOUD_MAIL_ADDRESS || env.ICLOUD_EMAIL;
  const auth = b64(new TextEncoder().encode(`\0${mailUser}\0${env.ICLOUD_PASSWORD}`));
  await send(`AUTH PLAIN ${auth}`);
  const authResp = await readResp();
  if (!/^235/.test(authResp[0])) throw new Error('SMTP 认证失败：' + authResp.join(' ').slice(0, 200));
  await send(`MAIL FROM:<${mailUser}>`);
  await readResp();
  const recipients = [to, cc, bcc].filter(Boolean).flatMap(x => String(x).split(','));
  for (const rcpt of recipients) {
    await send(`RCPT TO:<${rcpt.trim()}>`);
    await readResp();
  }
  await send('DATA');
  await readResp();
  const raw = buildRfc822({ to, subject, body });
  await send(raw.replace(/\r\n/g, '\r\n') + '\r\n.');
  const done = await readResp();
  await send('QUIT');
  return { ok: /^250/.test(done[0]), recipients, message: done.join(' ').slice(0, 200) };
}

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
