/**
 * 代码高亮渲染模块
 * 基于 highlight.js 实现代码语法高亮，支持 Unified Diff 格式的特殊渲染和代码复制功能
 */
import hljs from 'highlight.js'
import { copyToClipboard } from '@/utils/clipboard'

/**
 * 语言别名映射表
 * 将常见的语言别名转换为 highlight.js 支持的标准语言名称
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  shellscript: 'bash',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  vue: 'xml',
}

/**
 * Unified Diff 相关语言集合
 * 用于识别 diff 和 patch 格式的代码块
 */
const UNIFIED_DIFF_LANGUAGES = new Set(['diff', 'patch'])

/**
 * Diff 上下文折叠阈值
 * 当连续的上下文行数超过此值时，自动折叠中间部分
 */
const DIFF_CONTEXT_FOLD_THRESHOLD = 8

/**
 * Diff 上下文折叠边缘行数
 * 折叠时保留的前后边缘行数
 */
const DIFF_CONTEXT_FOLD_EDGE_LINES = 3

/**
 * Diff 负载字段名称集合
 * 在结构化数据中搜索 diff 内容时需要检查的字段名
 */
const DIFF_PAYLOAD_FIELD_NAMES = new Set([
  'difference',
  'diff',
  'patch',
  'stdout',
  'output',
  'content',
])

/**
 * HTML 转义函数
 * 将字符串中的特殊字符转换为 HTML 实体，防止 XSS 攻击
 * @param value 原始字符串
 * @returns 转义后的字符串
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 语言类名清理函数
 * 将语言名称转换为合法的 CSS 类名，移除非法字符
 * @param value 原始语言名称
 * @returns 清理后的 CSS 类名，若为空则返回 'plain'
 */
function sanitizeLanguageClass(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '-') || 'plain'
}

/**
 * 渲染代码块包装器
 * 生成完整的代码块 HTML 结构，包含语言标签、复制按钮和高亮代码
 * @param highlighted 高亮后的代码 HTML
 * @param codeClassLanguage 用于 CSS 类的语言名称
 * @param labelLanguage 显示在标签上的语言名称
 * @param copyLabel 复制按钮的文本
 * @param extraClasses 额外的 CSS 类列表
 * @param rawCopyText 用于复制的原始文本（可选）
 * @returns 完整的代码块 HTML
 */
function renderCodeBlockWrapper(
  highlighted: string,
  codeClassLanguage: string,
  labelLanguage: string | undefined,
  copyLabel: string,
  extraClasses: string[] = [],
  rawCopyText?: string,
): string {
  const languageLabelHtml = labelLanguage
    ? `<span class="code-lang">${escapeHtml(labelLanguage)}</span>`
    : ''
  const blockClasses = ['hljs-code-block', ...extraClasses].join(' ')
  const copyTextAttr = rawCopyText == null
    ? ''
    : ` data-copy-text="${escapeHtml(rawCopyText)}"`

  return `<pre class="${blockClasses}"${copyTextAttr}><div class="code-header">${languageLabelHtml}<button type="button" class="copy-btn" data-copy-code="true">${escapeHtml(copyLabel)}</button></div><code class="hljs language-${sanitizeLanguageClass(codeClassLanguage)}">${highlighted}</code></pre>`
}

/**
 * 判断是否为 Unified Diff 语言
 * @param lang 语言名称
 * @returns 如果是 diff 或 patch 语言则返回 true
 */
function isUnifiedDiffLanguage(lang?: string): boolean {
  return UNIFIED_DIFF_LANGUAGES.has(lang?.trim().toLowerCase() || '')
}

/**
 * 判断是否为 Diff 文件头行
 * 匹配 diff --git、index、---、+++ 等文件标识行
 * @param line 待检测的行
 * @returns 如果是文件头行则返回 true
 */
function isDiffFileHeader(line: string): boolean {
  return /^(diff --git |index |---(?:\s|$)|\+\+\+(?:\s|$))/.test(line)
}

/**
 * 判断是否为 Diff Hunk 头行
 * 匹配 @@ 开头的 hunk 标识行
 * @param line 待检测的行
 * @returns 如果是 hunk 头行则返回 true
 */
function isDiffHunkHeader(line: string): boolean {
  return /^@@(?:\s|$)/.test(line)
}

/**
 * 判断是否为 Diff 添加行
 * 匹配以 + 开头但不是 +++ 的行
 * @param line 待检测的行
 * @returns 如果是添加行则返回 true
 */
function isDiffAddedLine(line: string): boolean {
  return /^\+(?!\+\+(?:\s|$))/.test(line)
}

