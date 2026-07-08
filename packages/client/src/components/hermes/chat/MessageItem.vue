<script setup lang="ts">
import type { Message, ContentBlock } from "@/stores/hermes/chat";
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useMessage } from "naive-ui";
import { downloadFile, getDownloadUrl } from "@/api/hermes/download";
import { copyToClipboard } from "@/utils/clipboard";
import MarkdownRenderer from "./MarkdownRenderer.vue";
// 思考内容解析工具：parseThinking 解析 <think> 标签，countThinkingChars 统计思考字符数
import { parseThinking, countThinkingChars } from "@/utils/thinking-parser";
import { useChatStore } from "@/stores/hermes/chat";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { useSettingsStore } from "@/stores/hermes/settings";
import ProfileAvatar from "@/components/hermes/profiles/ProfileAvatar.vue";
// 代码高亮相关工具函数
import {
  copyTextToClipboard,           // 复制文本到剪贴板
  extractUnifiedDiffPayload,      // 从工具结果中提取统一差异格式
  handleCodeBlockCopyClick,       // 处理代码块复制点击事件
  inferStructuredLanguage,        // 推断结构化语言类型（如 JSON、diff）
  renderHighlightedCodeBlock,     // 渲染高亮代码块
} from "./highlight";
// 全局语音播放 composable
import { useGlobalSpeech } from "@/composables/useSpeech";
// 语音设置 composable
import { useVoiceSettings } from "@/composables/useVoiceSettings";
// TTS 工具函数：speedToEdgeRate 转换语速，hzToEdgePitch 转换音调
import { speedToEdgeRate, hzToEdgePitch } from "@/utils/ttsHelpers";

// 工具调用负载的最大显示长度（防止过长内容影响性能）
const TOOL_PAYLOAD_DISPLAY_LIMIT = 1000;
// JSON 字符串的最大显示长度（超过会截断）
const JSON_STRING_DISPLAY_LIMIT = 200;
// JSON 解析的最大嵌套深度（防止无限递归）
const JSON_MAX_DEPTH = 6;
// JSON 解析的最大节点数（防止性能问题）
const JSON_MAX_NODES = 1000;
// 单个 JSON 对象的最大键数量
const JSON_MAX_KEYS_PER_OBJECT = 50;
// 单个 JSON 数组的最大元素数量
const JSON_MAX_ITEMS_PER_ARRAY = 50;
// JSON 截断标记键名（用于标记被截断的内容）
const JSON_TRUNCATED_KEY = "__truncated__";

// 定义组件 Props：message 是必传的消息对象，highlight 用于标记高亮状态，headingIdPrefix 用于 Markdown 标题 ID 前缀
const props = defineProps<{ message: Message; highlight?: boolean; headingIdPrefix?: string }>();
// 初始化国际化工具函数
const { t } = useI18n();
// 初始化消息提示实例（用于显示复制成功/失败等提示）
const toast = useMessage();

// 判断是否为系统消息
const isSystem = computed(() => props.message.role === "system");
// 判断是否为助手错误消息（assistant 角色且 systemType 为 error）
const isAgentError = computed(() => props.message.role === "assistant" && props.message.systemType === "error");

// 有效标题 ID 前缀：优先使用传入的 headingIdPrefix，否则使用消息 ID 作为前缀
const effectiveHeadingIdPrefix = computed(() => props.headingIdPrefix || `msg-${props.message.id}`);
// 判断是否为命令消息（role 为 command 或 systemType 为 command）
const isCommandMessage = computed(() => props.message.role === "command" || props.message.systemType === "command");
// 判断是否为命令错误消息（command 角色且 systemType 为 error）
const isCommandError = computed(() => props.message.role === "command" && props.message.systemType === "error");
// 判断是否为状态命令消息（命令消息且 commandAction 为 status，且不是 goal 类型）
const isStatusCommand = computed(() =>
  isCommandMessage.value
  && props.message.commandAction === "status"
  && props.message.commandData?.type !== "goal"
);
// 状态命令消息的显示项列表：从 commandData 中提取状态、源、配置、模型、队列长度、运行 ID 等信息
const statusItems = computed(() => {
  const data = props.message.commandData || {};
  return [
    { key: "status", value: data.isWorking ? "running" : "idle" },  // 运行状态：running 或 idle
    { key: "source", value: data.source },                           // 消息来源
    { key: "profile", value: data.profile },                         // 当前使用的配置文件
    { key: "model", value: data.model || "-" },                      // 使用的模型名称
    { key: "queue", value: data.queueLength ?? 0 },                  // 队列长度
    { key: "run", value: data.runId || "-" },                        // 运行 ID
  ];
});

// 多模态内容文件类型定义：用于表示消息中的图片或文件附件
type DisplayContentFile = {
  type: 'image' | 'file'   // 文件类型：图片或普通文件
  name: string              // 文件名称
  path?: string             // 文件路径（用于后端下载）
  url?: string              // 文件 URL（用于前端直接显示）
}

/**
 * 从内容块中提取文本内容
 * @param block 内容块对象
 * @returns 提取的文本字符串，若无法提取则返回空字符串
 */
