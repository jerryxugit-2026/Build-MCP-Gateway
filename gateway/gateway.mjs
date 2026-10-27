#!/usr/bin/env node
// gateway.mjs — MCP 2026-07-28 (modern) HTTP → legacy stdio bridge. One process pool, many clients.
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { endpoints } from './endpoints.mjs';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = process.env.GW_ROOT ?? new URL('.', import.meta.url).pathname.replace(/\/$/, '');
if (!existsSync(ROOT)) { console.error(`[gateway] FATAL: ROOT ${ROOT} not accessible (volume unmounted?)`); process.exit(1); }
const LOG = `${ROOT}/logs/gateway.log`;
const MAX_BODY = 8 * 1024 * 1024;
const outboundContext = new AsyncLocalStorage();
const httpContext = new AsyncLocalStorage();
const BACKOFF = process.env.GW_ENDPOINTS_OVERRIDE && process.env.GW_TEST_BACKOFF_MS === '0'
  ? [0, 0, 0, 0, 0] : [30_000, 120_000, 480_000, 1_800_000, 3_600_000];
mkdirSync(`${ROOT}/logs`, { recursive: true });
function log(level, message) {
  try {
    if (statSync(LOG, { throwIfNoEntry: false })?.size > 10 * 1024 * 1024) {
      for (let i = 2; i >= 1; i--) {
        if (statSync(`${LOG}.${i}`, { throwIfNoEntry: false })) renameSync(`${LOG}.${i}`, `${LOG}.${i + 1}`);
      }
      renameSync(LOG, `${LOG}.1`);
    }
    appendFileSync(LOG, `${new Date().toISOString()} ${level} ${message}\n`);
  } catch (e) { console.error('gateway logging:', e); }
}
const states = new Map(endpoints.map(e => [e.name, {
  ...e, generation: 0, child: null, client: null, transport: null, pgid: null, lastExit: null, starting: null,
  fingerprint: null, cached: null, startedAt: 0, lastError: null,
  failures: 0, openUntil: 0, requestCount: 0, inflight: new Map(), tokens: new Map(),
  active: new Set(), responses: new Set(), staleResponses: new Set(), innerIds: new Map(), seq: 0, handler: null, nodeHandler: null,
}]));
function internal(message) { return Object.assign(new Error(message), { code: -32603 }); }
function groupKill(state) {
  const pid = state.pgid ?? state.transport?.pid;
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
}
function failChild(state, phase, detail) {
  if (!state.transport) return;
  state.lastError = `${phase}: ${detail}`;
  log('ERROR', `${state.name} generation=${state.generation} ${state.lastError}`);
  groupKill(state);
  state.pgid = null;
  state.client = null;
  state.child = null;
  state.transport = null;
  state.cached = null;
  state.handler = null;
  state.nodeHandler = null;
  for (const response of state.responses) state.staleResponses.add(response);
  for (const pending of state.inflight.values()) pending.reject?.(internal(`child ${phase} failure (${detail})`));
  state.innerIds.clear();
  if (phase === 'startup') {
    state.failures++;
    state.openUntil = Date.now() + BACKOFF[Math.min(state.failures - 1, BACKOFF.length - 1)];
    if (state.failures >= 5) {
      state.openUntil = Infinity; // Endpoint-only latch; /healthz?unlock= clears it.
      if (state.failures === 5) log('CRITICAL', `${state.name} five consecutive startup failures: circuit-open until unlock`);
    }
  } else state.openUntil = 0;
}
function fingerprint(capabilities) { return createHash('sha256').update(JSON.stringify(capabilities ?? {})).digest('hex'); }
async function ensureReady(state) {
  if (state.client && state.cached) return state;
  if (Date.now() < state.openUntil) throw internal(`${state.name} circuit-open: ${state.lastError}; unlock=/healthz?unlock=${state.name}`);
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const oldFingerprint = state.fingerprint;
    const oldResponses = [...state.staleResponses];
    const transport = new StdioClientTransport({
      command: '/usr/bin/python3',
      args: ['-c', 'import os,sys; os.setsid(); os.execv(sys.argv[1],sys.argv[1:])', state.wrapper, ...(state.args ?? [])],
      stderr: 'pipe', maxBufferSize: 16 * 1024 * 1024,
    });
    state.transport = transport;
    state.generation++;
    state.lastExit = null;
    transport.stderr?.on('data', chunk => log('CHILD', `${state.name}: ${String(chunk).trim().slice(0, 2048)}`));
    const client = new Client({ name: 'dsh-mcp-gateway', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' }, capabilities: {} });
    let stage = 'startup';
    const sdkStart = transport.start.bind(transport);
    transport.start = () => {
      const started = sdkStart();
      const proc = transport._process;
      state.pgid = proc?.pid ?? null;
      proc?.on('exit', (code, signal) => {
        if (state.transport !== transport) return; // A retired generation cannot tear down its successor.
        state.lastExit = { code, signal };
        failChild(state, stage, `exit code=${code ?? 'unknown'} signal=${signal ?? 'none'}`);
      });
      return started;
    };
    transport.onclose = () => {
      if (state.transport === transport) failChild(state, stage, `exit code=${state.lastExit?.code ?? 'unknown'} signal=${state.lastExit?.signal ?? 'unknown'}`);
    };
    try {
      await client.connect(transport); // One legacy initialize per child generation; SDK owns inner IDs.
      state.client = client;
      const sdkClose = transport.onclose;
      transport.onclose = () => {
        if (state.transport !== transport) return;
        sdkClose?.();
        if (state.transport === transport) failChild(state, stage, `exit code=${state.lastExit?.code ?? 'unknown'} signal=${state.lastExit?.signal ?? 'unknown'}`);
      };
      const send = transport.send.bind(transport);
      transport.send = message => {
        const entry = outboundContext.getStore();
        if (entry && message?.method && 'id' in message) {
          entry.innerId = message.id;
          state.innerIds.set(message.id, entry); // SDK-generated child ID → original outer connection/request.
        }
        return send(message);
      };
      const original = transport.onmessage;
      transport.onmessage = (message, ...rest) => {
        if (message?.method === 'notifications/progress') {
          const record = state.tokens.get(message.params?.progressToken);
          if (record && !record.cancelled) void record.ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { ...message.params, progressToken: record.originalToken },
          }).catch(() => {});
          original?.(message, ...rest); // SDK also needs progress to reset its inner request timeout.
          return;
        }
        if (message?.method === 'notifications/cancelled') {
          const entry = state.innerIds.get(message.params?.requestId);
          if (entry) void entry.ctx.mcpReq.notify({
            ...message, params: { ...message.params, requestId: entry.originalId },
          }).catch(() => {});
          else log('WARN', `${state.name} unmatched child cancellation requestId=${String(message.params?.requestId)}`);
          return;
        }
        if (message?.method && !('id' in message)) {
          for (const ctx of state.active) void ctx.mcpReq.notify(message).catch(() => {});
          return;
        }
        if (message?.method && 'id' in message) {
          void transport.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported reverse request: ${message.method}` } });
          return;
        }
        original?.(message, ...rest);
      };
      const tools = await client.listTools(undefined, { timeout: 30_000 });
      state.cached = { serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities(), tools, innerVersion: client.getNegotiatedProtocolVersion() };
      state.fingerprint = fingerprint(state.cached.capabilities);
      state.startedAt = Date.now();
      state.failures = 0;
      state.openUntil = 0;
      stage = 'runtime';
      // Preserve old HTTP exchanges until their requests settle, then close stale SSE responses.
      if (oldFingerprint && oldFingerprint !== state.fingerprint) {
        for (const response of oldResponses) {
          const retire = () => { if (!response.writableEnded && !response.destroyed) response.end(); };
          if ([...state.inflight.values()].some(p => p.response === response)) {
            const t = setInterval(() => {
              if (![...state.inflight.values()].some(p => p.response === response)) { clearInterval(t); retire(); }
            }, 100); t.unref();
          } else retire();
        }
      }
      state.staleResponses.clear();
      log('INFO', `${state.name} spawned generation=${state.generation} inner=${state.cached.innerVersion} tools=${tools.tools.length}`);
      return state;
    } catch (error) {
      failChild(state, 'startup', `exit code=${state.lastExit?.code ?? 'unknown'} ${error.message}`);
      throw internal(`${state.name} child startup failure (exit code=${state.lastExit?.code ?? 'unknown'}): ${error.message}`);
    }
  })().finally(() => { state.starting = null; });
  return state.starting;
}
async function forward(state, request, ctx) {
  await ensureReady(state);
  state.requestCount++;
  const originalId = ctx.mcpReq.id;
  const gatewayId = ++state.seq;
  const originalToken = request.params?._meta?.progressToken ?? ctx.mcpReq._meta?.progressToken;
  const token = originalToken === undefined ? undefined : `gw-${state.name}-${++state.seq}`;
  const params = structuredClone(request.params ?? {});
  if (token !== undefined) params._meta = { ...(params._meta ?? {}), progressToken: token };
  const entry = { ctx, response: httpContext.getStore(), originalId, gatewayId, originalToken, cancelled: false, reject: null };
  state.inflight.set(gatewayId, entry);
  if (token !== undefined) state.tokens.set(token, entry);
  state.active.add(ctx);
  const cancelled = () => { entry.cancelled = true; state.tokens.delete(token); };
  ctx.mcpReq.signal.addEventListener('abort', cancelled, { once: true });
  try {
    const result = await Promise.race([
      outboundContext.run(entry, () => state.client.request({ method: request.method, params }, { timeout: 300_000, signal: ctx.mcpReq.signal, resetTimeoutOnProgress: token !== undefined })),
      new Promise((_, reject) => { entry.reject = reject; }),
    ]);
    if (entry.cancelled) throw internal(`cancelled request ${originalId}`);
    return result;
  } catch (error) {
    if (entry.cancelled) { try { await ctx.mcpReq.notify({ method: 'notifications/cancelled', params: { requestId: originalId, reason: 'cancelled' } }); } catch { /* disconnected */ } }
    throw error;
  } finally {
    ctx.mcpReq.signal.removeEventListener('abort', cancelled);
    state.inflight.delete(gatewayId);
    if (entry.innerId !== undefined) state.innerIds.delete(entry.innerId);
    if (token !== undefined) state.tokens.delete(token);
    state.active.delete(ctx);
  }
}
function buildServer(state) {
  const caps = state.cached?.capabilities ?? {};
  const server = new McpServer({ name: state.cached?.serverInfo?.name ?? state.name, version: state.cached?.serverInfo?.version ?? '1.0.0' },
    { capabilities: { ...caps } });
  const low = server.server;
  low.setRequestHandler('tools/list', async () => state.cached.tools);
  low.setRequestHandler('tools/call', (req, ctx) => forward(state, req, ctx));
  const supported = [
    ...(caps.resources ? ['resources/list', 'resources/templates/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe'] : []),
    ...(caps.prompts ? ['prompts/list', 'prompts/get'] : []),
    ...(caps.completions ? ['completion/complete'] : []),
    ...(caps.logging ? ['logging/setLevel'] : []),
  ];
  for (const method of supported) low.setRequestHandler(method, (req, ctx) => forward(state, req, ctx));
  return server;
}
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
async function readBody(req) {
  if (req.method !== 'POST') return undefined;
  const chunks = []; let count = 0; let tooLarge = false;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > MAX_BODY) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) return { error: 413 };
  try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { error: 400 }; }
}
let stopping = false;
const servers = [];
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const s of servers) s.close();
  for (const state of states.values()) groupKill(state);
  await new Promise(resolve => setTimeout(resolve, 3100));
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
for (const state of states.values()) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${state.port}`);
    if (url.pathname === '/healthz' && req.method === 'GET') {
      const unlock = url.searchParams.get('unlock');
      if (unlock && states.has(unlock)) { const target = states.get(unlock); target.openUntil = 0; target.failures = 0; target.lastError = null; log('INFO', `unlock ${unlock}`); }
      json(res, 200, Object.fromEntries([...states].map(([name, s]) => [name, {
        status: s.openUntil > Date.now() ? 'circuit-open' : s.client ? 'spawned' : 'idle',
        generation: s.generation, 'last-error': s.lastError, uptime: s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
        '活跃会话数': s.active.size, '累计请求数': s.requestCount, innerVersion: s.cached?.innerVersion ?? null,
      }]))); return;
    }
    if (url.pathname !== '/mcp') { json(res, 404, { error: 'not found' }); return; }
    const incoming = await readBody(req);
    if (incoming?.error) { json(res, incoming.error, { error: incoming.error === 413 ? 'body too large' : 'malformed JSON' }); return; }
    try {
      // SDK modern handler is stateless per HTTP exchange; first server/discover itself starts child.
      if (req.method === 'POST') await ensureReady(state);
      if (!state.handler) {
        state.handler = createMcpHandler(() => buildServer(state), {
          legacy: 'reject', responseMode: 'sse', keepAliveMs: 15000, maxRequestBodySize: MAX_BODY,
          onerror: e => log('ERROR', `${state.name} HTTP: ${e.message}`),
        });
        state.nodeHandler = toNodeHandler(state.handler, { maxRequestBodySize: MAX_BODY });
      }
      state.responses.add(res);
      res.once('close', () => state.responses.delete(res));
      await httpContext.run(res, () => state.nodeHandler(req, res, incoming?.body));
    } catch (e) {
      log('ERROR', `${state.name} request: ${e.stack ?? e}`);
      if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', id: incoming?.body?.id ?? null, error: { code: -32603, message: e.message } });
      else res.end();
    }
  });
  server.on('error', e => { log('CRITICAL', `${state.name} listen: ${e.message}`); void shutdown(1); });
  server.listen(state.port, '127.0.0.1', () => log('INFO', `${state.name} listening 127.0.0.1:${state.port}`));
  servers.push(server);
}
