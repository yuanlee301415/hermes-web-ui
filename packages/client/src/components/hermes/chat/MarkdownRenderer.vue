<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDrawer, NDrawerContent, NSpin, useMessage } from 'naive-ui'
import type MarkdownIt from 'markdown-it'
import MarkdownItConstructor from 'markdown-it'
import katex from 'katex'
import markdownItKatex from '@vscode/markdown-it-katex'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from './highlight'
import { repairNestedMarkdownFences } from './markdownFenceRepair'
import {
  MERMAID_MAX_DIAGRAMS_PER_MESSAGE,
  MERMAID_MAX_SOURCE_LENGTH,
  MERMAID_RENDER_TIMEOUT_MS,
  decodeMermaidSource,
  isMermaidFence,
  renderMermaidPlaceholder,
  SUPPORT_PREVIEW_FILE_TYPES,
} from './mermaidRenderer'
import { downloadFile, getDownloadUrl, fetchFileText } from '@/api/hermes/download'

// 支持的 LaTeX 代码块语言标识集合
const LATEX_FENCE_LANGS = new Set(['latex', 'tex', 'math', 'katex'])
// 文件预览区域宽度：最大 800px 或占满视口宽度
const PREVIEW_AREA_WIDTH = 'min(800px, 100vw)'

/**
 * 从代码块信息字符串中提取语言标识
 * @param info 代码块的信息字符串（如 "python" 或 "python filename.py"）
 * @returns 语言标识（小写）
 */
function getFenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

/**
 * 判断代码块是否为 LaTeX 数学公式
 * @param info 代码块的信息字符串
 * @returns 是否为 LaTeX 代码块
 */
function isLatexFence(info: string): boolean {
  return LATEX_FENCE_LANGS.has(getFenceLanguage(info))
}

/**
 * 规范化 LaTeX 代码块内容，去除包裹符号
 * 支持三种包裹格式：\[...\]、$$...$$、\(...\)
 * @param content 原始 LaTeX 内容
 * @returns 去除包裹符后的纯 LaTeX 公式
 */
function normalizeLatexFenceContent(content: string): string {
  const trimmed = content.trim()

  // 块级公式：\[ ... \]
  if (trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) {
    return trimmed.slice(2, -2).trim()
  }

  // 块级公式：$$ ... $$
  if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    return trimmed.slice(2, -2).trim()
  }

  // 行内公式：\( ... \)
  if (trimmed.startsWith('\\(') && trimmed.endsWith('\\)')) {
    return trimmed.slice(2, -2).trim()
  }

  return trimmed
}

/**
 * 使用 KaTeX 渲染 LaTeX 数学公式为 HTML
 * @param content LaTeX 公式内容
 * @returns 渲染后的 HTML 字符串
 */
function renderLatexFence(content: string): string {
  const latex = normalizeLatexFenceContent(content)
  return `<div class="latex-block">${katex.renderToString(latex, {
    displayMode: true,        // 块级显示模式
    output: 'htmlAndMathml',  // 输出 HTML 和 MathML
    throwOnError: false,      // 错误时不抛出异常
    strict: 'ignore',         // 忽略严格模式
  })}</div>`
}

// 组件属性定义
const props = withDefaults(defineProps<{
    content: string             // Markdown 内容文本
    mentionNames?: string[]     // 需要高亮的 @提及用户名列表
    headingIdPrefix?: string    // 标题 ID 前缀，用于区分不同消息的锚点
}>(), {
    mentionNames: () => [],     // 默认空数组
    headingIdPrefix: '',        // 默认无前缀
})

// 初始化国际化和消息提示
const { t } = useI18n()
const message = useMessage()

/**
 * 生成 diff 折叠标签文本
 * @param hiddenCount 隐藏的行数
 * @returns 本地化的标签文本
 */
function diffFoldLabel(hiddenCount: number): string {
  return t('chat.unchangedLines', { count: hiddenCount })
}

/**
 * 初始化 Markdown 解析器实例
 * 配置：禁用 HTML、自动换行、自动链接、排版优化
 */