function getBlockText(block: any): string {
  // 校验块是否有效
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
  // 校验块是否有效
  if (!block || typeof block !== 'object') return null
  // 只处理图片类型的块（input_image 或 image_url）
  if (block.type !== 'input_image' && block.type !== 'image_url') return null
  const raw = block.image_url
  // 支持字符串格式的 URL
  if (typeof raw === 'string') return raw
  // 支持对象格式的 URL（如 { url: 'xxx' }）
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url
  return null
}

/**
 * 从 Data URL 中生成图片文件名
 * @param url Data URL（如 data:image/png;base64,...）
 * @param index 图片索引（用于生成唯一文件名）
 * @returns 生成的文件名（如 image-1.png）
 */
function imageNameFromDataUrl(url: string, index: number): string {
  // 从 Data URL 中提取图片类型
  const match = url.match(/^data:image\/([^;,]+)/i)
  // 处理 jpeg 格式（将 jpeg 转换为 jpg）
  const ext = match?.[1] === 'jpeg' ? 'jpg' : match?.[1] || 'png'
  return `image-${index + 1}.${ext}`
}

/**
 * 解析消息内容为 ContentBlock 数组
 * 支持标准 JSON 格式和 Hermes Agent 遗留的 Python 格式
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
    // 必须是数组且第一个元素包含 type 字段
    return Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]
      ? parsed as Array<ContentBlock | Record<string, unknown>>
      : null
  }

  // 首先尝试标准 JSON 解析
  try {
    return parse(trimmed)
  } catch {
    // Hermes Agent 曾使用 Python str(list) 格式存储多模态消息，
    // 例如：[{'type': 'text'}, {'type': 'image_url', ...}]
    // 需要将这种遗留格式转换为 JSON
    if (!trimmed.startsWith("[{'") && !trimmed.startsWith('[{"')) return null
    try {
      return parse(
        trimmed
          .replace(/\bNone\b/g, 'null')   // 将 Python None 转换为 JSON null
          .replace(/\bTrue\b/g, 'true')   // 将 Python True 转换为 JSON true
          .replace(/\bFalse\b/g, 'false') // 将 Python False 转换为 JSON false
          .replace(/'/g, '"'),            // 将单引号转换为双引号
      )
    } catch {
      return null
    }
  }
}

// 从 JSON 字符串中解析 ContentBlock[] 数组
const contentBlocks = computed(() => {
  const content = props.message.content || '';
  return parseContentBlocks(content);
});

// 判断消息内容是否为 ContentBlock[] 格式
const isContentBlockArray = computed(() => contentBlocks.value !== null);

// 从 ContentBlock[] 中提取文本内容用于显示
const displayText = computed(() => {
  // 如果不是 ContentBlock[] 格式，直接返回原始内容
  if (!isContentBlockArray.value) {
    return props.message.content || '';
  }

  // 遍历所有块，提取文本并拼接
  return contentBlocks.value!
    .map(block => getBlockText(block))  // 从每个块中提取文本
    .filter(Boolean)                     // 过滤空字符串
    .join('\n');                         // 用换行符连接
});

// 从 ContentBlock[] 中提取文件列表（图片和普通文件）
const contentFiles = computed<DisplayContentFile[] | null>(() => {
  if (!isContentBlockArray.value) return null;

  return contentBlocks.value!.flatMap<DisplayContentFile>((block, index) => {
    // 处理 image 类型块（后端存储的图片）
    if (block.type === 'image') {
      return [{
        type: 'image' as const,
        name: String((block as any).name || `image-${index + 1}`),
        path: String((block as any).path || ''),
      }].filter(file => file.path)  // 过滤无路径的文件
    }
    // 处理 file 类型块（后端存储的普通文件）
    if (block.type === 'file') {
      return [{
        type: 'file' as const,
        name: String((block as any).name || `file-${index + 1}`),
        path: String((block as any).path || ''),
      }].filter(file => file.path)  // 过滤无路径的文件
    }
    // 处理 data:image 格式的图片（前端直接嵌入的图片）
    const imageUrl = getImageUrlFromBlock(block)
    if (imageUrl?.startsWith('data:image/')) {
      return [{
        type: 'image' as const,
        name: imageNameFromDataUrl(imageUrl, index),
        url: imageUrl,
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
  // 如果已有 URL，直接返回
  if (file.url) return file.url
  // 如果有路径，生成下载 URL；否则返回空字符串
  return file.path ? getDownloadUrl(file.path, file.name) : ''
}

// 工具调用详情展开状态（用于控制工具调用参数和结果的显示/隐藏）
const toolExpanded = ref(false);
// 图片预览 URL（用于点击图片后全屏预览）
const previewUrl = ref<string | null>(null);

// 初始化各状态管理 Store
const chatStore = useChatStore();           // 聊天状态 Store
const profilesStore = useProfilesStore();   // 用户配置 Store
const settingsStore = useSettingsStore();   // 设置 Store
const speech = useGlobalSpeech();           // 全局语音播放
const voiceSettings = useVoiceSettings();   // 语音设置

// 助手配置文件名称：优先使用当前会话的配置，否则使用全局激活的配置，默认 "default"
const assistantProfileName = computed(() => chatStore.activeSession?.profile || profilesStore.activeProfileName || "default");
// 助手头像：从配置列表中查找对应配置的头像
const assistantProfileAvatar = computed(() => profilesStore.profiles.find(profile => profile.name === assistantProfileName.value)?.avatar);

// 可复制的消息内容（排除工具调用消息）
const copyableContent = computed(() => {
  // 工具调用消息不支持复制
  if (props.message.role === 'tool') return null
  const content = props.message.content || ''
  // 空内容不支持复制
  if (!content.trim()) return null
  return content
})

/**
 * 复制整个消息气泡内容到剪贴板
 */
