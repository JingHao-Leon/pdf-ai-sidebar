// ai-client.js — 统一的流式 AI 调用客户端
// 支持 OpenAI-compatible + Anthropic + Google Gemini 三种协议
// 其它协议可以通过自定义 endpoint + 自定义 adapter 扩展

/**
 * 调用 AI 流式接口
 * @param {object} opts
 * @param {object} opts.agent { label, endpoint, model, apiKey, headers? }
 * @param {string} opts.userPrompt 完整的 user 消息内容（prompt.js 已经拼好）
 * @param {string} opts.requestId  关联到 sidepanel 的流
 * @param {(delta:string)=>void} opts.onChunk
 * @param {()=>void} opts.onDone
 * @param {(err:Error)=>void} opts.onError
 */
export async function callAIStream({ agent, userPrompt, onChunk, onDone, onError }) {
  try {
    const kind = detectProtocol(agent.endpoint);
    if (kind === "openai") {
      await streamOpenAI(agent, userPrompt, onChunk);
    } else if (kind === "anthropic") {
      await streamAnthropic(agent, userPrompt, onChunk);
    } else if (kind === "gemini") {
      await streamGemini(agent, userPrompt, onChunk);
    } else {
      // 默认按 OpenAI-compatible 处理
      await streamOpenAI(agent, userPrompt, onChunk);
    }
    onDone && onDone();
  } catch (e) {
    console.error("[pdf-ai] callAIStream error", e);
    onError && onError(e);
  }
}

function detectProtocol(endpoint = "") {
  const u = endpoint.toLowerCase();
  if (u.includes("anthropic.com")) return "anthropic";
  if (u.includes("generativelanguage.googleapis.com")) return "gemini";
  return "openai";
}

// ===== OpenAI / OpenAI-compatible =====
async function streamOpenAI(agent, userPrompt, onChunk) {
  const resp = await fetch(agent.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agent.apiKey}`,
      ...(agent.headers || {}),
    },
    body: JSON.stringify({
      model: agent.model,
      messages: [{ role: "user", content: userPrompt }],
      stream: true,
      temperature: 0.4,
    }),
  });
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  await readSSE(resp.body, (data) => {
    if (!data || data === "[DONE]") return;
    try {
      const json = JSON.parse(data);
      const delta =
        json.choices?.[0]?.delta?.content ||
        json.choices?.[0]?.message?.content ||
        "";
      if (delta) onChunk(delta);
    } catch (_) {}
  });
}

// ===== Anthropic Claude =====
async function streamAnthropic(agent, userPrompt, onChunk) {
  const resp = await fetch(agent.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": agent.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(agent.headers || {}),
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 2048,
      messages: [{ role: "user", content: userPrompt }],
      stream: true,
    }),
  });
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Anthropic HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  await readSSE(resp.body, (data) => {
    try {
      const json = JSON.parse(data);
      if (json.type === "content_block_delta" && json.delta?.text) {
        onChunk(json.delta.text);
      }
    } catch (_) {}
  });
}

// ===== Google Gemini =====
async function streamGemini(agent, userPrompt, onChunk) {
  const url = agent.endpoint.replace("{model}", encodeURIComponent(agent.model));
  const sep = url.includes("?") ? "&" : "?";
  const fullUrl = `${url}${sep}key=${encodeURIComponent(agent.apiKey)}`;
  const resp = await fetch(fullUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.4 },
    }),
  });
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Gemini HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  await readSSE(resp.body, (data) => {
    try {
      const json = JSON.parse(data);
      const part = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (part) onChunk(part);
    } catch (_) {}
  });
}

// ===== 通用 SSE 解析 =====
async function readSSE(stream, onData) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = raw.split("\n");
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) onData(dataLines.join("\n"));
    }
  }
  // flush
  if (buf.trim()) onData(buf.replace(/^data:\s?/, "").trim());
}

// ===== 列出已配置 agent（用于菜单/UI） =====
export async function listAvailableAgents(config) {
  const out = [];
  for (const [id, a] of Object.entries(config.agents || {})) {
    out.push({
      id,
      label: a.label || id,
      shortcut: a.shortcut || "",
      configured: !!(a.apiKey && a.endpoint && a.model),
    });
  }
  return out;
}