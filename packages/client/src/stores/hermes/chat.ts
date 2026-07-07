/**
 * Chat Store - 核心聊天状态管理模块
 * 
 * 负责管理会话列表、消息流、流式响应、工具调用、审批请求、压缩状态等核心聊天功能。
 * 主要特性：
 * - 会话管理：创建、切换、删除、加载历史消息
 * - 流式消息：通过 Socket.IO 实时接收 AI 响应，支持中断和恢复
 * - 工具调用：完整的工具执行流程（启动/运行/完成/错误）
 * - 思考推理：支持 reasoning.delta/thinking.delta/reasoning.available 事件
 * - 审批系统：处理工具执行权限请求（如内存写入）
 * - 澄清请求：处理 AI 的追问
 * - 队列机制：支持消息排队，避免并发冲突
 * - 跨端同步：支持 CLI/Telegram/多设备创建的会话实时同步
 * - 语音播放：支持消息自动语音合成
 */
import { startRunViaSocket, resumeSession, registerSessionHandlers, unregisterSessionHandlers, getChatRunSocket, respondToolApproval, onPeerUserMessage, onSessionCommand, onSessionTitleUpdated, respondClarify, type RunEvent, type ResumeSessionPayload, type StartRunRequest, type ContentBlock as ContentBlockImport } from '@/api/hermes/chat'
import { deleteSession as deleteSessionApi, fetchSessionMessagesPage, fetchSessions, setSessionModel, type HermesMessage, type SessionSummary } from '@/api/hermes/sessions'
import { getActiveProfileName } from '@/api/client'
import { getDownloadUrl } from '@/api/hermes/download'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { useSettingsStore } from './settings'
import { primeCompletionSound, playCompletionSound } from '@/utils/completion-sound'
import { showCompletionNotification } from '@/utils/completion-notification'
import { detectThinkingBoundary } from '@/utils/thinking-parser'

// 重新导出 ContentBlock 类型供外部使用
export type ContentBlock = ContentBlockImport

/** 消息附件接口 */
export interface Attachment {
  id: string              // 附件唯一标识
  name: string            // 文件名
  type: string            // MIME 类型
  size: number            // 文件大小（字节）
  url: string             // 下载/预览 URL
  file?: File             // 本地 File 对象（仅上传时存在）
}

/**
 * 消息接口 - 聊天界面展示的消息模型
 * 
 * 消息角色说明：
 * - user: 用户消息
 * - assistant: AI 助手回复
 * - system: 系统消息/错误提示
 * - tool: 工具调用消息
 * - command: 命令消息（如 /clear, /compress）
 */
export interface Message {
  id: string                              // 消息唯一标识
  role: 'user' | 'assistant' | 'system' | 'tool' | 'command'
  content: string                         // 消息内容
  timestamp: number                       // 时间戳（毫秒）
  toolName?: string                       // 工具名称（工具消息专用）
  toolCallId?: string                     // 工具调用 ID（关联工具调用和结果）
  toolPreview?: string                    // 工具结果预览文本
  toolArgs?: unknown                      // 工具调用参数
  toolResult?: unknown                    // 工具执行结果
  toolStatus?: 'running' | 'done' | 'error' // 工具执行状态
  toolDuration?: number                   // 工具执行时长（秒）
  isStreaming?: boolean                   // 是否正在流式传输中
  attachments?: Attachment[]              // 附件列表
  /**
   * 思考/推理文本 - AI 的内部思考过程
   * 来源：
   *   1) 历史消息：来自 HermesMessage.reasoning 字段
   *   2) 流式：由 reasoning.delta / thinking.delta / reasoning.available 事件累加
   * 不含 <think> 包裹标签；内容自身可以为多段纯文本。
   */
  reasoning?: string
  queued?: boolean                        // 是否在排队中
  systemType?: 'command' | 'error'        // 系统消息类型
  commandAction?: string                  // 命令动作类型
  commandData?: Record<string, unknown>   // 命令附带数据
  finishReason?: string | null            // 消息结束原因
  runMarker?: string | null               // 运行标记（用于恢复会话时追踪）
}

/**
 * 待审批请求接口 - 工具执行权限请求
 * 
 * 当 AI 需要执行敏感操作（如写入内存）时，会向用户发送审批请求
 */
export interface PendingApproval {
  sessionId: string                                   // 会话 ID
  approvalId: string                                  // 审批 ID
  command: string                                     // 请求执行的命令
  description: string                                 // 请求描述
  choices: Array<'once' | 'session' | 'always' | 'deny'> // 用户可选的审批选项
  allowPermanent: boolean                             // 是否允许永久授权（always）
  isMemoryWrite: boolean                              // 是否为内存写入操作
  requestedAt: number                                 // 请求时间戳
}

/**
 * 待澄清请求接口 - AI 的追问
 * 
 * 当 AI 需要更多信息才能继续回答时，会发送澄清请求
 */
export interface PendingClarify {
  sessionId: string           // 会话 ID
  clarifyId: string           // 澄清请求 ID
  question: string            // 追问问题
  choices: string[] | null    // 可选答案列表（null 表示自由输入）
  timeoutMs: number           // 超时时间（毫秒）
  requestedAt: number         // 请求时间戳
}

/**
 * 会话接口 - 聊天会话的完整模型
 */
export interface Session {
  id: string                                 // 会话唯一标识
  profile?: string                           // 所属 Profile
  title: string                              // 会话标题（自动生成或用户设置）
  source?: string                            // 会话来源（api_server/cli/coding_agent）
  agent?: string                             // 使用的 Agent 类型
  agentSessionId?: string                    // Agent 层会话 ID
  agentNativeSessionId?: string              // 原生模型会话 ID
  codingAgentId?: 'claude-code' | 'codex'    // 编码 Agent ID
  codingAgentMode?: 'global' | 'scoped'      // 编码 Agent 模式
  messages: Message[]                        // 消息列表
  createdAt: number                          // 创建时间（毫秒）
  updatedAt: number                          // 更新时间（毫秒）
  model?: string                             // 使用的模型名称
  provider?: string                          // 模型提供商
  baseUrl?: string                           // 自定义 API 基础 URL
  apiKey?: string                            // 自定义 API Key
  apiMode?: 'chat_completions' | 'codex_responses' | 'anthropic_messages' // API 模式
  messageCount?: number                      // 消息计数
  messageTotal?: number                      // 消息总数
  loadedMessageCount?: number                // 已加载的消息数
  hasMoreBefore?: boolean                    // 是否还有更早的消息可加载
  isLoadingOlderMessages?: boolean           // 是否正在加载更早的消息
  inputTokens?: number                       // 输入 Token 数
  outputTokens?: number                      // 输出 Token 数
  contextTokens?: number                     // 上下文 Token 数
  endedAt?: number | null                    // 会话结束时间
  lastActiveAt?: number                      // 最后活跃时间
  workspace?: string | null                  // 工作空间路径
  /**
   * 会话级别的推理强度覆盖
   * 空字符串/undefined = 使用 config.yaml 默认值
   * 可选值: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
   */
  reasoningEffort?: string
}

/**
 * 压缩状态接口 - 会话上下文压缩的状态追踪
 */
interface CompressionState {
  compressing: boolean       // 是否正在压缩中
  messageCount: number       // 参与压缩的消息数
  beforeTokens: number       // 压缩前的 Token 数
  afterTokens: number        // 压缩后的 Token 数
  compressed: boolean | null // 是否成功压缩
  error?: string             // 压缩错误信息
}

/** 生成唯一 ID - 使用时间戳 + 随机数的 36 进制表示 */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 判断工具输出是否包含错误
 * 
 * 检测逻辑：
 * 1. 输出必须是字符串且非空
 * 2. 尝试解析为 JSON 对象
 * 3. 如果对象包含 success: false 或非空的 error 字段，则视为错误
 */
function isToolOutputError(output: unknown): boolean {
  if (typeof output !== 'string' || !output.trim()) return false
  try {
    const parsed = JSON.parse(output)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (record.success === false) return true
      if (record.error != null && String(record.error).trim() !== '') return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * 从错误对象中提取可读的错误消息文本
 * 
 * 支持多种错误格式：
 * - 字符串：直接返回
 * - 数组：递归提取并拼接
 * - 对象：按优先级查找 message/error/detail/description/code 字段
 * - 其他：尝试 JSON 序列化或转为字符串
 */
function errorMessageText(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (error == null) return ''
  if (typeof error !== 'object') return String(error).trim()

  if (Array.isArray(error)) {
    return error.map(errorMessageText).filter(Boolean).join('\n')
  }

  const record = error as Record<string, unknown>
  for (const key of ['message', 'error', 'detail', 'description', 'code']) {
    const text = errorMessageText(record[key])
    if (text) return text
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 上传文件到服务器
 * 
 * 通过 POST /upload 接口上传附件，返回服务器端文件路径
 * @param attachments 附件列表
 * @returns 上传后的文件信息（名称和路径）
 */
async function uploadFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
  if (attachments.length === 0) return []
  const formData = new FormData()
  for (const att of attachments) {
    if (att.file) formData.append('file', att.file, att.name)
  }
  const token = localStorage.getItem('hermes_api_key') || ''
  const profileName = getActiveProfileName()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (profileName) headers['X-Hermes-Profile'] = profileName
  const res = await fetch('/upload', {
    method: 'POST',
    body: formData,
    headers,
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  const data = await res.json() as { files: { name: string; path: string }[] }
  return data.files
}

/**
 * 构建 Anthropic 格式的内容块数组
 * 
 * 将文本内容和附件转换为 API 请求所需的 ContentBlock 格式：
 * - 文本内容 -> text 块
 * - 图片附件 -> image 块
 * - 其他附件 -> file 块
 * 
 * @param content 文本内容
 * @param attachments 附件列表
 * @param uploadedFiles 已上传的文件信息
 * @returns 内容块数组
 */
async function buildContentBlocks(
  content: string,
  attachments?: Attachment[],
  uploadedFiles?: { name: string; path: string }[]
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []

  // 添加文本块（如果内容非空）
  if (content.trim()) {
    blocks.push({ type: 'text', text: content.trim() })
  }

  // 添加附件块（使用上传后的文件路径）
  if (attachments && attachments.length > 0 && uploadedFiles) {
    for (let i = 0; i < uploadedFiles.length; i++) {
      const uploaded = uploadedFiles[i]
      const attachment = attachments[i]

      // 判断是否为图片附件
      if (attachment?.type.startsWith('image/')) {
        blocks.push({
          type: 'image',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment.type,
        })
      } else {
        // 非图片附件
        blocks.push({
          type: 'file',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment?.type,
        })
      }
    }
  }

  return blocks
}

/** 判断工具负载是否有实际值（非空、非 undefined、非空字符串） */
function hasRuntimeToolPayload(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

/** 将工具负载转换为 undefined（如果为空）或原值 */
function runtimeToolPayloadOrUndefined(value: unknown): unknown | undefined {
  return hasRuntimeToolPayload(value) ? value : undefined
}

/**
 * 将工具负载转换为字符串表示
 * 
 * 处理逻辑：
 * 1. 空值 -> 空字符串
 * 2. 字符串 -> 直接返回
 * 3. 对象 -> JSON 序列化
 * 4. 其他 -> 转为字符串
 */
function runtimePayloadText(value: unknown): string {
  if (!hasRuntimeToolPayload(value)) return ''
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) return serialized
  } catch {
    // 对于不可序列化的负载，回退到 String(value)
  }
  return String(value)
}

/** 判断工具输出是否包含错误（简化版，仅检查字符串格式） */
function runtimeToolOutputHasError(value: unknown): boolean {
  return typeof value === 'string' && isToolOutputError(value)
}

/**
 * 从对象中读取 finish_reason（支持 camelCase 和 snake_case 两种格式）
 * @returns finish_reason 值或 undefined
 */
function readFinishReason(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'finishReason')) {
    return (record as { finishReason?: string | null }).finishReason
  }
  if (Object.prototype.hasOwnProperty.call(record, 'finish_reason')) {
    return (record as { finish_reason?: string | null }).finish_reason
  }
  return undefined
}

/**
 * 从对象中读取 run_marker（支持 camelCase 和 snake_case 两种格式）
 * @returns run_marker 值或 undefined
 */
function readRunMarker(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'runMarker')) {
    return typeof record.runMarker === 'string' || record.runMarker == null
      ? record.runMarker as string | null
      : undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, 'run_marker')) {
    return typeof record.run_marker === 'string' || record.run_marker == null
      ? record.run_marker as string | null
      : undefined
  }
  return undefined
}

/** 判断助手消息是否有可见文本内容（content 或 reasoning） */
function hasAssistantVisibleText(message: Message | null | undefined): boolean {
  if (!message) return false
  return message.content.trim() !== '' || (message.reasoning?.trim() ?? '') !== ''
}

/**
 * 从消息列表中选择恢复会话时正在进行中的助手消息
 * 
 * 判断逻辑：
 * 1. 必须是最后一条消息
 * 2. 角色必须是 assistant
 * 3. finish_reason 为 null（表示未完成）或 run_marker 匹配当前运行
 * 
 * @param messages 消息列表
 * @param activeRunMarker 当前活跃的运行标记
 * @returns 正在进行中的助手消息或 null
 */
function selectResumedInFlightAssistant(messages: Message[], activeRunMarker?: string | null): Message | null {
  if (messages.length === 0) return null
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role !== 'assistant') return null
  const finishReason = readFinishReason(lastMessage)
  const runMarker = readRunMarker(lastMessage)
  const hasMatchingRunMarker = !!activeRunMarker && !!runMarker && runMarker === activeRunMarker
  return finishReason === null || hasMatchingRunMarker ? lastMessage : null
}

/**
 * 从事件列表中提取回放的 run_marker
 * 
 * 从后往前遍历事件，找到第一个有效的 run_marker
 * @param events 事件列表
 * @returns run_marker 值或 null
 */
function getReplayRunMarker(events?: Array<{ event: string; data: RunEvent }>): string | null {
  if (!Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const runMarker = readRunMarker(events[i]?.data)
    if (typeof runMarker === 'string' && runMarker.trim() !== '') return runMarker
  }
  return null
}

/**
 * 解析恢复会话时的助手消息状态
 * 
 * 在页面刷新或重新连接后，确定当前正在进行中的助手消息和推理消息
 * 
 * @param messages 消息列表
 * @param options 恢复选项
 * @param options.previousActiveAssistantMessageId 之前活跃的助手消息 ID
 * @param options.previousReasoningAssistantMessageId 之前活跃的推理消息 ID
 * @param options.activeRunMarker 当前活跃的运行标记
 * @returns 助手消息状态对象
 */
function resolveResumedAssistantState(
  messages: Message[],
  options: {
    previousActiveAssistantMessageId?: string | null
    previousReasoningAssistantMessageId?: string | null
    activeRunMarker?: string | null
  },
): {
  activeAssistant: Message | null        // 正在进行中的助手消息
  reasoningAssistant: Message | null     // 正在进行中的推理消息
  runMarker: string | null               // 当前运行标记
  hadVisibleText: boolean                // 是否有可见文本内容
} {
  // 优先使用之前保存的 activeAssistantMessageId 查找
  const activeAssistant = options.previousActiveAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousActiveAssistantMessageId) || null
    : null
  // 如果没找到，尝试从消息列表中选择正在进行中的助手消息
  const selectedActiveAssistant = activeAssistant || selectResumedInFlightAssistant(messages, options.activeRunMarker)
  
  // 优先使用之前保存的 reasoningAssistantMessageId 查找
  const reasoningAssistant = options.previousReasoningAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousReasoningAssistantMessageId) || null
    : null
  // 如果没找到，使用 activeAssistant（如果它有 reasoning 内容）
  const selectedReasoningAssistant = reasoningAssistant || (selectedActiveAssistant?.reasoning ? selectedActiveAssistant : null)
  
  // 提取 run_marker
  const selectedRunMarker = readRunMarker(selectedActiveAssistant) ?? options.activeRunMarker ?? null
  
  return {
    activeAssistant: selectedActiveAssistant,
    reasoningAssistant: selectedReasoningAssistant,
    runMarker: selectedRunMarker,
    hadVisibleText: hasAssistantVisibleText(selectedActiveAssistant),
  }
}

