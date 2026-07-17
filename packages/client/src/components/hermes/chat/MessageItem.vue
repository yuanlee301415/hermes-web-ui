<script setup lang="ts">
/**
 * MessageItem 组件
 * 
 * 该组件负责渲染聊天界面中的单条消息，支持多种消息类型：
 * - 用户消息 (user)
 * - 助手消息 (assistant)
 * - 工具调用消息 (tool)
 * - 系统消息 (system)
 * - 命令消息 (command)
 * 
 * 主要功能：
 * 1. 消息内容渲染（支持 Markdown、多模态内容）
 * 2. 思考内容展示（<think> 标签解析）
 * 3. 工具调用详情展示（参数和结果）
 * 4. 附件展示与下载
 * 5. 语音播放（支持多种 TTS 服务）
 * 6. 消息复制功能
 * 7. 图片预览功能
 */

// 类型导入：Message 消息对象类型，ContentBlock 多模态内容块类型
import type { Message, ContentBlock } from "@/stores/hermes/chat";
// Vue 3 响应式 API：computed 计算属性、onBeforeUnmount 组件卸载前钩子、onMounted 组件挂载后钩子、ref 响应式引用、watchEffect 响应式副作用
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
// 国际化工具：useI18n 返回翻译函数 t
import { useI18n } from "vue-i18n";
// Naive UI 消息提示组件：用于显示复制成功/失败等 Toast 提示
import { useMessage } from "naive-ui";
// 下载相关 API：downloadFile 执行文件下载，getDownloadUrl 生成下载 URL
import { downloadFile, getDownloadUrl } from "@/api/hermes/download";
// 剪贴板工具：复制文本到系统剪贴板
import { copyToClipboard } from "@/utils/clipboard";
// Markdown 渲染组件：负责将 Markdown 文本转换为 HTML
import MarkdownRenderer from "./MarkdownRenderer.vue";

// 思考内容解析工具：parseThinking 解析消息中的 <think> 标签，countThinkingChars 统计思考内容字符数
import { parseThinking, countThinkingChars } from "@/utils/thinking-parser";

// 状态管理 Store：
// - useChatStore: 聊天会话状态（消息列表、当前会话、思考观测等）
// - useProfilesStore: 用户配置状态（头像、配置文件列表）
// - useSettingsStore: 全局设置状态（显示设置、语音设置等）
import { useChatStore } from "@/stores/hermes/chat";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { useSettingsStore } from "@/stores/hermes/settings";

// 头像组件：根据配置文件名称和头像数据渲染助手头像
import ProfileAvatar from "@/components/hermes/profiles/ProfileAvatar.vue";

// 代码高亮相关工具函数：
// - copyTextToClipboard: 将文本复制到剪贴板
// - extractUnifiedDiffPayload: 从工具调用结果中提取统一差异（unified diff）格式内容
// - handleCodeBlockCopyClick: 处理代码块复制按钮的点击事件
// - inferStructuredLanguage: 推断文本的结构化语言类型（如 JSON、diff）
// - renderHighlightedCodeBlock: 将代码文本渲染为带语法高亮的 HTML
import {
  copyTextToClipboard,
  extractUnifiedDiffPayload,
  handleCodeBlockCopyClick,
  inferStructuredLanguage,
  renderHighlightedCodeBlock,
} from "./highlight";

// 全局语音播放 composable：管理语音播放状态和播放控制
import { useGlobalSpeech } from "@/composables/useSpeech";
// 语音设置 composable：管理 TTS 服务提供商配置（OpenAI、Edge、Web Speech API 等）
import { useVoiceSettings } from "@/composables/useVoiceSettings";
// TTS 工具函数：speedToEdgeRate 将语速值转换为 Edge TTS 格式，hzToEdgePitch 将音调值转换为 Edge TTS 格式
import { speedToEdgeRate, hzToEdgePitch } from "@/utils/ttsHelpers";

// ========== 常量配置 ==========

// 工具调用负载的最大显示长度（防止过长内容影响渲染性能）
const TOOL_PAYLOAD_DISPLAY_LIMIT = 1000;
// JSON 字符串的最大显示长度（超过此长度的字符串会被截断并添加标记）
const JSON_STRING_DISPLAY_LIMIT = 200;
// JSON 解析的最大嵌套深度（防止解析深层嵌套 JSON 时的无限递归和性能问题）
const JSON_MAX_DEPTH = 6;
// JSON 解析的最大节点数（防止解析超大 JSON 时的性能问题）
const JSON_MAX_NODES = 1000;
// 单个 JSON 对象的最大键数量（超过此数量会截断）
const JSON_MAX_KEYS_PER_OBJECT = 50;
// 单个 JSON 数组的最大元素数量（超过此数量会截断）
const JSON_MAX_ITEMS_PER_ARRAY = 50;
// JSON 截断标记键名（用于在截断的 JSON 对象中标记被截断的内容）
const JSON_TRUNCATED_KEY = "__truncated__";

// ========== Props 定义 ==========

// 组件属性定义：
// - message: 必传，当前要渲染的消息对象
// - highlight: 可选，是否高亮显示该消息（用于搜索结果定位等场景）
// - headingIdPrefix: 可选，Markdown 标题 ID 的前缀（用于锚点跳转）
const props = defineProps<{
  message: Message;
  highlight?: boolean;
  headingIdPrefix?: string;
}>();

// ========== 初始化工具函数和状态 ==========

// 国际化翻译函数，用于获取多语言文本
const { t } = useI18n();
// 消息提示实例，用于显示复制成功/失败、下载状态等 Toast 通知
const toast = useMessage();

// ========== 消息类型判断计算属性 ==========

// 判断是否为系统消息（role 为 system），系统消息通常用于显示系统提示或通知
const isSystem = computed(() => props.message.role === "system");

// 判断是否为助手错误消息（assistant 角色且 systemType 为 error），用于特殊的错误样式展示
const isAgentError = computed(() => props.message.role === "assistant" && props.message.systemType === "error");

// 有效标题 ID 前缀：优先使用传入的 headingIdPrefix，否则使用消息 ID 作为前缀
// 用于 Markdown 渲染时为标题生成唯一 ID，支持锚点跳转
const effectiveHeadingIdPrefix = computed(() => props.headingIdPrefix || `msg-${props.message.id}`);

// 判断是否为命令消息（role 为 command 或 systemType 为 command），用于执行系统命令
const isCommandMessage = computed(() => props.message.role === "command" || props.message.systemType === "command");

// 判断是否为命令错误消息（command 角色且 systemType 为 error），用于展示命令执行失败
const isCommandError = computed(() => props.message.role === "command" && props.message.systemType === "error");

// 判断是否为状态命令消息：命令消息且 commandAction 为 status，且不是 goal 类型
// 状态命令用于展示 Hermes Agent 的运行状态信息
const isStatusCommand = computed(() =>
  isCommandMessage.value
  && props.message.commandAction === "status"
  && props.message.commandData?.type !== "goal"
);

// 状态命令消息的显示项列表：从 commandData 中提取运行状态信息
// 包含：运行状态、消息来源、配置文件、模型名称、队列长度、运行 ID
const statusItems = computed(() => {
  const data = props.message.commandData || {};
  return [
    { key: "status", value: data.isWorking ? "running" : "idle" },  // 运行状态：running（运行中）或 idle（空闲）
    { key: "source", value: data.source },                           // 消息来源标识
    { key: "profile", value: data.profile },                         // 当前使用的配置文件名称
    { key: "model", value: data.model || "-" },                      // 使用的模型名称，默认为 "-"
    { key: "queue", value: data.queueLength ?? 0 },                  // 任务队列长度，默认为 0
    { key: "run", value: data.runId || "-" },                        // 当前运行 ID，默认为 "-"
  ];
});

// ========== 多模态内容解析相关 ==========

// 多模态内容文件类型定义：用于表示消息中的图片或文件附件
type DisplayContentFile = {
  type: 'image' | 'file'   // 文件类型：image（图片）或 file（普通文件）
  name: string              // 文件名称（用于显示和下载）
  path?: string             // 文件路径（用于后端 API 下载）
  url?: string              // 文件 URL（用于前端直接显示，如 Data URL）
}

/**
 * 从内容块中提取文本内容
 * @param block 内容块对象
 * @returns 提取的文本字符串，若无法提取则返回空字符串
 */
function getBlockText(block: any): string {
  // 校验块是否为有效对象
  if (!block || typeof block !== 'object') return ''
  // 只处理文本类型的块（text 或 input_text）
  if (block.type === 'text' || block.type === 'input_text') {
    return typeof block.text === 'string' ? block.text : ''
  }
  return ''
}

/**
 * 从内容块中提取图片 URL
 * @param block 内容块对象
 * @returns 图片 URL 字符串，若无法提取则返回 null
 */