/**
 * 判断是否为 Diff 删除行
 * 匹配以 - 开头但不是 --- 的行
 * @param line 待检测的行
 * @returns 如果是删除行则返回 true
 */
function isDiffRemovedLine(line: string): boolean {
  return /^-(?!---(?:\s|$))/.test(line)
}

/**
 * Diff 行号信息类型
 * 用于追踪 diff 中旧文件和新文件的行号
 */
type DiffLineNumbers = {
  oldNumber?: number
  newNumber?: number
}

/**
 * 渲染后的 Diff 行类型
 */
type RenderedDiffLine = {
  html: string
  foldableContext: boolean
}

/**
 * 解析 Diff Hunk 头行
 * 从 @@ -start,count +start,count @@ 格式中提取旧文件和新文件的起始行号
 * @param line hunk 头行
 * @returns 包含旧行号和新行号的对象，解析失败返回 null
 */
function parseDiffHunkHeader(line: string): DiffLineNumbers | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  if (!match) return null
  return {
    oldNumber: Number(match[1]),
    newNumber: Number(match[2]),
  }
}

/**
 * 格式化 Diff 行号
 * 根据行类型返回对应的行号显示值和 CSS 类名
 * @param line 当前行内容
 * @param numbers 当前的行号状态
 * @returns 包含行号值和 CSS 类名的对象
 */
function formatDiffLineNumber(line: string, numbers: DiffLineNumbers): { value: string; className: string } {
  if (isDiffFileHeader(line) || isDiffHunkHeader(line)) {
    return { value: '', className: 'diff-line-number-empty' }
  }
  if (isDiffRemovedLine(line)) {
    return {
      value: numbers.oldNumber != null ? String(numbers.oldNumber) : '',
      className: 'diff-line-number-old',
    }
  }
  if (isDiffAddedLine(line)) {
    return {
      value: numbers.newNumber != null ? String(numbers.newNumber) : '',
      className: 'diff-line-number-new',
    }
  }
  if (!isDiffFileHeader(line) && !isDiffHunkHeader(line) && numbers.newNumber != null) {
    return {
      value: String(numbers.newNumber),
      className: 'diff-line-number-context',
    }
  }
  return { value: '', className: 'diff-line-number-empty' }
}

/**
 * 推进 Diff 行号
 * 根据当前行类型更新旧文件和新文件的行号计数器
 * @param line 当前行内容
 * @param numbers 当前的行号状态
 */
function advanceDiffLineNumber(line: string, numbers: DiffLineNumbers): void {
  if (isDiffFileHeader(line) || isDiffHunkHeader(line)) return
  if (isDiffRemovedLine(line)) {
    if (numbers.oldNumber != null) numbers.oldNumber += 1
    return
  }
  if (isDiffAddedLine(line)) {
    if (numbers.newNumber != null) numbers.newNumber += 1
    return
  }
  if (numbers.oldNumber != null) numbers.oldNumber += 1
  if (numbers.newNumber != null) numbers.newNumber += 1
}

/**
 * 渲染 Diff 上下文折叠行
 * 生成表示折叠区域的占位行 HTML
 * @param foldLabel 折叠标签文本（通常显示隐藏的行数）
 * @returns 折叠行的 HTML
 */
function renderDiffContextFoldLine(foldLabel: string): string {
  return `<span class="diff-line diff-line-context-fold"><span class="diff-line-number diff-line-number-empty" aria-hidden="true"></span><span class="diff-line-content">⋮ ${escapeHtml(foldLabel)}</span></span>`
}

/**
 * 折叠可折叠的上下文行
 * 当连续的上下文行数超过阈值时，保留边缘行并折叠中间部分
 * @param rows 渲染后的 Diff 行数组
 * @param formatFoldLabel 折叠标签格式化函数
 * @returns 处理后的行数组（包含折叠行）
 */
function collapseFoldableContextRows(
  rows: RenderedDiffLine[],
  formatFoldLabel: (hiddenCount: number) => string,
): RenderedDiffLine[] {
  const folded: RenderedDiffLine[] = []
  let index = 0

  while (index < rows.length) {
    if (!rows[index].foldableContext) {
      folded.push(rows[index])
      index += 1
      continue
    }

    const runStart = index
    while (index < rows.length && rows[index].foldableContext) index += 1
    const run = rows.slice(runStart, index)

    if (run.length <= DIFF_CONTEXT_FOLD_THRESHOLD) {
      folded.push(...run)
      continue
    }

    const edge = Math.min(DIFF_CONTEXT_FOLD_EDGE_LINES, Math.floor(run.length / 2))
    const hiddenCount = run.length - edge * 2
    folded.push(...run.slice(0, edge))
    folded.push({
      html: renderDiffContextFoldLine(formatFoldLabel(hiddenCount)),
      foldableContext: false,
    })
    folded.push(...run.slice(run.length - edge))
  }

  return folded
}

