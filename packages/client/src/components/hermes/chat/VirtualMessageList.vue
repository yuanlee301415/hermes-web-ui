<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DynamicScroller,
  DynamicScrollerItem,
  type DynamicScrollerExposed,
  type ScrollToOptions,
} from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

/**
 * 虚拟列表项类型定义，每个消息项必须有唯一的 id
 */
type VirtualItem = {
  id: string | number;
}

/**
 * 锚点对齐方式：start 为顶部对齐，center 为居中对齐
 */
type AnchorAlign = "start" | "center";

/**
 * 锚点目标对象，用于定位到特定消息或锚点元素
 */
type AnchorTarget = {
  token: number;       // 锚点操作的唯一令牌，用于取消过期的锚点操作
  index: number;       // 消息在列表中的索引位置
  messageId: string;   // 消息的唯一标识
  anchorId: string;    // 锚点元素的 DOM id
  align: AnchorAlign;  // 对齐方式
}

/**
 * 滚动到底部的配置选项
 */
type BottomScrollOptions = number | {
  frames?: number;     // 动画帧数，默认 2
  keepAliveMs?: number; // 保持底部状态的时长（毫秒），默认 400
}

/**
 * 视口滚动快照，用于保存和恢复滚动位置
 */
type ViewportScrollSnapshot = {
  scrollTop: number;       // 滚动距离顶部的像素值
  scrollHeight: number;    // 滚动区域的总高度
  clientHeight: number;    // 视口可见高度
  wasNearBottom: boolean;  // 是否接近底部
}

/**
 * 组件属性定义
 */
const props = withDefaults(defineProps<{
  /** 消息列表数据，必须包含唯一 id 字段 */
  messages: VirtualItem[];
  /** 预估的单项高度（像素），用于虚拟滚动计算 */
  estimatedItemHeight?: number;
  /** 预渲染的额外项数（上下各 overscan 项），优化滚动体验 */
  overscan?: number;
  /** 每行之间的间距（像素） */
  rowGap?: number;
  /** 列表内边距，支持 CSS padding 格式 */
  padding?: string;
  /** 触发顶部到达事件的阈值（像素） */
  topThreshold?: number;
}>(), {
  estimatedItemHeight: 180,  // 默认预估高度 180px
  overscan: 8,               // 默认预渲染 8 项
  rowGap: 16,                // 默认行间距 16px
  padding: "20px",           // 默认内边距 20px
  topThreshold: 120,         // 默认顶部阈值 120px
});

/**
 * 组件事件定义
 */
const emit = defineEmits<{
  /** 滚动事件，每次滚动时触发 */
  scroll: [];
  /** 到达顶部事件，当滚动距离顶部小于 topThreshold 时触发 */
  topReach: [];
}>();

/**
 * 组件插槽定义
 */
defineSlots<{
  /** 空列表时显示的内容 */
  empty?: () => any;
  /** 列表内容之前显示的内容 */
  before?: () => any;
  /** 单项消息内容，接收 message 属性 */
  item?: (props: { message: any }) => any;
  /** 列表内容之后显示的内容 */
  after?: () => any;
}>();

/**
 * DOM 引用
 */
const hostRef = ref<HTMLElement | null>(null);           // 宿主容器引用
const scrollerRef = ref<DynamicScrollerExposed<VirtualItem> | null>(null); // 虚拟滚动组件引用

/**
 * 响应式状态
 */
const scrollTop = ref(0);          // 当前滚动距离顶部的像素值
const viewportHeight = ref(0);     // 视口可见高度

/**
 * 滚动到底部相关状态（使用 let 而非 ref，因为不需要响应式）
 */
let keepBottomUntil = 0;              // 保持底部状态的截止时间戳
let bottomFrame: number | null = null; // 滚动到底部动画的 requestAnimationFrame ID
let bottomFrameRemaining = 0;         // 剩余动画帧数
let bottomFrameAttempts = 0;          // 动画尝试次数（用于防止无限循环）

/**
 * 程序化滚动状态
 */
