// sidepanel.js — 侧边栏主逻辑（全文上下文模式）

const $ = (id) => document.getElementById(id);

const els = {
  agentSelect: $("agent-select"),
  settingsBtn: $("settings-btn"),
  contextText: $("context-text"),
  contextMeta: $("context-meta"),
  refreshSelection: $("refresh-selection"),
  fullDocStatus: $("full-doc-status"),
  chat: $("chat"),
  chatEmpty: $("chat-empty"),
  userInput: $("user-input"),
  sendBtn: $("send-btn"),
  clearBtn: $("clear-btn"),
  hint: $("hint"),
  setupBanner: $("setup-banner"),
  openMinimaxBtn: $("open-minimax-btn"),
  openSettingsBtn: $("open-settings-btn"),
  webGuideCard: $("web-guide-card"),
  guideTask: $("guide-task"),
  startGuideBtn: $("start-guide-btn"),
  guideProgress: $("guide-progress"),
  guideNextBtn: $("guide-next-btn"),
};

const MINIMAX_API_URL = "https://platform.minimaxi.com/user-center/basic-information/interface-key";

const state = {
  agentId: null,
  contextText: "",
  contextUrl: "",
  fullDoc: null,        // { fullText, numPages, url }
  pdfLoadedAt: null,
  pdfLoading: false,
  messages: [],
  currentRequestId: null,
  guide: null,
};

function uid() {
  return "req_" + Math.random().toString(36).slice(2, 10);
}

function renderMarkdownLite(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function formatNum(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + " 万";
  return String(n);
}

// ---- 启动 ----
async function init() {
  bindEvents();
  await loadAgentList();
  await loadContext();
  await tryLoadFullDoc();
  await restoreChat();
  await initWebGuide();
  els.userInput.focus();
}

function bindEvents() {
  els.sendBtn.addEventListener("click", onSend);
  els.clearBtn.addEventListener("click", onClear);
  els.userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  els.agentSelect.addEventListener("change", () => {
    state.agentId = els.agentSelect.value;
    chrome.storage.sync.set({ defaultAgent: state.agentId });
  });
  els.settingsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  els.openMinimaxBtn?.addEventListener("click", () => {
    chrome.tabs.create({ url: MINIMAX_API_URL });
  });
  els.openSettingsBtn?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  els.refreshSelection.addEventListener("click", refreshSelectionFromPage);
  els.startGuideBtn?.addEventListener("click", startWebGuide);
  els.guideNextBtn?.addEventListener("click", advanceGuide);

  // 📁 选择 PDF 文件
  const fileInput = document.getElementById("pdf-file-input");
  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handlePdfFile(file);
    });
  }

  // 侧栏保持打开时，右键选择新的段落后实时刷新上下文。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    if (changes.pendingPrompt) {
      handleNewPendingPrompt(changes.pendingPrompt.newValue);
    }
    if (changes.selection && !state.contextText) {
      const text = changes.selection.newValue || "";
      if (text) {
        state.contextText = text;
        state.contextUrl = changes.selectionUrl?.newValue || state.contextUrl;
        renderContext();
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "pdf-ai/guide-result" && msg.requestId === state.currentRequestId) {
      if (msg.error || !msg.guide?.steps?.length) {
        flashHint(msg.error || "没有生成有效教程");
      } else {
        state.guide = { steps: msg.guide.steps, index: 0 };
        showGuideStep();
      }
      return;
    }
    if (!msg || !msg.requestId || msg.requestId !== state.currentRequestId) return;
    if (msg.type === "pdf-ai/stream") appendStreamDelta(msg.delta);
    else if (msg.type === "pdf-ai/done") finalizeStream();
    else if (msg.type === "pdf-ai/error") appendStreamError(msg.error);
  });
}

async function initWebGuide() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const meta = await chrome.tabs.sendMessage(tab.id, { type: "pdf-ai/get-page-meta" });
    if (meta?.ok && !meta.isPdf && els.webGuideCard) els.webGuideCard.hidden = false;
  } catch (_) {}
}