const md: MarkdownIt = new MarkdownItConstructor({
  html: false,       // 禁用 HTML 标签解析，防止 XSS
  breaks: true,      // 自动将换行转换为 <br>
  linkify: true,     // 自动识别链接并转换为 <a>
  typographer: true, // 启用排版优化（如引号转换）
  // 自定义代码高亮器
  highlight(str: string, lang: string): string {
    return renderHighlightedCodeBlock(str, lang, t('common.copy'), {
      formatDiffFoldLabel: diffFoldLabel,
    })
  },
})

// 注册 KaTeX 插件，支持 LaTeX 数学公式
md.use(markdownItKatex, {
  katex,
  throwOnError: false,  // 渲染错误时不抛出异常
  strict: 'ignore',     // 忽略严格模式检查
})

// 保存默认的代码块渲染器，用于回退处理
const defaultFenceRenderer = md.renderer.rules.fence?.bind(md.renderer.rules)

/**
 * 自定义代码块渲染规则
 * 支持三种类型：LaTeX 公式、Mermaid 图表、普通代码块
 */
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]

  // 优先渲染 LaTeX 数学公式
  if (isLatexFence(token.info)) {
    return renderLatexFence(token.content)
  }

  // 渲染 Mermaid 图表占位符（实际渲染在 mounted 后异步执行）
  if (isMermaidFence(token.info)) {
    return renderMermaidPlaceholder(token.content)
  }

  // 使用默认渲染器处理普通代码块
  if (defaultFenceRenderer) {
    return defaultFenceRenderer(tokens, idx, options, env, self)
  }

  // 最终回退：使用 token 默认渲染
  return self.renderToken(tokens, idx, options)
}

// Markdown 渲染容器 DOM 引用
const markdownBody = ref<HTMLElement | null>(null)
// 组件唯一 ID，用于 Mermaid 图表渲染时的 DOM 元素标识
const componentId = `hermes-mermaid-${Math.random().toString(36).slice(2)}`
// 图片预览 URL（点击图片时显示）
const previewUrl = ref<string | null>(null)

// 文件文本预览相关状态
const textPreviewContent = ref<string | null>(null)   // 预览文件内容
const textPreviewFileName = ref('')                  // 预览文件名
const textPreviewLoading = ref(false)                // 加载状态
const textPreviewVisible = ref(false)                // 预览抽屉是否可见

// 判断预览文件是否为 Markdown 格式
const textPreviewIsMarkdown = computed(() => /\.(md|markdown)$/i.test(textPreviewFileName.value))

// 渲染版本计数器，用于防止组件卸载后继续渲染
let renderGeneration = 0
// 组件卸载标记
let unmounted = false

/**
 * 判断路径是否为本地文件路径
 * @param path 文件路径
 * @returns 是否为本地路径（绝对路径或以盘符开头）
 */
function isLocalFilePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
}

/**
 * 规范化本地文件路径，统一使用正斜杠
 * @param path 原始路径
 * @returns 规范化后的路径
 */
function normalizeLocalFilePath(path: string): string {
  return /^[a-zA-Z]:\\/.test(path) ? path.replace(/\\/g, '/') : path
}

// 支持的视频文件扩展名
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov'])
// 支持的音频文件扩展名
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'])

/**
 * 判断文件路径是否具有指定的扩展名
 * @param path 文件路径
 * @param extensions 扩展名集合
 * @returns 是否匹配
 */
function hasExtension(path: string, extensions: Set<string>): boolean {
  // 去除查询参数和哈希片段
  const clean = path.split('?')[0].split('#')[0]
  // 获取文件扩展名（小写）
  const ext = clean.split('.').pop()?.toLowerCase()
  return !!ext && extensions.has(ext)
}

/**
 * 核心计算属性：将 Markdown 内容渲染为 HTML
 * 处理流程：
 * 1. 修复嵌套代码块问题
 * 2. 使用 markdown-it 渲染为 HTML
 * 3. 为标题添加 ID（用于锚点链接）
 * 4. 替换本地图片路径为下载 URL
 * 5. 将本地文件链接转换为文件卡片/音视频播放器
 * 6. 高亮 @提及用户名
 */
