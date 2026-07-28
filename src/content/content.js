// content.js — 注入到所有页面（all_frames=true）
// 职责：
//  1. 检测当前页面是否是 PDF（PDF.js 嵌入 或 file://...pdf）
//  2. 解析整篇 PDF 文本 → 推给 background 缓存
//  3. 监听 selection → 把选中段落推给 background

(function () {
  "use strict";

  const PDF_PARSE_FLAG = "__pdf_ai_parsed__";
  const PDF_PARSE_VERSION = 2;

  // ====== 检测 PDF ======
  function isLikelyPdfPage() {
    const url = (location.href || "").toLowerCase();
    // 0) 跳过 chrome:// / chrome-extension:// 内部页面（content script 不应在那里跑解析）
    if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
      return false;
    }
    // 1) URL 以 .pdf 结尾（用户直接打开 PDF 文件）
    if (url.endsWith(".pdf") || url.includes(".pdf?")) return true;
    // 2) 页面里已经有 PDF.js textLayer（嵌入的 PDF.js viewer）
    if (document.querySelector(".textLayer")) return true;
    // 3) 顶层页面有 <embed>/<object>/<iframe> 加载 .pdf
    const embeds = document.querySelectorAll('embed[src$=".pdf"], object[data$=".pdf"], iframe[src$=".pdf"]');
    if (embeds.length > 0) return true;
    return false;
  }

  // ====== 全文 PDF 解析 ======
  // 不在这里自动 fetch —— Chrome 原生 PDF viewer + file_access 限制让这条路不可靠。
  // 全文加载完全靠用户在侧栏点 "📁 选择 PDF 文件" 按钮（sidepanel.html / sidepanel.js）。
  // 这里只做一件事：通知 background "这个 tab 是 PDF 文件"，让 sidepanel 主动提示。
  async function notifyPdfDetected() {
    if (window[PDF_PARSE_FLAG] === true || window[PDF_PARSE_FLAG] === "notified") return;
    window[PDF_PARSE_FLAG] = "notified";
    try {
      await chrome.runtime.sendMessage({
        type: "pdf-ai/pdf-detected",
        url: location.href,
        title: document.title,
      });
    } catch (_) {}
  }

  // ====== 选区文本提取（PDF.js textLayer） ======
  function findTextLayer(root) {
    const candidates = root.querySelectorAll
      ? root.querySelectorAll(".textLayer")
      : [];
    if (candidates.length > 0) return candidates[0];
    let el = root;
    while (el && el !== document.documentElement) {
      if (el.classList && el.classList.contains("textLayer")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function extractTextLayerSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
    const range = sel.getRangeAt(0);
    const container =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!container) return "";
    const layer = findTextLayer(container);
    if (!layer) return "";
    const spans = layer.querySelectorAll("span");
    const collected = [];
    spans.forEach((span) => {
      try {
        if (range.intersectsNode(span)) collected.push(span.textContent);
      } catch (_) {}
    });
    return collected.join("").trim();
  }

  function extractGenericSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return "";
    return sel.toString().trim();
  }

  // ====== 网页教程模式：给页面上的可操作元素建立临时索引 ======
  function buildGuideIndex() {
    const selectors = "a,button,input,textarea,select,[role='button'],[role='link'],summary";
    const items = [];
    document.querySelectorAll(selectors).forEach((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width < 2 || rect.height < 2 || style.display === "none" || style.visibility === "hidden") return;
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
        .replace(/\s+/g, " ").trim().slice(0, 160);
      if (!text) return;
      const index = items.length;
      el.setAttribute("data-pdf-ai-guide-index", String(index));
      items.push({
        index,
        tag: el.tagName.toLowerCase(),
        text,
        aria: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        bbox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    });
    return items.slice(0, 180);
  }

  function clearGuideHighlight() {
    const old = document.querySelector(".__pdf-ai-guide-highlight");
    if (old) old.remove();
  }

  function highlightGuideElement(index) {
    clearGuideHighlight();
    const el = document.querySelector(`[data-pdf-ai-guide-index="${CSS.escape(String(index))}"]`);
    if (!el) return { ok: false, error: "页面元素已变化，请重新生成教程" };
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = "__pdf-ai-guide-highlight";
    Object.assign(box.style, { top: `${rect.top - 5}px`, left: `${rect.left - 5}px`, width: `${rect.width + 10}px`, height: `${rect.height + 10}px` });
    document.documentElement.appendChild(box);
    return { ok: true };
  }

  // ====== 选区推送 ======
  let lastSentText = "";
  let debounceTimer = null;

  function publishSelection(text) {
    if (!text || text === lastSentText) return;
    lastSentText = text;
    chrome.runtime
      .sendMessage({ type: "pdf-ai/selection", text })
      .catch(() => {});
  }

  function onSelectionChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const text = extractTextLayerSelection() || extractGenericSelection();
      publishSelection(text);
    }, 120);
  }

  document.addEventListener("selectionchange", onSelectionChange, true);

  // ====== 处理来自 background / sidepanel 的请求 ======
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "pdf-ai/get-current-selection") {
      const text = extractTextLayerSelection() || extractGenericSelection();
      sendResponse({ ok: true, text });
      return true;
    }
    if (msg && msg.type === "pdf-ai/get-page-meta") {
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        isPdf: isLikelyPdfPage(),
        pdfParsed: window[PDF_PARSE_FLAG] === PDF_PARSE_VERSION,
      });
      return true;
    }
    if (msg && msg.type === "pdf-ai/get-page-guide-context") {
      const elements = buildGuideIndex();
      const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30000);
      sendResponse({ ok: true, title: document.title, url: location.href, pageText, elements });
      return true;
    }
    if (msg && msg.type === "pdf-ai/highlight-guide-element") {
      sendResponse(highlightGuideElement(msg.index));
      return true;
    }
      // sidepanel 主动要求解析当前页面 PDF（不再实现，由侧栏按钮承载）
      if (msg && msg.type === "pdf-ai/parse-this") {
        sendResponse({ ok: false, error: "请使用侧栏的「选择 PDF 文件」按钮" });
        return true;
      }
    return false;
  });

  // ====== 启动 ======
  // 等到 DOM ready 后再尝试（PDF.js 嵌入场景）
  async function bootstrap() {
    if (document.readyState === "loading") {
      await new Promise((r) =>
        document.addEventListener("DOMContentLoaded", r, { once: true })
      );
    }
    if (isLikelyPdfPage()) {
      // 只通知 background "这个 tab 是 PDF"，不自动 fetch
      setTimeout(notifyPdfDetected, 800);
    }
    setTimeout(onSelectionChange, 500);
  }
  bootstrap();
})();
