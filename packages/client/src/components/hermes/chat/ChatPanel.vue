<script setup lang="ts">
import { renameSession, setSessionWorkspace, batchDeleteSessions, exportSession } from "@/api/hermes/sessions";
import type { AvailableModelGroup } from "@/api/hermes/system";
import { fetchCodingAgentsStatus, type CodingAgentId } from "@/api/coding-agents";
import { useChatStore, type Session } from "@/stores/hermes/chat";
import { useAppStore } from "@/stores/hermes/app";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { useSessionBrowserPrefsStore } from "@/stores/hermes/session-browser-prefs";
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NInput,
  NModal,
  NSelect,
  NTooltip,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  useMessage,
  type DropdownOption,
} from "naive-ui";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { copyToClipboard } from "@/utils/clipboard";
// 导入子组件
import FolderPicker from "./FolderPicker.vue";       // 文件夹选择器
import ChatInput from "./ChatInput.vue";             // 聊天输入框
import ConversationMonitorPane from "./ConversationMonitorPane.vue"; // 会话监控面板
import MessageList from "./MessageList.vue";         // 消息列表
import SessionListItem from "./SessionListItem.vue"; // 会话列表项
import DrawerPanel from "./DrawerPanel.vue";         // 抽屉面板
import OutlinePanel from "./OutlinePanel.vue";       // 大纲面板

// 状态管理实例
const chatStore = useChatStore();                    // 聊天状态
const appStore = useAppStore();                      // 应用状态
const profilesStore = useProfilesStore();            // 配置文件状态
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore(); // 会话浏览器偏好设置
const router = useRouter();                          // 路由实例
const message = useMessage();                        // 消息提示工具
const { t } = useI18n();                             // 国际化翻译函数

// 面板显示控制状态
const showDrawer = ref(false);                       // 抽屉面板显示状态
const drawerActiveTab = ref<"terminal" | "files">("files"); // 抽屉激活标签页
const showOutline = ref(false);                      // 大纲面板显示状态
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null); // 消息列表引用

// 当前模式：chat（聊天模式）或 live（实时监控模式）
const currentMode = ref<"chat" | "live">("chat");

// ============ 批量选择模式相关状态 ============
const isBatchMode = ref(false);                      // 是否处于批量选择模式
const selectedSessionKeys = ref<Set<string>>(new Set()); // 已选中会话的键集合
const showBatchDeleteConfirm = ref(false);           // 是否显示批量删除确认框
const isBatchDeleting = ref(false);                  // 是否正在批量删除中

// ============ 响应式布局相关状态 ============
// 同步从媒体查询初始化，确保首次渲染正确
// 在窄视口下，会话列表是绝对定位的覆盖层（z-index 10），覆盖在聊天区域上方
// 如果默认值设为true，onMounted中只会在首次渲染后才将其翻转为false，导致可见的闪烁
// （会话列表短暂覆盖聊天内容，然后"自动修复"——这就是竞态条件）
const showSessions = ref(
  typeof window === "undefined" ||
    !window.matchMedia("(max-width: 768px)").matches,
);
let mobileQuery: MediaQueryList | null = null;       // 移动端媒体查询对象
const isMobile = ref(false);                         // 是否为移动端

// ============ 基础工具函数 ============

/**
 * 生成会话的路由链接
 * @param sessionId 会话ID
 * @returns 路由链接
 */
function sessionHref(sessionId: string) {
  return router.resolve({
    name: "hermes.session",
    params: { sessionId },
  }).href;
}

/**
 * 在新标签页中打开会话
 * @param sessionId 会话ID
 */
function openSessionInNewTab(sessionId: string) {
  if (typeof window === "undefined") return;
  window.open(sessionHref(sessionId), "_blank", "noopener,noreferrer");
}

/**
 * 处理大纲导航事件，滚动到指定消息锚点
 * @param target 目标位置，包含消息ID和锚点ID
 */
function handleOutlineNavigate(target: { messageId: string; anchorId: string }) {
  messageListRef.value?.scrollToAnchor(target.messageId, target.anchorId);
}

/**
 * 处理会话点击事件，跳转到对应会话页面
 * @param sessionId 会话ID
 */
async function handleSessionClick(sessionId: string) {
  await router.push({
    name: "hermes.session",
    params: { sessionId },
  });
  // 在移动端点击会话后关闭会话列表
  if (mobileQuery?.matches) showSessions.value = false;
}

/**
 * 处理移动端媒体查询变化事件
 * @param e 媒体查询事件或媒体查询列表
 */
function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches;
  // 如果进入移动端且会话列表正在显示，则隐藏它
  if (e.matches && showSessions.value) {
    showSessions.value = false;
  }
}

// ============ 生命周期钩子 ============

/**
 * 组件挂载时初始化
 */
onMounted(() => {
  // 设置媒体查询监听
  mobileQuery = window.matchMedia("(max-width: 768px)");
  handleMobileChange(mobileQuery);
  mobileQuery.addEventListener("change", handleMobileChange);
  // 如果配置文件列表为空，获取配置文件
  if (profilesStore.profiles.length === 0) {
    void profilesStore.fetchProfiles();
  }
});

/**
 * 组件卸载时清理
 */
onUnmounted(() => {
  // 移除媒体查询监听
  mobileQuery?.removeEventListener("change", handleMobileChange);
});
// ============ 重命名模态框相关状态 ============
const showRenameModal = ref(false);                   // 是否显示重命名模态框
const renameValue = ref("");                          // 重命名输入值
const renameSessionId = ref<string | null>(null);     // 当前重命名的会话ID
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null); // 重命名输入框引用

// ============ 会话列表过滤相关计算属性 ============
const sessionProfileFilter = computed(() => chatStore.sessionProfileFilter); // 当前配置文件过滤器

/**
 * 配置文件过滤器选项，包含"全部配置文件"和所有可用配置文件
 */
const profileFilterOptions = computed(() => [
  { label: t("chat.allProfiles"), value: "__all__" },
  ...profilesStore.profiles.map((profile) => ({
    label: profile.name,
    value: profile.name,
  })),
]);

/**
 * 处理配置文件过滤器变化
 * @param value 选中的配置文件值
 */
async function handleProfileFilterChange(value: string) {
  chatStore.sessionProfileFilter = value === "__all__" ? null : value;
  await chatStore.loadSessions(chatStore.sessionProfileFilter);
}

/**
 * 将会话按更新时间降序排序（最新的在前）
 * @param items 会话数组
 * @returns 排序后的会话数组
 */
