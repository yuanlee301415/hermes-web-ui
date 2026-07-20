/**
 * Markdown 围栏修复工具函数
 * 
 * 用于处理 LLM 返回的 Markdown 内容中常见的嵌套代码块围栏问题。
 * LLM 经常将完整的 Markdown 答案包裹在外层 ```md 围栏中，
 * 这会导致渲染时标题、列表等变成纯文本。此模块负责：
 * 1. 移除包裹整个内容的外层 Markdown 围栏
 * 2. 修复嵌套代码块围栏的匹配问题，确保内部代码块能正确渲染
 */

/**
 * 识别为 Markdown 围栏的语言标识符集合
 * 当代码块标注为这些语言时，会被视为 Markdown 示例代码块
 */
const MARKDOWN_FENCE_LANGUAGES = new Set(['md', 'markdown', 'mdown', 'mkd'])

/**
 * 围栏信息结构
 * 用于存储解析代码块围栏时提取的详细信息
 */
type FenceInfo = {
  indent: string      // 围栏行前的缩进（最多3个空格）
  marker: string      // 围栏标记符（` 或 ~）
  fence: string       // 完整的围栏标记字符串（如 `````）
  length: number      // 围栏标记的长度（标记符个数）
  info: string        // 围栏后的信息字符串（通常是语言标识符）
}

/**
 * 解析一行文本，判断是否为代码块围栏
 * 
 * @param line - 待解析的文本行
 * @returns 围栏信息对象，如果不是围栏则返回 null
 */
function parseFence(line: string): FenceInfo | null {
  // 匹配规则：最多3个空格缩进 + 至少3个反引号或波浪号 + 可选信息
  const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/)
  if (!match) return null

  const [, indent, fence, rawInfo = ''] = match
  const marker = fence[0]           // 获取第一个标记符（` 或 ~）
  const info = rawInfo.trim()       // 去除首尾空格后的信息字符串

  // CommonMark 规范允许波浪号围栏的信息字符串中包含反引号，
  // 但反引号围栏的信息字符串中不能包含反引号。
  // 保持这种区分可以防止格式错误的反引号文本被误识别为围栏开始。
  if (marker === '`' && info.includes('`')) return null

  return {
    indent,
    marker,
    fence,
    length: fence.length,
    info,
  }
}

/**
 * 将围栏信息序列化为字符串
 * 
 * @param fence - 围栏信息对象
 * @param length - 围栏长度（默认使用原始长度）
 * @param info - 信息字符串（默认使用原始信息）
 * @returns 序列化后的围栏字符串
 */
function serializeFence(fence: FenceInfo, length = fence.length, info = fence.info): string {
  return `${fence.indent}${fence.marker.repeat(length)}${info ? ` ${info}` : ''}`
}

/**
 * 判断围栏是否为 Markdown 示例围栏
 * 
 * @param fence - 围栏信息对象
 * @returns 如果是 Markdown 围栏返回 true，否则返回 false
 */
function isMarkdownFence(fence: FenceInfo): boolean {
  // 提取第一个空格分隔的部分作为语言标识符，并转为小写
  const language = fence.info.split(/\s+/)[0]?.toLowerCase()
  return MARKDOWN_FENCE_LANGUAGES.has(language)
}

/**
 * 判断一行是否为指定围栏的闭合围栏
 * 
 * @param line - 待检查的文本行
 * @param opener - 开始围栏的信息对象
 * @returns 如果是闭合围栏返回 true，否则返回 false
 */
function isClosingFence(line: string, opener: FenceInfo): boolean {
  const fence = parseFence(line)
  return Boolean(
    fence                               // 必须是围栏
    && fence.marker === opener.marker   // 标记符必须相同
    && fence.length >= opener.length    // 长度必须大于等于开始围栏
    && fence.info === '',               // 闭合围栏不能有信息字符串
  )
}

/**
 * 从指定位置向前查找最后一个非空行的索引
 * 
 * @param lines - 文本行数组
 * @param start - 开始查找的位置（默认为数组末尾）
 * @returns 最后一个非空行的索引，如果所有行都为空则返回 -1
 */
