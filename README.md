# PDF AI Sidebar

一个浏览器扩展，在网页端浏览 PDF 时框选段落，对接 MiniMax-M3 或 DeepSeek，AI 基于**整篇 PDF 全文 + 选中段落**做解释；普通英文网页还支持逐步操作引导。

> **Manifest V3** · Chrome / Edge 116+ · **当前版本 v0.4（Side Panel 模式）**

## ✨ 功能

- 🖱️ **框选段落** → 在 PDF 里框选文字，自动提取干净文本
- 🖱️ **右键菜单** → 弹出多个 AI agent 子菜单（多 agent 并存）
- 📄 **基于整篇 PDF 解释** → AI 能看到全文上下文，不只是选中段
- 💬 **多轮对话** → 同一引用段落下连续追问
- 🔌 **MiniMax / DeepSeek** → 预置 OpenAI-compatible 流式接口，可在设置页切换
- 🧭 **网页 Guide 模式** → 在英文网页上输入操作目标，逐步高亮按钮并由用户确认下一步
- ⌨️ **快捷键** → `Ctrl/Cmd+Shift+J` 一键发选区

## 🎯 核心使用场景

> "我打开一份 PDF，框选其中一句话或一段，AI 结合**整篇文档**给我解释这段话的位置、含义、上下文关联。"

- 阅读英文论文时选中关键段 → AI 翻译并解释
- 阅读法律合同选中某条 → AI 解释其在整篇合同里的作用
- 阅读技术文档选中一个术语 → AI 解释并关联文档其它章节

## 🧱 项目结构（v0.4）

```
pdf-ai-sidebar/
├── manifest.json              MV3 配置（side_panel）
├── icons/                     16/48/128 PNG
├── src/
│   ├── sidepanel/             ⭐ v0.4 主界面：Chrome Side Panel
│   │   ├── sidepanel.html
│   │   ├── sidepanel.css
│   │   └── sidepanel.js       选区显示 + PDF 上传 + 全文解析 + 多轮对话
│   ├── content/
│   │   ├── content.js         监听右键，把选区推给 background
│   │   └── content.css
│   ├── background/
│   │   └── background.js      右键菜单 + storage + 流式 AI 调用
│   ├── options/               设置页（agent 配置 + 自定义 prompt）
│   ├── lib/
│   │   ├── ai-client.js       统一 AI 调用（流式 SSE）
│   │   ├── prompt.js          全文 + 选区 prompt 拼装
│   │   └── pdf-parser.js      PDF.js 解析封装
│   └── vendor/
│       └── pdfjs/             PDF.js 4.0.379（1.3MB）
├── test-fixtures/
│   ├── test-paper.pdf         E2E 测试 PDF
│   ├── run_e2e.py             Playwright E2E（用 mock DeepSeek）
│   └── screenshots/           E2E 截图
├── scripts/make_icons.py
└── README.md
```

## 🚀 安装（开发者模式）

1. 打开 `chrome://extensions`
2. 右上角打开 **"开发者模式"**
3. 点 **"加载已解压的扩展程序"** → 选这个项目根目录
4. **重要**：在扩展卡片里打开 **"允许访问文件 URL"**（用于读本地 PDF）
5. 把扩展图标 📌 钉到工具栏
6. 点 ⚙ 选项 → 选择 MiniMax 或 DeepSeek，并填入你自己的 API Key

## 🧪 使用流程（v0.4 Side Panel 模式）

### 完整 7 步

```
1️⃣  打开 PDF（拖入 Chrome / Cmd+O / 地址栏 file://...pdf）
2️⃣  框选一行/一段
3️⃣  右键 → "AI 解释整篇" → DeepSeek
4️⃣  右键菜单会自动打开 PDF AI 侧边栏
5️⃣  侧边栏里点 [📁 选择 PDF 文件]，选同一份
6️⃣  等全文加载（变绿点 ✓）
7️⃣  在底部输入框输问题 → 回车 → AI 基于整篇 PDF 回答
```

### 英文网页教程

打开普通网页后，侧边栏会出现“英文网页操作教程”。输入例如“如何在 GitHub 创建一个新的 repository”，插件会读取当前页面的正文和可操作元素，让 AI 生成最多 8 步的教程，并逐步高亮目标元素。每一步都由用户点击“下一步”确认，插件不会自动提交密码、付款或删除数据。

### 关键设计

| 旧版本 v0.2 | 新版本 v0.4 |
|---|---|
| side panel（侧栏）| **Side Panel 侧边栏**（右键后自动打开）|
| 后台 fetch file:// PDF（失败）| **用户手动选文件**（FileReader 100% 拿到）|
| 流程：先点图标开侧栏 → 再框选 | **流程：先框选 → 再点图标**（更顺）|

**为什么使用 Side Panel**：
- Chrome 116+ 允许在右键菜单用户手势中调用 `sidePanel.open()`
- 侧边栏可在阅读 PDF 时保持打开，便于连续追问和对照全文
- 工具栏图标也可以直接打开侧边栏

**为什么全文要手动选文件**：
- Chrome PDF viewer + `file://` 权限让"自动拿全文"走不通
- content script 进不去 viewer，background fetch 也被卡
- 用户手动选文件 = 绕过 Chrome 安全限制 = 100% 可靠

## 🔧 配置说明

### 内置 agent