function sortSessionsWithActiveFirst(items: Session[]): Session[] {
  return [...items].sort((a, b) => {
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

/**
 * 已固定的会话列表（按更新时间排序）
 */
const pinnedSessions = computed(() =>
  sortSessionsWithActiveFirst(
    chatStore.sessions.filter((session) =>
      sessionBrowserPrefsStore.isPinned(session.id),
    ),
  ),
);

/**
 * 未固定的会话列表（按更新时间排序）
 */
const unpinnedSessions = computed(() =>
  sortSessionsWithActiveFirst(
    chatStore.sessions.filter(
      (session) => !sessionBrowserPrefsStore.isPinned(session.id),
    ),
  ),
);

/**
 * 监听会话加载状态和会话ID变化，清理不存在的固定会话记录
 */
watch(
  () => [
    chatStore.sessionsLoaded,
    ...chatStore.sessions.map((session) => session.id),
  ],
  (value) => {
    const sessionIds = value.slice(1) as string[];
    if (!value[0] || sessionIds.length === 0) return;
    sessionBrowserPrefsStore.pruneMissingSessions(sessionIds);
  },
  { immediate: true },
);

/**
 * 当前活跃会话的标题，默认为"新聊天"
 */
const activeSessionTitle = computed(
  () => chatStore.activeSession?.title || t("chat.newChat"),
);

/**
 * 头部标题，根据当前模式显示不同内容
 */
const headerTitle = computed(() =>
  currentMode.value === "live"
    ? t("chat.liveSessions")
    : activeSessionTitle.value,
);

// ============ 新建聊天模态框相关状态 ============
const showNewChatModal = ref(false);                  // 是否显示新建聊天模态框
const newChatAgent = ref<"hermes" | "claude-code" | "codex">("hermes"); // 新建聊天使用的代理类型
const newChatAgentMode = ref<"global" | "scoped">("scoped"); // 代理模式：全局或作用域
const newChatProfile = ref<string>("default");        // 新建聊天使用的配置文件
const newChatProvider = ref<string>("");              // 新建聊天使用的模型提供商
const newChatModel = ref<string>("");                 // 新建聊天使用的模型
const newChatBaseUrl = ref<string>("");               // 新建聊天使用的API基础URL
const newChatApiKey = ref<string>("");                // 新建聊天使用的API密钥
const newChatApiMode = ref<"chat_completions" | "codex_responses" | "anthropic_messages">("codex_responses"); // API协议模式
const newChatWorkspace = ref("");                     // 新建聊天的工作区路径
const newChatLoading = ref(false);                    // 新建聊天加载状态
// 需要特殊认证的编码代理提供商集合
const CODING_AGENT_AUTH_PROVIDER_KEYS = new Set(["openai-codex", "copilot", "xai-oauth", "nous"]);

/**
 * 新建聊天的代理选项
 */
const newChatAgentOptions = computed(() => [
  { label: "Hermes", value: "hermes" },
  { label: "Claude Code", value: "claude-code" },
  { label: "Codex", value: "codex" },
]);

/**
 * API协议模式选项
 */
const newChatApiModeOptions = computed(() => [
  { label: t("codingAgents.protocolOpenAiChat"), value: "chat_completions" },
  { label: t("codingAgents.protocolOpenAiResponses"), value: "codex_responses" },
  { label: t("codingAgents.protocolAnthropicMessages"), value: "anthropic_messages" },
]);

/**
 * 代理启动模式选项
 */
const newChatAgentModeOptions = computed(() => [
  { label: t("codingAgents.launchModeGlobal"), value: "global" },
  { label: t("codingAgents.launchModeScoped"), value: "scoped" },
]);

/**
 * 获取指定配置文件的模型组列表
 * @param profile 配置文件名称
 * @returns 模型组列表
 */
function getModelGroupsForProfile(profile: string) {
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  return profileModels?.groups || [];
}

/**
 * 判断提供商是否为编码代理认证提供商
 * @param provider 提供商名称
 * @returns 是否为编码代理认证提供商
 */
function isCodingAgentAuthProvider(provider?: string) {
  return CODING_AGENT_AUTH_PROVIDER_KEYS.has(String(provider || "").toLowerCase());
}

/**
 * 判断新建聊天时是否允许使用指定的模型组
 * @param group 模型组
 * @returns 是否允许
 */
function isNewChatProviderAllowed(group: AvailableModelGroup) {
  // 非编码代理或全局模式下，所有提供商都允许
  if (!(newChatAgent.value !== "hermes" && newChatAgentMode.value === "scoped")) return true;
  // 作用域模式下，排除需要特殊认证的提供商
  return !isCodingAgentAuthProvider(group.provider);
}

/**
 * 获取指定配置文件中可选择的模型组列表
 * @param profile 配置文件名称
 * @returns 可选择的模型组列表
 */
function getSelectableModelGroupsForProfile(profile: string) {
  return getModelGroupsForProfile(profile).filter(isNewChatProviderAllowed);
}

/**
 * 获取指定配置文件的默认模型
 * @param profile 配置文件名称
 * @returns 默认提供商和模型
 */
function getDefaultModelForProfile(profile: string) {
  const groups = getSelectableModelGroupsForProfile(profile);
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  const defaultProvider = profileModels?.default_provider || "";
  const defaultModel = profileModels?.default || "";
  // 优先使用默认提供商的模型组
  const providerGroup = defaultProvider
    ? groups.find((group) => group.provider === defaultProvider)
    : undefined;
  // 如果没有默认提供商或默认提供商不存在，则选择第一个有模型的组
  const fallbackGroup = providerGroup || groups.find((group) => group.models.length > 0);
  return {
    provider: fallbackGroup?.provider || "",
    model: fallbackGroup?.models.includes(defaultModel)
      ? defaultModel
      : fallbackGroup?.models[0] || "",
  };
}

/**
 * 配置文件选项（如果没有配置文件则显示默认选项）
 */
const newChatProfileOptions = computed(() =>
  (profilesStore.profiles.length > 0 ? profilesStore.profiles : [{ name: "default" }]).map((profile) => ({
    label: profile.name,
    value: profile.name,
  })),
);

/**
 * 当前配置文件的可选择模型组列表
 */
const newChatModelGroups = computed(() => {
  return getSelectableModelGroupsForProfile(newChatProfile.value);
});

/**
 * 当前配置文件的提供商选项
 */
const newChatProviderOptions = computed(() =>
  newChatModelGroups.value.map((group) => ({
    label: group.label || group.provider,
    value: group.provider,
  })),
);

/**
 * 当前提供商的模型选项
 */
const newChatModelOptions = computed(() => {
  const group = newChatModelGroups.value.find(
    (item) => item.provider === newChatProvider.value,
  );
  return (group?.models || []).map((model) => ({
    label: appStore.displayModelName(model, group?.provider),
    value: model,
  }));
});

/**
 * 当前选中的提供商模型组
 */
const selectedNewChatProviderGroup = computed(() =>
  newChatModelGroups.value.find((item) => item.provider === newChatProvider.value),
);

// ============ 新建聊天状态判断计算属性 ============
const isNewChatCodingAgent = computed(() => newChatAgent.value !== "hermes"); // 是否为编码代理
const isNewChatGlobalCodingAgent = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "global", // 是否为全局编码代理
);
const newChatUsesProviderModel = computed(() => !isNewChatGlobalCodingAgent.value); // 是否使用提供商模型
const newChatNeedsBaseUrl = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "scoped" && !selectedNewChatProviderGroup.value?.base_url, // 是否需要手动输入Base URL
);
const newChatNeedsApiKey = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "scoped" && !selectedNewChatProviderGroup.value?.api_key, // 是否需要手动输入API Key
);

/**
 * 判断是否可以确认新建聊天（所有必填字段已填写）
 */
const canConfirmNewChat = computed(() => {
  if (!newChatProfile.value) return false;           // 必须选择配置文件
  if (!newChatUsesProviderModel.value) return true;  // 全局编码代理不需要提供商和模型
  if (!newChatProvider.value || !newChatModel.value) return false; // 必须选择提供商和模型
  if (!isNewChatCodingAgent.value) return true;      // Hermes不需要其他验证
  if (!newChatApiMode.value) return false;           // 编码代理必须选择API模式
  if (newChatNeedsBaseUrl.value && !newChatBaseUrl.value.trim()) return false; // 需要Base URL时必须填写
  if (newChatNeedsApiKey.value && !newChatApiKey.value.trim()) return false;   // 需要API Key时必须填写
  return true;
});

/**
 * 根据提供商和Base URL推断默认的API协议模式
 * @param group 模型组
 * @returns API协议模式
 */
function defaultNewChatApiMode(group?: AvailableModelGroup) {
  // 如果模型组已指定API模式，直接使用
  if (group?.api_mode) return group.api_mode;
  const providerKey = String(group?.provider || newChatProvider.value || "").toLowerCase();
  const baseUrl = String(group?.base_url || newChatBaseUrl.value || "").toLowerCase();
  // Anthropic/Claude 使用 anthropic_messages 协议
  if (
    providerKey.includes("claude") ||
    providerKey === "anthropic" ||
    baseUrl.includes("anthropic") ||
    baseUrl.includes("/anthropic")
  ) {
    return "anthropic_messages";
  }
  // DeepSeek、LM Studio、本地服务使用 chat_completions 协议
  if (
    providerKey === "deepseek" ||
    providerKey === "lmstudio" ||
    baseUrl.includes("deepseek") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("localhost")
  ) {
    return "chat_completions";
  }
  // 默认使用 codex_responses 协议
  return "codex_responses";
}