function findLastNonEmptyLine(lines: string[], start = lines.length - 1): number {
  let index = start
  while (index >= 0 && lines[index].trim() === '') {
    index -= 1
  }
  return index
}

/**
 * 从文件末尾向前查找与开始围栏匹配的最终闭合围栏
 * 
 * @param lines - 文本行数组
 * @param opener - 开始围栏的信息对象
 * @param start - 开始查找的位置
 * @returns 闭合围栏所在的行索引，未找到返回 -1
 */
function findFinalClosingFence(lines: string[], opener: FenceInfo, start: number): number {
  // 从最后一个非空行开始向前查找
  for (let i = findLastNonEmptyLine(lines); i > start; i -= 1) {
    if (isClosingFence(lines[i], opener)) {
      return i
    }
  }
  return -1
}

/**
 * 开放围栏栈元素结构
 * 用于追踪嵌套围栏的匹配状态
 */
type OpenFence = {
  marker: string      // 围栏标记符
  length: number      // 围栏长度
}

/**
 * 判断给定行范围内的嵌套围栏是否能够正确匹配闭合
 * 
 * 使用栈结构模拟围栏的嵌套：遇到开始围栏入栈，遇到匹配的闭合围栏出栈。
 * 如果最终栈为空且至少遇到过一个围栏，则说明嵌套结构是平衡的。
 * 
 * @param lines - 文本行数组
 * @param marker - 围栏标记符（` 或 ~）
 * @returns 如果嵌套围栏能够平衡返回 true，否则返回 false
 */
function canBalanceNestedFences(lines: string[], marker: string): boolean {
  const stack: OpenFence[] = []
  let sawFence = false

  for (const line of lines) {
    const fence = parseFence(line)
    // 跳过非围栏行或标记符不匹配的围栏
    if (!fence || fence.marker !== marker) continue

    sawFence = true
    const current = stack[stack.length - 1]
    
    // 如果当前围栏没有信息字符串，且栈顶有匹配的开放围栏，且长度足够，则出栈
    if (fence.info === '' && current && fence.length >= current.length) {
      stack.pop()
      continue
    }

    // 在 Markdown 示例中，没有标注的围栏可能是闭合围栏，也可能是嵌套示例的开始。
    // 如果栈中没有等待闭合的围栏，在评估后续候选闭合围栏时，将其视为嵌套示例的开始。
    stack.push({ marker: fence.marker, length: fence.length })
  }

  // 必须遇到过围栏且栈为空才算平衡
  return sawFence && stack.length === 0
}

/**
 * 查找与开始围栏匹配的平衡闭合围栏
 * 
 * 先收集所有可能的候选闭合围栏，然后从后往前检查哪个候选能够使嵌套结构平衡。
 * 
 * @param lines - 文本行数组
 * @param opener - 开始围栏的信息对象
 * @param start - 开始查找的位置
 * @returns 平衡闭合围栏的行索引，未找到返回 -1
 */
function findBalancedClosingFence(lines: string[], opener: FenceInfo, start: number): number {
  const candidates: number[] = []

  // 收集所有符合条件的候选闭合围栏
  for (let i = start; i < lines.length; i += 1) {
    const fence = parseFence(lines[i])
    if (
      fence
      && fence.marker === opener.marker   // 标记符相同
      && fence.info === ''                // 无信息字符串
      && fence.length >= opener.length    // 长度足够
    ) {
      candidates.push(i)
    }
  }

  // 从后往前检查每个候选是否能使嵌套结构平衡
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]
    if (canBalanceNestedFences(lines.slice(start, candidate), opener.marker)) {
      return candidate
    }
  }

  // 如果没有找到平衡的闭合围栏，返回第一个候选或 -1
  return candidates[0] ?? -1
}

/**
 * 找出给定行范围内指定标记符的围栏最大长度
 * 
 * @param lines - 文本行数组
 * @param marker - 围栏标记符（` 或 ~）
 * @returns 最大围栏长度
 */
function maxFenceLength(lines: string[], marker: string): number {
  let maxLength = 0
  for (const line of lines) {
    const fence = parseFence(line)
    if (fence?.marker === marker) {
      maxLength = Math.max(maxLength, fence.length)
    }
  }
  return maxLength
}