/**
 * 将 Hermes 后端消息格式转换为客户端消息格式
 * 
 * 主要处理：
 * 1. 过滤掉没有显示内容的 assistant 消息（除非包含 tool_calls 元数据）
 * 2. 构建工具调用名称和参数的映射表
 * 3. 将 assistant 消息中的 tool_calls 转换为独立的 tool 消息
 * 4. 将 tool 消息与对应的工具调用关联
 * 5. 普通消息直接转换
 * 
 * @param msgs Hermes 后端消息列表
 * @returns 客户端消息列表
 */
function mapHermesMessages(msgs: HermesMessage[]): Message[] {
  // 过滤掉没有显示内容的 assistant 消息（除非包含 tool_calls 元数据，用于恢复历史时命名工具结果行）
  const filteredMsgs = msgs.filter(m => {
    if (m.role === 'assistant') {
      return (m.tool_calls?.length || 0) > 0 || runtimePayloadText((m as any).content).trim() !== ''
    }
    return true
  })

  // 从包含 tool_calls 的 assistant 消息中构建工具名称和参数的映射表
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, unknown>()
  for (const msg of filteredMsgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          if (tc.function?.name) toolNameMap.set(tc.id, tc.function.name)
          if (hasRuntimeToolPayload(tc.function?.arguments)) toolArgsMap.set(tc.id, tc.function.arguments)
        }
      }
    }
  }

  const result: Message[] = []
  for (const msg of filteredMsgs) {
    // 跳过只包含 tool_calls 的 assistant 消息（无实际内容），为每个工具调用生成 tool.started 消息
    if (msg.role === 'assistant' && msg.tool_calls?.length && !runtimePayloadText((msg as any).content).trim()) {
      for (const tc of msg.tool_calls) {
        result.push({
          id: String(msg.id) + '_' + tc.id,
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: tc.function?.name || undefined,
          toolCallId: tc.id,
          toolArgs: runtimeToolPayloadOrUndefined(tc.function?.arguments),
          toolStatus: 'done',
          finishReason: readFinishReason(msg),
          runMarker: readRunMarker(msg),
        })
      }
      continue
    }

    // 工具结果消息处理
    if (msg.role === 'tool') {
      const tcId = msg.tool_call_id || ''
      const toolName = msg.tool_name || toolNameMap.get(tcId) || undefined
      const toolArgs = toolArgsMap.has(tcId) ? toolArgsMap.get(tcId) : undefined
      
      // 从内容中提取简短预览
      let preview = ''
      const contentText = runtimePayloadText((msg as any).content)
      if (contentText) {
        try {
          const parsed = typeof (msg as any).content === 'string'
            ? JSON.parse(contentText)
            : (msg as any).content
          preview = parsed?.url || parsed?.title || parsed?.preview || parsed?.summary || ''
        } catch {
          preview = contentText.slice(0, 80)
        }
      }
      
      // 查找并移除上面生成的占位符工具消息
      const placeholderIdx = result.findIndex(
        m => m.role === 'tool' && m.toolName === toolName && !m.toolResult && m.id.includes('_' + tcId)
      )
      if (placeholderIdx !== -1) {
        result.splice(placeholderIdx, 1)
      }
      
      result.push({
        id: String(msg.id),
        role: 'tool',
        content: '',
        timestamp: Math.round(msg.timestamp * 1000),
        toolName,
        toolCallId: tcId || undefined,
        toolArgs,
        toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
        toolResult: runtimeToolPayloadOrUndefined((msg as any).content),
        toolStatus: 'done',
        finishReason: readFinishReason(msg),
        runMarker: readRunMarker(msg),
      })
      continue
    }

    // 普通 user/assistant/command 消息处理
    result.push({
      id: String(msg.id),
      role: msg.role,
      content: msg.content || '',
      timestamp: Math.round(msg.timestamp * 1000),
      reasoning: msg.reasoning ? msg.reasoning : undefined,
      systemType: msg.role === 'command' ? 'command' : undefined,
      finishReason: readFinishReason(msg),
      runMarker: readRunMarker(msg),
    })
  }
  return result
}

/**
 * 将 Hermes 后端会话摘要转换为客户端会话格式
 * 
 * 主要处理：
 * 1. 时间戳转换（秒 -> 毫秒）
 * 2. 字段名映射（snake_case -> camelCase）
 * 3. 编码 Agent 模式判断
 * 4. 默认值设置
 * 
 * @param s Hermes 后端会话摘要
 * @returns 客户端会话对象
 */
function mapHermesSession(s: SessionSummary): Session {
  // 判断编码 Agent 模式
  const codingAgentMode = s.source === 'coding_agent'
    ? (s.agent_mode === 'global' || s.agent_mode === 'scoped'
        ? s.agent_mode
        : s.provider === 'global' ? 'global' : 'scoped')
    : undefined
  
  return {
    id: s.id,
    profile: s.profile || 'default',
    title: s.title || '',
    source: s.source || undefined,
    agent: s.agent || undefined,
    agentSessionId: s.agent_session_id || undefined,
    agentNativeSessionId: s.agent_native_session_id || undefined,
    codingAgentMode,
    messages: [],                                    // 消息列表初始为空，后续加载
    createdAt: Math.round(s.started_at * 1000),      // 时间戳转换：秒 -> 毫秒
    updatedAt: Math.round((s.last_active || s.ended_at || s.started_at) * 1000),
    model: s.model,
    provider: s.provider || (s as any).billing_provider || '',
    messageCount: s.message_count,
    messageTotal: s.message_count,
    loadedMessageCount: 0,
    hasMoreBefore: false,
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    endedAt: s.ended_at != null ? Math.round(s.ended_at * 1000) : null,
    lastActiveAt: s.last_active != null ? Math.round(s.last_active * 1000) : undefined,
    workspace: s.workspace || null,
  }
}

// localStorage 键名常量
const STORAGE_KEY_PREFIX = 'hermes_active_session_'   // 当前 profile 的活跃会话键名前缀
const LEGACY_STORAGE_KEY = 'hermes_active_session'     // 旧版（无 profile 隔离）的活跃会话键名

/**
 * 获取当前 profile 名称，用于隔离缓存
 * 
 * 从 profiles store 的 activeProfileName（同步 localStorage）读取，
 * 避免异步加载导致 chat store 初始化时拿到 null。
 * @returns profile 名称，默认为 'default'
 */
function getProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    return 'default'
  }
}

/** 获取当前 profile 的活跃会话存储键名 */
function storageKey(): string { return STORAGE_KEY_PREFIX + getProfileName() }

/** 获取旧版活跃会话存储键名（仅 default profile 有） */
function legacyStorageKey(): string | null { return getProfileName() === 'default' ? LEGACY_STORAGE_KEY : null }

/** 判断错误是否为 localStorage 配额超限错误 */
function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string, code?: number }
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
}

/**
 * 恢复 localStorage 配额
 * 
 * 清理所有已废弃的旧缓存键，释放存储空间
 */
function recoverStorageQuota() {
  try {
    // 已完全废弃的缓存键前缀列表
    const prefixes = [
      'hermes_sessions_cache_v1_',
      'hermes_session_msgs_v1_',
      'hermes_session_pins_v1_',
      'hermes_human_only_v1_',
    ]
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      // 保留当前使用的键
      if (key === storageKey() || key === LEGACY_STORAGE_KEY) continue
      // 删除废弃的键
      if (prefixes.some(prefix => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => removeItem(key))
    if (keysToRemove.length > 0) {
      console.log(`Recovered storage: cleared ${keysToRemove.length} old session cache entries`)
    }
  } catch {
    // 忽略错误
  }
}

/**
 * 尽力设置 localStorage 项（自动处理配额超限）
 * 
 * 如果设置失败且是配额超限，会尝试清理旧缓存后重试
 * @param key 存储键名
 * @param value 存储值
 */
function setItemBestEffort(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) return
  }

  // 配额超限，尝试清理旧缓存
  recoverStorageQuota()

  try {
    localStorage.setItem(key, value)
  } catch {
    // 配额仍然超限或私有模式 — 忽略，缓存是尽力而为的
  }
}

/**
 * 尽力获取 localStorage 项（自动处理异常）
 * @param key 存储键名
 * @returns 存储值或 null
 */
function getItemBestEffort(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * 删除 localStorage 项（自动处理异常）
 * @param key 存储键名
 */
function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // 忽略错误
  }
}

// 缓存前需要从附件中移除循环引用的 `file: File` 对象 ——
// File 对象无法序列化，我们只需要 name/type/size/url 用于显示。

/**
 * Chat Store 定义
 * 
 * 使用 Pinia 的 setup 模式，所有状态和方法都在内部定义，最后通过 return 暴露
 */
export const useChatStore = defineStore('chat', () => {
  // ========== 内部状态 ==========
  
  /** 已处理过的会话命令事件集合（防止重复处理） */
  const seenSessionCommandEvents = new WeakSet<RunEvent>()
  
  /** 会话列表 */
  const sessions = ref<Session[]>([])
  
  /** 当前活跃会话 ID */
  const activeSessionId = ref<string | null>(null)
  
  /** 当前聚焦的消息 ID（用于滚动定位） */
  const focusMessageId = ref<string | null>(null)
  
  /** 会话 ID → 流式状态映射（包含 abort 方法） */
  const streamStates = ref<Map<string, { abort: () => void }>>(new Map())
  
  /** 会话 ID → 服务器报告的 isWorking 状态 */
  const serverWorking = ref<Set<string>>(new Set())
  
  /** 当前会话列表的 Profile 过滤器 */
  const sessionProfileFilter = ref<string | null>(null)
  
  /** 会话 ID → 排队消息数量 */
  const queueLengths = ref<Map<string, number>>(new Map())
  
  /** 会话 ID → 已排队但尚未在对话中显示的用户消息 */
  const queuedUserMessages = ref<Map<string, Message[]>>(new Map())
  
  /** 会话 ID → 服务器报告已出队但对等消息尚未到达的队列 ID 集合 */
  const dequeuedQueueIds = ref<Map<string, Set<string>>>(new Map())
  
  /** 会话 ID → 待审批请求 */
  const pendingApprovals = ref<Map<string, PendingApproval>>(new Map())
  
  /** 当前活跃会话的待审批请求 */
  const activePendingApproval = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingApprovals.value.get(sid) || null : null
  })

  /** 会话 ID → 待澄清请求 */
  const pendingClarifies = ref<Map<string, PendingClarify>>(new Map())
  
  /** 当前活跃会话的待澄清请求 */
  const activePendingClarify = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingClarifies.value.get(sid) || null : null
  })

  /** 自动播放语音开关 */
  const autoPlaySpeechEnabled = ref(false)

  /** 设置自动播放语音状态 */
  function setAutoPlaySpeech(enabled: boolean) {
    autoPlaySpeechEnabled.value = enabled
  }

  /** 是否正在流式传输（客户端或服务器有活跃运行） */
  const isStreaming = computed(() => {
    const sid = activeSessionId.value
    if (sid == null) return false
    return streamStates.value.has(sid) || serverWorking.value.has(sid)
  })

  /** 是否正在加载会话列表 */
  const isLoadingSessions = ref(false)
  
  /** 会话列表是否已加载 */
  const sessionsLoaded = ref(false)
  
  /** 是否正在加载消息 */
  const isLoadingMessages = ref(false)
  
  /** 是否有活跃运行（与 isStreaming 等价） */
  const isRunActive = computed(() => isStreaming.value)

  /**
   * 会话 ID → 压缩状态映射
   * 
   * 压缩状态按会话隔离，因为 socket 可以在后台会话保持连接的同时另一个聊天处于活跃状态
   */
  const compressionStates = ref<Map<string, CompressionState>>(new Map())
  
  /** 当前活跃会话的压缩状态 */
  const compressionState = computed<CompressionState | null>(() => {
    const sid = activeSessionId.value
    return sid ? compressionStates.value.get(sid) || null : null
  })

  /**
   * 设置会话的压缩状态
   * @param sessionId 会话 ID
   * @param state 压缩状态（null 表示清除）
   */
  function setCompressionState(sessionId: string | null | undefined, state: CompressionState | null) {
    if (!sessionId) return
    const next = new Map(compressionStates.value)
    if (state) next.set(sessionId, state)
    else next.delete(sessionId)
    compressionStates.value = next
  }

  /** 中断状态 */
  const abortState = ref<{
    aborting: boolean     // 是否正在中断中
    synced: boolean | null // 是否已同步到服务器
    timedOut?: boolean    // 是否超时
    message?: string      // 消息
    error?: string        // 错误信息
  } | null>(null)
  
  /** 是否正在中断 */
  const isAborting = computed(() => abortState.value?.aborting === true)

  /** 设置中断状态 */
  function setAbortState(state: typeof abortState.value) {
    abortState.value = state
  }

  /** 当前活跃会话对象 */
  const activeSession = ref<Session | null>(null)
  
  /** 当前活跃会话的消息列表 */
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])

