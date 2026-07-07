<script setup lang="ts">
import type { Attachment } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchContextLength } from '@/api/hermes/sessions'
import { setModelContext } from '@/api/hermes/model-context'
import { NButton, NTooltip, NSwitch, NModal, NInputNumber, NPopselect, useMessage } from 'naive-ui'
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import VoiceDialogueControls from './VoiceDialogueControls.vue'
import { useMicRecorder } from '@/composables/useMicRecorder'
import { useGlobalSpeech } from '@/composables/useSpeech'
import { useVoiceDialogue } from '@/composables/useVoiceDialogue'
import { transcribeSpeech } from '@/api/hermes/stt'
import type { StoredSttProvider } from '@/api/hermes/stt-settings'
import { useSttSettings } from '@/composables/useSttSettings'
import { useBrowserSpeechRecognition } from '@/composables/useBrowserSpeechRecognition'

const chatStore = useChatStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()

// === 工具函数实例 ===
const { t } = useI18n()
const message = useMessage()
const { toolTraceVisible, toggleToolTraceVisible } = useToolTraceVisibility()

// === 推理努力级别配置 ===
// 推理努力选项列表，用于 NPopselect 下拉选择
const reasoningEffortOptions = computed(() => [
  { label: t('chat.reasoningEffort.options.default'), value: '' },
  { label: t('chat.reasoningEffort.options.none'), value: 'none' },
  { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
])

// 当前会话的推理努力级别
const currentReasoningEffort = computed<string>(() =>
  chatStore.activeSession?.reasoningEffort || ''
)

// 推理努力级别的显示标签
const reasoningEffortLabel = computed<string>(() => {
  const v = currentReasoningEffort.value
  if (!v) return t('chat.reasoningEffort.defaultLabel')
  const opt = reasoningEffortOptions.value.find(o => o.value === v)
  return opt?.label || v
})

// 推理努力级别变更处理函数
function onReasoningEffortChange(value: string | null | undefined) {
  const sid = chatStore.activeSessionId
  if (!sid) return
  chatStore.setSessionReasoningEffort(sid, value || '')
}

// === 草稿存储常量 ===
const DRAFT_STORAGE_KEY = 'hermes_chat_input_drafts_v1'
type DraftMap = Record<string, string>

// === 响应式状态 ===
// 输入框文本内容
const inputText = ref('')
// 文本域 DOM 引用
const textareaRef = ref<HTMLTextAreaElement>()
// Slash 命令下拉菜单 DOM 引用
const commandDropdownRef = ref<HTMLDivElement>()
// 文件上传输入 DOM 引用
const fileInputRef = ref<HTMLInputElement>()
// 附件列表
const attachments = ref<Attachment[]>([])
// 是否正在拖拽文件
const isDragging = ref(false)
// 拖拽计数器（用于处理嵌套拖拽事件）
const dragCounter = ref(0)
// 是否正在使用输入法（IME）输入
const isComposing = ref(false)

// === 语音相关实例 ===
// 全局语音播放实例
const speech = useGlobalSpeech()
// 麦克风录音器实例
const micRecorder = useMicRecorder({
  messages: {
    unsupported: t('chat.voiceInput.microphoneUnsupported'),
    recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
  },
})
// 语音转文字设置实例
const sttSettings = useSttSettings()
// 浏览器语音识别实例
const browserRecognition = useBrowserSpeechRecognition({
  messages: {
    unsupported: t('chat.voiceInput.browserSpeechUnsupported'),
    failed: t('chat.voiceInput.browserSpeechFailed'),
    failedWithReason: (reason) => t('chat.voiceInput.browserSpeechFailedWithReason', { error: reason }),
  },
})
// 当前激活的语音捕捉模式（浏览器原生 / 后端 API / 无）
const activeVoiceCaptureMode = ref<'browser' | 'backend' | null>(null)

// === 语音输入相关函数 ===

/**
 * 标准化语音转录文本
 * 替换多个连续空白符为单个空格，并去除首尾空白
 */
function normalizeVoiceTranscript(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 获取后端语音转录选项
 * 根据当前设置返回对应的 STT 提供商、语言和提示词配置
 */
function backendTranscribeOptions(): {
  provider: StoredSttProvider
  language?: string
  prompt?: string
} {
  if (sttSettings.provider.value === 'custom') {
    return {
      provider: 'custom',
      language: sttSettings.customLanguage.value.trim() || undefined,
      prompt: sttSettings.customPrompt.value.trim() || undefined,
    }
  }

  return {
    provider: 'openai',
    language: sttSettings.openaiLanguage.value.trim() || undefined,
    prompt: sttSettings.openaiPrompt.value.trim() || undefined,
  }
}

/**
 * 获取浏览器语音识别的语言设置
 * 优先使用 OpenAI 语言设置，其次使用自定义语言设置
 */
function browserCaptureLanguage() {
  return sttSettings.openaiLanguage.value.trim() || sttSettings.customLanguage.value.trim() || ''
}

/**
 * 将语音转录文本插入到输入框中
 * 在当前光标位置插入文本，自动处理空格
 */
function insertVoiceTranscriptIntoInput(text: string) {
  const normalizedTranscript = normalizeVoiceTranscript(text)
  if (!normalizedTranscript) return

  const el = textareaRef.value
  const currentValue = inputText.value
  const selectionStart = el?.selectionStart ?? currentValue.length
  const selectionEnd = el?.selectionEnd ?? selectionStart
  const before = currentValue.slice(0, selectionStart)
  const after = currentValue.slice(selectionEnd)
  // 在插入文本前后添加空格，确保与周围文本正确分隔
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  const nextValue = `${before}${prefix}${normalizedTranscript}${suffix}${after}`
  const nextCursorPosition = before.length + prefix.length + normalizedTranscript.length

  inputText.value = nextValue
  slashActive.value = false

  nextTick(() => {
    const textarea = textareaRef.value
    if (!textarea) return

    textarea.focus()
    textarea.setSelectionRange(nextCursorPosition, nextCursorPosition)

    // 如果文本域高度为自动模式，重新计算高度
    if (textareaHeight.value === null) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`
    }
  })
}

// 语音对话管理器实例
const voiceDialogue = useVoiceDialogue({
  // 后端转录回调：调用 API 将音频转为文字
  transcribe: async (audio) => {
    const { provider, language, prompt } = backendTranscribeOptions()
    return transcribeSpeech({ audio, provider, language, prompt })
  },
  // 发送消息回调：将转录文本插入输入框
  sendMessage: async (text) => {
    insertVoiceTranscriptIntoInput(text)
  },
  // 停止输出音频回调：停止语音播放
  stopOutputAudio: () => speech.stop(true),
})

// 语音对话转录文本（合并浏览器实时转录和部分转录）
const voiceDialogueTranscript = computed(() => {
  // 如果不是浏览器模式或未在录制，直接返回语音对话管理器的转录
  if (activeVoiceCaptureMode.value !== 'browser' || voiceDialogue.status.value !== 'capturing') {
    return voiceDialogue.transcript.value
  }

  // 浏览器模式下，合并已确认和临时的转录文本
  return normalizeVoiceTranscript([
    browserRecognition.transcript.value,
    browserRecognition.partialTranscript.value,
  ].filter(Boolean).join(' '))
})

// 是否应该显示浏览器语音识别错误（当前使用浏览器提供商或正在浏览器模式录制）
const shouldShowBrowserRecognitionError = computed(() =>
  sttSettings.provider.value === 'browser' || activeVoiceCaptureMode.value === 'browser',
)

// 语音对话错误信息（优先级：语音对话错误 > 浏览器识别错误 > 麦克风错误）
const voiceDialogueError = computed(() =>
  voiceDialogue.error.value?.message
  ?? (shouldShowBrowserRecognitionError.value ? browserRecognition.error.value?.message : null)
  ?? micRecorder.state.value.error?.message
  ?? null,
)

// === Slash 命令系统 ===

/**
 * Bridge 会话可用的 Slash 命令列表
 * 每个命令包含名称、参数提示、插入文本和描述
 */
const bridgeCommands = computed(() => [
  { name: 'usage', args: '', description: t('chat.slashCommands.usage') },
  { name: 'status', args: '', description: t('chat.slashCommands.status') },
  { name: 'abort', args: '', description: t('chat.slashCommands.abort') },
  { name: 'queue', args: t('chat.slashCommandArgs.message'), description: t('chat.slashCommands.queue') },
  { name: 'plan', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.plan') },
  { name: 'goal', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.goal') },
  { name: 'goal', args: 'status', insertText: 'goal status', description: t('chat.slashCommands.goalStatus') },
  { name: 'goal', args: 'pause', insertText: 'goal pause', description: t('chat.slashCommands.goalPause') },
  { name: 'goal', args: 'resume', insertText: 'goal resume', description: t('chat.slashCommands.goalResume') },
  { name: 'goal', args: 'done', insertText: 'goal done', description: t('chat.slashCommands.goalDone') },
  { name: 'goal', args: 'clear', insertText: 'goal clear', description: t('chat.slashCommands.goalClear') },
  { name: 'subgoal', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.subgoal') },
  { name: 'clear', args: '', description: t('chat.slashCommands.clear') },
  { name: 'clear', args: '--history', insertText: 'clear --history', description: t('chat.slashCommands.clearHistory') },
  { name: 'title', args: t('chat.slashCommandArgs.title'), description: t('chat.slashCommands.title') },
  { name: 'compress', args: '', description: t('chat.slashCommands.compress') },
  { name: 'steer', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.steer') },
  { name: 'destroy', args: '', description: t('chat.slashCommands.destroy') },
  { name: 'reload-mcp', args: '', description: t('chat.slashCommands.reloadMcp') },
])

// Slash 命令下拉菜单是否激活
const slashActive = ref(false)
// 当前 Slash 命令搜索词（去掉开头的 /）
const slashQuery = ref('')
// 当前选中的命令索引
const slashActiveIndex = ref(0)
// 是否为 Bridge（CLI）会话
const isBridgeSession = computed(() => chatStore.activeSession?.source === 'cli')

// 根据搜索词过滤后的命令列表
const filteredBridgeCommands = computed(() => {
  const query = slashQuery.value.toLowerCase()
  return bridgeCommands.value.filter(command =>
    command.name.includes(query) || command.insertText?.includes(query),
  )
})

// === 文本域高度拖拽调整 ===

// 文本域高度（null 表示自动调整，数值表示用户手动设置的高度）
const textareaHeight = ref<number | null>(null)

/**
 * 开始拖拽调整文本域高度
 * 监听鼠标移动事件，计算新高度并限制在 20-400px 范围内
 */
function startResize(e: MouseEvent) {
  e.preventDefault()
  const el = textareaRef.value
  if (!el) return

  // 如果当前是自动模式，用实际 clientHeight 作为起始值
  const startHeight = el.clientHeight
  const startY = e.clientY

  /**
   * 鼠标移动时更新文本域高度
   * 向上拖拽（deltaY < 0）会增加高度，向下拖拽（deltaY > 0）会减少高度
   */
  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    const newHeight = startHeight - deltaY
    textareaHeight.value = Math.max(20, Math.min(400, Math.round(newHeight)))
  }

  /**
   * 鼠标释放时清理事件监听和样式
   */
  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  // 设置全局光标样式并添加事件监听
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

// === 自动播放语音设置 ===

// 自动播放语音开关（从 localStorage 持久化）
const autoPlaySpeech = ref(false)

// === 草稿保存与恢复系统 ===

/**
 * 从 localStorage 读取草稿映射表
 * 返回格式：{ sessionId: draftText }
 */
function readDraftMap(): DraftMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    // 验证解析结果是否为对象（排除数组和其他类型）
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // 解析失败时返回空对象
    return {}
  }
}

/**
 * 获取当前活动会话的 ID（用于草稿存储键）
 */
function getActiveDraftSessionId() {
  return chatStore.activeSessionId || chatStore.activeSession?.id || ''
}

/**
 * 加载当前活动会话的草稿内容到输入框
 */
function loadDraftForActiveSession() {
  const sessionId = getActiveDraftSessionId()
  inputText.value = sessionId ? readDraftMap()[sessionId] || '' : ''
}

/**
 * 保存当前输入框内容为草稿
 * 空内容时删除对应会话的草稿
 */
function saveDraftForActiveSession(value: string) {
  const sessionId = getActiveDraftSessionId()
  if (!sessionId) return

  const drafts = readDraftMap()
  if (value) {
    drafts[sessionId] = value
  } else {
    // 清空内容时删除草稿
    delete drafts[sessionId]
  }

  // 只在有草稿时存储，否则移除 localStorage 项
  if (Object.keys(drafts).length > 0) {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts))
  } else {
    localStorage.removeItem(DRAFT_STORAGE_KEY)
  }
}

// === 生命周期钩子与监听器 ===

/**
 * 组件挂载时执行的初始化操作：
 * 1. 加载当前会话的草稿
 * 2. 读取自动播放语音设置并同步到 chat store
 */
onMounted(() => {
  loadDraftForActiveSession()

  const saved = localStorage.getItem('autoPlaySpeech')
  if (saved !== null) {
    autoPlaySpeech.value = saved === 'true'
    // 同步到 chat store，确保全局状态一致
    chatStore.setAutoPlaySpeech(autoPlaySpeech.value)
  }
})

/**
 * 监听自动播放语音设置变化，同步到 localStorage 和 chat store
 */
watch(autoPlaySpeech, (value) => {
  localStorage.setItem('autoPlaySpeech', String(value))
  // 通知 chat store 更新全局状态
  chatStore.setAutoPlaySpeech(value)
})

/**
 * 监听输入文本变化，自动保存草稿
 */
watch(inputText, (value) => {
  saveDraftForActiveSession(value)
})

/**
 * 监听会话切换，加载新会话的草稿
 */
watch(() => chatStore.activeSession?.id, () => {
  loadDraftForActiveSession()
})

/**
 * 是否可以发送消息
 * 条件：输入框有非空白文本 或 有附件
 */
const canSend = computed(() => inputText.value.trim() || attachments.value.length > 0)

/**
 * 将选中的 Slash 命令滚动到可视区域
 */
function scrollCommandIntoView() {
  nextTick(() => {
    if (!commandDropdownRef.value) return
    const active = commandDropdownRef.value.querySelector('.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
}

/**
 * 更新 Slash 命令状态
 * 检查光标位置是否在以 / 开头的单词中，若是则激活命令下拉菜单
 */
function updateSlashState() {
  // 非 Bridge 会话不支持 Slash 命令
  if (!isBridgeSession.value) {
    slashActive.value = false
    return
  }

  const el = textareaRef.value
  if (!el) return

  const cursorPos = el.selectionStart
  const beforeCursor = inputText.value.slice(0, cursorPos)

  // 检查条件：必须以 / 开头，且不包含空格或换行
  if (!beforeCursor.startsWith('/') || beforeCursor.includes(' ') || beforeCursor.includes('\n')) {
    slashActive.value = false
    return
  }

  // 提取搜索词（去掉开头的 /）
  slashQuery.value = beforeCursor.slice(1)
  slashActiveIndex.value = 0
  // 只有在有匹配命令时才激活下拉菜单
  slashActive.value = filteredBridgeCommands.value.length > 0
}

/**
 * 选择并插入 Slash 命令到输入框
 */
function selectBridgeCommand(command: { name: string; args: string; insertText?: string }) {
  // 使用 insertText（完整命令）或 name（命令名），后面加空格
  inputText.value = `/${command.insertText || command.name} `
  slashActive.value = false

  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    // 将光标定位到命令末尾
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

// === 上下文长度管理模块 ===

// 当前模型的上下文窗口长度（token 数）
const contextLength = ref(256000)
// 上下文长度的默认回退值
const FALLBACK_CONTEXT = 256000
// 已加载的上下文长度的缓存键（用于避免重复请求）
let contextLengthLoadedKey = ''
// 当前正在请求的上下文长度的键
let contextLengthRequestKey = ''
// 上下文长度请求的 Promise（用于去重）
let contextLengthRequest: Promise<void> | null = null

// === 上下文长度编辑弹窗 ===

// 是否显示上下文长度编辑弹窗
const showContextEditModal = ref(false)
// 正在编辑的上下文长度值
const editingContextLimit = ref(256000)
// 是否正在保存上下文长度
const isSavingContextLimit = ref(false)
// 是否为编码代理会话（编码代理会话不支持上下文编辑）
const isCodingAgentSession = computed(() => chatStore.activeSession?.source === 'coding_agent')

/**
 * 打开上下文长度编辑弹窗
 */
async function handleEditContextLimit() {
  if (isCodingAgentSession.value) return
  editingContextLimit.value = contextLength.value
  showContextEditModal.value = true
}

/**
 * 保存上下文长度设置到后端
 */
async function saveContextLimit() {
  // 验证输入值
  if (!editingContextLimit.value || editingContextLimit.value <= 0) {
    message.error(t('chat.contextEditInvalid'))
    return
  }

  isSavingContextLimit.value = true
  try {
    const provider = chatStore.activeSession?.provider || appStore.selectedProvider || ''
    const model = chatStore.activeSession?.model || appStore.selectedModel || ''

    if (!provider || !model) {
      message.error(t('chat.contextEditFailed'))
      return
    }

    // 调用 API 更新模型上下文设置
    await setModelContext(provider, model, editingContextLimit.value)
    contextLength.value = editingContextLimit.value
    contextLengthLoadedKey = currentContextLengthKey()
    showContextEditModal.value = false
    message.success(t('chat.contextEditSuccess'))
  } catch (err: any) {
    message.error(`${t('chat.contextEditFailed')}: ${err.message || ''}`)
  } finally {
    isSavingContextLimit.value = false
  }
}

/**
 * 获取当前上下文长度查询参数
 */
function currentContextLengthParams() {
  const activeSession = chatStore.activeSession
  return {
    profile: activeSession?.profile || profilesStore.activeProfileName || undefined,
    provider: activeSession?.provider || undefined,
    model: activeSession?.model || undefined,
  }
}

/**
 * 生成上下文长度缓存键
 * 格式：profile|provider|model
 */
function currentContextLengthKey() {
  const params = currentContextLengthParams()
  return `${params.profile || ''}|${params.provider || ''}|${params.model || ''}`
}

/**
 * 加载上下文长度（带缓存和去重）
 * 避免重复请求相同参数的上下文长度
 */
async function loadContextLength() {
  // 编码代理会话不显示上下文信息
  if (isCodingAgentSession.value) return

  const key = currentContextLengthKey()

  // 如果已加载过相同的键，直接返回
  if (key === contextLengthLoadedKey) return

  // 如果正在请求相同的键，返回已有请求的 Promise
  if (key === contextLengthRequestKey && contextLengthRequest) return contextLengthRequest

  contextLengthRequestKey = key
  contextLengthRequest = (async () => {
    const params = currentContextLengthParams()
    try {
      // 调用 API 获取上下文长度
      const value = await fetchContextLength(params.profile, params.provider, params.model)
      // 检查键是否已变更（会话切换等情况）
      if (currentContextLengthKey() !== key) return
      contextLength.value = value
      contextLengthLoadedKey = key
    } catch {
      // 请求失败时使用默认回退值
      if (currentContextLengthKey() !== key) return
      contextLength.value = FALLBACK_CONTEXT
      contextLengthLoadedKey = key
    } finally {
      // 清理请求状态
      if (contextLengthRequestKey === key) {
        contextLengthRequest = null
        contextLengthRequestKey = ''
      }
    }
  })()

  return contextLengthRequest
}

// 组件挂载时加载上下文长度
onMounted(loadContextLength)

/**
 * 监听影响上下文长度的变化，重新加载上下文长度
 * 监听的状态包括：profile、provider、model、session 信息
 */
watch(
  () => [
    profilesStore.activeProfileName,
    appStore.selectedProvider,
    appStore.selectedModel,
    chatStore.activeSession?.id,
    chatStore.activeSession?.profile,
    chatStore.activeSession?.provider,
    chatStore.activeSession?.model,
    chatStore.activeSession?.source,
  ],
  loadContextLength,
  { flush: 'post' },
)

// === 上下文使用统计 ===

/**
 * 计算当前会话使用的总 token 数
 * 优先使用 contextTokens，其次使用 inputTokens + outputTokens
 */
const totalTokens = computed(() => {
  if (isCodingAgentSession.value) return 0
  const context = chatStore.activeSession?.contextTokens
  if (typeof context === 'number' && Number.isFinite(context) && context > 0) return context
  const input = chatStore.activeSession?.inputTokens ?? 0
  const output = chatStore.activeSession?.outputTokens ?? 0
  return input + output
})

// 是否显示上下文使用信息（token 数 > 0 时显示）
const showContextUsage = computed(() => totalTokens.value > 0)

// 剩余可用 token 数
const remainingTokens = computed(() => Math.max(0, contextLength.value - totalTokens.value))

// 上下文使用率百分比（0-100）
const usagePercent = computed(() =>
  Math.min((totalTokens.value / contextLength.value) * 100, 100),
)

/**
 * 格式化 token 数量显示
 * 大于 1M 显示为 x.xM，大于 1k 显示为 x.xk，否则显示原始数字
 */
function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// === 文件附件处理 ===

/**
 * 添加文件到附件列表
 * 自动生成唯一 ID 和预览 URL，避免重复添加同名文件
 */
function addFile(file: File) {
  // 检查是否已存在同名文件
  if (attachments.value.find(a => a.name === file.name)) return

  // 生成唯一 ID：时间戳（36进制）+ 随机字符串
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  // 创建文件预览 URL
  const url = URL.createObjectURL(file)

  attachments.value.push({
    id,
    name: file.name,
    type: file.type,
    size: file.size,
    url,
    file,
  })
}

/**
 * 触发文件选择对话框
 */
function handleAttachClick() {
  fileInputRef.value?.click()
}

/**
 * 处理文件选择变化
 * 将选中的文件添加到附件列表，并清空 input 以便重复选择相同文件
 */
function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return

  for (const file of input.files) addFile(file)
  // 清空 input 值，允许用户再次选择相同文件
  input.value = ''
}

// === 粘贴图片处理 ===

/**
 * 处理粘贴事件，提取剪贴板中的图片
 */
function handlePaste(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items || [])
  // 筛选出图片类型的数据项
  const imageItems = items.filter(i => i.type.startsWith('image/'))

  if (!imageItems.length) return

  e.preventDefault()

  for (const item of imageItems) {
    const blob = item.getAsFile()
    if (!blob) continue

    // 提取文件扩展名
    const ext = item.type.split('/')[1] || 'png'
    // 创建新文件对象，命名格式：pasted-时间戳.扩展名
    const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type })
    addFile(file)
  }
}

// === 拖拽上传处理 ===

/**
 * 处理拖拽经过事件
 * 阻止默认行为以允许放置
 */
function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

/**
 * 处理拖拽进入事件
 * 使用计数器处理嵌套元素的拖拽事件
 */
function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  // 检查是否为文件拖拽
  if (e.dataTransfer?.types.includes('Files')) {
    dragCounter.value++
    isDragging.value = true
  }
}

/**
 * 处理拖拽离开事件
 * 计数器归零时才取消拖拽状态
 */
function handleDragLeave() {
  dragCounter.value--
  if (dragCounter.value <= 0) {
    dragCounter.value = 0
    isDragging.value = false
  }
}

/**
 * 处理文件放置事件
 * 将放置的文件添加到附件列表
 */
function handleDrop(e: DragEvent) {
  e.preventDefault()
  dragCounter.value = 0
  isDragging.value = false

  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return

  for (const file of files) addFile(file)
  // 放置完成后聚焦到文本域
  textareaRef.value?.focus()
}

// === 发送消息 ===

/**
 * 发送消息处理函数
 * 清空输入框和附件列表，并重置文本域高度
 */
function handleSend() {
  const text = inputText.value.trim()

  // 验证：必须有文本或附件才能发送
  if (!text && attachments.value.length === 0) return

  // 调用 chat store 发送消息
  chatStore.sendMessage(text, attachments.value.length > 0 ? attachments.value : undefined)

  // 发送后清理状态
  inputText.value = ''
  saveDraftForActiveSession('') // 清空草稿
  attachments.value = []
  slashActive.value = false

  // 重置文本域高度为自动
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }
}

// === 语音捕捉控制 ===

/**
 * 开始语音捕捉
 * 根据设置选择浏览器原生识别或后端麦克风录音
 */
async function startVoiceCapture() {
  // 清除之前的浏览器识别错误
  browserRecognition.clearError()

  // 开始语音对话捕捉流程
  const { captureId } = await voiceDialogue.beginCapture()

  // 判断使用哪种语音识别方案
  const useBrowserProvider = sttSettings.provider.value === 'browser'
  activeVoiceCaptureMode.value = useBrowserProvider ? 'browser' : 'backend'

  try {
    if (useBrowserProvider) {
      // 使用浏览器原生语音识别
      await browserRecognition.start({ language: browserCaptureLanguage() })
      return
    }

    // 使用后端 API：启动麦克风录音
    await micRecorder.start()
  } catch {
    // 启动失败，清理状态
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
  }
}

/**
 * 停止语音捕捉并处理结果
 * 根据当前模式执行不同的停止逻辑
 */
async function stopVoiceCapture() {
  const captureId = voiceDialogue.activeCaptureId.value
  if (!captureId) return

  // 浏览器模式：停止识别并提交转录结果
  if (activeVoiceCaptureMode.value === 'browser') {
    let transcript = ''

    try {
      transcript = await browserRecognition.stop()
    } catch {
      // 停止失败，取消捕捉
      activeVoiceCaptureMode.value = null
      voiceDialogue.cancelCapture(captureId)
      return
    }

    activeVoiceCaptureMode.value = null

    try {
      // 提交转录结果
      await voiceDialogue.commitTranscript(captureId, transcript)
    } catch {
      // 语音对话状态已经追踪发送错误，无需额外处理
    }
    return
  }

  // 后端模式：检查麦克风状态
  if (micRecorder.state.value.status === 'requesting') {
    // 麦克风权限请求中，取消请求
    micRecorder.cancel()
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
    return
  }

  let audio: Blob

  try {
    // 停止录音并获取音频数据
    audio = await micRecorder.stop()
  } catch {
    // 停止失败，取消捕捉
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
    return
  }

  activeVoiceCaptureMode.value = null

  // 检查音频数据是否有效
  if (audio.size <= 0) {
    voiceDialogue.cancelCapture(captureId)
    return
  }

  try {
    // 调用后端 API 转录并发送
    await voiceDialogue.transcribeAndSend(captureId, audio)
  } catch {
    // 语音对话状态已经追踪转录/发送错误，无需额外处理
  }
}

/**
 * 取消语音捕捉
 * 立即停止录音/识别并清理状态
 */
function cancelVoiceCapture() {
  if (activeVoiceCaptureMode.value === 'browser') {
    browserRecognition.cancel()
  } else {
    micRecorder.cancel()
  }

  activeVoiceCaptureMode.value = null
  voiceDialogue.cancelCapture()
}

// === 输入法（IME）事件处理 ===

/**
 * 输入法输入开始
 * 设置 isComposing 标志为 true，避免在输入法组合过程中误触发事件
 */
function handleCompositionStart() {
  isComposing.value = true
}

/**
 * 输入法输入结束
 * 设置 isComposing 标志为 false，并延迟更新 Slash 命令状态
 */
function handleCompositionEnd() {
  requestAnimationFrame(() => {
    isComposing.value = false
    updateSlashState()
  })
}

/**
 * 判断是否为输入法输入状态
 * 兼容不同浏览器的输入法事件检测方式
 */
function isImeEnter(e: KeyboardEvent): boolean {
  return isComposing.value || e.isComposing || e.keyCode === 229
}

// === 键盘事件处理 ===

/**
 * 处理键盘按下事件
 * 支持 Slash 命令导航和 Enter 发送消息
 */
function handleKeydown(e: KeyboardEvent) {
  // Slash 命令下拉菜单激活时的键盘导航
  if (slashActive.value && filteredBridgeCommands.value.length > 0) {
    if (e.key === 'ArrowDown') {
      // 向下箭头：切换到下一个命令
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value + 1) % filteredBridgeCommands.value.length
      scrollCommandIntoView()
      return
    }
    if (e.key === 'ArrowUp') {
      // 向上箭头：切换到上一个命令
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value - 1 + filteredBridgeCommands.value.length) % filteredBridgeCommands.value.length
      scrollCommandIntoView()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      // Enter/Tab：选中当前命令
      e.preventDefault()
      selectBridgeCommand(filteredBridgeCommands.value[slashActiveIndex.value])
      return
    }
    if (e.key === 'Escape') {
      // Escape：关闭命令下拉菜单
      e.preventDefault()
      slashActive.value = false
      return
    }
  }

  // 非 Slash 命令模式下，Enter 键发送消息（Shift+Enter 换行）
  if (e.key !== 'Enter' || e.shiftKey) return

  // 输入法输入中不发送消息
  if (isImeEnter(e)) return

  e.preventDefault()
  handleSend()
}

/**
 * 处理输入事件
 * 更新 Slash 命令状态并自动调整文本域高度
 */
function handleInput(e: Event) {
  const el = e.target as HTMLTextAreaElement

  // 非输入法输入时更新 Slash 状态
  if (!isComposing.value) updateSlashState()

  // 用户手动拖拽设置了自定义高度时，不自动调整
  if (textareaHeight.value !== null) return

  // 自动调整文本域高度（最大 100px）
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 100) + 'px'
}

/**
 * 处理命令下拉菜单项悬停
 * 更新当前选中的命令索引
 */
function handleCommandHover(index: number) {
  slashActiveIndex.value = index
}

/**
 * 处理文档鼠标按下事件
 * 点击下拉菜单外部时关闭命令下拉菜单
 */
function onDocumentMousedown(e: MouseEvent) {
  if (!slashActive.value) return

  const target = e.target as HTMLElement
  // 如果点击的不是命令下拉菜单且不是输入包装器，关闭下拉菜单
  if (!target.closest('.slash-command-dropdown') && !target.closest('.input-wrapper')) {
    slashActive.value = false
  }
}

// 组件挂载时添加全局点击事件监听
onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
})

// 组件卸载时移除全局点击事件监听
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
})

// === 辅助函数 ===

/**
 * 移除指定附件
 * 同时释放对应的 ObjectURL 资源
 */
function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id)
  if (idx !== -1) {
    // 释放文件预览 URL
    URL.revokeObjectURL(attachments.value[idx].url)
    attachments.value.splice(idx, 1)
  }
}

/**
 * 格式化文件大小显示
 * 小于 1KB 显示为 B，小于 1MB 显示为 KB，否则显示为 MB
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * 判断文件类型是否为图片
 */
function isImage(type: string): boolean {
  return type.startsWith('image/')
}
</script>

<template>
  <div class="chat-input-area">
    <!-- Top bar: attach + auto play speech + context info -->
    <div class="input-top-bar">
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton quaternary size="tiny" @click="handleAttachClick" circle>
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </template>
          </NButton>
        </template>
        {{ t('chat.attachFiles') }}
      </NTooltip>

      <NPopselect
        v-if="!isCodingAgentSession"
        :value="currentReasoningEffort"
        :options="reasoningEffortOptions"
        trigger="click"
        @update:value="onReasoningEffortChange"
      >
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              quaternary
              size="tiny"
              circle
              class="reasoning-effort-button"
              :class="{ active: !!currentReasoningEffort }"
              :aria-label="`${t('chat.reasoningEffort.tooltip')}: ${reasoningEffortLabel}`"
            >
              <template #icon>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                </svg>
              </template>
            </NButton>
          </template>
          {{ t('chat.reasoningEffort.tooltip') }}: {{ reasoningEffortLabel }}
        </NTooltip>
      </NPopselect>

      <div class="auto-play-speech-switch">
        <NTooltip trigger="hover">
          <template #trigger>
            <div class="switch-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>
          </template>
          {{ t('chat.autoPlaySpeech') }}
        </NTooltip>
        <NSwitch
          size="small"
          v-model:value="autoPlaySpeech"
          :round="false"
        />
      </div>

      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            quaternary
            size="tiny"
            class="tool-trace-toggle"
            :class="{ active: toolTraceVisible }"
            :aria-label="toolTraceVisible ? t('chat.hideToolCalls') : t('chat.showToolCalls')"
            @click="toggleToolTraceVisible"
          >
            <svg class="tool-trace-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a4.5 4.5 0 0 0-5.8 5.8L3.5 17.5a2.1 2.1 0 0 0 3 3l5.4-5.4a4.5 4.5 0 0 0 5.8-5.8l-3 3-3-3 3-3z"/>
            </svg>
          </NButton>
        </template>
        {{ toolTraceVisible ? t('chat.hideToolCalls') : t('chat.showToolCalls') }}
      </NTooltip>

      <span v-if="showContextUsage" class="context-info" :class="{ 'context-warning': usagePercent > 80 }">
        {{ formatTokens(totalTokens) }} /
        <NTooltip trigger="hover">
          <template #trigger>
            <span class="context-limit-editable" @click="handleEditContextLimit">
              {{ formatTokens(contextLength) }}
            </span>
          </template>
          <span>{{ t('chat.contextClickToEdit') }}</span>
        </NTooltip>
        · {{ t('chat.contextRemaining') }} {{ formatTokens(remainingTokens) }}
      </span>
      <div v-if="showContextUsage" class="context-bar">
        <div
          class="context-bar-fill"
          :class="{
            'context-bar-warn': usagePercent > 60 && usagePercent <= 80,
            'context-bar-danger': usagePercent > 80,
          }"
          :style="{ width: `${usagePercent}%` }"
        />
      </div>
    </div>

    <!-- Attachment previews -->
    <div v-if="attachments.length > 0" class="attachment-previews">
      <div
        v-for="att in attachments"
        :key="att.id"
        class="attachment-preview"
        :class="{ image: isImage(att.type) }"
      >
        <template v-if="isImage(att.type)">
          <img :src="att.url" :alt="att.name" class="attachment-thumb" />
        </template>
        <template v-else>
          <div class="attachment-file">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="file-name">{{ att.name }}</span>
            <span class="file-size">{{ formatSize(att.size) }}</span>
          </div>
        </template>
        <button class="attachment-remove" @click="removeAttachment(att.id)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <div
      class="input-wrapper"
      :class="{ 'drag-over': isDragging }"
      @dragover="handleDragOver"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileChange"
      />
      <div class="resize-handle" @mousedown="startResize"></div>
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-textarea"
        :style="textareaHeight ? { height: textareaHeight + 'px' } : {}"
        :placeholder="t('chat.inputPlaceholder')"
        rows="1"
        @keydown="handleKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @input="handleInput"
        @paste="handlePaste"
      ></textarea>
      <Transition name="dropdown-fade">
        <div
          v-if="slashActive && filteredBridgeCommands.length > 0"
          ref="commandDropdownRef"
          class="slash-command-dropdown"
        >
          <div
            v-for="(command, i) in filteredBridgeCommands"
            :key="command.name"
            class="slash-command-item"
            :class="{ active: i === slashActiveIndex }"
            @mousedown.prevent="selectBridgeCommand(command)"
            @mouseenter="handleCommandHover(i)"
          >
            <span class="slash-command-name">/{{ command.name }}</span>
            <span v-if="command.args" class="slash-command-args">{{ command.args }}</span>
            <span class="slash-command-desc">{{ command.description }}</span>
          </div>
        </div>
      </Transition>
      <div class="input-actions">
        <VoiceDialogueControls
          :status="voiceDialogue.status.value"
          :transcript="voiceDialogueTranscript"
          :error="voiceDialogueError"
          :events="voiceDialogue.events.value"
          :on-start="startVoiceCapture"
          :on-stop="stopVoiceCapture"
          :on-cancel="cancelVoiceCapture"
        />
        <NButton
          v-if="chatStore.isStreaming"
          size="small"
          type="error"
          :disabled="chatStore.isAborting"
          @click="chatStore.stopStreaming()"
        >
          {{ t('chat.stop') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="!canSend"
          @click="handleSend"
        >
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </template>
          {{ t('chat.send') }}
        </NButton>
      </div>
    </div>

    <!-- Context Length Edit Modal -->
    <NModal
      v-model:show="showContextEditModal"
      :title="t('chat.contextEditTitle')"
      :mask-closable="true"
      preset="card"
      style="width: 400px"
    >
      <div class="context-edit-content">
        <p style="margin-bottom: 16px; color: #666;">
          {{ t('chat.contextEditDesc') }}
        </p>
        <NInputNumber
          v-model:value="editingContextLimit"
          :min="1000"
          :max="10000000"
          :step="1000"
          :show-button="false"
          :placeholder="t('chat.contextEditPlaceholder')"
          style="width: 100%"
        >
          <template #suffix>
            <span style="color: #999;">tokens</span>
          </template>
        </NInputNumber>
        <div style="margin-top: 12px; font-size: 12px; color: #999;">
          {{ t('chat.contextEditHint') }}
        </div>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <NButton @click="showContextEditModal = false" :disabled="isSavingContextLimit">
            {{ t('chat.contextEditCancel') }}
          </NButton>
          <NButton type="primary" @click="saveContextLimit" :loading="isSavingContextLimit">
            {{ t('chat.contextEditSave') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.chat-input-area {
  padding: 12px 20px 16px;
  border-top: 1px solid $border-color;
  flex-shrink: 0;
}

.input-top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 6px;
}

.auto-play-speech-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 0 0 8px;
  border-left: 1px solid $border-light;
  margin-left: 4px;

  .switch-label {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: #999999;
    font-size: 12px;

    svg {
      opacity: 1;
    }
  }

  :deep(.n-switch),
  :deep(.n-switch__rail) {
    margin-right: 0;
  }
}

.tool-trace-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #999999;
  width: 24px;
  min-width: 24px;
  height: 22px;
  margin-left: -4px;
  padding: 0;
  background: transparent !important;
  opacity: 1;

  :deep(.n-button__state-border),
  :deep(.n-button__border),
  :deep(.n-button__ripple) {
    display: none;
  }

  .tool-trace-icon {
    display: block;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
  }

  &.active {
    color: #999999;
    opacity: 1;
  }

  &:hover {
    color: #999999;
    opacity: 1;
  }
}

.reasoning-effort-button {
  &.active {
    color: #4caf50;
  }
}

.context-info {
  font-size: 11px;
  color: $text-muted;

  &.context-warning {
    color: #e8a735;
  }
}

.context-limit-editable {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition: all 0.2s ease;
  padding: 0 2px;

  &:hover {
    border-bottom-color: $text-muted;
    background: rgba(128, 128, 128, 0.1);
    border-radius: 2px;
  }
}

.context-bar {
  width: 60px;
  height: 4px;
  background: rgba(128, 128, 128, 0.2);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(128, 128, 128, 0.3), rgba(128, 128, 128, 0.6));
  border-radius: 2px;
  transition: width 0.3s ease;

  &.context-bar-warn {
    background: linear-gradient(90deg, #c98a1a, #e8a735);
  }

  &.context-bar-danger {
    background: linear-gradient(90deg, #c43a2a, #e85d4a);
  }
}

.attachment-previews {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 10px;
}

.attachment-preview {
  position: relative;
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: $bg-secondary;
  border: 1px solid $border-color;

  &.image {
    width: 64px;
    height: 64px;
  }
}

.attachment-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment-file {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 8px 12px;
  min-width: 80px;
  max-width: 140px;
  color: $text-secondary;

  .file-name {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .file-size {
    font-size: 10px;
    color: $text-muted;
  }
}

.attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.5);
  color: var(--text-on-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity $transition-fast;

  .attachment-preview:hover & {
    opacity: 1;
  }
}

.file-input-hidden {
  display: none;
}

.input-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
  background-color: $bg-input;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 10px 12px;
  position: relative;
  transition: border-color $transition-fast, background-color $transition-fast;

  &:focus-within {
    border-color: $accent-primary;
  }

  .dark & {
    background-color: #333333;
  }
}

.resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  z-index: 2;

  &:hover {
    background: rgba($accent-primary, 0.15);
    border-radius: 4px;
  }
}

.input-textarea {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: $text-primary;
  font-family: $font-ui;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  max-height: 400px;
  min-height: 20px;
  overflow-y: auto;

  @media (max-width: 768px) {
    font-size: 16px;
  }

  &::placeholder {
    color: $text-muted;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.input-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}

.slash-command-dropdown {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 8px);
  max-height: 240px;
  overflow-y: auto;
  background: $bg-primary;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
  z-index: 20;
  padding: 4px;

  .dark & {
    background: #2a2a2a;
  }
}

.slash-command-item {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: $radius-sm;
  cursor: pointer;
  min-height: 36px;

  &.active,
  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

.slash-command-name {
  font-family: $font-code;
  font-size: 13px;
  color: $accent-primary;
  white-space: nowrap;
}

.slash-command-args {
  font-family: $font-code;
  font-size: 12px;
  color: $text-muted;
  white-space: nowrap;
}

.slash-command-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-secondary;
  font-size: 12px;
}

.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

// Drag-over state
.input-wrapper.drag-over {
  border-color: var(--accent-info);
  border-style: dashed;
  background-color: rgba(var(--accent-info-rgb), 0.04);
}
</style>