function getImageUrlFromBlock(block: any): string | null {
  // 校验块是否为有效对象
  if (!block || typeof block !== 'object') return null
  // 只处理图片类型的块（input_image 或 image_url）
  if (block.type !== 'input_image' && block.type !== 'image_url') return null
  const raw = block.image_url
  // 支持字符串格式的 URL（如 "https://example.com/image.png"）
  if (typeof raw === 'string') return raw
  // 支持对象格式的 URL（如 { url: 'xxx' }）
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url
  return null
}

/**
 * 从 Data URL 中生成图片文件名
 * @param url Data URL（如 data:image/png;base64,iVBORw0KGgo...）
 * @param index 图片索引（用于生成唯一文件名，避免重复）
 * @returns 生成的文件名（如 image-1.png）
 */
function imageNameFromDataUrl(url: string, index: number): string {
  // 使用正则表达式从 Data URL 中提取图片类型（如 png、jpeg、gif）
  const match = url.match(/^data:image\/([^;,]+)/i)
  // 处理 jpeg 格式（将 jpeg 转换为更常用的 jpg 扩展名）
  const ext = match?.[1] === 'jpeg' ? 'jpg' : match?.[1] || 'png'
  // 生成带索引的文件名，确保唯一性
  return `image-${index + 1}.${ext}`
}

/**
 * 解析消息内容为 ContentBlock 数组
 * 支持两种格式：
 * 1. 标准 JSON 格式：[{"type": "text", "text": "..."}]
 * 2. Hermes Agent 遗留的 Python 格式：[{'type': 'text'}, {'type': 'image_url', ...}]
 * 
 * @param content 消息内容字符串
 * @returns ContentBlock 数组，解析失败返回 null
 */
function parseContentBlocks(content: string): Array<ContentBlock | Record<string, unknown>> | null {
  const trimmed = content.trim()
  // 空内容直接返回 null
  if (!trimmed) return null

  // 内部解析函数：验证是否为有效 ContentBlock 数组
  const parse = (value: string) => {
    const parsed = JSON.parse(value)
    // 必须是数组且第一个元素包含 type 字段（ContentBlock 的特征）
    return Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]
      ? parsed as Array<ContentBlock | Record<string, unknown>>
      : null
  }

  // 首先尝试标准 JSON 解析（现代格式）
  try {
    return parse(trimmed)
  } catch {
    // 标准 JSON 解析失败，尝试处理 Hermes Agent 遗留的 Python 格式
    // Python str(list) 格式特点：使用单引号，None/True/False 等 Python 关键字
    if (!trimmed.startsWith("[{'") && !trimmed.startsWith('[{"')) return null
    try {
      return parse(
        trimmed
          .replace(/\bNone\b/g, 'null')   // 将 Python None 转换为 JSON null
          .replace(/\bTrue\b/g, 'true')   // 将 Python True 转换为 JSON true
          .replace(/\bFalse\b/g, 'false') // 将 Python False 转换为 JSON false
          .replace(/'/g, '"'),            // 将单引号转换为双引号（JSON 标准）
      )
    } catch {
      // 两种格式都解析失败，返回 null
      return null
    }
  }
}

// ========== 内容块解析计算属性 ==========

// 从消息内容字符串中解析 ContentBlock[] 数组
// 如果消息内容是标准 JSON 或遗留 Python 格式，返回解析后的数组；否则返回 null
const contentBlocks = computed(() => {
  const content = props.message.content || '';
  return parseContentBlocks(content);
});

// 判断消息内容是否为 ContentBlock[] 格式（多模态格式）
// 用于区分普通文本消息和多模态消息（包含图片、文件等）
const isContentBlockArray = computed(() => contentBlocks.value !== null);

// 从 ContentBlock[] 中提取纯文本内容用于显示
// 对于普通文本消息，直接返回原始内容；对于多模态消息，提取所有文本块并拼接
const displayText = computed(() => {
  // 如果不是 ContentBlock[] 格式（普通文本消息），直接返回原始内容
  if (!isContentBlockArray.value) {
    return props.message.content || '';
  }

  // 遍历所有内容块，提取文本并拼接
  return contentBlocks.value!
    .map(block => getBlockText(block))  // 从每个块中提取文本内容
    .filter(Boolean)                     // 过滤空字符串（忽略非文本块）
    .join('\n');                         // 用换行符连接各文本块
});

// 从 ContentBlock[] 中提取文件列表（图片和普通文件）
// 支持三种类型的文件：
// 1. image 类型块（后端存储的图片，有 path 字段）
// 2. file 类型块（后端存储的普通文件，有 path 字段）
// 3. data:image 格式的图片（前端直接嵌入的 Base64 图片）
const contentFiles = computed<DisplayContentFile[] | null>(() => {
  if (!isContentBlockArray.value) return null;

  return contentBlocks.value!.flatMap<DisplayContentFile>((block, index) => {
    // 处理 image 类型块（后端存储的图片，通过 path 下载）
    if (block.type === 'image') {
      return [{
        type: 'image' as const,
        name: String((block as any).name || `image-${index + 1}`),  // 使用块中名称或生成默认名称
        path: String((block as any).path || ''),                   // 文件路径（用于下载）
      }].filter(file => file.path)  // 过滤无路径的无效文件
    }
    // 处理 file 类型块（后端存储的普通文件，通过 path 下载）
    if (block.type === 'file') {
      return [{
        type: 'file' as const,
        name: String((block as any).name || `file-${index + 1}`),   // 使用块中名称或生成默认名称
        path: String((block as any).path || ''),                   // 文件路径（用于下载）
      }].filter(file => file.path)  // 过滤无路径的无效文件
    }
    // 处理 data:image 格式的图片（前端直接嵌入的 Base64 图片，无需后端下载）
    const imageUrl = getImageUrlFromBlock(block)
    if (imageUrl?.startsWith('data:image/')) {
      return [{
        type: 'image' as const,
        name: imageNameFromDataUrl(imageUrl, index),  // 从 Data URL 提取类型生成文件名
        url: imageUrl,                                // 直接使用 Data URL 显示
      }]
    }
    return []
  });
});

/**
 * 获取内容文件的显示/下载 URL
 * @param file 内容文件对象
 * @returns 文件 URL 字符串
 */
function getContentFileUrl(file: DisplayContentFile): string {
  // 如果已有 URL（如 Data URL），直接返回用于显示
  if (file.url) return file.url
  // 如果有路径，通过后端 API 生成下载 URL；否则返回空字符串
  return file.path ? getDownloadUrl(file.path, file.name) : ''
}

// ========== 响应式状态 ==========

// 工具调用详情展开状态（用于控制工具调用参数和结果的显示/隐藏切换）
const toolExpanded = ref(false);
// 图片预览 URL（用于点击图片后全屏预览，null 表示未激活预览）
const previewUrl = ref<string | null>(null);

// ========== 状态管理 Store 初始化 ==========

const chatStore = useChatStore();           // 聊天状态 Store（消息列表、当前会话、思考观测等）
const profilesStore = useProfilesStore();   // 用户配置 Store（头像、配置文件列表）
const settingsStore = useSettingsStore();   // 设置 Store（显示设置、语音设置等）
const speech = useGlobalSpeech();           // 全局语音播放 composable（管理语音播放状态和控制）
const voiceSettings = useVoiceSettings();   // 语音设置 composable（管理 TTS 服务提供商配置）

// ========== 助手配置相关计算属性 ==========

// 助手配置文件名称：优先级依次为当前会话配置 > 全局激活配置 > 默认 "default"
// 用于获取助手的名称和头像信息
const assistantProfileName = computed(() => chatStore.activeSession?.profile || profilesStore.activeProfileName || "default");

// 助手头像：从配置文件列表中查找对应配置的头像数据
// 如果找不到对应配置，返回 undefined（由 ProfileAvatar 组件处理默认值）
const assistantProfileAvatar = computed(() => profilesStore.profiles.find(profile => profile.name === assistantProfileName.value)?.avatar);

// ========== 复制功能相关 ==========

// 可复制的消息内容：
// - 工具调用消息（role 为 tool）不支持复制
// - 空内容不支持复制
// - 其他消息类型返回原始内容
const copyableContent = computed(() => {
  // 工具调用消息不支持复制（工具详情有单独的复制按钮）
  if (props.message.role === 'tool') return null
  const content = props.message.content || ''
  // 空内容或纯空白内容不支持复制
  if (!content.trim()) return null
  return content
})

/**
 * 复制整个消息气泡内容到剪贴板
 * 复制成功显示成功提示，失败显示错误提示
 */
async function copyBubbleContent() {
  const text = copyableContent.value
  // 无可复制内容时直接返回
  if (!text) return
  // 调用剪贴板工具执行复制操作
  const ok = await copyToClipboard(text)
  if (ok) {
    // 复制成功，显示成功提示
    toast.success(t('chat.copiedBubble'))
    return
  }
  // 复制失败，显示错误提示
  toast.error(t('chat.copyFailed'))
}

// ========== 思考内容（Reasoning）相关 ==========

// 解析消息内容中的思考文本（<think> 标签）
// 支持流式传输模式：当 isStreaming 为 true 时，允许未闭合的 <think> 标签
const parsedThinking = computed(() =>
  parseThinking(props.message.content || "", { streaming: !!props.message.isStreaming }),
);

