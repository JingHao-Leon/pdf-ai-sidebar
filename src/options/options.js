// options.js — 配置页面逻辑

const $ = (id) => document.getElementById(id);

const els = {
  agentList: $("agent-list"),
  addAgent: $("add-agent"),
  resetDefault: $("reset-default"),
  defaultAgent: $("default-agent"),
  customPrompt: $("custom-prompt"),
  resetPrompt: $("reset-prompt"),
  saveStatus: $("save-status"),
  openMinimax: $("open-minimax"),
};

const MINIMAX_API_URL = "https://platform.minimaxi.com/user-center/basic-information/interface-key";

const DEFAULT_PROMPT = `你是我的 PDF 阅读助手。基于以下引用段落回答我的问题。
如果问题不在段落范围内，请明确说明，并尝试基于段落上下文做合理推测。

引用段落：
"""
{context}
"""

我的问题：
{question}`;

const DEFAULT_AGENTS = {
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    apiKey: "",
  },
  minimax: {
    label: "MiniMax",
    endpoint: "https://api.minimaxi.com/v1/chat/completions",
    model: "MiniMax-M3",
    apiKey: "",
  },
};

const state = {
  agents: {},
  defaultAgent: "",
  customPrompt: DEFAULT_PROMPT,
};

let saveTimer = null;
function showSaved() {
  els.saveStatus.textContent = "✓ 已保存";
  els.saveStatus.classList.add("show");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    els.saveStatus.classList.remove("show");
  }, 1500);
}

async function load() {
  const data = await chrome.storage.sync.get([
    "agents",
    "defaultAgent",
    "customPrompt",
  ]);
  const saved = data.agents || {};
  state.agents = {};
  for (const id of Object.keys(DEFAULT_AGENTS)) {
    state.agents[id] = saved[id]
      ? { ...DEFAULT_AGENTS[id], ...saved[id] }
      : JSON.parse(JSON.stringify(DEFAULT_AGENTS[id]));
  }
  state.defaultAgent = data.defaultAgent && state.agents[data.defaultAgent]
    ? data.defaultAgent
    : "minimax";
  state.customPrompt = data.customPrompt || DEFAULT_PROMPT;
  render();
}

function render() {
  renderAgents();
  renderDefaultSelect();
  els.customPrompt.value = state.customPrompt;
}

function renderAgents() {
  els.agentList.innerHTML = "";
  for (const [id, a] of Object.entries(state.agents)) {
    els.agentList.appendChild(buildAgentItem(id, a));
  }
}