let programmaticScrollUntil = 0;      // 程序化滚动的截止时间戳，用于区分用户滚动和程序滚动
let userDetachedFromBottom = false;   // 用户是否已从底部离开（不再跟随新消息）

/**
 * 锚点定位相关状态
 */
let anchorFrame: number | null = null;          // 锚点对齐动画的 requestAnimationFrame ID
let anchorToken = 0;                            // 锚点操作的递增令牌，用于取消过期操作
let activeAnchorTarget: AnchorTarget | null = null; // 当前激活的锚点目标

/**
 * 视口恢复相关状态
 */
let viewportRestoreFrame: number | null = null; // 视口恢复动画的 requestAnimationFrame ID

/**
 * 计算属性
 */

/**
 * 消息键列表，用于检测消息列表变化
 */
const messageKeys = computed(() => props.messages.map(messageKey));

/**
 * 虚拟滚动的缓冲像素值，取预估高度和预渲染总高度中的较大值
 */
const bufferPx = computed(() => Math.max(props.estimatedItemHeight, props.estimatedItemHeight * props.overscan));

/**
 * 获取消息的唯一键值
 * @param message 消息项
 * @returns 消息的 id 字符串
 */
function messageKey(message: VirtualItem): string {
  return String(message.id);
}

/**
 * 获取滚动容器元素
 * @returns 滚动容器 DOM 元素，若不存在则返回 null
 */
function getScrollerElement(): HTMLElement | null {
  return hostRef.value?.querySelector<HTMLElement>(".virtual-message-list") ?? null;
}

/**
 * 同步视口状态，更新 scrollTop 和 viewportHeight
 */
function syncViewport() {
  const el = getScrollerElement();
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportHeight.value = el.clientHeight;
}

/**
 * 标记程序化滚动开始
 * 在指定时间内（默认 120ms），滚动事件将被视为程序触发而非用户触发
 * @param ms 程序化滚动的持续时间（毫秒）
 */
function markProgrammaticScroll(ms = 120) {
  programmaticScrollUntil = Date.now() + ms;
}

/**
 * 判断当前是否处于程序化滚动状态
 * @returns true 表示当前滚动是程序触发的，false 表示是用户触发的
 */
function isProgrammaticScroll(): boolean {
  return Date.now() < programmaticScrollUntil;
}

/**
 * 取消滚动到底部的动画
 */
function cancelBottomScroll() {
  keepBottomUntil = 0;
  if (bottomFrame != null) {
    cancelAnimationFrame(bottomFrame);
    bottomFrame = null;
  }
  bottomFrameRemaining = 0;
  bottomFrameAttempts = 0;
}

/**
 * 处理滚动事件
 * 1. 同步视口状态
 * 2. 检测用户是否离开底部
 * 3. 触发 scroll 和 topReach 事件
 */
function handleScroll() {
  const previousScrollTop = scrollTop.value;
  syncViewport();
  
  // 如果不是程序化滚动，则检测用户滚动行为
  if (!isProgrammaticScroll()) {
    const delta = scrollTop.value - previousScrollTop;
    // 用户向上滚动（delta 为负），标记用户已离开底部
    if (delta < -1) {
      userDetachedFromBottom = true;
    } else if (isNearBottom(32)) {
      // 用户滚动回到底部附近，重新启用自动跟随
      userDetachedFromBottom = false;
    }
    // 如果用户已离开底部或不在底部附近，取消滚动到底部动画
    if (userDetachedFromBottom || !isNearBottom(96)) {
      cancelBottomScroll();
    }
  }
  
  emit("scroll");
  // 检测是否到达顶部阈值
  if (scrollTop.value <= props.topThreshold) emit("topReach");
}

/**
 * 处理滚轮事件
 * 用户向上滚动时取消自动跟随
 * @param event 滚轮事件
 */
function handleWheel(event: WheelEvent) {
  // deltaY 为负表示向上滚动
  if (event.deltaY < -1) {
    userDetachedFromBottom = true;
    cancelBottomScroll();
  }
}

