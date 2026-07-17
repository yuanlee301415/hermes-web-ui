<script lang="ts">
/**
 * 会话滚动快照类型：用于保存和恢复会话切换时的滚动位置
 */
type SessionScrollSnapshot = {
  scrollTop: number;       // 滚动条距离顶部的位置
  scrollHeight: number;    // 滚动区域的总高度
  clientHeight: number;    // 可视区域的高度
  wasNearBottom: boolean;  // 是否靠近底部（用于判断是否自动滚动到底部）
}

/**
 * 底部滚动选项类型：控制滚动动画的参数
 */
type BottomScrollOptions = number | {
  frames?: number;         // 滚动动画的帧数（平滑度）
  keepAliveMs?: number;    // 保持滚动状态的毫秒数（防止内容更新时滚动位置跳动）
}

/**
 * 全局会话滚动位置缓存：key 为会话 ID，value 为滚动快照
 * 用于在不同会话之间切换时保存和恢复滚动位置
 */
const sessionScrollPositions = new Map<string, SessionScrollSnapshot>();
</script>

<script setup lang="ts">
// Vue 核心组合式 API
import { ref, computed, nextTick, onBeforeUnmount, watch } from "vue";
// 国际化支持
import { useI18n } from "vue-i18n";
// Naive UI 组件
import { NButton, NInput } from "naive-ui";
// 自定义组件：虚拟消息列表（优化大量消息的渲染性能）
import VirtualMessageList from "./VirtualMessageList.vue";
// 自定义组件：单条消息项
import MessageItem from "./MessageItem.vue";
// 聊天状态管理
import { useChatStore } from "@/stores/hermes/chat";
// AI 思考动画资源（浅色/深色主题）
import thinkingImageLight from "@/assets/thinking-light.gif";
import thinkingImageDark from "@/assets/thinking-dark.gif";
// 主题切换组合式函数
import { useTheme } from "@/composables/useTheme";
// 工具调用追踪可见性控制
import { useToolTraceVisibility } from "@/composables/useToolTraceVisibility";

// 初始化状态和依赖
const chatStore = useChatStore();
const { t } = useI18n();
const { isDark } = useTheme();
const { toolTraceVisible } = useToolTraceVisibility();

// 虚拟消息列表的引用，用于调用其滚动方法
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null);

// 待处理的初始滚动会话 ID：用于在消息加载完成后执行初始滚动
const pendingInitialScrollSessionId = ref<string | null>(null);

// 初始底部滚动选项：8帧动画，保持1200ms滚动状态
const initialBottomScrollOptions = { frames: 8, keepAliveMs: 1200 };

/**
 * 格式化令牌数：将大数字转换为可读格式（如 1.2M、1.5K）
 * @param n - 令牌数量
 * @returns 格式化后的字符串
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/**
 * 格式化工具执行时长：根据秒数转换为合适的时间单位
 * @param seconds - 执行时长（秒）
 * @returns 格式化后的时间字符串
 */
function formatToolDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return `${mins}m ${secs}s`
}

/**
 * 当前会话中最新的工具调用列表：只获取最后一条用户消息之后的工具调用
 * 按时间倒序排列（最新的在最前面）
 */
const currentToolCalls = computed(() => {
  const msgs = chatStore.messages;
  // 从后往前查找最后一条用户消息的索引
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  // 只筛选最后一条用户消息之后的工具调用，并倒序排列（最新的在最前面）
  const tools = msgs.filter((m, i) => m.role === "tool" && i > lastUserIdx);
  return [...tools].reverse();
});

/**
 * 可见的工具调用列表：过滤掉没有工具名称的调用
 */
const visibleToolCalls = computed(() =>
  currentToolCalls.value.filter((tool) => !!tool.toolName),
);

/**
 * 空状态配置：根据当前会话的 AI 代理类型返回对应的 logo 和提示文本
 */
const emptyState = computed(() => {
  const session = chatStore.activeSession;
  // 确定当前会话使用的编码代理 ID
  const codingAgentId = session?.codingAgentId || 
    (session?.agent === "codex" ? "codex" : 
     session?.agent === "claude" ? "claude-code" : undefined);
  
  // 根据代理类型返回不同的空状态配置
  if (codingAgentId === "codex") {
    return {
      logo: "/coding-agents/codex-openai.png",
      alt: "Codex",
      text: t("chat.emptyStateAgent", { agent: "Codex" }),
    };
  }
  if (codingAgentId === "claude-code") {
    return {
      logo: "/coding-agents/claude-code.svg",
      alt: "Claude Code",
      text: t("chat.emptyStateAgent", { agent: "Claude Code" }),
    };
  }
  // 默认使用 Hermes 品牌
  return {
    logo: "/logo.png",
    alt: "Hermes",
    text: t("chat.emptyState"),
  };
});