// 判断消息是否包含 reasoning 字段（来自事件/API 的思考文本）
// 思考文本的来源有两种：
// 1. reasoning 字段：来自后端事件推送，实时性更好
// 2. <think> 标签：嵌入在 content 字段中，需要解析
// 优先使用 reasoning 字段；若两者共存则拼接展示
const hasReasoningField = computed(() => !!(props.message.reasoning && props.message.reasoning.length > 0));

// 判断消息是否包含思考内容（reasoning 字段或 <think> 标签任一存在即可）
const hasThinking = computed(() => hasReasoningField.value || parsedThinking.value.hasThinking);

// 完整的思考文本：合并 reasoning 字段和解析出的 <think> 标签内容
// 拼接顺序：reasoning 字段 → 解析出的思考片段 → 未闭合的思考内容（流式传输中）
const thinkingFullText = computed(() => {
  const parts: string[] = [];
  // 优先添加 reasoning 字段内容（来自事件推送的思考文本）
  if (props.message.reasoning) parts.push(props.message.reasoning);
  // 添加从 content 中解析出的思考片段（已闭合的 <think> 标签内容）
  parts.push(...parsedThinking.value.segments);
  // 添加尚未闭合的思考内容（流式传输过程中，<think> 标签尚未关闭）
  if (parsedThinking.value.pending) parts.push(parsedThinking.value.pending);
  // 用双换行符连接各部分，保证阅读体验
  return parts.join("\n\n");
});

// 思考内容的字符数统计：包含 reasoning 字段和解析出的 <think> 标签内容
const thinkingCharCount = computed(() => {
  // 统计从 content 中解析出的思考字符数
  let count = countThinkingChars(parsedThinking.value);
  // 加上 reasoning 字段的字符数
  if (props.message.reasoning) count += props.message.reasoning.length;
  return count;
});

// 判断是否处于流式思考状态：
// 条件1：消息正在流式传输
// 条件2：存在未闭合的 <think> 标签，或 reasoning 有内容但正文尚未开始
const thinkingStreamingNow = computed(() => {
  // 非流式消息直接返回 false
  if (!props.message.isStreaming) return false;
  // 存在未闭合的 <think> 标签（流式传输中）
  if (parsedThinking.value.pending !== null) return true;
  // reasoning 有内容但正文为空（表示正在思考，尚未生成回复正文）
  if (hasReasoningField.value && !props.message.content) return true;
  return false;
});

// 思考内容展开状态的手动覆盖值（null 表示使用全局设置，用户点击后设置为 true/false）
const thinkingOverride = ref<boolean | null>(null);

// 思考内容的展开状态：
// 优先级：流式思考强制展开 > 手动覆盖值 > 全局设置
const thinkingExpanded = computed(() => {
  // 流式思考时强制展开（用户需要实时看到思考过程）
  if (thinkingStreamingNow.value) return true;
  // 优先使用手动覆盖值（用户手动点击展开/收起）
  if (thinkingOverride.value !== null) return thinkingOverride.value;
  // 默认使用全局设置（用户在设置中配置是否默认展开思考内容）
  return !!settingsStore.display.show_reasoning;
});

/**
 * 切换思考内容的展开/收起状态
 * 通过设置 thinkingOverride 覆盖全局设置
 */
function toggleThinking() {
  thinkingOverride.value = !thinkingExpanded.value;
}

// ========== 思考时间计时器相关 ==========

// 当前时间戳（用于计算流式思考的持续时间，每秒更新）
const nowTick = ref(Date.now());
// 定时器引用（每秒更新一次时间戳，用于实时计算思考持续时间）
let tickTimer: number | null = null;

/**
 * 确保思考时间计时器正确运行
 * 当消息处于流式状态且思考正在进行时，启动每秒计时器；否则停止计时器
 */
