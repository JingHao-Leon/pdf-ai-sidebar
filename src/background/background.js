// background.js — MV3 service worker (ESM)
// 职责：
//  1. 维护右键菜单（多 AI agent 子菜单）
//  2. 缓存全文 PDF（memory + chrome.storage.session 镜像，key by URL）
//  3. 缓存当前选区文本
//  4. 响应 content script / sidepanel 的消息
//  5. 转发 AI API 请求（流式 SSE）给 sidepanel
//  6. 处理快捷键（打开 side panel / 发送选区）

import { callAIStream, listAvailableAgents } from "../lib/ai-client.js";
import { buildFullDocPrompt, buildPrompt } from "../lib/prompt.js";
console.log("[pdf-ai] background script loaded");

// ===== 内存状态 =====
const state = {
  // pdfKey (URL hash) → { fullText, numPages, pages, url, ts }
  pdfCache: new Map(),
  // 当前 tab 的最后选区
  lastSelection: "",
  lastSelectionUrl: "",
  // pending 等 sidepanel 读取
  pendingPrompt: null,
};

// ===== 工具：URL hash（用作 cache key） =====
// 用 djb2 简单 hash（service worker 里 crypto.subtle 偶尔 hang）
function urlHash(url) {
  let hash = 5381;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) + hash + url.charCodeAt(i)) | 0;
  }
  // 转为 16 进制字符串（取绝对值 + 0x100000000 保证正数）
  return "h" + (hash >>> 0).toString(16).padStart(8, "0");
}

// ===== 缓存全文 PDF =====
async function cacheFullText({ url, fullText, numPages, pages }) {
  const key = await urlHash(url);
  state.pdfCache.set(key, { fullText, numPages, pages, url, ts: Date.now() });
  // 也存到 session storage（service worker 重启后能拿回来）
  const entry = {};
  entry[`pdf:${key}`] = { fullText, numPages, pages, url, ts: Date.now() };
  await chrome.storage.session.set(entry);
}

async function getCachedFullText(url) {
  const key = await urlHash(url);
  if (state.pdfCache.has(key)) return state.pdfCache.get(key);
  // 从 session storage 恢复
  const stored = await chrome.storage.session.get(`pdf:${key}`);
  const cached = stored[`pdf:${key}`];
  if (cached) {
    state.pdfCache.set(key, cached);
    return cached;
  }
  return null;
}

// 不再让 background 自动 fetch file:// PDF——Chrome viewer + file:// 权限限制下不可靠。
// 全文完全由用户在侧栏点 "📁 选择 PDF 文件" 上传（File → ArrayBuffer → PDF.js → 缓存到这里）。
async function ensureFullText(tabUrl) {
  if (!tabUrl) return null;
  return await getCachedFullText(tabUrl);
}

// ===== 配置读取 =====
async function loadConfig() {
  const data = await chrome.storage.sync.get(["agents", "defaultAgent", "customPrompt", "fullDocPrompt"]);
  return {
    agents: data.agents || {},
    defaultAgent: data.defaultAgent || "minimax",
    customPrompt:
      data.customPrompt ||
      "你是我的 PDF 阅读助手。基于以下引用段落回答我的问题。\n" +
        "如果问题不在段落范围内，请明确说明，并尝试基于段落上下文做合理推测。\n\n" +
        "引用段落：\n\"\"\"\n{context}\n\"\"\"\n\n我的问题：\n{question}",
    fullDocPrompt: data.fullDocPrompt || null, // null = 用 prompt.js 里的默认
    maxDocChars: data.maxDocChars || 24000,
  };
}

// ===== 持久化选区 =====
async function setSelection(text, url) {
  state.lastSelection = text || "";
  state.lastSelectionUrl = url || "";
  await chrome.storage.session.set({
    selection: state.lastSelection,
    selectionUrl: state.lastSelectionUrl,
    selectionAt: Date.now(),
  });
}

// ===== 持久化 pending =====
async function setPendingPrompt(p) {
  state.pendingPrompt = p;
  await chrome.storage.session.set({ pendingPrompt: p });
}

// ===== 右键菜单 =====
async function rebuildContextMenus() {
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
  const cfg = await loadConfig();
  const agents = await listAvailableAgents(cfg);

  chrome.contextMenus.create({
    id: "pdf-ai-root",
    title: "AI 解释整篇：%s",
    contexts: ["selection"],
    documentUrlPatterns: ["<all_urls>"],
  });

  if (agents.length === 0) {
    chrome.contextMenus.create({
      id: "pdf-ai-configure",
      parentId: "pdf-ai-root",
      title: "先去设置里配置 AI agent",
      contexts: ["selection"],
    });
    return;
  }
  for (const a of agents) {
    chrome.contextMenus.create({
      id: `pdf-ai-send-${a.id}`,
      parentId: "pdf-ai-root",
      title: `${a.label}（${a.shortcut || a.id}）`,
      contexts: ["selection"],
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  rebuildContextMenus();
});
chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenus();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.agents || changes.defaultAgent)) {
    rebuildContextMenus();
  }
});