/**
 * 实际显示的消息列表：根据多种条件过滤消息
 */
const displayMessages = computed(() => {
  const currentToolIds = new Set(currentToolCalls.value.map((tool) => tool.id));
  return chatStore.messages.filter((m) => {
    // 工具调用消息：仅当工具追踪可见、有工具名称，且不在当前运行中的工具调用列表中时显示
    if (m.role === "tool") {
      return toolTraceVisible.value && !!m.toolName && !(chatStore.isRunActive && currentToolIds.has(m.id));
    }
    // Assistant 消息：当正在流式传输且没有内容但有推理内容，且没有工具调用时，不显示（避免空消息）
    if (
      m.role === "assistant" &&
      m.isStreaming &&
      !m.content?.trim() &&
      !!m.reasoning?.trim() &&
      currentToolCalls.value.length === 0
    ) {
      return false;
    }
    // 其他消息正常显示
    return true;
  });
});

/**
 * 当前会话的排队消息列表：用户发送但尚未处理的消息
 */
const queuedMessages = computed(() => {
  const sid = chatStore.activeSessionId;
  if (!sid) return [];
  return chatStore.queuedUserMessages.get(sid) || [];
});

/**
 * 当前可见的审批请求：AI 需要用户确认才能执行的操作
 */
const visibleApproval = computed(() => chatStore.activePendingApproval);

/**
 * 当前可见的澄清请求：AI 需要用户进一步说明的问题
 */
const visibleClarify = computed(() => chatStore.activePendingClarify);

/**
 * 用户对澄清请求的响应内容
 */
const clarifyResponse = ref("");

/**
 * 是否有浮动面板：审批面板或澄清面板
 */
const hasFloatingPrompt = computed(() => !!visibleApproval.value || !!visibleClarify.value);

/**
 * 虚拟列表的内边距：根据是否有排队消息和浮动面板动态调整底部内边距
 * 确保底部面板不遮挡消息内容
 */
const virtualListPadding = computed(() => {
  if (queuedMessages.value.length > 0 && hasFloatingPrompt.value) return "20px 20px 380px";
  if (queuedMessages.value.length > 0 || hasFloatingPrompt.value) return "20px 20px 260px";
  return "20px";
});

/**
 * 处理审批请求：用户选择允许/拒绝 AI 的操作
 * @param choice - 审批选择：once（一次）、session（当前会话）、always（始终允许）、deny（拒绝）
 */
function handleApproval(choice: "once" | "session" | "always" | "deny") {
  chatStore.respondApproval(choice);
}

/**
 * 处理澄清请求：用户回答 AI 的问题
 * @param response - 用户的响应（可选，未提供时使用输入框中的内容）
 */
function handleClarify(response?: string) {
  const finalResponse = response !== undefined ? response : clarifyResponse.value.trim();
  chatStore.respondToClarify(finalResponse);
  clarifyResponse.value = "";
}

/**
 * 移除排队中的消息：用户取消发送尚未处理的消息
 * @param messageId - 要移除的消息 ID
 */
function removeQueuedMessage(messageId: string) {
  const sid = chatStore.activeSessionId;
  if (!sid) return;
  chatStore.removeQueuedMessage(sid, messageId);
}

/**
 * 格式化排队消息预览：将消息内容规范化并截断到 48 字符
 * @param content - 消息原始内容
 * @returns 预览文本（最多 48 字符）
 */
function queuedPreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

/**
 * 判断是否应该自动跟随滚动到底部：当用户靠近底部时自动滚动
 * @param threshold - 距离底部的阈值（像素），默认为 100
 * @returns 是否应该自动滚动
 */
function shouldAutoFollowBottom(threshold = 100): boolean {
  return listRef.value?.shouldAutoFollowBottom(threshold) ?? true;
}

/**
 * 滚动到底部：带动画效果
 * @param options - 滚动选项（帧数和保持时间）
 */
function scrollToBottom(options?: BottomScrollOptions) {
  listRef.value?.scrollToBottom(options);
}

/**
 * 滚动到指定消息：高亮显示目标消息
 * @param messageId - 目标消息 ID
 */
function scrollToMessage(messageId: string) {
  listRef.value?.scrollToMessage(messageId);
}