function buildAgentItem(id, agent) {
  const item = document.createElement("div");
  item.className = "agent-item";
  item.dataset.id = id;

  const ok = !!(agent.apiKey && agent.endpoint && agent.model);

  item.innerHTML = `
    <div class="agent-summary">
      <span class="agent-toggle">▶</span>
      <span class="agent-name">
        ${escapeHtml(agent.label || id)}
        <span class="agent-status ${ok ? "ok" : "missing"}">${
    ok ? "✓ 已配置" : "⚠ 未配置 key"
  }</span>
      </span>
      <button class="danger-btn" data-act="delete">删除</button>
    </div>
    <div class="agent-body">
      <div class="field">
        <label>显示名</label>
        <input data-f="label" value="${escapeAttr(agent.label || "")}" />
      </div>
      <div class="field">
        <label>Agent ID（用于内部标识）</label>
        <input data-f="id" value="${escapeAttr(id)}" readonly />
      </div>
      <div class="field">
        <label>API Endpoint</label>
        <input data-f="endpoint" value="${escapeAttr(
          agent.endpoint || ""
        )}" placeholder="https://..." />
      </div>
      <div class="field-row">
        <div class="field">
          <label>模型</label>
          <input data-f="model" value="${escapeAttr(agent.model || "")}" />
        </div>
        <div class="field">
          <label>API Key</label>
          <div class="api-key-row">
            <input data-f="apiKey" type="password" value="${escapeAttr(
              agent.apiKey || ""
            )}" />
            <button class="ghost-btn" data-act="toggle-key">显示</button>
          </div>
        </div>
      </div>
      <div class="field">
        <label>自定义请求头（JSON，可选）</label>
        <input data-f="headers" value='${escapeAttr(
          agent.headers ? JSON.stringify(agent.headers) : ""
        )}' placeholder='{"X-Custom": "value"}' />
      </div>
    </div>
  `;

  // 折叠
  const summary = item.querySelector(".agent-summary");
  summary.addEventListener("click", (e) => {
    if (e.target.dataset.act) return;
    item.classList.toggle("open");
  });

  // 删除
  item.querySelector('[data-act="delete"]').addEventListener("click", (e) => {
    e.stopPropagation();
    if (Object.keys(state.agents).length <= 1) {
      alert("至少要保留一个 agent");
      return;
    }
    if (!confirm(`删除 agent "${agent.label || id}"？`)) return;
    delete state.agents[id];
    if (state.defaultAgent === id) {
      state.defaultAgent = Object.keys(state.agents)[0];
    }
    save();
    render();
  });

  // 显示/隐藏 key
  const keyInput = item.querySelector('[data-f="apiKey"]');
  item.querySelector('[data-act="toggle-key"]').addEventListener("click", (e) => {
    e.stopPropagation();
    if (keyInput.type === "password") {
      keyInput.type = "text";
      e.target.textContent = "隐藏";
    } else {
      keyInput.type = "password";
      e.target.textContent = "显示";
    }
  });

  // 字段变更
  item.querySelectorAll("[data-f]").forEach((input) => {
    input.addEventListener("input", () => {
      const f = input.dataset.f;
      let val = input.value;
      if (f === "headers" && val.trim()) {
        try {
          val = JSON.parse(val);
        } catch (_) {
          // 暂存原 string，等保存时再报错
        }
      }
      // id 字段特殊处理
      if (f === "id") return; // id 不在 input 监听里改，下面单独处理
      agent[f] = val;
    });
    input.addEventListener("change", () => {
      save();
      render();
    });
  });

  // id 修改（特殊：用一个新的 id 替换 key）
  const idInput = item.querySelector('[data-f="id"]');
  idInput.addEventListener("change", () => {
    const newId = idInput.value.trim();
    if (!newId || newId === id) return;
    if (state.agents[newId]) {
      alert(`ID "${newId}" 已存在`);
      idInput.value = id;
      return;
    }
    state.agents[newId] = agent;
    delete state.agents[id];
    if (state.defaultAgent === id) state.defaultAgent = newId;
    save();
    render();
  });

  // 默认展开
  if (!ok) item.classList.add("open");

  return item;
}

function renderDefaultSelect() {
  els.defaultAgent.innerHTML = "";
  for (const [id, a] of Object.entries(state.agents)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = a.label || id;
    if (id === state.defaultAgent) opt.selected = true;
    els.defaultAgent.appendChild(opt);
  }
  els.defaultAgent.onchange = () => {
    state.defaultAgent = els.defaultAgent.value;
    save();
  };
}

function save() {
  // headers 字段做最终校验
  const cleaned = {};
  for (const [id, a] of Object.entries(state.agents)) {
    let headers = a.headers;
    if (typeof headers === "string") {
      if (!headers.trim()) {
        headers = undefined;
      } else {
        try {
          headers = JSON.parse(headers);
        } catch (e) {
          alert(`Agent "${a.label || id}" 的请求头 JSON 不合法：${e.message}`);
          headers = undefined;
        }
      }
    }
    cleaned[id] = { ...a, headers };
  }
  chrome.storage.sync.set(
    {
      agents: cleaned,
      defaultAgent: state.defaultAgent,
      customPrompt: state.customPrompt,
    },
    () => {
      showSaved();
      chrome.runtime.sendMessage({ type: "pdf-ai/config-changed" }).catch(() => {});
    }
  );
}

// ===== 事件绑定 =====
els.resetDefault.addEventListener("click", () => {
  state.agents = JSON.parse(JSON.stringify(DEFAULT_AGENTS));
  state.defaultAgent = "minimax";
  save();
  render();
});

els.resetPrompt.addEventListener("click", () => {
  if (!confirm("恢复默认 prompt 模板？")) return;
  state.customPrompt = DEFAULT_PROMPT;
  els.customPrompt.value = DEFAULT_PROMPT;
  save();
});

els.customPrompt.addEventListener("input", () => {
  state.customPrompt = els.customPrompt.value;
  clearTimeout(els.customPrompt._t);
  els.customPrompt._t = setTimeout(save, 400);
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

load();

els.openMinimax?.addEventListener("click", () => {
  chrome.tabs.create({ url: MINIMAX_API_URL });
});
