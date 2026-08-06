# packages/client 分析

> 生成时间：2025 年，基于当前工作区代码。
> 范围：`packages/client` 整体架构 + `stores/hermes/chat.ts` 深入分析。

## 1. 定位

`packages/client` 是 hermes-web-ui 的前端单页应用（SPA），**没有独立的 `package.json`**——由仓库根目录统一管理依赖与脚本，Vite 的 `root` 直接指向 `packages/client`，构建产物输出到 `dist/client`。

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Vue 3.5（Composition API + `<script setup>`，无 Options API） |
| 状态 | Pinia 3（按领域拆分 store） |
| 路由 | Vue Router 4，**hash 模式**（`createWebHashHistory`） |
| UI 库 | Naive UI（全局 Provider 包裹）+ 自写 SCSS |
| 国际化 | Vue I18n 11，10 种语言（en/zh/zh-TW/ja/ko/fr/de/es/ru/pt） |
| 富文本 | markdown-it + highlight.js + KaTeX + mermaid |
| 其他重型依赖 | monaco-editor（代码编辑）、@xterm/xterm（终端）、vue-virtual-scroller |

## 3. 目录职责

- **`main.ts`** — 入口：挂载前先应用主题 class 防 FOUC、从 URL/hash 提取 `token`、`router.isReady()` 后才 mount
- **`api/`** — 分层清晰：
  - `client.ts`：通用 `request()` 封装（fetch + Bearer 认证 + `X-Hermes-Profile` 注入 + 全局 401/403 处理与登出跳转）
  - `hermes/`：按后端领域拆分的 30+ 个模块（chat、sessions、kanban、mcp、tts/stt、profiles、jobs…）
- **`stores/hermes/`** — Pinia store，核心是 `chat.ts`（**3946 行 / 162KB**），其余为辅助 store
- **`components/`** — 按领域嵌套（`hermes/chat`、`hermes/settings`、`hermes/kanban`…），含 layout（AppSidebar、主题/语言/模型选择器）
- **`composables/`** — 语音相关居多（`useSpeech`、`useSttSettings`、`useVoiceApiConnections`、`useMicRecorder`…）
- **`views/hermes/`** — 25+ 个路由页面
- **`i18n/locales/`** — 每个语言文件 88–116KB，体量很大
- **`styles/`** — SCSS + `theme.ts`（Naive UI 主题覆盖）

## 4. 路由与鉴权

- 约 25 条路由，全部懒加载（`() => import()`）
- `router.beforeEach` 守卫：`public` 路由免认证；其余要求 `hasApiKey()`；`requiresSuperAdmin` 路由（profiles、performance、version-preview、mcp）做本地 JWT payload 解码校验（仅前端 UI 守卫，真正的权限在服务端）
- 支持 `hermesDesktop` 桌面壳检测（Electron 环境）

## 5. 构建配置（vite.config.ts）

- `@` 别名 → `packages/client/src`
- 手动 chunk 拆分：`monaco-editor`、`mermaid`、`xterm`、`vue-vendor`、`ui-vendor`、`vendor`，利于缓存与首屏
- dev server 将 `/api`、`/v1`、`/socket.io`（含 ws）代理到后端 8648 端口，并剥离 origin/referer 头
- 开发端口 8649，后端 8647/8648

## 6. 值得注意的点

1. **超大单体文件**：`chat.ts` store 162KB / 3946 行；`MessageItem.vue` 83KB、`ChatPanel.vue` 78KB、`ChatInput.vue` 51KB、`GroupChatPanel.vue` 49KB——远超组件合理粒度，维护和测试成本高，是后续重构的首要候选。
2. **认证凭据存 localStorage**（`hermes_api_key`、`hermes_server_url`），受 XSS 影响面大；但本地 token 解码仅做 UI 层守卫，符合"服务端鉴权"的安全底线。
3. **测试**：`packages/client` 内没有测试文件，覆盖在仓库根的 `tests/client`（73 个文件，Vitest）。
4. **i18n 文件体积大**（10 语言 × ~100KB），建议按页面做懒加载（当前是整体打包）。
5. **API 层有细微的 profile 注入逻辑**（`X-Hermes-Profile` 头 + 一组排除路径），属于领域规则，改动时需谨慎。

---

# chat store 深入分析

`packages/client/src/stores/hermes/chat.ts` — 3946 行 / 162KB，**setup 风格** Pinia store（`defineStore('chat', () => {...})`），是前端最复杂、最大的单文件。

## 1. 文件内部布局

**模块级 helper（第 1–757 行，约 760 行，不依赖 store 状态）**

- 类型：`Attachment`、`Message`（5 种角色 + 工具字段 + reasoning）、`PendingApproval`、`PendingClarify`、`Session`、`CompressionState`
- 工具函数：`uid()`、`isToolOutputError()`、`errorMessageText()`、`uploadFiles()` + `buildContentBlocks()`（附件上传转 Anthropic content blocks）
- 服务端数据映射：`mapHermesMessages()`、`mapHermesSession()`（协议适配层，前后端模型解耦）
- localStorage 持久化：`storageKey()`（按 profile 隔离）、`recoverStorageQuota()`（quota 超限降级）、`setItemBestEffort()`

**store 主体（758–4198 行）**