function ensureTick() {
  // 获取思考观测数据（包含思考开始时间和结束时间）
  const ob = chatStore.getThinkingObservation(props.message.id);
  // 判断是否需要计时：消息正在流式传输、有思考开始时间、无思考结束时间（思考进行中）
  const shouldTick = !!(
    props.message.isStreaming &&
    ob?.startedAt !== undefined &&
    ob.endedAt === undefined
  );
  // 需要计时且计时器未启动时，启动每秒计时器更新当前时间戳
  if (shouldTick && tickTimer === null) {
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
  } else if (!shouldTick && tickTimer !== null) {
    // 不需要计时且计时器正在运行时，停止计时器以节省资源
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

// 监听依赖变化，自动调整计时器状态
// 当消息的流式状态或思考观测数据变化时，自动启动或停止计时器
watchEffect(ensureTick);

// 组件卸载时清理计时器，防止内存泄漏
onBeforeUnmount(() => {
  if (tickTimer !== null) window.clearInterval(tickTimer);
});

// 思考持续时间（毫秒）：从思考开始时间到结束时间（或当前时间，如果仍在流式传输）
const thinkingDurationMs = computed<number | null>(() => {
  const ob = chatStore.getThinkingObservation(props.message.id);
  // 无思考开始时间时返回 null
  if (!ob?.startedAt) return null;
  const startedAt = ob.startedAt!;
  // 结束时间优先级：
  // 1. 观测数据中的结束时间（思考已完成）
  // 2. 当前时间（流式传输中，思考进行中）
  // 3. 开始时间（非流式消息，无结束时间记录）
  const end = ob?.endedAt ?? (props.message.isStreaming ? nowTick.value : startedAt);
  return Math.max(0, end - startedAt);
});

/**
 * 将毫秒数格式化为人类可读的时间字符串
 * 支持格式：
 * - 小于 60 秒：Xs（如 5s）
 * - 大于等于 60 秒：Xm（如 2m）或 Xm Ys（如 2m 30s）
 * @param ms 毫秒数
 * @returns 格式化后的时间字符串
 */
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  // 小于 60 秒，直接显示秒数
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  // 大于等于 60 秒，显示分钟数，若有余数则同时显示秒数
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

// ========== 时间显示相关 ==========

// 消息发送时间字符串（格式：HH:MM，使用浏览器本地时间）
const timeStr = computed(() => {
  const d = new Date(props.message.timestamp);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

// ========== 附件处理相关 ==========

/**
 * 判断文件类型是否为图片
 * 通过检查 MIME 类型是否以 "image/" 开头来判断
 * @param type MIME 类型（如 image/png、image/jpeg）
 * @returns 是否为图片类型
 */
function isImage(type: string): boolean {
  return type.startsWith("image/");
}

/**
 * 将字节数格式化为人类可读的文件大小
 * 支持单位：
 * - 小于 1 KB：B（如 100 B）
 * - 1 KB ~ 1 MB：KB（如 2.5 KB）
 * - 大于等于 1 MB：MB（如 1.2 MB）
 * @param bytes 字节数
 * @returns 格式化后的文件大小字符串
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * 从消息内容中提取附件的上传文件路径
 * 支持两种格式：
 * 1. ContentBlock[] 格式：[{"type": "file", "name": "...", "path": "..."}]
 * 2. Markdown 格式：[File: name.txt](/tmp/hermes-uploads/abc123.txt)
 * 
 * @param attName 附件名称（用于匹配）
 * @returns 文件路径，找不到返回 null
 */
function getFilePathFromContent(attName: string): string | null {
  const content = props.message.content || "";

  // 优先尝试 ContentBlock[] 格式（现代多模态消息格式）
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]) {
      // 在数组中查找名称匹配的文件块
      const fileBlock = parsed.find((block: any) =>
        block.type === 'file' && block.name === attName
      );
      if (fileBlock && (fileBlock as any).path) {
        return (fileBlock as any).path;
      }
    }
  } catch {
    // 不是有效 JSON，继续尝试正则匹配（旧格式）
  }

  // 回退到 Markdown 格式：[File: name](path)
  const regex = /\[File:\s*([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    // 匹配附件名称，返回对应的文件路径
    if (match[1].trim() === attName.trim()) return match[2];
  }

  return null;
}

/**
 * 处理附件下载
 * 支持两种下载方式：
 * 1. 通过后端 API 下载（需要文件路径）
 * 2. 直接创建下载链接（blob URL）
 * 
 * @param att 附件对象（包含名称、URL、类型）
 */
function handleAttachmentDownload(att: { name: string; url: string; type: string }) {
  // 尝试从消息内容中提取文件路径（用于后端下载）
  const filePath = getFilePathFromContent(att.name);
  if (filePath) {
    // 通过后端 API 下载，显示下载中提示
    toast.info(t("download.downloading"));
    downloadFile(filePath, att.name).catch((err: Error) => {
      // 下载失败显示错误提示
      toast.error(err.message || t("download.downloadFailed"));
    });
    return;
  }
  // 如果是 blob URL（前端生成的临时 URL），直接创建下载链接
  if (att.url && att.url.startsWith("blob:")) {
    const a = document.createElement("a");
    a.href = att.url;
    a.download = att.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

// ========== 工具调用负载处理相关 ==========

// 工具调用负载类型定义：包含完整内容和显示内容
// 用于处理工具调用的参数和结果展示
type ToolPayload = {
  full: string;       // 完整的原始内容（用于复制功能，不截断）
  display: string;    // 格式化后的显示内容（可能被截断，用于 UI 展示）
  language?: string;  // 内容语言类型（如 json、diff，用于代码高亮）
};

/**
 * 截断过长的字符串
 * 超过 JSON_STRING_DISPLAY_LIMIT 长度的字符串会被截断并添加标记
 * @param value 原始字符串
 * @param marker 截断标记文本（如 "[截断]"）
 * @returns 截断后的字符串
 */
function truncateLongString(value: string, marker: string): string {
  return value.length > JSON_STRING_DISPLAY_LIMIT
    ? value.slice(0, JSON_STRING_DISPLAY_LIMIT) + "\n" + marker
    : value;
}

/**
 * 递归截断 JSON 值，防止过大的 JSON 影响渲染性能
 * 支持多种限制策略：
 * - 节点数量限制（JSON_MAX_NODES）
 * - 嵌套深度限制（JSON_MAX_DEPTH）
 * - 数组元素数量限制（JSON_MAX_ITEMS_PER_ARRAY）
 * - 对象键数量限制（JSON_MAX_KEYS_PER_OBJECT）
 * - 字符串长度限制（JSON_STRING_DISPLAY_LIMIT）
 * - 总显示长度限制（TOOL_PAYLOAD_DISPLAY_LIMIT）
 * 
 * @param value 原始 JSON 值（可以是任意类型）
 * @param marker 截断标记文本（如 "[截断]"）
 * @returns 截断后的 JSON 值
 */
function truncateJsonValue(value: unknown, marker: string): unknown {
  let nodeCount = 0;                     // 节点计数器（用于限制总节点数）
  const seen = new WeakSet<object>();    // 用于检测循环引用（防止无限递归）

  // 辅助函数：计算对象序列化后的字符长度
  function stringifyLength(candidate: unknown): number {
    return JSON.stringify(candidate, null, 2).length;
  }

  // 递归访问函数：遍历 JSON 结构并应用截断规则
  function visit(current: unknown, depth: number): unknown {
    nodeCount += 1;
    // 超过最大节点数，返回截断标记
    if (nodeCount > JSON_MAX_NODES) {
      return marker;
    }

    // 字符串类型：应用字符串长度限制
    if (typeof current === "string") return truncateLongString(current, marker);
    // 原始类型（number、boolean、null）：直接返回，无需处理
    if (current === null || typeof current !== "object") return current;

    // 检测循环引用：如果已访问过该对象，返回循环引用标记
    if (seen.has(current)) return `[Circular ${marker}]`;
    // 超过最大嵌套深度限制
    if (depth >= JSON_MAX_DEPTH) {
      return Array.isArray(current) ? `[Array ${marker}]` : `[Object ${marker}]`;
    }

    seen.add(current);  // 标记当前对象已访问

    // 处理数组类型
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      // 限制数组最大元素数量
      const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY);
      for (let i = 0; i < maxItems; i += 1) {
        const remaining = current.length - i;
        result.push(visit(current[i], depth + 1));
        // 实时检查序列化后的长度，超过限制则截断
        if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
          result.pop();
          result.push(`${marker}: ${remaining} more items`);
          seen.delete(current);
          return result;
        }
      }
      // 数组元素超过最大限制，添加提示
      if (current.length > maxItems) {
        result.push(`${marker}: ${current.length - maxItems} more items`);
      }
      seen.delete(current);
      return result;
    }

    // 处理对象类型
    const entries = Object.entries(current as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    // 限制对象最大键数量
    const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT);
    for (let i = 0; i < maxKeys; i += 1) {
      const [key, val] = entries[i];
      const remaining = entries.length - i;
      result[key] = visit(val, depth + 1);
      // 实时检查序列化后的长度，超过限制则截断
      if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
        delete result[key];
        result[JSON_TRUNCATED_KEY] = `${marker}: ${remaining} more keys`;
        seen.delete(current);
        return result;
      }
    }
    // 对象键超过最大限制，添加提示
    if (entries.length > maxKeys) {
      result[JSON_TRUNCATED_KEY] = `${marker}: ${entries.length - maxKeys} more keys`;
    }
    seen.delete(current);
    return result;
  }

  // 执行递归截断
  const truncated = visit(value, 0);
  // 最终检查：如果整个结果仍超过限制，返回简单标记
  if (stringifyLength(truncated) <= TOOL_PAYLOAD_DISPLAY_LIMIT) return truncated;
  return { [JSON_TRUNCATED_KEY]: marker };
}

/**
 * 将工具调用负载标准化为字符串
 * 处理各种类型的原始负载值，统一转换为字符串格式
 * 
 * @param raw 原始负载值（可以是任意类型：string、object、null、undefined 等）
 * @returns 标准化后的字符串，空值返回空字符串
 */
function normalizeToolPayload(raw: unknown): string {
  // 空值处理：null、undefined、空字符串都返回空字符串
  if (raw === null || raw === undefined || raw === "") return "";
  // 字符串类型：直接返回
  if (typeof raw === "string") return raw;
  try {
    // 尝试 JSON 序列化（对象类型）
    const serialized = JSON.stringify(raw);
    if (serialized !== undefined) return serialized;
  } catch {
    // 非可序列化对象（如函数、Symbol），回退到 String()
  }
  // 回退方案：使用 String() 转换
  return String(raw);
}

/**
 * 格式化工具调用负载，处理 JSON、diff 和普通文本
 * 根据负载内容自动推断格式，并应用适当的格式化和截断策略
 * 
 * @param raw 原始负载值（工具调用的参数或结果）
 * @param extractDiff 是否提取 diff 格式内容（用于工具结果展示）
 * @returns 格式化后的 ToolPayload 对象（包含完整内容、显示内容和语言类型）
 */
function formatToolPayload(raw?: unknown, extractDiff = false): ToolPayload {
  const text = normalizeToolPayload(raw);
  // 空内容直接返回空对象
  if (!text) {
    return { full: "", display: "" };
  }

  // 判断是否应该解析为 JSON：
  // - 原始值不是字符串类型（说明已经是对象）
  // - 字符串以 [ 或 { 开头（符合 JSON 格式特征）
  const shouldParseJson = typeof raw !== "string" || /^[\[{]/.test(text.trim());
  if (shouldParseJson) {
    try {
      const parsed = JSON.parse(text);
      const full = JSON.stringify(parsed, null, 2);
      // 如果需要提取 diff（工具结果），尝试从 JSON 中提取统一差异格式
      const extractedDiff = extractDiff ? extractUnifiedDiffPayload(parsed) : null;
      if (extractedDiff) {
        return {
          full,           // 完整的原始 JSON（用于复制）
          display: extractedDiff,  // 提取的 diff 内容（用于显示）
          language: "diff",        // 语言类型标记为 diff
        };
      }
      // 如果内容过长，应用截断处理；否则直接使用完整内容
      const display = full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
        ? JSON.stringify(truncateJsonValue(parsed, t("chat.truncated")), null, 2)
        : full;
      return {
        full,
        display,
        language: "json",  // 语言类型标记为 json
      };
    } catch {
      // JSON 解析失败，回退到普通文本渲染
    }
  }

  // 推断结构化语言类型（如 diff、json 等）
  const language = inferStructuredLanguage(text);
  return {
    full: text,  // 完整原始文本（用于复制）
    display:
      // diff 格式或长度不超过限制时直接显示，否则截断
      language === "diff" || text.length <= TOOL_PAYLOAD_DISPLAY_LIMIT
        ? text
        : text.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated"),
    language,  // 推断的语言类型
  };
}

/**
 * 渲染工具调用负载为高亮代码块 HTML
 * 调用代码高亮工具生成带语法高亮的代码块
 * 
 * @param content 负载内容（格式化后的文本）
 * @param language 语言类型（用于语法高亮）
 * @returns HTML 字符串（带语法高亮的代码块）
 */
function renderToolPayload(content: string, language?: string): string {
  return renderHighlightedCodeBlock(content, language, t("common.copy"), {
    maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,  // 高亮处理的最大长度
    formatDiffFoldLabel: (hiddenCount) => t("chat.unchangedLines", { count: hiddenCount }),  // diff 折叠标签格式化
  });
}

/**
 * 处理工具详情区域的点击事件
 * 支持复制工具参数和工具结果，以及代码块内的单行复制
 * 
 * @param event 鼠标事件
 */
async function handleToolDetailClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  // 非 HTMLElement 直接返回（如 SVG 元素）
  if (!(target instanceof HTMLElement)) return;

  // 查找带有 data-copy-code 属性的复制按钮
  const button = target.closest<HTMLElement>("[data-copy-code=\"true\"]");
  if (!button) return;

  event.preventDefault();

  // 获取复制源类型（tool-args 表示工具参数，tool-result 表示工具结果）
  const source = button.closest<HTMLElement>("[data-copy-source]")?.dataset.copySource;
  // 复制工具参数（点击参数区域的复制按钮）
  if (source === "tool-args" && fullToolArgs.value) {
    const ok = await copyTextToClipboard(fullToolArgs.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }
  // 复制工具结果（点击结果区域的复制按钮）
  if (source === "tool-result" && fullToolResult.value) {
    const ok = await copyTextToClipboard(fullToolResult.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }

  // 默认处理：代码块内的单行复制（由 highlight 模块处理）
  const copyResult = await handleCodeBlockCopyClick(event);
  if (copyResult) toast.success(t("common.copied"));
  else if (copyResult === false) toast.error(t("chat.copyFailed"));
}

// ========== 工具调用详情计算属性 ==========

// 判断消息是否包含附件（attachments 数组长度大于 0）
const hasAttachments = computed(
  () => (props.message.attachments?.length ?? 0) > 0,
);

// 工具调用参数的格式化负载：将 toolArgs 格式化为 ToolPayload 对象
const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs));

// 工具调用结果的格式化负载：将 toolResult 格式化为 ToolPayload 对象（开启 diff 提取）
// 工具结果可能包含 diff 格式的内容，需要特殊处理
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult, true));