/**
 * 同步更新新建聊天的API协议模式
 */
function syncNewChatApiMode() {
  newChatApiMode.value = defaultNewChatApiMode(selectedNewChatProviderGroup.value);
}

/**
 * 同步更新新建聊天的模型选择（重置为默认值）
 */
function syncNewChatModelSelection() {
  const defaults = getDefaultModelForProfile(newChatProfile.value);
  newChatProvider.value = defaults.provider;
  newChatModel.value = defaults.model;
  newChatBaseUrl.value = "";
  newChatApiKey.value = "";
  syncNewChatApiMode();
}

/**
 * 确保新建聊天的提供商选择有效，如果当前模型不在当前提供商中则重置选择
 */
function ensureNewChatProviderSelection() {
  if (!newChatUsesProviderModel.value) return;
  const currentGroup = selectedNewChatProviderGroup.value;
  // 如果当前提供商有效且当前模型在其模型列表中，只更新API模式
  if (currentGroup && currentGroup.models.includes(newChatModel.value)) {
    syncNewChatApiMode();
    return;
  }
  // 否则重置为默认选择
  syncNewChatModelSelection();
}

/**
 * 监听代理类型、代理模式和配置文件变化，自动调整模型选择
 */
watch(
  () => [newChatAgent.value, newChatAgentMode.value, newChatProfile.value],
  () => ensureNewChatProviderSelection(),
);

/**
 * 打开新建聊天模态框，初始化数据
 */
async function openNewChatModal() {
  showNewChatModal.value = true;
  newChatLoading.value = true;
  try {
    // 如果配置文件列表为空，获取配置文件
    if (profilesStore.profiles.length === 0) await profilesStore.fetchProfiles();
    // 如果模型列表为空，加载模型
    if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) {
      await appStore.loadModels();
    }
    // 重置工作区
    newChatWorkspace.value = "";
    // 设置默认配置文件（优先使用活跃配置文件）
    newChatProfile.value =
      profilesStore.activeProfileName ||
      profilesStore.profiles.find((profile) => profile.active)?.name ||
      profilesStore.profiles[0]?.name ||
      "default";
    // 同步模型选择
    syncNewChatModelSelection();
  } finally {
    newChatLoading.value = false;
  }
}

/**
 * 处理配置文件变化
 * @param value 配置文件名称
 */
function handleNewChatProfileChange(value: string) {
  newChatProfile.value = value;
  syncNewChatModelSelection();
}

/**
 * 处理提供商变化
 * @param value 提供商名称
 */
function handleNewChatProviderChange(value: string) {
  newChatProvider.value = value;
  // 选择第一个可用模型
  newChatModel.value = newChatModelOptions.value[0]?.value || "";
  // 清空手动输入的Base URL和API Key（将从提供商配置中获取）
  newChatBaseUrl.value = "";
  newChatApiKey.value = "";
  // 同步API模式
  syncNewChatApiMode();
}

/**
 * 确认新建聊天，创建会话并跳转
 */
async function confirmNewChat() {
  // 如果选择的是编码代理（非Hermes），检查是否已安装
  if (newChatAgent.value !== "hermes") {
    newChatLoading.value = true;
    try {
      const agentId = newChatAgent.value as CodingAgentId;
      const status = await fetchCodingAgentsStatus();
      const tool = status.tools.find((item) => item.id === agentId);
      // 如果编码代理未安装，提示用户并跳转到安装页面
      if (!tool?.installed) {
        const fallbackName = agentId === "codex" ? "Codex" : "Claude Code";
        message.warning(t("codingAgents.installRequired", { agent: tool?.name || fallbackName }));
        showNewChatModal.value = false;
        await router.push({ name: "hermes.codingAgents" });
        return;
      }
    } catch {
      message.error(t("codingAgents.loadFailed"));
      return;
    } finally {
      newChatLoading.value = false;
    }
  }

  // 构建会话参数
  const group = selectedNewChatProviderGroup.value;
  const source = newChatAgent.value === "hermes" ? "cli" : "coding_agent";
  const isGlobalCodingAgent = source === "coding_agent" && newChatAgentMode.value === "global";
  const agent = newChatAgent.value === "codex"
    ? "codex"
    : newChatAgent.value === "claude-code"
      ? "claude"
      : "hermes";
  
  // 创建新会话
  const session = chatStore.newChat({
    profile: newChatProfile.value,
    provider: isGlobalCodingAgent ? undefined : newChatProvider.value,
    model: isGlobalCodingAgent ? undefined : newChatModel.value,
    source,
    agent,
    codingAgentId: newChatAgent.value === "hermes" ? undefined : newChatAgent.value,
    codingAgentMode: source === "coding_agent" ? newChatAgentMode.value : undefined,
    workspace: newChatWorkspace.value || null,
    // 全局编码代理不需要自定义Base URL和API Key
    baseUrl: source === "coding_agent" && !isGlobalCodingAgent ? group?.base_url || newChatBaseUrl.value.trim() || undefined : undefined,
    apiKey: source === "coding_agent" && !isGlobalCodingAgent ? group?.api_key || newChatApiKey.value.trim() || undefined : undefined,
    apiMode: source === "coding_agent" && !isGlobalCodingAgent ? newChatApiMode.value : undefined,
  });
  
  // 跳转到新会话页面
  await router.push({
    name: "hermes.session",
    params: { sessionId: session.id },
  });
  showNewChatModal.value = false;
}

// ============ 会话链接和复制功能 ============

/**
 * 获取会话所属的配置文件
 * @param sessionId 会话ID
 * @returns 配置文件名称或null
 */
function sessionProfile(sessionId: string): string | null {
  return chatStore.sessions.find((session) => session.id === sessionId)?.profile || null;
}

/**
 * 构建会话的完整URL（包含协议、域名和路径）
 * @param sessionId 会话ID
 * @param profile 配置文件名称（可选）
 * @returns 完整URL
 */
function buildSessionUrl(sessionId: string, profile?: string | null): string {
  const href = router.resolve({
    name: "hermes.session",
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href;
  return `${window.location.origin}${window.location.pathname}${href}`;
}

/**
 * 复制会话链接到剪贴板
 * @param id 会话ID（可选，默认为当前活跃会话）
 */
async function copySessionLink(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(buildSessionUrl(sessionId, sessionProfile(sessionId)));
    if (ok) message.success(t("common.copied"));
    else message.error(t("common.copied") + " ✗");
  }
}

/**
 * 复制会话ID到剪贴板
 * @param id 会话ID（可选，默认为当前活跃会话）
 */
async function copySessionId(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(sessionId);
    if (ok) message.success(t("common.copied"));
    else message.error(t("common.copied") + " ✗");
  }
}

// ============ 会话删除功能 ============

/**
 * 删除单个会话
 * @param id 会话ID
 */
async function handleDeleteSession(id: string) {
  const ok = await chatStore.deleteSession(id);
  if (!ok) {
    message.error(t("common.deleteFailed"));
    return;
  }
  // 从固定列表中移除
  sessionBrowserPrefsStore.removePinned(id);
  message.success(t("chat.sessionDeleted"));
}

// ============ 批量选择和删除功能 ============

/**
 * 切换批量选择模式
 */
function toggleBatchMode() {
  if (isBatchDeleting.value) return;
  isBatchMode.value = !isBatchMode.value;
  // 退出批量模式时清空选择
  if (!isBatchMode.value) {
    selectedSessionKeys.value.clear();
    showBatchDeleteConfirm.value = false;
  }
}

/**
 * 生成会话的唯一选择键（用于批量选择）
 * 使用配置文件和会话ID组合，避免不同配置文件下同ID会话的冲突
 * @param session 会话对象（包含id和profile）
 * @returns 选择键
 */