/**
 * 滚动到消息内的锚点位置
 * @param messageId - 消息 ID
 * @param anchorId - 锚点 ID
 */
function scrollToAnchor(messageId: string, anchorId: string) {
  listRef.value?.scrollToAnchor(messageId, anchorId);
}

/**
 * 保存会话滚动位置：在会话切换前调用，保存当前滚动状态
 * @param sessionId - 会话 ID
 */
function saveSessionScrollPosition(sessionId: string | null | undefined) {
  if (!sessionId) return;
  const snapshot = listRef.value?.captureViewportPosition() ?? null;
  if (snapshot) sessionScrollPositions.set(sessionId, snapshot);
}

/**
 * 应用初始会话滚动：在切换到新会话后恢复滚动位置
 * @param sessionId - 目标会话 ID
 */
function applyInitialSessionScroll(sessionId: string) {
  // 安全检查：确保当前会话与目标会话一致
  if (chatStore.activeSessionId !== sessionId) return;
  
  // 如果有聚焦的消息，优先滚动到该消息
  if (chatStore.focusMessageId) {
    pendingInitialScrollSessionId.value = null;
    scrollToMessage(chatStore.focusMessageId);
    return;
  }

  // 尝试从缓存中恢复滚动位置
  const snapshot = sessionScrollPositions.get(sessionId);
  if (snapshot) {
    pendingInitialScrollSessionId.value = null;
    // 如果之前靠近底部，则滚动到底部；否则恢复精确位置
    if (snapshot.wasNearBottom) {
      scrollToBottom(initialBottomScrollOptions);
    } else {
      listRef.value?.restoreViewportPosition(snapshot);
    }
    return;
  }

  // 默认滚动到底部
  scrollToBottom(initialBottomScrollOptions);
  // 如果已有消息且不在加载中，完成初始滚动
  if (chatStore.messages.length > 0 && !chatStore.isLoadingMessages) {
    pendingInitialScrollSessionId.value = null;
  }
}

/**
 * 处理滚动到顶部：加载更多历史消息（无限滚动）
 */
async function handleTopReach() {
  const session = chatStore.activeSession;
  // 如果没有更多历史消息或正在加载中，直接返回
  if (!session?.hasMoreBefore || session.isLoadingOlderMessages) return;
  
  // 在加载前捕获当前滚动位置，以便加载后恢复
  const snapshot = listRef.value?.captureScrollPosition() ?? null;
  const loaded = await chatStore.loadOlderMessages(session.id);
  
  // 如果未加载到新消息，直接返回
  if (!loaded) return;
  
  // 等待 DOM 更新后恢复滚动位置，避免视觉跳动
  await nextTick();
  listRef.value?.restoreScrollPosition(snapshot);
}

/**
 * 监听会话切换：保存前一个会话的滚动位置，恢复新会话的滚动位置
 * 使用 immediate: true 确保组件初始化时也能触发
 */
watch(
  () => chatStore.activeSessionId,
  async (id, previousId) => {
    // 保存前一个会话的滚动位置
    saveSessionScrollPosition(previousId);
    if (!id) return;
    // 设置待处理的初始滚动会话 ID
    pendingInitialScrollSessionId.value = id;
    // 等待 DOM 更新后执行初始滚动
    await nextTick();
    applyInitialSessionScroll(id);
  },
  { immediate: true },
);

/**
 * 监听消息数量变化：在消息加载完成后确保滚动位置正确
 * 使用 flush: "post" 确保 DOM 更新后再执行滚动
 */
watch(
  () => [chatStore.activeSessionId, chatStore.messages.length] as const,
  ([id, length]) => {
    // 如果没有会话、滚动尚未完成或没有消息，跳过
    if (!id || pendingInitialScrollSessionId.value !== id || length === 0) return;
    applyInitialSessionScroll(id);
  },
  { flush: "post" },
);

/**
 * 监听消息加载状态：当消息加载完成后，确保滚动到底部
 */
watch(
  () => chatStore.isLoadingMessages,
  async (isLoading, wasLoading) => {
    // 只在加载状态从 true 变为 false 时触发
    if (isLoading || !wasLoading) return;
    
    const id = chatStore.activeSessionId;
    if (!id || pendingInitialScrollSessionId.value !== id) return;
    
    // 如果有聚焦消息，不需要滚动到底部
    if (chatStore.focusMessageId) {
      pendingInitialScrollSessionId.value = null;
      return;
    }
    
    await nextTick();
    // 再次确认会话未变化
    if (chatStore.activeSessionId !== id) return;
    // 滚动到底部
    scrollToBottom(initialBottomScrollOptions);
    pendingInitialScrollSessionId.value = null;
  },
  { flush: "post" },
);