// 判断是否有工具调用详情（参数或结果任一非空）
// 用于控制工具调用详情的展开/收起按钮显示
const hasToolDetails = computed(
  () => !!(toolArgsPayload.value.full || toolResultPayload.value.full),
);

// 完整的工具参数内容（用于复制功能，不截断）
const fullToolArgs = computed(() => toolArgsPayload.value.full);

// 格式化后的工具参数（用于 UI 显示，可能被截断）
const formattedToolArgs = computed(() => toolArgsPayload.value.display);

// 完整的工具结果内容（用于复制功能，不截断）
const fullToolResult = computed(() => toolResultPayload.value.full);

// 格式化后的工具结果（用于 UI 显示，可能被截断）
const formattedToolResult = computed(() => toolResultPayload.value.display);

// 渲染后的工具参数（带语法高亮的代码块 HTML）
const renderedToolArgs = computed(() => {
  if (!formattedToolArgs.value) return "";
  return renderToolPayload(
    formattedToolArgs.value,
    toolArgsPayload.value.language,
  );
});

// 渲染后的工具结果（带语法高亮的代码块 HTML）
const renderedToolResult = computed(() => {
  if (!formattedToolResult.value) return "";
  return renderToolPayload(
    formattedToolResult.value,
    toolResultPayload.value.language,
  );
});

// ========== 语音播放相关逻辑 ==========

/**
 * 判断当前消息是否可以播放语音
 * 播放条件：
 * 1. 消息角色必须是 assistant（只有助手回复可以播放）
 * 2. 消息内容必须可复制（非空且非工具调用消息）
 * 3. TTS 服务必须可用：
 *    - OpenAI / Custom / Edge / MiMo：不依赖浏览器，直接返回 true
 *    - Web Speech API：需要检查浏览器支持
 */
const canPlaySpeech = computed(() => {
  // 只有 assistant 消息可以播放语音（用户消息、系统消息等不支持）
  if (props.message.role !== 'assistant') return false
  // 无内容或内容为空则无法播放
  if (!copyableContent.value) return false
  // 第三方 TTS 服务（OpenAI / Custom / Edge / MiMo）不依赖浏览器 Web Speech API
  const thirdPartyProviders = ['openai', 'custom', 'edge', 'mimo'] as const
  if (thirdPartyProviders.includes(voiceSettings.provider.value)) return true
  // Web Speech API 模式需要检查浏览器是否支持
  return speech.isSupported
})

/**
 * 判断当前消息是否正在播放语音
 * 根据配置的 TTS 提供商，使用不同的播放状态判断逻辑：
 * - 第三方服务（OpenAI/Custom/Edge/MiMo）：使用 custom 状态
 * - Web Speech API：使用标准状态
 */
const isPlayingThisMessage = computed(() => {
  // 第三方 TTS 服务模式：检查自定义播放状态
  const thirdPartyProviders = ['openai', 'custom', 'edge', 'mimo'] as const
  if (thirdPartyProviders.includes(voiceSettings.provider.value)) {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPlaying.value
  }
  // Web Speech API 模式：检查标准播放状态
  return speech.currentMessageId.value === props.message.id && speech.isPlaying.value
})

/**
 * 判断当前消息是否处于暂停状态
 * 根据配置的 TTS 提供商，使用不同的暂停状态判断逻辑：
 * - 第三方服务（OpenAI/Custom/Edge/MiMo）：使用 custom 暂停状态
 * - Web Speech API：使用标准暂停状态
 */
const isPausedThisMessage = computed(() => {
  // 第三方 TTS 服务模式：检查自定义暂停状态
  const thirdPartyProviders = ['openai', 'custom', 'edge', 'mimo'] as const
  if (thirdPartyProviders.includes(voiceSettings.provider.value)) {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPaused.value
  }
  // Web Speech API 模式：检查标准暂停状态
  return speech.currentMessageId.value === props.message.id && speech.isPaused.value
})

/**
 * 切换语音播放状态（播放/暂停）
 * 根据当前配置的 TTS 服务提供商，调用对应的播放/暂停方法
 * 支持的 TTS 服务：
 * - OpenAI TTS：使用 OpenAI API
 * - Custom：自定义 OpenAI 兼容端点（如 GPT-SoVITS）
 * - Edge TTS：使用 Microsoft Edge TTS 服务
 * - MiMo TTS：使用 MiMo 语音服务
 * - Web Speech API：浏览器原生语音合成
 */
function handleSpeechToggle() {
  // 无法播放时直接返回（如消息不是 assistant、无内容、TTS 不可用）
  if (!canPlaySpeech.value) {
    return
  }
  const content = props.message.content || ''

  // OpenAI TTS 模式：使用 OpenAI API 生成语音
  if (voiceSettings.provider.value === 'openai') {
    const apiUrl = voiceSettings.openaiBaseUrl.value
    if (!apiUrl) {
      console.warn('[MessageItem] OpenAI TTS 地址为空')
      return
    }
    speech.openaiToggle(props.message.id, content, {
      provider: 'openai',
      baseUrl: voiceSettings.openaiBaseUrl.value,
      apiKey: voiceSettings.openaiApiKey.value,
      model: voiceSettings.openaiModel.value,
      voice: voiceSettings.openaiVoice.value,
    })
    return
  }

  // 自定义端点模式（OpenAI 兼容）：支持 GPT-SoVITS 等自定义语音服务
  if (voiceSettings.provider.value === 'custom') {
    const apiUrl = voiceSettings.customUrl.value
    if (!apiUrl) {
      console.warn('[MessageItem] 自定义 TTS 地址为空')
      return
    }
    speech.openaiToggle(props.message.id, content, {
      provider: 'custom',
      baseUrl: voiceSettings.customUrl.value,
      apiKey: voiceSettings.customApiKey.value || undefined,
    })
    return
  }

  // Edge TTS 模式：使用 Microsoft Edge TTS 服务
  if (voiceSettings.provider.value === 'edge') {
    // URL 为空时使用内建后端代理（避免浏览器 CORS 限制）
    const apiUrl = voiceSettings.edgeUrl.value || '/api/tts/proxy'
    speech.openaiToggle(props.message.id, content, {
      provider: 'edge',
      baseUrl: apiUrl,
      voice: voiceSettings.edgeVoice.value,
      rate: speedToEdgeRate(voiceSettings.edgeRate.value),    // 转换语速为 Edge 格式
      pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value), // 转换音调为 Edge 格式
    })
    return
  }

  // MiMo TTS 模式：使用 MiMo 语音服务（支持 voiceDesign、voiceClone 等高级功能）
  if (voiceSettings.provider.value === 'mimo') {
    const apiKey = voiceSettings.mimoApiKey.value
    speech.mimoToggle(props.message.id, content, {
      baseUrl: voiceSettings.mimoBaseUrl.value,
      apiKey: apiKey || undefined,
      authMode: voiceSettings.mimoAuthMode.value,
      model: voiceSettings.mimoModel.value,
      // 根据模型选择语音模式：voiceDesign / voiceClone / preset
      voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' 
        ? 'voiceDesign' 
        : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' 
          ? 'voiceClone' 
          : 'preset',
      voice: voiceSettings.mimoVoice.value,
      voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
      voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
      voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
      stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
    })
    return
  }

  // Web Speech API 模式：使用浏览器原生语音合成
  if (voiceSettings.provider.value === 'webspeech') {
    speech.toggleBrowser(props.message.id, content, {
      voiceName: voiceSettings.webspeechVoice.value || undefined,
    })
    return
  }

  // 后备：无 provider 匹配时使用默认播放方式
  speech.toggle(props.message.id, content)
}

// ========== 自动播放事件监听 ==========