async function startWebGuide() {
  const task = els.guideTask?.value.trim();
  if (!task) return flashHint("请先描述你想在网页上完成的操作");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !state.agentId) return flashHint("当前页面或 AI 配置不可用");
  els.startGuideBtn.disabled = true;
  els.startGuideBtn.textContent = "生成中…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "pdf-ai/guide", tabId: tab.id, task, agentId: state.agentId, requestId: uid() });
    if (!res?.ok) throw new Error(res?.error || "生成教程失败");
    state.currentRequestId = res.requestId;
    els.guideProgress.hidden = false;
    els.guideProgress.textContent = "正在分析当前网页…";
  } catch (e) {
    flashHint(e.message || String(e));
  } finally {
    els.startGuideBtn.disabled = false;
    els.startGuideBtn.textContent = "生成网页教程";
  }
}

async function showGuideStep() {
  const step = state.guide.steps[state.guide.index];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await chrome.tabs.sendMessage(tab.id, { type: "pdf-ai/highlight-guide-element", index: step.targetIndex });
  if (!r?.ok) return flashHint(r?.error || "目标元素已变化，请重新生成教程");
  els.guideProgress.hidden = false;
  els.guideProgress.innerHTML = `<b>第 ${state.guide.index + 1}/${state.guide.steps.length} 步</b>：${escapeHtml(step.instruction)}<br><small>${escapeHtml(step.nextHint || "完成后点击下一步")}</small>`;
  els.guideNextBtn.hidden = false;
  els.guideNextBtn.textContent = state.guide.index + 1 >= state.guide.steps.length ? "完成教程" : "我已完成，下一步";
}

async function advanceGuide() {
  if (!state.guide) return;
  state.guide.index++;
  if (state.guide.index >= state.guide.steps.length) {
    els.guideProgress.textContent = "教程完成";
    els.guideNextBtn.hidden = true;
    state.guide = null;
    return;
  }
  await showGuideStep();
}

function handleNewPendingPrompt(pending) {
  if (!pending) return;
  if (pending.text) {
    state.contextText = pending.text;
    state.contextUrl = pending.pdfUrl || state.contextUrl;
    if (pending.agent) {
      els.agentSelect.value = pending.agent;
      state.agentId = pending.agent;
    }
    renderContext();
    if (pending.defaultQuestion) els.userInput.value = pending.defaultQuestion;
  }
  if (pending.hasFullText) {
    setFullDocStatus({
      ok: true,
      numPages: pending.pdfNumPages,
      chars: pending.pdfChars,
      url: pending.pdfUrl,
    });
  } else if (pending.pdfUrl) {
    setFullDocStatus({
      ok: false,
      url: pending.pdfUrl,
      error: "Chrome 不允许扩展读取 PDF，请点下方按钮手动选同一份 PDF",
    });
    showPdfPicker(true, "请选择同一份 PDF 文件");
  }
}

// ---- agent 列表 ----
async function loadAgentList() {
  const config = await getConfig();
  els.agentSelect.innerHTML = "";
  const agents = config.agents || {};
  const entries = Object.entries(agents);
  if (entries.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（未配置 agent）";
    els.agentSelect.appendChild(opt);
    return;
  }
  for (const [id, a] of entries) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = a.label || id;
    if (!a.apiKey) opt.textContent += " ⚠️ 未配置 key";
    els.agentSelect.appendChild(opt);
  }
  state.agentId = config.defaultAgent || entries[0][0];
  els.agentSelect.value = state.agentId;
  const hasAnyKey = entries.some(([, a]) => !!a.apiKey);
  if (els.setupBanner) els.setupBanner.hidden = hasAnyKey;
}

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["agents", "defaultAgent", "customPrompt"], (d) =>
      resolve(d || {})
    );
  });
}