/**
 * 渲染 Unified Diff 代码
 * 将 diff 内容解析并渲染为带有行号和高亮样式的 HTML
 * @param content diff 内容
 * @param labelLanguage 显示在标签上的语言名称
 * @param copyLabel 复制按钮的文本
 * @param formatFoldLabel 折叠标签格式化函数
 * @returns 渲染后的 diff 代码块 HTML
 */
function renderUnifiedDiffCode(
  content: string,
  labelLanguage: string,
  copyLabel: string,
  formatFoldLabel: (hiddenCount: number) => string,
): string {
  const numbers: DiffLineNumbers = {}
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  const renderedRows = lines
    .map((line) => {
      const classes = ['diff-line']
      let foldableContext = false
      if (isDiffFileHeader(line)) classes.push('diff-line-file-header')
      else if (isDiffHunkHeader(line)) {
        classes.push('diff-line-hunk-header')
        const hunkNumbers = parseDiffHunkHeader(line)
        if (hunkNumbers) {
          numbers.oldNumber = hunkNumbers.oldNumber
          numbers.newNumber = hunkNumbers.newNumber
        }
      }
      else if (isDiffAddedLine(line)) classes.push('diff-line-added')
      else if (isDiffRemovedLine(line)) classes.push('diff-line-removed')
      else foldableContext = true

      const lineNumber = formatDiffLineNumber(line, numbers)
      const html = `<span class="${classes.join(' ')}"><span class="diff-line-number ${lineNumber.className}" aria-hidden="true">${escapeHtml(lineNumber.value)}</span><span class="diff-line-content">${escapeHtml(line || ' ')}</span></span>`
      advanceDiffLineNumber(line, numbers)
      return { html, foldableContext }
    })

  const highlighted = collapseFoldableContextRows(renderedRows, formatFoldLabel)
    .map((row) => row.html)
    .join('')

  return renderCodeBlockWrapper(highlighted, 'diff', labelLanguage, copyLabel, ['hljs-unified-diff'], content)
}

/**
 * 标准化高亮语言名称
 * 将语言名称转换为小写并应用别名映射
 * @param lang 原始语言名称
 * @returns 标准化后的语言名称
 */
export function normalizeHighlightLanguage(lang?: string): string {
  const normalized = lang?.trim().toLowerCase() || ''
  return LANGUAGE_ALIASES[normalized] || normalized
}

/**
 * 判断内容是否看起来像 Diff
 * 通过检查特定的 diff 模式来识别
 * @param content 待检测的内容
 * @returns 如果内容看起来像 diff 则返回 true
 */
function looksLikeDiff(content: string): boolean {
  const trimmed = content.trimStart()
  if (/^\*\*\* Begin Patch/m.test(trimmed)) return true
  if (/^\*\*\* (Update|Add|Delete) File:/m.test(trimmed)) return true
  if (/^---\s+[^\n]+\n\+\+\+\s+[^\n]+\n@@/m.test(trimmed)) return true
  return false
}

/**
 * 推断结构化内容的语言类型
 * 通过检查内容格式自动识别 JSON 或 Diff
 * @param content 待检测的内容
 * @returns 推断出的语言名称（'json' 或 'diff'），无法推断返回 undefined
 */
export function inferStructuredLanguage(content: string): string | undefined {
  const trimmed = content.trimStart()
  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(content)
      return 'json'
    } catch {
      // Fall through to diff/text detection.
    }
  }
  return looksLikeDiff(content) ? 'diff' : undefined
}

/**
 * 判断内容是否为 Unified Diff 格式
 * 通过统计 diff 特征行（文件头、hunk 头、添加行、删除行）来判断
 * @param content 待检测的内容
 * @param lang 语言名称（可选）
 * @returns 如果内容是 Unified Diff 格式则返回 true
 */
export function isUnifiedDiffContent(content: string, lang?: string): boolean {
  const lines = content.split(/\r?\n/)
  if (lines.length < 3) return false

  let fileHeaders = 0
  let hunkHeaders = 0
  let addedLines = 0
  let removedLines = 0
  let diffHeaders = 0

  for (const line of lines) {
    if (/^(diff --git |index )/.test(line)) {
      diffHeaders += 1
      continue
    }
    if (/^---(?:\s|$)|^\+\+\+(?:\s|$)/.test(line)) {
      fileHeaders += 1
      continue
    }
    if (isDiffHunkHeader(line)) {
      hunkHeaders += 1
      continue
    }
    if (isDiffAddedLine(line)) {
      addedLines += 1
      continue
    }
    if (isDiffRemovedLine(line)) {
      removedLines += 1
    }
  }

  const hasChangedLines = addedLines > 0 || removedLines > 0
  if (!hasChangedLines) return false

  if (isUnifiedDiffLanguage(lang)) {
    return hunkHeaders > 0 || fileHeaders >= 2 || diffHeaders > 0
  }

  return fileHeaders >= 2 && hunkHeaders > 0
}