/**
 * 自动播放事件处理器引用
 * 用于在组件卸载时清理事件监听，防止内存泄漏
 */
let autoPlayHandler: ((e: Event) => void) | null = null

/**
 * 处理自动播放 TTS 错误
 * 过滤正常中断（AbortError），仅记录真实错误
 * 
 * @param err 错误对象
 */
function handleAutoplayTtsError(err: unknown) {
  // AbortError 是正常中断（如用户手动停止播放），无需处理
  if (err instanceof Error && err.name === 'AbortError') return
  console.warn('[MessageItem] TTS autoplay failed:', err)
}

/**
 * 组件挂载时注册自动播放事件监听
 * 监听全局 'auto-play-speech' 事件，当收到当前消息的自动播放指令时执行播放
 * 
 * 自动播放触发场景：
 * - 用户启用了自动语音播放设置
 * - 助手完成回复后触发自动播报
 */
onMounted(() => {
  autoPlayHandler = (e: Event) => {
    // 将事件转换为 CustomEvent，获取消息 ID 和内容
    const customEvent = e as CustomEvent<{ messageId: string; content: string }>
    // 只处理当前消息的自动播放事件，且必须满足播放条件
    if (customEvent.detail.messageId === props.message.id && canPlaySpeech.value) {
      // 优先使用事件携带的内容（可能经过处理），否则使用消息原始内容
      const content = customEvent.detail.content || props.message.content || ''

      // 根据 TTS 提供商选择对应的自动播放方法
      // OpenAI TTS 模式
      if (voiceSettings.provider.value === 'openai') {
        const apiUrl = voiceSettings.openaiBaseUrl.value
        if (apiUrl) void speech.openaiPlay(props.message.id, content, {
          provider: 'openai',
          baseUrl: voiceSettings.openaiBaseUrl.value,
          apiKey: voiceSettings.openaiApiKey.value,
          model: voiceSettings.openaiModel.value,
          voice: voiceSettings.openaiVoice.value,
        }).catch(handleAutoplayTtsError)
      }
      // 自定义端点模式（OpenAI 兼容）
      else if (voiceSettings.provider.value === 'custom') {
        const apiUrl = voiceSettings.customUrl.value
        if (apiUrl) void speech.openaiPlay(props.message.id, content, {
          provider: 'custom',
          baseUrl: voiceSettings.customUrl.value,
          apiKey: voiceSettings.customApiKey.value || undefined,
        }).catch(handleAutoplayTtsError)
      }
      // Edge TTS 模式（使用后端代理）
      else if (voiceSettings.provider.value === 'edge') {
        void speech.openaiPlay(props.message.id, content, {
          provider: 'edge',
          baseUrl: '/api/tts/proxy',  // 自动播放使用后端代理
          voice: voiceSettings.edgeVoice.value,
          rate: speedToEdgeRate(voiceSettings.edgeRate.value),
          pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
        }).catch(handleAutoplayTtsError)
      }
      // MiMo TTS 模式
      else if (voiceSettings.provider.value === 'mimo') {
        const apiKey = voiceSettings.mimoApiKey.value
        void speech.mimoPlay(props.message.id, content, {
          baseUrl: voiceSettings.mimoBaseUrl.value,
          apiKey: apiKey || undefined,
          authMode: voiceSettings.mimoAuthMode.value,
          model: voiceSettings.mimoModel.value,
          voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' 
            ? 'voiceDesign' 
            : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' 
              ? 'voiceClone' 
              : 'preset',
          voice: voiceSettings.mimoVoice.value,
          voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
          voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
          voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
          stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
        }).catch(handleAutoplayTtsError)
      }
      // Web Speech API 模式：先提取可读文本再播放
      else if (voiceSettings.provider.value === 'webspeech') {
        // 提取可读文本（去除 Markdown 标记、代码块等）
        const text = speech.extractReadableText(content)
        if (text) {
          speech.stop(false)  // 停止当前播放（不触发队列）
          speech.speakViaBrowser(props.message.id, text, {
            voiceName: voiceSettings.webspeechVoice.value || undefined,
          })
        }
      }
      // 默认模式：将消息加入播放队列
      else {
        speech.enqueue(props.message.id, content)
      }
    }
  }
  // 注册全局自动播放事件监听
  window.addEventListener('auto-play-speech', autoPlayHandler)
})

/**
 * 组件卸载时清理事件监听并停止播放
 * 防止内存泄漏和播放残留
 */
onBeforeUnmount(() => {
  // 移除自动播放事件监听
  if (autoPlayHandler) {
    window.removeEventListener('auto-play-speech', autoPlayHandler)
    autoPlayHandler = null
  }
  // 如果当前消息正在播放，停止播放
  // 需要同时检查标准播放状态和自定义播放状态
  if (speech.currentMessageId.value === props.message.id || 
      speech.currentCustomMessageId.value === props.message.id) {
    speech.stop();
  }
});
</script>