/**
 * 监听聚焦消息变化：当有新的聚焦消息时，滚动到该消息
 */
watch(
  () => chatStore.focusMessageId,
  (messageId) => {
    if (!messageId) return;
    scrollToMessage(messageId);
  },
);

/**
 * 监听运行状态开始：当用户发送消息后，强制滚动到底部一次
 * 确保用户能看到最新的对话内容
 */
watch(
  () => chatStore.isRunActive,
  (v) => {
    if (v) scrollToBottom({ frames: 3, keepAliveMs: 400 });
  },
);

/**
 * 监听最后一条消息内容变化（流式传输）：仅当用户靠近底部时自动跟随滚动
 * 这样用户可以在流式传输期间查看历史消息，不会被强制滚动
 */
watch(
  () => chatStore.messages[chatStore.messages.length - 1]?.content,
  () => {
    // 如果初始滚动尚未完成，跳过
    if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
    // 如果有聚焦消息，滚动到聚焦消息
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId);
      return;
    }
    // 如果用户不在底部附近，不自动滚动
    if (!shouldAutoFollowBottom()) return;
    // 轻量级滚动到底部（1帧动画）
    scrollToBottom({ frames: 1, keepAliveMs: 0 });
  },
);

/**
 * 监听工具调用变化：当工具调用更新时，自动滚动到底部（如果用户靠近底部）
 */
watch(currentToolCalls, () => {
  if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
  if (chatStore.focusMessageId) {
    scrollToMessage(chatStore.focusMessageId);
    return;
  }
  if (!shouldAutoFollowBottom()) return;
  scrollToBottom({ frames: 1, keepAliveMs: 0 });
});

/**
 * 监听排队消息数量变化：当有新消息加入队列时，自动滚动
 */
watch(
  () => queuedMessages.value.length,
  async (length, previousLength) => {
    if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
    if (chatStore.focusMessageId) return;
    // 只在消息数量增加时触发
    if (length <= previousLength) return;
    
    // 使用较大的阈值（320px）判断是否靠近底部
    const wasNearBottom = shouldAutoFollowBottom(320);
    await nextTick();
    // 如果不在底部附近且没有运行中的会话，不滚动
    if (!wasNearBottom && !chatStore.isRunActive) return;
    scrollToBottom({ frames: 4, keepAliveMs: 600 });
  },
);

/**
 * 组件卸载前：保存当前会话的滚动位置，以便下次访问时恢复
 */
onBeforeUnmount(() => {
  saveSessionScrollPosition(chatStore.activeSessionId);
});

/**
 * 暴露给父组件的方法：允许外部控制滚动行为
 */
defineExpose({
  scrollToBottom,    // 滚动到底部
  scrollToMessage,   // 滚动到指定消息
  scrollToAnchor,    // 滚动到消息内的锚点
});
</script>