const renderedHtml = computed(() => {
  // 先修复嵌套代码块问题，再进行渲染
  let html = md.render(repairNestedMarkdownFences(props.content))

  // 为所有标题添加 ID，支持锚点跳转
  const prefix = props.headingIdPrefix ? `${props.headingIdPrefix}-` : ''
  let headingCounter = 0
  // 匹配 h1-h6 标签（可能带属性）
  html = html.replace(/<(h[1-6])([^>]*)>/g, (match, tag, attrs) => {
    headingCounter++
    const id = `${prefix}heading-${headingCounter}`
    
    // 如果已存在 id 属性，替换为新的
    if (attrs.includes('id=')) {
      return match.replace(/id="[^"]*"/, `id="${id}"`).replace(/id='[^']*'/, `id="${id}"`)
    }
    
    // 添加新的 id 属性
    if (attrs.trim() === '') {
      return `<${tag} id="${id}">`
    }
    return `<${tag} ${attrs.trim()} id="${id}">`
  })

  // 将本地图片路径替换为下载 URL
  html = html.replace(/\bsrc=(["'])([^"']+)\1/g, (match, quote, path) => {
    if (!isLocalFilePath(path)) return match
    const downloadUrl = getDownloadUrl(normalizeLocalFilePath(path))
    return `src=${quote}${downloadUrl}${quote}`
  })

  // 将本地文件链接转换为文件卡片或音视频播放器
  // 匹配 <a href="/tmp/file.pdf">filename</a> 或 <a href="C:/tmp/file.pdf">filename</a>
  html = html.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, (match, rawPath, filename) => {
    if (!isLocalFilePath(rawPath)) return match

    const path = normalizeLocalFilePath(rawPath)
    const fileName = filename.trim()

    // 视频文件：渲染为视频播放器
    if (hasExtension(path, VIDEO_EXTENSIONS)) {
      const downloadUrl = getDownloadUrl(path)
      return `<div class="markdown-video-container">
        <video class="markdown-video" controls preload="metadata" src="${downloadUrl}"></video>
        <div class="markdown-video-footer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <span class="att-name">${fileName}</span>
        </div>
      </div>`
    }

    // 音频文件：渲染为内联音频播放器
    if (hasExtension(path, AUDIO_EXTENSIONS)) {
      const downloadUrl = getDownloadUrl(path)
      return `<div class="markdown-audio-container">
        <audio class="markdown-audio" controls preload="metadata" src="${downloadUrl}"></audio></audio>
        <div class="markdown-audio-footer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <span class="att-name">${fileName}</span>
        </div>
      </div>`
    }

    // 其他文件：渲染为文件卡片（支持下载）
    return `<div class="markdown-file-card" data-path="${path}" data-filename="${fileName}" title="${t('download.downloadFile')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span class="att-name">${fileName}</span>
      <button class="att-download-btn" type="button" title="${t('download.downloadFile')}" aria-label="${t('download.downloadFile')}">
        <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
    </div>`
  })

  // 高亮 @提及用户名
  if (props.mentionNames && props.mentionNames.length > 0) {
    // 按长度降序排列，确保长用户名优先匹配
    const escaped = [...props.mentionNames]
      .sort((a, b) => b.length - a.length)
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    // 正则匹配：用户名前后必须是空白、标点或边界
    const re = new RegExp(`(?<=[\\s>({\\[<]|^)@(${escaped.join('|')})(?=[\\s.,!?;:，。！？；：)\\]}>]|<|$)`, 'gi')
    html = html.replace(re, '<span class="mention-highlight">@$1</span>')
  }
  return html
})

/**
 * Mermaid 渲染失败时的回退处理
 * 将图表替换为高亮的代码块显示
 * @param element 要替换的 DOM 元素
 * @param source Mermaid 源代码
 */
function renderMermaidFallback(element: HTMLElement, source: string): void {
  element.outerHTML = renderHighlightedCodeBlock(source, 'mermaid', t('common.copy'))
}

