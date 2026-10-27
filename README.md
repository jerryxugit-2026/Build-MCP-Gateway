# Build-MCP-Gateway

**Where should an AI agent's tools live?** I moved mine four times in one week. Every move
was forced by something specific that broke. This repository is what is left: the code,
and the reasons.

**English** · [中文](#中文)

---

## The four moves

| Rev | Date | Where the tools went | What forced the move |
|---|---|---|---|
| A | 2026-10-19 | **A shared gateway on my Mac** | Three agent clients (DeepSeek Harness, Claude Code, Codex) each launched their own copy of every tool. One day six tools started at once and **all silently hung**: macOS gives a background service 256 file handles. The fix is one line — `NumberOfFiles: 10240` — and it carries a comment saying it must never be deleted. |
| B | 2026-10-21 | **A rented cloud VM** (2 vCPU / 8 GB, Ubuntu) | I wanted agents to work while my Mac was off. The same gateway, under systemd, shared by three clients; a Tailscale private network with an access list so only my own devices can reach it. |
| C | 2026-10-22 | **Removed the public entrance** | The VM bills by the minute and sleeps when idle. A permanently open public tunnel counts as activity, so the VM never slept: **≈ 76 € a month**. I tested three routes to a cheap public endpoint; all three were dead ends, and all three are written down so nobody walks them again. |
| D | 2026-10-22 → 23 | **A Cloudflare Worker** (free tier) | One assistant (Grok's main chat) cannot install software, speaks an older protocol version, and cannot send headers. So the Worker speaks both protocol versions and authenticates with OAuth 2.0 + PKCE. It now serves 11 endpoints / 347 tools to 10 agent clients. The local gateway was **kept as a cold standby**, not deleted. |

> The architecture is a fossil record of things that broke.

## No real accounts, keys or passwords in this repository

Everything that identifies a person or unlocks a service has been replaced with an obvious **mock**:

| What | Mock used here | Where you put the real one |
|---|---|---|
| Email / Apple ID | `someone@example.com` | `wrangler secret put ICLOUD_EMAIL` |
| Passwords (iCloud app-specific password) | `mock-abcd-efgh-ijkl-mnop` | `wrangler secret put ICLOUD_PASSWORD` |
| OAuth client IDs / secrets / refresh tokens | `mock-client-id…`, `mock-refresh-token-…` | `wrangler secret put <name>` |
| Access tokens for agents | `mock-static-token-000…` | `openssl rand -hex 32`, then `wrangler secret put STATIC_TOKEN` |
| Account labels | `personal`, `work` | rename to anything; they only select which secret to read |
| Private host names | `YOUR-MAC.YOUR-TAILNET.ts.net` | `MAC_BRIDGE_URL` |
| Worker name, OAuth client name, service label | `example-mcp-worker`, `example-oauth-client-id`, `com.example.mcp-gateway` | `wrangler.jsonc`, the launchd plist |

The complete list of settings, all mocked, is in [`worker/.dev.vars.example`](worker/.dev.vars.example).
Real values never go into code or into git: production values live only in Cloudflare secrets,
and the gateway keeps credentials inside each tool's own wrapper environment.
Before publishing, every file was checked against the real secret files on my machine
value by value; the check is part of how this repository was made, not an afterthought.

## What is in this repository

| Path | What it is |
|---|---|
| [`gateway/gateway.mjs`](gateway/gateway.mjs) | The shared gateway. Modern MCP (protocol `2026-07-28`) over HTTP in front; legacy stdio servers behind, started lazily, one process per endpoint shared by every client. Per-endpoint circuit breaker, `/healthz`, process-group cleanup (no orphans on stop). |
| [`gateway/endpoints.example.mjs`](gateway/endpoints.example.mjs) | The endpoint table. Copy to `endpoints.mjs`. |
| [`deploy/launchd.plist.example`](deploy/launchd.plist.example) | macOS service definition (auto-start, auto-restart, the `10240` file-handle fix). |
| [`worker/`](worker/) | The Cloudflare Worker: dual-protocol MCP endpoint (2025-11-25 + 2026-07-28), OAuth 2.0 + PKCE S256 for clients that cannot send headers, static bearer tokens for the rest. Calendar (CalDAV), contacts (CardDAV), mail (IMAP), Gmail, Google Calendar/Drive, Outlook (Graph), Gemini grounding. |

## Rules the gateway enforces (each one learned from an incident)

1. **Stateful servers never go in the shared table.** Two agents driving the same browser tab corrupt each other. Browsers get one stdio instance per client.
2. **Fail loud on the wrong protocol.** An old-protocol client gets a clear `Unsupported protocol version` error instead of a half-working session.
3. **`kill` is not stop.** Under `KeepAlive` the service comes back in ~10 s; a real stop is `launchctl bootout`. On stop the gateway reaps the whole process group (SIGTERM → 3 s → SIGKILL).
4. **The service program lives on the internal disk.** macOS `launchd` refuses to execute programs from an external volume (exit 78, reproducible); the tools themselves may live anywhere. Layered fix: launchd → node on the internal disk → spawn tools on the external disk.
5. **Credentials never live in the endpoint table.** They stay in each wrapper's environment (or Cloudflare secrets for the Worker).

## Quick start (gateway)

```bash
cd gateway
npm install
cp endpoints.example.mjs endpoints.mjs   # point entries at your stdio MCP wrappers
node gateway.mjs                         # GW_ROOT defaults to this directory (logs go to ./logs)
curl http://127.0.0.1:8810/healthz
```

Clients connect to `http://127.0.0.1:<port>/mcp` and must speak MCP `2026-07-28`
(for the official TypeScript client: `new Client(info, { versionNegotiation: { mode: 'auto' } })`).

**Verified on 2026-10-26** from this exact source tree: a modern client connected through the
gateway to a legacy (`2024-11-05`) stdio server, started lazily, and listed its 31 tools;
an old-protocol client was rejected with a clear error.

## Quick start (Worker)

```bash
cd worker
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars           # all MOCK values — replace with your own; production uses `wrangler secret put`
npm install && npx wrangler deploy
```

## Honest limits

- The gateway has run in daily use on macOS and Ubuntu since October 2026, but it has no
  standalone automated test suite in this repository; verification was done against the
  live deployment (`/healthz`, per-endpoint handshake, tool-count reconciliation).
- The Worker's tool set mirrors my own accounts. You will need your own OAuth clients and
  app passwords, and some tools are specific to services I use.

Built by Ziyang Xu (Jerry). MIT License.

---

<a id="中文"></a>

# 中文

**AI 智能体的工具应该放在哪里？** 我的工具一周里搬了四次家，每一次都是被一件具体的事逼着搬的。这个仓库是搬完之后留下的东西：代码，和理由。

| 版本 | 日期 | 搬到哪里 | 逼着搬的那件事 |
|---|---|---|---|
| A | 2026-10-19 | **Mac 上的共享网关** | 三个 AI 客户端各自拉起一整套工具；某天六个工具同时启动、**一声不响地全挂了**——macOS 只给后台服务 256 个文件句柄。修复就是配置里的一行 `10240`，旁边写着"这行永远不许删"。 |
| B | 2026-10-21 | **租了一台云虚拟机**（2 核 8G） | 想让 Mac 关机时 AI 也能干活。同一个网关跑在 systemd 下，三个客户端共用；Tailscale 私网 + 访问名单，只有我自己的设备进得来。 |
| C | 2026-10-22 | **拆掉公网入口** | 虚拟机按分钟计费、空闲会休眠；一直开着的公网隧道让它永不休眠，**约 76 欧元/月**。实测三条路全是死路，全部写进文档，免得以后有人再走一遍。 |
| D | 2026-10-22 → 23 | **Cloudflare Worker**（免费档） | Grok 主对话装不了软件、只会说旧版协议、发不了请求头 → Worker 同时说两版协议，用 OAuth 2.0 + PKCE 认证。现在 11 个端点、347 个工具服务 10 个 AI 客户端。本地那套**不删，留作冷备**。 |

> 这套架构，就是一部"坏过的东西"的化石记录。

## 本仓库不含任何真实账号、密钥或密码

所有能识别个人身份或解锁服务的信息，都已替换为一眼可辨的 **mock 假值**：邮箱用 `someone@example.com`，密码用 `mock-abcd-efgh-ijkl-mnop`，OAuth 客户端与刷新令牌用 `mock-…`，智能体访问令牌用 `mock-static-token-000…`，账号标签用 `personal` / `work`，私网主机名用 `YOUR-MAC.YOUR-TAILNET.ts.net`，Worker 名与服务名用 `example-…`。完整配置清单（全部为 mock）见 [`worker/.dev.vars.example`](worker/.dev.vars.example)。真实值只放在 Cloudflare secret 里，从不进代码、不进 git；发布前每个文件都与本机真实密钥文件逐值比对过。

上面的五条规则、快速上手与诚实边界，中文含义同英文部分。作者：徐子阳（Jerry）。MIT 许可证。