<template>
  <!-- 消息列表外壳容器：包含虚拟滚动列表和浮动面板 -->
  <div class="message-list-shell">
    <!-- 虚拟消息列表组件：优化大量消息的渲染性能 -->
    <!-- key 属性确保会话切换时重新创建组件 -->
    <VirtualMessageList
      :key="chatStore.activeSessionId || 'chat-empty'"
      ref="listRef"
      :messages="displayMessages"
      :padding="virtualListPadding"
      @top-reach="handleTopReach"
    >
      <!-- 空状态插槽：当没有消息时显示 -->
      <template #empty>
        <div class="empty-state">
          <img :src="emptyState.logo" :alt="emptyState.alt" class="empty-logo" />
          <p>{{ emptyState.text }}</p>
        </div>
      </template>

      <!-- 列表顶部插槽：历史消息加载指示器 -->
      <template #before>
        <div
          v-if="chatStore.activeSession?.hasMoreBefore || chatStore.activeSession?.isLoadingOlderMessages"
          class="history-loader"
        >
          <!-- 加载动画 -->
          <span v-if="chatStore.activeSession?.isLoadingOlderMessages" class="history-loader-spinner"></span>
        </div>
      </template>

      <!-- 消息项插槽：渲染每条消息 -->
      <template #item="{ message: msg }">
        <MessageItem
          :message="msg"
          :highlight="chatStore.focusMessageId === msg.id"
        />
      </template>

      <!-- 列表底部插槽：流式传输指示器和工具调用面板 -->
      <template #after>
        <Transition name="fade">
          <div v-if="chatStore.isRunActive || chatStore.abortState" class="streaming-indicator">
            <!-- AI 思考动画 -->
            <img
              :src="isDark ? thinkingImageDark : thinkingImageLight"
              alt=""
              aria-hidden="true"
              class="thinking-video"
            >
            
            <!-- 工具调用面板：显示当前运行状态、压缩状态和工具调用列表 -->
            <div v-if="visibleToolCalls.length > 0 || chatStore.compressionState || chatStore.abortState" class="tool-calls-panel">
              <!-- 中止状态指示器 -->
              <div v-if="chatStore.abortState" class="tool-call-item compression-item">
                <!-- 中止中图标 -->
                <svg
                  v-if="chatStore.abortState.aborting"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  class="tool-call-icon"
                >
                  <path d="M10 9v6m4-6v6M5 5h14v14H5z" />
                </svg>
                <!-- 已暂停图标 -->
                <svg
                  v-else
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  class="tool-call-icon"
                >
                  <path d="M5 13l4 4L19 7" />
                </svg>
                <!-- 状态文本 -->
                <span class="tool-call-name">
                  {{
                    chatStore.abortState.aborting
                      ? chatStore.abortState.timedOut
                        ? (chatStore.abortState.message || 'Still stopping... new messages will be queued')
                        : 'Pausing... waiting for the run to stop and sync'
                      : chatStore.abortState.synced
                        ? 'Paused and synced'
                        : 'Paused'
                  }}
                </span>
                <!-- 加载动画 -->
                <span
                  v-if="chatStore.abortState.aborting"
                  class="tool-call-spinner"
                ></span>
              </div>

              <!-- 压缩状态指示器 -->
              <div v-if="chatStore.compressionState" class="tool-call-item compression-item">
                <!-- 压缩中图标 -->
                <svg
                  v-if="chatStore.compressionState.compressing"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  class="tool-call-icon"
                >
                  <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <!-- 已压缩图标 -->
                <svg
                  v-else-if="chatStore.compressionState.compressed"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  class="tool-call-icon"
                >
                  <path d="M5 13l4 4L19 7" />
                </svg>
                <!-- 状态文本 -->
                <span class="tool-call-name">
                  {{
                    chatStore.compressionState.compressing
                      ? `Compressing... (${chatStore.compressionState.messageCount} msgs, ~${formatTokens(chatStore.compressionState.beforeTokens)} tokens)`
                      : chatStore.compressionState.compressed
                        ? `Compressed ${chatStore.compressionState.messageCount} msgs: ~${formatTokens(chatStore.compressionState.beforeTokens)} → ~${formatTokens(chatStore.compressionState.afterTokens)} tokens`
                        : `Compression skipped`
                  }}
                </span>
                <!-- 加载动画 -->
                <span
                  v-if="chatStore.compressionState.compressing"
                  class="tool-call-spinner"
                ></span>
              </div>

              <!-- 工具调用列表 -->
              <div
                v-for="tc in visibleToolCalls"
                :key="tc.id"
                class="tool-call-item"
              >
                <!-- 工具图标 -->
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  class="tool-call-icon"
                >
                  <path
                    d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                  />
                </svg>
                <!-- 工具名称 -->
                <span class="tool-call-name">{{ tc.toolName }}</span>
                <!-- 工具调用预览 -->
                <span v-if="tc.toolPreview" class="tool-call-preview">{{ tc.toolPreview }}</span>
                <!-- 执行时长 -->
                <span
                  v-if="tc.toolDuration && tc.toolStatus !== 'running'"
                  class="tool-call-duration"
                  :title="$t('chat.executionDuration')"
                >{{ formatToolDuration(tc.toolDuration) }}</span>
                <!-- 成功图标 -->
                <svg
                  v-if="tc.toolStatus === 'done'"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  class="tool-call-success-icon"
                >
                  <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15"/>
                  <path
                    d="M8 12L11 15L16 9"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    fill="none"
                  />
                </svg>
                <!-- 运行中动画 -->
                <span
                  v-if="tc.toolStatus === 'running'"
                  class="tool-call-spinner"
                ></span>
                <!-- 错误图标 -->
                <svg
                  v-if="tc.toolStatus === 'error'"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  class="tool-call-error-icon"
                >
                  <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15"/>
                  <path
                    d="M15 9L9 15M9 9L15 15"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    fill="none"
                  />
                </svg>
              </div>
            </div>
          </div>
        </Transition>
      </template>
    </VirtualMessageList>

    <!-- 浮动面板堆栈：包含审批面板、澄清面板和消息队列 -->
    <div
      v-if="visibleApproval || visibleClarify || queuedMessages.length > 0"
      class="message-float-stack"
    >
      <!-- 审批面板：AI 需要用户确认才能执行的操作 -->
      <Transition name="queue-float">
        <div v-if="visibleApproval" class="approval-float-panel">
          <div class="float-panel-header">
            <span class="approval-float-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </span>
            <span>{{ t("chat.approvalKicker") }}</span>
          </div>
          <div class="approval-float-title">{{ t("chat.approvalTitle") }}</div>
          <div class="approval-float-desc">{{ visibleApproval.description }}</div>
          <code class="approval-float-command">{{ visibleApproval.command }}</code>
          <div class="approval-float-actions">
            <!-- 内存写入确认按钮 -->
            <NButton
              v-if="visibleApproval.isMemoryWrite"
              size="small"
              type="primary"
              @click="handleApproval('once')"
            >
              {{ t("chat.approvalAgree") }}
            </NButton>
            <!-- 单次允许按钮 -->
            <NButton
              v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('once')"
              size="small"
              type="primary"
              @click="handleApproval('once')"
            >
              {{ t("chat.approvalAllowOnce") }}
            </NButton>
            <!-- 会话内允许按钮 -->
            <NButton
              v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('session')"
              size="small"
              secondary
              @click="handleApproval('session')"
            >
              {{ t("chat.approvalAllowSession") }}
            </NButton>
            <!-- 始终允许按钮 -->
            <NButton
              v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('always')"
              size="small"
              secondary
              @click="handleApproval('always')"
            >
              {{ t("chat.approvalAlways") }}
            </NButton>
            <!-- 拒绝按钮 -->
            <NButton
              v-if="visibleApproval.isMemoryWrite || visibleApproval.choices.includes('deny')"
              size="small"
              type="error"
              secondary
              @click="handleApproval('deny')"
            >
              {{ t("chat.approvalDeny") }}
            </NButton>
          </div>
        </div>
      </Transition>

      <!-- 澄清面板：AI 需要用户进一步说明的问题 -->
      <Transition name="queue-float">
        <div v-if="!visibleApproval && visibleClarify" class="approval-float-panel">
          <div class="float-panel-header">
            <span class="approval-float-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
            <span>{{ t("chat.clarifyKicker") }}</span>
          </div>
          <div class="approval-float-title">{{ t("chat.clarifyTitle") }}</div>
          <div class="approval-float-desc">{{ visibleClarify.question }}</div>
          
          <!-- 选择题模式 -->
          <div v-if="visibleClarify.choices && visibleClarify.choices.length" class="approval-float-actions">
            <NButton
              v-for="choice in visibleClarify.choices"
              :key="choice"
              size="small"
              type="primary"
              @click="handleClarify(choice)"
            >
              {{ choice }}
            </NButton>
            <NButton size="small" type="error" secondary @click="handleClarify('')">
              {{ t("chat.clarifyDismiss") }}
            </NButton>
          </div>
          
          <!-- 自由输入模式 -->
          <div v-else class="clarify-float-input-row">
            <NInput
              v-model:value="clarifyResponse"
              size="small"
              :placeholder="t('chat.clarifyPlaceholder')"
            />
            <NButton size="small" type="primary" @click="handleClarify()">
              {{ t("chat.clarifySubmit") }}
            </NButton>
          </div>
        </div>
      </Transition>

      <!-- 消息队列面板：显示已发送但尚未处理的消息 -->
      <Transition name="queue-float">
        <div v-if="queuedMessages.length > 0" class="queue-float-panel">
          <div class="queue-float-header">
            <!-- 动画轨道图标 -->
            <span class="queue-orbit" aria-hidden="true">
              <span></span>
            </span>
            <span>{{ t('chat.messageQueue') }}</span>
            <!-- 队列消息数量 -->
            <strong>{{ queuedMessages.length }}</strong>
          </div>
          <div class="queue-float-list">
            <div
              v-for="(message, index) in queuedMessages"
              :key="message.id"
              class="queue-float-item"
            >
              <!-- 队列序号 -->
              <span class="queue-index">{{ index + 1 }}</span>
              <!-- 消息预览 -->
              <span class="queue-text">{{ queuedPreview(message.content) }}</span>
              <!-- 删除按钮 -->
              <button
                type="button"
                class="queue-remove"
                :title="t('chat.removeQueuedMessage')"
                @click="removeQueuedMessage(message.id)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped lang="scss">