// ---- 上下文 ----
async function loadContext() {
  const ctx = await chrome.runtime.sendMessage({ type: "pdf-ai/get-context" });
  if (!ctx.ok) return;

  if (ctx.pendingPrompt && ctx.pendingPrompt.text) {
    state.contextText = ctx.pendingPrompt.text;
    state.contextUrl = ctx.pendingPrompt.pdfUrl || ctx.selectionUrl || "";
    if (ctx.pendingPrompt.agent) {
      els.agentSelect.value = ctx.pendingPrompt.agent;
      state.agentId = ctx.pendingPrompt.agent;
    }
    if (ctx.pendingPrompt.defaultQuestion) {
      els.userInput.value = ctx.pendingPrompt.defaultQuestion;
    }
  } else if (ctx.selection) {
    state.contextText = ctx.selection;
    state.contextUrl = ctx.selectionUrl || "";
  }
  renderContext();
  renderFullDocStatusFromPending(ctx.pendingPrompt);
}

function renderContext() {
  if (!state.contextText) return;
  els.contextText.textContent = state.contextText;
  if (state.contextUrl) {
    try {
      const u = new URL(state.contextUrl);
      const path = u.pathname.split("/").pop() || u.pathname;
      els.contextMeta.textContent =
        (path.length > 30 ? path.slice(0, 28) + "…" : path) + " · " + u.hostname;
      els.contextMeta.title = state.contextUrl;
    } catch (_) {}
  }
}

function renderFullDocStatusFromPending(pending) {
  if (!pending) return;
  if (pending.hasFullText) {
    setFullDocStatus({
      ok: true,
      numPages: pending.pdfNumPages,
      chars: pending.pdfChars,
      url: pending.pdfUrl,
    });
  } else {
    setFullDocStatus({ ok: false, loading: false, url: pending.pdfUrl });
  }
}

function setFullDocStatus({ ok, loading, numPages, chars, url, error }) {
  if (!els.fullDocStatus) return;
  if (loading) {
    els.fullDocStatus.innerHTML =
      '<span class="dot loading"></span>正在加载 PDF 全文…';
    els.fullDocStatus.className = "full-doc-status loading";
    return;
  }
  if (error) {
    els.fullDocStatus.innerHTML =
      '<span class="dot err"></span>全文加载失败：' + escapeHtml(error);
    els.fullDocStatus.className = "full-doc-status error";
    return;
  }
  if (ok && chars) {
    els.fullDocStatus.innerHTML =
      `<span class="dot ok"></span>已加载全文 ` +
      `<b>${formatNum(chars)}</b> 字 · ` +
      `<b>${numPages || "?"}</b> 页`;
    els.fullDocStatus.className = "full-doc-status ready";
    els.fullDocStatus.title = url || "";
  } else {
    els.fullDocStatus.innerHTML =
      '<span class="dot warn"></span>全文未加载（只解释选段）';
    els.fullDocStatus.className = "full-doc-status empty";
  }
}

// 主动拉全文（sidepanel 启动时调一次）
async function tryLoadFullDoc() {
  // 先看当前 tab 是不是 PDF（不依赖 contextUrl）
  let tabUrl = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabUrl = (tab && tab.url) || "";
  } catch (_) {}

  if (!tabUrl || !tabUrl.toLowerCase().includes(".pdf")) {
    setFullDocStatus({ ok: false });
    showPdfPicker(false, "");
    return;
  }

  // 更新上下文 URL 到 tab 真实 URL（如果 pendingPrompt 还没有 pdfUrl）
  if (!state.contextUrl) {
    state.contextUrl = tabUrl;
    renderContext();
  }

  setFullDocStatus({ loading: true, url: tabUrl });
  state.pdfLoading = true;
  try {
    // 看 background 是否已经 cache 了
    const r1 = await chrome.runtime.sendMessage({ type: "pdf-ai/get-full-text", url: tabUrl });
    if (r1 && r1.ok && r1.fullText) {
      state.fullDoc = { fullText: r1.fullText, numPages: r1.numPages, url: r1.url };
      setFullDocStatus({
        ok: true,
        numPages: r1.numPages,
        chars: r1.fullText.length,
        url: r1.url,
      });
      showPdfPicker(false, r1.url);
      return;
    }
    // 没法自动拿：让用户手动选文件
    setFullDocStatus({
      ok: false,
      url: tabUrl,
      error: "Chrome 不允许扩展读取 PDF，请点下方按钮手动选同一份 PDF",
    });
    showPdfPicker(true, "请选择同一份 PDF 文件");
  } catch (e) {
    setFullDocStatus({ ok: false, url: tabUrl, error: String(e.message || e) });
    showPdfPicker(true, "出错了，请手动选文件");
  } finally {
    state.pdfLoading = false;
  }
}

