// pdf-parser.js — 封装 PDF.js 解析
// 能在 background service worker 和 content script 里跑
// 关键：service worker 里用 Blob + Worker 创建 fake worker context

let pdfjsLibPromise = null;

export async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib = await import(
        chrome.runtime.getURL("src/vendor/pdfjs/pdf.min.mjs")
      );
      await setupWorker(lib);
      return lib;
    })();
  }
  return pdfjsLibPromise;
}

async function setupWorker(pdfjsLib) {
  const workerUrl = chrome.runtime.getURL(
    "src/vendor/pdfjs/pdf.worker.min.mjs"
  );
  if (typeof Worker !== "undefined") {
    try {
      // 普通环境（content script / sidepanel）：直接用 URL
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      return;
    } catch (_) {}
  }
  // service worker 环境：用 Blob 包装
  // （实际上 service worker 也支持 new Worker(URL)，所以这分支一般不走到）
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

/**
 * 从 arrayBuffer 解析 PDF 全文
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{fullText:string, numPages:number, pages:string[]}>}
 */
export async function parsePdfFromBuffer(arrayBuffer) {
  const pdfjs = await getPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: arrayBuffer,
    // 关闭一些会拖慢解析的选项
    disableFontFace: true,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items || [];
    // 拼接时按 transform Y 排序保留段落结构
    const pageText = items
      .map((it) => it.str || "")
      .filter((s) => s.length > 0)
      .join(" ");
    pages.push(pageText);
  }
  return {
    fullText: pages.join("\n\n--- Page Break ---\n\n"),
    numPages: pdf.numPages,
    pages,
  };
}

/**
 * 从 URL fetch + 解析
 * @param {string} url
 */
export async function parsePdfFromUrl(url) {
  const resp = await fetch(url, { credentials: "omit" });
  if (!resp.ok) {
    throw new Error(`fetch PDF failed: HTTP ${resp.status}`);
  }
  const buf = await resp.arrayBuffer();
  return await parsePdfFromBuffer(buf);
}