// 引入全局样式变量
@use "@/styles/variables" as *;

/**
 * 消息列表外壳容器：作为虚拟列表和浮动面板的父容器
 * 使用 flex 布局填充可用空间，支持滚动
 */
.message-list-shell {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

/**
 * 浮动面板堆栈：包含审批面板、澄清面板和消息队列
 * 定位在右下角，使用较高层级确保在最上层显示
 */
.message-float-stack {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 8;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(720px, calc(100% - 32px));
  pointer-events: none;
}

/**
 * 浮动面板基础样式：审批面板和队列面板的共同样式
 */
.approval-float-panel,
.queue-float-panel {
  pointer-events: auto;
  width: 100%;
  padding: 10px;
  border: 1px solid rgba(var(--accent-info-rgb), 0.22);
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(14px);

  // 深色主题下的背景色
  .dark & {
    background: #262626;
  }
}

/**
 * 审批面板特定样式：使用主色调边框
 */
.approval-float-panel {
  border-color: rgba(var(--accent-primary-rgb), 0.24);
}

/**
 * 队列面板特定样式：靠右对齐，宽度较小
 */
.queue-float-panel {
  align-self: flex-end;
  width: min(380px, 100%);
}

/**
 * 浮动面板头部：显示标题和图标
 */
.float-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 8px;
  color: var(--accent-primary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/**
 * 审批面板图标：圆形背景，显示主色调
 */
.approval-float-icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.12);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
}