// ===== 工具栏图标 → 打开 side panel =====
// Chrome 116+ 支持点击 action 图标时打开扩展侧边栏。
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[pdf-ai] set side panel behavior failed", err));
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[pdf-ai] set side panel behavior failed", err));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = (info.selectionText || "").trim();
  if (!text) return;

  const cfg = await loadConfig();
  const id = info.menuItemId;
  const agentId = id.replace(/^pdf-ai-send-/, "");

  // 缓存选区
  await setSelection(text, info.pageUrl);

  // 尝试拿全文（content script 可能已解析，也可能需要 background fallback）
  let doc = await getCachedFullText(info.pageUrl || "");
  if (!doc) {
    doc = await ensureFullText(info.pageUrl || "");
  }

  state.pendingPrompt = {
    text,
    agent: agentId,
    pdfUrl: info.pageUrl || "",
    hasFullText: !!(doc && doc.fullText),
    pdfNumPages: doc ? doc.numPages : 0,
    pdfChars: doc ? doc.fullText.length : 0,
  };
  await setPendingPrompt(state.pendingPrompt);

  // 右键菜单点击本身是用户手势，Chrome 116+ 允许在这里打开 side panel。
  if (tab && tab.id != null && id.startsWith("pdf-ai-send-")) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (err) {
      console.error("[pdf-ai] failed to open side panel", err);
    }
  }
});