/**
 * 从结构化数据中提取 Unified Diff 内容
 * 递归搜索对象或数组，查找包含 diff 内容的字段
 * @param value 待搜索的值
 * @param depth 当前递归深度（默认 0，最大 4 层）
 * @returns 找到的 diff 内容字符串，未找到返回 null
 */
export function extractUnifiedDiffPayload(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const diff = extractUnifiedDiffPayload(item, depth + 1)
      if (diff) return diff
    }
    return null
  }

  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, candidate] of entries) {
    if (
      DIFF_PAYLOAD_FIELD_NAMES.has(key.toLowerCase())
      && typeof candidate === 'string'
      && isUnifiedDiffContent(candidate)
    ) {
      return candidate
    }
  }

  for (const [, candidate] of entries) {
    if (candidate && typeof candidate === 'object') {
      const diff = extractUnifiedDiffPayload(candidate, depth + 1)
      if (diff) return diff
    }
  }

  return null
}

/**
 * 渲染高亮代码块的选项类型
 */
type RenderHighlightedCodeBlockOptions = {
  maxHighlightLength?: number
  formatDiffFoldLabel?: (hiddenCount: number) => string
}

/**
 * 渲染高亮代码块
 * 根据内容类型选择合适的渲染方式：Unified Diff 使用特殊渲染，其他语言使用 highlight.js
 * @param content 代码内容
 * @param lang 语言名称（可选）
 * @param copyLabel 复制按钮的文本
 * @param options 渲染选项
 * @returns 完整的代码块 HTML
 */
export function renderHighlightedCodeBlock(
  content: string,
  lang: string | undefined,
  copyLabel: string,
  options: RenderHighlightedCodeBlockOptions = {},
): string {
  const requestedLanguage = lang?.trim().toLowerCase() || ''
  const normalizedLanguage = normalizeHighlightLanguage(requestedLanguage)
  const highlightLimit = options.maxHighlightLength ?? Number.POSITIVE_INFINITY

  if (isUnifiedDiffContent(content, requestedLanguage || normalizedLanguage)) {
    const formatDiffFoldLabel = options.formatDiffFoldLabel ?? ((hiddenCount: number) => String(hiddenCount))
    return renderUnifiedDiffCode(content, requestedLanguage || 'diff', copyLabel, formatDiffFoldLabel)
  }

  let highlighted = ''
  let codeClassLanguage = normalizedLanguage || requestedLanguage || 'plain'
  let labelLanguage = requestedLanguage

  try {
    if (normalizedLanguage && hljs.getLanguage(normalizedLanguage) && content.length <= highlightLimit) {
      highlighted = hljs.highlight(content, {
        language: normalizedLanguage,
        ignoreIllegals: true,
      }).value
      codeClassLanguage = normalizedLanguage
    } else {
      highlighted = escapeHtml(content)
      if (!labelLanguage) {
        labelLanguage = 'text'
      }
    }
  } catch {
    highlighted = escapeHtml(content)
    if (!labelLanguage) {
      labelLanguage = 'text'
    }
  }

  return renderCodeBlockWrapper(highlighted, codeClassLanguage, labelLanguage, copyLabel)
}

/**
 * 复制文本到剪贴板
 * @param text 要复制的文本
 * @returns 复制成功返回 true，失败返回 false
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  return copyToClipboard(text)
}

/**
 * 处理代码块复制按钮点击事件
 * 从事件目标向上查找复制按钮和代码块，提取文本并复制到剪贴板
 * @param event 鼠标点击事件
 * @returns 复制成功返回 true，失败返回 false，不是复制按钮返回 null
 */
export async function handleCodeBlockCopyClick(event: MouseEvent): Promise<boolean | null> {
  const target = event.target
  if (!(target instanceof HTMLElement)) return null

  const button = target.closest<HTMLElement>('[data-copy-code="true"]')
  if (!button) return null

  event.preventDefault()

  const block = button.closest<HTMLElement>('.hljs-code-block')
  const code = block?.querySelector('code')
  const text = block?.getAttribute('data-copy-text') ?? code?.textContent ?? ''
  if (!text) return false

  return copyTextToClipboard(text)
}