/**
 * 审批面板标题：加粗显示
 */
.approval-float-title {
  padding: 0 4px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  color: $text-primary;
}

/**
 * 审批面板描述文字：次要文字颜色
 */
.approval-float-desc {
  padding: 0 4px;
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.45;
  color: $text-secondary;
}

/**
 * 审批面板命令代码块：显示要执行的命令
 */
.approval-float-command {
  display: block;
  margin: 8px 4px 0;
  max-height: 96px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: $text-primary;
  background: rgba(255, 255, 255, 0.68);
  border: 1px solid $border-color;
  border-radius: 11px;
  padding: 8px 10px;

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

/**
 * 审批面板操作按钮区域：靠右对齐，支持换行
 */
.approval-float-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 4px 0;
  border-top: 1px solid $border-color;
}

/**
 * 澄清面板输入行：包含输入框和提交按钮
 */
.clarify-float-input-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 4px 0;
  border-top: 1px solid $border-color;

  // 输入框占满剩余空间
  :deep(.n-input) {
    flex: 1 1 auto;
    min-width: 0;
  }

  // 按钮固定宽度
  :deep(.n-button) {
    flex: 0 0 auto;
  }
}

/**
 * 队列面板头部：显示队列标题和消息数量
 */
.queue-float-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 8px;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 600;

  // 消息数量徽章：圆形背景，靠右对齐
  strong {
    margin-left: auto;
    min-width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: rgba(var(--accent-info-rgb), 0.16);
    color: var(--accent-info);
  }
}

/**
 * 队列动画轨道图标：旋转动画效果
 */
.queue-orbit {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(var(--accent-info-rgb), 0.28);
  position: relative;
  animation: queue-spin 1.6s linear infinite;

  // 轨道上的小球
  span {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    right: -2px;
    top: 5px;
    background: var(--accent-info);
    box-shadow: 0 0 12px rgba(var(--accent-info-rgb), 0.65);
  }
}

/**
 * 队列消息列表：垂直排列，支持滚动
 */
.queue-float-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 172px;
  overflow-y: auto;
}

/**
 * 队列消息项：包含序号、预览文本和删除按钮
 */
.queue-float-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 7px 8px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.68);
  color: $text-primary;

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

/**
 * 队列序号：小圆角背景，显示消息在队列中的位置
 */
.queue-index {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--accent-info);
  background: rgba(var(--accent-info-rgb), 0.12);
}

/**
 * 队列消息预览文本：单行截断显示
 */
.queue-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

/**
 * 队列删除按钮：悬停时显示红色背景
 */
.queue-remove {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  background: transparent;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: $error;
    background: rgba($error, 0.1);
  }
}

/**
 * 移动端响应式样式：640px 以下屏幕
 */