/**
 * 为 Promise 添加超时控制
 * @param promise 要包装的 Promise
 * @param timeoutMs 超时时间（毫秒）
 * @param label 标识名称（用于错误信息）
 * @returns 包装后的 Promise，超时时会拒绝
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  })
}

/**
 * 获取元素的滚动父容器
 * 向上遍历 DOM 树，找到第一个可滚动的父元素
 * @param el 目标元素
 * @returns 滚动父容器或 null
 */
function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  let current: HTMLElement | null = el.parentElement
  while (current) {
    const { overflow, overflowY } = getComputedStyle(current)
    if (overflow === 'auto' || overflow === 'scroll' || overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }
  return null
}

/**
 * 判断滚动容器是否接近底部
 * @param el 滚动容器
 * @param threshold 阈值（像素）
 * @returns 是否接近底部
 */
function isNearScrollBottom(el: HTMLElement, threshold = 200): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

/**
 * 清理 Mermaid 渲染产生的临时 DOM 元素
 * Mermaid 会创建额外的 <svg> 和 <defs> 元素，需要手动清理
 * @param id 图表 ID
 */
function cleanupMermaidRenderArtifacts(id: string): void {
  document.getElementById(id)?.remove()
  document.getElementById(`d${id}`)?.remove()
}

/**
 * 异步渲染 Mermaid 图表
 * 渲染流程：
 * 1. 获取当前渲染版本号，防止组件卸载后继续渲染
 * 2. 等待 DOM 更新完成（nextTick）
 * 3. 查找所有待渲染的 Mermaid 占位符
 * 4. 限制单次渲染数量，超出部分回退为代码块
 * 5. 动态导入 Mermaid 库（按需加载）
 * 6. 逐个渲染图表，处理超时和错误
 * 7. 保持滚动位置（如果用户正在底部）
 */
async function renderMermaidDiagrams(): Promise<void> {
  // 递增渲染版本号，用于取消过时的渲染任务
  const generation = ++renderGeneration
  // 等待 DOM 更新完成，确保占位符元素已挂载
  await nextTick()

  const root = markdownBody.value
  // 检查：组件已卸载 / 渲染版本过期 / 根元素不存在
  if (unmounted || generation !== renderGeneration || !root) return

  // 查找所有待渲染的 Mermaid 占位符元素
  const pendingDiagrams = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid-pending="true"]'))
  if (pendingDiagrams.length === 0) return

  // 限制单次渲染数量，防止过多图表导致性能问题
  const diagramsToRender = pendingDiagrams.slice(0, MERMAID_MAX_DIAGRAMS_PER_MESSAGE)
  const diagramsToFallback = pendingDiagrams.slice(MERMAID_MAX_DIAGRAMS_PER_MESSAGE)

  // 超出限制的图表直接回退为代码块显示
  for (const element of diagramsToFallback) {
    renderMermaidFallback(element, decodeMermaidSource(element.getAttribute('data-mermaid-source')))
  }

  // 构建渲染候选列表，解码 Mermaid 源代码
  const renderCandidates = diagramsToRender
    .map(element => ({
      element,
      source: decodeMermaidSource(element.getAttribute('data-mermaid-source')),
    }))

  // 筛选有效图表（非空且不超过最大长度）
  const validDiagrams = [] as typeof renderCandidates
  for (const candidate of renderCandidates) {
    // 每次迭代都检查渲染版本，防止过时任务继续执行
    if (unmounted || generation !== renderGeneration || !root.contains(candidate.element)) return

    // 源代码为空或过长时，回退为代码块
    if (!candidate.source || candidate.source.length > MERMAID_MAX_SOURCE_LENGTH) {
      renderMermaidFallback(candidate.element, candidate.source)
      continue
    }

    validDiagrams.push(candidate)
  }

  if (validDiagrams.length === 0) return

  let mermaid: typeof import('mermaid').default

  try {
    // 动态导入 Mermaid 库（带超时控制）
    mermaid = (await withTimeout(import('mermaid'), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid import')).default
    if (unmounted || generation !== renderGeneration) return

    // 初始化 Mermaid（禁用自动加载，使用严格安全级别）
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
    })
  } catch {
    // Mermaid 导入失败，所有图表回退为代码块
    if (unmounted || generation !== renderGeneration) return
    for (const { element, source } of validDiagrams) {
      if (root.contains(element)) {
        renderMermaidFallback(element, source)
      }
    }
    return
  }

  // 逐个渲染有效图表
  for (const [index, { element, source }] of validDiagrams.entries()) {
    if (unmounted || generation !== renderGeneration || !root.contains(element)) return

    try {
      // 生成唯一的图表 ID
      const id = `${componentId}-${generation}-${index}`
      // 渲染图表（带超时控制）
      const result = await withTimeout(mermaid.render(id, source), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid render')
      // 清理 Mermaid 生成的临时 DOM 元素
      cleanupMermaidRenderArtifacts(id)
      if (unmounted || generation !== renderGeneration || !root.contains(element)) return

      // 记录滚动位置，渲染后保持用户在底部的状态
      const scrollParent = getScrollParent(markdownBody.value)
      const shouldKeepBottom = scrollParent ? isNearScrollBottom(scrollParent) : false
      // 移除占位符标记
      element.removeAttribute('data-mermaid-pending')
      element.removeAttribute('data-mermaid-source')
      // 替换为渲染后的 SVG
      element.innerHTML = result.svg
      // 如果用户原本在底部，滚动到新的底部
      if (scrollParent && shouldKeepBottom) {
        nextTick(() => {
          scrollParent.scrollTop = scrollParent.scrollHeight
        })
      }
    } catch {
      // 单个图表渲染失败，清理并回退
      cleanupMermaidRenderArtifacts(`${componentId}-${generation}-${index}`)
      if (unmounted || generation !== renderGeneration || !root.contains(element)) return
      renderMermaidFallback(element, source)
    }
  }
}