打开选项页配置 DeepSeek API key：

| Agent | Endpoint | 默认 Model |
|---|---|---|
| MiniMax | `https://api.minimaxi.com/v1/chat/completions` | `MiniMax-M3` |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |

当前版本预置 MiniMax 和 DeepSeek。API Key 由用户自行配置，不打包进扩展。

### Prompt 模板

`{context}` = 选中段落，`{question}` = 你的问题，`{fullDoc}` = 整篇 PDF 全文（v0.3 新增）

默认 v0.3 prompt：
```
你是我的 PDF 阅读助手。我会给你一篇文档的全文（可能截断），以及我特别想理解的一段话。
请基于文档的整体内容，帮我解释选中这段话。回答时：
1. 简要说明这段话在文档中的位置和作用
2. 解释它的核心意思
3. 关联文档中其他相关段落（如果有）
4. 如果我附加了问题，优先回答问题

【文档全文】
"""{fullDoc}"""

【我选中的内容】
"""{context}"""

【我的问题】
{question}
```

## 🛠️ 关键工程细节

### 1. content script → background 推送选区

`src/content/content.js`：
- 监听 `contextmenu`，从 `window.getSelection()` 拿选区文本
- 主动 fetch 一下 PDF URL（捕获"用户在 PDF 页面"这个事实，给 background 标记用）
- 通过 `chrome.runtime.sendMessage` 推给 background

### 2. background → sidepanel 推送 pending

`src/background/background.js`：
- 监听 `contextMenus.onClicked`
- 写 `chrome.storage.session.set({pendingSelection, pendingAgent, pendingUrl})`
- 右键菜单写入 storage 后自动打开 side panel，侧栏读取 pending → 渲染

### 3. sidepanel 里上传 + 解析 PDF

`src/sidepanel/sidepanel.js`：
- 用 `<input type="file" accept="application/pdf">` 拿文件
- FileReader 读成 ArrayBuffer
- 动态 import PDF.js（`pdf.min.mjs`）
- 逐页 `getTextContent()` → 拼成 fullText
- 缓存到 `chrome.storage.session`（同会话不重复解析）
- 显示"已加载全文 X 字 · Y 页"

### 4. AI 调用：background 转发 + 流式

`src/background/background.js` 监听 `sidepanel → background` 的 `ai/stream` 消息：
- 拿 sidepanel 传来的 fullText + selection + question + agent
- 用 `ai-client.js` 走对应协议
- 通过 runtime message 推回 sidepanel
- sidepanel 边流边渲染（打字效果）

### 5. 流式 SSE 解析

`src/lib/ai-client.js`：
- OpenAI 协议：`data: {...}\n\n` 循环
- Anthropic 协议：`event: content_block_delta\ndata: {...}`
- Gemini 协议：`data: {...}` 单行 JSON
- 每个 chunk 用 `controller.enqueue()` 推给 ReadableStream caller

## 🧪 E2E 测试

`test-fixtures/run_e2e.py` 提供完整链路测试脚本（使用 mock DeepSeek）：
1. 启动 mock server（`mimic_deepseek.py`）
2. Playwright 启动 Chrome with `--load-extension=<项目根>`
3. 配置页填 mock key
4. 打开测试 PDF → 框选 → 右键 → DeepSeek
5. side panel 自动打开 → 上传 PDF → 验证绿点
6. 输入问题 → 验证流式响应 + Markdown 渲染
7. 第二轮对话 → 验证 4 条消息

说明：静态检查和 mock 测试脚本已保留；不同 Chrome 版本或本机扩展加载环境可能需要手动重新加载扩展后再运行。

## 🐛 已知问题 / 限制

1. Side Panel 会占用浏览器右侧空间，但便于和 PDF 并排对照
2. **全文需要手动选文件**（前面解释了原因）
3. **PDF.js 在 service worker 有兼容问题**（少数加密/损坏 PDF 解析失败）
4. **chrome://extensions 的 service worker console** 是排查错误的主入口
5. **DeepSeek 流式偶尔断开**（网络问题，需要重试机制，目前没做）

## 🔄 版本历史

| 版本 | 改动 |
|---|---|
| v0.1 | 初始版，side panel + 选中段（无全文）|
| v0.2 | side panel + 全文上下文（自动 fetch PDF 失败）|
| **v0.4** | **Side Panel 模式 + 手动选 PDF 文件**（当前）|

## 🌐 浏览器兼容性

| 浏览器 | 支持情况 |
|---|---|
| Chrome 116+ | ✅ 完整支持 |
| Edge 116+ | ✅ 完整支持 |
| Firefox | ⚠️ Side Panel API 不兼容，暂不支持 |
| Safari | ❌ MV3 支持不完整 |

## 🔒 隐私

- API Key 仅保存在 `chrome.storage.sync`（同步到用户 Google 账号）
- 选中的段落和 PDF 全文只发往用户选择的 MiniMax 或 DeepSeek endpoint
- 网页教程模式仅在用户主动生成教程时，将当前网页正文和可操作元素索引发送给用户选择的 AI endpoint
- 不收集任何遥测

## 📦 打包

```bash
cd /Users/ahs/Documents/一坨/pdf-ai-sidebar
zip -r pdf-ai-sidebar.zip . -x "*.DS_Store" "scripts/*" "test-fixtures/*" ".gitignore"
```

## 📝 License

MIT