@media (max-width: 640px) {
  .message-float-stack {
    left: 8px;
    right: 8px;
    bottom: 8px;
    width: auto;
    gap: 8px;
  }

  .approval-float-panel,
  .queue-float-panel {
    padding: 7px;
    border-radius: 14px;
  }

  .queue-float-header {
    padding: 0 2px;
    font-size: 11px;

    // 隐藏队列标题文字，只显示图标和数量
    span:nth-child(2) {
      display: none;
    }
  }

  .queue-orbit {
    width: 16px;
    height: 16px;

    span {
      width: 5px;
      height: 5px;
      top: 5px;
    }
  }

  .queue-float-list {
    margin-top: 6px;
    max-height: min(220px, 34dvh);
    overflow-y: auto;
  }

  .queue-float-item {
    min-height: 30px;
    padding: 5px 6px;
  }

  .queue-index {
    width: 18px;
    height: 18px;
    border-radius: 6px;
    font-size: 10px;
  }

  .queue-text {
    font-size: 11px;
  }

  .queue-remove {
    width: 22px;
    height: 22px;
  }

  // 审批按钮改为两列网格布局
  .approval-float-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));

    :deep(.n-button) {
      width: 100%;
    }
  }

  // 澄清输入框改为垂直排列
  .clarify-float-input-row {
    flex-direction: column;

    :deep(.n-button) {
      width: 100%;
    }
  }
}

/**
 * 队列旋转动画：轨道图标持续旋转
 */
@keyframes queue-spin {
  to {
    transform: rotate(360deg);
  }
}

/**
 * 队列面板进入/离开过渡动画
 */
.queue-float-enter-active,
.queue-float-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.queue-float-enter-from,
.queue-float-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

/**
 * 空状态样式：居中显示 logo 和提示文本
 */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  gap: 12px;

  .empty-logo {
    width: 48px;
    height: 48px;
    opacity: 0.25;
  }

  p {
    font-size: 14px;
  }
}

/**
 * 历史消息加载器：位于列表顶部，显示加载状态
 */
.history-loader {
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

/**
 * 历史加载器旋转动画：标准的旋转圆环
 */
.history-loader-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 0, 0, 0.16);
  border-top-color: $accent-primary;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;

  .dark & {
    border-color: rgba(255, 255, 255, 0.18);
    border-top-color: $accent-primary;
  }
}

/**
 * 淡入淡出过渡动画：用于流式传输指示器的显示/隐藏
 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.4s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/**
 * 流式传输指示器：显示 AI 思考动画和工具调用面板
 */
.streaming-indicator {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 4px;

  // AI 思考动画图片
  .thinking-video {
    width: 120px;
    height: 213px;
    border-radius: $radius-md;
    object-fit: contain;
    flex-shrink: 0;
  }
}

/**
 * 工具调用面板：垂直排列工具调用项，支持滚动
 */
.tool-calls-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 213px;
  overflow-y: auto;
  padding-top: 4px;
  scrollbar-width: none;
  -ms-overflow-style: none;

  // 隐藏滚动条
  &::-webkit-scrollbar {
    display: none;
  }
}

/**
 * 工具调用项：显示工具名称、预览、时长和状态
 */
.tool-call-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: $text-secondary;
  padding: 3px 8px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: $radius-sm;

  .dark & {
    background: rgba(255, 255, 255, 0.06);
  }

  // 压缩状态项：更小的字体和更淡的颜色
  &.compression-item {
    color: $text-muted;
    font-size: 10px;
  }

  .tool-call-icon {
    flex-shrink: 0;
    color: $text-muted;
  }

  .tool-call-name {
    font-family: $font-code;
    flex-shrink: 0;
  }

  // 工具调用参数预览：单行截断
  .tool-call-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
    color: $text-muted;
  }
}

/**
 * 工具调用运行中动画：小尺寸旋转圆环
 */
.tool-call-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid $text-muted;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

/**
 * 工具调用错误图标：红色叉号
 */
.tool-call-error-icon {
  color: #ff4d4f;
  flex-shrink: 0;
  margin-left: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/**
 * 工具调用执行时长：等宽字体，淡色显示
 */
.tool-call-duration {
  font-size: 10px;
  color: $text-muted;
  font-family: $font-code;
  margin-left: 4px;
  flex-shrink: 0;
}

/**
 * 工具调用成功图标：绿色对勾
 */
.tool-call-success-icon {
  color: #52c41a;
  flex-shrink: 0;
  margin-left: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/**
 * 通用旋转动画：用于加载器和工具调用状态
 */
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