function showPdfPicker(show, hint) {
  const btn = document.getElementById("load-pdf-btn");
  const nameEl = document.getElementById("pdf-file-name");
  if (btn) btn.style.display = show ? "" : "none";
  if (hint !== undefined && nameEl) nameEl.textContent = hint;
}

/**
 * 用户点击 "📁 选择 PDF 文件" 后：解析文件，缓存到 background，更新 UI
 */
async function handlePdfFile(file) {
  if (!file) return;
  setFullDocStatus({ loading: true });
  showPdfPicker(true, `正在解析 ${file.name}…`);

  try {
    const buf = await file.arrayBuffer();
    if (buf.byteLength < 100) throw new Error("文件太小，可能不是 PDF");

    const mod = await import(chrome.runtime.getURL("src/lib/pdf-parser.js"));
    const result = await mod.parsePdfFromBuffer(buf);

    // 用 state.contextUrl 或者当前 tab 的 url 作为 cache key
    const cacheUrl = state.contextUrl || `file://manual/${encodeURIComponent(file.name)}`;
    await chrome.runtime.sendMessage({
      type: "pdf-ai/full-text",
      url: cacheUrl,
      fullText: result.fullText,
      numPages: result.numPages,
      pages: result.pages,
    });

    state.fullDoc = { fullText: result.fullText, numPages: result.numPages, url: cacheUrl };
    setFullDocStatus({
      ok: true,
      numPages: result.numPages,
      chars: result.fullText.length,
      url: cacheUrl,
    });
    showPdfPicker(true, `✓ ${file.name}`);
  } catch (e) {
    console.error("[pdf-ai] file parse failed", e);
    setFullDocStatus({ ok: false, error: String(e.message || e) });
    showPdfPicker(true, `❌ 解析失败：${e.message || e}`);
  }
}

async function refreshSelectionFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({
    type: "pdf-ai/fetch-selection",
    tabId: tab.id,
  });
  if (res && res.ok && res.text) {
    state.contextText = res.text;
    state.contextUrl = tab.url || state.contextUrl;
    renderContext();
  } else {
    flashHint("没抓到选区——请在页面上先框选文字");
  }
}