/**
 * 组件挂载后触发：开始渲染 Mermaid 图表
 */
onMounted(() => {
  void renderMermaidDiagrams()
})

/**
 * 监听渲染后的 HTML 变化：内容更新时重新渲染 Mermaid 图表
 * 使用 post 模式确保 DOM 已更新完成
 */
watch(renderedHtml, () => {
  void renderMermaidDiagrams()
}, { flush: 'post' })

/**
 * 组件卸载前清理：标记卸载状态并递增渲染版本
 * 防止异步渲染任务在组件卸载后继续执行
 */
onBeforeUnmount(() => {
  unmounted = true
  renderGeneration += 1
})

/**
 * 处理 Markdown 内容的点击事件
 * 支持的交互：
 * 1. 代码块复制按钮
 * 2. 图片预览（点击图片显示全屏预览）
 * 3. 文件卡片点击（预览或下载）
 * 4. 链接点击（外部链接、下载链接、本地文件）
 */
async function handleMarkdownClick(event: MouseEvent): Promise<void> {
  // 优先处理代码块复制操作
  const copyResult = await handleCodeBlockCopyClick(event)
  if (copyResult !== null) {
    if (copyResult) {
      message.success(t('common.copied'))
    } else {
      message.error(t('chat.copyFailed'))
    }
    return
  }

  const target = event.target as HTMLElement

  // 图片点击：显示全屏预览
  const img = target.closest('img') as HTMLImageElement | null
  if (img) {
    event.preventDefault()
    previewUrl.value = img.src
    return
  }

  // 文件卡片点击：处理下载或预览
  const fileCard = target.closest('.markdown-file-card') as HTMLElement | null
  if (fileCard) {
    event.preventDefault()
    event.stopPropagation()
    const path = fileCard.getAttribute('data-path')
    const fileName = fileCard.getAttribute('data-filename') || undefined

    const isDownloadBtn = target.closest('.att-download-btn')

    // 点击下载按钮：直接下载文件
    if (isDownloadBtn && path) {
      message.info(t('download.downloading'))
      downloadFile(path, fileName).catch((err: Error) => {
        message.error(err.message || t('download.downloadFailed'))
      })
      return
    }

    // 点击文件卡片主体：根据文件类型决定预览或下载
    if (path) {
      const ext = fileName?.split('.').pop()?.toLowerCase()
      if (SUPPORT_PREVIEW_FILE_TYPES.includes(ext || '')) {
        // 支持预览的文件类型（如 md、txt）：打开预览抽屉
        previewTextFile(path, fileName || '')
      } else {
        // 不支持预览的文件：直接下载
        downloadFile(path, fileName).catch((err: Error) => {
          message.error(err.message || t('download.downloadFailed'))
        })
      }
    }
    return
  }

  // 链接点击处理
  const link = target.closest('a') as HTMLAnchorElement | null
  if (!link) return

  const href = link.getAttribute('href')
  if (!href) return

  // 外部链接（http/https）：在新标签页打开
  // 使用 window.open 防止哈希路由拦截
  if (href.startsWith('http://') || href.startsWith('https://')) {
    event.preventDefault()
    window.open(href, '_blank', 'noopener,noreferrer')
    return
  }

  // 完整下载 URL（已包含 /api/hermes/download?path=...）
  if (href.startsWith('/api/hermes/download?')) {
    event.preventDefault()
    event.stopPropagation()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    message.info(t('download.downloading'))
    // 从查询参数中解析真实文件路径
    const url = new URL(href, window.location.origin)
    const realPath = url.searchParams.get('path') || href
    downloadFile(realPath, fileName || undefined).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
    return
  }

  // 本地文件路径链接：拦截并触发下载
  if (isLocalFilePath(href)) {
    event.preventDefault()
    event.stopPropagation()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    message.info(t('download.downloading'))
    downloadFile(normalizeLocalFilePath(href), fileName || undefined).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
  }
}