/**
 * 处理容器尺寸变化事件
 * 尺寸变化时重新同步视口并尝试保持底部位置或锚点对齐
 */
function handleResize() {
  syncViewport();
  // 如果处于保持底部状态或接近底部，重新滚动到底部
  if (Date.now() < keepBottomUntil || isNearBottom(64)) scheduleScrollToBottom(2);
  // 如果有激活的锚点目标，重新对齐锚点
  if (activeAnchorTarget) scheduleAnchorAlignment(activeAnchorTarget.token, 4);
}

/**
 * 判断是否接近底部
 * @param threshold 距离底部的阈值（像素），默认为 200
 * @returns true 表示已接近底部，false 表示距离底部较远
 */
function isNearBottom(threshold = 200): boolean {
  const el = getScrollerElement();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

/**
 * 判断是否应该自动跟随底部（新消息）
 * 用户未离开底部且当前接近底部时返回 true
 * @param threshold 距离底部的阈值（像素），默认为 200
 * @returns true 表示应该自动跟随底部
 */
function shouldAutoFollowBottom(threshold = 200): boolean {
  return !userDetachedFromBottom && isNearBottom(threshold);
}

/**
 * 滚动到底部（异步版本）
 * 设置保持底部状态并在 nextTick 后执行滚动动画
 * @param options 滚动配置，可传入帧数或配置对象
 */
function scrollToBottom(options: BottomScrollOptions = {}) {
  const frames = typeof options === "number" ? options : options.frames ?? 2;
  const keepAliveMs = typeof options === "number" ? 400 : options.keepAliveMs ?? 400;
  userDetachedFromBottom = false;
  keepBottomUntil = Date.now() + keepAliveMs;
  nextTick(() => {
    scheduleScrollToBottom(frames);
  });
}

/**
 * 立即滚动到底部（同步版本）
 * 直接设置 scrollTop 到最大位置
 * @returns true 表示滚动成功，false 表示滚动容器不存在
 */
function setScrollToBottomNow(): boolean {
  const el = getScrollerElement();
  markProgrammaticScroll();
  scrollerRef.value?.scrollToBottom();
  if (el) {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    syncViewport();
    return true;
  }
  return false;
}

/**
 * 调度滚动到底部的动画
 * 使用 requestAnimationFrame 实现平滑滚动，确保在内容变化后能正确滚动到底部
 * @param frames 动画帧数，默认 1
 */
function scheduleScrollToBottom(frames = 1) {
  // 更新剩余帧数，取较大值
  bottomFrameRemaining = Math.max(bottomFrameRemaining, frames);
  // 如果已有动画在运行，不再创建新的
  if (bottomFrame != null) return;

  const step = () => {
    const scrolled = setScrollToBottomNow();
    if (scrolled) {
      // 滚动成功，重置尝试次数并减少剩余帧数
      bottomFrameAttempts = 0;
      bottomFrameRemaining -= 1;
    } else {
      // 滚动失败，增加尝试次数
      bottomFrameAttempts += 1;
    }
    
    // 检查是否应该停止动画
    if (bottomFrameRemaining <= 0 && Date.now() >= keepBottomUntil) {
      bottomFrame = null;
      bottomFrameRemaining = 0;
      bottomFrameAttempts = 0;
      return;
    }
    
    // 防止无限循环，最多尝试 30 次
    if (bottomFrameAttempts > 30) {
      bottomFrame = null;
      bottomFrameRemaining = 0;
      bottomFrameAttempts = 0;
      return;
    }
    
    // 继续下一帧动画
    bottomFrame = requestAnimationFrame(step);
  };

  bottomFrame = requestAnimationFrame(step);
}

/**
 * 查找目标锚点元素
 * 优先查找指定的 anchorId，若不存在则查找消息元素
 * @param messageId 消息的唯一标识
 * @param anchorId 锚点元素的 DOM id
 * @returns 找到的目标元素，若不存在则返回 null
 */
function findTargetElement(messageId: string, anchorId: string): HTMLElement | null {
  const el = getScrollerElement();
  if (!el) return null;

  // 优先查找指定的锚点元素
  const anchor = document.getElementById(anchorId);
  if (anchor instanceof HTMLElement && el.contains(anchor)) return anchor;

  // 查找消息元素
  const message = document.getElementById(`message-${messageId}`);
  if (message instanceof HTMLElement && el.contains(message)) return message;

  return null;
}

/**
 * 对齐元素到视口指定位置
 * 根据 align 参数将目标元素对齐到视口顶部或居中
 * @param targetEl 目标元素
 * @param align 对齐方式：start（顶部）或 center（居中）
 */
function alignElement(targetEl: HTMLElement, align: AnchorAlign) {
  const el = getScrollerElement();
  if (!el) return;

  const scrollerRect = el.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  
  // 计算需要滚动的偏移量
  const delta = align === "center"
    ? targetRect.top + targetRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2)
    : targetRect.top - scrollerRect.top - 24;

  // 只有当偏移量大于 1px 时才执行滚动，避免不必要的滚动
  if (Math.abs(delta) > 1) {
    markProgrammaticScroll();
    el.scrollTop = Math.max(0, el.scrollTop + delta);
  }
  syncViewport();
}