async function copyBubbleContent() {
  const text = copyableContent.value
  // 无内容时直接返回
  if (!text) return
  // 调用剪贴板工具复制
  const ok = await copyToClipboard(text)
  if (ok) {
    toast.success(t('chat.copiedBubble'))
    return
  }
  toast.error(t('chat.copyFailed'))
}

// 解析消息内容中的思考文本（<think> 标签）
const parsedThinking = computed(() =>
  parseThinking(props.message.content || "", { streaming: !!props.message.isStreaming }),
);

// 判断消息是否包含 reasoning 字段（来自事件/API 的思考文本）
// 优先使用来自 reasoning 字段/事件的思考文本；否则回退到从 content 解析的 <think> 标签。
// 若两者共存，则拼接展示（罕见，但保持信息不丢）。
const hasReasoningField = computed(() => !!(props.message.reasoning && props.message.reasoning.length > 0));

// 判断消息是否包含思考内容（reasoning 字段或 <think> 标签）
const hasThinking = computed(() => hasReasoningField.value || parsedThinking.value.hasThinking);

// 完整的思考文本：合并 reasoning 字段和解析出的 <think> 标签内容
const thinkingFullText = computed(() => {
  const parts: string[] = [];
  // 优先添加 reasoning 字段内容
  if (props.message.reasoning) parts.push(props.message.reasoning);
  // 添加解析出的思考片段
  parts.push(...parsedThinking.value.segments);
  // 添加尚未闭合的思考内容（流式传输中）
  if (parsedThinking.value.pending) parts.push(parsedThinking.value.pending);
  // 用双换行连接各部分
  return parts.join("\n\n");
});

// 思考内容的字符数统计
const thinkingCharCount = computed(() => {
  // 统计解析出的思考字符数
  let count = countThinkingChars(parsedThinking.value);
  // 加上 reasoning 字段的字符数
  if (props.message.reasoning) count += props.message.reasoning.length;
  return count;
});

// 判断是否处于流式思考状态：仍有未闭合 <think> 标签，或 reasoning 有内容但正文尚未开始
const thinkingStreamingNow = computed(() => {
  // 非流式消息直接返回 false
  if (!props.message.isStreaming) return false;
  // 存在未闭合的 <think> 标签
  if (parsedThinking.value.pending !== null) return true;
  // reasoning 有内容但正文为空（思考中）
  if (hasReasoningField.value && !props.message.content) return true;
  return false;
});

// 思考内容展开状态的手动覆盖值（null 表示使用全局设置）
const thinkingOverride = ref<boolean | null>(null);

// 思考内容的展开状态：流式思考时强制展开，否则使用手动覆盖值或全局设置
const thinkingExpanded = computed(() => {
  // 流式思考时强制展开
  if (thinkingStreamingNow.value) return true;
  // 优先使用手动覆盖值
  if (thinkingOverride.value !== null) return thinkingOverride.value;
  // 默认使用全局设置
  return !!settingsStore.display.show_reasoning;
});

/**
 * 切换思考内容的展开/收起状态
 */
function toggleThinking() {
  thinkingOverride.value = !thinkingExpanded.value;
}

// 当前时间戳（用于计算流式思考的持续时间）
const nowTick = ref(Date.now());
// 定时器引用（每秒更新一次时间戳）
let tickTimer: number | null = null;

/**
 * 确保思考时间计时器正确运行
 * 当消息处于流式状态且思考正在进行时，启动每秒计时器；否则停止计时器
 */