/**
 * 获取文件内容并打开预览抽屉
 * @param path 文件路径
 * @param fileName 文件名
 */
async function previewTextFile(path: string, fileName: string): Promise<void> {
  // 重置预览状态
  textPreviewLoading.value = true
  textPreviewVisible.value = true
  textPreviewFileName.value = fileName
  textPreviewContent.value = null
  try {
    // 请求文件内容
    textPreviewContent.value = await fetchFileText(path, fileName)
  } catch (err: any) {
    message.error(err.message || t('download.downloadFailed'))
  } finally {
    textPreviewLoading.value = false
  }
}

/**
 * 关闭文件文本预览抽屉
 */
function closeTextPreview(): void {
  textPreviewVisible.value = false
}
</script>

<template>
  <div ref="markdownBody" class="markdown-body" v-html="renderedHtml" @click="handleMarkdownClick"></div>
  <!-- File preview area -->
  <NDrawer
    v-model:show="textPreviewVisible"
    :width="PREVIEW_AREA_WIDTH"
    placement="right"
    :show-mask="false"
    :trap-focus="false"
    class="markdown-text-preview-drawer"
  >
    <NDrawerContent
      :title="t('download.contentDisplay')"
      closable
      :body-content-style="{ padding: 0 }"
      @close="closeTextPreview"
    >
      <NSpin :show="textPreviewLoading">
        <div v-if="textPreviewContent !== null && textPreviewIsMarkdown" class="text-preview-markdown">
          <MarkdownRenderer :content="textPreviewContent" />
        </div>
        <pre v-else-if="textPreviewContent !== null" class="text-preview-body">{{ textPreviewContent }}</pre>
      </NSpin>
    </NDrawerContent>
  </NDrawer>
  <Teleport to="body">
    <div v-if="previewUrl" class="image-preview-overlay" @click.self="previewUrl = null">
      <img :src="previewUrl" class="image-preview-img" @click="previewUrl = null" />
    </div>
  </Teleport>
</template>

<style lang="scss">
@use '@/styles/variables' as *;