/**
 * 滚动到指定索引的消息项
 * 使用虚拟滚动组件的 scrollToItem 方法
 * @param index 消息索引
 * @param options 滚动选项，包含对齐方式和偏移量
 */
function scrollToItem(index: number, options?: ScrollToOptions) {
  markProgrammaticScroll();
  scrollerRef.value?.scrollToItem(index, options);
  syncViewport();
}

/**
 * 调度锚点对齐动画
 * 使用 requestAnimationFrame 实现多次对齐，确保内容渲染完成后能正确定位
 * @param token 锚点操作的令牌，用于验证操作是否有效
 * @param frames 动画帧数，默认 1
 */
function scheduleAnchorAlignment(token: number, frames = 1) {
  // 取消之前的锚点对齐动画
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);

  const step = (remaining: number) => {
    const target = activeAnchorTarget;
    // 如果目标不存在或令牌不匹配，停止动画
    if (!target || target.token !== token) {
      anchorFrame = null;
      return;
    }

    // 查找目标元素
    const targetEl = findTargetElement(target.messageId, target.anchorId);
    if (targetEl) {
      // 找到目标元素，执行精确对齐
      alignElement(targetEl, target.align);
    } else {
      // 未找到目标元素，使用索引滚动（虚拟滚动方式）
      scrollToItem(target.index, {
        align: target.align,
        offset: target.align === "start" ? -24 : 0,
      });
    }

    // 如果剩余帧数为 1，停止动画
    if (remaining <= 1) {
      anchorFrame = null;
      activeAnchorTarget = null;
      return;
    }
    // 继续下一帧动画
    anchorFrame = requestAnimationFrame(() => step(remaining - 1));
  };

  anchorFrame = requestAnimationFrame(() => step(frames));
}

/**
 * 取消当前的锚点对齐操作
 * 通过递增令牌使正在进行的操作失效
 */
function cancelAnchorAlignment() {
  anchorToken += 1;
  activeAnchorTarget = null;
  if (anchorFrame != null) {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = null;
  }
}

/**
 * 滚动到指定消息（居中对齐）
 * 通过消息 ID 定位并滚动到该消息，使其居中显示
 * @param messageId 消息的唯一标识
 */
function scrollToMessage(messageId: string) {
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return;

  // 取消之前的锚点操作
  cancelAnchorAlignment();
  const token = anchorToken;
  // 设置新的锚点目标
  activeAnchorTarget = {
    token,
    index,
    messageId,
    anchorId: `message-${messageId}`,
    align: "center",
  };

  nextTick(() => {
    // 先使用虚拟滚动定位到大致位置
    scrollToItem(index, { align: "center" });
    // 再通过多帧动画进行精确对齐（8 帧）
    scheduleAnchorAlignment(token, 8);
  });
}

/**
 * 滚动到指定消息内的锚点（顶部对齐）
 * 通过消息 ID 和锚点 ID 定位并滚动到指定位置，使其顶部对齐显示
 * @param messageId 消息的唯一标识
 * @param anchorId 锚点元素的 DOM id
 */