function sessionSelectionKey(session: Pick<Session, "id" | "profile">): string {
  return `${session.profile || "default"}\u0000${session.id}`;
}

/**
 * 切换单个会话的选择状态
 * @param session 会话对象
 */
function toggleSessionSelection(session: Session) {
  if (isBatchDeleting.value) return;
  const key = sessionSelectionKey(session);
  if (selectedSessionKeys.value.has(key)) {
    selectedSessionKeys.value.delete(key);
  } else {
    selectedSessionKeys.value.add(key);
  }
  // 创建新Set触发响应式更新
  selectedSessionKeys.value = new Set(selectedSessionKeys.value);
  // 清空选择时隐藏删除确认框
  if (selectedSessionKeys.value.size === 0) {
    showBatchDeleteConfirm.value = false;
  }
}

/**
 * 判断会话是否被选中
 * @param session 会话对象
 * @returns 是否被选中
 */
function isSessionSelected(session: Session): boolean {
  return selectedSessionKeys.value.has(sessionSelectionKey(session));
}

/**
 * 执行批量删除操作
 */
async function handleBatchDelete() {
  if (selectedSessionKeys.value.size === 0 || isBatchDeleting.value) return;

  // 构建会话键到会话对象的映射
  const sessionsByKey = new Map(chatStore.sessions.map((session) => [sessionSelectionKey(session), session]));
  // 将选中的键转换为会话列表
  const targets = Array.from(selectedSessionKeys.value)
    .map((key) => sessionsByKey.get(key))
    .filter((session): session is Session => Boolean(session))
    .map((session) => ({ id: session.id, profile: session.profile || null }));
  
  if (targets.length === 0) return;
  
  isBatchDeleting.value = true;
  try {
    const result = await batchDeleteSessions(targets);
    if (result.deleted > 0) {
      // 从固定列表中移除已删除的会话
      for (const target of targets) {
        sessionBrowserPrefsStore.removePinned(target.id);
      }

      // 从本地存储中移除已删除的会话（通过重新加载而非手动过滤）
      await chatStore.loadSessions(chatStore.sessionProfileFilter);

      message.success(t("chat.batchDeleteSuccess", { count: result.deleted }));
      // 如果有删除失败的会话，显示警告
      if (result.failed > 0) {
        message.warning(t("chat.batchDeletePartial", { failed: result.failed }));
      }
    } else {
      message.error(t("chat.batchDeleteFailed"));
    }
  } catch (err: any) {
    message.error(t("chat.batchDeleteFailed"));
  } finally {
    // 重置状态
    isBatchDeleting.value = false;
    showBatchDeleteConfirm.value = false;
    isBatchMode.value = false;
    selectedSessionKeys.value.clear();
  }
}

/**
 * 批量删除确认回调（返回false防止弹窗自动关闭）
 */
function handleBatchDeleteConfirm() {
  void handleBatchDelete();
  return false;
}

/**
 * 全选所有会话（排除当前活跃会话）
 */
function selectAllSessions() {
  if (isBatchDeleting.value) return;
  selectedSessionKeys.value.clear();
  for (const session of chatStore.sessions) {
    // 不选择当前活跃会话
    if (session.id !== chatStore.activeSessionId) {
      selectedSessionKeys.value.add(sessionSelectionKey(session));
    }
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value);
}

/**
 * 当前选中的会话数量
 */
const selectedCount = computed(() => selectedSessionKeys.value.size);

/**
 * 是否可以全选（存在非活跃会话）
 */
const canSelectAll = computed(() => {
  return chatStore.sessions.some(s => s.id !== chatStore.activeSessionId);
});

// ============ 上下文菜单相关状态和逻辑 ============

const contextSessionId = ref<string | null>(null); // 当前右键点击的会话ID

/**
 * 当前右键点击会话的固定状态
 */
const contextSessionPinned = computed(() =>
  contextSessionId.value
    ? sessionBrowserPrefsStore.isPinned(contextSessionId.value)
    : false,
);

/**
 * 当前右键点击的会话对象
 */
const contextSession = computed(() =>
  contextSessionId.value
    ? chatStore.sessions.find((session) => session.id === contextSessionId.value) || null
    : null,
);

/**
 * 上下文菜单选项（根据会话状态动态生成）
 */
const contextMenuOptions = computed(() => {
  const options: DropdownOption[] = [{
    // 固定/取消固定
    label: t(contextSessionPinned.value ? "chat.unpin" : "chat.pin"),
    key: "pin",
  },
  { label: t("chat.rename"), key: "rename" },      // 重命名
  { label: t("chat.setWorkspace"), key: "workspace" }] // 设置工作区

  // 只有CLI来源的会话才能更改模型
  if (contextSession.value?.source === "cli") {
    options.push({ label: t("chat.setModel"), key: "model" })
  }

  // 导出选项（支持完整/压缩，JSON/TXT格式）
  options.push({
    label: t("chat.export"),
    key: "export",
    children: [
      {
        label: t("chat.exportFull"),
        key: "export-full",
        children: [
          { label: "JSON", key: "export-full-json" },
          { label: "TXT", key: "export-full-txt" },
        ],
      },
      {
        label: t("chat.exportCompressed"),
        key: "export-compressed",
        children: [
          { label: "JSON", key: "export-compressed-json" },
          { label: "TXT", key: "export-compressed-txt" },
        ],
      },
    ],
  })
  // 在新标签页打开
  options.push({ label: t("chat.openSessionInNewTab"), key: "open-link" })
  // 复制会话链接
  options.push({ label: t("chat.copySessionLink"), key: "copy-link" })
  // 复制会话ID
  options.push({ label: t("chat.copySessionId"), key: "copy-id" })
  return options
});

/**
 * 处理右键菜单事件
 * @param e 鼠标事件
 * @param sessionId 会话ID
 */
function handleContextMenu(e: MouseEvent, sessionId: string) {
  e.preventDefault();
  contextSessionId.value = sessionId;
  showContextMenu.value = true;
  contextMenuX.value = e.clientX;
  contextMenuY.value = e.clientY;
}

const showContextMenu = ref(false); // 是否显示上下文菜单
const contextMenuX = ref(0);        // 上下文菜单X坐标
const contextMenuY = ref(0);        // 上下文菜单Y坐标

/**
 * 解析导出选项的key，获取导出模式和文件格式
 * @param key 菜单选项key
 * @returns 导出模式和格式，或null
 */
function parseExportKey(key: string): { mode: 'full' | 'compressed'; ext: 'json' | 'txt' } | null {
  if (key === 'export-full-json') return { mode: 'full', ext: 'json' }
  if (key === 'export-full-txt') return { mode: 'full', ext: 'txt' }
  if (key === 'export-compressed-json') return { mode: 'compressed', ext: 'json' }
  if (key === 'export-compressed-txt') return { mode: 'compressed', ext: 'txt' }
  return null
}

/**
 * 处理上下文菜单选择
 * @param key 选中的菜单选项key
 */
