// src/carddav.mjs — CardDAV 联系人客户端（vCard 3.0）
// 2026-10-22
import { dav } from './caldav.mjs';

const CARDBASE = 'https://contacts.icloud.com';

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
function xmlHrefInside(xml, wrapper) {
  const inner = xmlText(xml, wrapper);
  return inner ? xmlText(inner, 'href') : '';
}
function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
}
function abs(href) {
  if (!href) return '';
  try { return new URL(href, CARDBASE).toString(); } catch { return href; }
}

function propfindXml(prop) {
  const el = prop.includes(':') ? prop : 'd:' + prop;
  return `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><${el}/><d:displayname/><d:getetag/><d:resourcetype/><card:addressbook-description/></d:prop>
</d:propfind>`;
}

export async function discoverContacts(env) {
  const cache = caches.default;
  const key = new Request(`https://carddav-cache.internal/${env.ICLOUD_EMAIL}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const r1 = await dav(env, 'PROPFIND', `${CARDBASE}/`, propfindXml('current-user-principal'), 0, {}, CARDBASE);
  const x1 = await r1.text();
  const principal = xmlHrefInside(x1, 'current-user-principal') || '/';

  const r2 = await dav(env, 'PROPFIND', abs(principal), propfindXml('card:addressbook-home-set'), 0, {}, CARDBASE);
  const x2 = await r2.text();
  const home = xmlHrefInside(x2, 'addressbook-home-set') || principal;

  const out = { principal, home: abs(home) };
  await cache.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': 'public, max-age=3600' } }));
  return out;
}

export async function listAddressBooks(env) {
  const { home } = await discoverContacts(env);
  const r = await dav(env, 'PROPFIND', home, propfindXml('d:resourcetype'), 1, {}, CARDBASE);
  const xml = await r.text();
  const out = [];
  for (const resp of xmlAll(xml, 'response')) {
    const href = abs(decodeXml(xmlText(resp, 'href')));
    const name = decodeXml(xmlText(resp, 'displayname'));
    const isBook = /<(?:[a-z0-9]+:)?addressbook[\s/>]/i.test(resp);
    if (isBook) out.push({ href, name: name || '(未命名)' });
  }
  return out;
}

export async function searchContacts(env, bookHref, { query, limit = 50 } = {}) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop>
  <card:filter>
    <card:prop-filter name="FN"><card:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(query || '')}</card:text-match></card:prop-filter>
  </card:filter>
  <card:limit><card:nresults>${limit}</card:nresults></card:limit>
</card:addressbook-query>`;
  const r = await dav(env, 'REPORT', bookHref, body, 1, {}, CARDBASE);
  const xml = await r.text();
  const out = [];
  for (const resp of xmlAll(xml, 'response')) {
    const href = abs(decodeXml(xmlText(resp, 'href')));
    const vcf = xmlText(resp, 'address-data');
    const c = parseVCard(vcf);
    if (c) out.push({ ...c, href });
  }
  return out;
}

export async function getContact(env, href) {
  const r = await dav(env, 'GET', href, null, null, {}, CARDBASE);
  const vcf = await r.text();
  return { ...parseVCard(vcf), href: abs(href), etag: r.headers.get('etag') };
}

export async function createContact(env, bookHref, c) {
  const uid = `${crypto.randomUUID()}@icloud-mcp`;
  const vcf = buildVCard(uid, c);
  const href = abs(bookHref.replace(/\/$/, '') + '/' + uid + '.vcf');
  const r = await dav(env, 'PUT', href, vcf, null, { 'if-none-match': '*', 'content-type': 'text/vcard; charset=utf-8' }, CARDBASE);
  return { ok: r.ok, status: r.status, uid, href };
}

export async function updateContact(env, href, c, etag) {
  const existing = await getContact(env, href);
  const merged = { ...existing, ...c };
  const vcf = buildVCard(merged.uid || href.split('/').pop().replace(/\.vcf$/, ''), merged);
  const r = await dav(env, 'PUT', href, vcf, null, {
    'content-type': 'text/vcard; charset=utf-8',
    ...(etag ? { 'if-match': etag } : {}),
  }, CARDBASE);
  return { ok: r.ok, status: r.status };
}

export async function deleteContact(env, href, etag) {
  const r = await dav(env, 'DELETE', href, null, null, etag ? { 'if-match': etag } : {}, CARDBASE);
  return { ok: r.ok, status: r.status };
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildVCard(uid, c) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`];
  if (c.name) lines.push(`FN:${foldV(escV(c.name))}`);
  if (c.name) lines.push(`N:${foldV(escV(c.name))};;;;`);
  if (c.organization) lines.push(`ORG:${foldV(escV(c.organization))}`);
  if (c.title) lines.push(`TITLE:${foldV(escV(c.title))}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${foldV(escV(c.email))}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${foldV(escV(c.phone))}`);
  if (c.notes) lines.push(`NOTE:${foldV(escV(c.notes))}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}
function escV(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function unescV(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
function foldV(line) {
  const out = []; let s = line;
  while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
  out.push(s);
  return out.join('\r\n');
}

export function parseVCard(vcfRaw) {
  const vcf = decodeXml(vcfRaw || '');
  if (!vcf || !/BEGIN:VCARD/i.test(vcf)) return null;
  const raw = vcf.split(/\r?\n/);
  const flat = [];
  for (const ln of raw) {
    if (/^\s/.test(ln) && flat.length) flat[flat.length - 1] += ln.trim();
    else flat.push(ln);
  }
  const get = (name) => {
    const l = flat.find(x => x.toUpperCase().startsWith(name + ';') || x.toUpperCase().startsWith(name + ':'));
    return l ? unescV(l.slice(l.indexOf(':') + 1)).replace(/\r$/, '') : '';
  };
  return {
    uid: get('UID'),
    name: get('FN'),
    organization: get('ORG'),
    title: get('TITLE'),
    email: get('EMAIL'),
    phone: get('TEL'),
    notes: get('NOTE'),
  };
}