/**
 * 提升 Markdown 示例围栏的长度以避免嵌套冲突
 * 
 * 当 Markdown 示例内部包含与外层围栏长度相同的围栏时，会导致解析错误。
 * 此函数通过增加外层围栏的长度（比内部最大围栏长1）来解决这个问题。
 * 
 * @param lines - 文本行数组
 * @returns 处理后的文本行数组
 */
function promoteMarkdownExampleFences(lines: string[]): string[] {
  const output: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const opener = parseFence(lines[i])
    
    // 跳过非围栏行或非 Markdown 围栏
    if (!opener || !isMarkdownFence(opener)) {
      output.push(lines[i])
      continue
    }

    // 查找匹配的平衡闭合围栏
    const balancedClose = findBalancedClosingFence(lines, opener, i + 1)
    if (balancedClose === -1) {
      output.push(lines[i])
      continue
    }

    // 获取围栏内部的内容
    const body = lines.slice(i + 1, balancedClose)
    // 找出内部最大的围栏长度
    const innerMaxLength = maxFenceLength(body, opener.marker)

    // 如果内部围栏长度大于等于外层围栏，需要提升外层围栏长度
    if (innerMaxLength >= opener.length) {
      const promotedLength = innerMaxLength + 1
      // 输出提升后的开始围栏
      output.push(serializeFence(opener, promotedLength))
      output.push(...body)
      // 输出提升后的闭合围栏（无信息字符串）
      output.push(serializeFence(opener, promotedLength, ''))
    } else {
      // 内部围栏长度足够小，无需提升，直接输出原内容
      output.push(lines[i])
      output.push(...body)
      output.push(lines[balancedClose])
    }

    // 跳过已处理的行
    i = balancedClose
  }

  return output
}

/**
 * 修复嵌套 Markdown 围栏问题
 * 
 * LLM 经常将完整的 PR 草稿或 Markdown 答案包裹在外层 ```md 围栏中。
 * 将这个外层包装器显示为代码块会使 UI 看起来像是 Markdown 渲染被破坏了：
 * 标题、列表和行内代码仍然是字面文本。在将内容交给 markdown-it 之前，
 * 需要移除这个外层草稿包装器。
 * 
 * 未包装的草稿仍然可以包含 Markdown 示例，这些示例本身又包含围栏示例。
 * CommonMark 在第一个具有至少开始围栏长度的相同标记符行处关闭围栏，
 * 因此像 ```md ... ```md ... ``` ... ``` 这样格式错误的示例必须通过
 * 使示例的外层围栏长于其内部的字面围栏来规范化。
 * 
 * @param content - 原始 Markdown 内容
 * @returns 修复后的 Markdown 内容
 */
export function repairNestedMarkdownFences(content: string): string {
  // 如果内容中不包含任何围栏标记，直接返回原内容
  if (!content.includes('```') && !content.includes('~~~')) return content

  const lines = content.split('\n')
  const output: string[] = []
  let changed = false

  for (let i = 0; i < lines.length; i += 1) {
    const opener = parseFence(lines[i])
    
    // 跳过非围栏行或非 Markdown 围栏
    if (!opener || !isMarkdownFence(opener)) {
      output.push(lines[i])
      continue
    }

    // 查找匹配的最终闭合围栏
    const finalClose = findFinalClosingFence(lines, opener, i + 1)
    if (finalClose === -1) {
      output.push(lines[i])
      continue
    }

    // 检查闭合围栏是否位于最后一个非空行
    // 只有当 Markdown 围栏包裹整个内容时才移除
    const lastNonEmpty = findLastNonEmptyLine(lines)
    if (finalClose !== lastNonEmpty) {
      output.push(lines[i])
      continue
    }

    // 移除外层围栏，处理内部的嵌套围栏问题
    output.push(...promoteMarkdownExampleFences(lines.slice(i + 1, finalClose)))
    // 添加闭合围栏之后的内容（如果有的话）
    output.push(...lines.slice(finalClose + 1))
    changed = true
    break
  }

  return changed ? output.join('\n') : content
}