async function handleContextMenuSelect(key: string) {
  showContextMenu.value = false;
  if (!contextSessionId.value) return;
  
  switch (key) {
    case "pin":
      // 切换固定状态
      sessionBrowserPrefsStore.togglePinned(contextSessionId.value);
      break;
    case "copy-link":
      // 复制会话链接
      copySessionLink(contextSessionId.value);
      break;
    case "copy-id":
      // 复制会话ID
      copySessionId(contextSessionId.value);
      break;
    case "open-link":
      // 在新标签页打开
      openSessionInNewTab(contextSessionId.value);
      break;
    case "workspace": {
      // 设置工作区
      const session = chatStore.sessions.find(
        (s) => s.id === contextSessionId.value,
      );
      workspaceSessionId.value = contextSessionId.value;
      workspaceValue.value = session?.workspace || "";
      showWorkspaceModal.value = true;
      break;
    }
    case "model":
      // 打开模型选择模态框
      await openSessionModelModal(contextSessionId.value);
      break;
    case "rename": {
      // 打开重命名模态框
      const session = chatStore.sessions.find(
        (s) => s.id === contextSessionId.value,
      );
      renameSessionId.value = contextSessionId.value;
      renameValue.value = session?.title || "";
      showRenameModal.value = true;
      nextTick(() => {
        renameInputRef.value?.focus();
      });
      break;
    }
    default: {
      // 导出会话
      const exportInfo = parseExportKey(key);
      if (exportInfo) {
        const { mode, ext } = exportInfo;
        // 压缩导出时显示加载提示
        const loadingMsg = mode === "compressed" ? message.loading(t("chat.exportCompressing"), { duration: 0 }) : null;
        try {
          await exportSession(contextSessionId.value, mode, ext);
          loadingMsg?.destroy();
          message.success(t("chat.exportSuccess"));
        } catch {
          loadingMsg?.destroy();
          message.error(t("chat.exportFailed"));
        }
      }
    }
  }
}

/**
 * 点击外部时关闭上下文菜单
 */
function handleClickOutside() {
  showContextMenu.value = false;
}

// ============ 重命名会话逻辑 ============

/**
 * 确认重命名会话
 */
async function handleRenameConfirm() {
  if (!renameSessionId.value || !renameValue.value.trim()) return;
  const ok = await renameSession(
    renameSessionId.value,
    renameValue.value.trim(),
  );
  if (ok) {
    // 更新本地会话列表中的标题
    const session = chatStore.sessions.find(
      (s) => s.id === renameSessionId.value,
    );
    if (session) session.title = renameValue.value.trim();
    // 更新活跃会话的标题
    if (chatStore.activeSession?.id === renameSessionId.value) {
      chatStore.activeSession.title = renameValue.value.trim();
    }
    message.success(t("chat.renamed"));
  } else {
    message.error(t("chat.renameFailed"));
  }
  showRenameModal.value = false;
}

// ============ 工作区设置相关状态和逻辑 ============

const showWorkspaceModal = ref(false);   // 是否显示工作区设置模态框
const workspaceValue = ref("");          // 工作区路径值
const workspaceSessionId = ref<string | null>(null); // 当前设置工作区的会话ID

/**
 * 确认设置工作区
 */
async function handleWorkspaceConfirm() {
  if (!workspaceSessionId.value) return;
  const ok = await setSessionWorkspace(
    workspaceSessionId.value,
    workspaceValue.value || null,
  );
  if (ok) {
    // 更新本地会话列表中的工作区
    const session = chatStore.sessions.find(
      (s) => s.id === workspaceSessionId.value,
    );
    if (session) session.workspace = workspaceValue.value || null;
    // 更新活跃会话的工作区
    if (chatStore.activeSession?.id === workspaceSessionId.value) {
      chatStore.activeSession.workspace = workspaceValue.value || null;
    }
    message.success(t("chat.workspaceSet"));
  } else {
    message.error(t("chat.workspaceSetFailed"));
  }
  showWorkspaceModal.value = false;
}

// ============ 会话模型选择相关状态和逻辑 ============

const showSessionModelModal = ref(false);         // 是否显示会话模型选择模态框
const sessionModelSessionId = ref<string | null>(null); // 当前选择模型的会话ID
const sessionModelSearch = ref("");               // 模型搜索关键词
const sessionModelCollapsedGroups = ref<Record<string, boolean>>({}); // 模型组折叠状态
const sessionModelValue = ref("");                // 当前选中的模型
const sessionModelProvider = ref("");             // 当前选中的提供商
const sessionModelCustomInput = ref("");          // 自定义模型输入值
const sessionModelCustomProvider = ref("");       // 自定义模型的提供商

/**
 * 当前会话所属的配置文件
 */
const sessionModelProfile = computed<string | null>(() => {
  const session = chatStore.sessions.find((s) => s.id === sessionModelSessionId.value);
  return session?.profile || null;
});

/**
 * 当前配置文件的基础模型组列表
 */
const sessionModelBaseGroups = computed(() =>
  sessionModelProfile.value ? getModelGroupsForProfile(sessionModelProfile.value) : [],
);

/**
 * 当前配置文件的提供商选项
 */
const sessionModelProviderOptions = computed(() =>
  sessionModelBaseGroups.value.map((group) => ({ label: group.label, value: group.provider })),
);

/**
 * 包含自定义模型的模型组列表（将自定义模型合并到对应的提供商下）
 */
const sessionModelGroupsWithCustom = computed(() =>
  sessionModelBaseGroups.value.map((group) => ({
    ...group,
    models: [
      ...group.models,
      // 添加自定义模型，但排除已存在于基础列表中的模型
      ...(appStore.customModels[group.provider] || []).filter(
        (model) => !group.models.includes(model),
      ),
    ],
  })),
);

/**
 * 根据搜索关键词过滤后的模型组列表
 */
const filteredSessionModelGroups = computed(() => {
  const query = sessionModelSearch.value.trim().toLowerCase();
  if (!query) return sessionModelGroupsWithCustom.value;
  return sessionModelGroupsWithCustom.value
    .map((group) => ({
      ...group,
      // 过滤模型：匹配模型名或显示名
      models: group.models.filter((model) => {
        const displayName = appStore.displayModelName(model, group.provider);
        return model.toLowerCase().includes(query) || displayName.toLowerCase().includes(query);
      }),
    }))
    // 只保留有匹配模型的组，或标签匹配的组
    .filter((group) => group.models.length > 0 || group.label.toLowerCase().includes(query));
});

/**
 * 打开会话模型选择模态框
 * @param sessionId 会话ID
 */
async function openSessionModelModal(sessionId: string) {
  // 如果模型列表为空，先加载模型
  if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) {
    await appStore.loadModels();
  }
  const session = chatStore.sessions.find((s) => s.id === sessionId);
  // 获取默认模型配置
  const defaults = session?.profile
    ? getDefaultModelForProfile(session.profile)
    : { provider: "", model: "" };
  // 初始化模态框状态
  sessionModelSessionId.value = sessionId;
  sessionModelValue.value = session?.model || defaults.model || "";
  sessionModelProvider.value = session?.provider || defaults.provider || "";
  sessionModelCustomProvider.value = sessionModelProvider.value;
  sessionModelSearch.value = "";
  sessionModelCustomInput.value = "";
  sessionModelCollapsedGroups.value = {};
  showSessionModelModal.value = true;
}

/**
 * 判断模型组是否折叠
 * @param provider 提供商名称
 * @returns 是否折叠
 */
function isSessionModelGroupCollapsed(provider: string) {
  return !!sessionModelCollapsedGroups.value[provider];
}

/**
 * 切换模型组的折叠状态
 * @param provider 提供商名称
 */
function toggleSessionModelGroup(provider: string) {
  sessionModelCollapsedGroups.value[provider] = !sessionModelCollapsedGroups.value[provider];
}

/**
 * 判断模型是否为自定义模型
 * @param model 模型名称
 * @param provider 提供商名称
 * @returns 是否为自定义模型
 */
function isCustomSessionModel(model: string, provider: string) {
  return (appStore.customModels[provider] || []).includes(model);
}

/**
 * 获取模型的显示名称
 * @param model 模型名称
 * @param provider 提供商名称
 * @returns 显示名称
 */
function sessionModelDisplayName(model: string, provider: string) {
  return appStore.displayModelName(model, provider);
}

/**
 * 获取模型的别名
 * @param model 模型名称
 * @param provider 提供商名称
 * @returns 别名
 */
function sessionModelAlias(model: string, provider: string) {
  return appStore.getModelAlias(model, provider);
}

/**
 * 选择会话模型
 * @param model 模型名称
 * @param provider 提供商名称
 */