// ===== 消息处理 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[pdf-ai] background received:", msg && msg.type, "from", sender.url || sender.id);
  (async () => {
    try {
      if (!msg || typeof msg !== "object") {
        sendResponse({ ok: false, error: "bad message" });
        return;
      }

      // --- content script 推送选区 ---
      if (msg.type === "pdf-ai/selection") {
        await setSelection(msg.text || "", sender.url || "");
        sendResponse({ ok: true });
        return;
      }

      // --- content script 通知 background "这个 tab 是 PDF" ---
      if (msg.type === "pdf-ai/pdf-detected") {
        if (state.pendingPrompt && state.pendingPrompt.pdfUrl === msg.url) {
          state.pendingPrompt.isPdf = true;
          await setPendingPrompt(state.pendingPrompt);
        }
        sendResponse({ ok: true });
        return;
      }

      // --- content / sidepanel 推送全文（侧栏文件选择器解析后） ---
      if (msg.type === "pdf-ai/full-text") {
        await cacheFullText({
          url: msg.url,
          fullText: msg.fullText,
          numPages: msg.numPages,
          pages: msg.pages,
        });
        // 如果有 pending，更新它的状态
        if (state.pendingPrompt && state.pendingPrompt.pdfUrl === msg.url) {
          state.pendingPrompt.hasFullText = true;
          state.pendingPrompt.pdfNumPages = msg.numPages;
          state.pendingPrompt.pdfChars = msg.fullText.length;
          await setPendingPrompt(state.pendingPrompt);
        }
        sendResponse({ ok: true });
        return;
      }

      // --- sidepanel 拉取上下文 ---
      if (msg.type === "pdf-ai/get-context") {
        const stored = await chrome.storage.session.get([
          "pendingPrompt",
          "selection",
          "selectionUrl",
        ]);
        sendResponse({
          ok: true,
          pendingPrompt: stored.pendingPrompt || null,
          selection: stored.selection || state.lastSelection || "",
          selectionUrl: stored.selectionUrl || state.lastSelectionUrl || "",
        });
        return;
      }

      // --- sidepanel 拉全文（指定 URL） ---
      if (msg.type === "pdf-ai/get-full-text") {
        const url = msg.url || state.lastSelectionUrl;
        let doc = await getCachedFullText(url);
        if (!doc) doc = await ensureFullText(url);
        sendResponse({
          ok: !!doc,
          fullText: doc ? doc.fullText : null,
          numPages: doc ? doc.numPages : 0,
          url,
        });
        return;
      }

      // --- sidepanel 要求主动解析（Chrome 原生 viewer 场景） ---
      if (msg.type === "pdf-ai/force-parse") {
        const tabId = msg.tabId;
        if (tabId == null) {
          sendResponse({ ok: false, error: "no tabId" });
          return;
        }
        try {
          // 先试 content script
          const r = await chrome.tabs.sendMessage(tabId, { type: "pdf-ai/parse-this" });
          if (r && r.ok && r.result) {
            sendResponse({ ok: true, source: "content", numPages: r.result.numPages });
            return;
          }
        } catch (_) {}
        // 退到 background 自己解析
        try {
          const tab = await chrome.tabs.get(tabId);
          const doc = await ensureFullText(tab.url);
          sendResponse({
            ok: !!doc,
            source: "background",
            numPages: doc ? doc.numPages : 0,
            url: tab.url,
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      // --- sidepanel 提交提问 ---
      if (msg.type === "pdf-ai/ask") {
        const { contextText, question, agentId, requestId, fullDoc } = msg;
        const cfg = await loadConfig();
        const aid = agentId || cfg.defaultAgent;
        const agent = cfg.agents[aid];
        if (!agent || !agent.apiKey) {
          sendResponse({ ok: false, error: `Agent "${aid}" 未配置 apiKey` });
          return;
        }

        // 决定 prompt：fullDoc 模式 vs 单段模式
        let userPrompt;
        if (fullDoc && fullDoc.fullText) {
          userPrompt = buildFullDocPrompt({
            fullText: fullDoc.fullText,
            selectedText: contextText,
            question,
            maxChars: cfg.maxDocChars,
            selectedPageHint: fullDoc.selectedPage || null,
          });
        } else {
          userPrompt = buildPrompt(cfg.customPrompt, contextText, question);
        }

        sendResponse({ ok: true, requestId });

        await callAIStream({
          agent,
          userPrompt,
          requestId,
          onChunk: (delta) => {
            chrome.runtime.sendMessage({
              type: "pdf-ai/stream",
              requestId,
              delta,
            }).catch(() => {});
          },
          onDone: () => {
            chrome.runtime.sendMessage({
              type: "pdf-ai/done",
              requestId,
            }).catch(() => {});
          },
          onError: (err) => {
            chrome.runtime.sendMessage({
              type: "pdf-ai/error",
              requestId,
              error: String(err && err.message ? err.message : err),
            }).catch(() => {});
          },
        });
        return;
      }

      // --- 网页教程：读取当前页面的 DOM 索引，让 AI 只返回可验证的步骤 ---
      if (msg.type === "pdf-ai/guide") {
        const { tabId, task, agentId, requestId } = msg;
        const cfg = await loadConfig();
        const aid = agentId || cfg.defaultAgent;
        const agent = cfg.agents[aid];
        if (!agent || !agent.apiKey) {
          sendResponse({ ok: false, error: `Agent "${aid}" 未配置 apiKey` });
          return;
        }
        const page = await chrome.tabs.sendMessage(tabId, { type: "pdf-ai/get-page-guide-context" });
        if (!page?.ok || !page.elements?.length) {
          sendResponse({ ok: false, error: "当前页面没有读取到可操作元素" });
          return;
        }
        const userPrompt = `你是网页操作教程助手。用户要完成以下任务：\n${task}\n\n当前网页标题：${page.title}\n网页正文（可能不完整）：\n${page.pageText}\n\n可操作元素索引（只能使用这些 index）：\n${JSON.stringify(page.elements)}\n\n请只返回 JSON，不要 Markdown：{"steps":[{"instruction":"中文的一步操作说明","targetIndex":0,"waitFor":"click|input|navigate|manual","nextHint":"完成后会发生什么"}]}。最多 8 步。不要生成密码、支付、提交订单或删除数据的自动操作；这类步骤使用 manual。每一步只给一个目标元素。`;
        sendResponse({ ok: true, requestId });
        let output = "";
        await callAIStream({
          agent,
          userPrompt,
          requestId,
          onChunk: (delta) => { output += delta; },
          onDone: async () => {
            try {
              const clean = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
              const guide = JSON.parse(clean);
              chrome.runtime.sendMessage({ type: "pdf-ai/guide-result", requestId, guide, pageUrl: page.url }).catch(() => {});
            } catch (e) {
              chrome.runtime.sendMessage({ type: "pdf-ai/guide-result", requestId, error: "AI 返回的教程格式无法解析" }).catch(() => {});
            }
          },
          onError: (err) => chrome.runtime.sendMessage({ type: "pdf-ai/guide-result", requestId, error: String(err?.message || err) }).catch(() => {}),
        });
        return;
      }

      // --- 配置变更 ---
      if (msg.type === "pdf-ai/config-changed") {
        await rebuildContextMenus();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});



// ===== 快捷键 =====
// 快捷键写入选区并打开 side panel。
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === "send-selection") {
    let text = "";
    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "pdf-ai/get-current-selection",
      });
      text = (res && res.text) || "";
    } catch (_) {}
    if (!text) {
      const stored = await chrome.storage.session.get(["selection"]);
      text = stored.selection || "";
    }
    if (!text) return;
    const cfg = await loadConfig();
    let doc = await getCachedFullText(tab.url || "");
    state.pendingPrompt = {
      text,
      agent: cfg.defaultAgent,
      pdfUrl: tab.url || "",
      hasFullText: !!(doc && doc.fullText),
      pdfNumPages: doc ? doc.numPages : 0,
      pdfChars: doc ? doc.fullText.length : 0,
      defaultQuestion: "请解释这段话",
    };
    await setPendingPrompt(state.pendingPrompt);
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (err) {
      console.error("[pdf-ai] failed to open side panel from command", err);
    }
  }
});

// ===== 默认配置 =====
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.sync.get(["agents"]);
  const deepseek = data.agents?.deepseek || {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    apiKey: "",
  };
  const minimax = data.agents?.minimax || {
    label: "MiniMax",
    endpoint: "https://api.minimaxi.com/v1/chat/completions",
    model: "MiniMax-M3",
    apiKey: "",
  };
  await chrome.storage.sync.set({
    agents: { deepseek, minimax },
    defaultAgent: data.defaultAgent === "deepseek" ? "deepseek" : "minimax",
  });
});