function scrollToAnchor(messageId: string, anchorId: string) {
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return;

  // 取消之前的锚点操作
  cancelAnchorAlignment();
  const token = anchorToken;
  // 设置新的锚点目标
  activeAnchorTarget = {
    token,
    index,
    messageId,
    anchorId,
    align: "start",
  };

  nextTick(() => {
    // 先使用虚拟滚动定位到大致位置，顶部对齐并偏移 -24px
    scrollToItem(index, { align: "start", offset: -24 });
    // 再通过多帧动画进行精确对齐（10 帧，比 scrollToMessage 多以确保精确）
    scheduleAnchorAlignment(token, 10);
  });
}

/**
 * 捕获当前滚动位置
 * 返回 scrollTop 和 scrollHeight，用于在内容变化后恢复位置
 * @returns 滚动位置快照，若容器不存在则返回 null
 */
function captureScrollPosition() {
  const el = getScrollerElement();
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
  };
}

/**
 * 恢复滚动位置
 * 根据之前捕获的快照，计算新的滚动位置并恢复
 * @param snapshot 滚动位置快照
 */
function restoreScrollPosition(snapshot: { scrollTop: number; scrollHeight: number } | null) {
  if (!snapshot) return;
  nextTick(() => {
    const el = getScrollerElement();
    if (!el) return;
    // 计算新的 scrollTop：新的总高度 - 旧的总高度 + 旧的 scrollTop
    const nextScrollTop = Math.max(0, el.scrollHeight - snapshot.scrollHeight + snapshot.scrollTop);
    markProgrammaticScroll();
    scrollerRef.value?.scrollToPosition(nextScrollTop);
    el.scrollTop = nextScrollTop;
    syncViewport();
  });
}

/**
 * 捕获当前视口位置（包含完整信息）
 * 返回 scrollTop、scrollHeight、clientHeight 和是否接近底部
 * @returns 视口滚动快照，若容器不存在则返回 null
 */
function captureViewportPosition(): ViewportScrollSnapshot | null {
  const el = getScrollerElement();
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    wasNearBottom: isNearBottom(64),
  };
}

/**
 * 恢复视口位置
 * 根据之前捕获的完整快照恢复滚动位置，并保持用户的底部跟随状态
 * @param snapshot 视口滚动快照
 * @param frames 动画帧数，默认 4
 */
function restoreViewportPosition(snapshot: ViewportScrollSnapshot | null, frames = 4) {
  if (!snapshot) return;
  // 取消滚动到底部动画
  cancelBottomScroll();
  // 恢复用户的底部跟随状态
  userDetachedFromBottom = !snapshot.wasNearBottom;
  // 取消之前的视口恢复动画
  if (viewportRestoreFrame != null) cancelAnimationFrame(viewportRestoreFrame);

  nextTick(() => {
    let remaining = frames;
    const step = () => {
      const el = getScrollerElement();
      if (!el) {
        viewportRestoreFrame = null;
        return;
      }
      // 计算最大可滚动位置
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      // 确保 scrollTop 在有效范围内
      const nextScrollTop = Math.min(maxScrollTop, Math.max(0, snapshot.scrollTop));
      markProgrammaticScroll();
      scrollerRef.value?.scrollToPosition(nextScrollTop);
      el.scrollTop = nextScrollTop;
      syncViewport();

      remaining -= 1;
      if (remaining <= 0) {
        viewportRestoreFrame = null;
        return;
      }
      viewportRestoreFrame = requestAnimationFrame(step);
    };
    viewportRestoreFrame = requestAnimationFrame(step);
  });
}

/**
 * ResizeObserver 实例，用于监听滚动容器的尺寸变化
 */
let resizeObserver: ResizeObserver | null = null;

/**
 * 组件挂载时的初始化逻辑
 */
onMounted(() => {
  nextTick(() => {
    // 同步初始视口状态
    syncViewport();
    const el = getScrollerElement();
    // 创建 ResizeObserver 监听容器尺寸变化
    if (el && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(el);
    }
  });
});