<template>
  <!-- 消息主容器：根据消息角色和高亮状态添加样式类 -->
  <div
    class="message"
    :class="[message.role, { highlight }]"
    :id="`message-${message.id}`"
  >
    <!-- ========== 工具调用消息渲染 ========== -->
    <!-- 工具消息与普通消息采用不同的渲染结构 -->
    <template v-if="message.role === 'tool'">
      <!-- 工具调用摘要行：显示工具名称、预览和状态，可点击展开详情 -->
      <div
        class="tool-line"
        :class="{ expandable: hasToolDetails }"
        @click="hasToolDetails && (toolExpanded = !toolExpanded)"
      >
        <!-- 展开/收起箭头图标（有详情时显示） -->
        <svg
          v-if="hasToolDetails"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="tool-chevron"
          :class="{ rotated: toolExpanded }"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <!-- 工具图标（无详情时显示） -->
        <svg
          v-else
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="tool-icon"
        >
          <path
            d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
          />
        </svg>
        <!-- 工具名称 -->
        <span class="tool-name">{{ message.toolName }}</span>
        <!-- 工具调用预览（收起时显示） -->
        <span
          v-if="message.toolPreview && !toolExpanded"
          class="tool-preview"
          >{{ message.toolPreview }}</span
        >
        <!-- 运行状态指示器（running 时显示旋转动画） -->
        <span
          v-if="message.toolStatus === 'running'"
          class="tool-spinner"
        ></span>
        <!-- 错误状态标签（error 时显示红色错误标识） -->
        <span v-if="message.toolStatus === 'error'" class="tool-error-badge">{{
          t("chat.error")
        }}</span>
      </div>
      <!-- 工具调用详情区域（展开时显示） -->
      <div v-if="toolExpanded && hasToolDetails" class="tool-details" @click="handleToolDetailClick">
        <!-- 工具参数部分 -->
        <div v-if="formattedToolArgs" class="tool-detail-section" data-copy-source="tool-args">
          <div class="tool-detail-label">{{ t("chat.arguments") }}</div>
          <div class="tool-detail-code-block" v-html="renderedToolArgs"></div>
        </div>
        <!-- 工具结果部分 -->
        <div v-if="formattedToolResult" class="tool-detail-section" data-copy-source="tool-result">
          <div class="tool-detail-label">{{ t("chat.result") }}</div>
          <div class="tool-detail-code-block" v-html="renderedToolResult"></div>
        </div>
      </div>
    </template>

    <!-- ========== 非工具消息渲染（用户/助手/系统/命令） ========== -->
    <template v-else>
      <!-- 消息主体：包含头像和内容 -->
      <div class="msg-body">
        <!-- 助手头像（仅 assistant 消息显示） -->
        <ProfileAvatar
          v-if="message.role === 'assistant'"
          class="msg-avatar"
          :name="assistantProfileName"
          :avatar="assistantProfileAvatar"
          :size="40"
        />
        <!-- 消息内容区域 -->
        <div class="msg-content" :class="message.role">
          <!-- 消息气泡：根据消息类型添加不同样式 -->
          <div
            class="message-bubble"
            :class="{
              system: isSystem,              // 系统消息样式
              'agent-error': isAgentError,  // 代理错误样式
              command: isCommandMessage,    // 命令消息样式
              'command-error': isCommandError, // 命令错误样式
              'speech-playing': isPlayingThisMessage && !isPausedThisMessage, // 语音播放中样式
            }"
          >
            <!-- ========== 附件区域 ========== -->
            <!-- 显示消息中的文件附件（图片或普通文件） -->
            <div v-if="hasAttachments" class="msg-attachments">
              <div
                v-for="att in message.attachments"
                :key="att.id"
                class="msg-attachment"
                :class="{ image: isImage(att.type) }"
              >
                <!-- 图片附件：显示缩略图，点击可预览 -->
                <template v-if="isImage(att.type) && att.url">
                  <img
                    :src="att.url"
                    :alt="att.name"
                    class="msg-attachment-thumb"
                    @click="previewUrl = att.url"
                  />
                </template>
                <!-- 普通文件附件：显示文件名和大小，点击可下载 -->
                <template v-else>
                  <div class="msg-attachment-file" @click="handleAttachmentDownload(att)" style="cursor: pointer;" :title="t('download.downloadFile')">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span class="att-name">{{ att.name }}</span>
                    <span class="att-size">{{ formatSize(att.size) }}</span>
                    <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </div>
                </template>
              </div>
            </div>
            <!-- ========== 思考内容区域 ========== -->
            <!-- 显示助手的思考过程（</think> 标签内的内容） -->
            <div
              v-if="hasThinking"
              class="thinking-block"
              :class="{ expanded: thinkingExpanded }"
            >
              <!-- 思考内容标题栏：点击可展开/收起 -->
              <div class="thinking-header" @click="toggleThinking">
                <!-- 展开/收起箭头 -->
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="thinking-chevron"
                  :class="{ rotated: thinkingExpanded }"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <!-- 思考图标 -->
                <span class="thinking-icon">💭</span>
                <!-- 思考标签：流式传输中显示 "思考中"，否则显示 "思考" -->
                <span class="thinking-label">
                  {{
                    thinkingStreamingNow
                      ? t('chat.thinkingInProgress')
                      : t('chat.thinkingLabel')
                  }}
                </span>
                <!-- 思考时长（可选） -->
                <span v-if="thinkingDurationMs !== null && thinkingDurationMs > 0" class="thinking-meta">
                  · {{ t('chat.thinkingDuration', { duration: formatDuration(thinkingDurationMs) }) }}
                </span>
                <!-- 思考内容字符数 -->
                <span class="thinking-meta">
                  · {{ t('chat.thinkingChars', { count: thinkingCharCount }) }}
                </span>
              </div>
              <!-- 思考内容正文（展开时显示） -->
              <div v-if="thinkingExpanded" class="thinking-body">
                <MarkdownRenderer :content="thinkingFullText" />
              </div>
            </div>

            <!-- ========== 解析后的思考内容（直接显示） ========== -->
            <!-- 当思考内容在助手消息中且不需要单独展开时，直接渲染 -->
            <MarkdownRenderer
              v-if="parsedThinking.body && message.role === 'assistant'"
              :content="parsedThinking.body"
              :heading-id-prefix="effectiveHeadingIdPrefix"
            />

            <!-- ========== 用户消息内容渲染 ========== -->
            <template v-if="message.role === 'user'">
              <!-- ContentBlock[] 格式（多模态内容） -->
              <template v-if="isContentBlockArray">
                <!-- 用户消息中的文件附件（图片或普通文件） -->
                <div v-if="contentFiles && contentFiles.length > 0" class="msg-attachments">
                  <div
                    v-for="(file, idx) in contentFiles"
                    :key="idx"
                    class="msg-attachment"
                    :class="{ image: file.type === 'image' }"
                  >
                    <!-- 图片文件：显示预览图，点击可全屏预览 -->
                    <template v-if="file.type === 'image'">
                      <img
                        :src="getContentFileUrl(file)"
                        :alt="file.name"
                        class="msg-attachment-thumb"
                        @click="previewUrl = getContentFileUrl(file)"
                      />
                    </template>
                    <!-- 普通文件：显示文件名，点击可下载 -->
                    <template v-else>
                      <div
                        class="msg-attachment-file"
                        @click="file.path && downloadFile(file.path, file.name).catch(err => toast.error(err.message || t('download.downloadFailed')))"
                        style="cursor: pointer;"
                        :title="t('download.downloadFile')"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span class="att-name">{{ file.name }}</span>
                      </div>
                    </template>
                  </div>
                </div>
                <!-- 用户消息文本内容（Markdown 渲染） -->
                <MarkdownRenderer v-if="displayText" :content="displayText" />
              </template>
              <!-- 纯文本格式（普通用户消息） -->
              <MarkdownRenderer v-else-if="message.content" :content="message.content" />
            </template>

            <!-- ========== 助手消息内容渲染 ========== -->
            <!-- 当没有解析的思考内容时，直接渲染助手回复内容 -->
            <MarkdownRenderer
              v-if="message.role === 'assistant' && message.content && !parsedThinking.body"
              :content="message.content"
              :heading-id-prefix="effectiveHeadingIdPrefix"
            />

            <!-- ========== 系统消息内容渲染 ========== -->
            <MarkdownRenderer
              v-if="message.role === 'system' && message.content && !isCommandMessage"
              :content="message.content"
            />

            <!-- ========== 命令消息渲染 ========== -->
            <!-- 状态命令（/status）：显示键值对网格 -->
            <div v-if="isStatusCommand" class="command-result command-status">
              <span class="command-result-icon">/</span>
              <div class="command-status-grid">
                <span
                  v-for="item in statusItems"
                  :key="item.key"
                  class="command-status-item"
                >
                  <span class="command-status-key">{{ item.key }}</span>
                  <span class="command-status-value">{{ item.value }}</span>
                </span>
              </div>
            </div>
            <!-- 普通命令消息：显示命令执行结果 -->
            <div v-else-if="isCommandMessage && message.content" class="command-result">
              <span class="command-result-icon">/</span>
              <MarkdownRenderer :content="message.content" />
            </div>

            <!-- ========== 流式传输指示器 ========== -->
            <!-- 当消息正在流式传输且无内容时，显示加载动画 -->
            <span v-if="message.isStreaming && !message.content" class="streaming-dots">
              <span></span><span></span><span></span>
            </span>
          </div>

          <!-- ========== 消息操作栏（语音播放/复制/时间） ========== -->
          <div class="message-meta">
            <!-- 语音播放按钮（仅 assistant 消息且支持播放时显示） -->
            <button
              v-if="canPlaySpeech"
              class="speech-bubble-btn"
              :class="{ playing: isPlayingThisMessage, paused: isPausedThisMessage }"
              @click="handleSpeechToggle"
              :title="isPlayingThisMessage ? (isPausedThisMessage ? t('chat.resumeSpeech') : t('chat.pauseSpeech')) : t('chat.playSpeech')"
            >
              <!-- 播放图标（未播放或暂停时显示） -->
              <svg v-if="!isPlayingThisMessage || isPausedThisMessage" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <!-- 暂停图标（播放中显示） -->
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            </button>
            <!-- 复制按钮（有可复制内容时显示） -->
            <button
              v-if="copyableContent"
              class="copy-bubble-btn"
              @click="copyBubbleContent"
              :title="t('chat.copyBubble')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <!-- 消息时间戳 -->
            <span class="message-time">{{ timeStr }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>

  <!-- ========== 图片预览弹窗（Teleport 到 body） ========== -->
  <!-- 使用 Teleport 将预览弹窗渲染到 body，避免层级问题 -->
  <Teleport to="body">
    <div v-if="previewUrl" class="image-preview-overlay" @click.self="previewUrl = null">
      <img :src="previewUrl" class="image-preview-img" @click="previewUrl = null" />
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

// ========== 消息主容器样式 ==========
.message {
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
  max-width: 100%;

  // 用户消息：右对齐，浅蓝色背景
  &.user {
    align-items: flex-end;

    .msg-body {
      max-width: 75%;
      position: relative;
      z-index: 1;
    }

    .msg-content.user {
      align-items: flex-end;
    }

    .message-bubble {
      background-color: $msg-user-bg;
      border-radius: 10px;
    }
  }

  // 助手消息：左对齐，白色背景，带头像
  &.assistant {
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;

    .msg-body {
      max-width: 80%;
      position: relative;
      z-index: 1;
    }

    .msg-avatar {
      width: 40px;
      height: 40px;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .message-bubble {
      background-color: $msg-assistant-bg;
      border-radius: 10px;
    }

    // 代理错误状态：红色文字和边框
    .message-bubble.agent-error {
      color: $error;
      background-color: rgba(var(--error-rgb), 0.06);
      border: 1px solid rgba(var(--error-rgb), 0.2);
    }
  }

  // 工具消息：左对齐
  &.tool {
    align-items: flex-start;
  }

  // 系统消息：左对齐
  &.system {
    align-items: flex-start;
  }

  // 命令消息：左对齐
  &.command {
    align-items: flex-start;
  }

  // 高亮状态：选中消息时的边框效果
  &.highlight {
    .message-bubble {
      box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.45);
    }
  }
}

// 渐变流动动画（未使用）
@keyframes gradient-flow {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

// ========== 消息主体布局样式 ==========
.msg-body {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 85%;
  min-width: 0;
  box-sizing: border-box;
}

.msg-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

// ========== 消息气泡样式 ==========
.message-bubble {
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
  overflow-wrap: anywhere;
  border-radius: 10px;
  max-width: 100%;
  min-width: 0;
  position: relative;
  box-sizing: border-box;

  // 系统消息：黄色左侧边框，淡背景
  &.system {
    border-left: 3px solid $warning;
    border-radius: $radius-sm;
    max-width: 80%;
    background-color: rgba(var(--warning-rgb), 0.06);
  }

  // 命令消息：淡蓝色边框，浅色背景
  &.command {
    border-left: none;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.12);
    background-color: rgba(var(--accent-primary-rgb), 0.04);
    color: $text-secondary;
    max-width: min(100%, 960px);
    padding: 8px 10px;
  }

  // 命令错误：黄色边框和背景
  &.command-error {
    border-color: rgba(var(--warning-rgb), 0.28);
    background-color: rgba(var(--warning-rgb), 0.06);
  }

  // 代理错误：红色文字和边框
  &.agent-error {
    color: $error;
    background-color: rgba(var(--error-rgb), 0.06);
    border: 1px solid rgba(var(--error-rgb), 0.2);

    :deep(.markdown-body),
    :deep(.markdown-body p),
    :deep(.markdown-body li),
    :deep(.markdown-body strong),
    :deep(.markdown-body code) {
      color: $error;
    }
  }

  // 语音播放中：彩虹发光效果
  &.speech-playing {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    animation: rainbow-glow 4s linear infinite;
  }
}

// ========== 命令消息结果样式 ==========
.command-result {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;

  :deep(.markdown-body) {
    min-width: 0;
  }

  :deep(.markdown-body p) {
    margin: 0;
  }
}

// 状态命令（/status）样式：居中对齐
.command-status {
  align-items: center;
}

// 状态命令网格：横向滚动
.command-status-grid {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
}

// 状态命令项：标签样式，圆角背景
.command-status-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.035);
  line-height: 1.4;
}