async function selectSessionModel(model: string, provider: string) {
  // 获取模型元数据，检查是否禁用
  const meta = sessionModelBaseGroups.value.find((group) => group.provider === provider)?.model_meta?.[model];
  if (meta?.disabled || !sessionModelSessionId.value) return;
  
  const ok = await chatStore.switchSessionModel(model, provider, sessionModelSessionId.value);
  if (ok) {
    // 更新选中状态
    sessionModelValue.value = model;
    sessionModelProvider.value = provider;
    showSessionModelModal.value = false;
    message.success(t("chat.modelSet"));
  } else {
    message.error(t("chat.modelSetFailed"));
  }
}

/**
 * 提交自定义模型输入
 */
async function handleSessionModelCustomSubmit() {
  const model = sessionModelCustomInput.value.trim();
  const provider = sessionModelCustomProvider.value;
  if (!model || !provider) return;
  await selectSessionModel(model, provider);
}
</script>

<template>
  <div class="chat-panel">
    <div
      v-if="currentMode === 'chat'"
      class="session-backdrop"
      :class="{ active: showSessions }"
      @click="showSessions = false"
    />
    <aside
      v-if="currentMode === 'chat'"
      class="session-list"
      :class="{ collapsed: !showSessions }"
    >
      <div class="session-list-header">
        <span v-if="showSessions" class="session-list-title">{{
          t("chat.webUiSessions")
        }}</span>
        <div class="session-list-actions">
          <button class="session-close-btn" @click="showSessions = false">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <NButton
            v-if="!isBatchMode"
            quaternary
            size="tiny"
            @click="toggleBatchMode"
            :title="t('chat.toggleBatchMode')"
          >
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </template>
          </NButton>
          <NButton
            v-if="isBatchMode"
            quaternary
            size="tiny"
            @click="selectAllSessions"
            :disabled="!canSelectAll || isBatchDeleting"
            :title="t('chat.selectAll')"
          >
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </template>
          </NButton>
          <NPopconfirm
            v-if="isBatchMode && selectedCount > 0"
            v-model:show="showBatchDeleteConfirm"
            :positive-button-props="{ loading: isBatchDeleting, disabled: isBatchDeleting }"
            :negative-button-props="{ disabled: isBatchDeleting }"
            @positive-click="handleBatchDeleteConfirm"
          >
            <template #trigger>
              <NButton quaternary size="tiny" type="error" :loading="isBatchDeleting" :disabled="isBatchDeleting">
                <template #icon>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.confirmBatchDelete', { count: selectedCount }) }}
          </NPopconfirm>
          <NButton
            v-if="isBatchMode"
            quaternary
            size="tiny"
            @click="toggleBatchMode"
            :disabled="isBatchDeleting"
          >
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </template>
          </NButton>
          <NButton quaternary size="tiny" circle @click="openNewChatModal">
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </template>
          </NButton>
        </div>
      </div>
      <div v-if="showSessions" class="session-profile-filter">
        <NSelect
          :value="sessionProfileFilter || '__all__'"
          :options="profileFilterOptions"
          size="small"
          :loading="profilesStore.loading"
          @update:value="handleProfileFilterChange"
        />
      </div>
      <div v-if="showSessions" class="session-items">
        <div
          v-if="chatStore.isLoadingSessions && chatStore.sessions.length === 0"
          class="session-loading"
        >
          {{ t("common.loading") }}
        </div>
        <div v-else-if="chatStore.sessions.length === 0" class="session-empty">
          {{ t("chat.noSessions") }}
        </div>

        <template v-if="pinnedSessions.length > 0">
          <div class="session-group-header session-group-header--static">
            <span class="session-group-label">{{ t("chat.pinned") }}</span>
            <span class="session-group-count">{{ pinnedSessions.length }}</span>
          </div>
          <SessionListItem
            v-for="s in pinnedSessions"
            :key="`pinned-${s.id}`"
            :session="s"
            :active="s.id === chatStore.activeSessionId"
            :pinned="true"
            :can-delete="
              s.id !== chatStore.activeSessionId ||
              chatStore.sessions.length > 1
            "
            :streaming="chatStore.isSessionLive(s.id)"
            :selectable="isBatchMode"
            :selected="isSessionSelected(s)"
            :show-profile="true"
            :to="sessionHref(s.id)"
            @select="handleSessionClick(s.id)"
            @contextmenu="handleContextMenu($event, s.id)"
            @delete="handleDeleteSession(s.id)"
            @toggle-select="toggleSessionSelection(s)"
          />
        </template>

        <SessionListItem
          v-for="s in unpinnedSessions"
          :key="s.id"
          :session="s"
          :active="s.id === chatStore.activeSessionId"
          :pinned="false"
          :can-delete="
            s.id !== chatStore.activeSessionId ||
            chatStore.sessions.length > 1
          "
          :streaming="chatStore.isSessionLive(s.id)"
          :selectable="isBatchMode"
          :selected="isSessionSelected(s)"
          :show-profile="true"
          :to="sessionHref(s.id)"
          @select="handleSessionClick(s.id)"
          @contextmenu="handleContextMenu($event, s.id)"
          @delete="handleDeleteSession(s.id)"
          @toggle-select="toggleSessionSelection(s)"
        />
      </div>
    </aside>

    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      :show="showContextMenu"
      @select="handleContextMenuSelect"
      @clickoutside="handleClickOutside"
    />

    <NModal
      v-model:show="showRenameModal"
      preset="dialog"
      :title="t('chat.renameSession')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      @positive-click="handleRenameConfirm"
    >
      <NInput
        ref="renameInputRef"
        v-model:value="renameValue"
        :placeholder="t('chat.enterNewTitle')"
        @keydown.enter="handleRenameConfirm"
      />
    </NModal>

    <NModal
      v-model:show="showWorkspaceModal"
      preset="dialog"
      :title="t('chat.setWorkspaceTitle')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      style="width: 520px"
      @positive-click="handleWorkspaceConfirm"
    >
      <FolderPicker v-model="workspaceValue" />
    </NModal>

    <NModal
      v-model:show="showSessionModelModal"
      preset="card"
      :title="t('chat.setModelTitle')"
      :style="{ width: 'min(480px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <NInput
        v-model:value="sessionModelSearch"
        :placeholder="t('models.searchPlaceholder')"
        clearable
        size="small"
        class="session-model-search"
      />
      <div class="session-model-list">
        <div v-for="group in filteredSessionModelGroups" :key="group.provider" class="session-model-group">
          <div class="session-model-group-header" @click="toggleSessionModelGroup(group.provider)">
            <svg
              class="session-model-group-arrow"
              :class="{ collapsed: isSessionModelGroupCollapsed(group.provider) }"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="session-model-group-label">{{ group.label }}</span>
            <span class="session-model-group-count">{{ group.models.length }}</span>
          </div>
          <div v-show="!isSessionModelGroupCollapsed(group.provider)" class="session-model-group-items">
            <div
              v-for="model in group.models"
              :key="model"
              class="session-model-item"
              :class="{
                active: model === sessionModelValue && group.provider === sessionModelProvider,
                disabled: !!group.model_meta?.[model]?.disabled,
              }"
              :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
              @click="selectSessionModel(model, group.provider)"
            >
              <span class="session-model-item-label">
                <span class="session-model-item-name">{{ sessionModelDisplayName(model, group.provider) }}</span>
                <span v-if="sessionModelAlias(model, group.provider)" class="session-model-item-id">
                  {{ t('models.aliasCanonical', { model }) }}
                </span>
              </span>
              <span v-if="group.model_meta?.[model]?.preview" class="session-model-badge-preview">{{ t('models.previewBadge') }}</span>
              <span v-if="group.model_meta?.[model]?.disabled" class="session-model-badge-disabled">{{ t('models.disabledBadge') }}</span>
              <span v-if="isCustomSessionModel(model, group.provider)" class="session-model-badge-custom">{{ t('models.customBadge') }}</span>
              <svg
                v-if="model === sessionModelValue && group.provider === sessionModelProvider"
                class="session-model-check"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
        </div>
        <div v-if="filteredSessionModelGroups.length === 0" class="session-model-empty">
          {{ sessionModelSearch ? 'No results' : 'No models' }}
        </div>
        <div class="session-model-custom">
          <div class="session-model-custom-row">
            <NSelect
              v-model:value="sessionModelCustomProvider"
              :options="sessionModelProviderOptions"
              size="small"
              class="session-model-custom-provider"
            />
            <NInput
              v-model:value="sessionModelCustomInput"
              :placeholder="t('models.customModelPlaceholder')"
              size="small"
              class="session-model-custom-input"
              @keydown.enter="handleSessionModelCustomSubmit"
            />
          </div>
          <div class="session-model-custom-hint">
            {{ t('models.customModelHint') }}
          </div>
        </div>
      </div>
    </NModal>

    <NDrawer
      v-model:show="showNewChatModal"
      class="new-chat-drawer"
      placement="right"
      width="min(440px, 100vw)"
      :mask-closable="true"
    >
      <NDrawerContent :title="t('chat.newChat')" closable>
        <div class="new-chat-form">
          <label class="new-chat-field">
            <span class="new-chat-label">{{ t("chat.agent") }}</span>
            <NSelect
              v-model:value="newChatAgent"
              :options="newChatAgentOptions"
              :disabled="newChatLoading"
            />
          </label>
          <label v-if="isNewChatCodingAgent" class="new-chat-field">
            <span class="new-chat-label">{{ t("codingAgents.launchModeScope") }}</span>
            <NRadioGroup v-model:value="newChatAgentMode" name="new-chat-coding-agent-mode">
              <NRadioButton
                v-for="option in newChatAgentModeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </NRadioButton>
            </NRadioGroup>
          </label>
          <label class="new-chat-field">
            <span class="new-chat-label">{{ t("sidebar.profiles") }}</span>
            <NSelect
              :value="newChatProfile"
              :options="newChatProfileOptions"
              :loading="newChatLoading || profilesStore.loading"
              @update:value="handleNewChatProfileChange"
            />
          </label>
          <label v-if="newChatUsesProviderModel" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.provider") }}</span>
            <NSelect
              :value="newChatProvider"
              :options="newChatProviderOptions"
              :disabled="newChatLoading"
              @update:value="handleNewChatProviderChange"
            />
          </label>
          <label v-if="newChatUsesProviderModel" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.models") }}</span>
            <NSelect
              v-model:value="newChatModel"
              :options="newChatModelOptions"
              :disabled="newChatLoading || !newChatProvider"
              filterable
            />
          </label>
          <label v-if="isNewChatCodingAgent && newChatAgentMode === 'scoped'" class="new-chat-field">
            <span class="new-chat-label">{{ t("codingAgents.protocolScope") }}</span>
            <NSelect
              v-model:value="newChatApiMode"
              :options="newChatApiModeOptions"
              :disabled="newChatLoading"
            />
          </label>
          <label v-if="newChatNeedsBaseUrl" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.baseUrl") }}</span>
            <NInput
              v-model:value="newChatBaseUrl"
              :placeholder="t('models.baseUrlPlaceholder')"
            />
          </label>
          <label v-if="newChatNeedsApiKey" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.apiKey") }}</span>
            <NInput
              v-model:value="newChatApiKey"
              type="password"
              show-password-on="click"
              :placeholder="t('models.apiKeyPlaceholder')"
            />
          </label>
          <div class="new-chat-field">
            <span class="new-chat-label">{{ t("chat.workspace") }}</span>
            <FolderPicker v-model="newChatWorkspace" />
          </div>
        </div>
        <template #footer>
          <div class="new-chat-actions">
            <NButton @click="showNewChatModal = false">{{ t("common.cancel") }}</NButton>
            <NButton
              type="primary"
              :disabled="!canConfirmNewChat"
              @click="confirmNewChat"
            >
              {{ t("chat.newChat") }}
            </NButton>
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>

    <div class="chat-main">
      <header class="chat-header">
        <div class="header-left">
          <NButton
            v-if="currentMode === 'chat'"
            quaternary
            size="small"
            @click="showSessions = !showSessions"
            circle
          >
            <template #icon>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </template>
          </NButton>
          <span class="header-session-title">{{ headerTitle }}</span>
          <span
            v-if="chatStore.activeSession?.workspace"
            class="workspace-badge"
            :title="chatStore.activeSession.workspace"
            >📁
            {{
              chatStore.activeSession.workspace.split("/").pop() ||
              chatStore.activeSession.workspace
            }}</span
          >
        </div>
        <div class="header-actions">
          <!-- chat/live mode toggle hidden -->
          <template v-if="currentMode === 'chat'">
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  quaternary
                  size="small"
                  @click="showOutline = !showOutline"
                  circle
                >
                  <template #icon>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <path d="M3 12h18M3 6h18M3 18h18" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t("chat.outlineTitle") }}
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  quaternary
                  size="small"
                  @click="copySessionId()"
                  circle
                >
                  <template #icon>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path
                        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                      />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t("chat.copySessionId") }}
            </NTooltip>
            <NButton size="small" :circle="isMobile" @click="openNewChatModal">
              <template #icon>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </template>
              <template v-if="!isMobile">{{ t("chat.newChat") }}</template>
            </NButton>
          </template>
        </div>
      </header>

      <template v-if="currentMode === 'chat'">
        <div class="chat-content-wrapper">
          <div class="chat-main-content">
            <MessageList ref="messageListRef" />
          </div>
          <OutlinePanel
            v-if="showOutline"
            :messages="chatStore.messages"
            @navigate="handleOutlineNavigate"
          />
        </div>
        <ChatInput />
      </template>
      <ConversationMonitorPane
        v-else
        :human-only="sessionBrowserPrefsStore.humanOnly"
      />
    </div>

    <!-- Floating drawer button -->
    <div class="drawer-button-wrapper">
      <div class="drawer-button" @click="showDrawer = true">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </div>
    </div>

    <DrawerPanel v-model:show="showDrawer" :active-tab="drawerActiveTab" />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.chat-panel {
  display: flex;
  height: 100%;
  position: relative;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}

