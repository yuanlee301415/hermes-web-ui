# Hermes Studio 项目架构分析

> 本文档是 Hermes Studio 代码库的架构概述，用于快速理解项目结构与运行时装配。
> 详细规范见根目录 `ARCHITECTURE.md` 与 `DEVELOPMENT.md`。

## 1. 项目定位

**Hermes Studio**（npm 名 `hermes-web-ui`）是一个围绕 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的自托管 AI 控制台：Web UI + 本地运行时 + Electron 桌面应用三位一体。核心能力包括 agent 聊天、视觉化 workflow、模型/profile 管理、群聊、编码 agent、文件浏览、终端、语音（STT/TTS）、MCU 设备接入等。TypeScript monorepo，BSL-1.1 许可，要求 Node ≥ 23。

## 2. 总体分层

```
┌─────────────────────────────────────────────────────────┐
│  Electron 桌面壳 (packages/desktop)                     │
│  主进程：WebUI server 引导、runtime 管理、更新、浏览器自动化│
└──────────────┬──────────────────────────────────────────┘
┌──────────────▼──────────────────────────────────────────┐
│  Vue 3 客户端 (packages/client)                         │
│  views → components → stores(Pinia) → api/ → HTTP/Socket│
└──────────────┬──────────────────────────────────────────┘
┌──────────────▼──────────────────────────────────────────┐
│  Koa 服务端 (packages/server)                           │
│  routes → controllers → services → db(SQLite)           │
│  └─ Hermes 集成：agent-bridge(Python)、hermes CLI、gateway│
└─────────────────────────────────────────────────────────┘
```

请求流：浏览器加载 Koa 托管的 Vite 构建产物（SPA fallback）→ `client/src/api` 调 HTTP → `routes`（只注册路径）→ `controllers`（请求级校验）→ `services`（IO/领域逻辑）→ SQLite / Hermes 进程 / 文件系统。

## 3. Monorepo 包划分

| 包 | 职责 |
| --- | --- |
| `packages/client` | Vue 3 前端：hash 路由、Pinia stores、Naive UI、i18n（11 语言）、语音/主题 composables |
| `packages/server` | Koa API、JWT 认证、Socket.IO、SQLite stores、Hermes 运行时集成、LAN 发现 |
| `packages/desktop` | Electron 外壳（`main/` + `preload/`）：本地 WebUI server 引导、捆绑 Python/Node runtime 管理、自动更新、桌面浏览器自动化 |
| `packages/ekko-agent` | 内置轻量 agent 运行时：自带 memory 服务、多 provider 适配（anthropic/gemini/openai…）、tools、runtime |
| `packages/esp32-c3` | MCU 固件（PlatformIO，v1/v2），语音/设备交互的硬件端 |
| `packages/skills` | 随包分发的 Hermes skills（SKILL.md 格式，如 `apikey-image-gen`、`grok-image-to-video`），启动时注入 |
| `packages/website` | 营销/文档站点（独立 Vite 配置） |

## 4. 服务端分层（`packages/server/src`）

### 4.1 入口 `index.ts`（bootstrap）

装配顺序（理解整个服务端的关键）：

1. 初始化 SQLite stores（`db/hermes/init`）
2. 中间件链：security headers → CORS → bodyParser → 路由
3. 注册约 50 组路由（`routes/index.ts`：先公开路由，再 `requireUserJwt` + `resolveUserProfile` 认证中间件，后保护路由，代理类路由放最后）
4. 静态资源 + SPA fallback
5. WebSocket 装配：原生 WS（terminal、kanban-events、LAN peer）+ 共享 Socket.IO 实例上的多个 namespace（`/chat-run`、group-chat、workflow、pet-state）
6. 后台服务：gateway 自动拉起、agent bridge、skill 注入、Studio MCP 自动注入、LAN discovery、session deleter、provider 模型目录后台刷新

### 4.2 分层规则

**routes 保持薄、控制器管请求、services 拥有副作用**（文件/SQLite/Hermes profile/子进程/凭据）。路由不得堆积业务逻辑，客户端不得复制服务端持久化规则。

### 4.3 核心 services（体量最大的部分）