function ensureTick() {
  // 获取思考观测数据（包含开始时间和结束时间）
  const ob = chatStore.getThinkingObservation(props.message.id);
  // 判断是否需要计时：消息正在流式传输、有开始时间、无结束时间（思考中）
  const shouldTick = !!(
    props.message.isStreaming &&
    ob?.startedAt !== undefined &&
    ob.endedAt === undefined
  );
  // 需要计时且计时器未启动时，启动每秒计时器
  if (shouldTick && tickTimer === null) {
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
  } else if (!shouldTick && tickTimer !== null) {
    // 不需要计时且计时器正在运行时，停止计时器
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

// 监听依赖变化，自动调整计时器状态
watchEffect(ensureTick);

// 组件卸载时清理计时器
onBeforeUnmount(() => {
  if (tickTimer !== null) window.clearInterval(tickTimer);
});

// 思考持续时间（毫秒）：从开始时间到结束时间（或当前时间，如果仍在流式传输）
const thinkingDurationMs = computed<number | null>(() => {
  const ob = chatStore.getThinkingObservation(props.message.id);
  // 无开始时间时返回 null
  if (!ob?.startedAt) return null;
  const startedAt = ob.startedAt!;
  // 结束时间：优先使用观测数据中的结束时间，流式传输中使用当前时间，否则使用开始时间
  const end = ob?.endedAt ?? (props.message.isStreaming ? nowTick.value : startedAt);
  return Math.max(0, end - startedAt);
});

/**
 * 将毫秒数格式化为人类可读的时间字符串（如 5s、2m 30s）
 * @param ms 毫秒数
 * @returns 格式化后的时间字符串
 */
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  // 小于 60 秒，显示为 Xs
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  // 大于等于 60 秒，显示为 Xm 或 Xm Ys
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

// 消息发送时间字符串（格式：HH:MM）
const timeStr = computed(() => {
  const d = new Date(props.message.timestamp);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

/**
 * 判断文件类型是否为图片
 * @param type MIME 类型
 * @returns 是否为图片类型
 */
function isImage(type: string): boolean {
  return type.startsWith("image/");
}

/**
 * 将字节数格式化为人类可读的文件大小（如 100 B、2.5 KB、1.2 MB）
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
 * @param attName 附件名称
 * @returns 文件路径，找不到返回 null
 */
function getFilePathFromContent(attName: string): string | null {
  const content = props.message.content || "";

  // 优先尝试 ContentBlock[] 格式
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]) {
      // 在数组中查找匹配的文件块
      const fileBlock = parsed.find((block: any) =>
        block.type === 'file' && block.name === attName
      );
      if (fileBlock && (fileBlock as any).path) {
        return (fileBlock as any).path;
      }
    }
  } catch {
    // 不是有效 JSON，继续尝试正则匹配
  }

  // 回退到 Markdown 格式：[File: name](path)
  const regex = /\[File:\s*([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    // 匹配附件名称，返回对应的路径
    if (match[1].trim() === attName.trim()) return match[2];
  }

  return null;
}

/**
 * 处理附件下载
 * 优先通过后端 API 下载；如果是 blob URL，则直接创建下载链接
 * @param att 附件对象（包含名称、URL、类型）
 */
function handleAttachmentDownload(att: { name: string; url: string; type: string }) {
  // 尝试从消息内容中提取文件路径
  const filePath = getFilePathFromContent(att.name);
  if (filePath) {
    // 通过后端 API 下载
    toast.info(t("download.downloading"));
    downloadFile(filePath, att.name).catch((err: Error) => {
      toast.error(err.message || t("download.downloadFailed"));
    });
    return;
  }
  // 如果是 blob URL，直接创建下载链接
  if (att.url && att.url.startsWith("blob:")) {
    const a = document.createElement("a");
    a.href = att.url;
    a.download = att.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

// 工具调用负载类型定义：包含完整内容和显示内容
type ToolPayload = {
  full: string;       // 完整的原始内容（用于复制）
  display: string;    // 格式化后的显示内容（可能被截断）
  language?: string;  // 内容语言类型（如 json、diff）
};

/**
 * 截断过长的字符串
 * @param value 原始字符串
 * @param marker 截断标记文本
 * @returns 截断后的字符串
 */
function truncateLongString(value: string, marker: string): string {
  return value.length > JSON_STRING_DISPLAY_LIMIT
    ? value.slice(0, JSON_STRING_DISPLAY_LIMIT) + "\n" + marker
    : value;
}

/**
 * 递归截断 JSON 值，防止过大的 JSON 影响性能
 * 支持：节点数量限制、嵌套深度限制、数组元素数量限制、对象键数量限制、字符串长度限制
 * @param value 原始 JSON 值
 * @param marker 截断标记文本
 * @returns 截断后的 JSON 值
 */
function truncateJsonValue(value: unknown, marker: string): unknown {
  let nodeCount = 0;                     // 节点计数器
  const seen = new WeakSet<object>();    // 用于检测循环引用

  // 计算对象序列化后的长度
  function stringifyLength(candidate: unknown): number {
    return JSON.stringify(candidate, null, 2).length;
  }

  // 递归访问函数
  function visit(current: unknown, depth: number): unknown {
    nodeCount += 1;
    // 超过最大节点数，返回截断标记
    if (nodeCount > JSON_MAX_NODES) {
      return marker;
    }

    // 字符串截断
    if (typeof current === "string") return truncateLongString(current, marker);
    // 原始类型直接返回
    if (current === null || typeof current !== "object") return current;

    // 检测循环引用
    if (seen.has(current)) return `[Circular ${marker}]`;
    // 超过最大深度限制
    if (depth >= JSON_MAX_DEPTH) {
      return Array.isArray(current) ? `[Array ${marker}]` : `[Object ${marker}]`;
    }

    seen.add(current);

    // 处理数组
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY);
      for (let i = 0; i < maxItems; i += 1) {
        const remaining = current.length - i;
        result.push(visit(current[i], depth + 1));
        // 超过显示长度限制，截断并添加提示
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

    // 处理对象
    const entries = Object.entries(current as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT);
    for (let i = 0; i < maxKeys; i += 1) {
      const [key, val] = entries[i];
      const remaining = entries.length - i;
      result[key] = visit(val, depth + 1);
      // 超过显示长度限制，截断并添加提示
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

  const truncated = visit(value, 0);
  // 最终检查：如果整个结果仍超过限制，返回简单标记
  if (stringifyLength(truncated) <= TOOL_PAYLOAD_DISPLAY_LIMIT) return truncated;
  return { [JSON_TRUNCATED_KEY]: marker };
}

/**
 * 将工具调用负载标准化为字符串
 * @param raw 原始负载值
 * @returns 标准化后的字符串
 */
function normalizeToolPayload(raw: unknown): string {
  // 空值处理
  if (raw === null || raw === undefined || raw === "") return "";
  // 字符串直接返回
  if (typeof raw === "string") return raw;
  try {
    // 尝试 JSON 序列化
    const serialized = JSON.stringify(raw);
    if (serialized !== undefined) return serialized;
  } catch {
    // 非可序列化对象，回退到 String()
  }
  return String(raw);
}

/**
 * 格式化工具调用负载，处理 JSON、diff 和普通文本
 * @param raw 原始负载值
 * @param extractDiff 是否提取 diff 格式内容
 * @returns 格式化后的 ToolPayload 对象
 */
function formatToolPayload(raw?: unknown, extractDiff = false): ToolPayload {
  const text = normalizeToolPayload(raw);
  // 空内容直接返回
  if (!text) {
    return { full: "", display: "" };
  }

  // 判断是否应该解析为 JSON（非字符串或以 [ 或 { 开头）
  const shouldParseJson = typeof raw !== "string" || /^[\[{]/.test(text.trim());
  if (shouldParseJson) {
    try {
      const parsed = JSON.parse(text);
      const full = JSON.stringify(parsed, null, 2);
      // 如果需要提取 diff，尝试从 JSON 中提取统一差异格式
      const extractedDiff = extractDiff ? extractUnifiedDiffPayload(parsed) : null;
      if (extractedDiff) {
        return {
          full,
          display: extractedDiff,
          language: "diff",
        };
      }
      // 如果内容过长，截断处理
      const display = full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
        ? JSON.stringify(truncateJsonValue(parsed, t("chat.truncated")), null, 2)
        : full;
      return {
        full,
        display,
        language: "json",
      };
    } catch {
      // 解析失败，回退到文本渲染
    }
  }

  // 推断结构化语言类型（如 diff）
  const language = inferStructuredLanguage(text);
  return {
    full: text,
    display:
      // diff 格式或长度不超过限制时直接显示，否则截断
      language === "diff" || text.length <= TOOL_PAYLOAD_DISPLAY_LIMIT
        ? text
        : text.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated"),
    language,
  };
}

/**
 * 渲染工具调用负载为高亮代码块
 * @param content 负载内容
 * @param language 语言类型
 * @returns HTML 字符串
 */
function renderToolPayload(content: string, language?: string): string {
  return renderHighlightedCodeBlock(content, language, t("common.copy"), {
    maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,
    formatDiffFoldLabel: (hiddenCount) => t("chat.unchangedLines", { count: hiddenCount }),
  });
}

/**
 * 处理工具详情区域的点击事件
 * 支持复制工具参数和工具结果
 * @param event 鼠标事件
 */
async function handleToolDetailClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  // 非 HTMLElement 直接返回
  if (!(target instanceof HTMLElement)) return;

  // 查找复制按钮
  const button = target.closest<HTMLElement>("[data-copy-code=\"true\"]");
  if (!button) return;

  event.preventDefault();

  // 获取复制源类型（tool-args 或 tool-result）
  const source = button.closest<HTMLElement>("[data-copy-source]")?.dataset.copySource;
  // 复制工具参数
  if (source === "tool-args" && fullToolArgs.value) {
    const ok = await copyTextToClipboard(fullToolArgs.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }
  // 复制工具结果
  if (source === "tool-result" && fullToolResult.value) {
    const ok = await copyTextToClipboard(fullToolResult.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }

  // 默认处理代码块复制
  const copyResult = await handleCodeBlockCopyClick(event);
  if (copyResult) toast.success(t("common.copied"));
  else if (copyResult === false) toast.error(t("chat.copyFailed"));
}

// 判断消息是否包含附件
const hasAttachments = computed(
  () => (props.message.attachments?.length ?? 0) > 0,
);

// 工具调用参数的格式化负载
const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs));
// 工具调用结果的格式化负载（开启 diff 提取）
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult, true));

// 判断是否有工具调用详情（参数或结果）
const hasToolDetails = computed(
  () => !!(toolArgsPayload.value.full || toolResultPayload.value.full),
);

// 完整的工具参数内容（用于复制）
const fullToolArgs = computed(() => toolArgsPayload.value.full);
// 格式化后的工具参数（用于显示）
const formattedToolArgs = computed(() => toolArgsPayload.value.display);
// 完整的工具结果内容（用于复制）
const fullToolResult = computed(() => toolResultPayload.value.full);
// 格式化后的工具结果（用于显示）
const formattedToolResult = computed(() => toolResultPayload.value.display);

// 渲染后的工具参数（高亮代码块）
const renderedToolArgs = computed(() => {
  if (!formattedToolArgs.value) return "";
  return renderToolPayload(
    formattedToolArgs.value,
    toolArgsPayload.value.language,
  );
});

// 渲染后的工具结果（高亮代码块）
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
 * 条件：
 * 1. 消息角色必须是 assistant
 * 2. 消息内容必须可复制
 * 3. TTS 服务必须可用（第三方服务或浏览器 Web Speech API）
 */
const canPlaySpeech = computed(() => {
  // 只有 assistant 消息可以播放
  if (props.message.role !== 'assistant') return false
  // 无内容则无法播放
  if (!copyableContent.value) return false
  // OpenAI / Custom / Edge / MiMo 不依赖浏览器 Web Speech API，直接返回 true
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') return true
  // Web Speech API 需要检查浏览器支持
  return speech.isSupported
})

/**
 * 判断当前消息是否正在播放语音
 * 区分第三方 TTS 服务和浏览器 Web Speech API 两种模式
 */
const isPlayingThisMessage = computed(() => {
  // OpenAI / Custom / Edge / MiMo 模式使用自定义播放状态
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPlaying.value
  }
  // Web Speech API 模式使用标准播放状态
  return speech.currentMessageId.value === props.message.id && speech.isPlaying.value
})

/**
 * 判断当前消息是否处于暂停状态
 * 区分第三方 TTS 服务和浏览器 Web Speech API 两种模式
 */
const isPausedThisMessage = computed(() => {
  // OpenAI / Custom / Edge / MiMo 模式使用自定义暂停状态
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPaused.value
  }
  // Web Speech API 模式使用标准暂停状态
  return speech.currentMessageId.value === props.message.id && speech.isPaused.value
})

/**
 * 切换语音播放状态（播放/暂停）
 * 根据当前配置的 TTS 服务提供商，调用对应的播放方法
 */
function handleSpeechToggle() {
  // 无法播放时直接返回
  if (!canPlaySpeech.value) {
    return
  }
  const content = props.message.content || ''

  // OpenAI TTS 模式
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

  // 自定义端点模式（OpenAI 兼容，如 GPT-SoVITS）
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

  // Edge TTS 模式
  if (voiceSettings.provider.value === 'edge') {
    // URL 为空时使用内建后端代理
    const apiUrl = voiceSettings.edgeUrl.value || '/api/tts/proxy'
    speech.openaiToggle(props.message.id, content, {
      provider: 'edge',
      baseUrl: apiUrl,
      voice: voiceSettings.edgeVoice.value,
      rate: speedToEdgeRate(voiceSettings.edgeRate.value),
      pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
    })
    return
  }

  // MiMo TTS 模式
  if (voiceSettings.provider.value === 'mimo') {
    const apiKey = voiceSettings.mimoApiKey.value
    speech.mimoToggle(props.message.id, content, {
      baseUrl: voiceSettings.mimoBaseUrl.value,
      apiKey: apiKey || undefined,
      authMode: voiceSettings.mimoAuthMode.value,
      model: voiceSettings.mimoModel.value,
      voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' : 'preset',
      voice: voiceSettings.mimoVoice.value,
      voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
      voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
      voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
      stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
    })
    return
  }

  // Web Speech API 模式（浏览器原生语音）
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

// 自动播放事件处理器引用
let autoPlayHandler: ((e: Event) => void) | null = null

/**
 * 处理自动播放 TTS 错误
 * @param err 错误对象
 */
function handleAutoplayTtsError(err: unknown) {
  // AbortError 是正常中断，无需处理
  if (err instanceof Error && err.name === 'AbortError') return
  console.warn('[MessageItem] TTS autoplay failed:', err)
}

// 组件挂载时注册自动播放事件监听
onMounted(() => {
  autoPlayHandler = (e: Event) => {
    const customEvent = e as CustomEvent<{ messageId: string; content: string }>
    // 只处理当前消息的自动播放事件
    if (customEvent.detail.messageId === props.message.id && canPlaySpeech.value) {
      const content = customEvent.detail.content || props.message.content || ''
      // 根据 TTS 提供商选择对应的播放方法
      if (voiceSettings.provider.value === 'openai') {
        const apiUrl = voiceSettings.openaiBaseUrl.value
        if (apiUrl) void speech.openaiPlay(props.message.id, content, {
          provider: 'openai',
          baseUrl: voiceSettings.openaiBaseUrl.value,
          apiKey: voiceSettings.openaiApiKey.value,
          model: voiceSettings.openaiModel.value,
          voice: voiceSettings.openaiVoice.value,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'custom') {
        const apiUrl = voiceSettings.customUrl.value
        if (apiUrl) void speech.openaiPlay(props.message.id, content, {
          provider: 'custom',
          baseUrl: voiceSettings.customUrl.value,
          apiKey: voiceSettings.customApiKey.value || undefined,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'edge') {
        void speech.openaiPlay(props.message.id, content, {
          provider: 'edge',
          baseUrl: '/api/tts/proxy',
          voice: voiceSettings.edgeVoice.value,
          rate: speedToEdgeRate(voiceSettings.edgeRate.value),
          pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'mimo') {
        const apiKey = voiceSettings.mimoApiKey.value
        void speech.mimoPlay(props.message.id, content, {
          baseUrl: voiceSettings.mimoBaseUrl.value,
          apiKey: apiKey || undefined,
          authMode: voiceSettings.mimoAuthMode.value,
          model: voiceSettings.mimoModel.value,
          voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' : 'preset',
          voice: voiceSettings.mimoVoice.value,
          voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
          voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
          voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
          stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'webspeech') {
        // Web Speech API 模式：提取可读文本后播放
        const text = speech.extractReadableText(content)
        if (text) {
          speech.stop(false)
          speech.speakViaBrowser(props.message.id, text, {
            voiceName: voiceSettings.webspeechVoice.value || undefined,
          })
        }
      } else {
        // 默认模式：将消息加入播放队列
        speech.enqueue(props.message.id, content)
      }
    }
  }
  // 注册全局自动播放事件监听
  window.addEventListener('auto-play-speech', autoPlayHandler)
})

// 组件卸载时清理事件监听并停止播放
onBeforeUnmount(() => {
  // 移除自动播放事件监听
  if (autoPlayHandler) {
    window.removeEventListener('auto-play-speech', autoPlayHandler)
  }
  // 如果当前消息正在播放，停止播放
  if (speech.currentMessageId.value === props.message.id || speech.currentCustomMessageId.value === props.message.id) {
    speech.stop();
  }
});
</script>

<template>
  <div
    class="message"
    :class="[message.role, { highlight }]"
    :id="`message-${message.id}`"
  >
    <template v-if="message.role === 'tool'">
      <div
        class="tool-line"
        :class="{ expandable: hasToolDetails }"
        @click="hasToolDetails && (toolExpanded = !toolExpanded)"
      >
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
        <span class="tool-name">{{ message.toolName }}</span>
        <span
          v-if="message.toolPreview && !toolExpanded"
          class="tool-preview"
          >{{ message.toolPreview }}</span
        >
        <span
          v-if="message.toolStatus === 'running'"
          class="tool-spinner"
        ></span>
        <span v-if="message.toolStatus === 'error'" class="tool-error-badge">{{
          t("chat.error")
        }}</span>
      </div>
      <div v-if="toolExpanded && hasToolDetails" class="tool-details" @click="handleToolDetailClick">
        <div v-if="formattedToolArgs" class="tool-detail-section" data-copy-source="tool-args">
          <div class="tool-detail-label">{{ t("chat.arguments") }}</div>
          <div class="tool-detail-code-block" v-html="renderedToolArgs"></div>
        </div>
        <div v-if="formattedToolResult" class="tool-detail-section" data-copy-source="tool-result">
          <div class="tool-detail-label">{{ t("chat.result") }}</div>
          <div class="tool-detail-code-block" v-html="renderedToolResult"></div>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="msg-body">
        <ProfileAvatar
          v-if="message.role === 'assistant'"
          class="msg-avatar"
          :name="assistantProfileName"
          :avatar="assistantProfileAvatar"
          :size="40"
        />
        <div class="msg-content" :class="message.role">
          <div
            class="message-bubble"
            :class="{
              system: isSystem,
              'agent-error': isAgentError,
              command: isCommandMessage,
              'command-error': isCommandError,
              'speech-playing': isPlayingThisMessage && !isPausedThisMessage,
            }"
          >
            <div v-if="hasAttachments" class="msg-attachments">
              <div
                v-for="att in message.attachments"
                :key="att.id"
                class="msg-attachment"
                :class="{ image: isImage(att.type) }"
              >
                <template v-if="isImage(att.type) && att.url">
                  <img
                    :src="att.url"
                    :alt="att.name"
                    class="msg-attachment-thumb"
                    @click="previewUrl = att.url"
                  />
                </template>
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
                      <path
                        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                      />
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
            <div
              v-if="hasThinking"
              class="thinking-block"
              :class="{ expanded: thinkingExpanded }"
            >
              <div class="thinking-header" @click="toggleThinking">
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
                <span class="thinking-icon">💭</span>
                <span class="thinking-label">
                  {{
                    thinkingStreamingNow
                      ? t('chat.thinkingInProgress')
                      : t('chat.thinkingLabel')
                  }}
                </span>
                <span v-if="thinkingDurationMs !== null && thinkingDurationMs > 0" class="thinking-meta">
                  · {{ t('chat.thinkingDuration', { duration: formatDuration(thinkingDurationMs) }) }}
                </span>
                <span class="thinking-meta">
                  · {{ t('chat.thinkingChars', { count: thinkingCharCount }) }}
                </span>
              </div>
              <div v-if="thinkingExpanded" class="thinking-body">
                <MarkdownRenderer :content="thinkingFullText" />
              </div>
            </div>
            <MarkdownRenderer
              v-if="parsedThinking.body && message.role === 'assistant'"
              :content="parsedThinking.body"
              :heading-id-prefix="effectiveHeadingIdPrefix"
            />

            <!-- Render user message content -->
            <template v-if="message.role === 'user'">
              <!-- ContentBlock[] format -->
              <template v-if="isContentBlockArray">
                <div v-if="contentFiles && contentFiles.length > 0" class="msg-attachments">
                  <div
                    v-for="(file, idx) in contentFiles"
                    :key="idx"
                    class="msg-attachment"
                    :class="{ image: file.type === 'image' }"
                  >
                    <template v-if="file.type === 'image'">
                      <img
                        :src="getContentFileUrl(file)"
                        :alt="file.name"
                        class="msg-attachment-thumb"
                        @click="previewUrl = getContentFileUrl(file)"
                      />
                    </template>
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
                <MarkdownRenderer v-if="displayText" :content="displayText" />
              </template>
              <!-- Plain text format -->
              <MarkdownRenderer v-else-if="message.content" :content="message.content" />
            </template>

            <!-- Render assistant message content -->
            <MarkdownRenderer
              v-if="message.role === 'assistant' && message.content && !parsedThinking.body"
              :content="message.content"
              :heading-id-prefix="effectiveHeadingIdPrefix"
            />

            <!-- Render system message content -->
            <MarkdownRenderer
              v-if="message.role === 'system' && message.content && !isCommandMessage"
              :content="message.content"
            />
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
            <div v-else-if="isCommandMessage && message.content" class="command-result">
              <span class="command-result-icon">/</span>
              <MarkdownRenderer :content="message.content" />
            </div>

            <span v-if="message.isStreaming && !message.content" class="streaming-dots">
              <span></span><span></span><span></span>
            </span>
          </div>
          <div class="message-meta">
            <button
              v-if="canPlaySpeech"
              class="speech-bubble-btn"
              :class="{ playing: isPlayingThisMessage, paused: isPausedThisMessage }"
              @click="handleSpeechToggle"
              :title="isPlayingThisMessage ? (isPausedThisMessage ? t('chat.resumeSpeech') : t('chat.pauseSpeech')) : t('chat.playSpeech')"
            >
              <svg v-if="!isPlayingThisMessage || isPausedThisMessage" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            </button>
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
            <span class="message-time">{{ timeStr }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
  <Teleport to="body">
    <div v-if="previewUrl" class="image-preview-overlay" @click.self="previewUrl = null">
      <img :src="previewUrl" class="image-preview-img" @click="previewUrl = null" />
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message {
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
  max-width: 100%;

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

    .message-bubble.agent-error {
      color: $error;
      background-color: rgba(var(--error-rgb), 0.06);
      border: 1px solid rgba(var(--error-rgb), 0.2);
    }
  }

  &.tool {
    align-items: flex-start;
  }

  &.system {
    align-items: flex-start;
  }

  &.command {
    align-items: flex-start;
  }

  &.highlight {
    .message-bubble {
      box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.45);
    }
  }
}

@keyframes gradient-flow {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}

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

  &.system {
    border-left: 3px solid $warning;
    border-radius: $radius-sm;
    max-width: 80%;
    background-color: rgba(var(--warning-rgb), 0.06);
  }

  &.command {
    border-left: none;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.12);
    background-color: rgba(var(--accent-primary-rgb), 0.04);
    color: $text-secondary;
    max-width: min(100%, 960px);
    padding: 8px 10px;
  }

  &.command-error {
    border-color: rgba(var(--warning-rgb), 0.28);
    background-color: rgba(var(--warning-rgb), 0.06);
  }

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

  &.speech-playing {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    animation: rainbow-glow 4s linear infinite;
  }
}

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

.command-status {
  align-items: center;
}

.command-status-grid {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
}

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

.command-status-key {
  color: $text-muted;
  font-size: 11px;
}

.command-status-value {
  color: $text-primary;
  font-family: $font-code;
  font-size: 11px;
}

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

  &.image {
    max-width: 200px;
  }
}

.msg-attachment-thumb {
  display: block;
  max-width: 200px;
  max-height: 160px;
  object-fit: contain;
  cursor: pointer;
}

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

.thinking-block {
  margin-bottom: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed $border-light;

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

  .thinking-chevron {
    flex-shrink: 0;
    transition: transform 0.15s ease;

    &.rotated {
      transform: rotate(90deg);
    }
  }

  .thinking-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  .thinking-label {
    font-weight: 500;
    flex-shrink: 0;
  }

  .thinking-meta {
    color: $text-muted;
    font-variant-numeric: tabular-nums;
  }

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

.message-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
  opacity: 0;
  transition: opacity 0.15s ease;

  .message:hover & {
    opacity: 1;
  }

  // 移动端一直显示按钮
  @media (max-width: 768px) {
    opacity: 1;
  }
}

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

  .dark & {
    color: #999999;

    &:hover {
      color: #cccccc;
      background: rgba(255, 255, 255, 0.1);
    }
  }
}

.speech-bubble-btn {
  &.playing {
    color: var(--accent-primary);
    animation: pulse 1.5s ease-in-out infinite;

    &.paused {
      animation: none;
      opacity: 0.6;
    }
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.message-time {
  font-size: 11px;
  color: $text-muted;
  user-select: none;

  .dark & {
    color: #999999;
  }
}

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

  &.expandable {
    cursor: pointer;

    &:hover {
      background: rgba(0, 0, 0, 0.03);
    }
  }

  .tool-name {
    font-family: $font-code;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

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

.tool-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;

  &.rotated {
    transform: rotate(90deg);
  }
}

.tool-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid $text-muted;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

.tool-error-badge {
  font-size: 9px;
  color: $error;
  background: rgba(var(--error-rgb), 0.08);
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
  margin-left: 4px;
}

.tool-details {
  margin-left: 16px;
  margin-top: 2px;
  border-left: 2px solid $border-light;
  padding-left: 10px;
}

.tool-detail-section {
  margin-bottom: 6px;
}

.tool-detail-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
}

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

  :deep(.hljs-unified-diff code.hljs) {
    max-height: none;
    overflow-y: visible;
    white-space: pre;
    word-break: normal;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background-color: $text-muted;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 0.8s infinite;
}

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

@keyframes blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
  }
}

@keyframes pulse {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

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