/**
   * 判断会话是否处于活跃状态（正在流式传输或服务器报告工作中）
   * @param sessionId 会话 ID
   * @returns 是否活跃
   */
  function isSessionLive(sessionId: string): boolean {
    return streamStates.value.has(sessionId) || serverWorking.value.has(sessionId)
  }

  /**
   * 清除当前活跃会话
   * 
   * 重置所有相关状态，包括活跃会话、聚焦消息、中断状态、压缩状态，并清除本地存储
   */
  function clearActiveSession() {
    const sid = activeSessionId.value
    activeSessionId.value = null
    activeSession.value = null
    focusMessageId.value = null
    setAbortState(null)
    setCompressionState(sid, null)
    removeItem(storageKey())
  }

  /**
   * 加载会话列表
   * 
   * 从服务器获取会话列表，保留已加载的消息，然后根据优先级选择并切换到目标会话。
   * 
   * 会话恢复优先级（从高到低）：
   * 1. preferredSessionId（路由指定的会话）
   * 2. currentId（当前内存中的会话）
   * 3. storedId（本地存储的会话）
   * 4. 最新会话
   * 
   * @param profile 可选的 profile 过滤
   * @param preferredSessionId 首选会话 ID（路由指定）
   */
  async function loadSessions(profile?: string | null, preferredSessionId?: string | null) {
    isLoadingSessions.value = true
    try {
      const list = await fetchSessions(undefined, undefined, profile || undefined)
      const fresh = list.map(mapHermesSession)
      
      // 保留仍存在的会话的已加载消息，避免刷新时丢失活跃会话的消息
      const runtimeByIdBefore = new Map(sessions.value.map(s => [s.id, {
        messages: s.messages,
        contextTokens: s.contextTokens,
      }]))
      for (const s of fresh) {
        const prev = runtimeByIdBefore.get(s.id)
        if (prev?.messages?.length) s.messages = prev.messages
        if (prev?.contextTokens != null) s.contextTokens = prev.contextTokens
      }
      sessions.value = fresh

      // 按优先级选择目标会话
      const currentId = activeSessionId.value
      const legacyActiveKey = legacyStorageKey()
      const storedId = getItemBestEffort(storageKey()) || (legacyActiveKey ? getItemBestEffort(LEGACY_STORAGE_KEY) : null)
      const targetId = preferredSessionId && sessions.value.some(s => s.id === preferredSessionId)
        ? preferredSessionId
        : currentId && sessions.value.some(s => s.id === currentId)
          ? currentId
          : storedId && sessions.value.some(s => s.id === storedId)
            ? storedId
            : sessions.value[0]?.id
      if (targetId) {
        await switchSession(targetId)
      } else {
        clearActiveSession()
      }
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      isLoadingSessions.value = false
      sessionsLoaded.value = true
    }
  }

  /**
   * 仅刷新会话列表元数据（标题、排序、新增/删除的会话）
   * 
   * 不切换活跃会话，不重新加载消息。用于实时同步，使得在其他地方（CLI、Telegram、其他设备）
   * 创建的会话能够自动显示。流式传输期间会跳过以避免抖动。
   * 
   * 关键：此方法**原地合并**到现有会话对象，而不是用 mapHermesSession 克隆替换整个数组。
   * activeSession 是一个绑定到 sessions.value 中特定对象的 ref，流式增量通过 sessions.value.find(...)
   * 修改同一个对象。如果替换为新对象，activeSession.value 将指向一个孤立对象，实时消息将停止显示。
   * 原地修改保持引用一致性，确保流式传输继续工作。
   * 
   * @param profile 可选的 profile 过滤
   */
  async function refreshSessionListOnly(profile?: string | null): Promise<void> {
    if (isStreaming.value) return
    if (isLoadingSessions.value) return
    try {
      const list = await fetchSessions(undefined, undefined, profile ?? sessionProfileFilter.value ?? undefined)
      const incoming = list.map(mapHermesSession)
      const existingById = new Map(sessions.value.map(s => [s.id, s]))
      const incomingIds = new Set(incoming.map(s => s.id))

      // 构建新数组：重用现有对象（保持引用一致性），插入真正新的会话
      const next: Session[] = []
      for (const fresh of incoming) {
        const existing = existingById.get(fresh.id)
        if (existing) {
          // 原地更新标量元数据；绝不触摸运行时/滚动状态（messages, loadedMessageCount, hasMoreBefore, contextTokens）
          existing.title = fresh.title
          existing.source = fresh.source
          existing.updatedAt = fresh.updatedAt
          existing.lastActiveAt = fresh.lastActiveAt
          existing.endedAt = fresh.endedAt
          existing.model = fresh.model
          existing.provider = fresh.provider
          existing.messageCount = fresh.messageCount
          existing.inputTokens = fresh.inputTokens
          existing.outputTokens = fresh.outputTokens
          existing.workspace = fresh.workspace
          // messageTotal：保留服务器计数和已加载计数中的较大值，避免会话中途缩小到已渲染消息以下
          if (fresh.messageTotal != null) {
            existing.messageTotal = Math.max(fresh.messageTotal, existing.loadedMessageCount || 0)
          }
          next.push(existing)
        } else {
          next.push(fresh)
        }
      }

      // 即使服务器不再列出活跃会话，也要保留它（不要在用户正在查看时移除）
      const activeId = activeSessionId.value
      if (activeId && !incomingIds.has(activeId)) {
        const keep = existingById.get(activeId)
        if (keep) next.push(keep)
      }

      sessions.value = next

      // 防御性：重新绑定 activeSession 到数组中的同一对象，以防上面的操作改变了数组成员
      if (activeId) {
        const again = sessions.value.find(s => s.id === activeId)
        if (again && activeSession.value !== again) activeSession.value = again
      }
    } catch (err) {
      console.error('Failed to refresh session list:', err)
    }
  }

  /**
   * 从服务器重新拉取活跃会话数据
   * 
   * 用于标签页可见事件。重新加载消息并更新会话元数据。
   * @returns 是否刷新成功
   */
  async function refreshActiveSession(): Promise<boolean> {
    const sid = activeSessionId.value
    if (!sid) return false
    try {
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      const limit = Math.max(target.loadedMessageCount || 300, 300)
      const detail = await fetchSessionMessagesPage(sid, 0, limit, activeSession.value?.profile)
      if (!detail) return false
      const mapped = mapHermesMessages(detail.messages || [])
      target.messages = mapped
      target.loadedMessageCount = detail.messages.length
      target.messageTotal = detail.total
      target.messageCount = detail.total
      target.hasMoreBefore = detail.hasMore
      if (detail.session.title) target.title = detail.session.title
      return true
    } catch (err) {
      console.error('Failed to refresh active session:', err)
      return false
    }
  }

  /**
   * 创建新会话
   * 
   * 创建一个本地会话对象并添加到会话列表头部。
   * 
   * @param options 会话创建选项
   * @returns 新创建的会话对象
   */
  function createSession(options: {
    profile?: string                          // profile 名称
    model?: string                            // 模型名称
    provider?: string                         // 提供商
    source?: 'api_server' | 'cli' | 'coding_agent'  // 会话来源
    agent?: 'hermes' | 'claude' | 'codex'     // Agent 类型
    codingAgentId?: 'claude-code' | 'codex'   // 编码 Agent ID
    codingAgentMode?: 'global' | 'scoped'     // 编码 Agent 模式
    workspace?: string | null                 // 工作空间
    baseUrl?: string                          // API 基础 URL
    apiKey?: string                           // API Key
    apiMode?: 'chat_completions' | 'codex_responses' | 'anthropic_messages'  // API 模式
  } = {}): Session {
    const source = options.source || 'cli'
    const codingAgentId = options.codingAgentId || (options.agent === 'codex' ? 'codex' : options.agent === 'claude' ? 'claude-code' : undefined)
    const codingAgentMode = source === 'coding_agent' ? (options.codingAgentMode || 'scoped') : undefined
    const session: Session = {
      id: uid(),
      profile: options.profile || useProfilesStore().activeProfileName || 'default',
      title: '',
      source,
      agent: options.agent || (source === 'coding_agent' ? (codingAgentId === 'codex' ? 'codex' : 'claude') : 'hermes'),
      codingAgentId,
      codingAgentMode,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: options.model || undefined,
      provider: options.provider || '',
      workspace: options.workspace || null,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    }
    sessions.value.unshift(session)
    return session
  }

  /**
   * 创建一个新的 CLI 会话
   * 
   * 会话 ID 格式：YYYYMMDD_HHMMSS_hex（时间戳 + 随机十六进制）
   * @returns 新创建的 CLI 会话
   */
  function newCliSession(): Session {
    const now = new Date()
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
    const hex = Math.random().toString(16).slice(2, 8)
    const session: Session = {
      id: `${ts}_${hex}`,
      title: '',
      source: 'cli',
      agent: 'hermes',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    return session
  }

  /**
   * 切换到指定会话
   * 
   * 切换会话的核心流程：
   * 1. 清除之前的思考观察
   * 2. 更新活跃会话 ID 和本地存储
   * 3. 通过 Socket.IO resume 加载消息（服务器从内存或数据库加载）
   * 4. 处理恢复的状态（工作状态、队列、压缩、中断、审批等）
   * 5. 处理重放事件（压缩、中断、工具调用等）
   * 6. 恢复正在进行中的运行事件监听
   * 
   * @param sessionId 目标会话 ID
   * @param focusId 可选的聚焦消息 ID
   */
  async function switchSession(sessionId: string, focusId?: string | null) {
    clearThinkingObservationFor(sessionId)
    activeSessionId.value = sessionId
    focusMessageId.value = focusId ?? null
    setItemBestEffort(storageKey(), sessionId)
    const legacyActiveKey = legacyStorageKey()
    if (legacyActiveKey) removeItem(legacyActiveKey)
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null

    if (!activeSession.value) return

    isLoadingMessages.value = true

    try {
      // 通过 Socket.IO resume 加载消息（服务器从内存或数据库加载）
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('resume timeout')), 15_000)
        resumeSession(sessionId, (data) => {
          clearTimeout(timeout)
          // 如果会话已切换，直接返回
          if (data.session_id !== sessionId || activeSessionId.value !== sessionId) {
            resolve()
            return
          }
          const target = sessions.value.find(s => s.id === sessionId)
          if (!target) {
            resolve()
            return
          }
          
          // 更新工作状态
          if (data.isWorking) {
            serverWorking.value.add(sessionId)
          } else {
            serverWorking.value.delete(sessionId)
          }
          
          // 更新队列长度
          if (data.queueLength && data.queueLength > 0) {
            queueLengths.value.set(sessionId, data.queueLength)
          } else {
            queueLengths.value.delete(sessionId)
          }
          
          // 更新排队消息
          if (Array.isArray((data as any).queueMessages)) {
            replaceQueuedUserMessages(sessionId, normalizeQueuedUserMessages((data as any).queueMessages))
          } else if (!data.queueLength) {
            replaceQueuedUserMessages(sessionId, [])
          }
          
          // 更新中断状态
          if ((data as any).isAborting) {
            setAbortState({ aborting: true, synced: null })
          } else if (!data.isWorking) {
            setAbortState(null)
          }
          
          // 更新压缩状态
          if (!data.isWorking) setCompressionState(sessionId, null)
          
          // 更新 token 计数
          if (data.inputTokens != null) target.inputTokens = data.inputTokens
          if (data.outputTokens != null) target.outputTokens = data.outputTokens
          if ((data as any).contextTokens != null) target.contextTokens = (data as any).contextTokens
          
          // 更新消息列表
          if (data.messages?.length) {
            target.messages = mapHermesMessages(data.messages as any[])
            target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
            target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
            target.messageCount = target.messageTotal
            target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal
          }
          
          // 如果没有标题，从第一条用户消息生成
          if (!target.title) {
            const firstUser = target.messages.find(m => m.role === 'user')
            if (firstUser) {
              const t = firstUser.content.slice(0, 40)
              target.title = t + (firstUser.content.length > 40 ? '...' : '')
            }
          }
          
          activeSession.value = target
          
          // 处理重放事件（压缩状态等）
          if (data.events?.length) {
            for (const evt of data.events) {
              const e = evt.data as any
              if (e.event === 'compression.started') {
                setCompressionState(sessionId, {
                  compressing: true,
                  messageCount: e.message_count || 0,
                  beforeTokens: e.token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
              } else if (e.event === 'compression.completed') {
                const afterTokens = e.contextTokens || e.afterTokens || 0
                setCompressionState(sessionId, {
                  compressing: false,
                  messageCount: e.totalMessages || 0,
                  beforeTokens: e.beforeTokens || 0,
                  afterTokens,
                  compressed: e.compressed ?? false,
                  error: e.error,
                })
                if (e.contextTokens != null) target.contextTokens = e.contextTokens
              } else if (e.event === 'abort.started') {
                setAbortState({ aborting: true, synced: null })
              } else if (e.event === 'abort.timeout') {
                setAbortState({ aborting: true, synced: false, timedOut: true, message: (e as any).message })
              } else if (e.event === 'abort.completed') {
                setAbortState({ aborting: false, synced: e.synced ?? false })
              } else if (e.event === 'approval.requested') {
                setPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'approval.resolved') {
                clearPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.requested') {
                setPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.resolved') {
                clearPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'run.failed') {
                addAgentErrorMessage(sessionId, e.error)
                serverWorking.value.delete(sessionId)
                queueLengths.value.delete(sessionId)
              } else if (e.event === 'agent.event' || e.event === 'run.reattach_failed') {
                handleAgentEvent(e)
              } else if (e.event === 'tool.started') {
                // 工具开始事件处理
                const msgs = getSessionMsgs(sessionId)
                const toolCallId = e.tool_call_id as string | undefined
                const existingTool = toolCallId
                  ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
                  : null
                if (existingTool) {
                  updateMessage(sessionId, existingTool.id, {
                    toolName: e.tool || e.name,
                    toolArgs: hasRuntimeToolPayload((e as any).arguments) ? (e as any).arguments : existingTool.toolArgs,
                    toolPreview: e.preview || existingTool.toolPreview,
                    toolStatus: existingTool.toolStatus || 'running',
                  })
                } else {
                  addMessage(sessionId, {
                    id: uid(),
                    role: 'tool',
                    content: '',
                    timestamp: Date.now(),
                    toolName: e.tool || e.name,
                    toolCallId,
                    toolPreview: e.preview,
                    toolArgs: runtimeToolPayloadOrUndefined((e as any).arguments),
                    toolStatus: 'running',
                  })
                }
              } else if (e.event === 'tool.completed') {
                // 工具完成事件处理
                const msgs = getSessionMsgs(sessionId)
                const toolCallId = e.tool_call_id as string | undefined
                const toolMsgs = toolCallId
                  ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
                  : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
                if (toolMsgs.length > 0) {
                  const output = runtimeToolPayloadOrUndefined((e as any).output)
                  updateMessage(sessionId, toolMsgs[toolMsgs.length - 1].id, {
                    toolStatus: e.error === true || runtimeToolOutputHasError(output) ? 'error' : 'done',
                    toolDuration: e.duration,
                    toolResult: output,
                  })
                }
              } else if (String(e.event || '').startsWith('subagent.')) {
                // 子 Agent 事件处理
                handleSubagentEvent(sessionId, e as RunEvent)
              }
            }
          }
          resolve()
        }, activeSession.value?.profile)
      })
    } catch (err) {
      console.error('Failed to load session messages via resume:', err)
    } finally {
      isLoadingMessages.value = false
    }

    // 如果会话仍活跃，恢复正在进行中的运行事件监听
    if (activeSessionId.value === sessionId) {
      resumeServerWorkingRun(sessionId)
    }
  }

  /**
   * 加载更早的历史消息（分页加载）
   * 
   * @param sessionId 会话 ID，默认为当前活跃会话
   * @returns 是否成功加载
   */
  async function loadOlderMessages(sessionId = activeSessionId.value): Promise<boolean> {
    if (!sessionId) return false
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target || target.isLoadingOlderMessages || !target.hasMoreBefore) return false
    const offset = target.loadedMessageCount || 0
    const limit = 300
    target.isLoadingOlderMessages = true
    try {
      const page = await fetchSessionMessagesPage(sessionId, offset, limit, target.profile)
      if (!page || page.messages.length === 0) {
        target.hasMoreBefore = false
        return false
      }

      // 过滤掉已存在的消息（防止重复）
      const existingIds = new Set(target.messages.map(message => message.id))
      const olderMessages = mapHermesMessages(page.messages).filter(message => !existingIds.has(message.id))
      
      // 将旧消息插入到消息列表开头
      target.messages = [...olderMessages, ...target.messages]
      target.loadedMessageCount = offset + page.messages.length
      target.messageTotal = page.total
      target.messageCount = page.total
      target.hasMoreBefore = page.hasMore
      return olderMessages.length > 0
    } catch (err) {
      console.error('Failed to load older session messages:', err)
      return false
    } finally {
      target.isLoadingOlderMessages = false
    }
  }

  /**
   * 创建新的聊天会话并切换到该会话
   * 
   * @param options 会话创建选项
   * @returns 新创建的会话
   */
  function newChat(options: {
    profile?: string                          // profile 名称
    model?: string                            // 模型名称
    provider?: string                         // 提供商
    source?: 'api_server' | 'cli' | 'coding_agent'  // 会话来源
    agent?: 'hermes' | 'claude' | 'codex'     // Agent 类型
    codingAgentId?: 'claude-code' | 'codex'   // 编码 Agent ID
    codingAgentMode?: 'global' | 'scoped'     // 编码 Agent 模式
    workspace?: string | null                 // 工作空间
    baseUrl?: string                          // API 基础 URL
    apiKey?: string                           // API Key
    apiMode?: 'chat_completions' | 'codex_responses' | 'anthropic_messages'  // API 模式
  } = {}): Session {
    const appStore = useAppStore()
    const source = options.source || 'cli'
    const isGlobalCodingAgent = source === 'coding_agent' && options.codingAgentMode === 'global'
    const session = createSession({
      profile: options.profile,
      model: isGlobalCodingAgent ? undefined : options.model || appStore.selectedModel || undefined,
      provider: isGlobalCodingAgent ? '' : options.provider || appStore.selectedProvider || '',
      source,
      agent: options.agent,
      codingAgentId: options.codingAgentId,
      codingAgentMode: options.codingAgentMode,
      workspace: options.workspace,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    })
    void switchSession(session.id)
    return session
  }

  /**
   * 切换会话的模型
   * 
   * @param modelId 目标模型 ID
   * @param provider 目标提供商
   * @param sessionId 会话 ID（默认当前活跃会话）
   * @returns 是否切换成功
   */
  async function switchSessionModel(modelId: string, provider?: string, sessionId?: string): Promise<boolean> {
    const targetId = sessionId || activeSession.value?.id
    if (!targetId) return false
    const ok = await setSessionModel(targetId, modelId, provider || '')
    if (!ok) return false
    const target = sessions.value.find(s => s.id === targetId)
    if (target) {
      target.model = modelId
      target.provider = provider || ''
    }
    if (activeSession.value?.id === targetId) {
      activeSession.value.model = modelId
      activeSession.value.provider = provider || ''
    }
    return true
  }

  /**
   * 删除会话
   * 
   * 删除后如果删除的是当前活跃会话，会自动切换到第一个会话或创建新会话
   * 
   * @param sessionId 要删除的会话 ID
   * @returns 是否删除成功
   */
  async function deleteSession(sessionId: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const ok = await deleteSessionApi(sessionId, target?.profile)
    if (!ok) return false
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
    return true
  }

  /**
   * 获取指定会话的消息列表
   * @param sessionId 会话 ID
   * @returns 消息列表（空数组如果会话不存在）
   */
  function getSessionMsgs(sessionId: string): Message[] {
    const s = sessions.value.find(s => s.id === sessionId)
    return s?.messages || []
  }

  /**
   * 向指定会话添加消息
   * @param sessionId 会话 ID
   * @param msg 消息对象
   */
  function addMessage(sessionId: string, msg: Message) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (s) s.messages.push(msg)
  }

  /**
   * 添加或更新会话
   * 
   * 如果会话已存在则更新，否则添加到列表末尾
   * @param session 会话对象
   */
  function addOrUpdateSession(session: Session) {
    const existingIndex = sessions.value.findIndex(s => s.id === session.id)
    if (existingIndex !== -1) {
      sessions.value[existingIndex] = session
    } else {
      sessions.value.push(session)
    }
  }

  /**
   * 更新指定消息
   * 
   * 使用浅合并更新消息属性
   * @param sessionId 会话 ID
   * @param id 消息 ID
   * @param update 要更新的属性
   */
  function updateMessage(sessionId: string, id: string, update: Partial<Message>) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    const idx = s.messages.findIndex(m => m.id === id)
    if (idx !== -1) {
      s.messages[idx] = { ...s.messages[idx], ...update }
    }
  }

  /**
   * 清理会话中所有运行中的工具消息
   * 
   * 将所有状态为 'running' 的工具消息设置为指定状态
   * @param sessionId 会话 ID
   * @param status 目标状态（'done' 或 'error'）
   */
  function settleRunningTools(sessionId: string, status: 'done' | 'error') {
    const msgs = getSessionMsgs(sessionId)
    msgs.forEach((m, i) => {
      if (m.role === 'tool' && m.toolStatus === 'running') {
        msgs[i] = { ...m, toolStatus: status }
      }
    })
  }

  /**
   * 清除会话中的 Agent 事件消息
   * 
   * 过滤掉 commandAction 为 'agent.event' 的消息
   * @param sessionId 会话 ID
   */
  function clearAgentEventMessages(sessionId: string) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    s.messages = s.messages.filter(m => m.commandAction !== 'agent.event')
  }

  /**
   * 处理子 Agent 事件
   * 
   * 将子 Agent 事件转换为工具消息显示，支持以下事件类型：
   * - subagent.start: 子任务开始
   * - subagent.tool: 子任务工具调用
   * - subagent.progress: 子任务进度更新
   * - subagent.complete: 子任务完成
   * 
   * @param sessionId 会话 ID
   * @param evt 运行事件
   */
  function handleSubagentEvent(sessionId: string, evt: RunEvent) {
    const eventName = String(evt.event || '')
    if (!eventName.startsWith('subagent.')) return

    // 构建子 Agent 标识
    const subagentId = String((evt as any).subagent_id || `${(evt as any).task_index ?? 0}`)
    const toolCallId = `subagent:${evt.run_id || 'run'}:${subagentId}`
    const taskIndex = Number((evt as any).task_index ?? 0)
    const taskCount = Number((evt as any).task_count ?? 1)
    const label = `${taskIndex + 1}/${Math.max(1, taskCount || 1)}`
    
    // 提取事件数据
    const toolName = String((evt as any).tool || (evt as any).name || '')
    const toolCount = Number((evt as any).tool_count || 0)
    const goal = String((evt as any).goal || '').trim()
    const text = String(evt.text || evt.preview || '').trim()
    const summary = String((evt as any).summary || '').trim()
    const duration = Number((evt as any).duration_seconds ?? (evt as any).duration)

    // 根据事件类型生成预览文本
    let preview = text || summary || goal
    if (eventName === 'subagent.start') {
      preview = `subagent ${label} started${goal ? `: ${goal}` : ''}`
    } else if (eventName === 'subagent.tool') {
      const prefix = `subagent ${label}${toolCount ? ` turn ${toolCount}` : ''}`
      preview = `${prefix}${toolName ? `: ${toolName}` : ''}${text ? ` - ${text}` : ''}`
    } else if (eventName === 'subagent.progress') {
      preview = `subagent ${label}: ${text || 'working'}`
    } else if (eventName === 'subagent.complete') {
      const status = String((evt as any).status || 'completed')
      preview = `subagent ${label} ${status}${summary ? `: ${summary}` : ''}`
    }

    // 更新或添加工具消息
    const msgs = getSessionMsgs(sessionId)
    const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
    const toolStatus = eventName === 'subagent.complete'
      ? ((evt as any).status && String((evt as any).status) !== 'completed' ? 'error' : 'done')
      : 'running'
    
    const update: Partial<Message> = {
      toolName: 'delegate_task',
      toolCallId,
      toolPreview: preview.slice(0, 220),
      toolStatus,
      toolDuration: Number.isFinite(duration) ? duration : undefined,
      toolResult: eventName === 'subagent.complete'
        ? JSON.stringify({
            status: (evt as any).status || 'completed',
            summary: summary || text,
            api_calls: (evt as any).api_calls,
            input_tokens: (evt as any).input_tokens,
            output_tokens: (evt as any).output_tokens,
          }, null, 2)
        : undefined,
    }

    if (existing) {
      updateMessage(sessionId, existing.id, update)
      return
    }

    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      ...update,
    })
  }

