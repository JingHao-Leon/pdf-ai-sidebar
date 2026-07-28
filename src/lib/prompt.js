// prompt.js — 模板拼装
// 两种 prompt：
//  1. 段落式（旧）：{context} = 选中段落
//  2. 全文式（新）：{fullText} = PDF 全文, {selectedText} = 选中段落, {question} = 用户问题

export function buildPrompt(template, contextText, question) {
  if (!template) template = defaultTemplate();
  return template
    .replace(/\{context\}/g, contextText)
    .replace(/\{question\}/g, question);
}

export function defaultTemplate() {
  return (
    "你是我的 PDF 阅读助手。基于以下引用段落回答我的问题。\n" +
    "如果问题不在段落范围内，请明确说明，并尝试基于段落上下文做合理推测。\n\n" +
    "引用段落：\n\"\"\"\n{context}\n\"\"\"\n\n我的问题：\n{question}"
  );
}

/**
 * 全文上下文模式：基于整篇文档解释选中的段落/句子
 *
 * 设计要点：
 *  - fullText 可能很长（论文几万字），做硬上限截断 + 重点位置优先
 *  - 优先保留：选中段落所在页 + 前后各 1 页（如果知道位置）
 *  - 兜底：保留首尾 + 中间均匀采样
 */
export function buildFullDocPrompt({
  fullText,
  selectedText,
  question = "",
  maxChars = 24000, // 约 8K-12K tokens
  selectedPageHint = null, // 可选：1-indexed 选中的页码
}) {
  const truncated = truncateWithPriority(
    fullText,
    selectedText,
    maxChars,
    selectedPageHint
  );

  const userQ = question.trim() || "请基于全文上下文，解释我选中的这段话";

  return (
    `你是我的 PDF 阅读助手。我会给你一篇文档的全文（可能截断），以及我特别想理解的一段话。\n` +
    `请基于文档的整体内容，帮我解释选中这段话。回答时：\n` +
    `1. 简要说明这段话在文档中的位置和作用\n` +
    `2. 解释它的核心意思\n` +
    `3. 关联文档中其他相关段落（如果有）\n` +
    `4. 如果我附加了问题，优先回答问题\n\n` +
    `【文档全文】\n"""${truncated}"""\n\n` +
    `【我选中的内容】\n"""${selectedText}"""\n\n` +
    `【我的问题（可选）】\n${userQ}`
  );
}

/**
 * 智能截断全文：
 *  - 如果 totalLen <= maxChars，全文返回
 *  - 否则：保留头尾 + 选中段落所在页（如果知道）
 */
function truncateWithPriority(fullText, selectedText, maxChars, selectedPageHint) {
  if (!fullText) return "";
  if (fullText.length <= maxChars) return fullText;

  // 按 "--- Page Break ---" 分页
  const SEP = "\n\n--- Page Break ---\n\n";
  const pages = fullText.split(SEP);
  const totalPages = pages.length;

  // 找选中段落所在的页
  let selectedPageIdx = -1;
  if (selectedText) {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].includes(selectedText.substring(0, 50))) {
        selectedPageIdx = i;
        break;
      }
    }
  }
  if (selectedPageIdx === -1 && selectedPageHint) {
    selectedPageIdx = Math.max(0, Math.min(totalPages - 1, selectedPageHint - 1));
  }

  // 计算预算：头 30% + 选中页附近 50% + 尾 20%
  const headBudget = Math.floor(maxChars * 0.3);
  const tailBudget = Math.floor(maxChars * 0.2);
  const centerBudget = maxChars - headBudget - tailBudget;

  const head = pages.slice(0, Math.min(2, totalPages)).join(SEP).slice(0, headBudget);
  const tail = pages.slice(Math.max(0, totalPages - 2)).join(SEP).slice(-tailBudget);

  let center = "";
  if (selectedPageIdx >= 0) {
    const start = Math.max(0, selectedPageIdx - 1);
    const end = Math.min(totalPages, selectedPageIdx + 2);
    center = pages.slice(start, end).join(SEP).slice(0, centerBudget);
  } else {
    // 均匀采样
    const step = Math.max(1, Math.floor(totalPages / 5));
    const sampled = [];
    for (let i = 1; i < totalPages - 1; i += step) sampled.push(pages[i]);
    center = sampled.join(SEP).slice(0, centerBudget);
  }

  return (
    `[文档前段]\n${head}\n\n` +
    `[重点段落（选中内容所在位置）]\n${center}\n\n` +
    `[文档后段]\n${tail}`
  );
}