- `hermes/run-chat/` — 聊天执行核心：bridge run、coding-agent run、ekko run 三种模式，含 abort、上下文压缩、usage、SSE 工具流
- `hermes/agent-bridge/` — Node↔Python 桥接（Python 侧 `bridge_pool.py` 107KB、`bridge_server.py`），聊天经此驱动 Hermes agent
- `hermes/group-chat/` — Socket.IO 群聊（`index.ts` 90KB、`agent-clients.ts` 81KB）
- `workflow-manager.ts`（110KB）、`global-agent/server.ts`（88KB）、`outbound-relay-client.ts`（86KB）、`coding-agents.ts`（70KB）— 四大巨型 service
- `agent-runner/` — 编码 agent 适配层（anthropic/codex 的 proxy 与 SSE 流适配）
- `stt-providers/`、`tts-providers/` — 可插拔语音 provider（doubao、edge、openai、hermes-cloud、mimo）
- `hermes/hermes-cli.ts`、`gateway-runner.ts`、`profile-credentials.ts` — 与 Hermes CLI/gateway/profile 的进程级集成

### 4.4 数据层

`db/hermes`：SQLite schema + store（`sessions-db.ts` 62KB 为自有会话库，Hermes 的 state.db 只读用于历史 API）。

## 5. 前端结构（`packages/client/src`）

- `views/hermes/` — 路由级页面，`WorkflowView.vue` 183KB 是最大的单文件
- `components/hermes/` — 按域组织（chat、files、group-chat、kanban、models、settings、skills、workflow…）
- `stores/hermes/chat.ts` — 199KB 的巨型 Pinia store，承载聊天状态
- `api/hermes/` — 与服务端 controller 域一一对应的 API 封装，统一走 `api/client.ts`
- `composables/` — 语音识别/录音、主题、键盘等跨组件逻辑

前端强制约定：Composition API `<script setup lang="ts">`、Naive UI、所有用户可见文案进全部 locale 文件、组件样式 scoped。

## 6. 实时通信通道

| 通道 | 用途 |
| --- | --- |
| Socket.IO `/chat-run` | 聊天流式响应、工具轨迹 |
| Socket.IO `/group-chat` | 群聊房间 |
| Socket.IO workflow / pet-state | 工作流执行状态、桌面宠物 |
| 原生 WS `/api/hermes/terminal` | xterm 终端（node-pty） |
| 原生 WS `/api/hermes/kanban/events` | Kanban 事件推送 |
| UDP + WS LAN peer | 局域网设备发现与多端互联 |

## 7. 值得注意的架构特征

1. **Hermes 集成是"多通道"的**：聊天走 Python agent-bridge 进程、配置走 CLI/文件直改（YAML/JSON 编辑器 + 凭据注入）、gateway 由 WebUI 托管生命周期（`HERMES_WEB_UI_MANAGED_GATEWAY` 可控）。
2. **状态所有权严格分离**：Web UI 状态在 `~/.hermes-web-ui`（可被 `HERMES_WEB_UI_HOME` 覆盖），Hermes Agent 状态在 profile 目录，二者不混用；运行时数据不落在 `dist` 旁。
3. **桌面端是"自带 runtime"的分发**：`desktop-runtime.yml` 单独构建捆绑的 Python/Node/Hermes 源码，Electron 主进程负责解包、`pyvenv.cfg` rebase、版本管理与更新。
4. **脚手架纪律**：`npm run harness:check` 校验文档/CI/脚本一致性；e2e 用 Playwright + mock 后端；`openapi:generate` 由 tsoa 注解驱动。
5. **可观察到的风险点**：多个超大体量文件（chat store 199KB、ChatPanel 124KB、workflow-manager 110KB、agent-bridge Python 107KB），功能迭代快但聚合度高，改动时需注意冲突与可测性；`desktop` 与 `server` 存在一定的逻辑重叠（如 CLI 引导、状态路径处理）。

## 8. 工程验证面

`npm run harness:check`（文档/CI 一致性）→ `npm run test`（Vitest 单测）→ `npm run test:e2e`（Playwright）→ `npm run build`（vue-tsc + vite + 服务端 tsc + esbuild 打包），改动越小越应该选最小相关项迭代。

## 9. 后续可深入的方向

- agent-bridge 的 Node↔Python 通信协议
- run-chat 的三种执行模式（bridge / coding-agent / ekko）
- workflow 引擎的持久化与恢复机制（`recoverActiveRuns` 的 fail-closed 设计）
- 桌面端 runtime 管理（解包、`pyvenv.cfg` rebase、更新）