function flashHint(text) {
  const old = els.hint.textContent;
  els.hint.textContent = text;
  els.hint.style.color = "var(--error)";
  setTimeout(() => {
    els.hint.textContent = old;
    els.hint.style.color = "";
  }, 2000);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---- 对话 ----
async function restoreChat() {
  const data = await chrome.storage.session.get(["chatHistory"]);
  if (data.chatHistory && Array.isArray(data.chatHistory)) {
    state.messages = data.chatHistory;
    renderAllMessages();
  }
}

function saveChat() {
  chrome.storage.session.set({ chatHistory: state.messages });
}

function renderAllMessages() {
  els.chat.innerHTML = "";
  if (state.messages.length === 0) {
    if (els.chatEmpty) els.chat.appendChild(els.chatEmpty);
    return;
  }
  for (const m of state.messages) appendBubble(m.role, m.content, false);
  els.chat.scrollTop = els.chat.scrollHeight;
}

function appendBubble(role, content, withCursor = false) {
  if (state.messages.length === 0 && els.chatEmpty && els.chatEmpty.parentNode) {
    els.chatEmpty.remove();
  }
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "我" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.dataset.role = role;
  if (withCursor) {
    bubble.innerHTML = renderMarkdownLite(content) + '<span class="cursor"></span>';
  } else {
    bubble.innerHTML = renderMarkdownLite(content);
  }

  if (role === "assistant" && !withCursor) {
    const actions = document.createElement("div");
    actions.className = "bubble-actions";
    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.textContent = "复制";
    copy.onclick = () => copyToClipboard(content);
    actions.appendChild(copy);
    bubble.appendChild(actions);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  els.chat.appendChild(wrap);
  els.chat.scrollTop = els.chat.scrollHeight;
  return bubble;
}

function getLastAssistantBubble() {
  const bubbles = els.chat.querySelectorAll(".msg.assistant .bubble");
  return bubbles[bubbles.length - 1] || null;
}

function appendStreamDelta(delta) {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant" || !last.pending) {
    state.messages.push({ role: "assistant", content: delta, pending: true });
    appendBubble("assistant", delta, true);
  } else {
    last.content += delta;
    const bubble = getLastAssistantBubble();
    if (bubble) {
      bubble.innerHTML = renderMarkdownLite(last.content) + '<span class="cursor"></span>';
      els.chat.scrollTop = els.chat.scrollHeight;
    }
  }
}

function finalizeStream() {
  const last = state.messages[state.messages.length - 1];
  if (last && last.pending) {
    delete last.pending;
    const bubble = getLastAssistantBubble();
    if (bubble) {
      bubble.innerHTML = renderMarkdownLite(last.content);
      const actions = document.createElement("div");
      actions.className = "bubble-actions";
      const copy = document.createElement("button");
      copy.className = "copy-btn";
      copy.textContent = "复制";
      copy.onclick = () => copyToClipboard(last.content);
      actions.appendChild(copy);
      bubble.appendChild(actions);
    }
  }
  state.currentRequestId = null;
  els.sendBtn.disabled = false;
  els.sendBtn.textContent = "发送";
  saveChat();
}

function appendStreamError(err) {
  const last = state.messages[state.messages.length - 1];
  if (last && last.pending) {
    last.content = `❌ ${err}`;
    delete last.pending;
  } else {
    state.messages.push({ role: "assistant", content: `❌ ${err}` });
  }
  renderAllMessages();
  state.currentRequestId = null;
  els.sendBtn.disabled = false;
  els.sendBtn.textContent = "发送";
  saveChat();
}

// ---- 发送 ----
async function onSend() {
  if (els.sendBtn.disabled) return;
  const question = els.userInput.value.trim();
  if (!question) {
    flashHint("问题不能为空（不填也能发，AI 会直接解释选中段落）");
  }
  if (!state.contextText) {
    flashHint("还没有引用段落——请先在 PDF 页面上框选文字");
    return;
  }
  if (!state.agentId) {
    flashHint("请先在设置里配置一个 AI agent");
    return;
  }

  if (els.chatEmpty && els.chatEmpty.parentNode) els.chatEmpty.remove();

  // 决定是否带全文
  const useFullDoc = !!state.fullDoc && state.fullDoc.fullText;
  const q = question || "请基于全文上下文，解释我选中的这段话";

  state.messages.push({ role: "user", content: q + (useFullDoc ? "" : "\n（仅基于选段）") });
  appendBubble("user", q, false);
  els.userInput.value = "";

  state.messages.push({ role: "assistant", content: "", pending: true });
  appendBubble("assistant", "", true);

  saveChat();

  els.sendBtn.disabled = true;
  els.sendBtn.textContent = "生成中…";
  state.currentRequestId = uid();

  const res = await chrome.runtime.sendMessage({
    type: "pdf-ai/ask",
    contextText: state.contextText,
    question: q,
    agentId: state.agentId,
    requestId: state.currentRequestId,
    fullDoc: useFullDoc ? state.fullDoc : null,
  });

  if (!res || !res.ok) appendStreamError(res?.error || "请求失败");
}

function onClear() {
  if (!confirm("清空所有对话？引用段落不会被清掉。")) return;
  state.messages = [];
  saveChat();
  renderAllMessages();
}

init();