.markdown-body {
  font-size: 14px;
  line-height: 1.65;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  overflow-x: auto;
  overflow-wrap: anywhere;
  word-break: break-word;

  p {
    margin: 0 0 8px;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;

    &:last-child {
      margin-bottom: 0;
    }
  }

  ul, ol {
    padding-left: 20px;
    margin: 4px 0 8px;
  }

  li {
    margin: 2px 0;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  strong {
    color: $text-primary;
    font-weight: 600;
  }

  em {
    color: $text-secondary;
  }

  a {
    color: $accent-primary;
    text-decoration: underline;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
    word-break: break-word;

    &:hover {
      color: $accent-hover;
    }
  }

  img {
    display: block;
    max-width: 200px;
    max-height: 160px;
    object-fit: contain;
    cursor: pointer;
    border-radius: 4px;
    margin: 8px 0;
  }

  .markdown-video-container {
    margin: 12px 0;
    border-radius: $radius-sm;
    overflow: hidden;
    background: #000;
    border: 1px solid $border-color;
  }

  .markdown-video {
    display: block;
    width: 100%;
    max-width: 640px;
    max-height: 480px;
    object-fit: contain;
  }

  .markdown-video-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    font-size: 12px;

    .att-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .markdown-audio-container {
    margin: 12px 0;
    padding: 10px 12px;
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    background-color: rgba(0, 0, 0, 0.04);
  }

  .markdown-audio {
    display: block;
    width: 100%;
    max-width: 420px;
  }

  .markdown-audio-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    color: $text-secondary;
    font-size: 12px;

    .att-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .markdown-file-card {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: $text-secondary;
    background-color: rgba(0, 0, 0, 0.04);
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    margin: 8px 0;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    &:hover {
      background-color: rgba(0, 0, 0, 0.08);
      border-color: $border-color;
    }

    .att-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }

    .att-download-icon {
      flex-shrink: 0;
      opacity: 0.6;
      transition: opacity 0.15s ease;
    }

    .att-download-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      padding: 0;
      color: inherit;
      background: transparent;
      border: 0;
      cursor: pointer;
    }

    &:hover .att-download-icon,
    .att-download-btn:hover .att-download-icon {
      opacity: 1;
    }
  }

  blockquote {
    margin: 8px 0;
    padding: 4px 12px;
    border-left: 3px solid $border-color;
    color: $text-secondary;
  }

  code:not(.hljs) {
    background: $code-bg;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: $font-code;
    font-size: 13px;
    color: $accent-primary;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  table {
    width: 100%;
    max-width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    display: block;
    overflow-x: auto;

    th, td {
      padding: 6px 12px;
      border: 1px solid $border-color;
      text-align: left;
      font-size: 13px;
    }

    th {
      background: rgba(var(--accent-primary-rgb), 0.08);
      color: $text-primary;
      font-weight: 600;
    }

    td {
      color: $text-secondary;
    }
  }

  hr {
    border: none;
    border-top: 1px solid $border-color;
    margin: 12px 0;
  }

  .mermaid-diagram {
    margin: 10px 0;
    padding: 14px;
    border: 1px solid $border-color;
    border-radius: 8px;
    background: rgba(var(--accent-primary-rgb), 0.04);
    overflow-x: auto;

    svg {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
  }

  .mermaid-loading {
    color: $text-secondary;
    font-size: 13px;
    font-family: $font-code;
    min-height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
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
  cursor: pointer;
}

.text-preview-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  margin: 0;
  font-family: $font-code;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: $text-primary;
}

.text-preview-markdown {
  padding: 16px;
  overflow: auto;
}

.markdown-text-preview-drawer {
  max-width: 100vw;

  .n-drawer-content,
  .n-drawer-body-content-wrapper {
    max-width: 100vw;
  }
}

@media (max-width: $breakpoint-mobile) {
  .markdown-text-preview-drawer {
    max-width: 100vw;

    .n-drawer-content,
    .n-drawer-body-content-wrapper {
      max-width: 100vw;
    }
  }

  .text-preview-body {
    padding: 12px;
    max-width: 100vw;
  }

  .text-preview-markdown {
    padding: 12px;
    max-width: 100vw;
  }
}
</style>