| 区块 | 位置 | 内容 |
|---|---|---|
| state | 758–880 | 大量 `ref<Map<K,V>>`：`sessions`、`streamStates`(会话→abort)、`serverWorking`(Set)、`queueLengths`、`queuedUserMessages`、`dequeuedQueueIds`、`pendingApprovals`、`pendingClarifies`、`compressionStates`、`abortState` |
| computed | 795–883 | `messages`、`isStreaming`、`activePendingApproval`、`compressionState` 等 |
| 会话生命周期 | 899–1476 | `loadSessions`、`refreshSessionListOnly`、`switchSession`、`loadOlderMessages`、`newChat`、`deleteSession` |
| 队列机制 | 1816–2070 | `enqueueUserMessage` / `dropQueuedUserMessage` / `normalizeQueuedUserMessages` / `markDequeuedQueueId` 等 8 个函数 |
| 审批/澄清 | 2071–2262 | `setPendingApproval`、`respondApproval`、`respondToClarify`… |
| **发送核心** | 2365–3266 | `sendMessage()`，内嵌 `applyReconnectResume`（**~700 行**）+ `handleEvent`（**~500 行**） |
| 断线恢复 | 3277–3907 | `resumeServerWorkingRun()`（页面刷新后重挂运行），再次内嵌一套 `applyReconnectResume` + `handleEvent` |
| 推理观察/其他 | 4001–4149 | thinking 增量追踪、`clearProviderFromSessions`、`setSessionReasoningEffort`、`playMessageSpeech` |

## 2. 核心架构：事件驱动 + 双轨同步

**Socket 层**（`api/hermes/chat.ts`）维护单一共享 socket，注册了 20+ 个全局 handler；**store 层**通过 `registerSessionHandlers(sid, ...)` 接收事件，按 `evt.session_id` 过滤后再分发。事件类型共 **27 种**：

- 运行生命周期：`run.queued/started/completed/failed/reattach_failed`
- 流式增量：`message.delta`、`reasoning.delta`、`thinking.delta`、`reasoning.available`
- 工具：`tool.started/completed`、`subagent.*`（4 种）
- 交互：`approval.requested/resolved`、`clarify.requested/resolved`
- 状态：`compression.*`、`abort.*`（3 种）、`usage.updated`、`session.title.updated`、`session.command`、`agent.event`

**双轨消息流**：用户消息既进本地 `addMessage`（立即显示），又以 `queue_id` 发到服务器排队；`run.queued` 事件回传后置为 `queued`，`dequeuedQueueIds` 集合专门处理"服务器已出队但对等消息尚未到达"的窗口期，跨端同步靠 `onPeerUserMessage` 全局订阅。

**重连恢复**：`applyReconnectResume(data)` 用服务器恢复 payload（messages + isWorking + queueMessages + events）整体重建会话状态，并重放压缩/中断/审批事件；`resolveResumedAssistantState()` 用 `runMarker` 追踪并恢复进行中的助手消息。

## 3. 值得注意的设计决策

1. **引用一致性是命脉**：`refreshSessionListOnly`（978 行）的注释明确警告——必须**原地合并**到现有 session 对象而非替换，否则 `activeSession` 变成孤儿引用、流式消息立刻停止。这是对后续修改者最隐蔽的陷阱。
2. **并发会话意识**：状态全部按 `sessionId` 键隔离（Map/Set），支持后台会话继续流式、前台切走；`isStreaming` 只对活跃会话计算。
3. **健壮性细节**：quota 恢复、resume 15s 超时、`run.completed` 对"静默吞没错误"的检测（`runProducedAssistantText` 三态区分）。
4. **`as any` 大量逃逸**：`RunEvent` 是扁平接口（第 85 行），各事件 payload 未建 discriminated union，事件处理全用 `(evt as any).xxx` 访问字段——编译器基本无法校验事件字段。

## 4. 问题与风险

1. **三份近乎重复的事件处理**：`switchSession` 的 resume 回调、`sendMessage` 内的 `handleEvent`、`resumeServerWorkingRun` 内的 `handleEvent`、以及重放 switch——同一批事件类型至少处理了 3–4 遍，逻辑漂移风险高，也是 162KB 的主要来源。
2. **巨型闭包**：`sendMessage` 一个函数内嵌两个 500+/700+ 行的回调，状态变量（`runProducedAssistantText`、`activeAssistantMessageId` 等 6 个）在闭包间共享，改动需全局心算。
3. **类型安全薄弱**：见上，`RunEvent`/`ResumeSessionPayload` 应建 discriminated union。
4. **测试覆盖与复杂度不匹配**：`tests/client` 只有 6 个 chat store 测试（reconnect、compression、reasoning、session-command、thinking），没有 sendMessage 全流程、事件分发矩阵、队列竞态的覆盖。
5. **可拆性**：队列机制、审批/澄清、压缩状态、thinking 观察都自洽成模块，可拆为独立 composable 或子 store，但需保持事件分发单一入口。

## 5. 改进建议（按性价比排序）

1. 把 `RunEvent` 改成 discriminated union，一次消灭大部分 `as any`（收益最大、风险最低）。
2. 抽取统一的事件 reducer（`handleRunEvent(sessionCtx, evt)`），四份实现合为一份。
3. 将 `applyReconnectResume` 与 `switchSession` 的 resume 状态同步去重。
4. 补测试：sendMessage 全流程 + 事件类型分发矩阵（用 `@pinia/testing` 已有基础）。