.session-model-search {
  margin-bottom: 12px;
}

.session-model-list {
  max-height: 50vh;
  overflow-y: auto;
  scrollbar-width: thin;
}

.session-model-group {
  margin-bottom: 4px;
}

.session-model-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  font-size: 12px;
  font-weight: 600;
  color: $text-secondary;
  cursor: pointer;
  border-radius: $radius-sm;
  user-select: none;
  transition: background-color $transition-fast;

  &:hover {
    background-color: $bg-secondary;
  }
}

.session-model-group-arrow {
  flex-shrink: 0;
  transition: transform $transition-fast;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.session-model-group-label {
  flex: 1;
}

.session-model-group-count {
  font-size: 11px;
  color: $text-muted;
  font-weight: 400;
}

.session-model-group-items {
  padding-left: 8px;
}

.session-model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  color: $text-secondary;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    color: $accent-primary;
    font-weight: 500;
  }

  &.disabled {
    opacity: 0.45;
    cursor: not-allowed;

    &:hover {
      background-color: transparent;
      color: $text-secondary;
    }
  }
}

.session-model-item-label {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-model-item-name,
.session-model-item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: $font-code;
}

.session-model-item-name {
  font-size: 12px;
}

.session-model-item-id {
  color: $text-muted;
  font-size: 10px;
  font-weight: 400;
}

.session-model-check {
  flex-shrink: 0;
  color: $accent-primary;
}

.session-model-badge-preview,
.session-model-badge-custom,
.session-model-badge-disabled {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 4px;
  letter-spacing: 0.03em;
}

.session-model-badge-preview {
  color: #fff;
  background: #d97706;
}

.session-model-badge-custom {
  color: #fff;
  background: $accent-primary;
}

.session-model-badge-disabled {
  color: $text-muted;
  background: transparent;
  border: 1px solid $border-color;
  padding: 0 5px;
}