/**
   * 添加 Agent 错误消息
   * 
   * 如果最后一条消息正在流式传输，则更新它为错误状态；
   * 否则添加一条新的错误消息。
   * 
   * @param sessionId 会话 ID
   * @param error 错误对象
   */
  function addAgentErrorMessage(sessionId: string, error?: unknown) {
    const message = errorMessageText(error)
    const content = message ? `Error: ${message}` : 'Run failed'
    const msgs = getSessionMsgs(sessionId)
    const last = msgs[msgs.length - 1]
    
    // 如果最后一条消息正在流式传输，更新它为错误状态
    if (last?.isStreaming) {
      updateMessage(sessionId, last.id, {
        role: 'assistant',
        content,
        isStreaming: false,
        systemType: 'error',
      })
      return
    }
    
    // 防止重复添加相同的错误消息
    if (last?.role === 'assistant' && last.systemType === 'error' && last.content === content) return
    
    // 添加新的错误消息
    addMessage(sessionId, {
      id: uid(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      systemType: 'error',
    })
  }

  /**
   * 处理会话命令事件
   * 
   * 支持的命令类型：
   * - clear: 清空消息历史
   * - title: 更新会话标题
   * - usage: 更新 token 使用情况
   * - destroy: 销毁会话
   * 
   * 使用 WeakSet 防止重复处理相同事件
   * @param evt 运行事件
   */
  function handleSessionCommandEvent(evt: RunEvent) {
    if (seenSessionCommandEvents.has(evt)) return
    seenSessionCommandEvents.add(evt)

    const sid = evt.session_id
    if (!sid) return
    const target = sessions.value.find(s => s.id === sid)
    const action = (evt as any).action as string | undefined
    const command = String((evt as any).command || '').toLowerCase()
    
    // 如果命令开始且非终端命令，标记会话为工作状态
    if ((evt as any).started === true && (evt as any).terminal === false) {
      serverWorking.value.add(sid)
    }

    // 清空命令处理
    if (action === 'clear' && command === 'clear') {
      if (target) target.messages = []
      queuedUserMessages.value.delete(sid)
      queueLengths.value.delete(sid)
      if ((evt as any).clearHistory) {
        const message = String((evt as any).message || '')
        if (message) {
          addMessage(sid, {
            id: uid(),
            role: 'command',
            content: message,
            timestamp: Date.now(),
            systemType: (evt as any).ok === false ? 'error' : 'command',
            commandAction: action,
            commandData: { ...(evt as any) },
          })
        }
      }
      return
    }

    // 标题更新命令处理
    if (action === 'title' && target && typeof (evt as any).title === 'string') {
      target.title = (evt as any).title
      target.updatedAt = Date.now()
    }

    // 使用量更新命令处理
    if (action === 'usage' && target) {
      target.inputTokens = (evt as any).inputTokens
      target.outputTokens = (evt as any).outputTokens
      if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
    }

    // 销毁命令处理
    if (action === 'destroy') {
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      queueLengths.value.delete(sid)
      queuedUserMessages.value.delete(sid)
      setAbortState(null)
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.isStreaming) updateMessage(sid, m.id, { isStreaming: false })
        if (m.role === 'tool' && m.toolStatus === 'running') m.toolStatus = 'error'
      })
    }

    // 添加命令消息（如果有消息内容）
    const message = String((evt as any).message || '')
    if (message) {
      addMessage(sid, {
        id: uid(),
        role: 'command',
        content: message,
        timestamp: Date.now(),
        systemType: (evt as any).ok === false ? 'error' : 'command',
        commandAction: action,
        commandData: { ...(evt as any) },
      })
    }
  }

  /**
   * 处理 Agent 事件
   * 
   * 将 Agent 事件转换为系统消息显示，用于展示 Agent 的状态更新或通知。
   * 如果最后一条消息已经是 agent.event 类型，则更新它，否则添加新消息。
   * 
   * @param evt 运行事件
   */
  function handleAgentEvent(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    // 忽略编码 Agent 的状态事件
    if ((evt as any).source === 'coding_agent' && (evt as any).kind === 'status') return
    const text = String((evt as any).text || (evt as any).message || '').trim()
    if (!text) return

    const msgs = getSessionMsgs(sid)
    const last = msgs[msgs.length - 1]
    const commandData = { ...(evt as any) }
    
    // 如果最后一条消息已经是 agent.event，更新它
    if (last?.role === 'system' && last.commandAction === 'agent.event') {
      if (last.content === text) return
      updateMessage(sid, last.id, {
        content: text,
        timestamp: Date.now(),
        commandData,
      })
      return
    }

    // 添加新的 agent.event 消息
    addMessage(sid, {
      id: uid(),
      role: 'system',
      content: text,
      timestamp: Date.now(),
      commandAction: 'agent.event',
      commandData,
    })
  }

  /**
   * 将用户消息加入队列
   * 
   * 当会话正在运行时，新消息会被加入队列等待处理。
   * 防止重复加入相同 ID 的消息。
   * 
   * @param sessionId 会话 ID
   * @param message 用户消息
   */
  function enqueueUserMessage(sessionId: string, message: Message) {
    const queue = queuedUserMessages.value.get(sessionId) || []
    if (queue.some(item => item.id === message.id)) return
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, [...queue, { ...message, queued: true }])
    queuedUserMessages.value = nextMap
  }

  /**
   * 更新队列中的用户消息
   * @param sessionId 会话 ID
   * @param messageId 消息 ID
   * @param patch 要更新的属性
   */
  function updateQueuedUserMessage(sessionId: string, messageId: string, patch: Partial<Message>) {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return
    const next = queue.map(message => message.id === messageId
      ? { ...message, ...patch, queued: true }
      : message)
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, next)
    queuedUserMessages.value = nextMap
  }

  /**
   * 从队列中移除用户消息（仅本地）
   * 
   * @param sessionId 会话 ID
   * @param messageId 消息 ID
   * @returns 是否成功移除
   */
  function dropQueuedUserMessage(sessionId: string, messageId: string): boolean {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return false
    const next = queue.filter(message => message.id !== messageId)
    if (next.length === queue.length) return false
    const nextMap = new Map(queuedUserMessages.value)
    if (next.length > 0) {
      nextMap.set(sessionId, next)
      queueLengths.value.set(sessionId, next.length)
    } else {
      nextMap.delete(sessionId)
      queueLengths.value.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
    return true
  }

  /**
   * 移除队列中的消息（本地 + 通知服务器）
   * 
   * 从本地队列移除后，还会通过 Socket.IO 通知服务器取消排队的运行。
   * 
   * @param sessionId 会话 ID
   * @param messageId 消息 ID
   */
  function removeQueuedMessage(sessionId: string, messageId: string) {
    if (!dropQueuedUserMessage(sessionId, messageId)) return
    getChatRunSocket()?.emit('cancel_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  /**
   * 规范化队列中的用户消息
   * 
   * 将服务器返回的原始消息格式转换为客户端 Message 格式，
   * 过滤掉无效消息（没有 ID 或内容为空）。
   * 
   * @param rawMessages 原始消息数组
   * @returns 规范化后的消息列表
   */
  function normalizeQueuedUserMessages(rawMessages: unknown): Message[] {
    if (!Array.isArray(rawMessages)) return []
    return rawMessages.flatMap((raw) => {
      const peer = raw as NonNullable<RunEvent['queued_messages']>[number]
      const content = typeof peer?.content === 'string' ? peer.content : ''
      const messageId = peer?.id != null ? String(peer.id) : ''
      if (!messageId || !content.trim()) return []
      const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
        ? Math.round(peer.timestamp * 1000)
        : Date.now()
      const role = peer?.role === 'command' ? 'command' : 'user'
      return [{
        id: messageId,
        role,
        content,
        timestamp,
        queued: true,
        systemType: role === 'command' ? 'command' as const : undefined,
      }]
    })
  }

  /**
   * 替换队列中的用户消息
   * 
   * 合并现有消息的附件（避免丢失本地文件引用），并更新队列长度。
   * 
   * @param sessionId 会话 ID
   * @param messages 新的消息列表
   */
  function replaceQueuedUserMessages(sessionId: string, messages: Message[]) {
    const existingById = new Map((queuedUserMessages.value.get(sessionId) || []).map(message => [message.id, message]))
    const merged = messages.map(message => ({
      ...(existingById.get(message.id) || {}),
      ...message,
      attachments: existingById.get(message.id)?.attachments || message.attachments,
      queued: true,
    }))
    const nextMap = new Map(queuedUserMessages.value)
    if (merged.length > 0) {
      nextMap.set(sessionId, merged)
    } else {
      nextMap.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
  }

  /**
   * 标记队列 ID 为已出队（服务器报告出队但对等消息尚未到达）
   * 
   * 用于处理消息到达顺序问题：服务器报告消息出队，但实际消息可能还没到客户端。
   * 
   * @param sessionId 会话 ID
   * @param messageId 消息 ID
   */
  function markDequeuedQueueId(sessionId: string, messageId: string) {
    const nextMap = new Map(dequeuedQueueIds.value)
    const ids = new Set(nextMap.get(sessionId) || [])
    ids.add(messageId)
    nextMap.set(sessionId, ids)
    dequeuedQueueIds.value = nextMap
  }

  /**
   * 消费已出队的队列 ID
   * 
   * 当消息到达时，检查是否已经标记为出队，如果是则消费该标记。
   * 
   * @param sessionId 会话 ID
   * @param messageId 消息 ID
   * @returns 是否成功消费
   */
  function consumeDequeuedQueueId(sessionId: string, messageId: string): boolean {
    const ids = dequeuedQueueIds.value.get(sessionId)
    if (!ids?.has(messageId)) return false
    const nextIds = new Set(ids)
    nextIds.delete(messageId)
    const nextMap = new Map(dequeuedQueueIds.value)
    if (nextIds.size > 0) nextMap.set(sessionId, nextIds)
    else nextMap.delete(sessionId)
    dequeuedQueueIds.value = nextMap
    return true
  }

  /**
   * 处理运行排队事件
   * 
   * 处理服务器发送的队列状态更新，包括：
   * 1. 更新队列长度
   * 2. 处理消息出队（从队列移除并添加到消息列表）
   * 3. 更新队列消息列表
   * 4. 添加新的排队消息
   * 
   * @param sessionId 会话 ID
   * @param evt 运行事件
   */
  function handleRunQueuedEvent(sessionId: string, evt: RunEvent) {
    // 更新队列长度
    const queueLength = Number((evt as any).queue_length || 0)
    if (queueLength > 0) {
      queueLengths.value.set(sessionId, queueLength)
    } else {
      queueLengths.value.delete(sessionId)
    }

    // 处理消息出队
    const dequeuedId = (evt as any).dequeued_queue_id != null
      ? String((evt as any).dequeued_queue_id)
      : ''
    if (dequeuedId) {
      const existingQueue = queuedUserMessages.value.get(sessionId) || []
      const dequeued = existingQueue.find(message => message.id === dequeuedId)
      
      // 更新队列消息列表
      if (Array.isArray((evt as any).queued_messages)) {
        const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
        replaceQueuedUserMessages(sessionId, queued)
      } else {
        const nextQueue = existingQueue.filter(message => message.id !== dequeuedId)
        replaceQueuedUserMessages(sessionId, nextQueue)
      }
      
      // 如果出队消息存在且不在消息列表中，添加到消息列表
      if (dequeued && !getSessionMsgs(sessionId).some(message => message.id === dequeued.id)) {
        addMessage(sessionId, { ...dequeued, queued: false })
        updateSessionTitle(sessionId)
      } else if (!dequeued) {
        // 消息还没到，标记为已出队
        markDequeuedQueueId(sessionId, dequeuedId)
      }
      return
    }

    // 更新完整队列消息列表
    if (Array.isArray((evt as any).queued_messages)) {
      const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
      replaceQueuedUserMessages(sessionId, queued)
      return
    }

    // 添加新的排队消息
    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    const messageId = peer?.id != null ? String(peer.id) : ''
    if (!messageId || !content.trim()) return

    // 防止重复添加
    if ((queuedUserMessages.value.get(sessionId) || []).some(msg => msg.id === messageId)) return

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()
    const msgs = getSessionMsgs(sessionId)
    
    // 如果消息已在消息列表中，先移除它
    const existingIndex = msgs.findIndex(msg => msg.id === messageId && msg.role === 'user')
    const existing = existingIndex >= 0 ? msgs[existingIndex] : null
    if (existingIndex >= 0) {
      msgs.splice(existingIndex, 1)
    }

    // 添加到队列
    enqueueUserMessage(sessionId, {
      ...(existing || {}),
      id: messageId,
      role: peer?.role === 'command' ? 'command' : 'user',
      content,
      timestamp: existing?.timestamp || timestamp,
      attachments: existing?.attachments,
      queued: true,
      systemType: peer?.role === 'command' ? 'command' : existing?.systemType,
    })
  }

  /**
   * 设置待审批请求
   * 
   * 根据事件数据创建待审批对象，支持特殊处理内存写入请求（限制为 once/deny）。
   * 
   * @param evt 运行事件
   */
  function setPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    const approvalId = (evt as any).approval_id as string | undefined
    if (!sid || !approvalId) return
    const description = String((evt as any).description || '')
    const normalizedDescription = description.trim().toLowerCase().replace(/\s+/g, ' ')
    
    // 判断是否为内存写入请求（限制选项为 once/deny）
    const isMemoryWrite = !Boolean((evt as any).allow_permanent) && (
      normalizedDescription === 'save to memory' ||
      normalizedDescription.startsWith('save to memory:') ||
      normalizedDescription.startsWith('save to memory?')
    )
    
    // 过滤有效选项
    const rawChoices = Array.isArray((evt as any).choices) ? (evt as any).choices : ['once', 'session', 'deny']
    const choices = rawChoices
      .filter((choice: unknown): choice is PendingApproval['choices'][number] =>
        choice === 'once' || choice === 'session' || choice === 'always' || choice === 'deny')
    
    pendingApprovals.value.set(sid, {
      sessionId: sid,
      approvalId,
      command: String((evt as any).command || ''),
      description,
      choices: isMemoryWrite ? ['once', 'deny'] : choices.length ? choices : ['once', 'session', 'deny'],
      allowPermanent: Boolean((evt as any).allow_permanent),
      isMemoryWrite,
      requestedAt: Date.now(),
    })
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  /**
   * 清除待审批请求
   * 
   * 根据会话 ID 和审批 ID 清除待审批请求。
   * 
   * @param evt 运行事件
   */
  function clearPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const current = pendingApprovals.value.get(sid)
    if (!current) return
    const approvalId = (evt as any).approval_id
    // 如果指定了审批 ID，确保匹配才清除
    if (approvalId && current.approvalId !== approvalId) return
    pendingApprovals.value.delete(sid)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  /**
   * 设置待澄清请求
   * 
   * 创建待澄清对象，包含问题、可选选项和超时时间。
   * 
   * @param evt 运行事件
   */
  function setPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    const clarifyId = (evt as any).clarify_id as string | undefined
    if (!sid || !clarifyId) return
    pendingClarifies.value.set(sid, {
      sessionId: sid,
      clarifyId,
      question: String((evt as any).question || ''),
      choices: Array.isArray((evt as any).choices) ? (evt as any).choices : null,
      timeoutMs: Number((evt as any).timeout_ms) || 300000,
      requestedAt: Date.now(),
    })
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  /**
   * 清除待澄清请求
   * 
   * 根据会话 ID 和澄清 ID 清除待澄清请求。
   * 
   * @param evt 运行事件
   */
  function clearPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const current = pendingClarifies.value.get(sid)
    if (!current) return
    const clarifyId = (evt as any).clarify_id
    // 如果指定了澄清 ID，确保匹配才清除
    if (clarifyId && current.clarifyId !== clarifyId) return
    pendingClarifies.value.delete(sid)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  /**
   * 清除会话的所有待处理交互（审批和澄清）
   * 
   * @param sessionId 会话 ID
   */
  function clearPendingInteractions(sessionId: string) {
    let changed = false
    if (pendingApprovals.value.has(sessionId)) {
      pendingApprovals.value.delete(sessionId)
      changed = true
    }
    if (pendingClarifies.value.has(sessionId)) {
      pendingClarifies.value.delete(sessionId)
      changed = true
    }
    if (changed) {
      pendingApprovals.value = new Map(pendingApprovals.value)
      pendingClarifies.value = new Map(pendingClarifies.value)
    }
  }

  /**
   * 响应对待澄清请求
   * 
   * 发送响应到服务器并清除本地待澄清状态。
   * 
   * @param response 用户的响应文本
   */
  function respondToClarify(response: string) {
    const pending = activePendingClarify.value
    if (!pending) return
    respondClarify(pending.sessionId, pending.clarifyId, response)
    pendingClarifies.value.delete(pending.sessionId)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  /**
   * 响应对待审批请求
   * 
   * 发送审批选择到服务器并清除本地待审批状态。
   * 
   * @param choice 审批选择（once/session/always/deny）
   */
  function respondApproval(choice: PendingApproval['choices'][number]) {
    const pending = activePendingApproval.value
    if (!pending) return
    respondToolApproval(pending.sessionId, pending.approvalId, choice)
    pendingApprovals.value.delete(pending.sessionId)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  /**
   * 更新会话标题
   * 
   * 如果会话没有标题，从第一条用户消息生成。
   * 
   * @param sessionId 会话 ID
   */
  function updateSessionTitle(sessionId: string) {
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target) return
    if (!target.title) {
      const firstUser = target.messages.find(m => m.role === 'user')
      if (firstUser) {
        // 如果有附件，使用附件名称作为标题；否则使用消息内容
        const title = firstUser.attachments?.length
          ? firstUser.attachments.map(a => a.name).join(', ')
          : firstUser.content
        target.title = title.slice(0, 40) + (title.length > 40 ? '...' : '')
      }
    }
    target.updatedAt = Date.now()
  }

  /**
   * 应用服务器生成的会话标题
   * 
   * 当服务器返回生成的标题时更新会话标题。
   * 
   * @param evt 运行事件
   */
  function applyGeneratedSessionTitle(evt: RunEvent) {
    const sid = evt.session_id
    const title = typeof (evt as any).title === 'string' ? (evt as any).title.trim() : ''
    if (!sid || !title) return
    const target = sessions.value.find(s => s.id === sid)
    if (target) {
      target.title = title
      target.updatedAt = Date.now()
    }
    // 同时更新活跃会话的标题引用
    if (activeSession.value?.id === sid) {
      activeSession.value.title = title
    }
  }

  /**
   * 如果启用了完成提示音，预加载音频
   */
  function primeCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      primeCompletionSound()
    }
  }

  /**
   * 如果启用了完成提示音，播放音频
   */
  function playCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      void playCompletionSound()
    }
  }

  /**
   * 截断通知文本（去除多余空格并限制长度）
   * 
   * @param value 原始文本
   * @param maxLength 最大长度
   * @returns 截断后的文本
   */
  function truncateNotificationText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
  }

  /**
   * 获取完成通知的 Agent 图标
   * 
   * 根据会话的 Agent 类型返回对应的图标路径。
   * 
   * @param session 会话对象
   * @returns 包含图标的对象
   */
  function completionNotificationAgent(session: Session): { icon: string } {
    const codingAgentId = session.codingAgentId || (session.agent === 'codex' ? 'codex' : session.agent === 'claude' ? 'claude-code' : undefined)
    if (codingAgentId === 'codex') {
      return { icon: '/coding-agents/codex-openai.png' }
    }
    if (codingAgentId === 'claude-code') {
      return { icon: '/coding-agents/claude-code.svg' }
    }
    return { icon: '/coding-agents/hermes.png' }
  }

  /**
   * 生成完成通知的正文内容
   * 
   * @param session 会话对象
   * @param message 消息对象（可选）
   * @returns 通知正文
   */
  function completionNotificationBody(session: Session, message?: Message): string {
    const preview = message?.content || session.title || 'Message complete.'
    return truncateNotificationText(preview, 140)
  }

  /**
   * 如果启用了完成通知，显示桌面通知
   * 
   * @param sessionId 会话 ID
   * @param messageId 消息 ID（可选）
   */
  function showCompletionNotificationIfEnabled(sessionId: string, messageId?: string | null) {
    const settingsStore = useSettingsStore()
    if (!settingsStore.display.notify_on_complete) return

    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    
    // 找到对应的消息（优先使用指定的消息 ID，否则找最后一条助手消息）
    const message = messageId
      ? session.messages.find(m => m.id === messageId)
      : [...session.messages].reverse().find(m => m.role === 'assistant')

    const agent = completionNotificationAgent(session)
    void showCompletionNotification({
      title: truncateNotificationText(session.title || 'Hermes', 80),
      body: completionNotificationBody(session, message),
      icon: agent.icon,
      tag: `hermes-complete-${sessionId}-${message?.id || Date.now()}`,
    })
  }

  /**
   * 发送消息
   * 
   * 消息发送的核心流程：
   * 1. 验证内容（非空或有附件）
   * 2. 预加载完成提示音
   * 3. 如果没有活跃会话，创建新会话
   * 4. 构建用户消息对象（支持排队）
   * 5. 处理附件上传和内容块构建
   * 6. 构建运行请求 Payload
   * 7. 调用 startRun API 发起运行
   * 8. 注册运行事件回调
   * 
   * @param content 消息内容
   * @param attachments 附件列表（可选）
   */
  async function sendMessage(content: string, attachments?: Attachment[]) {
    // 验证内容：必须有文本或附件
    if ((!content.trim() && !(attachments && attachments.length > 0))) return

    // 预加载完成提示音
    primeCompletionBellIfEnabled()

    // 如果没有活跃会话，创建新会话
    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // 在发送时捕获会话 ID —— 所有回调都使用这个，而不是 activeSessionId
    const sid = activeSessionId.value!
    
    // 判断是否需要发送初始会话配置（首次消息）
    const shouldSendInitialSessionConfig = activeSession.value
      ? activeSession.value.messageCount == null || activeSession.value.messageCount === 0
      : false
    
    // 判断会话类型
    const isCodingAgentSession = activeSession.value?.source === 'coding_agent'
    const isBridgeSlashCommand = !isCodingAgentSession && content.trim().startsWith('/')
    const isBridgeCompressCommand = isBridgeSlashCommand && /^\/compress(?:\s|$)/i.test(content.trim())
    const isBridgePlanCommand = isBridgeSlashCommand && /^\/plan(?:\s|$)/i.test(content.trim())
    const isBridgeGoalCommand = isBridgeSlashCommand && /^\/goal(?:\s|$)/i.test(content.trim())
    
    // 判断是否需要排队（会话正在运行时，除了压缩命令外的消息都需要排队）
    const wasLiveBeforeSend = isSessionLive(sid)
    const shouldQueue = wasLiveBeforeSend && (!isBridgeSlashCommand || isBridgePlanCommand)

    // 创建用户消息对象
    const userMsg: Message = {
      id: uid(),
      role: isBridgeSlashCommand ? 'command' : 'user',
      content: content.trim(),
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      queued: shouldQueue,
      systemType: isBridgeSlashCommand ? 'command' : undefined,
    }

    // 如果需要排队，添加到队列；否则直接添加到消息列表
    if (shouldQueue) {
      enqueueUserMessage(sid, userMsg)
    } else {
      addMessage(sid, userMsg)
      updateSessionTitle(sid)
      if (!isCodingAgentSession) serverWorking.value.add(sid)
    }

    let runSubmitted = false
    try {

      // 构建 Anthropic 格式的输入
      let input: string | ContentBlock[]
      if (attachments && attachments.length > 0) {
        // 有附件：先上传，然后构建内容块
        const uploaded = await uploadFiles(attachments)

        // 更新用户消息上的附件 URL 用于显示
        const urlMap = new Map(uploaded.map(f => {
          return [f.name, getDownloadUrl(f.path, f.name)]
        }))
        if (shouldQueue && userMsg.attachments) {
          userMsg.attachments = userMsg.attachments.map(a => {
            const dl = urlMap.get(a.name)
            return dl ? { ...a, url: dl } : a
          })
          updateQueuedUserMessage(sid, userMsg.id, { attachments: userMsg.attachments })
        } else {
          const msgs = getSessionMsgs(sid)
          const lastUser = msgs.findLast(m => m.id === userMsg.id)
          if (lastUser?.attachments) {
            lastUser.attachments = lastUser.attachments.map(a => {
              const dl = urlMap.get(a.name)
              return dl ? { ...a, url: dl } : a
            })
          }
        }

        // 使用上传的文件路径构建内容块
        input = await buildContentBlocks(content, attachments, uploaded)
      } else {
        // 无附件：使用纯文本格式
        input = content.trim()
      }

      // 获取运行配置
      const appStore = useAppStore()
      await appStore.waitForModelsForRun()
      const sessionModel = activeSession.value?.model || appStore.selectedModel
      const sessionProvider = activeSession.value?.provider || appStore.selectedProvider
      const sessionProfile = activeSession.value?.profile || useProfilesStore().activeProfileName || undefined
      const profileModelGroups = sessionProfile
        ? appStore.profileModelGroups.find(entry => entry.profile === sessionProfile)?.groups
        : undefined
      const runModelGroups = profileModelGroups?.length ? profileModelGroups : appStore.modelGroups
      const providerGroup = runModelGroups.find(group => group.provider === sessionProvider)
      const sessionSource: StartRunRequest['source'] = activeSession.value?.source === 'coding_agent' ? 'coding_agent' : 'cli'
      const codingAgentId: 'claude-code' | 'codex' =
        activeSession.value?.codingAgentId ||
        (activeSession.value?.agent === 'codex' ? 'codex' : 'claude-code')
      const codingAgentMode = activeSession.value?.codingAgentMode || 'scoped'
      
      // 构建运行请求 Payload
      const runPayload: StartRunRequest = {
        input,
        session_id: sid,
        profile: sessionProfile,
        // 根据会话类型和模式决定是否发送 model/provider
        model: sessionSource === 'coding_agent'
          ? (codingAgentMode === 'global' ? undefined : sessionModel || undefined)
          : shouldSendInitialSessionConfig ? sessionModel || undefined : undefined,
        provider: sessionSource === 'coding_agent'
          ? (codingAgentMode === 'global' ? undefined : sessionProvider || undefined)
          : shouldSendInitialSessionConfig ? sessionProvider || undefined : undefined,
        model_groups: runModelGroups.map(group => ({
          provider: group.provider,
          models: group.models,
        })),
        queue_id: userMsg.id,
        workspace: activeSession.value?.workspace || undefined,
        source: sessionSource,
        // Coding Agent 特有配置
        ...(sessionSource === 'coding_agent'
          ? {
              coding_agent_id: codingAgentId,
              mode: codingAgentMode,
              baseUrl: codingAgentMode === 'global' ? undefined : activeSession.value?.baseUrl || providerGroup?.base_url || undefined,
              apiKey: codingAgentMode === 'global' ? undefined : activeSession.value?.apiKey || providerGroup?.api_key || undefined,
              apiMode: codingAgentMode === 'global' ? undefined : activeSession.value?.apiMode || providerGroup?.api_mode || undefined,
            }
          : {}),
        // 每会话推理努力覆盖。Coding Agent runner 目前不使用此设置，保持 payload 显式。
        reasoning_effort: sessionSource === 'coding_agent' ? undefined : activeSession.value?.reasoningEffort || undefined,
      }
      
      // 如果是首次消息，更新消息计数
      if (shouldSendInitialSessionConfig && activeSession.value) {
        activeSession.value.messageCount = Math.max(activeSession.value.messageCount || 0, 1)
      }

      /**
       * 清理会话的流状态
       */
      const cleanup = () => {
        streamStates.value.delete(sid)
        serverWorking.value.delete(sid)
      }

      /**
       * 每活跃运行的标志，用于在 run.completed 时检测静默吞没的错误。
       * hermes-agent 偶尔会在代理层捕获上游错误（如无效 API 密钥）时，
       * 发出带有空输出且无使用量的 run.completed。
       * 需要区分：(a) 产生了助手文本的运行，(b) 只有工具活动的运行，(c) 确实没有任何可见内容的运行。
       * 在每次 run.started 时重置，因为一个处理程序可能跨越多个排队的运行。
       */
      let runProducedAssistantText = false
      let runProducedAssistantContent = false
      let runHadToolActivity = false
      let activeAssistantMessageId: string | null = null
      let reasoningAssistantMessageId: string | null = null
      let activeRunMarker: string | null = null

      /**
       * 关闭所有流式助手消息（设置 isStreaming 为 false）
       */
      const closeStreamingAssistant = () => {
        const msgs = getSessionMsgs(sid)
        msgs.forEach(m => {
          if (m.role === 'assistant' && m.isStreaming) {
            updateMessage(sid, m.id, { isStreaming: false })
          }
        })
        activeAssistantMessageId = null
        reasoningAssistantMessageId = null
        activeRunMarker = null
      }

      /**
       * 应用重连恢复数据
       * 
       * 当 Socket.IO 重连后，服务器会发送恢复数据，包括消息列表、运行状态、队列等。
       * 此函数负责将这些数据应用到本地状态。
       * 
       * @param data 恢复会话的 payload
       */
      const applyReconnectResume = (data: ResumeSessionPayload) => {
        if (data.session_id !== sid) return
        const target = sessions.value.find(s => s.id === sid)
        if (!target) return

        // 更新服务器工作状态
        if (data.isWorking) serverWorking.value.add(sid)
        else serverWorking.value.delete(sid)

        // 更新队列长度
        if (data.queueLength && data.queueLength > 0) {
          queueLengths.value.set(sid, data.queueLength)
        } else {
          queueLengths.value.delete(sid)
        }

        // 更新队列消息
        if (Array.isArray(data.queueMessages)) {
          replaceQueuedUserMessages(sid, normalizeQueuedUserMessages(data.queueMessages))
        } else if (!data.queueLength) {
          replaceQueuedUserMessages(sid, [])
        }

        // 更新中断状态
        if (data.isAborting) {
          setAbortState({ aborting: true, synced: null })
        } else if (!data.isWorking) {
          setAbortState(null)
        }
        if (!data.isWorking) setCompressionState(sid, null)

        // 更新 token 计数
        if (data.inputTokens != null) target.inputTokens = data.inputTokens
        if (data.outputTokens != null) target.outputTokens = data.outputTokens
        if (data.contextTokens != null) target.contextTokens = data.contextTokens

        // 更新消息列表
        if (Array.isArray(data.messages)) {
          const previousActiveAssistantMessageId = activeAssistantMessageId
          const previousReasoningAssistantMessageId = reasoningAssistantMessageId
          const replayRunMarker = getReplayRunMarker(data.events) ?? activeRunMarker
          
          target.messages = mapHermesMessages(data.messages as any[])
          target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
          target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
          target.messageCount = target.messageTotal
          target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal

          // 解析恢复的助手状态
          const resumedAssistantState = data.isWorking
            ? resolveResumedAssistantState(target.messages, {
                previousActiveAssistantMessageId,
                previousReasoningAssistantMessageId,
                activeRunMarker: replayRunMarker,
              })
            : {
                activeAssistant: null,
                reasoningAssistant: null,
                runMarker: null,
                hadVisibleText: false,
              }

          const resumedActiveAssistant = resumedAssistantState.activeAssistant
          const resumedReasoningAssistant = resumedAssistantState.reasoningAssistant
          activeRunMarker = resumedAssistantState.runMarker

          // 更新活跃助手消息
          if (resumedActiveAssistant) {
            resumedActiveAssistant.isStreaming = true
            activeAssistantMessageId = resumedActiveAssistant.id
            if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
          } else {
            activeAssistantMessageId = null
          }

          // 更新推理消息
          if (resumedReasoningAssistant) {
            reasoningAssistantMessageId = resumedReasoningAssistant.id
            if (resumedReasoningAssistant.reasoning) noteReasoningStart(resumedReasoningAssistant.id)
          } else {
            reasoningAssistantMessageId = null
          }
        }

        // 重放事件（压缩、中断、审批、澄清等）
        if (data.events?.length) {
          for (const evt of data.events) {
            const e = evt.data as RunEvent
            switch (e.event) {
              case 'compression.started':
                setCompressionState(sid, {
                  compressing: true,
                  messageCount: (e as any).message_count || 0,
                  beforeTokens: (e as any).token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
                break
              case 'compression.completed': {
                const afterTokens = (e as any).contextTokens || (e as any).afterTokens || 0
                setCompressionState(sid, {
                  compressing: false,
                  messageCount: (e as any).totalMessages || 0,
                  beforeTokens: (e as any).beforeTokens || 0,
                  afterTokens,
                  compressed: (e as any).compressed ?? false,
                  error: (e as any).error,
                })
                if ((e as any).contextTokens != null) target.contextTokens = (e as any).contextTokens
                break
              }
              case 'abort.started':
                setAbortState({ aborting: true, synced: null })
                break
              case 'abort.timeout':
                setAbortState({ aborting: true, synced: false, timedOut: true, message: (e as any).message })
                break
              case 'abort.completed':
                setAbortState({ aborting: false, synced: (e as any).synced ?? false })
                break
              case 'approval.requested':
                setPendingApproval({ ...e, session_id: sid })
                break
              case 'approval.resolved':
                clearPendingApproval({ ...e, session_id: sid })
                break
              case 'clarify.requested':
                setPendingClarify({ ...e, session_id: sid })
                break
              case 'clarify.resolved':
                clearPendingClarify({ ...e, session_id: sid })
                break
              case 'run.failed':
                addAgentErrorMessage(sid, e.error)
                break
              case 'agent.event':
                handleAgentEvent(e)
                break
            }
          }
        }

        // 更新活跃会话引用
        if (activeSessionId.value === sid) activeSession.value = target
        
        // 如果运行已完成且无队列消息，清理状态
        if (!data.isWorking && !(data.queueLength && data.queueLength > 0)) {
          clearAgentEventMessages(sid)
          cleanup()
          activeAssistantMessageId = null
          updateSessionTitle(sid)
        }
      }

      // 通过 Socket.IO 发送运行请求并监听流式事件 —— 所有闭包都捕获 `sid`
      const ctrl = startRunViaSocket(
        runPayload,
        // onEvent 回调：处理运行事件
        (evt: RunEvent) => {
          const eventRunMarker = readRunMarker(evt)
          if (eventRunMarker) activeRunMarker = eventRunMarker
          switch (evt.event) {
            case 'run.started':
              // 运行开始：重置状态
              serverWorking.value.add(sid)
              clearAgentEventMessages(sid)
              setAbortState(null)
              setCompressionState(sid, null)
              runProducedAssistantText = false
              runProducedAssistantContent = false
              runHadToolActivity = false
              closeStreamingAssistant()
              activeRunMarker = readRunMarker(evt) ?? null
              // 更新队列长度
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
              } else {
                queueLengths.value.delete(sid)
              }
              break

            case 'run.queued': {
              // 运行排队：更新队列状态
              handleRunQueuedEvent(sid, evt)
              break
            }

            case 'session.command': {
              // 会话命令：处理命令事件（如重命名会话）
              handleSessionCommandEvent(evt)
              break
            }

            case 'agent.event': {
              // 代理事件：处理自定义代理事件
              handleAgentEvent(evt)
              break
            }

            case 'run.reattach_failed': {
              // 重连失败：作为代理事件处理
              handleAgentEvent(evt)
              break
            }

            case 'compression.started': {
              // 压缩开始：设置压缩状态
              setCompressionState(sid, {
                compressing: true,
                messageCount: (evt as any).message_count || 0,
                beforeTokens: (evt as any).token_count || 0,
                afterTokens: 0,
                compressed: null,
              })
              break
            }

            case 'compression.completed': {
              // 压缩完成：更新压缩状态和 token 计数
              const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
              setCompressionState(sid, {
                compressing: false,
                messageCount: (evt as any).totalMessages || 0,
                beforeTokens: (evt as any).beforeTokens || 0,
                afterTokens,
                compressed: (evt as any).compressed ?? false,
                error: (evt as any).error,
              })
              // 更新上下文 token 计数
              if ((evt as any).contextTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) target.contextTokens = (evt as any).contextTokens
              }
              // 5秒后自动清除压缩状态
              setTimeout(() => {
                const state = compressionStates.value.get(sid)
                if (state && !state.compressing) {
                  setCompressionState(sid, null)
                }
              }, 5000)
              break
            }

            case 'abort.started': {
              // 中断开始：设置中断状态
              setAbortState({ aborting: true, synced: null })
              break
            }

            case 'abort.timeout': {
              // 中断超时：设置中断状态并标记超时
              setAbortState({ aborting: true, synced: false, timedOut: true, message: (evt as any).message })
              break
            }

            case 'abort.completed': {
              // 中断完成：清理状态
              setAbortState({ aborting: false, synced: (evt as any).synced ?? false })
              clearPendingInteractions(sid)
              // 如果还有队列消息，更新队列长度并继续
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
                setAbortState(null)
                break
              }
              // 结束流式消息
              const msgs = getSessionMsgs(sid)
              const lastMsg = msgs[msgs.length - 1]
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              // 将所有运行中的工具状态改为完成
              msgs.forEach((m, i) => {
                if (m.role === 'tool' && m.toolStatus === 'running') {
                  msgs[i] = { ...m, toolStatus: 'done' }
                }
              })
              cleanup()
              setAbortState(null)
              break
            }

            case 'reasoning.delta':
            case 'thinking.delta': {
              // 推理增量：累积推理文本
              const text = evt.text || evt.delta || ''
              if (!text) break
              runProducedAssistantText = true
              const msgs = getSessionMsgs(sid)
              const reasoningTargetId = reasoningAssistantMessageId || activeAssistantMessageId
              const last = reasoningTargetId
                ? msgs.find(m => m.id === reasoningTargetId)
                : null
              if (last?.role === 'assistant') {
                // 追加到现有消息的 reasoning 字段
                last.reasoning = (last.reasoning || '') + text
                reasoningAssistantMessageId = last.id
                noteReasoningStart(last.id)
              } else {
                // 创建新的助手消息（仅包含推理）
                const newId = uid()
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                  isStreaming: true,
                  reasoning: text,
                })
                activeAssistantMessageId = newId
                reasoningAssistantMessageId = newId
                noteReasoningStart(newId)
              }
              break
            }

            case 'reasoning.available': {
              // 推理可用：标记推理结束（上游发送的是预览内容，不是真正的推理）
              // 只作为"思考结束"信号，停止时长计数器
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                // 只有当 reasoning.delta 事件曾经启动过计时，才标记结束；
                // 否则（上游未转发 delta，只发这一次 available）不显示时长。
                noteReasoningEnd(last.id)
              }
              break
            }

            case 'message.delta': {
              // 消息增量：累积助手回复文本
              if (evt.delta) {
                runProducedAssistantText = true
                runProducedAssistantContent = true
              }
              const msgs = getSessionMsgs(sid)
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : null
              if (last?.role === 'assistant' && last.isStreaming) {
                // 追加到现有消息
                const prev = last.content
                const next = prev + (evt.delta || '')
                noteThinkingDelta(last.id, prev, next)
                // 若之前有 reasoning 累积，则 content 到达即视为推理结束
                if (last.reasoning) noteReasoningEnd(last.id)
                last.content = next
              } else {
                // 创建新的助手消息
                const newId = uid()
                const nextContent = evt.delta || ''
                noteThinkingDelta(newId, '', nextContent)
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: nextContent,
                  timestamp: Date.now(),
                  isStreaming: true,
                })
                activeAssistantMessageId = newId
              }
              break
            }

            case 'session.title.updated': {
              // 会话标题更新：应用服务器生成的标题
              applyGeneratedSessionTitle(evt)
              break
            }

            case 'tool.started': {
              // 工具调用开始：创建或更新工具消息
              runHadToolActivity = true
              const msgs = getSessionMsgs(sid)
              const toolCallId = (evt as any).tool_call_id as string | undefined
              // 找到相关的助手消息并结束流式
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              if (last?.isStreaming) {
                updateMessage(sid, last.id, { isStreaming: false })
              }
              activeAssistantMessageId = null
              // 查找是否已存在相同 toolCallId 的工具消息
              const existingTool = toolCallId
                ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
                : null
              if (existingTool) {
                // 更新现有工具消息
                updateMessage(sid, existingTool.id, {
                  toolName: evt.tool || evt.name,
                  toolArgs: hasRuntimeToolPayload((evt as any).arguments) ? (evt as any).arguments : existingTool.toolArgs,
                  toolPreview: evt.preview || existingTool.toolPreview,
                  toolStatus: existingTool.toolStatus || 'running',
                })
                break
              }
              // 创建新的工具消息
              addMessage(sid, {
                id: uid(),
                role: 'tool',
                content: '',
                timestamp: Date.now(),
                toolName: evt.tool || evt.name,
                toolCallId,
                toolPreview: evt.preview,
                toolArgs: runtimeToolPayloadOrUndefined((evt as any).arguments),
                toolStatus: 'running',
              })
              break
            }

            case 'tool.completed': {
              // 工具调用完成：更新工具消息状态和结果
              runHadToolActivity = true
              const msgs = getSessionMsgs(sid)
              const toolCallId = (evt as any).tool_call_id as string | undefined
              // 查找相关的工具消息（优先按 toolCallId，否则找运行中的工具）
              const toolMsgs = toolCallId
                ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
                : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
              if (toolMsgs.length > 0) {
                const last = toolMsgs[toolMsgs.length - 1]
                const output = runtimeToolPayloadOrUndefined((evt as any).output)
                const hasError = (evt as any).error === true || runtimeToolOutputHasError(output)
                const duration = (evt as any).duration
                updateMessage(sid, last.id, {
                  toolStatus: hasError ? 'error' : 'done',
                  toolDuration: duration,
                  toolResult: output,
                })
              }
              break
            }

            case 'subagent.start':
            case 'subagent.tool':
            case 'subagent.progress':
            case 'subagent.complete': {
              // 子 Agent 事件：处理子任务相关事件
              runHadToolActivity = true
              handleSubagentEvent(sid, evt)
              break
            }

            case 'approval.requested': {
              // 审批请求：设置待审批状态
              setPendingApproval(evt)
              break
            }

            case 'approval.resolved': {
              // 审批解决：清除待审批状态
              clearPendingApproval(evt)
              break
            }

            case 'clarify.requested': {
              // 澄清请求：设置待澄清状态
              setPendingClarify(evt)
              break
            }

            case 'clarify.resolved': {
              // 澄清解决：清除待澄清状态
              clearPendingClarify(evt)
              break
            }

            case 'run.completed': {
              // 运行完成：清理状态、更新消息、处理最终输出
              clearAgentEventMessages(sid)
              const msgs = getSessionMsgs(sid)
              const lastMsg = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
                ? lastMsg.id
                : null
              
              // 结束流式消息
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              
              // 完成所有运行中的工具
              settleRunningTools(sid, 'done')
              
              // 更新服务器计算的 token 使用量
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                  if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
                }
              }
              
              // 备用方案：某些提供商可能只通过 run.completed.output 发送最终助手文本（无 message.delta 流）。
              // 如果从未产生过助手文本但网关报告了非空输出，则回退到渲染为单个助手消息。
              let finalOutputTrimmed = ''
              
              // 检查后端是否提供了解析后的内容（从字符串化数组格式）
              if ((evt as any).parsed_content !== undefined) {
                // 后端有解析的字符串化数组格式，更新最后一条助手消息
                const msgs = getSessionMsgs(sid)
                const lastAssistant = activeAssistantMessageId
                  ? msgs.find(m => m.id === activeAssistantMessageId)
                  : completedAssistantMessageId
                    ? msgs.find(m => m.id === completedAssistantMessageId)
                    : undefined
                const parsedContent = typeof (evt as any).parsed_content === 'string'
                  ? (evt as any).parsed_content
                  : ''
                const parsedContentTrimmed = parsedContent.trim()
                
                if (lastAssistant) {
                  const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
                  // 如果解析内容非空或现有内容为空，则更新消息
                  if (parsedContentTrimmed || !existingContentTrimmed) {
                    updateMessage(sid, lastAssistant.id, {
                      content: parsedContent,
                    })
                    finalOutputTrimmed = parsedContentTrimmed
                    if (parsedContentTrimmed) {
                      runProducedAssistantText = true
                      runProducedAssistantContent = true
                    }
                  } else {
                    finalOutputTrimmed = existingContentTrimmed
                    runProducedAssistantText = true
                  }
                  // 更新推理内容
                  if ((evt as any).parsed_reasoning) {
                    updateMessage(sid, lastAssistant.id, {
                      reasoning: (evt as any).parsed_reasoning,
                    })
                  }
                } else if (parsedContentTrimmed) {
                  // 创建新的助手消息
                  addMessage(sid, {
                    id: uid(),
                    role: 'assistant',
                    content: parsedContent,
                    reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                    timestamp: Date.now(),
                  })
                  finalOutputTrimmed = parsedContentTrimmed
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              } else {
                // 回退到 output 字段（遗留行为）
                const finalOutput = typeof evt.output === 'string' ? evt.output : ''
                finalOutputTrimmed = finalOutput.trim()
                if (!runProducedAssistantText && finalOutputTrimmed !== '') {
                  addMessage(sid, {
                    id: uid(),
                    role: 'assistant',
                    content: finalOutput,
                    timestamp: Date.now(),
                  })
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              }
              
              // 解决上游 hermes-agent bug：当代理层静默吞没错误（如无效 API 密钥、不支持的模型）时，
              // 网关仍会发出 run.completed 但输出为空。如果不在此显示错误，聊天 UI 看起来会像冻结/
              // "成功但无回复"。通过以下组合检测：无助手文本 AND 无工具活动 AND 空最终输出。
              const swallowedError =
                !runProducedAssistantText &&
                !runHadToolActivity &&
                finalOutputTrimmed === ''
              if (swallowedError) {
                // 添加错误消息
                addMessage(sid, {
                  id: uid(),
                  role: 'system',
                  content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
                  timestamp: Date.now(),
                })
              } else {
                // 播放完成提示音并显示通知
                playCompletionBellIfEnabled()
                showCompletionNotificationIfEnabled(sid, completedAssistantMessageId)
              }

              // 自动播放语音（如果启用）
              if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
                const msgs = getSessionMsgs(sid)
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
                if (lastAssistant?.content) {
                  // 延迟一小会儿再播放，确保 UI 更新完成
                  setTimeout(() => {
                    playMessageSpeech(lastAssistant.id, lastAssistant.content)
                  }, 300)
                }
              }

              // 如果还有队列消息，更新队列长度；否则清理状态
              if ((evt as any).queue_remaining > 0) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              updateSessionTitle(sid)
              break
            }

            case 'run.failed': {
              // 运行失败：清理状态并添加错误消息
              clearAgentEventMessages(sid)
              // 更新 token 使用量
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                  if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
                }
              }
              // 添加错误消息
              addAgentErrorMessage(sid, evt.error)
              // 将所有运行中的工具状态改为错误
              settleRunningTools(sid, 'error')
              // 如果还有队列消息，更新队列长度；否则清理状态
              if ((evt as any).queue_remaining > 0) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              break
            }

            case 'usage.updated': {
              // 使用量更新：更新 token 计数
              const target = sessions.value.find(s => s.id === sid)
              if (target) {
                target.inputTokens = (evt as any).inputTokens
                target.outputTokens = (evt as any).outputTokens
                if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
              }
              break
            }
          }
        },
        // onDone 回调：流正常结束
        () => {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          updateSessionTitle(sid)
        },
        // onError 回调：流发生错误
        (err) => {
          console.warn('Socket.IO run stream error:', err.message)
          addAgentErrorMessage(sid, err.message)
          const msgs = getSessionMsgs(sid)
          // 将所有运行中的工具状态改为错误
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'error' }
            }
          })
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
        },
        undefined,
        { onReconnectResume: applyReconnectResume },
      )
      runSubmitted = true

      // 根据会话类型和命令类型注册流控制器
      if (isCodingAgentSession) {
        serverWorking.value.add(sid)
        streamStates.value.set(sid, ctrl)
      } else if (!isBridgeSlashCommand || isBridgeCompressCommand || isBridgePlanCommand || isBridgeGoalCommand) {
        streamStates.value.set(sid, ctrl)
      }
    } catch (err: any) {
      // 发送失败处理
      if (shouldQueue && !runSubmitted) {
        // 如果消息在队列中，移除队列消息
        dropQueuedUserMessage(sid, userMsg.id)
      }
      if (!shouldQueue && !runSubmitted) {
        // 如果消息已发送，移除工作状态
        serverWorking.value.delete(sid)
      }
      // 添加错误消息
      addMessage(sid, {
        id: uid(),
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * 页面刷新后恢复正在进行的运行
   * 
   * 通过 Socket.IO 发送 'resume' 事件加入服务器的会话房间，
   * 然后设置事件监听器接收持续的事件。
   * 
   * @param sid 会话 ID
   * @param force 是否强制恢复（即使服务器没有报告活跃运行）
   */
  function resumeServerWorkingRun(sid: string, force = false) {
    // 如果已经在流式传输，不注册重复监听器
    if (streamStates.value.has(sid)) return
    // 只有当服务器在恢复期间报告了活跃运行时才设置监听器
    if (!force && !serverWorking.value.has(sid)) return

    let closed = false
    let runProducedAssistantText = false
    let runProducedAssistantContent = false
    let runHadToolActivity = false
    let activeAssistantMessageId: string | null = null
    let reasoningAssistantMessageId: string | null = null
    let activeRunMarker: string | null = null

    const cleanup = () => {
      if (closed) return
      closed = true
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      // 从全局会话处理器注销
      unregisterSessionHandlers(sid)
    }

    const closeStreamingAssistant = () => {
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.role === 'assistant' && m.isStreaming) {
          updateMessage(sid, m.id, { isStreaming: false })
        }
      })
      activeAssistantMessageId = null
      reasoningAssistantMessageId = null
      activeRunMarker = null
    }

    /**
     * 初始化恢复的助手状态
     */
    const initializeResumedAssistantState = () => {
      const resumedAssistantState = resolveResumedAssistantState(getSessionMsgs(sid), { activeRunMarker })
      activeRunMarker = resumedAssistantState.runMarker
      if (resumedAssistantState.activeAssistant) {
        resumedAssistantState.activeAssistant.isStreaming = true
        activeAssistantMessageId = resumedAssistantState.activeAssistant.id
        if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
      }
      if (resumedAssistantState.reasoningAssistant) {
        reasoningAssistantMessageId = resumedAssistantState.reasoningAssistant.id
        if (resumedAssistantState.reasoningAssistant.reasoning) {
          noteReasoningStart(resumedAssistantState.reasoningAssistant.id)
        }
      }
    }

    initializeResumedAssistantState()

    // 共享事件处理器 —— 按 session_id 标签过滤
    function handleEvent(evt: RunEvent) {
      if (closed) return
      // 过滤此会话的事件（服务器用 session_id 标记所有事件）
      if (evt.session_id && evt.session_id !== sid) return
      const eventRunMarker = readRunMarker(evt)
      if (eventRunMarker) activeRunMarker = eventRunMarker
      switch (evt.event) {
        case 'run.queued': {
          handleRunQueuedEvent(sid, evt)
          break
        }

        case 'session.command': {
          handleSessionCommandEvent(evt)
          break
        }

        case 'agent.event': {
          handleAgentEvent(evt)
          break
        }

        case 'run.reattach_failed': {
          handleAgentEvent(evt)
          break
        }

        case 'run.started': {
          // 运行开始：重置状态
          serverWorking.value.add(sid)
          clearAgentEventMessages(sid)
          setAbortState(null)
          setCompressionState(sid, null)
          runProducedAssistantText = false
          runProducedAssistantContent = false
          runHadToolActivity = false
          closeStreamingAssistant()
          activeRunMarker = readRunMarker(evt) ?? null
          // 更新队列长度
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
          } else {
            queueLengths.value.delete(sid)
          }
          break
        }

        case 'compression.started': {
          setCompressionState(sid, {
            compressing: true,
            messageCount: (evt as any).message_count || 0,
            beforeTokens: (evt as any).token_count || 0,
            afterTokens: 0,
            compressed: null,
          })
          break
        }

        case 'compression.completed': {
          const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
          setCompressionState(sid, {
            compressing: false,
            messageCount: (evt as any).totalMessages || 0,
            beforeTokens: (evt as any).beforeTokens || 0,
            afterTokens,
            compressed: (evt as any).compressed ?? false,
            error: (evt as any).error,
          })
          if ((evt as any).contextTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) target.contextTokens = (evt as any).contextTokens
          }
          setTimeout(() => {
            const state = compressionStates.value.get(sid)
            if (state && !state.compressing) {
              setCompressionState(sid, null)
            }
          }, 5000)
          break
        }

        case 'abort.started': {
          setAbortState({ aborting: true, synced: null })
          break
        }

        case 'abort.timeout': {
          setAbortState({ aborting: true, synced: false, timedOut: true, message: (evt as any).message })
          break
        }

        case 'abort.completed': {
          setAbortState({ aborting: false, synced: (evt as any).synced ?? false })
          clearPendingInteractions(sid)
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
            setAbortState(null)
            break
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'done' }
            }
          })
          cleanup()
          setAbortState(null)
          break
        }

        case 'reasoning.delta':
        case 'thinking.delta': {
          const text = evt.text || evt.delta || ''
          if (!text) break
          runProducedAssistantText = true
          const msgs = getSessionMsgs(sid)
          const reasoningTargetId = reasoningAssistantMessageId || activeAssistantMessageId
          const last = reasoningTargetId
            ? msgs.find(m => m.id === reasoningTargetId)
            : null
          if (last?.role === 'assistant') {
            last.reasoning = (last.reasoning || '') + text
            reasoningAssistantMessageId = last.id
            noteReasoningStart(last.id)
          } else {
            const newId = uid()
            addMessage(sid, {
              id: newId,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
              reasoning: text,
            })
            activeAssistantMessageId = newId
            reasoningAssistantMessageId = newId
            noteReasoningStart(newId)
          }

          break
        }

        case 'reasoning.available': {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && last.isStreaming) {
            noteReasoningEnd(last.id)
          }

          break
        }

        case 'message.delta': {
          if (evt.delta) {
            runProducedAssistantText = true
            runProducedAssistantContent = true
          }
          const msgs = getSessionMsgs(sid)
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : null
          if (last?.role === 'assistant' && last.isStreaming) {
            const prev = last.content
            const next = prev + (evt.delta || '')
            noteThinkingDelta(last.id, prev, next)
            if (last.reasoning) noteReasoningEnd(last.id)
            last.content = next
          } else {
            const newId = uid()
            const nextContent = evt.delta || ''
            noteThinkingDelta(newId, '', nextContent)
            addMessage(sid, {
              id: newId,
              role: 'assistant',
              content: nextContent,
              timestamp: Date.now(),
              isStreaming: true,
            })
            activeAssistantMessageId = newId
          }

          break
        }

        case 'session.title.updated': {
          applyGeneratedSessionTitle(evt)
          break
        }

        case 'tool.started': {
          runHadToolActivity = true
          const msgs = getSessionMsgs(sid)
          const toolCallId = (evt as any).tool_call_id as string | undefined
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          activeAssistantMessageId = null
          const existingTool = toolCallId
            ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
            : null
          if (existingTool) {
            updateMessage(sid, existingTool.id, {
              toolName: evt.tool || evt.name,
              toolArgs: hasRuntimeToolPayload((evt as any).arguments) ? (evt as any).arguments : existingTool.toolArgs,
              toolPreview: evt.preview || existingTool.toolPreview,
              toolStatus: existingTool.toolStatus || 'running',
            })
            break
          }
          addMessage(sid, {
            id: uid(),
            role: 'tool',
            content: '',
            timestamp: Date.now(),
            toolName: evt.tool || evt.name,
            toolCallId,
            toolPreview: evt.preview,
            toolArgs: runtimeToolPayloadOrUndefined((evt as any).arguments),
            toolStatus: 'running',
          })

          break
        }

        case 'tool.completed': {
          runHadToolActivity = true
          const msgs = getSessionMsgs(sid)
          const toolCallId = (evt as any).tool_call_id as string | undefined
          const toolMsgs = toolCallId
            ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
            : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
          if (toolMsgs.length > 0) {
            const output = runtimeToolPayloadOrUndefined((evt as any).output)
            const hasError = (evt as any).error === true || runtimeToolOutputHasError(output)
            updateMessage(sid, toolMsgs[toolMsgs.length - 1].id, {
              toolStatus: hasError ? 'error' : 'done',
              toolDuration: (evt as any).duration,
              toolResult: output,
            })
          }

          break
        }

        case 'subagent.start':
        case 'subagent.tool':
        case 'subagent.progress':
        case 'subagent.complete': {
          runHadToolActivity = true
          handleSubagentEvent(sid, evt)
          break
        }

        case 'approval.requested': {
          setPendingApproval(evt)
          break
        }

        case 'approval.resolved': {
          clearPendingApproval(evt)
          break
        }

        case 'clarify.requested': {
          setPendingClarify(evt)
          break
        }

        case 'clarify.resolved': {
          clearPendingClarify(evt)
          break
        }

        case 'run.completed': {
          clearAgentEventMessages(sid)
          const hasQueue = (evt as any).queue_remaining > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
            ? lastMsg.id
            : null
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          settleRunningTools(sid, 'done')
          // Server-computed usage (local countTokens, snapshot-aware)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
              if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
            }
          }
          // Check if backend provided parsed content (from stringified array format)
          let finalOutputTrimmed = ''
          if ((evt as any).parsed_content !== undefined) {
            // Backend has parsed stringified array format, update last assistant message
            const msgs = getSessionMsgs(sid)
            const lastAssistant = activeAssistantMessageId
              ? msgs.find(m => m.id === activeAssistantMessageId)
              : completedAssistantMessageId
                ? msgs.find(m => m.id === completedAssistantMessageId)
                : undefined
            const parsedContent = typeof (evt as any).parsed_content === 'string'
              ? (evt as any).parsed_content
              : ''
            const parsedContentTrimmed = parsedContent.trim()
            if (lastAssistant) {
              const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
              if (parsedContentTrimmed || !existingContentTrimmed) {
                updateMessage(sid, lastAssistant.id, {
                  content: parsedContent,
                })
                finalOutputTrimmed = parsedContentTrimmed
                if (parsedContentTrimmed) {
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              } else {
                finalOutputTrimmed = existingContentTrimmed
                runProducedAssistantText = true
              }
              if ((evt as any).parsed_reasoning) {
                updateMessage(sid, lastAssistant.id, {
                  reasoning: (evt as any).parsed_reasoning,
                })
              }
            } else if (parsedContentTrimmed) {
              addMessage(sid, {
                id: uid(),
                role: 'assistant',
                content: parsedContent,
                reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                timestamp: Date.now(),
              })
              finalOutputTrimmed = parsedContentTrimmed
              runProducedAssistantText = true
              runProducedAssistantContent = true
            }
          } else {
            // Fallback to output field (legacy behavior)
            const finalOutput = typeof evt.output === 'string' ? evt.output : ''
            finalOutputTrimmed = finalOutput.trim()
            if (!runProducedAssistantText && finalOutputTrimmed !== '') {
              addMessage(sid, {
                id: uid(),
                role: 'assistant',
                content: finalOutput,
                timestamp: Date.now(),
              })
              runProducedAssistantText = true
              runProducedAssistantContent = true
            }
          }
          const swallowedError = !runProducedAssistantText && !runHadToolActivity && finalOutputTrimmed === ''
          if (swallowedError) {
            addMessage(sid, {
              id: uid(),
              role: 'system',
              content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
              timestamp: Date.now(),
            })
          } else {
            playCompletionBellIfEnabled()
            showCompletionNotificationIfEnabled(sid, completedAssistantMessageId)
          }

          // Auto-play speech for every completed assistant message
          if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
            const msgs = getSessionMsgs(sid)
            const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
            if (lastAssistant?.content) {
              setTimeout(() => {
                playMessageSpeech(lastAssistant.id, lastAssistant.content)
              }, 300)
            }
          }

          if (!hasQueue) {
            cleanup()
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          } else {
            // More runs pending — reset for next run but don't cleanup
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          }
          updateSessionTitle(sid)
          break
        }

        case 'run.failed': {
          clearAgentEventMessages(sid)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
              if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
            }
          }
          const hasQueue = (evt as any).queue_remaining > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          addAgentErrorMessage(sid, evt.error)
          settleRunningTools(sid, 'error')
          if (!hasQueue) {
            cleanup()
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          break
        }

        case 'usage.updated': {
          const target = sessions.value.find(s => s.id === sid)
          if (target) {
            target.inputTokens = (evt as any).inputTokens
            target.outputTokens = (evt as any).outputTokens
            if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
          }
          break
        }
      }
    }

    // 在全局会话映射中注册处理器
    registerSessionHandlers(sid, {
      onMessageDelta: (evt) => handleEvent(evt),
      onReasoningDelta: (evt) => handleEvent(evt),
      onThinkingDelta: (evt) => handleEvent(evt),
      onReasoningAvailable: (evt) => handleEvent(evt),
      onToolStarted: (evt) => handleEvent(evt),
      onToolCompleted: (evt) => handleEvent(evt),
      onSubagentEvent: (evt) => handleEvent(evt),
      onRunStarted: (evt) => handleEvent(evt),
      onRunCompleted: (evt) => handleEvent(evt),
      onRunFailed: (evt) => handleEvent(evt),
      onCompressionStarted: (evt) => handleEvent(evt),
      onCompressionCompleted: (evt) => handleEvent(evt),
      onAbortStarted: (evt) => handleEvent(evt),
      onAbortTimeout: (evt) => handleEvent(evt),
      onAbortCompleted: (evt) => handleEvent(evt),
      onUsageUpdated: (evt) => handleEvent(evt),
      onAgentEvent: (evt) => handleEvent(evt),
      onSessionCommand: (evt) => handleEvent(evt),
      onRunQueued: (evt) => handleEvent(evt),
      onClarifyRequested: (evt) => handleEvent(evt),
      onClarifyResolved: (evt) => handleEvent(evt),
    })

    // 无需在此发送 resume —— switchSession 已经发送过了。
    // 服务器已经加入房间并重放了事件。
    // 只需为持续的流式事件设置处理器。

    // 标记为流式传输，以便 UI 显示指示器，并且刷新后仍可以中断。
    streamStates.value.set(sid, {
      abort: () => {
        getChatRunSocket()?.emit('abort', { session_id: sid })
      },
    })
  }

  /**
   * 处理对等用户消息（从其他设备/CLI/Telegram 发送的消息）
   * 
   * 当服务器广播来自其他客户端的用户消息时，将其添加到本地会话中。
   * 
   * @param evt 运行事件
   */
  function handlePeerUserMessage(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    if (!content.trim()) return

    const messageId = peer?.id != null ? String(peer.id) : ''
    const msgs = getSessionMsgs(sid)
    
    // 如果消息已存在，恢复运行
    if (messageId && msgs.some(msg => msg.id === messageId)) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
      return
    }
    
    // 如果消息在队列中，恢复运行
    if (messageId && (queuedUserMessages.value.get(sid) || []).some(msg => msg.id === messageId)) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
      return
    }

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()

    const message: Message = {
      id: messageId || uid(),
      role: peer?.role === 'command' ? 'command' : 'user',
      content,
      timestamp,
      queued: !!peer?.queued,
      systemType: peer?.role === 'command' ? 'command' : undefined,
    }
    
    // 检查是否已标记为出队
    const wasDequeued = messageId ? consumeDequeuedQueueId(sid, messageId) : false
    
    // 如果消息在队列中或会话正在运行，添加到队列；否则直接添加到消息列表
    if (peer?.queued || (!wasDequeued && isSessionLive(sid))) {
      enqueueUserMessage(sid, message)
    } else {
      addMessage(sid, message)
      updateSessionTitle(sid)
    }
    
    // 恢复运行监听
    serverWorking.value.add(sid)
    resumeServerWorkingRun(sid, true)
  }

  // 注册对等用户消息处理器
  onPeerUserMessage(handlePeerUserMessage)

  /**
   * 处理全局会话命令
   * 
   * @param evt 运行事件
   */
  function handleGlobalSessionCommand(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return
    const shouldAttachToStartedRun = (evt as any).started === true && (evt as any).terminal === false
    handleSessionCommandEvent(evt)
    // 如果是已启动的运行，恢复监听
    if (shouldAttachToStartedRun) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
    }
  }

  // 注册全局会话命令处理器
  onSessionCommand(handleGlobalSessionCommand)

  // 注册会话标题更新处理器
  onSessionTitleUpdated(applyGeneratedSessionTitle)

  /**
   * 停止流式传输（中断当前运行）
   */
  function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    if (isAborting.value) return
    
    // 清除待处理交互
    clearPendingInteractions(sid)
    
    // 通过流控制器中断
    const ctrl = streamStates.value.get(sid)
    if (ctrl) {
      setAbortState({ aborting: true, synced: null })
      ctrl.abort()
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
      return
    }
    
    // 如果没有流控制器但服务器正在工作，直接发送中断事件
    if (serverWorking.value.has(sid)) {
      setAbortState({ aborting: true, synced: null })
      getChatRunSocket()?.emit('abort', { session_id: sid })
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
    }
  }

  // 标签页可见性：返回前台时重新同步
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      // 刷新会话列表（CLI、Telegram、其他设备创建的会话）
      if (document.visibilityState === 'visible' && !isStreaming.value) {
        void refreshSessionListOnly()
      }
      
      // 重新加载当前会话的消息
      if (document.visibilityState === 'visible' && activeSessionId.value && !isStreaming.value) {
        const sid = activeSessionId.value
        if (sid && !streamStates.value.has(sid)) {
          // 通过 resume 重新加载消息（服务器从 DB 加载）
          resumeSession(sid, (data) => {
            if (data.isWorking) {
              serverWorking.value.add(sid)
            } else {
              serverWorking.value.delete(sid)
            }
            if (data.isAborting) {
              setAbortState({ aborting: true, synced: null })
            } else if (!data.isWorking) {
              setAbortState(null)
            }
            if (!data.isWorking) setCompressionState(sid, null)
            if (data.messages?.length && activeSession.value) {
              activeSession.value.messages = mapHermesMessages(data.messages as any[])
              activeSession.value.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
              activeSession.value.messageTotal = data.messageTotal ?? activeSession.value.messageCount ?? activeSession.value.loadedMessageCount
              activeSession.value.messageCount = activeSession.value.messageTotal
              activeSession.value.hasMoreBefore = data.hasMoreBefore ?? activeSession.value.loadedMessageCount < activeSession.value.messageTotal
            }
            resumeServerWorkingRun(sid)
          }, activeSession.value?.profile)
        }
      }
    })
  }

  // 轻度后台轮询用于会话列表实时同步（覆盖通过 CLI/Telegram 在 VM 上创建的会话）。
  // 仅在标签可见且非流式传输时运行，因此开销低且不会中断活跃运行。
  // visibilitychange 处理从隐藏唤醒的情况；此处理"保持打开并观察"的情况。
  if (typeof window !== 'undefined') {
    window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (isStreaming.value) return
      void refreshSessionListOnly()
    }, 12_000)
  }

  // 活跃流式传输期间 <think> 边界的临时观察。
  // 不持久化；会话切换时清除。参见规范 §5.3。
  const thinkingObservation = new Map<string, { startedAt?: number; endedAt?: number }>()

  /**
   * 获取消息的思考观察数据
   * 
   * @param messageId 消息 ID
   * @returns 思考观察数据
   */
  function getThinkingObservation(messageId: string) {
    return thinkingObservation.get(messageId)
  }

  /**
   * 记录思考边界变化
   * 
   * 在流式传输期间检测 <think> 标签的开始和结束边界，用于计算思考时长。
   * 
   * @param messageId 消息 ID
   * @param prevContent 变更前的内容
   * @param nextContent 变更后的内容
   */
  function noteThinkingDelta(messageId: string, prevContent: string, nextContent: string) {
    const { startedAtBoundary, endedAtBoundary } = detectThinkingBoundary(prevContent, nextContent)
    if (!startedAtBoundary && !endedAtBoundary) return
    const existing = thinkingObservation.get(messageId) || {}
    if (startedAtBoundary && existing.startedAt === undefined) {
      existing.startedAt = Date.now()
    }
    if (endedAtBoundary && existing.endedAt === undefined) {
      existing.endedAt = Date.now()
    }
    thinkingObservation.set(messageId, existing)
  }

  /**
   * 第一次见到某条消息的 reasoning 文本时，标记 startedAt
   * 
   * @param messageId 消息 ID
   */
  function noteReasoningStart(messageId: string) {
    const existing = thinkingObservation.get(messageId) || {}
    if (existing.startedAt === undefined) {
      existing.startedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  /**
   * 内容首次到达（视为推理结束）或显式收到 reasoning.available 时，标记 endedAt
   * 
   * @param messageId 消息 ID
   */
  function noteReasoningEnd(messageId: string) {
    const existing = thinkingObservation.get(messageId)
    if (!existing || existing.startedAt === undefined) return
    if (existing.endedAt === undefined) {
      existing.endedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  /**
   * 从所有会话中清除指定的 provider
   * 
   * 当 provider 被删除或禁用时，清空相关会话的 provider 和 model 信息。
   * 
   * @param provider provider 名称
   */
  function clearProviderFromSessions(provider: string) {
    if (!provider) return
    const target = provider.toLowerCase()
    for (const s of sessions.value) {
      if ((s.provider || '').toLowerCase() === target) {
        s.model = undefined
        s.provider = ''
      }
    }
  }

  // 持久化到 localStorage，以 sessionId 为键，使选择在页面刷新后保持。
  // 会话删除时清除未实现（尽力而为 —— 孤立键很小且不会再次读取）。
  const REASONING_LS_PREFIX = 'hermes:reasoning_effort:'
  
  /**
   * 设置会话的推理努力级别
   * 
   * 推理努力级别决定了 AI 的思考深度，持久化到 localStorage 以跨页面刷新保持。
   * 
   * @param sessionId 会话 ID
   * @param effort 推理努力级别
   */
  function setSessionReasoningEffort(sessionId: string, effort: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.reasoningEffort = effort || undefined
    try {
      if (effort) {
        localStorage.setItem(REASONING_LS_PREFIX + sessionId, effort)
      } else {
        localStorage.removeItem(REASONING_LS_PREFIX + sessionId)
      }
    } catch {
      // localStorage 可能不可用（隐私模式）；静默忽略
    }
  }
  
  /**
   * 获取存储的推理努力级别
   * 
   * @param sessionId 会话 ID
   * @returns 推理努力级别，如果未存储则返回 undefined
   */
  function getStoredReasoningEffort(sessionId: string): string | undefined {
    try {
      return localStorage.getItem(REASONING_LS_PREFIX + sessionId) || undefined
    } catch {
      return undefined
    }
  }
  
  // 当会话从服务器新获取时，将 reasoningEffort 恢复到会话上
  // （mapHermesSession 不携带此字段 —— 这是客户端独有的状态）。
  watch(sessions, (list) => {
    for (const s of list) {
      if (s.reasoningEffort === undefined) {
        const stored = getStoredReasoningEffort(s.id)
        if (stored) s.reasoningEffort = stored
      }
    }
  }, { deep: false })

  /**
   * 清除指定会话的思考观察数据
   * 
   * messageId 与 sessionId 的关联未单独持有；方案是切换会话时一律清空。
   * 这符合 spec 定义：observation 是"当前会话范围内"的 transient 状态。
   * 
   * @param _sessionId 会话 ID（未使用）
   */
  function clearThinkingObservationFor(_sessionId: string) {
    thinkingObservation.clear()
  }

  /**
   * 播放消息语音
   * 
   * 通过触发自定义事件让 MessageItem 组件处理播放逻辑。
   * 
   * @param messageId 消息 ID
   * @param content 消息内容
   */
  function playMessageSpeech(messageId: string, content: string) {
    const event = new CustomEvent('auto-play-speech', {
      detail: { messageId, content }
    })
    window.dispatchEvent(event)
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    focusMessageId,
    messages,
    isStreaming,
    isRunActive,
    isSessionLive,
    sessionProfileFilter,
    compressionState,
    abortState,
    isAborting,
    queueLengths,
    queuedUserMessages,
    pendingApprovals,
    activePendingApproval,
    activePendingClarify,
    removeQueuedMessage,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,

    newChat,
    newCliSession,
    switchSession,
    loadOlderMessages,
    switchSessionModel,
    addOrUpdateSession,
    clearProviderFromSessions,
    deleteSession,
    sendMessage,
    stopStreaming,
    respondApproval,
    respondToClarify,
    loadSessions,
    refreshSessionListOnly,
    refreshActiveSession,
    getThinkingObservation,
    noteThinkingDelta,
    noteReasoningStart,
    noteReasoningEnd,
    clearThinkingObservationFor,
    setAutoPlaySpeech,
    playMessageSpeech,
    setSessionReasoningEffort,
  }
})
