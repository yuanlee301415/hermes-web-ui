/**
 * Thinking 解析器 - 用于从 Markdown 内容中提取 AI 的思考过程
 * 
 * 核心功能：
 * - 从文本中识别并提取 `<think>`, `<thinking>`, `<reasoning>` 标签内的内容
 * - 支持流式解析（处理未闭合的标签）
 * - 保护代码块（代码块中的标签不会被误识别）
 * - 计算思考内容的字符数
 * - 检测思考标签的边界变化
 */

/**
 * 解析后的 Thinking 结果
 */
export interface ParsedThinking {
  /** 已提取的思考内容片段列表 */
  segments: string[]
  /** 
   * 流式模式下，未闭合标签内的待处理内容
   * 非流式模式下为 null
   */
  pending: string | null
  /** 去除思考标签后的正文内容 */
  body: string
  /** 是否包含思考内容（已提取或待处理） */
  hasThinking: boolean
}

/**
 * 解析选项
 */
export interface ParseOptions {
  /** 是否为流式模式 */
  streaming: boolean
}

/**
 * 匹配思考标签的正则表达式
 * 支持三种标签：<think>、<thinking>、<reasoning>
 * 使用反向引用 \1 确保开闭标签一致
 */
const TAG_RE = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi

/**
 * 代码块占位符前缀（使用空字符 \u0000 避免与普通文本冲突）
 */
const PLACEHOLDER_PREFIX = '\u0000THKCODE'

/**
 * 代码块占位符后缀
 */
const PLACEHOLDER_SUFFIX = '\u0000'

/**
 * 匹配围栏代码块的正则表达式
 * 格式：``` 或 ~~~ 包裹的多行内容
 */
const FENCED_RE = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2\3[ \t]*(?=\n|$)/g

/**
 * 匹配行内代码的正则表达式
 * 格式：`code` 包裹的内容
 */
const INLINE_CODE_RE = /`[^`\n]*`/g

/**
 * 保护代码块 - 将代码块替换为占位符，避免代码块内的标签被误识别
 * 
 * 设计意图：当思考内容包含代码块时，代码块内可能出现类似 `<think>` 的文本
 * 直接解析会误将其当作思考标签，因此需要先将代码块临时替换为占位符
 * 解析完成后再恢复原始内容
 * 
 * @param input 原始文本
 * @returns 包含掩码文本和原始代码块列表的对象
 */
function protectCodeBlocks(input: string): { masked: string; blocks: string[] } {
  const blocks: string[] = []
  // 替换围栏代码块（``` 或 ~~~）
  let masked = input.replace(FENCED_RE, (m) => {
    blocks.push(m)
    return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`
  })
  // 替换行内代码（`code`）
  masked = masked.replace(INLINE_CODE_RE, (m) => {
    blocks.push(m)
    return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`
  })
  return { masked, blocks }
}

/**
 * 恢复代码块 - 将占位符替换回原始代码块内容
 * 
 * @param text 掩码文本
 * @param blocks 原始代码块列表
 * @returns 恢复后的文本
 */
function restoreCodeBlocks(text: string, blocks: string[]): string {
  if (blocks.length === 0) return text

  const placeholderRe = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g')
  let restored = text

  // 循环替换所有占位符，直到没有更多替换发生
  for (let i = 0; i < blocks.length; i += 1) {
    const next = restored.replace(
      placeholderRe,
      (_, idx) => blocks[Number(idx)] ?? '',
    )
    if (next === restored) break
    restored = next
  }

  return restored
}

/**
 * 解析思考内容 - 从文本中提取思考标签内的内容
 * 
 * @param content 原始 Markdown 内容
 * @param opts 解析选项
 * @returns 解析后的思考结果
 */
export function parseThinking(content: string, opts: ParseOptions): ParsedThinking {
  // 先保护代码块，避免误识别
  const { masked, blocks } = protectCodeBlocks(content)

  const segments: string[] = []
  let pending: string | null = null
  let body = ''
  let lastIndex = 0

  // 遍历所有匹配的思考标签
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(masked)) !== null) {
    // 将标签前的内容添加到正文
    body += masked.slice(lastIndex, m.index)
    // 将标签内的内容添加到思考片段
    segments.push(m[2])
    // 更新上次匹配位置
    lastIndex = m.index + m[0].length
  }

  // 获取剩余未处理的内容
  const rest = masked.slice(lastIndex)

  // 检查是否存在未闭合的思考标签（用于流式场景）
  const openRe = /<(think|thinking|reasoning)>([\s\S]*)$/i
  const openMatch = rest.match(openRe)
  if (openMatch) {
    // 将未闭合标签前的内容添加到正文
    body += rest.slice(0, openMatch.index)
    if (opts.streaming) {
      // 流式模式：将未闭合标签内的内容设为待处理
      pending = openMatch[2]
    } else {
      // 非流式模式：将未闭合标签整体视为正文
      body += rest.slice(openMatch.index!)
    }
  } else {
    // 没有未闭合标签，将剩余内容全部添加到正文
    body += rest
  }

  // 恢复代码块并返回结果
  return {
    segments: segments.map(s => restoreCodeBlocks(s, blocks)),
    pending: pending === null ? null : restoreCodeBlocks(pending, blocks),
    body: restoreCodeBlocks(body, blocks),
    hasThinking: segments.length > 0 || pending !== null,
  }
}

/**
 * 计算思考内容的字符数（支持 Unicode 字符）
 * 
 * @param parsed 解析后的思考结果
 * @returns 思考内容的总字符数
 */
export function countThinkingChars(parsed: ParsedThinking): number {
  const len = (s: string) => [...s].length
  return parsed.segments.reduce((a, s) => a + len(s), 0) + len(parsed.pending || '')
}

/**
 * 思考标签边界检测结果
 */
export interface ThinkingBoundary {
  /** 是否在当前增量中开始了新的思考标签 */
  startedAtBoundary: boolean
  /** 是否在当前增量中结束了思考标签 */
  endedAtBoundary: boolean
}

/**
 * 匹配任意思考开始标签的正则
 */
const ANY_OPEN_RE = /<(think|thinking|reasoning)>/i

/**
 * 匹配任意思考结束标签的正则
 */
const ANY_CLOSE_RE = /<\/(think|thinking|reasoning)>/i

/**
 * 检测思考标签的边界变化 - 用于增量更新场景
 * 
 * 场景：流式输出时，需要检测新到来的文本是否包含思考标签的开始或结束
 * 通过比较前后文本中是否存在开/闭标签来判断边界变化
 * 
 * @param prev 之前的文本
 * @param next 更新后的文本（包含之前的内容）
 * @returns 边界检测结果
 */
export function detectThinkingBoundary(prev: string, next: string): ThinkingBoundary {
  const prevMasked = protectCodeBlocks(prev).masked
  const nextMasked = protectCodeBlocks(next).masked
  return {
    // 之前没有开标签，现在有了 → 开始了新的思考
    startedAtBoundary: !ANY_OPEN_RE.test(prevMasked) && ANY_OPEN_RE.test(nextMasked),
    // 之前没有闭标签，现在有了 → 结束了思考
    endedAtBoundary: !ANY_CLOSE_RE.test(prevMasked) && ANY_CLOSE_RE.test(nextMasked),
  }
}