.session-model-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: $text-muted;
}

.session-model-custom {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid $border-color;
}

.session-model-custom-row {
  display: flex;
  gap: 8px;
}

.session-model-custom-provider {
  width: 160px;
  flex-shrink: 0;
}

.session-model-custom-input {
  flex: 1;
}

.session-model-custom-hint {
  margin-top: 6px;
  font-size: 11px;
  color: $text-muted;
}

.session-list {
  width: 220px;
  border-right: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition:
    width $transition-normal,
    opacity $transition-normal;
  overflow: hidden;

  &.collapsed {
    width: 0;
    border-right: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    z-index: 120;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
    width: 280px;

    &.collapsed {
      transform: translateX(-100%);
      opacity: 0;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .session-close-btn {
    display: flex;
  }

  .session-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 110;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.session-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  flex-shrink: 0;
  min-height: 0;
}

.session-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;

  .n-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    min-height: 22px;
  }
}

.session-close-btn {
  display: none;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;
  height: 22px;
  min-height: 22px;
  align-items: center;
  justify-content: center;

  &:hover {
    background: rgba($accent-primary, 0.06);
  }
}

.session-list-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  line-height: 22px;
}

.session-profile-filter {
  margin: 0 8px 10px;
}

.new-chat-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

:deep(.new-chat-drawer .n-drawer-content) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

:deep(.new-chat-drawer .n-drawer-header),
:deep(.new-chat-drawer .n-drawer-footer) {
  flex-shrink: 0;
}

:deep(.new-chat-drawer .n-drawer-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

:deep(.new-chat-drawer .n-drawer-body-content-wrapper) {
  height: 100%;
  overflow-y: auto;
}

:deep(.new-chat-drawer .folder-picker) {
  max-height: 260px;
}

:deep(.new-chat-drawer .folder-tree) {
  max-height: 170px;
}

@media (max-width: $breakpoint-mobile) {
  :deep(.new-chat-drawer .n-drawer-body-content-wrapper) {
    padding-top: 12px;
    padding-bottom: 12px;
  }

  :deep(.new-chat-drawer .folder-picker) {
    max-height: 210px;
  }

  :deep(.new-chat-drawer .folder-tree) {
    max-height: 128px;
  }
}

.new-chat-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.new-chat-label {
  font-size: 12px;
  color: $text-muted;
  font-weight: 500;
}

.new-chat-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.session-group-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 4px;
  cursor: pointer;
  user-select: none;
}

.session-group-header--static {
  cursor: default;
}

.group-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;
  transform: rotate(90deg);

  &.collapsed {
    transform: rotate(0deg);
  }
}

.session-group-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.session-group-count {
  font-size: 10px;
  color: $text-muted;
  font-weight: 400;
}

.session-items {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 12px;
}

.session-loading,
.session-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

:deep(.session-item) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: $radius-sm;
  cursor: pointer;
  text-align: left;
  text-decoration: none;
  color: $text-secondary;
  transition: all $transition-fast;
  margin-bottom: 2px;

  &:hover {
    background: rgba($accent-primary, 0.06);
    color: $text-primary;

    .session-item-delete {
      opacity: 1;
    }
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $text-primary;
    font-weight: 500;
  }

  &.active .session-item-title {
    color: $accent-primary;
  }

  &.missing-models {
    color: #b42318;
    background: rgba(220, 38, 38, 0.08);

    .session-item-title,
    .session-item-profile-name,
    .session-item-time {
      color: #b42318;
    }

    .session-item-model {
      color: #b42318;
      background: rgba(220, 38, 38, 0.12);
    }

    &:hover {
      background: rgba(220, 38, 38, 0.12);
    }
  }
}

:deep(.session-item-content) {
  flex: 1;
  overflow: hidden;
}

:deep(.session-item-title-row) {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

:deep(.session-item-title) {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:deep(.session-item-streaming) {
  display: inline-block;
  flex-shrink: 0;
  margin-right: 4px;
  vertical-align: middle;
  animation: spin 1.2s linear infinite;
  color: $accent-primary;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

:deep(.session-item-pin) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: $accent-primary;
}

:deep(.session-item-time) {
  font-size: 11px;
  color: $text-muted;
}

:deep(.session-item-meta) {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

:deep(.session-item-model) {
  font-size: 10px;
  color: $accent-primary;
  background: rgba($accent-primary, 0.08);
  padding: 0 5px;
  border-radius: 3px;
  line-height: 16px;
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.session-item-delete) {
  flex-shrink: 0;
  opacity: 0.5;
  padding: 2px;
  border: none;
  background: none;
  color: $text-muted;
  cursor: pointer;
  border-radius: 3px;
  transition: all $transition-fast;

  &:hover {
    color: $error;
    background: rgba($error, 0.1);
  }
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.chat-content-wrapper {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
  min-width: 0;
  max-width: 100%;
}

.chat-main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.header-session-title {
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-badge {
  font-size: 10px;
  color: $text-muted;
  background: rgba($text-muted, 0.12);
  padding: 1px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  line-height: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.chat-mode-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: 4px;
}

@media (max-width: $breakpoint-mobile) {
  .chat-header {
    padding: 16px 12px 16px 52px;
  }
}

.workspace-badge {
  font-size: 11px;
  color: $text-muted;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 8px;
  border-radius: 4px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}

// ─── Drawer button ─────────────────────────────────────────────

.drawer-button-wrapper {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 100;
  background: $bg-card;
  border-radius: 50%;
  box-shadow:
    0 0 10px rgba(255, 107, 107, 0.4),
    0 0 20px rgba(255, 107, 107, 0.2);
  animation: rainbow-glow 8s linear infinite;
  transition: all $transition-fast;

  &:hover {
    animation-play-state: paused;
    box-shadow:
      0 0 15px rgba(255, 107, 107, 0.6),
      0 0 30px rgba(255, 107, 107, 0.3);
  }
}

.drawer-button {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(var(--accent-primary-rgb), 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all $transition-fast;

  svg {
    width: 18px;
    height: 18px;
    color: var(--accent-primary);
  }

  &:hover {
    transform: scale(1.1);
  }
}

@keyframes rainbow-glow {
  0% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    border-color: #ff6b6b;
    color: #ff6b6b;
  }
  16.66% {
    box-shadow:
      0 0 0 2px #feca57,
      0 0 10px rgba(254, 202, 87, 0.4),
      0 0 20px rgba(254, 202, 87, 0.2);
    border-color: #feca57;
    color: #feca57;
  }
  33.33% {
    box-shadow:
      0 0 0 2px #48dbfb,
      0 0 10px rgba(72, 219, 251, 0.4),
      0 0 20px rgba(72, 219, 251, 0.2);
    border-color: #48dbfb;
    color: #48dbfb;
  }
  50% {
    box-shadow:
      0 0 0 2px #ff9ff3,
      0 0 10px rgba(255, 159, 243, 0.4),
      0 0 20px rgba(255, 159, 243, 0.2);
    border-color: #ff9ff3;
    color: #ff9ff3;
  }
  66.66% {
    box-shadow:
      0 0 0 2px #54a0ff,
      0 0 10px rgba(84, 160, 255, 0.4),
      0 0 20px rgba(84, 160, 255, 0.2);
    border-color: #54a0ff;
    color: #54a0ff;
  }
  83.33% {
    box-shadow:
      0 0 0 2px #5f27cd,
      0 0 10px rgba(95, 39, 205, 0.4),
      0 0 20px rgba(95, 39, 205, 0.2);
    border-color: #5f27cd;
    color: #5f27cd;
  }
  100% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    border-color: #ff6b6b;
    color: #ff6b6b;
  }
}

@media (max-width: $breakpoint-mobile) {
  .drawer-button-wrapper {
    right: 12px;
  }

  .drawer-button {
    width: 36px;
    height: 36px;

    svg {
      width: 16px;
      height: 16px;
    }
  }
}
</style>