// 状态命令键名：灰色小字
.command-status-key {
  color: $text-muted;
  font-size: 11px;
}

// 状态命令值：主色等宽字体
.command-status-value {
  color: $text-primary;
  font-family: $font-code;
  font-size: 11px;
}

// 命令图标：圆形背景的 "/" 符号
.command-result-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
  font-family: $font-code;
  font-size: 12px;
  line-height: 1;
  margin-top: 2px;
}

// ========== 彩虹发光动画（语音播放时） ==========
@keyframes rainbow-glow {
  0% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
  }
  16.66% {
    box-shadow:
      0 0 0 2px #feca57,
      0 0 10px rgba(254, 202, 87, 0.4),
      0 0 20px rgba(254, 202, 87, 0.2);
  }
  33.33% {
    box-shadow:
      0 0 0 2px #48dbfb,
      0 0 10px rgba(72, 219, 251, 0.4),
      0 0 20px rgba(72, 219, 251, 0.2);
  }
  50% {
    box-shadow:
      0 0 0 2px #ff9ff3,
      0 0 10px rgba(255, 159, 243, 0.4),
      0 0 20px rgba(255, 159, 243, 0.2);
  }
  66.66% {
    box-shadow:
      0 0 0 2px #54a0ff,
      0 0 10px rgba(84, 160, 255, 0.4),
      0 0 20px rgba(84, 160, 255, 0.2);
  }
  83.33% {
    box-shadow:
      0 0 0 2px #5f27cd,
      0 0 10px rgba(95, 39, 205, 0.4),
      0 0 20px rgba(95, 39, 205, 0.2);
  }
  100% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
  }
}

// ========== 附件样式 ==========
.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.msg-attachment {
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: rgba(0, 0, 0, 0.04);
  border: 1px solid $border-light;

  // 图片附件：限制最大宽度
  &.image {
    max-width: 200px;
  }
}

// 图片附件缩略图
.msg-attachment-thumb {
  display: block;
  max-width: 200px;
  max-height: 160px;
  object-fit: contain;
  cursor: pointer;
}

// 普通文件附件：水平布局，显示文件名和大小
.msg-attachment-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: $text-secondary;

  .att-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  .att-size {
    color: $text-muted;
    font-size: 11px;
    flex-shrink: 0;
  }
}

// ========== 思考内容样式 ==========
.thinking-block {
  margin-bottom: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed $border-light;

  // 思考标题栏：可点击展开/收起
  .thinking-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: $text-muted;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: $radius-sm;
    user-select: none;

    &:hover {
      background: rgba(0, 0, 0, 0.03);
    }
  }

  // 展开/收起箭头
  .thinking-chevron {
    flex-shrink: 0;
    transition: transform 0.15s ease;

    &.rotated {
      transform: rotate(90deg);
    }
  }

  // 思考图标
  .thinking-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  // 思考标签
  .thinking-label {
    font-weight: 500;
    flex-shrink: 0;
  }

  // 思考元信息（时长、字符数）
  .thinking-meta {
    color: $text-muted;
    font-variant-numeric: tabular-nums;
  }

  // 思考内容正文：斜体，左侧边框
  .thinking-body {
    margin-top: 6px;
    padding: 6px 10px;
    border-left: 2px solid $border-light;
    font-size: 13px;
    opacity: 0.85;
    font-style: italic;

    :deep(p) { margin: 0.3em 0; }
  }
}

// ========== 消息操作栏样式（语音播放/复制/时间） ==========
.message-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
  opacity: 0;           // 默认隐藏
  transition: opacity 0.15s ease;

  // 鼠标悬停时显示
  .message:hover & {
    opacity: 1;
  }

  // 移动端一直显示按钮
  @media (max-width: 768px) {
    opacity: 1;
  }
}

// ========== 操作按钮样式（复制/语音播放） ==========
.copy-bubble-btn,
.speech-bubble-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  border-radius: $radius-sm;
  padding: 0;
  transition: color 0.15s ease, background 0.15s ease;

  &:hover {
    color: $text-secondary;
    background: rgba(0, 0, 0, 0.06);
  }

  // 暗色模式下的按钮样式
  .dark & {
    color: #999999;

    &:hover {
      color: #cccccc;
      background: rgba(255, 255, 255, 0.1);
    }
  }
}

// 语音播放按钮：播放时有脉冲动画
.speech-bubble-btn {
  &.playing {
    color: var(--accent-primary);
    animation: pulse 1.5s ease-in-out infinite;

    // 暂停状态：停止动画，降低透明度
    &.paused {
      animation: none;
      opacity: 0.6;
    }
  }
}

// 脉冲动画（语音播放状态）
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

// ========== 消息时间戳样式 ==========
.message-time {
  font-size: 11px;
  color: $text-muted;
  user-select: none;

  .dark & {
    color: #999999;
  }
}

// ========== 工具调用样式 ==========
// 工具调用摘要行
.tool-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: $text-muted;
  padding: 2px 4px;
  border-radius: $radius-sm;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;

  // 可展开状态：鼠标悬停显示背景
  &.expandable {
    cursor: pointer;

    &:hover {
      background: rgba(0, 0, 0, 0.03);
    }
  }

  // 工具名称：等宽字体，截断显示
  .tool-name {
    font-family: $font-code;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  // 工具预览：截断显示，最大宽度限制
  .tool-preview {
    display: block;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: min(400px, 100%);
  }
}

// 工具调用展开/收起箭头
.tool-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;

  &.rotated {
    transform: rotate(90deg);
  }
}

// 工具运行状态：旋转动画
.tool-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid $text-muted;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

// 工具错误标签：红色背景
.tool-error-badge {
  font-size: 9px;
  color: $error;
  background: rgba(var(--error-rgb), 0.08);
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
  margin-left: 4px;
}

// 工具调用详情区域：左侧边框缩进
.tool-details {
  margin-left: 16px;
  margin-top: 2px;
  border-left: 2px solid $border-light;
  padding-left: 10px;
}

// 工具详情分段
.tool-detail-section {
  margin-bottom: 6px;
}

// 工具详情标签：大写，小字
.tool-detail-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
}

// 工具详情代码块：调整高亮样式
.tool-detail-code-block {
  :deep(.hljs-code-block) {
    margin: 0;
  }

  :deep(.code-header) {
    background: rgba(0, 0, 0, 0.02);
  }

  :deep(code.hljs) {
    font-size: 11px;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  // diff 格式代码块：不限制高度，保持原始格式
  :deep(.hljs-unified-diff code.hljs) {
    max-height: none;
    overflow-y: visible;
    white-space: pre;
    word-break: normal;
  }
}

// 旋转动画（工具运行状态）
@keyframes spin {
  to { transform: rotate(360deg); }
}

// ========== 流式传输样式 ==========
// 流式光标（未使用）
.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background-color: $text-muted;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 0.8s infinite;
}

// 流式传输指示器：三个跳动的圆点
.streaming-dots {
  display: flex;
  gap: 4px;
  padding: 4px 0;

  span {
    width: 6px;
    height: 6px;
    background-color: $text-muted;
    border-radius: 50%;
    animation: pulse 1.4s infinite ease-in-out;

    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
  }
}

// 闪烁动画（光标）
@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

// 脉冲动画（流式圆点）
@keyframes pulse {
  0%, 80%, 100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

// ========== 图片预览弹窗样式 ==========
.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.image-preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
}

// ========== 移动端响应式样式 ==========
@media (max-width: $breakpoint-mobile) {
  .message.user .msg-body {
    max-width: 100%;
  }

  .message.assistant .msg-body {
    max-width: 100%;
  }

  .message.system .msg-body {
    max-width: 100%;
  }
}
</style>