/**
 * 组件卸载前的清理逻辑
 */
onBeforeUnmount(() => {
  // 取消所有动画
  cancelBottomScroll();
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);
  if (viewportRestoreFrame != null) cancelAnimationFrame(viewportRestoreFrame);
  // 断开 ResizeObserver
  resizeObserver?.disconnect();
});

/**
 * 监听消息列表变化
 * 当消息键列表变化时，取消锚点对齐并同步视口
 */
watch(messageKeys, () => {
  cancelAnchorAlignment();
  nextTick(syncViewport);
});

/**
 * 暴露给父组件的方法
 */
defineExpose({
  isNearBottom,              // 判断是否接近底部
  shouldAutoFollowBottom,    // 判断是否应该自动跟随底部
  scrollToBottom,            // 滚动到底部
  scrollToMessage,           // 滚动到指定消息（居中）
  scrollToAnchor,            // 滚动到指定锚点（顶部）
  captureScrollPosition,     // 捕获滚动位置
  restoreScrollPosition,     // 恢复滚动位置
  captureViewportPosition,   // 捕获视口位置（完整）
  restoreViewportPosition,   // 恢复视口位置（完整）
});
</script>

<template>
  <!-- 虚拟消息列表宿主容器 -->
  <div
    ref="hostRef"
    class="virtual-message-list-host"
    :style="{ '--virtual-row-gap': `${rowGap}px`, '--virtual-list-padding': padding }"
  >
    <!-- 虚拟滚动组件 -->
    <DynamicScroller
      ref="scrollerRef"
      class="virtual-message-list"
      :items="messages"
      key-field="id"
      :min-item-size="estimatedItemHeight"
      :buffer="bufferPx"
      :flow-mode="true"
      :prerender="overscan"
      @scroll.passive="handleScroll"
      @wheel.passive="handleWheel"
      @resize="handleResize"
      @visible="syncViewport"
    >
      <!-- 列表内容之前的插槽 -->
      <template #before>
        <slot v-if="messages.length > 0" name="before" />
      </template>
      <!-- 消息列表项模板 -->
      <template #default="{ item, index, active }">
        <DynamicScrollerItem
          :item="item"
          :index="index"
          :active="active"
          class="virtual-row"
        >
          <!-- 仅在项处于活跃状态（在视口内）时渲染 -->
          <slot v-if="active" name="item" :message="item" />
        </DynamicScrollerItem>
      </template>
      <!-- 列表内容之后的插槽 -->
      <template #after>
        <slot v-if="messages.length > 0" name="after" />
      </template>
    </DynamicScroller>
    <!-- 空列表状态插槽 -->
    <div v-if="messages.length === 0 && $slots.empty" class="virtual-message-list-empty">
      <slot name="empty" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

/**
 * 虚拟消息列表宿主容器样式
 * 使用 flex 布局确保容器能正确填充父容器
 */
.virtual-message-list-host {
  flex: 1;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  display: flex;
  position: relative;
  animation: message-list-fade-in 1.5s ease both;
}

/**
 * 虚拟滚动容器样式
 */
.virtual-message-list {
  flex: 1;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  padding: var(--virtual-list-padding);
  box-sizing: border-box;
  background-color: $bg-card;

  /**
   * 深色模式下的背景色
   */
  .dark & {
    background-color: #333333;
  }
}

/**
 * 虚拟列表项样式
 */
.virtual-row {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  padding-bottom: var(--virtual-row-gap);
}

/**
 * 空列表状态容器样式
 * 使用绝对定位覆盖在滚动容器之上
 */
.virtual-message-list-empty {
  position: absolute;
  inset: var(--virtual-list-padding);
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  pointer-events: auto;
}

/**
 * 空列表状态内部元素样式
 */
.virtual-message-list-empty :deep(.empty-state) {
  width: 100%;
  height: 100%;
  min-height: 0;
}

/**
 * 列表淡入动画
 */
@keyframes message-list-fade-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

</style>
